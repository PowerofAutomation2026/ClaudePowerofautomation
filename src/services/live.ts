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
 */
import { getClient } from '@microsoft/power-apps/data'
import { getContext } from '@microsoft/power-apps/app'
import type { Asset, Backend, Env } from '../types'

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
  /** Prefer the classic list (includes creator) over V2 (ids only). */
  flows: () => { const o = allOps(); return pick(
    o.find((x) => x.method === 'GET' && /admin\/environments\/\{[^}/]+\}\/flows$/i.test(bare(x.path))),
    o.find((x) => /^(getadminflows?|listflowsasadmin)$/.test(x.norm)),
    o.find((x) => x.method === 'GET' && /admin\/environments\/\{[^}/]+\}\/v2\/flows$/i.test(bare(x.path))),
    o.find((x) => /^listflowsasadminv2|listflowsinenvironmentv2asadmin/.test(x.norm))) },
  flowOwner: () => { const o = allOps(); return pick(
    o.find((x) => /^(modifyflowownersasadmin|modifyflowownersadmin)$/.test(x.norm)),
    o.find((x) => x.method === 'POST' && /flows\/\{[^}/]+\}\/modifyPermissions/i.test(x.path)),
    o.find((x) => /^(setadminflowownerrole|editflowownerroleasadmin)$/.test(x.norm))) },
  /** Used only when the flow list has no creator info (V2). */
  flowOwners: () => { const o = allOps(); return pick(
    o.find((x) => /^(getadminflowownerrole|getflowownerroleasadmin)$/.test(x.norm)),
    o.find((x) => x.method === 'GET' && /admin\/environments\/\{[^}/]+\}\/flows\/\{[^}/]+\}\/(owners|permissions)$/i.test(bare(x.path)))) },
  user: () => { const o = allOps(); return pick(
    o.find((x) => /office365users/i.test(x.ds) && x.norm === 'userprofilev2'),
    o.find((x) => /office365users/i.test(x.ds) && x.method === 'GET' && /\/users\/\{[^}/]+\}$/i.test(bare(x.path)))) },
} as const
type OpKey = keyof typeof OPS
const REQUIRED: OpKey[] = ['apps', 'appOwner', 'user']

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

async function call(o: Op, pathValues: string[] = [], body?: unknown, query: Record<string, unknown> = {}): Promise<any> {
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
    return params
  }
  const run = async () => {
    const res: any = await getClient(dataSourcesInfo as any).executeAsync({ connectorOperation: { tableName: o.ds, operationName: o.op, parameters: build() } })
    if (!res?.success) {
      const e = res?.error
      const raw = e?.message ?? (typeof e === 'string' ? e : JSON.stringify(e ?? 'Connector call failed'))
      let pretty = raw
      try { const j = JSON.parse(raw); pretty = j?.error?.message ?? raw } catch { /* not JSON */ }
      throw new Error(`${raw.includes('InvalidApiVersion') ? 'InvalidApiVersion: ' : ''}${pretty}`)
    }
    return res.data?.value ?? res.data
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

export const liveBackend: Backend = {
  label: 'Live',

  async listEnvironments() {
    const op = OPS.envs()
    if (op) {
      const rows = asList(await call(op))
      return rows.map<Env>((e) => ({ id: e.name, name: e.properties?.displayName ?? e.name, isDefault: !!e.properties?.isDefault, region: e.location }))
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
    const apps = OPS.apps(); const flows = OPS.flows(); const owners = OPS.flowOwners()
    if (!apps && !flows) throw new Error('No admin connectors found in this build. Run the deploy script.')
    const out: Asset[] = []
    const mail = user.email.toLowerCase()
    const errs: string[] = []
    let done = 0
    for (const env of envs) {
      onProgress(done, envs.length, env.name)
      const [a, f] = await Promise.allSettled([apps ? call(apps, [env.id]) : [], flows ? call(flows, [env.id]) : []])

      if (a.status === 'fulfilled') for (const x of asList(a.value)) {
        const o = x.properties?.owner
        if (!o || (o.id !== user.id && String(o.email ?? o.userPrincipalName ?? '').toLowerCase() !== mail)) continue
        out.push({
          key: `app:${env.id}:${x.name}`, id: x.name, kind: 'app', name: x.properties?.displayName ?? x.name, envId: env.id, envName: env.name,
          ownerId: o.id ?? user.id, ownerName: o.displayName ?? user.name, ownerEmail: o.email ?? user.email, state: 'Published',
          createdTime: x.properties?.createdTime, modifiedTime: x.properties?.lastModifiedTime,
          inSolution: !!x.properties?.solutionId, connections: Object.keys(x.properties?.connectionReferences ?? {}).length,
        })
      } else errs.push(`apps/${env.name}: ${(a.reason as Error).message}`)

      if (f.status === 'fulfilled') {
        let list = asList(f.value)
        // V2 lists omit the creator: look up each flow's owners (bounded concurrency).
        if (list.length && !list.some((x) => x.properties?.creator) && owners) {
          const checked = await mapLimit(list, 8, async (x) => {
            try {
              const roles = asList(await call(owners, [env.id, x.name]))
              const mine = roles.some((r) => (r.properties?.principal?.id ?? r.principal?.id) === user.id && /owner/i.test(r.properties?.roleName ?? r.roleName ?? ''))
              return mine ? { ...x, properties: { ...x.properties, creator: { userId: user.id } } } : null
            } catch { return null }
          })
          list = checked.filter(Boolean) as any[]
        }
        for (const x of list) {
          const c = x.properties?.creator
          if (!c || (c.userId !== user.id && c.objectId !== user.id)) continue
          out.push({
            key: `flow:${env.id}:${x.name}`, id: x.name, kind: 'flow', name: x.properties?.displayName ?? x.name, envId: env.id, envName: env.name,
            ownerId: user.id, ownerName: user.name, ownerEmail: user.email, state: stateOf(x.properties?.state),
            createdTime: x.properties?.createdTime, modifiedTime: x.properties?.lastModifiedTime,
            inSolution: !!x.properties?.workflowEntityId, connections: Object.keys(x.properties?.connectionReferences ?? {}).length,
          })
        }
      } else errs.push(`flows/${env.name}: ${(f.reason as Error).message}`)
      onProgress(++done, envs.length, env.name)
    }
    if (errs.length) console.warn('Some scans failed:', errs)
    if (errs.length && !out.length && errs.length >= envs.length) throw new Error(errs[0])
    return out
  },

  async transfer(asset, to, opts) {
    if (asset.kind === 'app') {
      // Power Apps have exactly one owner, so co-owner mode does not apply.
      await call(need('appOwner'), [asset.envId, asset.id], { newAppOwner: to.id })
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
      return { name: k + (optional ? ' (optional)' : ''), ok: !!o, detail: o ? `${o.ds} → ${o.op}  [${o.method} ${o.path}]` : 'not found' }
    })
    const ops = allOps()
    const sources = [...new Set(ops.map((o) => o.ds))]
    rows.push({ name: 'connectors in this build', ok: sources.length > 0, detail: sources.join(', ') || 'none - run the deploy script' })
    for (const ds of sources) {
      rows.push({ name: `ops: ${ds}`, ok: true, detail: ops.filter((o) => o.ds === ds).map((o) => `${o.op}  [${o.method} ${o.path}]`).join('\n') })
    }
    return rows
  },
}
