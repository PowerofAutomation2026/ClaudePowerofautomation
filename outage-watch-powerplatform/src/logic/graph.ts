/**
 * Pure helpers for the blast-radius map and the "Can I do my job?" view
 * (ports of topo/downstream/derive/roleStatus from the Python dashboard, plus a deterministic layout).
 */
import type { Frame, State } from './classify'

export type Kind = State | 'risk-down' | 'risk-warn'
export const SEV: Record<State, number> = { up: 0, blocked: 0, unconfigured: 0, warning: 1, suspect: 2, down: 3 }

export interface Topology { out: Map<string, string[]>; inn: Map<string, string[]>; edges: [string, string][] }

export function topo(names: string[], edges: [string, string][]): Topology {
  const has = new Set(names)
  const out = new Map<string, string[]>(); const inn = new Map<string, string[]>(); const E: [string, string][] = []
  for (const n of names) { out.set(n, []); inn.set(n, []) }
  for (const [a, b] of edges) if (has.has(a) && has.has(b) && a !== b) { E.push([a, b]); out.get(a)!.push(b); inn.get(b)!.push(a) }
  return { out, inn, edges: E }
}

export function downstream(n: string, out: Map<string, string[]>): Set<string> {
  const seen = new Set<string>(); const q = [n]
  while (q.length) { const x = q.pop()!; for (const y of out.get(x) ?? []) if (!seen.has(y) && y !== n) { seen.add(y); q.push(y) } }
  return seen
}

export interface Derived { own: State; risk: number; via: string[]; kind: Kind }

/** Own state + inherited risk from every unhealthy upstream service. */
export function derive(frame: Frame, T: Topology): Map<string, Derived> {
  const D = new Map<string, Derived>()
  frame.services.forEach((v, n) => D.set(n, { own: v.state, risk: 0, via: [], kind: 'up' }))
  frame.services.forEach((v, n) => {
    const sv = SEV[v.state]
    if (!sv) return
    downstream(n, T.out).forEach((y) => { const d = D.get(y); if (!d) return; if (sv > d.risk) d.risk = sv; d.via.push(n) })
  })
  D.forEach((d) => { d.kind = d.own !== 'up' ? d.own : d.risk >= 2 ? 'risk-down' : d.risk === 1 ? 'risk-warn' : 'up' })
  return D
}

export type RoleKind = 'up' | 'warning' | 'down' | 'blocked' | 'none'
export interface RoleStatus { name: string; k: RoleKind; why: string }
export const ROLE_WORD: Record<RoleKind, string> = { up: 'Should work', warning: 'May be unreliable', down: 'Unlikely to work right now', blocked: 'Cannot fully tell from here', none: 'Not monitored' }

export function list(a: string[], max = 6): string {
  return a.length <= max ? a.join(', ') : a.slice(0, max).join(', ') + ' and ' + (a.length - max) + ' more'
}

/** Port of roleStatus() in dashboard.html. */
export function roleStatus(roles: Record<string, string[]>, frame: Frame, D: Map<string, Derived>): RoleStatus[] {
  return Object.entries(roles).map(([name, services]) => {
    const unconf = services.filter((n) => frame.services.get(n)?.state === 'unconfigured')
    const need = services.filter((n) => frame.services.has(n) && frame.services.get(n)!.state !== 'unconfigured')
    let worst = 0
    const blocked: string[] = []; const why: string[] = []; const seen = new Set<string>()
    const cause = (n: string) => {
      const o = D.get(n)?.own
      if (!o || seen.has(n) || !SEV[o]) return
      seen.add(n)
      why.push(n + ' is ' + (o === 'down' ? 'not answering' : o === 'suspect' ? 'failing (not yet confirmed)' : 'slow'))
    }
    for (const n of need) {
      const d = D.get(n)!
      const sv = Math.max(SEV[d.own], d.risk)
      if (sv > worst) worst = sv
      if (d.own === 'blocked') blocked.push(n)
      cause(n); d.via.forEach(cause)
    }
    const k: RoleKind = !need.length ? 'none' : worst >= 3 ? 'down' : worst >= 1 ? 'warning' : blocked.length || unconf.length ? 'blocked' : 'up'
    const text = k === 'none' ? 'none of its services are monitored here'
      : k === 'blocked' && !blocked.length ? list(unconf, 3) + ' not set up (tenant name missing); the rest answers'
      : k === 'blocked' ? list(blocked, 3) + ' could not be checked: the probe was refused on our side'
      : k === 'up' ? 'needs ' + list(need, 5) + ': all answering' : why.join('; ')
    return { name, k, why: text }
  })
}

// ---------------------------------------------------------------------------------------------
// Families + layout (family clusters on two buses, like the Python dashboard)
// ---------------------------------------------------------------------------------------------
export interface Family { name: string; nodes: string[] }

/** Group `names` by family; anything unknown goes to "Independent" (port of the dashboard's family grouping). */
export function groupFamilies(names: string[], families: [string, string[]][], familyOf: (n: string) => string | undefined = () => undefined): Family[] {
  const left = new Set(names)
  const out: Family[] = []
  const byName = new Map<string, Family>()
  const add = (fam: string, n: string) => {
    let f = byName.get(fam)
    if (!f) { f = { name: fam, nodes: [] }; byName.set(fam, f); out.push(f) }
    f.nodes.push(n)
  }
  const order = families.map((f) => f[0])
  for (const [fam, members] of families) for (const n of members) if (left.has(n)) { left.delete(n); add(familyOf(n) || fam, n) }
  for (const n of [...left].sort()) add(familyOf(n) || 'Independent', n)
  return out.sort((a, b) => { const ia = order.indexOf(a.name); const ib = order.indexOf(b.name); return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) })
}

const RANK: Record<Kind, number> = { up: 0, unconfigured: 0, blocked: 0, 'risk-warn': 1, warning: 2, 'risk-down': 3, suspect: 4, down: 5 }
export interface FamilySummary { worst: Kind; total: number; problems: number; text: string }

/** One line per family: worst state and counts (keeps a 36-node map readable when families are collapsed). */
export function familySummary(nodes: string[], D: Map<string, Derived>): FamilySummary {
  let worst: Kind = 'up'
  const c: Record<string, number> = {}
  let total = 0
  for (const n of nodes) {
    const d = D.get(n)
    if (!d) continue
    total++
    c[d.kind] = (c[d.kind] ?? 0) + 1
    if (RANK[d.kind] > RANK[worst]) worst = d.kind
  }
  const problems = total - (c.up ?? 0) - (c.unconfigured ?? 0) - (c.blocked ?? 0)
  const parts: string[] = []
  for (const [k, word] of [['down', 'down'], ['suspect', 'suspect'], ['warning', 'warning'], ['risk-down', 'at risk'], ['risk-warn', 'may be slow'], ['blocked', 'blocked'], ['unconfigured', 'not set up']] as const) if (c[k]) parts.push(c[k] + ' ' + word)
  if (!problems && worst === 'up' && (c.unconfigured ?? 0) === total && total > 0) worst = 'unconfigured'
  return { worst, total, problems, text: parts.length ? parts.join(', ') : 'all answering' }
}

/** A problem worth showing under "show only problems" (neutral states are not problems). */
export const isProblem = (k: Kind) => k !== 'up' && k !== 'unconfigured' && k !== 'blocked'

export interface Pos { x: number; y: number }
export interface Band { name: string; y: number; h: number; collapsed: boolean; nodes: string[]; signIn: boolean; copilot: boolean; yMid: number }
export interface Rail { kind: 'signin' | 'copilot'; family: string; d: string; from: string[] }
export interface MapLayout {
  width: number; height: number; narrow: boolean; r: number
  pos: Map<string, Pos>
  bands: Band[]
  /** Dependency lines. signin: hub -> dependants (hot when the hub fails). copilot: sources -> sink (hot when a source in `from` fails). */
  rails: Rail[]
  hub: string | null; sink: string | null
}

export interface LayoutOptions { narrow: boolean; collapsed?: ReadonlySet<string>; hub?: string; sink?: string }

/**
 * Deterministic "family bands on two buses" layout.
 * Every family is a horizontal band; nodes sit in rows (7 per row wide, 3 per row at 360 px).
 * Left bus = sign-in: from the hub (auth) down the left edge, with a rail through every dependant in each row.
 * Right bus = what Copilot reads: a rail above each row with a tick to every source, collected on the right edge
 * and delivered to the sink (m365-copilot). Lines never cross a node they do not belong to:
 * within a row, sign-in dependants come first, so the sign-in rail stops before the others.
 */
export function layoutFamilies(families: Family[], dependsOnAuth: ReadonlySet<string>, copilotNeeds: ReadonlySet<string>, o: LayoutOptions): MapLayout {
  const hub = o.hub ?? 'auth'; const sink = o.sink ?? 'm365-copilot'
  const narrow = o.narrow
  const W = narrow ? 360 : 1000
  const cols = narrow ? 3 : 7
  const busL = narrow ? 9 : 22; const busR = W - busL
  const x0 = narrow ? 66 : 96; const pitch = narrow ? 114 : 134
  const r = narrow ? 19 : 22
  const head = 30; const rowH = narrow ? 102 : 108; const gap = 10; const top = 6
  const all = new Set(families.flatMap((f) => f.nodes))
  const hasHub = all.has(hub); const hasSink = all.has(sink)
  const pos = new Map<string, Pos>()
  const bands: Band[] = []
  const rails: Rail[] = []
  const f1 = (v: number) => v.toFixed(1)
  let y = top
  let hubPos: Pos | null = null
  let sinkPos: Pos | null = null
  const stubs: { y: number; kind: 'signin' | 'copilot'; family: string; from: string[] }[] = []

  for (const fam of families) {
    const collapsed = !!o.collapsed?.has(fam.name)
    // order: hub first, then sign-in dependants (Copilot sources last among them), then everything else
    const rank = (n: string) => (n === hub ? 0 : dependsOnAuth.has(n) ? (n === sink ? 1 : copilotNeeds.has(n) ? 3 : 2) : 4)
    const nodes = [...fam.nodes].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    const needsSignIn = hasHub && nodes.some((n) => dependsOnAuth.has(n) && n !== hub)
    const feedsCopilot = hasSink && nodes.some((n) => copilotNeeds.has(n) && n !== sink)
    const rows = collapsed ? 0 : Math.ceil(nodes.length / cols)
    const h = head + rows * rowH + (collapsed ? 0 : 4)
    const band: Band = { name: fam.name, y, h, collapsed, nodes, signIn: needsSignIn, copilot: feedsCopilot, yMid: y + head / 2 }
    bands.push(band)
    if (collapsed) {
      // a collapsed family keeps its place on the buses, so a failure still visibly reaches it
      if (needsSignIn || nodes.includes(hub)) stubs.push({ y: band.yMid, kind: 'signin', family: fam.name, from: [hub] })
      if (feedsCopilot || nodes.includes(sink)) stubs.push({ y: band.yMid, kind: 'copilot', family: fam.name, from: nodes.filter((n) => copilotNeeds.has(n)) })
      if (nodes.includes(hub)) hubPos = { x: x0, y: band.yMid }
      if (nodes.includes(sink)) sinkPos = { x: busR - 40, y: band.yMid }
    } else {
      for (let ri = 0; ri < rows; ri++) {
        const row = nodes.slice(ri * cols, ri * cols + cols)
        const cy = y + head + ri * rowH + r + 16
        row.forEach((n, i) => pos.set(n, { x: x0 + i * pitch, y: cy }))
        if (row.includes(hub)) hubPos = pos.get(hub)!
        if (row.includes(sink)) sinkPos = pos.get(sink)!
        const dep = row.filter((n) => (dependsOnAuth.has(n) && n !== hub) || n === hub)
        if (hasHub && dep.length) {
          const lastX = pos.get(dep[dep.length - 1])!.x
          rails.push({ kind: 'signin', family: fam.name, from: [hub], d: `M${f1(busL)},${f1(cy)}L${f1(lastX)},${f1(cy)}` })
          stubs.push({ y: cy, kind: 'signin', family: fam.name, from: [hub] })
        }
        const src = row.filter((n) => copilotNeeds.has(n) && n !== sink)
        const hasSinkHere = row.includes(sink)
        if (hasSink && (src.length || hasSinkHere)) {
          const ry = cy - r - 11
          const members = [...src, ...(hasSinkHere ? [sink] : [])]
          const firstX = Math.min(...members.map((n) => pos.get(n)!.x))
          let d = `M${f1(busR)},${f1(ry)}L${f1(firstX)},${f1(ry)}`
          for (const n of members) d += `M${f1(pos.get(n)!.x)},${f1(ry)}L${f1(pos.get(n)!.x)},${f1(cy - r - 2)}`
          rails.push({ kind: 'copilot', family: fam.name, from: src, d })
          stubs.push({ y: ry, kind: 'copilot', family: fam.name, from: src })
        }
      }
    }
    y += h + gap
  }
  const height = y - gap + top
  // the two buses: one vertical line each, spanning every stub
  const bus = (kind: 'signin' | 'copilot', x: number) => {
    const ys = stubs.filter((s) => s.kind === kind).map((s) => s.y)
    if (ys.length < 2) return
    const from = kind === 'signin' ? [hub] : [...new Set(stubs.filter((s) => s.kind === 'copilot').flatMap((s) => s.from))]
    rails.push({ kind, family: '*', from, d: `M${f1(x)},${f1(Math.min(...ys))}L${f1(x)},${f1(Math.max(...ys))}` })
  }
  bus('signin', busL); bus('copilot', busR)
  for (const s of stubs) {   // collapsed families: a short stub so the bus visibly ends at the band
    const b = bands.find((x) => x.name === s.family)!
    if (b.collapsed) rails.push({ kind: s.kind, family: s.family, from: s.from, d: s.kind === 'signin' ? `M${f1(busL)},${f1(s.y)}L${f1(busL + 14)},${f1(s.y)}` : `M${f1(busR)},${f1(s.y)}L${f1(busR - 14)},${f1(s.y)}` })
  }
  void hubPos; void sinkPos
  return { width: W, height, narrow, r, pos, bands, rails, hub: hasHub ? hub : null, sink: hasSink ? sink : null }
}
