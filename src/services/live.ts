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
 *   Microsoft Dataverse (legacy) (shared_commondataservice)     optional: Copilot Studio agents (bots table, any environment via `dataset`)
 */
import { getClient } from '@microsoft/power-apps/data'
import { getContext } from '@microsoft/power-apps/app'
import type { Asset, Backend, Env, ScanNote } from '../types'

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
  /** Microsoft Dataverse (legacy): list / patch rows in ANY environment by passing `dataset` (the org host). */
  dvList: () => { const o = allOps(); return pick(
    o.find((x) => /commondataservice/i.test(x.ds) && x.method === 'GET' && /datasets\/\{dataset\}\/tables\/\{table\}\/items$/i.test(bare(x.path)))) },
  dvUpdate: () => { const o = allOps(); return pick(
    o.find((x) => /commondataservice/i.test(x.ds) && x.method === 'PATCH' && /datasets\/\{dataset\}\/tables\/\{table\}\/items\/\{[^}]+\}$/i.test(bare(x.path)))) },
  user: () => { const o = allOps(); return pick(
    o.find((x) => /office365users/i.test(x.ds) && x.norm === 'userprofilev2'),
    o.find((x) => /office365users/i.test(x.ds) && x.method === 'GET' && /\/users\/\{[^}/]+\}$/i.test(bare(x.path)))) },
} as const
type OpKey = keyof typeof OPS
const REQUIRED: OpKey[] = ['apps', 'appOwner', 'user']
const NEEDS: Partial<Record<OpKey, string>> = { envs: 'environment list', flows: 'flow list', flowOwner: 'change flow owner', flowOwners: 'flow owners lookup (only if list has no creator)', dvList: 'Copilot Studio agents (read)', dvUpdate: 'Copilot Studio agents (transfer)' }

const need = (k: OpKey): Op => {
  const o = OPS[k]()
  if (!o) throw new Error(`Connector operation "${k}" not found - add the matching connector (see 🩺 Diagnostics) and re-run the deploy script.`)
  return o
}

/** The connectors mark api-version as "optional", but the Power Platform services reject calls without one. */
const API_VERSION: Record<string, string> = { powerapps: '2017-08-01', flow: '2016-11-01', platform: '2020-10-01' }
const defaultApiVersion = (ds: string) => (/powerplatform/i.test(ds) ? API_VERSION.platform : /flow/i.test(ds) ? API_VERSION.flow : API_VERSION.powerapps)
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
        else if (isApiVersionParam(p.name)) params[p.name] = versionCache[cacheKey] ?? defaultApiVersion(o.ds)   // always send, even if "optional"
      } else if (p.in === 'header' && /content-?type/i.test(p.name) && body !== undefined) params[p.name] = 'application/json'
    }
    return { ...params, ...extra }
  }
  const run = async () => {
    const res: any = await sdk().executeAsync({ connectorOperation: { tableName: o.ds, operationName: o.op, parameters: build() } })
    if (!res?.success) {
      const e = res?.error
      const raw = e?.message ?? (typeof e === 'string' ? e : JSON.stringify(e ?? 'Connector call failed'))
      let pretty = raw
      try { const j = JSON.parse(raw); pretty = j?.error?.message ?? raw } catch { /* not JSON */ }
      throw new Error(`${raw.includes('InvalidApiVersion') ? 'InvalidApiVersion: ' : ''}${pretty}`)
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


// ---- Dataverse of the environment this app runs in (no extra connection needed; added by `pac code add-data-source -a dataverse`) ----
const nativeTable = (re: RegExp): string | null =>
  Object.keys(dataSourcesInfo).find((k) => re.test(k) && /dataverse/i.test(String(dataSourcesInfo[k]?.dataSourceType ?? 'dataverse'))) ?? null
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

export const liveBackend: Backend = {
  label: 'Live',

  async listEnvironments() {
    const op = OPS.envs()
    if (op) {
      const rows = asList(await call(op))
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
    if (!dvList && !nativeTable(/^bots?$/i)) note('(all)', 'agent', 'warn', 'Copilot Studio agents cannot be scanned: this build has neither the Dataverse "bot" table nor the Dataverse (legacy) connector. Re-run the deploy script.')

    const out: Asset[] = []
    const mail = user.email.toLowerCase()
    const MAX_OWNER_LOOKUPS = 400
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
          for (const x of list) {
            const c = x.properties?.creator
            if (!c || (c.userId !== user.id && c.objectId !== user.id)) continue
            mine++
            out.push({
              key: `flow:${env.id}:${x.name}`, id: x.name, kind: 'flow', name: x.properties?.displayName ?? x.name, envId: env.id, envName: env.name,
              ownerId: user.id, ownerName: user.name, ownerEmail: user.email, state: stateOf(x.properties?.state),
              createdTime: x.properties?.createdTime, modifiedTime: x.properties?.lastModifiedTime,
              inSolution: !!x.properties?.workflowEntityId, connections: Object.keys(x.properties?.connectionReferences ?? {}).length,
            })
          }
          note(env.name, 'flow', 'info', `${op.op}: ${total} flow(s) listed, ${mine} owned by user (via ${how})`)
          flowsDone = true
          break
        } catch (e) { note(env.name, 'flow', 'warn', `${op.op} failed: ${(e as Error).message.slice(0, 250)}`) }
      }
      if (flowOps.length && !flowsDone) note(env.name, 'flow', 'error', 'All flow list operations failed in this environment (are you an admin there?).')

      // ---- Copilot Studio agents (Dataverse bots table) ----
      await tick()
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
        note(env.name, 'agent', 'info', botsTable ? 'agents here need the optional "Microsoft Dataverse (legacy)" connector (the app can only read its own environment natively)' : 'agents not scanned: add Dataverse tables to the build (deploy script does this) or the legacy Dataverse connector')
      } else note(env.name, 'agent', 'info', 'no Dataverse database in this environment')

      onProgress(++done, envs.length, env.name)
    }
    return { assets: out, notes }
  },

  async transfer(asset, to, opts) {
    if (asset.kind === 'app') {
      // Power Apps have exactly one owner, so co-owner mode does not apply.
      await call(need('appOwner'), [asset.envId, asset.id], { newAppOwner: to.id })
      return
    }
    if (asset.kind === 'agent' && asset.orgHost === 'native') {
      const botsTable = nativeTable(/^bots?$/i)
      if (!botsTable) throw new Error('Dataverse "bot" table is not in this build - re-run the deploy script.')
      const sysId = await nativeSystemUserId(to.id)
      if (!sysId) throw new Error('The new owner has no user record in this environment - add them to the environment first.')
      const r: any = await sdk().updateRecordAsync<any, any>(botsTable, asset.id, { 'ownerid@odata.bind': `/systemusers(${sysId})` })
      if (!r?.success) throw new Error(r?.error?.message ?? 'Dataverse update failed')
      return
    }
    if (asset.kind === 'agent') {
      const list = need('dvList'); const upd = need('dvUpdate')
      const host = asset.orgHost
      if (!host) throw new Error('Missing Dataverse host for this agent - rescan.')
      const su = asList(await call(list, [], undefined, {}, { dataset: host, table: 'systemusers', '$filter': `azureactivedirectoryobjectid eq ${to.id}`, '$select': 'systemuserid', '$top': 1 }))
      const sysId = su[0]?.systemuserid
      if (!sysId) throw new Error('The new owner has no user record in this environment - add them to the environment first.')
      await call(upd, [], { 'ownerid@odata.bind': `/systemusers(${sysId})` }, {}, { dataset: host, table: 'bots', id: asset.id })
      return
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
    rows.push({ name: 'native Dataverse tables (agents in this app\'s own environment)', ok: !!nativeTable(/^bots?$/i) && !!nativeTable(/^systemusers?$/i), detail: `bots: ${nativeTable(/^bots?$/i) ?? 'missing'}, systemusers: ${nativeTable(/^systemusers?$/i) ?? 'missing'}` })
    rows.push({ name: 'flow list candidates', ok: flowLists().length > 0, detail: flowLists().map((o) => `${o.ds} → ${o.op} [${o.method} ${o.path}]`).join('\n') || 'none' })
    const ops = allOps()
    const sources = [...new Set(ops.map((o) => o.ds))]
    rows.push({ name: 'connectors in this build', ok: sources.length > 0, detail: sources.join(', ') || 'none - run the deploy script' })
    for (const ds of sources) {
      rows.push({ name: `ops: ${ds}`, ok: true, detail: ops.filter((o) => o.ds === ds).map((o) => `${o.op}  [${o.method} ${o.path}]`).join('\n') })
    }
    return rows
  },
}
