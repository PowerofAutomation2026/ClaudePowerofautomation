/**
 * Exposure Auditor - live backend. NO Azure app registration: every call goes through the signed-in admin's own
 * connector connections (same plumbing as the Ownership Command Center). Operations are bound by REST path + verb, never by
 * generated method name, and listed in Diagnostics. Paths marked (unverified) could not be tested against a live tenant.
 */
import { log } from '../oplog'
import { internals as I, type Op } from '../services/live'
import type { Env } from '../types'
import { classifyPrincipal } from './rules'
import type { ExposureBackend, Principal, Resource, ScanOutput, Share } from './types'

/* eslint-disable @typescript-eslint/no-explicit-any */
const ops = () => I.allOps()
const adminPath = (re: RegExp, method: string) => ops().find((x) => x.method === method && /admin\//i.test(x.path) && re.test(I.bare(x.path))) ?? null
const byName = (re: RegExp, method?: string) => ops().find((x) => re.test(x.op.toLowerCase().replace(/[^a-z0-9]/g, '')) && (!method || x.method === method)) ?? null

const EX = {
  appPerms: () => byName(/^getadminapproleassignments?$|^getapproleassignmentsasadmin$/) ?? adminPath(/environments\/\{[^}/]+\}\/apps\/\{[^}/]+\}\/(permissions|roleassignments)$/i, 'GET'),
  appDelete: () => byName(/^(removeadminapproleassignment|deleteapproleassignmentasadmin)$/) ?? adminPath(/apps\/\{[^}/]+\}\/(permissions|roleassignments)\/\{[^}/]+\}$/i, 'DELETE'),
  appModify: () => adminPath(/apps\/\{[^}/]+\}\/modifyPermissions$/i, 'POST'),
  connList: () => byName(/^(getconnectionsasadmin|getadminconnections?)$/) ?? adminPath(/environments\/\{[^}/]+\}\/connections$/i, 'GET'),
  flowGet: () => byName(/^(getflowasadmin|getadminflow)$/) ?? adminPath(/environments\/\{[^}/]+\}\/flows\/\{[^}/]+\}$/i, 'GET'),
  connPerms: () => byName(/^(getconnectionroleassignmentsasadmin|getadminconnectionroleassignments?)$/) ?? adminPath(/connections\/\{[^}/]+\}\/permissions$/i, 'GET') ?? adminPath(/connections\/\{[^}/]+\}\/roleassignments$/i, 'GET'),
}
type ExKey = keyof typeof EX

const MAX_PERM_LOOKUPS = 400 // per environment and kind, same cap as the owner app
const PARALLEL = 4
const MAX_REF_LOOKUPS = 300 // per environment: one extra read per flow/app that did not list its connection references

/** Connection ids a flow/app runs with the OWNER's credentials. Flow refs with source "Invoker" use the run-only user's own connection: not the owner's, so no edge. */
function connIds(refs: any, isApp: boolean): string[] | undefined {
  if (!refs || typeof refs !== 'object') return undefined
  const out: string[] = []
  for (const v of Object.values<any>(refs)) {
    if (!v || (!isApp && /^invoker$/i.test(String(v.source ?? '')))) continue
    const id = v.connectionName ?? String(v.sharedConnectionId ?? v.connection?.id ?? '').split('/').pop()
    if (id) out.push(String(id))
  }
  return out
}

const shares = (rows: any[], skipRoles = /^owner$/i): Share[] =>
  rows.flatMap((r) => {
    const p = r?.properties ?? r
    const role = String(p?.roleName ?? p?.role ?? '')
    if (!role || skipRoles.test(role)) return []
    const principal = classifyPrincipal({ ...(p?.principal ?? {}), id: p?.principal?.id ?? r?.name }, p?.principal?.tenantId)
    return [{ rowId: String(r?.name ?? r?.id ?? principal.id), role, principal }]
  })

async function checkEnabled(ids: string[]): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>()
  const op = I.userOp()
  if (!op) return out
  const uniq = [...new Set(ids.filter(Boolean))].slice(0, 100)
  await I.mapLimit(uniq, PARALLEL, async (id) => {
    try {
      const u = await I.callRaw(op, [id], undefined, {}, { $select: 'id,accountEnabled,userPrincipalName' }).catch(() => I.callRaw(op, [id]))
      out.set(id, u?.accountEnabled === undefined ? null : !!u.accountEnabled)
    } catch (e) {
      out.set(id, /404|not found|does not exist/i.test((e as Error).message) ? false : null) // an error is "unknown", never "safe" or "dead"
    }
  })
  return out
}

export const liveExposure: ExposureBackend = {
  label: 'Live',

  async scan(envs: Env[], onProgress): Promise<ScanOutput> {
    const notes: ScanOutput['notes'] = []
    const note = (env: string, level: 'info' | 'warn' | 'error', text: string) => notes.push({ env, level, text })
    const resources: Resource[] = []
    const appsOp = I.appsOp(); const flowOp = I.flowLists()[0] ?? null; const flowPerms = I.flowOwnersOp()
    const appPerms = EX.appPerms(); const connList = EX.connList(); const connPerms = EX.connPerms()
    if (!appsOp) note('(all)', 'error', 'No "list apps" operation - add the Power Apps for Admins connector.')
    else if (!appPerms) note('(all)', 'warn', 'No "app role assignments" operation - app sharing cannot be read (apps are listed with counts only).')
    if (!flowOp) note('(all)', 'error', 'No "list flows" operation - add Power Automate Management.')
    else if (!flowPerms) note('(all)', 'warn', 'No flow owner/permission operation - co-owners cannot be read.')
    if (!connList) note('(all)', 'warn', 'No "connections as admin" operation - connection exposure is skipped. Check 🩺 Diagnostics for the real operation names.')
    else if (!connPerms) note('(all)', 'warn', 'No "connection role assignments" operation - connections are listed but their shares are not.')

    let done = 0
    for (const env of envs) {
      onProgress(done++, envs.length, env.name)
      const stats = { apps: 0, appPerms: 0, flows: 0, flowPerms: 0, conns: 0, connPerms: 0, failed: 0 }
      // ---- apps ----
      if (appsOp) try {
        const { items, truncated } = await I.callAll(appsOp, [env.id])
        if (truncated) note(env.name, 'warn', 'App list was cut off (paging limit).')
        const apps: Resource[] = items.map((a) => {
          const p = a.properties ?? {}
          const sharedCount = (Number(p.sharedUsersCount ?? 0) || 0) + (Number(p.sharedGroupsCount ?? 0) || 0)
          return { key: `app:${env.id}:${a.name}`, kind: 'app', id: a.name, name: p.displayName ?? a.name, envId: env.id, envName: env.name,
            owner: p.owner ? { id: p.owner.id, type: 'User', name: p.owner.displayName, email: p.owner.email ?? p.owner.userPrincipalName } : undefined,
            state: 'Published', modified: p.lastModifiedTime, shares: [], uses: connIds(p.connectionReferences, true), sharedCount: p.sharedUsersCount === undefined && p.sharedGroupsCount === undefined ? undefined : sharedCount }
        })
        stats.apps = apps.length
        if (appPerms) {
          // Only apps that the list says are shared (or whose counts are missing) need the per-app permissions call.
          const todo = apps.filter((a) => a.sharedCount === undefined || a.sharedCount > 0).slice(0, MAX_PERM_LOOKUPS)
          if (apps.filter((a) => a.sharedCount === undefined || a.sharedCount > 0).length > todo.length) note(env.name, 'warn', `Only the first ${MAX_PERM_LOOKUPS} shared apps were inspected.`)
          await I.mapLimit(todo, PARALLEL, async (a) => {
            try { a.shares = shares(I.asList(await I.call(appPerms, [env.id, a.id]))); stats.appPerms++ }
            catch (e) { stats.failed++; log(`app permissions ${a.id}: ${(e as Error).message.slice(0, 160)}`) }
          })
        }
        const appGet = I.appGetOp()
        if (appGet) {
          const need = apps.filter((a) => a.uses === undefined).slice(0, MAX_REF_LOOKUPS)
          await I.mapLimit(need, PARALLEL, async (a) => {
            try { const full = await I.call(appGet, [env.id, a.id]); a.uses = connIds(full?.properties?.connectionReferences, true) ?? [] } catch (e) { log(`app connections ${a.id}: ${(e as Error).message.slice(0, 120)}`) }
          })
        }
        resources.push(...apps)
      } catch (e) { note(env.name, 'error', `Apps: ${(e as Error).message}`) }
      // ---- flows ----
      if (flowOp) try {
        const { items, truncated } = await I.callAll(flowOp, [env.id])
        if (truncated) note(env.name, 'warn', 'Flow list was cut off (paging limit).')
        const flows: Resource[] = items.map((f) => {
          const p = f.properties ?? {}
          const cid = p.creator?.userId ?? p.creator?.objectId
          return { key: `flow:${env.id}:${f.name}`, kind: 'flow', id: f.name, name: p.displayName ?? f.name, envId: env.id, envName: env.name,
            owner: cid ? { id: cid, type: 'User', name: cid } : undefined, state: p.state, modified: p.lastModifiedTime, shares: [], uses: connIds(p.connectionReferences, false) }
        })
        stats.flows = flows.length
        if (flowPerms) {
          const todo = flows.slice(0, MAX_PERM_LOOKUPS)
          if (flows.length > todo.length) note(env.name, 'warn', `Only the first ${MAX_PERM_LOOKUPS} of ${flows.length} flows had their co-owners read.`)
          await I.mapLimit(todo, PARALLEL, async (f) => {
            try {
              // The creator is always an Owner row - drop it, keep every other principal.
              f.shares = shares(I.asList(await I.call(flowPerms, [env.id, f.id])), /^$/).filter((s) => !(/^owner$/i.test(s.role) && s.principal.id === f.owner?.id))
              stats.flowPerms++
            } catch (e) { stats.failed++; log(`flow permissions ${f.id}: ${(e as Error).message.slice(0, 160)}`) }
          })
        }
        const flowGet = EX.flowGet()
        if (flowGet) {
          const need = flows.filter((f) => f.uses === undefined).slice(0, MAX_REF_LOOKUPS)
          if (flows.filter((f) => f.uses === undefined).length > need.length) note(env.name, 'warn', `Connection use was read for only ${MAX_REF_LOOKUPS} flows; the blast-radius map may under-report here.`)
          await I.mapLimit(need, PARALLEL, async (f) => {
            try { const full = await I.call(flowGet, [env.id, f.id]); f.uses = connIds(full?.properties?.connectionReferences, false) ?? [] } catch (e) { log(`flow connections ${f.id}: ${(e as Error).message.slice(0, 120)}`) }
          })
        } else if (flows.some((f) => f.uses === undefined)) note(env.name, 'warn', 'No "get flow as admin" operation - flow → connection edges unavailable (blast-radius map is incomplete).')
        resources.push(...flows)
      } catch (e) { note(env.name, 'error', `Flows: ${(e as Error).message}`) }
      // ---- connections ----
      if (connList) try {
        const { items } = await I.callAll(connList, [env.id])
        const conns: Resource[] = items.map((c) => {
          const p = c.properties ?? {}
          const connector = String(p.apiId ?? '').split('/').pop() ?? ''
          const cb = p.createdBy
          return { key: `connection:${env.id}:${c.name}`, kind: 'connection', id: c.name, name: p.displayName ?? `${connector} (${c.name.slice(0, 8)})`, envId: env.id, envName: env.name, connector,
            owner: cb ? { id: cb.id, type: 'User', name: cb.displayName ?? cb.email, email: cb.email ?? cb.userPrincipalName } : undefined,
            status: p.statuses?.[0]?.status, modified: p.lastModifiedTime, shares: [] }
        })
        stats.conns = conns.length
        if (connPerms) {
          await I.mapLimit(conns.slice(0, MAX_PERM_LOOKUPS), PARALLEL, async (c) => {
            try { c.shares = shares(I.asList(await I.call(connPerms, [env.id, c.connector ?? '', c.id])), /^$/).filter((s) => s.principal.id !== c.owner?.id); stats.connPerms++ }
            catch (e) { stats.failed++; log(`connection permissions ${c.id}: ${(e as Error).message.slice(0, 160)}`) }
          })
        }
        const dead = await checkEnabled(conns.map((c) => c.owner?.id ?? ''))
        conns.forEach((c) => { if (c.owner) c.owner.enabled = dead.get(c.owner.id) ?? null })
        resources.push(...conns)
      } catch (e) { note(env.name, 'warn', `Connections: ${(e as Error).message}`) }
      note(env.name, stats.failed ? 'warn' : 'info', `apps ${stats.apps} (${stats.appPerms} permission reads) · flows ${stats.flows} (${stats.flowPerms} reads) · connections ${stats.conns} (${stats.connPerms} reads)${stats.failed ? ` · ${stats.failed} permission read(s) FAILED - those resources may be exposed but are not shown` : ''}`)
    }
    onProgress(envs.length, envs.length, 'done')
    return { resources, notes }
  },

  async removeShare(r: Resource, s: Share) {
    if (r.kind === 'connection') throw new Error('Connection shares are report-only in this version - remove them in the Power Platform admin center or with the generated PowerShell.')
    if (r.kind === 'flow') {
      const op = I.flowOwnerOp()
      if (!op) throw new Error('No flow permission-modify operation in this build.')
      await I.call(op, [r.envId, r.id], { delete: [{ id: s.rowId }] })
      return
    }
    const del = EX.appDelete()
    if (del) { await I.call(del, [r.envId, r.id, s.rowId]); return }
    const mod = EX.appModify()
    if (!mod) throw new Error('No app permission-modify operation in this build (needs Power Apps for Admins).')
    await I.call(mod, [r.envId, r.id], { delete: [{ id: s.rowId }] })
  },

  async verifyGone(r: Resource, s: Share) {
    const op = r.kind === 'app' ? EX.appPerms() : r.kind === 'flow' ? I.flowOwnersOp() : null
    if (!op) return null
    try {
      const now = shares(I.asList(await I.call(op, [r.envId, r.id])), /^$/)
      return !now.some((x) => x.rowId === s.rowId || (x.principal.id === s.principal.id && x.role === s.role))
    } catch { return null }
  },

  async diagnostics() {
    const need: Record<ExKey, string> = { flowGet: 'read a flow incl. its connection references (blast-radius map)', appPerms: 'read who an app is shared with', appDelete: 'remove an app share (preferred)', appModify: 'remove an app share (fallback modifyPermissions)', connList: 'list connections as admin', connPerms: 'read who a connection is shared with' }
    const rows = (Object.keys(EX) as ExKey[]).map((k) => { const o: Op | null = EX[k](); return { name: `${k} (${need[k]})`, ok: !!o, detail: o ? `${o.ds} → ${o.op}  [${o.method} ${o.path}]` : 'not found - open the Ownership diagnostics to see the real operation names, then adjust the pattern in src/exposure/live.ts' } })
    const extra: [string, Op | null][] = [['apps list', I.appsOp()], ['flow list', I.flowLists()[0] ?? null], ['flow permissions', I.flowOwnersOp()], ['flow modify permissions', I.flowOwnerOp()], ['user profile (disabled-account check)', I.userOp()]]
    extra.forEach(([n, o]) => rows.push({ name: n, ok: !!o, detail: o ? `${o.ds} → ${o.op}  [${o.method} ${o.path}]` : 'not found' }))
    return rows
  },
}
export type { Principal }
