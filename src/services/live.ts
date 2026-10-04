/**
 * Live backend - NO Azure app registration.
 *
 * Runs inside Power Apps, so every call goes through the signed-in admin's own connector connections via the
 * code-apps SDK (`getClient(...).executeAsync`). Operations are discovered from the generated
 * `.power/schemas/appschemas/dataSourcesInfo.ts` by operation id and/or REST path across ALL added connectors:
 *
 *   Power Platform for Admins  (shared_powerplatformforadmins)  Get-AdminEnvironment        -> environments
 *   Power Apps for Admins      (shared_powerappsforadmins)      Get-AdminApps / Set-AdminAppOwner
 *   Power Automate Management  (shared_flowmanagement)          List Flows as Admin / Modify Flow Owners as Admin
 *   Power Automate for Admins  (shared_microsoftflowforadmins)  optional: owner role operations
 *   Office 365 Users           (shared_office365users)          email -> Entra object id
 *   Power Platform for Admins V2 (shared_powerplatformadminv2)  Copilot Studio agents: tenant-wide inventory query + ReassignCopilotAgent
 *   (fallbacks for agents: this app's own Dataverse, or the legacy Dataverse connector)
 */
import { log } from '../oplog'
import { getClient } from '@microsoft/power-apps/data'
import { getContext } from '@microsoft/power-apps/app'
import type { AgentCategory, Asset, Backend, Env, ScanNote, SolutionGroup } from '../types'

/* eslint-disable @typescript-eslint/no-explicit-any */
const infoModules = import.meta.glob('../../.power/schemas/appschemas/dataSourcesInfo.ts', { eager: true }) as Record<string, any>

function loadInfo(): Record<string, any> {
  const mod = Object.values(infoModules)[0]
  if (!mod) return {}
  if (mod.dataSourcesInfo) return mod.dataSourcesInfo
  if (mod.default && typeof mod.default === 'object') return mod.default.dataSourcesInfo ?? mod.default
  const firstObj = Object.values(mod).find((v) => v && typeof v === 'object')
  return (firstObj as any) ?? {}
}
const dataSourcesInfo = loadInfo()

const SYNTHETIC = new Set(['connectionid', 'dataset', 'tablename'])

interface Op {
  ds: string
  op: string
  method: string
  path: string
  norm: string // operation id, lower-case alphanumerics only
  params: { name: string; in: string; required: boolean }[]
  pathNames: string[] // user-supplied path params, in path order (connectionId etc. removed)
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

function allOps(): Op[] {
  const out: Op[] = []
  for (const [ds, info] of Object.entries<any>(dataSourcesInfo)) {
    for (const [op, def] of Object.entries<any>(info?.apis ?? {})) {
      const path = String(def.path ?? '')
      const params = (def.parameters ?? []) as Op['params']
      let pathNames = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).filter((n) => !SYNTHETIC.has(n.toLowerCase()))
      if (!pathNames.length) pathNames = params.filter((p) => p.in === 'path' && !SYNTHETIC.has(p.name.toLowerCase())).map((p) => p.name)
      out.push({ ds, op, method: String(def.method ?? '').toUpperCase(), path, norm: norm(op), params, pathNames })
    }
  }
  return out
}

const bare = (p: string) => p.split('?')[0].replace(/\/+$/, '')
const pick = (...cands: (Op | undefined)[]) => cands.find(Boolean) ?? null

/** Every operation that can list flows, best first: lists that include the creator, then V2 (ids only). */
function flowLists(): Op[] {
  const o = allOps()
  const v1 = o.filter((x) => x.method === 'GET' && /admin\/environments\/\{[^}/]+\}\/flows$/i.test(bare(x.path)))
  const named = o.filter((x) => /^(getadminflows?|listflowsasadmin)$/.test(x.norm))
  const v2 = o.filter((x) => (x.method === 'GET' && /admin\/environments\/\{[^}/]+\}\/v2\/flows$/i.test(bare(x.path))) || /^listflowsasadminv2|listflowsinenvironmentv2asadmin/.test(x.norm))
  return [...new Set([...v1, ...named, ...v2])]
}

const OPS = {
  /** Power Platform for Admins: list all environments (no path params). */
  envs: () => { const o = allOps(); return pick(
    o.find((x) => x.method === 'GET' && /scopes\/admin\/environments$/i.test(bare(x.path)) && !x.pathNames.length),
    o.find((x) => /^(getadminenvironments?|listenvironmentsasadmin|getenvironmentsasadmin)$/.test(x.norm) && !x.pathNames.length)) },
  /** Power Apps for Admins: list apps in an environment. */
  apps: () => { const o = allOps(); return pick(
    o.find((x) => x.norm === 'getadminapps'),
    o.find((x) => x.method === 'GET' && /admin\/environments\/\{[^}/]+\}\/apps$/i.test(bare(x.path)))) },
  appOwner: () => { const o = allOps(); return pick(
    o.find((x) => x.norm === 'setadminappowner'),
    o.find((x) => x.method === 'POST' && /modifyAppOwner/i.test(x.path))) },
  /** Kept for diagnostics: the preferred flow-list operation. */
  flows: () => flowLists()[0] ?? null,
  flowOwner: () => { const o = allOps(); return pick(
    o.find((x) => /^(modifyflowownersasadmin|modifyflowownersadmin)$/.test(x.norm)),
    o.find((x) => x.method === 'POST' && /flows\/\{[^}/]+\}\/modifyPermissions/i.test(x.path)),
    o.find((x) => /^(setadminflowownerrole|editflowownerroleasadmin)$/.test(x.norm))) },
  /** Used only when the flow list has no creator info (V2). */
  flowOwners: () => { const o = allOps(); return pick(
    o.find((x) => /^(getadminflowownerrole|getflowownerroleasadmin)$/.test(x.norm)),
    o.find((x) => x.method === 'GET' && /admin\/environments\/\{[^}/]+\}\/flows\/\{[^}/]+\}\/(owners|permissions)$/i.test(bare(x.path)))) },
  /** Power Apps for Admins: read one app back (used to verify an owner change at the source). */
  appGet: () => { const o = allOps(); return pick(
    o.find((x) => x.norm === 'getadminapp'),
    o.find((x) => x.method === 'GET' && /admin\/environments\/\{[^}/]+\}\/apps\/\{[^}/]+\}$/i.test(bare(x.path)))) },
  /** Power Platform for Admins V2: tenant-wide inventory ("Query Power Platform resources"). */
  inventory: () => { const o = allOps(); return pick(
    o.find((x) => x.method === 'POST' && /resourcequery\/resources\/query/i.test(x.path)),
    o.find((x) => /^(queryresources?|resourcequery|querypowerplatformresources?|queryresourcesinventory)$/.test(x.norm))) },
  /** Power Platform for Admins V2: "Reassign the owner of the bot" (ReassignCopilotAgent). */
  agentReassign: () => { const o = allOps(); return pick(
    o.find((x) => x.norm === 'reassigncopilotagent'),
    o.find((x) => x.method === 'POST' && /botAdminOperations\/reassign/i.test(x.path))) },
  /** Power Platform for Admins: "Add Admin Power Apps Sync User" = add a user as a member (Dataverse user record) of an environment, no roles needed. */
  syncUser: () => { const o = allOps(); return pick(
    o.find((x) => x.norm === 'addadminpowerappssyncuser'),
    o.find((x) => x.method === 'POST' && /\/(addUser|syncUser|addsyncuser)\b/i.test(x.path))) },
  /** Microsoft Dataverse (legacy): list / patch rows in ANY environment by passing `dataset` (the org host). */
  dvList: () => { const o = allOps(); return pick(
    o.find((x) => /commondataservice/i.test(x.ds) && x.method === 'GET' && /datasets\/\{dataset\}\/tables\/\{table\}\/items$/i.test(bare(x.path))),
    o.find((x) => /commondataservice/i.test(x.ds) && x.method === 'GET' && /datasets\/\{[^}]+\}\/tables\/\{[^}]+\}\/items$/i.test(bare(x.path))),
    o.find((x) => /commondataservice/i.test(x.ds) && /^(listrecords|listrecordswithorganization|getitems|listrows)$/.test(x.norm)),
    o.find((x) => /commondataservice/i.test(x.ds) && x.method === 'GET' && /\/items$/i.test(bare(x.path)) && x.pathNames.length >= 1)) },
  dvUpdate: () => { const o = allOps(); return pick(
    o.find((x) => /commondataservice/i.test(x.ds) && x.method === 'PATCH' && /datasets\/\{dataset\}\/tables\/\{table\}\/items\/\{[^}]+\}$/i.test(bare(x.path)))) },
  user: () => { const o = allOps(); return pick(
    o.find((x) => /office365users/i.test(x.ds) && x.norm === 'userprofilev2'),
    o.find((x) => /office365users/i.test(x.ds) && x.method === 'GET' && /\/users\/\{[^}/]+\}$/i.test(bare(x.path)))) },
} as const
type OpKey = keyof typeof OPS
const REQUIRED: OpKey[] = ['apps', 'appOwner', 'user']
const NEEDS: Partial<Record<OpKey, string>> = { envs: 'environment list', flows: 'flow list', flowOwner: 'change flow owner', flowOwners: 'flow owners lookup (only if list has no creator)', dvList: 'agents fallback (legacy Dataverse read)', dvUpdate: 'agents fallback (legacy Dataverse write)', inventory: 'Copilot Studio agents - discovery (all environments)', agentReassign: 'Copilot Studio agents - transfer', appGet: 'read an app back to verify its owner', syncUser: 'add new owner to an environment (membership, no roles)' }

const need = (k: OpKey): Op => {
  const o = OPS[k]()
  if (!o) throw new Error(`Connector operation "${k}" not found - add the matching connector (see 🩺 Diagnostics) and re-run the deploy script.`)
  return o
}

/** The connectors mark api-version as "optional", but the Power Platform services reject calls without one. */
const API_VERSION: Record<string, string> = { powerapps: '2017-08-01', flow: '2016-11-01', platform: '2020-10-01' }
const defaultApiVersion = (o: Op) =>
  /botAdminOperations/i.test(o.path) ? '1'                                  // Copilot Studio admin API
  : /resourcequery/i.test(o.path) ? '2024-10-01'                            // Power Platform inventory API
  : /adminv2/i.test(o.ds) ? '2024-10-01'
  : /powerplatform/i.test(o.ds) ? API_VERSION.platform : /flow/i.test(o.ds) ? API_VERSION.flow : API_VERSION.powerapps
const PREFERRED_VERSIONS = ['2020-10-01', '2016-11-01', '2017-08-01', '2018-01-01', '2019-05-01', '2020-06-01', '2021-04-01']
const versionCache: Record<string, string> = {}
const isApiVersionParam = (name: string) => /^api[-_]?version$/i.test(name)

/** Parse the "supported list of API versions are: …" part of an InvalidApiVersion error and pick one. */
function pickSupportedVersion(message: string): string | null {
  const tail = message.split(/supported list/i)[1] ?? message
  const versions = [...new Set(tail.match(/\d{4}-\d{2}-\d{2}/g) ?? [])]
  if (!versions.length) return null
  return PREFERRED_VERSIONS.find((v) => versions.includes(v)) ?? versions[Math.max(0, versions.length - 2)]
}

// One SDK client for the whole session - creating one per call is slow and wastes memory on big scans.
let cachedClient: ReturnType<typeof getClient> | null = null
const sdk = () => (cachedClient ??= getClient(dataSourcesInfo as any))

async function callRaw(o: Op, pathValues: string[] = [], body?: unknown, query: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<any> {
  const cacheKey = `${o.ds}|${o.op}`
  const build = (): Record<string, unknown> => {
    const params: Record<string, unknown> = {}
    o.pathNames.forEach((n, i) => { if (pathValues[i] !== undefined) params[n] = pathValues[i] })
    for (const p of o.params) {
      if (SYNTHETIC.has(p.name.toLowerCase())) continue
      if (p.in === 'body') params[p.name] = body
      else if (p.in === 'query') {
        if (p.name in query) params[p.name] = query[p.name]
        else if (isApiVersionParam(p.name)) params[p.name] = versionCache[cacheKey] ?? defaultApiVersion(o)   // always send, even if "optional"
      } else if (p.in === 'header' && /content-?type/i.test(p.name) && body !== undefined) params[p.name] = 'application/json'
    }
    return { ...params, ...extra }
  }
  const run = async () => {
    const t0 = Date.now()
    const built = build()
    log(`→ ${o.ds}.${o.op} ${JSON.stringify(Object.fromEntries(Object.entries(built).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v).slice(0, 160) : String(v).slice(0, 80)])))}`)
    const res: any = await sdk().executeAsync({ connectorOperation: { tableName: o.ds, operationName: o.op, parameters: built } })
    log(`← ${o.op} ${res?.success ? 'OK' : 'FAILED'} in ${Date.now() - t0} ms${res?.success ? '' : ' – ' + String(res?.error?.message ?? res?.error ?? '').slice(0, 220)}`)
    if (!res?.success) {
      const e = res?.error
      const st = e?.status ?? e?.statusCode ?? res?.status
      const rawMsg: string = e?.message ?? (typeof e === 'string' ? e : JSON.stringify(e ?? 'Connector call failed'))
      // The message is often a JSON document ({"error":{"message":..., "innerError": "<the real reason>"}}): surface both parts.
      let pretty = rawMsg
      try {
        const start = rawMsg.indexOf('{'); const end = rawMsg.lastIndexOf('}')
        if (start >= 0 && end > start) {
          const j = JSON.parse(rawMsg.slice(start, end + 1))
          const er = j?.error ?? j
          const inner = typeof er?.innerError === 'string' ? er.innerError : er?.innerError?.message
          pretty = [er?.message, inner].filter(Boolean).join(' — ') || rawMsg
        }
      } catch { /* not JSON */ }
      console.warn('connector error', o.op, st, rawMsg.slice(0, 600))
      const raw = `${st ? `HTTP ${st}: ` : ''}${pretty}`
      throw new Error(`${/InvalidApiVersion/i.test(rawMsg) ? 'InvalidApiVersion: ' : ''}${raw}`)
    }
    return res.data
  }
  try {
    return await run()
  } catch (err) {
    const msg = (err as Error).message
    const hasVersionParam = o.params.some((p) => p.in === 'query' && isApiVersionParam(p.name))
    if (hasVersionParam && /InvalidApiVersion/i.test(msg)) {
      const v = pickSupportedVersion(msg)
      if (v && v !== versionCache[cacheKey]) { versionCache[cacheKey] = v; return await run() }
    }
    throw err
  }
}

/** Unwrap the `value` array of an OData-style response. */
const call = async (o: Op, pathValues: string[] = [], body?: unknown, query: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<any> => {
  const d = await callRaw(o, pathValues, body, query, extra)
  return d?.value ?? d
}

/** Follow `nextLink` / skiptoken paging when the operation exposes a skiptoken parameter (bounded). */
async function callAll(o: Op, pathValues: string[], maxPages = 10, maxItems = 20000): Promise<{ items: any[]; truncated: boolean }> {
  const tokenParam = o.params.find((p) => p.in === 'query' && /skiptoken/i.test(p.name))?.name
  const items: any[] = []
  let token: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const d = await callRaw(o, pathValues, undefined, token && tokenParam ? { [tokenParam]: token } : {})
    items.push(...asList(d))
    const link: string | undefined = d?.nextLink ?? d?.['@odata.nextLink']
    const m = link ? /[?&]\$?skiptoken=([^&]+)/i.exec(link) : null
    token = m ? decodeURIComponent(m[1]) : undefined
    if (!token || !tokenParam) return { items, truncated: !!link && !tokenParam }
    if (items.length >= maxItems) return { items, truncated: true }
    await tick()
  }
  return { items, truncated: true }
}

async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (let k = i++; k < items.length; k = i++) out[k] = await fn(items[k])
  }))
  return out
}

const stateOf = (s?: string): Asset['state'] => (s === 'Started' || s === 'Stopped' || s === 'Suspended' ? s : 'Unknown')
const asList = (v: any): any[] => (Array.isArray(v) ? v : Array.isArray(v?.value) ? v.value : [])
const tick = () => new Promise<void>((r) => setTimeout(r, 0)) // yield to the browser so memory can be reclaimed between heavy steps



// ---- Copilot Studio agents via the tenant-wide Power Platform inventory (works for EVERY environment) ----
const invProp = (r: any, k: string): any => {
  let p = r?.properties
  if (typeof p === 'string') { try { p = JSON.parse(p) } catch { p = undefined } }
  return p?.[k] ?? r?.[`properties.${k}`] ?? r?.[`properties_${k}`] ?? r?.[k]
}
const invRows = (d: any): any[] => (Array.isArray(d?.data) ? d.data : Array.isArray(d?.body?.data) ? d.body.data : Array.isArray(d) ? d : asList(d))

/** Short string facts about an inventory row (used as classification evidence and shown in the UI). */
function invMeta(r: any): Record<string, string> {
  let p = r?.properties
  if (typeof p === 'string') { try { p = JSON.parse(p) } catch { p = {} } }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries<any>(p ?? {})) {
    if (v == null || typeof v === 'object') continue
    const sv = String(v)
    if (sv.length <= 80 && !/^(ownerId|environmentId|tenantId|displayName|createdAt|modifiedAt|lastModifiedAt)$/i.test(k)) out[k] = sv
  }
  if (r?.kind) out.kind = String(r.kind)
  return out
}

/**
 * The inventory type "microsoft.copilotstudio/agents" is broader than "agents you build in Copilot Studio"
 * (it also contains Agent Builder agents, CLI harness agents, and tool / MCP style entries). Classify so the UI can
 * show real Copilot Studio agents by default and hide the rest behind a toggle.
 */
function classifyAgent(r: any): { category: AgentCategory; meta: Record<string, string> } {
  const meta = invMeta(r)
  const name = String(invProp(r, 'displayName') ?? r?.name ?? '')
  // Structural properties only - NEVER the display name, otherwise a real agent called e.g. "IT Tool Desk" would be hidden as a tool.
  const hay = Object.entries(meta).filter(([k]) => /type|kind|categor|template|schema|source|origin|harness|createdIn/i.test(k)).map(([, v]) => v).join(' ')
  void name
  const createdIn = String(meta.createdIn ?? '').toLowerCase()
  let category: AgentCategory = 'agent'
  if (String(meta.isCLIAgent ?? '').toLowerCase() === 'true') meta.flavor = 'GitHub Copilot'   // shown in Copilot Studio's agent list, so it IS an agent
  else if (/(^|[^a-z0-9])mcp([^a-z0-9]|$)|model[ -]context[ -]protocol/i.test(hay)) category = 'mcp'
  else if (/(^|[^a-z0-9])(tool|tools|connector action|plugin)([^a-z0-9]|$)/i.test(hay)) category = 'tool'
  else if (/agent ?builder|m365 ?copilot|microsoft ?365|copilot ?chat|word|excel|powerpoint|outlook|sharepoint|teams ?toolkit/i.test(createdIn)) category = 'agentbuilder'
  return { category, meta }
}

async function inventoryAgents(op: Op, ownerAad: string | null): Promise<{ rows: any[]; total?: number; truncated: boolean }> {
  const rows: any[] = []
  let token: string | undefined
  let total: number | undefined
  for (let page = 0; page < 20; page++) {
    const clauses: any[] = [{ $type: 'where', FieldName: 'type', Operator: '==', Values: ["'microsoft.copilotstudio/agents'"] }]
    if (ownerAad) clauses.push({ $type: 'where', FieldName: 'properties.ownerId', Operator: '==', Values: [`'${ownerAad}'`] })
    const body = { TableName: 'PowerPlatformResources', Clauses: clauses, Options: { Top: 1000, ...(token ? { SkipToken: token } : {}) } }
    const d = await callRaw(op, [], body)
    rows.push(...invRows(d))
    total = d?.totalRecords ?? d?.body?.totalRecords ?? total
    token = d?.skipToken ?? d?.body?.skipToken
    if (!token) return { rows, total, truncated: false }
    if (rows.length >= 20000) break
    await tick()
  }
  return { rows, total, truncated: true }
}

// ---- Dataverse of the environment this app runs in (no extra connection needed; added by `pac code add-data-source -a dataverse`) ----
/**
 * pac names Dataverse data sources by display name (the `bot` table becomes "agents", `systemuser` becomes "users"),
 * so identify them by what they ARE: primary key / entity set / logical name, with the key name as a last resort.
 */
const DV_TABLES = {
  bot: { pk: 'botid', entitySet: 'bots', logical: 'bot', names: /^(bots?|agents?|copilots?|chatbots?)$/i },
  systemuser: { pk: 'systemuserid', entitySet: 'systemusers', logical: 'systemuser', names: /^(systemusers?|users?)$/i },
} as const
function nativeKey(t: keyof typeof DV_TABLES): string | null {
  const d = DV_TABLES[t]
  const entries = Object.entries<any>(dataSourcesInfo).filter(([, info]) => /dataverse/i.test(String(info?.dataSourceType ?? '')) || Object.keys(info?.apis ?? {}).length === 0)
  const hit =
    entries.find(([, i]) => i?.primaryKey === d.pk) ??
    entries.find(([, i]) => i?.entitySetName === d.entitySet || i?.logicalName === d.logical) ??
    entries.find(([k]) => d.names.test(k))
  return hit?.[0] ?? null
}
const nativeTable = (re: RegExp): string | null => (re.test('bot') ? nativeKey('bot') : nativeKey('systemuser'))
let currentEnvId: string | null | undefined
async function getCurrentEnvId(): Promise<string | null> {
  if (currentEnvId !== undefined) return currentEnvId
  try { currentEnvId = (await getContext()).app.environmentId ?? null } catch { currentEnvId = null }
  return currentEnvId
}
async function nativeSystemUserId(aadId: string): Promise<string | null> {
  const t = nativeTable(/^systemusers?$/i)
  if (!t) return null
  const r: any = await sdk().retrieveMultipleRecordsAsync<any>(t, { filter: `azureactivedirectoryobjectid eq ${aadId}`, select: ['systemuserid'], top: 1 })
  if (!r?.success) throw new Error(r?.error?.message ?? 'Dataverse query failed (systemusers)')
  return r.data?.[0]?.systemuserid ?? null
}

// ---- Authoritative Dataverse access for ANY environment: this app's own (native) or the Microsoft Dataverse connector (org host) ----
const orgHosts = new Map<string, string>()
type DvQuery = (table: string, filter: string, select: string[], top?: number) => Promise<any[]>
async function dvConnectorRows(host: string, table: string, filter: string, select: string, top: number): Promise<any[]> {
  const op = OPS.dvList()
  if (!op) throw new Error('Microsoft Dataverse connector is not in this build')
  const extra: Record<string, unknown> = {}
  for (const p of op.params) {                      // parameter names differ between Dataverse connector versions: map by meaning
    const n = p.name.toLowerCase()
    if (p.in === 'path' || p.in === 'header') {
      if (/dataset|organi|environment|instance|^org/.test(n)) extra[p.name] = host
      else if (/table|entity/.test(n)) extra[p.name] = table
    } else if (p.in === 'query') {
      const k = n.replace('$', '')
      if (k === 'filter') extra[p.name] = filter
      else if (k === 'select') extra[p.name] = select
      else if (k === 'top') extra[p.name] = top
    }
  }
  return asList(await callRaw(op, [], undefined, {}, extra))
}
async function dvFor(envId: string): Promise<DvQuery | null> {
  const home = (await getCurrentEnvId())?.toLowerCase() === envId.toLowerCase()
  const host = orgHosts.get(envId.toLowerCase())
  const viaConnector: DvQuery | null = host && OPS.dvList() ? (table, filter, select, top = 500) => dvConnectorRows(host, table, filter, select.join(','), top) : null
  if (home && nativeKey('bot') && nativeKey('systemuser')) {
    return async (table, filter, select, top = 500) => {
      if (table !== 'bots' && table !== 'systemusers') {                  // other tables (solutions, components) only via the Dataverse connector
        if (!viaConnector) throw new Error('Reading solutions needs the Microsoft Dataverse connector (re-run the deploy script).')
        return viaConnector(table, filter, select, top)
      }
      const t = table === 'bots' ? nativeKey('bot')! : nativeKey('systemuser')!
      const r: any = await sdk().retrieveMultipleRecordsAsync<any>(t, { filter, select, top })
      if (!r?.success) throw new Error(r?.error?.message ?? 'Dataverse query failed')
      return r.data ?? []
    }
  }
  return viaConnector
}

export const liveBackend: Backend = {
  label: 'Live',

  async listEnvironments() {
    const op = OPS.envs()
    if (op) {
      const rows = asList(await call(op))
      rows.forEach((e) => { const u = e.properties?.linkedEnvironmentMetadata?.instanceUrl ?? e.properties?.linkedEnvironmentMetadata?.instanceApiUrl; if (u) { try { orgHosts.set(String(e.name).toLowerCase(), new URL(u).host) } catch { /* ignore */ } } })
      return rows.map<Env>((e) => ({ id: e.name, name: e.properties?.displayName ?? e.name, isDefault: !!e.properties?.isDefault, region: e.location, orgUrl: e.properties?.linkedEnvironmentMetadata?.instanceUrl ?? e.properties?.linkedEnvironmentMetadata?.instanceApiUrl }))
    }
    // No environment connector: fall back to the environment this app runs in.
    const ctx = await getContext()
    console.warn('Power Platform for Admins connector missing - scanning current environment only')
    return [{ id: ctx.app.environmentId, name: 'Current environment (add "Power Platform for Admins" to scan all)' }]
  },

  async resolveUser(q) {
    if (/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(q)) return { id: q, name: q, email: q }
    const u = await call(need('user'), [q])
    if (!u?.id) throw new Error(`No user found for ${q}`)
    return { id: u.id, name: u.displayName ?? q, email: u.mail ?? u.userPrincipalName ?? q }
  },

  async listAssets(user, envs, onProgress) {
    const appsOp = OPS.apps()
    const flowOps = flowLists()
    const ownersOp = OPS.flowOwners()
    const dvList = OPS.dvList()
    const notes: ScanNote[] = []
    const note = (env: string, kind: ScanNote['kind'], level: ScanNote['level'], text: string) => notes.push({ env, kind, level, text })
    if (!appsOp) note('(all)', 'app', 'error', 'No "list apps" operation in this build - add the Power Apps for Admins connector.')
    if (!flowOps.length) note('(all)', 'flow', 'error', 'No "list flows" operation in this build - add the Power Automate Management (or Power Automate for Admins) connector. Flows cannot be discovered without it.')

    const out: Asset[] = []
    const mail = user.email.toLowerCase()
    const MAX_OWNER_LOOKUPS = 400

    // ---- Copilot Studio agents: tenant-wide inventory (all environments in one call) ----
    let agentsViaInventory = false
    const invOp = OPS.inventory()
    if (invOp) {
      try {
        onProgress(0, envs.length, 'agent inventory (tenant-wide)')
        const inScope = new Set(envs.map((e) => e.id.toLowerCase()))
        const envName = new Map(envs.map((e) => [e.id.toLowerCase(), e.name]))
        const mine = (r: any) => String(invProp(r, 'ownerId') ?? '').toLowerCase() === user.id.toLowerCase()
        let res = await inventoryAgents(invOp, user.id).catch(() => null)     // server-side owner filter first
        let owned = (res?.rows ?? []).filter(mine)
        let via = 'server-side owner filter'
        if (!owned.length) {                                                  // owner id format may differ: fetch all agents and compare here
          res = await inventoryAgents(invOp, null)
          owned = res.rows.filter(mine)
          via = `client-side match over ${res.rows.length} agent(s)`
          if (!owned.length && res.rows.length) {
            const sample = [...new Set(res.rows.map((r) => String(invProp(r, 'ownerId') ?? '')))].slice(0, 3).join(', ')
            note('(all)', 'agent', 'info', `inventory has ${res.rows.length} agent(s) but none with ownerId = ${user.id}. Sample ownerIds seen: ${sample || '(none)'}`)
          }
        }
        let inScopeCount = 0
        const cat: Record<string, number> = {}
        const seen: Record<string, Set<string>> = {}
        for (const r of owned) {
          const eid = String(invProp(r, 'environmentId') ?? '')
          if (!inScope.has(eid.toLowerCase())) continue
          inScopeCount++
          const id = String(r.name ?? invProp(r, 'agentId') ?? '')
          const { category, meta } = classifyAgent(r)
          cat[category] = (cat[category] ?? 0) + 1
          for (const [k, v] of Object.entries(meta)) { (seen[k] ??= new Set()).add(v); if ((seen[k]?.size ?? 0) > 6) seen[k]!.delete(v) }
          out.push({
            key: `agent:${eid}:${id}`, id, kind: 'agent', name: invProp(r, 'displayName') ?? id, envId: eid, envName: envName.get(eid.toLowerCase()) ?? eid,
            ownerId: user.id, ownerName: user.name, ownerEmail: user.email, state: 'Started',
            createdTime: invProp(r, 'createdAt'), modifiedTime: invProp(r, 'modifiedAt') ?? invProp(r, 'lastModifiedAt'), orgHost: 'inventory',
            category, meta,
          })
        }
        const catText = Object.entries(cat).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'
        note('(all)', 'agent', 'info', `Inventory classification of the user's items: ${catText}. Only "agent" (real Copilot Studio agents) is shown by default; the rest are hidden behind a toggle.`)
        const evidence = Object.entries(seen).map(([k, v]) => `${k}={${[...v].join(' | ')}}`).join('; ')
        if (evidence) note('(all)', 'agent', 'info', `Inventory properties seen (for tuning the filter): ${evidence.slice(0, 700)}`)
        agentsViaInventory = true
        note('(all)', 'agent', 'info', `Copilot Studio inventory: ${owned.length} agent(s) owned by user in the tenant, ${inScopeCount} in the scanned environment(s) (${via}${res?.truncated ? '; list truncated' : ''})`)
      } catch (e) { note('(all)', 'agent', 'warn', `agent inventory failed: ${(e as Error).message.slice(0, 300)} - falling back to per-environment Dataverse`) }
    } else note('(all)', 'agent', 'warn', 'No inventory operation in this build - add the "Power Platform for Admins V2" connector to discover Copilot Studio agents in all environments.')

    let done = 0

    for (const env of envs) {
      onProgress(done, envs.length, env.name)

      // ---- apps ----
      if (appsOp) {
        try {
          onProgress(done, envs.length, `${env.name} · apps`)
          const { items: list, truncated } = await callAll(appsOp, [env.id])
          if (truncated) note(env.name, 'app', 'warn', `app list was cut off at ${list.length} items (paging limit) - some apps may be missing`)
          let mine = 0
          for (const x of list) {
            const o = x.properties?.owner
            if (!o || (o.id !== user.id && String(o.email ?? o.userPrincipalName ?? '').toLowerCase() !== mail)) continue
            mine++
            out.push({
              key: `app:${env.id}:${x.name}`, id: x.name, kind: 'app', name: x.properties?.displayName ?? x.name, envId: env.id, envName: env.name,
              ownerId: o.id ?? user.id, ownerName: o.displayName ?? user.name, ownerEmail: o.email ?? user.email, state: 'Published',
              createdTime: x.properties?.createdTime, modifiedTime: x.properties?.lastModifiedTime,
              inSolution: !!x.properties?.solutionId, connections: Object.keys(x.properties?.connectionReferences ?? {}).length,
            })
          }
          note(env.name, 'app', 'info', `scanned ${list.length} app(s), ${mine} owned by user`)
        } catch (e) { note(env.name, 'app', 'error', (e as Error).message.slice(0, 300)) }
      }

      // ---- flows (try each list operation until one works) ----
      let flowsDone = false
      for (const op of flowOps) {
        try {
          onProgress(done, envs.length, `${env.name} · flows`)
          const paged = await callAll(op, [env.id])
          let list = paged.items
          if (paged.truncated) note(env.name, 'flow', 'warn', `flow list was cut off at ${list.length} items (paging limit) - some flows may be missing`)
          const total = list.length
          let how = 'creator field'
          if (total && !list.some((x) => x.properties?.creator)) {
            // V2-style list: no creator, so look up each flow's owners (bounded).
            if (!ownersOp) { note(env.name, 'flow', 'warn', `${op.op} returned ${total} flow(s) without creator info and no "get flow owners" operation exists - cannot tell who owns them.`); flowsDone = true; break }
            const subset = list.slice(0, MAX_OWNER_LOOKUPS)
            if (list.length > MAX_OWNER_LOOKUPS) note(env.name, 'flow', 'warn', `${list.length} flows here; only the first ${MAX_OWNER_LOOKUPS} were checked for ownership. Scan this environment alone and ask for a deeper scan if needed.`)
            const checked = await mapLimit(subset, 4, async (x) => {
              try {
                const roles = asList(await call(ownersOp, [env.id, x.name]))
                const mine = roles.some((r) => (r.properties?.principal?.id ?? r.principal?.id) === user.id && /owner/i.test(r.properties?.roleName ?? r.roleName ?? ''))
                return mine ? { ...x, properties: { ...x.properties, creator: { userId: user.id } } } : null
              } catch { return null }
            })
            list = checked.filter(Boolean) as any[]
            how = 'owner lookups'
          }
          let mine = 0
          let movedAway = 0
          for (const x of list) {
            const c = x.properties?.creator
            if (!c || (c.userId !== user.id && c.objectId !== user.id)) continue
            // A flow's CREATOR never changes. After a transfer the user may no longer be an owner, so confirm with the owner roles.
            if (how === 'creator field' && ownersOp) {
              try {
                const roles = asList(await call(ownersOp, [env.id, x.name]))
                if (roles.length && !roles.some((r) => (r.properties?.principal?.id ?? r.principal?.id) === user.id && /owner/i.test(r.properties?.roleName ?? r.roleName ?? ''))) { movedAway++; continue }
              } catch { /* cannot tell - keep the flow listed */ }
            }
            mine++
            out.push({
              key: `flow:${env.id}:${x.name}`, id: x.name, kind: 'flow', name: x.properties?.displayName ?? x.name, envId: env.id, envName: env.name,
              ownerId: user.id, ownerName: user.name, ownerEmail: user.email, state: stateOf(x.properties?.state),
              createdTime: x.properties?.createdTime, modifiedTime: x.properties?.lastModifiedTime,
              inSolution: !!x.properties?.workflowEntityId, connections: Object.keys(x.properties?.connectionReferences ?? {}).length,
            })
          }
          note(env.name, 'flow', 'info', `${op.op}: ${total} flow(s) listed, ${mine} owned by user (via ${how})${movedAway ? `; ${movedAway} flow(s) created by the user are no longer owned by them (already transferred)` : ''}`)
          flowsDone = true
          break
        } catch (e) { note(env.name, 'flow', 'warn', `${op.op} failed: ${(e as Error).message.slice(0, 250)}`) }
      }
      if (flowOps.length && !flowsDone) note(env.name, 'flow', 'error', 'All flow list operations failed in this environment (are you an admin there?).')

      // ---- Copilot Studio agents: per-environment Dataverse fallback (only if the inventory was unavailable) ----
      await tick()
      if (agentsViaInventory) { onProgress(++done, envs.length, env.name); continue }
      onProgress(done, envs.length, `${env.name} · agents`)
      const botsTable = nativeTable(/^bots?$/i)
      const isHome = botsTable && (await getCurrentEnvId()) === env.id
      if (isHome) {
        // Environment this app runs in: use its own Dataverse directly.
        try {
          const sysId = await nativeSystemUserId(user.id)
          if (!sysId) note(env.name, 'agent', 'info', 'user has no Dataverse user record here (no agents)')
          else {
            const r: any = await sdk().retrieveMultipleRecordsAsync<any>(botsTable!, { filter: `_ownerid_value eq ${sysId}`, select: ['botid', 'name', 'statecode', 'modifiedon', 'createdon', 'ismanaged'], top: 500 })
            if (!r?.success) throw new Error(r?.error?.message ?? 'query failed')
            for (const b of r.data ?? []) out.push({
              key: `agent:${env.id}:${b.botid}`, id: b.botid, kind: 'agent', name: b.name ?? b.botid, envId: env.id, envName: env.name,
              ownerId: user.id, ownerName: user.name, ownerEmail: user.email, state: b.statecode === 0 ? 'Started' : 'Stopped',
              createdTime: b.createdon, modifiedTime: b.modifiedon, inSolution: !!b.ismanaged, orgHost: 'native',
            })
            note(env.name, 'agent', 'info', `${(r.data ?? []).length} Copilot Studio agent(s) owned by user (this app's own Dataverse)`)
          }
        } catch (e) { note(env.name, 'agent', 'warn', `agents: ${(e as Error).message.slice(0, 250)}`) }
      } else if (dvList && env.orgUrl) {
        try {
          const host = new URL(env.orgUrl).host
          const su = asList(await call(dvList, [], undefined, {}, { dataset: host, table: 'systemusers', '$filter': `azureactivedirectoryobjectid eq ${user.id}`, '$select': 'systemuserid', '$top': 1 }))
          const sysId = su[0]?.systemuserid
          if (!sysId) note(env.name, 'agent', 'info', 'user has no Dataverse user record here (no agents)')
          else {
            const bots = asList(await call(dvList, [], undefined, {}, { dataset: host, table: 'bots', '$filter': `_ownerid_value eq ${sysId}`, '$select': 'botid,name,statecode,modifiedon,createdon,ismanaged', '$top': 500 }))
            for (const b of bots) out.push({
              key: `agent:${env.id}:${b.botid}`, id: b.botid, kind: 'agent', name: b.name ?? b.botid, envId: env.id, envName: env.name,
              ownerId: user.id, ownerName: user.name, ownerEmail: user.email, state: b.statecode === 0 ? 'Started' : 'Stopped',
              createdTime: b.createdon, modifiedTime: b.modifiedon, inSolution: !!b.ismanaged, orgHost: host,
            })
            note(env.name, 'agent', 'info', `${bots.length} Copilot Studio agent(s) owned by user`)
          }
        } catch (e) { note(env.name, 'agent', 'warn', `agents: ${(e as Error).message.slice(0, 250)}`) }
      } else if (env.orgUrl) {
        const homeId = await getCurrentEnvId()
        const homeName = envs.find((e) => e.id === homeId)?.name ?? homeId ?? 'its own environment'
        note(env.name, 'agent', botsTable ? 'warn' : 'info', botsTable
          ? `agents NOT scanned here: this app can read agents only in the environment it is deployed to (${homeName}). To scan agents in "${env.name}", deploy the app into "${env.name}" too (run the deploy script again with that environment ID), then scan there.`
          : 'agents not scanned: the Dataverse tables are missing from this build (re-run the deploy script).')
      } else note(env.name, 'agent', 'info', 'no Dataverse database in this environment')

      onProgress(++done, envs.length, env.name)
    }
    // ---- Live reconcile: the tenant inventory lags both ways (deleted / transferred agents linger, new ones are missing).
    //      Dataverse of each environment is the source of truth wherever this app can reach it. ----
    if (agentsViaInventory) {
      let confirmed = 0, removed = 0, added = 0, unchecked = 0
      for (const env of envs) {
        const here = out.filter((a) => a.kind === 'agent' && a.orgHost === 'inventory' && a.envId.toLowerCase() === env.id.toLowerCase())
        const dv = await dvFor(env.id)
        if (!dv) { unchecked += here.length; here.forEach((a) => { a.meta = { ...(a.meta ?? {}), live: 'unverified' } }); continue }
        try {
          onProgress(0, envs.length, `${env.name} · live agents`)
          const su = await dv('systemusers', `azureactivedirectoryobjectid eq ${user.id}`, ['systemuserid'], 1)
          const sysId = su[0]?.systemuserid
          const bots = sysId ? await dv('bots', `_ownerid_value eq ${sysId}`, ['botid', 'name', 'statecode', 'modifiedon', 'createdon', 'ismanaged'], 500) : []
          log(`live agents in ${env.name}: Dataverse says ${bots.length} owned by user (inventory had ${here.length})`)
          const live = new Map<string, any>(bots.map((b) => [String(b.botid).toLowerCase(), b]))
          for (const a of here) {
            const b = live.get(a.id.toLowerCase())
            if (!b) { out.splice(out.indexOf(a), 1); removed++; continue }                 // deleted, or no longer owned by this user
            a.name = b.name ?? a.name
            a.state = b.statecode === 0 ? 'Started' : 'Stopped'
            a.modifiedTime = b.modifiedon ?? a.modifiedTime
            a.inSolution = !!b.ismanaged
            a.meta = { ...(a.meta ?? {}), live: 'verified' }
            live.delete(a.id.toLowerCase()); confirmed++
          }
          for (const b of live.values()) {                                                  // exists in Dataverse but the inventory has not caught up yet
            out.push({
              key: `agent:${env.id}:${b.botid}`, id: b.botid, kind: 'agent', name: b.name ?? b.botid, envId: env.id, envName: env.name,
              ownerId: user.id, ownerName: user.name, ownerEmail: user.email, state: b.statecode === 0 ? 'Started' : 'Stopped',
              createdTime: b.createdon, modifiedTime: b.modifiedon, inSolution: !!b.ismanaged, orgHost: 'inventory', category: 'agent', meta: { live: 'verified', source: 'Dataverse' },
            })
            added++
          }
        } catch (e) {
          unchecked += here.length; here.forEach((a) => { a.meta = { ...(a.meta ?? {}), live: 'unverified' } })
          note(env.name, 'agent', 'warn', `live check of agents failed: ${(e as Error).message.slice(0, 250)} - showing inventory data unverified`)
        }
      }
      note('(all)', 'agent', removed || added || unchecked ? 'warn' : 'info',
        `Live check against Dataverse: ${confirmed} agent(s) confirmed` +
        (removed ? `; ${removed} removed (deleted, or already owned by someone else - the tenant inventory lags)` : '') +
        (added ? `; ${added} added that the inventory had not listed yet` : '') +
        (unchecked ? `; ⚠ ${unchecked} could NOT be live-checked (no Dataverse access to their environment) - inventory data only, may include deleted agents` : ''))
    }

    return { assets: out, notes }
  },

  async listSolutions(assets) {
    const groups: SolutionGroup[] = []
    const byEnv = new Map<string, Asset[]>()
    for (const a of assets) (byEnv.get(a.envId) ?? byEnv.set(a.envId, []).get(a.envId)!).push(a)
    for (const [eid, list] of byEnv) {
      const dv = await dvFor(eid)
      const envName = list[0]!.envName
      if (!dv) { log(`solutions: no Dataverse route for ${envName}`); continue }
      try {
        // 1. which solutions contain the user's items (component objectid = canvasapp / workflow / bot id)
        const sols = new Map<string, Asset[]>()
        for (let i = 0; i < list.length; i += 12) {
          const chunk = list.slice(i, i + 12)
          const rows = await dv('solutioncomponents', chunk.map((a) => `objectid eq ${a.id}`).join(' or '), ['objectid', '_solutionid_value', 'componenttype'], 500)
          for (const r of rows) {
            const a = chunk.find((x) => x.id.toLowerCase() === String(r.objectid).toLowerCase())
            const sid = String(r._solutionid_value ?? '').toLowerCase()
            if (a && sid) { const arr = sols.get(sid) ?? []; if (!arr.includes(a)) arr.push(a); sols.set(sid, arr) }
          }
        }
        // 2. solution names (hide the always-present Default / Active solutions) and the total component count
        for (const [sid, members] of sols) {
          const sr = await dv('solutions', `solutionid eq ${sid}`, ['solutionid', 'friendlyname', 'uniquename', 'ismanaged', 'version'], 1)
          const s0 = sr[0]
          if (!s0 || /^(default|active|basic)$/i.test(String(s0.uniquename))) continue
          let total = members.length
          try { total = (await dv('solutioncomponents', `_solutionid_value eq ${sid}`, ['objectid'], 500)).length } catch { /* keep */ }
          groups.push({ key: `${eid}:${sid}`, envId: eid, envName, name: s0.friendlyname ?? s0.uniquename, uniqueName: s0.uniquename, version: s0.version, managed: !!s0.ismanaged, assetKeys: members.map((m) => m.key), totalComponents: total })
        }
        log(`solutions in ${envName}: ${groups.filter((g) => g.envId === eid).length} contain the user's items`)
      } catch (e) { log(`solutions lookup failed in ${envName}: ${(e as Error).message.slice(0, 200)}`); throw e }
    }
    return groups
  },

  async preflightTarget(envId, to) {
    const dv = await dvFor(envId)
    if (!dv) return undefined                                     // cannot check from here
    const rows = await dv('systemusers', `azureactivedirectoryobjectid eq ${to.id}`, ['systemuserid', 'isdisabled', 'accessmode'], 1)
    const u = rows[0]
    log(`pre-flight target user in Dataverse: ${u ? `isdisabled=${u.isdisabled} accessmode=${u.accessmode}` : 'no row'}`)
    if (!u) return undefined
    if (u.isdisabled) return `${to.email} is DISABLED in this environment - enable the user first. Nothing was changed.`
    if (u.accessmode === 3 || u.accessmode === 4) return `${to.email} has access mode "${u.accessmode === 4 ? 'Non-interactive' : 'Support user'}" in this environment and cannot own agents. Nothing was changed.`
    return null
  },

  async checkMember(envId, to) {
    const dv = await dvFor(envId)
    if (!dv) return null
    try { return (await dv('systemusers', `azureactivedirectoryobjectid eq ${to.id}`, ['systemuserid'], 1)).length > 0 } catch { return null }
  },

  async verifyOwner(asset, to) {
    const r = await liveBackend.verifyOwnerRaw!(asset, to)
    log(`READ-BACK ${asset.kind} "${asset.name}": new owner ${r === true ? 'CONFIRMED' : r === false ? 'NOT showing yet' : 'could not be read'}`)
    return r
  },

  async verifyOwnerRaw(asset, to) {
    try {
      if (asset.kind === 'app') {
        const op = OPS.appGet()
        if (!op) return null
        const x = await call(op, [asset.envId, asset.id])
        const o = x?.properties?.owner
        return o ? String(o.id ?? '').toLowerCase() === to.id.toLowerCase() : null
      }
      if (asset.kind === 'flow') {
        const op = OPS.flowOwners()
        if (!op) return null
        const roles = asList(await call(op, [asset.envId, asset.id]))
        if (!roles.length) return null
        return roles.some((r) => (r.properties?.principal?.id ?? r.principal?.id) === to.id && /owner/i.test(r.properties?.roleName ?? r.roleName ?? ''))
      }
      // agent: authoritative Dataverse read (this app's own environment or via the Dataverse connector)
      const dv = await dvFor(asset.envId)
      if (dv) {
        const su = await dv('systemusers', `azureactivedirectoryobjectid eq ${to.id}`, ['systemuserid'], 1)
        const rows = await dv('bots', `botid eq ${asset.id}`, ['botid', '_ownerid_value'], 1)
        log(`read-back Dataverse bot ${asset.id}: owner row ${rows[0]?._ownerid_value ?? 'NOT FOUND'}, expected ${su[0]?.systemuserid ?? '?'}`)
        if (rows[0] && su[0]?.systemuserid) return String(rows[0]._ownerid_value ?? '').toLowerCase() === String(su[0].systemuserid).toLowerCase()
      }
      // Fallback = tenant inventory, which LAGS: a match proves the change, a mismatch proves nothing.
      const op = OPS.inventory()
      if (!op) return null
      const body = { TableName: 'PowerPlatformResources', Clauses: [
        { $type: 'where', FieldName: 'type', Operator: '==', Values: ["'microsoft.copilotstudio/agents'"] },
        { $type: 'where', FieldName: 'name', Operator: '==', Values: [`'${asset.id}'`] },
      ], Options: { Top: 5 } }
      const rows = invRows(await callRaw(op, [], body))
      if (!rows.length) return null
      return rows.some((r) => String(invProp(r, 'ownerId') ?? '').toLowerCase() === to.id.toLowerCase()) ? true : null
    } catch { return null }
  },

  async prepareOwner(envId, to) {
    const op = OPS.syncUser()
    if (!op) return 'skipped: "Add Admin Power Apps Sync User" operation is not in this build (Power Platform for Admins connector)'
    try {
      await callRaw(op, [envId], { ObjectId: to.id })
      return 'added as an environment member (or already was)'
    } catch (e) {
      const m = (e as Error).message
      // Only an explicit 'already a member / already exists' counts as success. "user does not exist" must NOT match.
      if (/already (a )?member|already exists|user already|HTTP 409/i.test(m) && !/not exist|does not|doesn't/i.test(m)) return 'already a member'
      throw new Error(m)
    }
  },

  async transfer(asset, to, opts) {
    log(`TRANSFER ${asset.kind} "${asset.name}" [${asset.id}] in ${asset.envName}: ${asset.ownerEmail} → ${to.email} (${to.id})`)
    if (asset.kind === 'app') {
      // Power Apps have exactly one owner, so co-owner mode does not apply.
      await call(need('appOwner'), [asset.envId, asset.id], { newAppOwner: to.id })
      return
    }
    if (asset.kind === 'agent') {
      // Never send tool / MCP / Agent Builder / CLI inventory rows to the Copilot Studio reassign API.
      if (asset.category && asset.category !== 'agent') throw new Error(`Not attempted: "${asset.name}" is a ${asset.category}, not a Copilot Studio agent – nothing was changed.`)
      // Pre-flight: the inventory can list deleted agents - make sure it still exists where Dataverse is reachable.
      const dv = await dvFor(asset.envId).catch(() => null)
      if (dv) {
        const rows = await dv('bots', `botid eq ${asset.id}`, ['botid', 'name', '_ownerid_value', 'ismanaged'], 1).catch(() => null)
        log(`pre-flight Dataverse bot ${asset.id}: ${rows ? (rows[0] ? 'exists, owner row ' + rows[0]._ownerid_value + (rows[0].ismanaged ? ' - MANAGED (reassign may be blocked)' : '') : 'NOT FOUND') : 'query failed'}`)
        if (rows && !rows[0]) throw new Error('Not attempted: this agent no longer exists in Dataverse (it was deleted; the tenant inventory is stale). Nothing was changed. Re-scan.')
      }
      const re = OPS.agentReassign()
      if (re) {
        // ONE attempt, no automatic retry and NO fallback: a retry or a Dataverse "assign" after a half-finished reassign
        // can make the inconsistency worse and hide it. Needs: connection account = System Administrator in the target
        // environment; new owner = environment member with a Copilot Studio licence.
        await callRaw(re, [asset.envId, asset.id], { NewOwnerAadUserId: to.id })
        return
      }
      // Only when the reassign operation is not in this build at all: plain Dataverse assign in this app's own environment.
      const botsTable = nativeTable(/^bots?$/i)
      if (botsTable && (await getCurrentEnvId()) === asset.envId) {
        const sysId = await nativeSystemUserId(to.id)
        if (!sysId) throw new Error('Not attempted: the new owner has no user record in this environment. Nothing was changed.')
        const r: any = await sdk().updateRecordAsync<any, any>(botsTable, asset.id, { 'ownerid@odata.bind': `/systemusers(${sysId})` })
        if (!r?.success) throw new Error(r?.error?.message ?? 'Dataverse update failed')
        return
      }
      throw new Error('Not attempted: neither the Power Platform for Admins V2 reassign operation nor a usable Dataverse path is available for this agent.')
    }
    const body: Record<string, unknown> = { put: [{ properties: { principal: { id: to.id, type: 'User' }, roleName: 'Owner' } }] }
    if (opts.mode === 'replace' && opts.removeOldOwner) body.delete = [{ id: asset.ownerId }]
    await call(need('flowOwner'), [asset.envId, asset.id], body)
  },

  async diagnostics() {
    const rows: { name: string; ok: boolean; detail: string }[] = (Object.keys(OPS) as OpKey[]).map((k) => {
      const o = OPS[k]()
      const optional = !REQUIRED.includes(k)
      return { name: k + (optional ? ` (optional${NEEDS[k] ? ': ' + NEEDS[k] : ''})` : ''), ok: !!o, detail: o ? `${o.ds} → ${o.op}  [${o.method} ${o.path}]` : 'not found' }
    })
    rows.push({ name: 'native Dataverse tables (agents in this app\'s own environment)', ok: !!nativeTable(/^bots?$/i) && !!nativeTable(/^systemusers?$/i), detail: `bot table → data source "${nativeKey('bot') ?? 'missing'}", systemuser table → "${nativeKey('systemuser') ?? 'missing'}"; all data sources: ${Object.keys(dataSourcesInfo).join(', ')}` })
    rows.push({ name: 'flow list candidates', ok: flowLists().length > 0, detail: flowLists().map((o) => `${o.ds} → ${o.op} [${o.method} ${o.path}]`).join('\n') || 'none' })
    // Real test of the live Dataverse source per environment (this is what makes brand-new agents visible immediately)
    const tested: string[] = []
    const homeId = (await getCurrentEnvId())?.toLowerCase()
    const ids = [...new Set([...(homeId ? [homeId] : []), ...orgHosts.keys()])].slice(0, 8)
    for (const id of ids) {
      try {
        const dv = await dvFor(id)
        if (!dv) { tested.push(`✖ ${id}: no route (Dataverse connector missing or environment has no database)`); continue }
        const t0 = Date.now()
        const rows = await dv('bots', 'statecode eq 0', ['botid'], 1)
        tested.push(`✔ ${id}: reads agents live (${Date.now() - t0} ms, ${rows.length ? 'has agents' : 'no rows'})${id === homeId ? ' [this app\'s own environment]' : ' [via Dataverse connector]'}`)
      } catch (e) { tested.push(`✖ ${id}: ${(e as Error).message.slice(0, 220)}`) }
    }
    rows.push({ name: 'Live Dataverse test (agents appear immediately only where this is ✔)', ok: tested.length > 0 && tested.every((t) => t.startsWith('✔')), detail: tested.join('\n') || 'no environments tested' })
    const ops = allOps()
    const sources = [...new Set(ops.map((o) => o.ds))]
    rows.push({ name: 'connectors in this build', ok: sources.length > 0, detail: sources.join(', ') || 'none - run the deploy script' })
    for (const ds of sources) {
      rows.push({ name: `ops: ${ds}`, ok: true, detail: ops.filter((o) => o.ds === ds).map((o) => `${o.op}  [${o.method} ${o.path}]`).join('\n') })
    }
    return rows
  },
}
