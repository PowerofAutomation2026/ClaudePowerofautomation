/**
 * Live backend. Uses ONLY the connectors the signed-in admin already has - no Azure app registration:
 *   - Power Apps for Admins       (apps + environments + change app owner)
 *   - Power Automate for Admins   (flows + owner roles)
 *   - Office 365 Users            (email -> Entra object id)
 *
 * `pac code add-data-source` generates a typed service per connector into src/generated/services.
 * Because generated method names/argument order depend on the connector version, each operation is
 * bound by name pattern in OPS below. The Diagnostics panel shows what bound; tweak OPS if needed.
 */
import type { Asset, Backend, Env, Person, TransferOptions } from '../types'

type AnyFn = (...a: any[]) => Promise<any>
type Svc = Record<string, AnyFn>

const modules = import.meta.glob('../generated/services/*.ts') as Record<string, () => Promise<Record<string, unknown>>>

async function loadService(fileRegex: RegExp): Promise<{ file: string; svc: Svc } | null> {
  for (const [path, loader] of Object.entries(modules)) {
    if (!fileRegex.test(path)) continue
    const mod = await loader()
    const svcKey = Object.keys(mod).find((k) => /Service$/.test(k)) ?? Object.keys(mod)[0]
    return { file: path.split('/').pop()!, svc: mod[svcKey] as Svc }
  }
  return null
}

function findMethod(svc: Svc, re: RegExp): { name: string; fn: AnyFn } | null {
  const proto = Object.getPrototypeOf(svc)
  const names = new Set([...Object.keys(svc), ...Object.getOwnPropertyNames(proto ?? {})])
  for (const n of names) if (re.test(n) && typeof svc[n] === 'function' && n !== 'constructor') return { name: n, fn: svc[n].bind(svc) }
  return null
}

/** Method-name patterns per operation. Adjust here if your generated names differ. */
export const OPS = {
  apps: { file: /powerappsforadmins/i, method: /^(get)?_?apps?_?(as)?_?admin|adminapps|getappsasadmin/i },
  envs: { file: /powerappsforadmins/i, method: /^(get)?_?environments?_?(as)?_?admin|adminenvironments?/i },
  appOwner: { file: /powerappsforadmins/i, method: /(modify|change|put|set)_?app_?owner|appowner/i },
  flows: { file: /(powerautomateforadmins|flowforadmins|flowmanagement)/i, method: /(get)?_?(list)?_?flows?_?(as)?_?admin|adminflows?|listflowsasadmin/i },
  flowOwner: { file: /(powerautomateforadmins|flowforadmins|flowmanagement)/i, method: /(modify|put|set|add|change)_?(flow)?_?(owner|permissions|role)/i },
  users: { file: /office365users/i, method: /^user_?(profile|get)(_v2)?$|userprofile|userget/i },
}

async function bind(key: keyof typeof OPS) {
  const o = OPS[key]
  const s = await loadService(o.file)
  if (!s) return { err: `Connector not added (no file matching ${o.file})` as string }
  const m = findMethod(s.svc, o.method)
  if (!m) return { err: `${s.file}: no method matching ${o.method}. Available: ${Object.keys(s.svc).join(', ')}` as string }
  return { fn: m.fn, label: `${s.file} → ${m.name}` }
}

function unwrap(res: any): any {
  if (res && res.success === false) throw new Error(res.error?.message ?? res.error ?? 'Connector call failed')
  const d = res && 'data' in res ? res.data : res
  return d?.value ?? d
}

const stateOf = (s?: string): Asset['state'] =>
  s === 'Started' || s === 'Stopped' || s === 'Suspended' || s === 'Published' ? s : 'Unknown'

export const liveBackend: Backend = {
  label: 'Live',

  async listEnvironments() {
    const b = await bind('envs')
    if (!b.fn) throw new Error(b.err)
    const rows = unwrap(await b.fn())
    return (rows as any[]).map<Env>((e) => ({
      id: e.name ?? e.id,
      name: e.properties?.displayName ?? e.name,
      isDefault: !!e.properties?.isDefault,
      region: e.location,
    }))
  },

  async resolveUser(q) {
    if (/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(q)) return { id: q, name: q, email: q }
    const b = await bind('users')
    if (!b.fn) throw new Error(b.err + ' - or paste the user Entra object id instead of an email.')
    const u = unwrap(await b.fn(q))
    if (!u?.id) throw new Error(`No user found for ${q}`)
    return { id: u.id, name: u.displayName ?? q, email: u.mail ?? u.userPrincipalName ?? q }
  },

  async listAssets(user, envs, onProgress) {
    const [ba, bf] = await Promise.all([bind('apps'), bind('flows')])
    const out: Asset[] = []
    let done = 0
    for (const env of envs) {
      onProgress(done, envs.length, env.name)
      if (ba.fn) {
        try {
          const apps = unwrap(await ba.fn(env.id)) as any[]
          for (const a of apps ?? []) {
            const o = a.properties?.owner
            if (o?.id !== user.id && o?.email?.toLowerCase() !== user.email.toLowerCase()) continue
            out.push({
              key: `app:${env.id}:${a.name}`, id: a.name, kind: 'app', name: a.properties?.displayName ?? a.name,
              envId: env.id, envName: env.name, ownerId: o.id, ownerName: o.displayName ?? user.name, ownerEmail: o.email ?? user.email,
              state: 'Published', createdTime: a.properties?.createdTime, modifiedTime: a.properties?.lastModifiedTime,
              inSolution: !!a.properties?.solutionId, connections: Object.keys(a.properties?.connectionReferences ?? {}).length,
            })
          }
        } catch (e) { console.warn('apps', env.name, e) }
      }
      if (bf.fn) {
        try {
          const flows = unwrap(await bf.fn(env.id)) as any[]
          for (const f of flows ?? []) {
            const c = f.properties?.creator
            if (c?.userId !== user.id && c?.objectId !== user.id) continue
            out.push({
              key: `flow:${env.id}:${f.name}`, id: f.name, kind: 'flow', name: f.properties?.displayName ?? f.name,
              envId: env.id, envName: env.name, ownerId: user.id, ownerName: user.name, ownerEmail: user.email,
              state: stateOf(f.properties?.state), createdTime: f.properties?.createdTime, modifiedTime: f.properties?.lastModifiedTime,
              inSolution: !!f.properties?.workflowEntityId, connections: Object.keys(f.properties?.connectionReferences ?? {}).length,
            })
          }
        } catch (e) { console.warn('flows', env.name, e) }
      }
      onProgress(++done, envs.length, env.name)
    }
    return out
  },

  async transfer(asset, to, opts: TransferOptions) {
    if (asset.kind === 'app') {
      const b = await bind('appOwner')
      if (!b.fn) throw new Error(b.err)
      // Power Apps only has a single owner: "co-owner" mode is not applicable, so it always replaces.
      unwrap(await b.fn(asset.envId, asset.id, { newAppOwner: to.id }))
      return
    }
    const b = await bind('flowOwner')
    if (!b.fn) throw new Error(b.err)
    const put = [{ properties: { principal: { id: to.id, type: 'User' }, roleName: 'Owner' } }]
    const del = opts.mode === 'replace' && opts.removeOldOwner ? [{ id: asset.ownerId }] : undefined
    unwrap(await b.fn(asset.envId, asset.id, { put, ...(del ? { delete: del } : {}) }))
  },

  async diagnostics() {
    const keys = Object.keys(OPS) as (keyof typeof OPS)[]
    const rows = await Promise.all(keys.map(async (k) => {
      const b = await bind(k)
      return { name: k, ok: !!b.fn, detail: b.fn ? (b as any).label : (b as any).err }
    }))
    return rows
  },
}
