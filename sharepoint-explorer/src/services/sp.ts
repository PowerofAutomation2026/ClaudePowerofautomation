/**
 * Live backend. Talks to SharePoint through the signed-in user's own "SharePoint" connector connection
 * (code-apps SDK -> executeAsync). Every call is the connector's "Send an HTTP request to SharePoint" action, i.e. plain
 * SharePoint REST, so ANY site, list or library works without generating a typed data source per list.
 */
import { getClient } from '@microsoft/power-apps/data'
import { getContext } from '@microsoft/power-apps/app'
import baked from '../appconfig.json'
import type { AppConfig, Backend, FieldKind, Page, Query, Row, SourceConfig, SpField, SpList, SpSite } from '../types'
import { buildFilter } from '../query'
import { lsGet, lsSet, odataQuote, sleep } from '../util'

/* eslint-disable @typescript-eslint/no-explicit-any */
const infoModules = import.meta.glob('../../.power/schemas/appschemas/dataSourcesInfo.ts', { eager: true }) as Record<string, any>
function loadInfo(): Record<string, any> {
  const mod = Object.values(infoModules)[0]
  if (!mod) return {}
  if (mod.dataSourcesInfo) return mod.dataSourcesInfo
  if (mod.default && typeof mod.default === 'object') return mod.default.dataSourcesInfo ?? mod.default
  return (Object.values(mod).find((v) => v && typeof v === 'object') as any) ?? {}
}
export const dataSourcesInfo = loadInfo()
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * `pac code add-data-source` for a tabular connector such as SharePoint only describes the table it was pointed at
 * (get/create/update/delete on ONE list). This app needs to reach ANY site/list, so it adds two connector operations
 * to the data source's operation table at start-up: "Send an HTTP request to SharePoint" (plain SharePoint REST) and
 * "Get sites". The SDK already lets `dataset` be overridden per call, which is what makes any site reachable.
 */
const HTTP_API = {
  path: '/{connectionId}/datasets/{dataset}/httprequest', method: 'POST',
  parameters: [{ name: 'connectionId', in: 'path', required: true, type: 'string' }, { name: 'dataset', in: 'path', required: true, type: 'string' }, { name: 'parameters', in: 'body', required: true, type: 'object' }],
}
const DATASETS_API = { path: '/{connectionId}/datasets', method: 'GET', parameters: [{ name: 'connectionId', in: 'path', required: true, type: 'string' }] }
const isConnectorSource = (v: any) => v && typeof v === 'object' && !/dataverse|cds/i.test(String(v.dataSourceType ?? ''))
for (const v of Object.values<any>(dataSourcesInfo)) {
  if (!isConnectorSource(v)) continue
  v.apis = v.apis ?? {}
  const keys = Object.keys(v.apis).map(norm)
  if (!keys.includes('httprequest')) v.apis.HttpRequest = HTTP_API
  if (!keys.includes('getdatasets')) v.apis.GetDataSets = DATASETS_API
}
const candidates = (): string[] => {
  const all = Object.entries<any>(dataSourcesInfo).filter(([, v]) => isConnectorSource(v)).map(([k]) => k)
  return [...all.filter((k) => /sharepoint/i.test(k)), ...all.filter((k) => !/sharepoint/i.test(k) && dataSourcesInfo[k]?.tableId), ...all.filter((k) => !/sharepoint/i.test(k) && !dataSourcesInfo[k]?.tableId)]
}
export const hasSharePointConnector = () => candidates().length > 0

let client: ReturnType<typeof getClient> | null = null
const sdk = () => (client ??= getClient(dataSourcesInfo as any))


let keyP: Promise<string> | null = null
/** The data-source key that is bound to the SharePoint connection (found by asking each candidate for the site list). */
const spKey = () => (keyP ??= (async () => {
  const c = candidates()
  if (!c.length) throw new Error('No connector is attached to this app. Re-run the deploy script to add the SharePoint connection.')
  if (c.length === 1) return c[0]
  for (const k of c) { try { const r: any = await sdk().executeAsync({ connectorOperation: { tableName: k, operationName: 'GetDataSets', parameters: {} } } as any); if (r?.success) return k } catch { /* not SharePoint */ } }
  return c[0]
})())

/* ------------------------------------------------------------------ throttled, retrying transport */
let active = 0
const waiters: (() => void)[] = []
const MAX_PARALLEL = 4
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((r) => waiters.push(r))
  active++
  try { return await fn() } finally { active--; waiters.shift()?.() }
}

function friendly(raw: string): string {
  if (/threshold/i.test(raw)) return 'SharePoint refused the query because it would scan more than 5,000 items without an index (list view threshold). Index the column you are filtering/sorting on (owner: Connect → Index column), or narrow the filter.'
  if (/does not exist|404/i.test(raw) && /list|site|web/i.test(raw)) return `Not found: ${raw}`
  if (/(401|403)|access denied|forbidden/i.test(raw)) return `Access denied by SharePoint - you may not have permission to this list. ${raw}`
  return raw
}

async function exec(opName: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  const ds = await spKey()
  let attempt = 0
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const res: any = await slot(() => sdk().executeAsync({ connectorOperation: { tableName: ds, operationName: opName, parameters: params } } as any))
    if (res?.success) return res.data
    const e = res?.error
    const status = Number(e?.status ?? e?.statusCode ?? res?.status ?? 0)
    const text = String(e?.message ?? (typeof e === 'string' ? e : JSON.stringify(e ?? 'Connector call failed')))
    if ((status === 429 || status === 503 || status === 504 || /throttl|too many requests|timed? ?out/i.test(text)) && attempt < 5) {
      await sleep(Math.min(20_000, 800 * 2 ** attempt) + Math.random() * 400); attempt++; continue
    }
    let pretty = text
    try { const s = text.indexOf('{'), t = text.lastIndexOf('}'); if (s >= 0) { const j = JSON.parse(text.slice(s, t + 1)); const er = j.error ?? j; pretty = (typeof er.message === 'object' ? er.message?.value : er.message) || er['odata.error']?.message?.value || text } } catch { /* plain text */ }
    throw new Error(friendly(`${status ? `HTTP ${status}: ` : ''}${pretty}`))
  }
}

const parse = (d: any) => { if (typeof d === 'string') { try { return JSON.parse(d) } catch { return d } } return d }
const rows = (d: any): any[] => { d = parse(d); return d?.value ?? d?.d?.results ?? d?.results ?? (Array.isArray(d) ? d : []) }

async function http(site: string, method: 'GET' | 'POST', uri: string, body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<any> {
  const payload: Record<string, unknown> = {
    method, uri,
    headers: { Accept: 'application/json;odata=nometadata', 'Content-Type': 'application/json;odata=nometadata', ...headers },
  }
  if (body !== undefined) payload.body = typeof body === 'string' ? body : JSON.stringify(body)
  // `dataset` = the site URL: the SDK encodes it for SharePoint and allows overriding it per call
  return parse(await exec('HttpRequest', { dataset: site.replace(/\/+$/, ''), parameters: payload }, signal))
}

/* ------------------------------------------------------------------ metadata */

const guid = (id: string) => `guid'${id}'`
const KIND: Record<string, FieldKind> = {
  Text: 'text', Note: 'note', Number: 'number', Integer: 'number', Currency: 'currency', Counter: 'counter', Boolean: 'boolean', DateTime: 'date',
  Choice: 'choice', MultiChoice: 'multichoice', User: 'user', UserMulti: 'user', Lookup: 'lookup', LookupMulti: 'lookup', URL: 'url',
  Calculated: 'text', File: 'text', TaxonomyFieldType: 'lookup', TaxonomyFieldTypeMulti: 'lookup',
}
const SKIP_TYPES = new Set(['Computed', 'ContentTypeId', 'Guid', 'ThreadIndex', 'WorkflowEventType', 'WorkflowStatus', 'ModStat', 'Attachments', 'CrossProjectLink', 'Thumbnail', 'AllDayEvent', 'Recurrence'])
const SKIP_NAMES = new Set(['ContentType', 'LinkTitle', 'LinkTitleNoMenu', 'Edit', 'DocIcon', 'ItemChildCount', 'FolderChildCount', '_UIVersionString', 'AppAuthor', 'AppEditor', 'SelectTitle', 'FileLeafRef2'])

export const sp: Backend = {
  mode: 'live',

  async whoAmI() {
    const c = await getContext()
    return { upn: c.user.userPrincipalName ?? '', name: c.user.fullName ?? c.user.userPrincipalName ?? '' }
  },

  async listSites(): Promise<SpSite[]> {
    const out: SpSite[] = []
    try {
      for (const s of rows(await exec('GetDataSets', {}))) {
        const url = String(s.Name ?? s.name ?? s.DisplayName ?? '')
        if (/^https?:/i.test(url)) out.push({ url, title: String(s.DisplayName && s.DisplayName !== url ? s.DisplayName : url.split('/').filter(Boolean).pop()) })
      }
    } catch { /* the owner can still paste a URL */ }
    return out
  },

  async listLists(site): Promise<SpList[]> {
    const d = await http(site, 'GET', '_api/web/lists?$select=Id,Title,ItemCount,BaseType,BaseTemplate,Hidden,Description,LastItemUserModifiedDate,IsSystemList,IsCatalog,IsApplicationList,RootFolder/ServerRelativeUrl&$expand=RootFolder&$filter=Hidden eq false&$top=500')
    return rows(d)
      .filter((l) => !l.Hidden && !l.IsSystemList && !l.IsCatalog && !l.IsApplicationList)
      .map<SpList>((l) => ({ id: l.Id, title: l.Title, isLibrary: l.BaseType === 1, itemCount: l.ItemCount ?? 0, baseTemplate: l.BaseTemplate, url: l.RootFolder?.ServerRelativeUrl ?? '', description: l.Description, modified: l.LastItemUserModifiedDate }))
      .sort((a, b) => b.itemCount - a.itemCount)
  },

  async getList(site, id): Promise<SpList> {
    const l = await http(site, 'GET', `_api/web/lists(${guid(id)})?$select=Id,Title,ItemCount,BaseType,BaseTemplate,Description,RootFolder/ServerRelativeUrl&$expand=RootFolder`)
    return { id: l.Id, title: l.Title, isLibrary: l.BaseType === 1, itemCount: l.ItemCount ?? 0, baseTemplate: l.BaseTemplate, url: l.RootFolder?.ServerRelativeUrl ?? '', description: l.Description }
  },

  async getFields(site, id): Promise<SpField[]> {
    const base = `_api/web/lists(${guid(id)})`
    const [fieldsRes, viewRes, choiceRes] = await Promise.all([
      http(site, 'GET', `${base}/fields?$filter=Hidden eq false&$select=InternalName,Title,TypeAsString,Required,Indexed,Sortable,Filterable,ReadOnlyField&$top=500`),
      http(site, 'GET', `${base}/defaultview/viewfields`).catch(() => null),
      http(site, 'GET', `${base}/fields?$filter=TypeAsString eq 'Choice' or TypeAsString eq 'MultiChoice'&$select=InternalName,Choices`).catch(() => null),
    ])
    const choices = new Map<string, string[]>(rows(choiceRes).map((c) => [c.InternalName, c.Choices?.results ?? c.Choices ?? []]))
    const inView: string[] = (viewRes?.Items?.results ?? viewRes?.Items ?? []).map(String)
    const out: SpField[] = []
    for (const r of rows(fieldsRes)) {
      const type = String(r.TypeAsString)
      if (SKIP_TYPES.has(type) || SKIP_NAMES.has(r.InternalName)) continue
      const kind: FieldKind = r.InternalName === 'ID' ? 'counter' : KIND[type] ?? 'other'
      const multi = /Multi$/.test(type)
      out.push({
        internal: r.InternalName, title: r.Title, kind, typeAsString: type, multi, required: !!r.Required, indexed: !!r.Indexed,
        choices: choices.get(r.InternalName),
        sortable: !!r.Sortable && !['note', 'user', 'lookup', 'multichoice', 'other', 'url'].includes(kind),
        filterable: !!r.Filterable && !['note', 'multichoice', 'other', 'url'].includes(kind),
        system: inView.length ? !inView.includes(r.InternalName) : false,
      })
    }
    const order = (f: SpField) => { const i = inView.indexOf(f.internal); return i < 0 ? 1000 + (f.system ? 1 : 0) : i }
    return out.sort((a, b) => order(a) - order(b))
  },

  async query(src, fields, select, q, top, cursor, signal): Promise<Page> {
    const byId = q.sort.field === 'ID'
    const asc = q.sort.dir === 'asc'
    const extra: string[] = []
    let uri: string
    if (cursor?.startsWith('next:')) {
      uri = cursor.slice(5)
    } else {
      if (byId && cursor?.startsWith('id:')) extra.push(`Id ${asc ? 'ge' : 'le'} ${Number(cursor.slice(3))}`)
      const filter = buildFilter(q, fields, src.isLibrary, extra)
      const order = byId ? `Id ${asc ? 'asc' : 'desc'}` : `${q.sort.field} ${asc ? 'asc' : 'desc'}`
      uri = `_api/web/lists(${guid(src.listId)})/items?${selectExpand(fields, select, src.isLibrary)}&$orderby=${enc(order)}&$top=${Math.min(top, 5000)}${filter ? `&$filter=${enc(filter)}` : ''}`
    }
    const d = await http(src.siteUrl, 'GET', uri, undefined, {}, signal)
    const items = rows(d)
    const out = items.map((i) => toRow(i, fields))
    let next: string | undefined
    if (byId) {
      if (items.length >= Math.min(top, 5000) && out.length) next = `id:${out[out.length - 1].__id + (asc ? 1 : -1)}`
    } else {
      const link: string | undefined = d?.['odata.nextLink'] ?? d?.['@odata.nextLink'] ?? d?.d?.__next
      const i = link ? link.indexOf('_api/') : -1
      if (link && i >= 0) next = `next:${link.slice(i)}`
    }
    return { rows: out, cursor: next, scanned: items.length }
  },

  async getItem(src, fields, id) {
    const sel = fields.map((f) => f.internal)
    try {
      const d = await http(src.siteUrl, 'GET', `_api/web/lists(${guid(src.listId)})/items(${id})?${selectExpand(fields, sel, src.isLibrary)}`)
      return toRow(d, fields)
    } catch { return null }
  },

  async changes(src, fields, select, afterId, since) {
    const base = `_api/web/lists(${guid(src.listId)})/items?${selectExpand(fields, select, src.isLibrary)}`
    const libF = src.isLibrary ? ' and FSObjType eq 0' : ''
    const sinceIso = new Date(Date.parse(since) - 60_000).toISOString()
    const [addedRes, changedRes, listRes] = await Promise.all([
      http(src.siteUrl, 'GET', `${base}&$filter=${enc(`Id gt ${afterId}${libF}`)}&$orderby=Id asc&$top=100`).catch(() => null),
      http(src.siteUrl, 'GET', `${base}&$filter=${enc(`Modified gt datetime'${sinceIso}'${libF}`)}&$orderby=Modified desc&$top=50`).catch(() => null),
      http(src.siteUrl, 'GET', `_api/web/lists(${guid(src.listId)})?$select=ItemCount`).catch(() => null),
    ])
    const added = rows(addedRes).map((i) => toRow(i, fields))
    return { added, changed: rows(changedRes).map((i) => toRow(i, fields)), itemCount: listRes?.ItemCount ?? 0, maxId: Math.max(afterId, ...added.map((r) => r.__id)) }
  },

  async loadConfig(): Promise<AppConfig> {
    const site = baked.configSiteUrl || lsGet<string>('spx.configSite', '')
    const fallback = (): AppConfig => lsGet<AppConfig>('spx.config', { v: 1, owners: [], sources: [], updated: '', updatedBy: '' })
    let cfg = fallback()
    if (site) {
      try {
        const d = await http(site, 'GET', `_api/web/lists/getbytitle(${odataQuote(baked.configList)})/items?$select=Id,ConfigJson&$top=1`)
        const item = rows(d)[0]
        if (item?.ConfigJson) cfg = JSON.parse(item.ConfigJson) as AppConfig
      } catch { /* list not created yet / no access: use local copy */ }
    }
    // Owners come ONLY from the deployed bundle (written by the deploy script), never from the editable list.
    return { ...cfg, v: 1, owners: baked.owners as string[], sources: cfg.sources ?? [] }
  },

  async saveConfig(cfg) {
    lsSet('spx.config', cfg)
    const site = baked.configSiteUrl || lsGet<string>('spx.configSite', '') || cfg.sources[0]?.siteUrl
    if (!site) return
    if (!baked.configSiteUrl) lsSet('spx.configSite', site)
    const title = baked.configList
    const listUri = `_api/web/lists/getbytitle(${odataQuote(title)})`
    try { await http(site, 'GET', `${listUri}?$select=Id`) } catch {
      await http(site, 'POST', '_api/web/lists', { Title: title, BaseTemplate: 100, Description: 'App configuration for the SharePoint Explorer code app. Keep editable by app owners only.' })
      await http(site, 'POST', `${listUri}/fields`, { Title: 'ConfigJson', FieldTypeKind: 3 })
    }
    const body = { Title: 'config', ConfigJson: JSON.stringify({ ...cfg, owners: [] }) }
    const existing = rows(await http(site, 'GET', `${listUri}/items?$select=Id&$top=1`))[0]
    if (existing) await http(site, 'POST', `${listUri}/items(${existing.Id})`, body, { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' })
    else await http(site, 'POST', `${listUri}/items`, body)
  },

  async indexColumn(src, field) {
    await http(src.siteUrl, 'POST', `_api/web/lists(${guid(src.listId)})/fields/getbyinternalnameortitle(${odataQuote(field)})`, { Indexed: true }, { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' })
  },
}

const enc = (s: string) => encodeURIComponent(s).replace(/%24/g, '$')

export function selectExpand(fields: SpField[], select: string[], isLibrary: boolean): string {
  const sel = new Set<string>(['Id'])
  const exp = new Set<string>()
  for (const n of select) {
    const f = fields.find((x) => x.internal === n)
    if (!f || n === 'ID') continue
    if (f.kind === 'user' || (f.kind === 'lookup' && f.typeAsString.startsWith('Lookup'))) { sel.add(`${n}/Title`); exp.add(n) }
    else sel.add(n)
  }
  if (isLibrary) ['FileRef', 'FileLeafRef', 'FSObjType', 'File_x0020_Type', 'File_x0020_Size'].forEach((x) => sel.add(x))
  const e = [...exp].slice(0, 12)
  return `$select=${[...sel].filter((s) => !s.includes('/') || e.includes(s.split('/')[0])).join(',')}${e.length ? `&$expand=${e.join(',')}` : ''}`
}

function toRow(item: any, fields: SpField[]): Row {
  const row: Row = { __id: Number(item.Id ?? item.ID), ID: Number(item.Id ?? item.ID) }
  for (const k of ['FileRef', 'FileLeafRef', 'FSObjType', 'File_x0020_Type']) if (item[k] != null) row[k] = item[k]
  if (item.File_x0020_Size != null) row.File_x0020_Size = Number(item.File_x0020_Size)
  for (const f of fields) {
    if (!(f.internal in item)) continue
    let v = item[f.internal]
    if (v && typeof v === 'object' && !Array.isArray(v) && 'results' in v) v = v.results
    if (f.kind === 'user' || f.kind === 'lookup') v = Array.isArray(v) ? v.map((x) => x?.Title ?? x?.Label ?? x).join('; ') : v?.Title ?? v?.Label ?? ''
    else if (f.kind === 'number' || f.kind === 'currency') v = v == null ? null : Number(v)
    row[f.internal] = v
  }
  return row
}
