/**
 * Pure helpers for the blast-radius map and the "Can I do my job?" view
 * (ports of topo/downstream/derive/roleStatus from the Python dashboard, plus a deterministic layout).
 */
import type { Frame, State } from './classify'

export type Kind = State | 'risk-down' | 'risk-warn'
export const SEV: Record<State, number> = { up: 0, blocked: 0, warning: 1, suspect: 2, down: 3 }

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
export const ROLE_WORD: Record<RoleKind, string> = { up: 'Should work', warning: 'May be unreliable', down: 'Unlikely to work right now', blocked: 'Cannot tell from here', none: 'Not monitored' }

export function list(a: string[], max = 6): string {
  return a.length <= max ? a.join(', ') : a.slice(0, max).join(', ') + ' and ' + (a.length - max) + ' more'
}

/** Port of roleStatus() in dashboard.html. */
export function roleStatus(roles: Record<string, string[]>, frame: Frame, D: Map<string, Derived>): RoleStatus[] {
  return Object.entries(roles).map(([name, services]) => {
    const need = services.filter((n) => frame.services.has(n))
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
    const k: RoleKind = !need.length ? 'none' : worst >= 3 ? 'down' : worst >= 1 ? 'warning' : blocked.length ? 'blocked' : 'up'
    const text = k === 'none' ? 'none of its services are monitored here'
      : k === 'blocked' ? list(blocked, 3) + ' could not be checked: the probe was refused on our side'
      : k === 'up' ? 'needs ' + list(need, 5) + ': all answering' : why.join('; ')
    return { name, k, why: text }
  })
}

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------
export interface Pos { x: number; y: number }
export interface Layout { width: number; height: number; narrow: boolean; pos: Map<string, Pos>; r: number }

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Deterministic layout. Wide: hub (roots) in the centre, dependants on an ellipse, sinks on the right,
 * unconnected services in a row below. Narrow (phones, 360 px): stacked rows, three per row.
 */
export function layout(names: string[], T: Topology, narrow: boolean): Layout {
  const sortedNames = [...names].sort(byName)
  const isolated = sortedNames.filter((n) => !T.out.get(n)!.length && !T.inn.get(n)!.length)
  const roots = sortedNames.filter((n) => T.out.get(n)!.length && !T.inn.get(n)!.length)
  const sinks = sortedNames.filter((n) => T.inn.get(n)!.length && !T.out.get(n)!.length && T.inn.get(n)!.some((u) => T.inn.get(u)!.length))
  const sinkSet = new Set(sinks)
  const mid = sortedNames.filter((n) => T.inn.get(n)!.length && !sinkSet.has(n))
  const feeds = (n: string) => T.out.get(n)!.some((y) => sinkSet.has(y))
  const pos = new Map<string, Pos>()

  if (narrow) {
    const W = 360; const cols = 3; const colX = (i: number, count: number) => (W / (count + 1)) * (i + 1)
    let y = 46
    const row = (items: string[], gap: number) => {
      for (let i = 0; i < items.length; i += cols) {
        const chunk = items.slice(i, i + cols)
        chunk.forEach((n, k) => pos.set(n, { x: colX(k, chunk.length), y }))
        y += gap
      }
    }
    row(roots, 96)
    row([...mid.filter((n) => !feeds(n)), ...mid.filter(feeds)], 92)
    row(sinks, 96)
    if (isolated.length) { y += 8; row(isolated, 92) }
    return { width: W, height: y - 18, narrow, pos, r: 21 }
  }

  const W = 1000; const cx = 420; const cy = 280; const rx = 300; const ry = 220
  roots.forEach((n, i) => pos.set(n, { x: cx, y: cy + (i - (roots.length - 1) / 2) * 110 }))
  const place = (items: string[], from: number, to: number, skipZero: boolean) => {
    const k = items.length
    items.forEach((n, i) => {
      let deg = k === 1 ? (from + to) / 2 : from + ((to - from) * i) / (k - 1)
      if (skipZero && Math.abs(deg) < 16) deg = deg < 0 ? -16 : 16     // keep the hub -> sink corridor free
      const a = (deg * Math.PI) / 180
      pos.set(n, { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) })
    })
  }
  const right = mid.filter(feeds); const left = mid.filter((n) => !feeds(n))
  if (right.length) place(right, -78, 78, true); else if (left.length) { place(left, 0, 360 - 360 / Math.max(left.length, 1), false) }
  if (right.length) place(left, 104, 256, false)
  sinks.forEach((n, i) => pos.set(n, { x: 900, y: cy + (i - (sinks.length - 1) / 2) * 120 }))
  let height = 566
  if (isolated.length) {
    const y = 612
    isolated.forEach((n, i) => pos.set(n, { x: (W / (isolated.length + 1)) * (i + 1), y }))
    height = 672
  }
  return { width: W, height, narrow, pos, r: 24 }
}

/** Point on the border of the node at `a`, on the way to `b`. */
export function trim(a: Pos, b: Pos, r: number): Pos {
  const dx = b.x - a.x; const dy = b.y - a.y; const L = Math.hypot(dx, dy) || 1
  return { x: a.x + (dx / L) * r, y: a.y + (dy / L) * r }
}
