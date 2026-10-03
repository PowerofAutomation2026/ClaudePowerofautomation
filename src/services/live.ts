/**
 * Live backend - NO Azure app registration.
 *
 * The app runs inside Power Apps, so every call goes through the signed-in admin's own connector
 * connections via the code-apps SDK (`getClient(...).executeAsync`). The operations are discovered
 * from the generated `dataSourcesInfo` by their stable REST path + HTTP verb (e.g. POST ...modifyAppOwner),
 * not by generated method names, so it keeps working whichever connector version `pac` generated.
 *
 *   Power Apps for Admins      -> environments, apps, change app owner
 *   Power Automate for Admins  -> flows, modify flow permissions (owner)
 *   Office 365 Users           -> email -> Entra object id
 */
import { getClient } from '@microsoft/power-apps/data'
import type { Asset, Backend, Env } from '../types'

/* eslint-disable @typescript-eslint/no-explicit-any */
const infoModules = import.meta.glob('../../.power/schemas/appschemas/dataSourcesInfo.ts', { eager: true }) as Record<string, any>
const dataSourcesInfo: Record<string, any> = Object.values(infoModules)[0]?.dataSourcesInfo ?? {}

interface Op { ds: string; op: string; def: { path: string; method: string; parameters: { name: string; in: string; required: boolean }[] } }

function find(dsRe: RegExp, method: string, pathRe: RegExp, notRe?: RegExp): Op | null {
  for (const [ds, info] of Object.entries(dataSourcesInfo)) {
    if (!dsRe.test(`${ds} ${info?.tableId ?? ''}`)) continue
    for (const [op, def] of Object.entries<any>(info.apis ?? {})) {
      if (String(def.method).toUpperCase() === method && pathRe.test(def.path) && !(notRe && notRe.test(def.path))) return { ds, op, def }
    }
  }
  return null
}

const PA = /powerappsforadmin/i
const FL = /flow|automate/i
const DEFAULT_API_VERSION: Record<string, string> = { pa: '2017-08-01', fl: '2016-11-01' }

/** Discoverable operations, by REST path. */
const OPS = {
  envs: () => find(PA, 'GET', /scopes\/admin\/environments\/?(\?|$)/),
  apps: () => find(PA, 'GET', /scopes\/admin\/environments\/\{[^}/]+\}\/apps\/?(\?|$)/),
  appOwner: () => find(PA, 'POST', /modifyAppOwner/i),
  flows: () => find(FL, 'GET', /scopes\/admin\/environments\/\{[^}/]+\}\/(v2\/)?flows\/?(\?|$)/),
  flowOwner: () => find(FL, 'POST', /\/flows\/\{[^}/]+\}\/modifyPermissions/i),
  user: () => find(/office365users/i, 'GET', /\/users\/\{[^}/]+\}\/?(\?|$)/, /photo|manager|directReports|trending|relevant/i),
} as const
type OpKey = keyof typeof OPS

const need = (k: OpKey): Op => {
  const o = OPS[k]()
  if (!o) throw new Error(`Connector operation "${k}" not found. Run the deploy script (it adds the connectors) and check 🩺 Diagnostics.`)
  return o
}

/** Build the parameter object by name: path params in path order, one body, required query defaults. */
async function call(o: Op, pathValues: string[] = [], body?: unknown, query: Record<string, unknown> = {}): Promise<any> {
  const pathNames = [...o.def.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])
  const params: Record<string, unknown> = {}
  pathNames.forEach((n, i) => { if (pathValues[i] !== undefined) params[n] = pathValues[i] })
  for (const p of o.def.parameters) {
    if (p.in === 'body') params[p.name] = body
    else if (p.in === 'query') {
      if (p.name in query) params[p.name] = query[p.name]
      else if (p.required && /api-version/i.test(p.name)) params[p.name] = DEFAULT_API_VERSION[PA.test(o.ds) ? 'pa' : 'fl']
    }
  }
  const res: any = await getClient(dataSourcesInfo as any).executeAsync({ connectorOperation: { tableName: o.ds, operationName: o.op, parameters: params } })
  if (!res?.success) throw new Error(res?.error?.message ?? String(res?.error ?? 'Connector call failed'))
  return res.data?.value ?? res.data
}

const stateOf = (s?: string): Asset['state'] => (s === 'Started' || s === 'Stopped' || s === 'Suspended' ? s : 'Unknown')

export const liveBackend: Backend = {
  label: 'Live',

  async listEnvironments() {
    const rows: any[] = await call(need('envs'))
    return rows.map<Env>((e) => ({ id: e.name, name: e.properties?.displayName ?? e.name, isDefault: !!e.properties?.isDefault, region: e.location }))
  },

  async resolveUser(q) {
    if (/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(q)) return { id: q, name: q, email: q }
    const u = await call(need('user'), [q])
    if (!u?.id) throw new Error(`No user found for ${q}`)
    return { id: u.id, name: u.displayName ?? q, email: u.mail ?? u.userPrincipalName ?? q }
  },

  async listAssets(user, envs, onProgress) {
    const apps = OPS.apps(); const flows = OPS.flows()
    if (!apps && !flows) throw new Error('No admin connectors found in this build. Run the deploy script.')
    const out: Asset[] = []
    const mail = user.email.toLowerCase()
    let done = 0
    for (const env of envs) {
      onProgress(done, envs.length, env.name)
      const [a, f] = await Promise.allSettled([apps ? call(apps, [env.id]) : [], flows ? call(flows, [env.id]) : []])
      if (a.status === 'fulfilled') for (const x of a.value as any[]) {
        const o = x.properties?.owner
        if (!o || (o.id !== user.id && String(o.email ?? o.userPrincipalName ?? '').toLowerCase() !== mail)) continue
        out.push({
          key: `app:${env.id}:${x.name}`, id: x.name, kind: 'app', name: x.properties?.displayName ?? x.name, envId: env.id, envName: env.name,
          ownerId: o.id ?? user.id, ownerName: o.displayName ?? user.name, ownerEmail: o.email ?? user.email, state: 'Published',
          createdTime: x.properties?.createdTime, modifiedTime: x.properties?.lastModifiedTime,
          inSolution: !!x.properties?.solutionId, connections: Object.keys(x.properties?.connectionReferences ?? {}).length,
        })
      } else console.warn('apps', env.name, a.reason)
      if (f.status === 'fulfilled') for (const x of f.value as any[]) {
        const c = x.properties?.creator
        if (!c || (c.userId !== user.id && c.objectId !== user.id)) continue
        out.push({
          key: `flow:${env.id}:${x.name}`, id: x.name, kind: 'flow', name: x.properties?.displayName ?? x.name, envId: env.id, envName: env.name,
          ownerId: user.id, ownerName: user.name, ownerEmail: user.email, state: stateOf(x.properties?.state),
          createdTime: x.properties?.createdTime, modifiedTime: x.properties?.lastModifiedTime,
          inSolution: !!x.properties?.workflowEntityId, connections: Object.keys(x.properties?.connectionReferences ?? {}).length,
        })
      } else console.warn('flows', env.name, f.reason)
      onProgress(++done, envs.length, env.name)
    }
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
      return { name: k, ok: !!o, detail: o ? `${o.ds} → ${o.op}  [${o.def.method} ${o.def.path}]` : 'not found - connector missing or path differs' }
    })
    const sources = Object.keys(dataSourcesInfo)
    rows.push({ name: 'data sources', ok: sources.length > 0, detail: sources.join(', ') || 'none (build has no connectors)' })
    return rows
  },
}
