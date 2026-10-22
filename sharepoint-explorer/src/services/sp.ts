/**
 * Live backend. Talks to SharePoint through the signed-in user's own "SharePoint" connector connection
 * (code-apps SDK -> executeAsync). Every call is the connector's "Send an HTTP request to SharePoint" action, i.e. plain
 * SharePoint REST, so ANY site, list or library works without generating a typed data source per list.
 */
import { getClient } from '@microsoft/power-apps/data'
import { getContext } from '@microsoft/power-apps/app'
import baked from '../appconfig.json'
import type { Access, AppConfig, Attachment, Backend, PermInfo, PermTarget, Principal, RoleAssign, RoleDef, VersionInfo, ViewDef, FieldKind, Page, Query, Row, SourceConfig, SpField, SpList, SpSite } from '../types'
import { buildFilter, parseSearch } from '../query'
import { accessFrom } from '../access'
import { isEditable } from '../editable'
import { lsGet, lsSet, odataQuote, sleep } from '../util'
import { isFolderMode } from '../query'

/* eslint-disable @typescript-eslint/no-explicit-any */
const infoModules = import.meta.glob('../../.power/**/dataSourcesInfo.ts', { eager: true }) as Record<string, any>
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
const conn = { name: 'connectionId', in: 'path', required: true, type: 'string' }
const ds = { name: 'dataset', in: 'path', required: true, type: 'string' }
/** connector "Create file": binary upload (the SDK decodes a base64 string for `format: binary` body parameters) */
const FILE_API = { path: '/{connectionId}/datasets/{dataset}/files', method: 'POST', parameters: [conn, ds, { name: 'folderPath', in: 'query', required: true, type: 'string' }, { name: 'name', in: 'query', required: true, type: 'string' }, { name: 'queryParametersSingleEncoded', in: 'query', required: false, type: 'boolean' }, { name: 'body', in: 'body', required: true, type: 'string', format: 'binary' }] }
/** connector "Add attachment" */
const ATT_API = { path: '/{connectionId}/datasets/{dataset}/tables/{tableName}/items/{itemId}/attachments', method: 'POST', parameters: [conn, ds, { name: 'tableName', in: 'path', required: true, type: 'string' }, { name: 'itemId', in: 'path', required: true, type: 'string' }, { name: 'displayName', in: 'query', required: true, type: 'string' }, { name: 'body', in: 'body', required: true, type: 'string', format: 'binary' }] }
const isConnectorSource = (v: any) => v && typeof v === 'object' && !/dataverse|cds/i.test(String(v.dataSourceType ?? ''))
for (const v of Object.values<any>(dataSourcesInfo)) {
  if (!isConnectorSource(v)) continue
  v.apis = v.apis ?? {}
  const keys = Object.keys(v.apis).map(norm)
  if (!keys.includes('httprequest')) v.apis.HttpRequest = HTTP_API
  if (!keys.includes('getdatasets')) v.apis.GetDataSets = DATASETS_API
  if (!keys.includes('createfile')) v.apis.CreateFile = FILE_API
  if (!keys.includes('addattachment')) v.apis.AddAttachment = ATT_API
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
  let last = ''
  for (const k of c) { try { const r: any = await sdk().executeAsync({ connectorOperation: { tableName: k, operationName: 'GetDataSets', parameters: {} } } as any); if (r?.success) return k; last = String(r?.error?.message ?? 'failed') } catch (e) { last = (e as Error).message } }
  throw new Error(`None of the connectors in this app answered the SharePoint site-list call (${c.join(', ')}). ${last}`)
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

async function exec(opName: string, params: Record<string, unknown>, signal?: AbortSignal, idempotent = true): Promise<any> {
  const ds = await spKey()
  let attempt = 0
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const res: any = await slot(() => sdk().executeAsync({ connectorOperation: { tableName: ds, operationName: opName, parameters: params } } as any))
    if (res?.success) return res.data
    const e = res?.error
    const status = Number(e?.status ?? e?.statusCode ?? res?.status ?? 0)
    const text = String(e?.message ?? (typeof e === 'string' ? e : JSON.stringify(e ?? 'Connector call failed')))
    if ((status === 429 || status === 503 || (idempotent && (status === 504 || /throttl|too many requests|timed? ?out/i.test(text)))) && attempt < 5) {   // never re-send a write after a timeout: it may have been applied
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
  return parse(await exec('HttpRequest', { dataset: site.replace(/\/+$/, ''), parameters: payload }, signal, method === 'GET'))
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
    const [fieldsRes, viewRes, choiceRes, lookupRes] = await Promise.all([
      http(site, 'GET', `${base}/fields?$filter=Hidden eq false&$select=InternalName,Title,TypeAsString,Required,Indexed,Sortable,Filterable,ReadOnlyField&$top=500`),
      http(site, 'GET', `${base}/defaultview/viewfields`).catch(() => null),
      http(site, 'GET', `${base}/fields?$filter=TypeAsString eq 'Choice' or TypeAsString eq 'MultiChoice'&$select=InternalName,Choices`).catch(() => null),
      http(site, 'GET', `${base}/fields?$filter=TypeAsString eq 'Lookup' or TypeAsString eq 'LookupMulti'&$select=InternalName,LookupField`).catch(() => null),
    ])
    const choices = new Map<string, string[]>(rows(choiceRes).map((c) => [c.InternalName, c.Choices?.results ?? c.Choices ?? []]))
    const lookups = new Map<string, string>(rows(lookupRes).map((c) => [c.InternalName, String(c.LookupField || 'Title')]))
    const inView: string[] = (viewRes?.Items?.results ?? viewRes?.Items ?? []).map(String)
    const out: SpField[] = []
    for (const r of rows(fieldsRes)) {
      const type = String(r.TypeAsString)
      if (SKIP_TYPES.has(type) || SKIP_NAMES.has(r.InternalName)) continue
      const kind: FieldKind = r.InternalName === 'ID' ? 'counter' : KIND[type] ?? 'other'
      const multi = /Multi$/.test(type)
      out.push({
        internal: r.InternalName, title: r.Title, kind, typeAsString: type, multi, required: !!r.Required, indexed: !!r.Indexed,
        choices: choices.get(r.InternalName), lookupField: lookups.get(r.InternalName),
        sortable: !!r.Sortable && !['note', 'user', 'lookup', 'multichoice', 'other', 'url'].includes(kind),
        filterable: !!r.Filterable && !['note', 'multichoice', 'other', 'url'].includes(kind),
        system: inView.length ? !inView.includes(r.InternalName) && r.InternalName !== 'FileLeafRef' && r.InternalName !== 'Title' : false,
      })
    }
    const order = (f: SpField) => { const i = inView.indexOf(f.internal); return i < 0 ? 1000 + (f.system ? 1 : 0) : i }
    return out.sort((a, b) => order(a) - order(b))
  },

  async query(src, fields, select, q, top, cursor, signal): Promise<Page> {
    if (useSearchApi(src, q, cursor)) {
      try {
        const r = await searchPage(src, fields, select, q, top, cursor, signal)
        if (r) return r
      } catch (e) { if ((e as Error).name === 'AbortError') throw e /* otherwise fall through to the plain filter */ }
    }
    if (isFolderMode(q) && src.isLibrary) return folderPage(src, fields, select, q, cursor, signal)
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

  async getAccess(src, cfg, upn): Promise<Access> {
    const base = `_api/web/lists(${guid(src.listId)})`
    const [perm, groups, me] = await Promise.all([
      http(src.siteUrl, 'GET', `${base}/EffectiveBasePermissions`).catch(() => null),
      http(src.siteUrl, 'GET', '_api/web/currentuser/groups?$select=Title').then((d) => rows(d).map((g) => String(g.Title))).catch(() => [] as string[]),
      http(src.siteUrl, 'GET', '_api/web/currentuser?$select=IsSiteAdmin').catch(() => null),
    ])
    // if SharePoint cannot tell us, fail CLOSED: read-only
    const low = perm ? Number(perm.Low ?? perm.d?.EffectiveBasePermissions?.Low ?? 1) : 1
    return accessFrom(low, groups, !!me?.IsSiteAdmin, cfg, upn)
  },

  async createItem(src, fields, values) {
    const d = await http(src.siteUrl, 'POST', `_api/web/lists(${guid(src.listId)})/items`, await writeBody(src, fields, values), VERBOSE)
    return Number(d?.Id ?? d?.d?.Id ?? 0)
  },
  async updateItem(src, fields, id, values) {
    await http(src.siteUrl, 'POST', `_api/web/lists(${guid(src.listId)})/items(${id})`, await writeBody(src, fields, values), { ...VERBOSE, 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' })
  },
  async deleteItem(src, id) {
    await http(src.siteUrl, 'POST', `_api/web/lists(${guid(src.listId)})/items(${id})/recycle()`)   // to the recycle bin, never a hard delete
  },

  async loadViews(upn) {
    const [shared, mine] = await Promise.all([kvGet<ViewDef[]>('views:shared'), kvGet<ViewDef[]>(`views:${upn.toLowerCase()}`)])
    return { shared: shared ?? lsGet<ViewDef[]>('spx.views.shared', []), mine: mine ?? lsGet<ViewDef[]>(`spx.views.mine.${upn}`, []) }
  },
  async saveShared(views) { lsSet('spx.views.shared', views); await kvSet('views:shared', views) },
  async saveMine(upn, views) {
    lsSet(`spx.views.mine.${upn}`, views)
    try { await kvSet(`views:${upn.toLowerCase()}`, views); return 'cloud' } catch { return 'device' }   // a read-only user cannot write the settings list: keep the view on this device
  },

  async suggest(src, fields, text, signal) {
    const tf = src.isLibrary ? 'FileLeafRef' : 'Title'
    if (!fields.some((f) => f.internal === tf) || text.length < 2) return []
    try {
      const d = await http(src.siteUrl, 'GET', `_api/web/lists(${guid(src.listId)})/items?$select=Id,${tf}&$filter=${enc(`startswith(${tf},${odataQuote(text)})${src.isLibrary ? ' and FSObjType eq 0' : ''}`)}&$orderby=Id desc&$top=8`, undefined, {}, signal)
      return [...new Set(rows(d).map((r) => String(r[tf])))]
    } catch { return [] }
  },

  /* ---------------------------------------------------------------- document libraries */
  async createFolder(src, parentUrl, name) {
    await http(src.siteUrl, 'POST', `_api/web/folders/add(${pathQ(`${parentUrl.replace(/\/$/, '')}/${name}`)})`)
  },
  async uploadFile(src, folderUrl, file) {
    const b64 = await fileToBase64(file)
    await exec('CreateFile', { dataset: src.siteUrl.replace(/\/+$/, ''), folderPath: rel(src, folderUrl), name: file.name, queryParametersSingleEncoded: true, body: b64 })
  },
  async renameItem(src, fields, id, newName) {
    await http(src.siteUrl, 'POST', `_api/web/lists(${guid(src.listId)})/items(${id})`, { __metadata: { type: await entityType(src) }, FileLeafRef: newName }, { ...VERBOSE, 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' })
  },
  async moveItem(src, row, dest) {
    const from = String(row.FileRef), to = `${dest.replace(/\/$/, '')}/${row.FileLeafRef}`
    const isFolder = row.FSObjType === 1
    const call = isFolder ? `GetFolderByServerRelativePath(decodedurl=${pathQ(from)})/moveto(newurl=${pathQ(to)})` : `GetFileByServerRelativePath(decodedurl=${pathQ(from)})/moveto(newurl=${pathQ(to)},flags=0)`
    await http(src.siteUrl, 'POST', `_api/web/${call}`)
  },
  async copyItem(src, row, dest) {
    if (row.FSObjType === 1) throw new Error('Copying a whole folder is not supported - copy its files, or move the folder.')
    await http(src.siteUrl, 'POST', `_api/web/GetFileByServerRelativePath(decodedurl=${pathQ(String(row.FileRef))})/copyto(strnewurl=${pathQ(`${dest.replace(/\/$/, '')}/${row.FileLeafRef}`)},boverwrite=false)`)
  },
  async listFolders(src, parent) {
    const d = await http(src.siteUrl, 'GET', `_api/web/GetFolderByServerRelativePath(decodedurl=${pathQ(parent)})/Folders?$select=Name,ServerRelativeUrl&$orderby=Name&$top=500`)
    return rows(d).filter((f) => f.Name !== 'Forms' && !String(f.Name).startsWith('_')).map((f) => ({ name: String(f.Name), url: String(f.ServerRelativeUrl) }))
  },

  /* ---------------------------------------------------------------- attachments + history */
  async listAttachments(src, id) {
    const d = await http(src.siteUrl, 'GET', `_api/web/lists(${guid(src.listId)})/items(${id})/AttachmentFiles?$select=FileName,ServerRelativeUrl`)
    return rows(d).map<Attachment>((a) => ({ name: String(a.FileName), url: new URL(src.siteUrl).origin + a.ServerRelativeUrl }))
  },
  async addAttachment(src, id, file) {
    await exec('AddAttachment', { dataset: src.siteUrl.replace(/\/+$/, ''), tableName: src.listId, itemId: String(id), displayName: file.name, body: await fileToBase64(file) })
  },
  async deleteAttachment(src, id, name) {
    await http(src.siteUrl, 'POST', `_api/web/lists(${guid(src.listId)})/items(${id})/AttachmentFiles/getByFileName(${odataQuote(name)})`, undefined, { 'X-HTTP-Method': 'DELETE', 'IF-MATCH': '*' })
  },
  async getVersions(src, id) {
    const d = await http(src.siteUrl, 'GET', `_api/web/lists(${guid(src.listId)})/items(${id})/versions`)
    return rows(d).map<VersionInfo>((v) => ({ label: String(v.VersionLabel ?? ''), modified: String(v.Created ?? v.Modified ?? ''), by: String(v.Editor?.LookupValue ?? v.Editor?.Title ?? v.Author?.LookupValue ?? ''), size: v.Size != null ? Number(v.Size) : undefined, comment: v.CheckInComment || undefined, current: !!v.IsCurrentVersion }))
  },

  async createShareLink(src, id, edit) {
    const d = await http(src.siteUrl, 'POST', `_api/web/lists(${guid(src.listId)})/items(${id})/ShareLink`,
      { request: { createLink: true, settings: { linkKind: edit ? 3 : 2, role: edit ? 2 : 1, expiration: null, restrictShareMembership: false, updatePassword: false, password: '' } } }, VERBOSE)
    const url = d?.sharingLinkInfo?.Url ?? d?.d?.ShareLink?.sharingLinkInfo?.Url ?? d?.ShareLink?.sharingLinkInfo?.Url
    if (!url) throw new Error('SharePoint did not return a sharing link. Sharing may be turned off for this site.')
    return String(url)
  },

  /* ---------------------------------------------------------------- security */
  async getPermissions(src, t): Promise<PermInfo> {
    const base = baseOf(src, t)
    const [uniq, ra] = await Promise.all([
      http(src.siteUrl, 'GET', `${base}/HasUniqueRoleAssignments`).catch(() => ({ value: true })),
      http(src.siteUrl, 'GET', `${base}/roleassignments?$expand=Member,RoleDefinitionBindings&$select=PrincipalId,Member/Title,Member/LoginName,Member/PrincipalType,Member/Email,RoleDefinitionBindings/Id,RoleDefinitionBindings/Name`),
    ])
    const assignments = rows(ra).map<RoleAssign>((r) => {
      const defs = r.RoleDefinitionBindings?.results ?? r.RoleDefinitionBindings ?? []
      return { principal: { id: r.PrincipalId, title: r.Member?.Title ?? '', login: r.Member?.LoginName ?? '', kind: r.Member?.PrincipalType === 1 ? 'user' : 'group', email: r.Member?.Email }, roles: defs.map((x: any) => String(x.Name)), roleIds: defs.map((x: any) => Number(x.Id)) }
    })
    return { inherited: uniq?.value === false || uniq === false, assignments }   // lists inherit from the site until broken, too
  },
  async setInheritance(src, t, inherit) {
    const base = baseOf(src, t)
    await http(src.siteUrl, 'POST', inherit ? `${base}/resetroleinheritance` : `${base}/breakroleinheritance(copyRoleAssignments=true,clearSubscopes=false)`)
  },
  async addPermission(src, t, pid, rid) {
    await http(src.siteUrl, 'POST', `${baseOf(src, t)}/roleassignments/addroleassignment(principalid=${pid},roledefid=${rid})`)
  },
  async removePermission(src, t, ra) {
    await Promise.all(ra.roleIds.map((rid) => http(src.siteUrl, 'POST', `${baseOf(src, t)}/roleassignments/removeroleassignment(principalid=${ra.principal.id},roledefid=${rid})`)))
  },
  async listRoleDefs(src): Promise<RoleDef[]> {
    const d = await http(src.siteUrl, 'GET', '_api/web/roledefinitions?$select=Id,Name,Hidden,RoleTypeKind,Order')
    return rows(d).filter((r) => !r.Hidden && r.RoleTypeKind !== 1 && !/limited access/i.test(r.Name)).sort((a, b) => Number(a.Order ?? 0) - Number(b.Order ?? 0)).map((r) => ({ id: r.Id, name: String(r.Name) }))
  },
  async searchPrincipals(src, text, signal) {
    const out: (Principal & { login: string })[] = []
    try {
      const d = await http(src.siteUrl, 'POST', '_api/SP.UI.ApplicationPages.ClientPeoplePickerWebServiceInterface.clientPeoplePickerSearchUser',
        { queryParams: { __metadata: { type: 'SP.UI.ApplicationPages.ClientPeoplePickerQueryParameters' }, AllowEmailAddresses: true, AllowMultipleEntities: false, AllUrlZones: false, MaximumEntitySuggestions: 8, PrincipalSource: 15, PrincipalType: 15, QueryString: text } }, VERBOSE, signal)
      const raw = d?.value ?? d?.ClientPeoplePickerSearchUser ?? d?.d?.ClientPeoplePickerSearchUser   // nometadata wraps a scalar result as { value }
      for (const e of typeof raw === 'string' ? JSON.parse(raw) : raw ?? []) {
        const isGroup = e.EntityType === 'SPGroup' || e.EntityType === 'SecGroup' || /group/i.test(e.EntityType ?? '')
        out.push({ id: Number(e.EntityData?.SPGroupID ?? 0), title: e.DisplayText, login: e.Key, kind: isGroup ? 'group' : 'user', email: e.EntityData?.Email })
      }
    } catch (e) { if ((e as Error).name === 'AbortError') throw e }
    return out
  },
  async resolvePrincipal(src, p) {
    if (p.id > 0) return p.id
    const d = await http(src.siteUrl, 'POST', '_api/web/ensureuser', { logonName: p.login })
    return Number(d?.Id ?? d?.d?.Id)
  },

  async loadConfig(): Promise<AppConfig> {
    const fallback = (): AppConfig => lsGet<AppConfig>('spx.config', { v: 1, owners: [], sources: [], updated: '', updatedBy: '' })
    const cfg = (await kvGet<AppConfig>('config', true)) ?? fallback()
    // Owners come ONLY from the deployed bundle (written by the deploy script), never from the editable list.
    return { ...cfg, v: 1, owners: baked.owners as string[], sources: cfg.sources ?? [] }
  },

  async saveConfig(cfg) {
    lsSet('spx.config', cfg)
    const site = cfgSite() || cfg.sources[0]?.siteUrl
    if (site && !baked.configSiteUrl) lsSet('spx.configSite', site)
    await kvSet('config', { ...cfg, owners: [] }, site)
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
    if (f.kind === 'user' || (f.kind === 'lookup' && f.typeAsString.startsWith('Lookup'))) { sel.add(`${n}/${f.kind === 'lookup' ? f.lookupField || 'Title' : 'Title'}`); if (f.kind === 'user') sel.add(`${n}/Id`); exp.add(n) }
    else sel.add(n)
  }
  if (isLibrary) ['FileRef', 'FileDirRef', 'FileLeafRef', 'FSObjType', 'File_x0020_Type', 'File_x0020_Size'].forEach((x) => sel.add(x))
  const e = [...exp].slice(0, 12)
  return `$select=${[...sel].filter((s) => !s.includes('/') || e.includes(s.split('/')[0])).join(',')}${e.length ? `&$expand=${e.join(',')}` : ''}`
}

function toRow(item: any, fields: SpField[]): Row {
  const row: Row = { __id: Number(item.Id ?? item.ID), ID: Number(item.Id ?? item.ID) }
  for (const k of ['FileRef', 'FileDirRef', 'FileLeafRef', 'File_x0020_Type']) if (item[k] != null) row[k] = item[k]
  if (item.FSObjType != null) row.FSObjType = Number(item.FSObjType)
  if (item.File_x0020_Size != null) row.File_x0020_Size = Number(item.File_x0020_Size)
  for (const f of fields) {
    if (!(f.internal in item)) continue
    let v = item[f.internal]
    if (v && typeof v === 'object' && !Array.isArray(v) && 'results' in v) v = v.results
    if (f.kind === 'user') row[f.internal + '__ids'] = (Array.isArray(v) ? v : v ? [v] : []).map((x: any) => x?.Id).filter((n: unknown) => n != null)
    if (f.kind === 'user' || f.kind === 'lookup') v = Array.isArray(v) ? v.map((x) => x?.[f.lookupField || 'Title'] ?? x?.Title ?? x?.Label ?? '').join('; ') : v?.[f.lookupField || 'Title'] ?? v?.Title ?? v?.Label ?? ''
    else if (f.kind === 'number' || f.kind === 'currency') v = v == null ? null : Number(v)
    row[f.internal] = v
  }
  return row
}

/* ------------------------------------------------------------------ small key/value store in the SPX_Config list */
const cfgSite = () => baked.configSiteUrl || lsGet<string>('spx.configSite', '')
const cfgUri = () => `_api/web/lists/getbytitle(${odataQuote(baked.configList)})`

async function kvGet<T>(key: string, strict = false): Promise<T | null> {
  const site = cfgSite(); if (!site) return null
  try {
    const d = await http(site, 'GET', `${cfgUri()}/items?$select=Id,ConfigJson&$filter=${enc(`Title eq ${odataQuote(key)}`)}&$top=1`)
    const it = rows(d)[0]
    return it?.ConfigJson ? (JSON.parse(it.ConfigJson) as T) : null
  } catch (e) {
    // only 'the settings list does not exist yet' counts as empty; connection / permission problems must be visible
    if (strict && !/404|does not exist|not found|List .* not found/i.test((e as Error).message)) throw new Error(`Could not read the app settings list on ${site}: ${(e as Error).message}`)
    return null
  }
}

async function kvSet(key: string, value: unknown, siteArg?: string): Promise<void> {
  const site = siteArg || cfgSite(); if (!site) return
  try { await http(site, 'GET', `${cfgUri()}?$select=Id`) } catch {
    await http(site, 'POST', '_api/web/lists', { Title: baked.configList, BaseTemplate: 100, Description: 'App configuration for the SharePoint Explorer code app. Keep editable by app owners / data admins only.' })
    await http(site, 'POST', `${cfgUri()}/fields`, { Title: 'ConfigJson', FieldTypeKind: 3 })
  }
  const body = { Title: key, ConfigJson: JSON.stringify(value) }
  const existing = rows(await http(site, 'GET', `${cfgUri()}/items?$select=Id&$filter=${enc(`Title eq ${odataQuote(key)}`)}&$top=1`))[0]
  if (existing) await http(site, 'POST', `${cfgUri()}/items(${existing.Id})`, body, { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' })
  else await http(site, 'POST', `${cfgUri()}/items`, body)
}

const entityCache = new Map<string, string>()
async function entityType(src: SourceConfig): Promise<string> {
  let t = entityCache.get(src.listId)
  if (!t) { const d = await http(src.siteUrl, 'GET', `_api/web/lists(${guid(src.listId)})?$select=ListItemEntityTypeFullName`); t = String(d.ListItemEntityTypeFullName); entityCache.set(src.listId, t) }
  return t
}
const VERBOSE = { 'Content-Type': 'application/json;odata=verbose' }

/** Write payload (odata=verbose is what SharePoint needs for multi-value, person and URL columns). */
async function writeBody(src: SourceConfig, fields: SpField[], values: Record<string, unknown>, withType = true) {
  const body: Record<string, unknown> = withType ? { __metadata: { type: await entityType(src) } } : {}
  for (const [k, v] of Object.entries(values)) {
    const f = fields.find((x) => x.internal === k)
    if (!f || (!isEditable(f) && k !== 'FileLeafRef')) continue
    const empty = v === '' || v == null || (Array.isArray(v) && !v.length)
    if (f.kind === 'user') {
      const ps = ((v as Principal[] | undefined) ?? []).filter((p) => p.id > 0 || p.login)
      const ids = await Promise.all(ps.map((p) => sp.resolvePrincipal(src, p)))
      body[`${k}Id`] = f.multi ? { __metadata: { type: 'Collection(Edm.Int32)' }, results: ids } : ids[0] ?? null
    } else if (f.kind === 'multichoice') body[k] = { __metadata: { type: 'Collection(Edm.String)' }, results: (v as string[]) ?? [] }
    else if (f.kind === 'url') { const u = v as { url?: string; desc?: string } | null; body[k] = u?.url ? { __metadata: { type: 'SP.FieldUrlValue' }, Url: u.url, Description: u.desc || u.url } : null }
    else if (empty) body[k] = null
    else if (f.kind === 'number' || f.kind === 'currency') body[k] = Number(v)
    else if (f.kind === 'date') body[k] = /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? `${v}T12:00:00Z` : new Date(String(v)).toISOString()   // noon UTC: a date-only value never slips to the previous day in any time zone
    else body[k] = v
  }
  return body
}

const fileToBase64 = (file: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = () => rej(r.error); r.readAsDataURL(file) })
const siteRel = (src: SourceConfig) => new URL(src.siteUrl).pathname.replace(/\/$/, '')
const rel = (src: SourceConfig, serverRel: string) => serverRel.startsWith(siteRel(src)) ? serverRel.slice(siteRel(src).length) || '/' : serverRel
const baseOf = (src: SourceConfig, t: PermTarget) => `_api/web/lists(${guid(src.listId)})${t.kind === 'item' ? `/items(${t.id})` : ''}`
const pathQ = (p: string) => enc(odataQuote(p)).replace(/%2F/gi, '/')   // keep slashes readable: IIS rejects encoded slashes inside the URL path

/* ------------------------------------------------------------------ SharePoint Search path (millions of items) */
/** Free-text search on a big list goes through the SharePoint Search index (fast at any size, relevance ranked), not a table scan. */
function useSearchApi(src: SourceConfig, q: Query, cursor?: string) {
  if (cursor && !cursor.startsWith('s:')) return false
  const ps = parseSearch(q.search)
  return !!src.url && src.itemCount > 5000 && ps.terms.length > 0 && ps.fielded.length === 0 && q.sort.field === 'ID' && q.sort.dir === 'desc'
}

async function searchPage(src: SourceConfig, fields: SpField[], select: string[], q: Query, top: number, cursor: string | undefined, signal?: AbortSignal): Promise<Page | null> {
  const ps = parseSearch(q.search)
  const start = cursor?.startsWith('s:') ? Number(cursor.slice(2)) : 0
  const origin = new URL(src.siteUrl).origin
  const kql = [...ps.terms.map((t) => (/\s/.test(t) ? `"${t}"` : t)), ...ps.excludes.map((t) => `-${/\s/.test(t) ? `"${t}"` : t}`), `path:"${origin}${src.url}"`, src.isLibrary && !q.folders ? 'IsDocument:true' : ''].filter(Boolean).join(' ')
  const lim = Math.min(top, 250)
  const d = await http(src.siteUrl, 'GET', `_api/search/query?querytext=${enc(odataQuote(kql))}&selectproperties='ListItemID'&rowlimit=${lim}&startrow=${start}&trimduplicates=false`, undefined, {}, signal)
  const rel = d?.PrimaryQueryResult?.RelevantResults ?? d?.d?.query?.PrimaryQueryResult?.RelevantResults
  const rws: any[] = rel?.Table?.Rows?.results ?? rel?.Table?.Rows ?? []
  const ids = rws.map((r) => { const cells = r.Cells?.results ?? r.Cells ?? []; return Number(cells.find((c: any) => c.Key === 'ListItemID')?.Value) }).filter((n) => n > 0)
  if (!ids.length) return start === 0 ? null : { rows: [], scanned: 0 }   // nothing indexed (yet): let the caller fall back to a filter query
  const sel = selectExpand(fields, select, src.isLibrary)
  const extra = buildFilter({ ...q, search: '' }, fields, src.isLibrary)
  const chunks: number[][] = []
  for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30))
  const parts = await Promise.all(chunks.map((c) => {
    const f = `(${c.map((id) => `Id eq ${id}`).join(' or ')})${extra ? ` and ${extra}` : ''}`
    return http(src.siteUrl, 'GET', `_api/web/lists(${guid(src.listId)})/items?${sel}&$filter=${enc(f)}&$top=30`, undefined, {}, signal)
  }))
  const byId = new Map<number, Row>()
  for (const part of parts) for (const it of rows(part)) { const r = toRow(it, fields); byId.set(r.__id, r) }
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean) as Row[]
  return { rows: ordered, scanned: ids.length, cursor: ids.length >= lim ? `s:${start + lim}` : undefined }
}

/* ------------------------------------------------------------------ library folder view (CAML GetItems scoped to one folder) */
const FOLDER_PAGE = 1000
async function folderPage(src: SourceConfig, fields: SpField[], select: string[], q: Query, cursor: string | undefined, signal?: AbortSignal): Promise<Page> {
  const after = cursor?.startsWith('id:') ? Number(cursor.slice(3)) : 0
  const view = (type: 0 | 1, from: number, limit: number) => `<View><Query><Where><And><Eq><FieldRef Name='FSObjType'/><Value Type='Integer'>${type}</Value></Eq><Geq><FieldRef Name='ID'/><Value Type='Counter'>${from}</Value></Geq></And></Where><OrderBy Override='TRUE'><FieldRef Name='ID'/></OrderBy></Query><RowLimit>${limit}</RowLimit></View>`
  const get = (type: 0 | 1, from: number, limit: number) => http(src.siteUrl, 'POST', `_api/web/lists(${guid(src.listId)})/GetItems?${selectExpand(fields, select, true)}`,
    { query: { __metadata: { type: 'SP.CamlQuery' }, ViewXml: view(type, from, limit), FolderServerRelativeUrl: q.folder } }, VERBOSE, signal)
  const [folders, files] = await Promise.all([after === 0 ? get(1, 0, 1000) : Promise.resolve(null), get(0, after, FOLDER_PAGE)])
  const f = rows(files).map((i) => toRow(i, fields))
  const all = [...(folders ? rows(folders).map((i) => toRow(i, fields)) : []), ...f]
  return { rows: all, scanned: all.length, cursor: f.length >= FOLDER_PAGE ? `id:${f[f.length - 1].__id + 1}` : undefined }
}

/* ------------------------------------------------------------------ diagnostics (what an admin needs when "it shows demo data / no data") */
export interface Check { label: string; ok: boolean | null; detail: string }
const within = <T,>(p: Promise<T>, ms = 9000) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`no answer within ${ms / 1000} s (is the app running inside Power Apps?)`)), ms))])
export async function diagnose(testSite?: string): Promise<Check[]> {
  const out: Check[] = []
  const entries = Object.entries<any>(dataSourcesInfo)
  out.push({ label: 'Data sources compiled into this app', ok: entries.length > 0, detail: entries.length ? entries.map(([k, v]) => `${k} (${v?.dataSourceType ?? '?'}, table ${v?.tableId || '—'}, ${Object.keys(v?.apis ?? {}).length} operations)`).join(' · ') : 'none — .power/schemas/appschemas/dataSourcesInfo.ts was not part of the build. Re-run the deploy script (pac code add-data-source must run before the build).' })
  out.push({ label: 'Connector candidates', ok: candidates().length > 0, detail: candidates().join(', ') || 'none' })
  try { const c = await within(getContext()); out.push({ label: 'Power Apps context (getContext)', ok: true, detail: `${c.user.userPrincipalName ?? c.user.fullName ?? 'user'} · environment ${c.app.environmentId}` }) }
  catch (e) { out.push({ label: 'Power Apps context (getContext)', ok: false, detail: (e as Error).message }) }
  try { out.push({ label: 'Data source bound to the SharePoint connection', ok: true, detail: await within(spKey()) }) } catch (e) { out.push({ label: 'Data source bound to the SharePoint connection', ok: false, detail: (e as Error).message }) }
  try { const r = rows(await within(exec('GetDataSets', {}))); out.push({ label: 'SharePoint connection works (list of sites)', ok: true, detail: `${r.length} site(s) returned` }) }
  catch (e) { out.push({ label: 'SharePoint connection works (list of sites)', ok: false, detail: (e as Error).message }) }
  const site = testSite || baked.configSiteUrl || lsGet<string>('spx.lastSite', '')
  if (site) {
    try { const w = await within(http(site, 'GET', '_api/web?$select=Title,Url')); out.push({ label: `SharePoint REST on ${site}`, ok: true, detail: `${w.Title} — ${w.Url}` }) }
    catch (e) { out.push({ label: `SharePoint REST on ${site}`, ok: false, detail: (e as Error).message }) }
  }
  out.push({ label: 'Config site for shared settings', ok: !!baked.configSiteUrl, detail: baked.configSiteUrl || 'not set at deploy time: other users cannot see what the owner connected' })
  return out
}
