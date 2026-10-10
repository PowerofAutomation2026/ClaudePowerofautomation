/**
 * "Publish to Copilot agent": the app computes everything in the browser, so to make the data available to a Copilot Studio agent we persist
 * each scan's normalised findings into ONE Dataverse table (occ_finding). The agent reads it with the Dataverse MCP server / Dataverse knowledge
 * using the ASKING USER's identity and Dataverse security roles. No app registration, no backend. The core below is pure and unit-tested.
 */
export type Module = 'exposure' | 'blast' | 'egress' | 'agents' | 'ownership'
export interface FindingRow {
  module: Module; rule: string; severity: 'High' | 'Medium' | 'Low' | 'Info'
  kind: string; resource: string; envName: string; envId?: string
  principal?: string; host?: string; title: string; detail: string
  fixPayload?: string
}
export interface Existing { id: string; fingerprint: string; status: string }
export interface Store {
  listModule(module: Module): Promise<Existing[]>
  create(rec: Record<string, unknown>): Promise<void>
  update(id: string, changes: Record<string, unknown>): Promise<void>
}
export interface Result { created: number; updated: number; fixed: number; failed: number; errors: string[] }

/** Stable id of "the same finding" across scans (so history, first-seen and "fixed since" work). Columns are plain text <= 200 chars. */
export function fingerprint(r: Pick<FindingRow, 'module' | 'rule' | 'kind' | 'resource' | 'envName' | 'principal' | 'host'>): string {
  const raw = [r.module, r.rule, r.kind, r.envName, r.resource, r.principal ?? '', r.host ?? ''].join('|').toLowerCase()
  let h1 = 5381, h2 = 52711
  for (let i = 0; i < raw.length; i++) { const c = raw.charCodeAt(i); h1 = ((h1 * 33) ^ c) >>> 0; h2 = ((h2 * 31) + c) >>> 0 }
  return `${r.module}:${r.rule}:${h1.toString(36)}${h2.toString(36)}`.slice(0, 200)
}
const clip = (s: string | undefined, n: number) => (s ?? '').slice(0, n)
export const toRecord = (r: FindingRow, snapshot: string, nowIso: string) => ({
  occ_name: clip(r.title, 200), occ_fingerprint: fingerprint(r), occ_module: r.module, occ_rule: r.rule, occ_severity: r.severity, occ_kind: clip(r.kind, 100),
  occ_resourcename: clip(r.resource, 200), occ_envname: clip(r.envName, 200), occ_envid: clip(r.envId, 100), occ_principal: clip(r.principal, 200), occ_host: clip(r.host, 200),
  occ_detail: clip(r.detail, 9000), occ_fixpayload: clip(r.fixPayload, 9000), occ_snapshot: snapshot, occ_status: 'open', occ_lastseen: nowIso,
})

/** Pure planning step: what to create, update and mark fixed. Rows seen before keep their first-seen date (not sent on update). */
export function plan(existing: Existing[], incoming: FindingRow[], snapshot: string, nowIso: string) {
  const byFp = new Map(existing.map((e) => [e.fingerprint, e]))
  const seen = new Set<string>()
  const create: Record<string, unknown>[] = []; const update: { id: string; changes: Record<string, unknown> }[] = []
  for (const r of incoming) {
    const rec = toRecord(r, snapshot, nowIso); const fp = rec.occ_fingerprint
    if (seen.has(fp)) continue
    seen.add(fp)
    const old = byFp.get(fp)
    if (old) update.push({ id: old.id, changes: rec })
    else create.push({ ...rec, occ_firstseen: nowIso })
  }
  const fixed = existing.filter((e) => !seen.has(e.fingerprint) && e.status !== 'fixed').map((e) => ({ id: e.id, changes: { occ_status: 'fixed', occ_lastseen: nowIso, occ_snapshot: snapshot } }))
  return { create, update, fixed }
}

async function retry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let i = 0; i < 4; i++) {
    try { return await fn() } catch (e) { last = e; if (!/429|throttl|too many|timeout|5\d\d/i.test((e as Error).message)) throw e; await new Promise((r) => setTimeout(r, 600 * 2 ** i)) }
  }
  throw last
}
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { for (let k = i++; k < items.length; k = i++) await fn(items[k]) }))
}

export async function publish(store: Store, module: Module, rows: FindingRow[], onProgress?: (done: number, total: number) => void, now = new Date()): Promise<Result> {
  const nowIso = now.toISOString(); const snapshot = `${module}-${nowIso.slice(0, 16)}`
  const p = plan(await store.listModule(module), rows, snapshot, nowIso)
  const res: Result = { created: 0, updated: 0, fixed: 0, failed: 0, errors: [] }
  const total = p.create.length + p.update.length + p.fixed.length; let done = 0
  const run = async (kind: 'created' | 'updated' | 'fixed', f: () => Promise<void>) => {
    try { await retry(f); res[kind]++ } catch (e) { res.failed++; if (res.errors.length < 3) res.errors.push((e as Error).message.slice(0, 200)) }
    onProgress?.(++done, total)
  }
  await pool(p.create, 8, (rec) => run('created', () => store.create(rec)))
  await pool(p.update, 8, (u) => run('updated', () => store.update(u.id, u.changes)))
  await pool(p.fixed, 8, (u) => run('fixed', () => store.update(u.id, u.changes)))
  return res
}

/** In-memory store (Demo mode and tests). */
export function memoryStore(): Store & { rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>(); let n = 0
  return { rows,
    async listModule(m) { return [...rows].filter(([, r]) => r.occ_module === m).map(([id, r]) => ({ id, fingerprint: String(r.occ_fingerprint), status: String(r.occ_status) })) },
    async create(rec) { rows.set(`id${++n}`, { ...rec }) },
    async update(id, ch) { rows.set(id, { ...(rows.get(id) ?? {}), ...ch }) } }
}
