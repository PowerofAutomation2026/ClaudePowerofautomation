/**
 * Dashboard widgets. Each widget owns a small accumulator that rows are fed into page by page, so the SAME code serves a fully loaded
 * small list, a 2,000-row sample, and a "deep scan" of millions of rows (only counters are kept, never the rows).
 */
import { resolveRelative } from './format'
import { clauseMatches } from './query'
import type { Row, SpField, Widget } from './types'
import { cellText, uid } from './util'

export interface GroupRes { kind: 'group'; items: { label: string; value: number }[]; total: number }
export interface KpiRes { kind: 'kpi'; value: number; n: number; field?: SpField }
export interface TimeRes { kind: 'time'; items: { label: string; value: number }[] }
export interface TopRes { kind: 'top'; rows: { id: number; title: string; value: number | string }[] }
export type WidgetRes = GroupRes | KpiRes | TimeRes | TopRes | { kind: 'none' }
export interface Acc { add(rows: Row[]): void; result(): WidgetRes }

const DAY = 86_400_000
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10)
const weekKey = (d: string) => { const t = new Date(d + 'T00:00:00Z'); const dow = (t.getUTCDay() + 6) % 7; return dayKey(+t - dow * DAY) }
const rebucket = (day: string, b: string) => (b === 'month' ? day.slice(0, 7) : b === 'year' ? day.slice(0, 4) : b === 'week' ? weekKey(day) : day)

export function makeAcc(w: Widget, fields: SpField[], titleField: string): Acc {
  const f = fields.find((x) => x.internal === w.field)
  const vf = fields.find((x) => x.internal === w.valueField)
  const cf = w.clause ? fields.find((x) => x.internal === w.clause!.field) : undefined
  let clause = w.clause ? { ...w.clause, value: w.clause.op === 'lastdays' ? w.clause.value : resolveRelative(w.clause.value) } : undefined
  if (clause && cf?.percent && !isNaN(Number(clause.value)) && ['gt', 'ge', 'lt', 'le', 'eq'].includes(clause.op)) clause = { ...clause, value: String(Number(clause.value) / 100) }
  const pass = (r: Row) => !clause || !cf || clauseMatches(clause, r, cf)
  const num = (r: Row) => { const x = Number(r[w.valueField ?? '']); return isNaN(x) ? null : x }
  const agg = w.agg ?? 'count'

  if (w.type === 'kpi' || w.type === 'goal') {
    let n = 0, sum = 0, mn = Infinity, mx = -Infinity
    return {
      add(rows) { for (const r of rows) { if (!pass(r)) continue; n++; const x = agg === 'count' ? null : num(r); if (x != null) { sum += x; if (x < mn) mn = x; if (x > mx) mx = x } } },
      result: () => ({ kind: 'kpi', n, field: vf, value: agg === 'count' ? n : agg === 'sum' ? sum : agg === 'avg' ? (n ? sum / n : 0) : agg === 'min' ? (isFinite(mn) ? mn : 0) : (isFinite(mx) ? mx : 0) }),
    }
  }
  if (w.type === 'bar' || w.type === 'donut') {
    const m = new Map<string, { n: number; sum: number }>()
    const CAP = 5000
    return {
      add(rows) {
        for (const r of rows) {
          if (!pass(r)) continue
          const raw = f ? r[f.internal] : ''
          const keys: string[] = raw == null || raw === '' ? ['(empty)'] : f?.kind === 'date' ? [rebucket(dayKey(Date.parse(String(raw))), w.bucket && w.bucket !== 'auto' ? w.bucket : 'month')]
            : Array.isArray(raw) ? raw.map(String) : f?.kind === 'user' || f?.kind === 'lookup' || f?.kind === 'multichoice' ? String(raw).split('; ') : [f?.kind === 'boolean' ? cellText(f, r) : String(raw)]
          const x = agg === 'count' ? 0 : num(r) ?? 0
          for (const k of keys) { const e = m.get(k); if (e) { e.n++; e.sum += x } else if (m.size < CAP) m.set(k, { n: 1, sum: x }) }
        }
      },
      result: () => {
        const val = (e: { n: number; sum: number }) => (agg === 'count' ? e.n : agg === 'sum' ? e.sum : e.n ? e.sum / e.n : 0)
        const all = [...m.entries()].map(([label, e]) => ({ label, value: Math.round(val(e) * 100) / 100 })).sort(f?.kind === 'date' ? (a, b) => a.label.localeCompare(b.label) : (a, b) => b.value - a.value)
        const N = w.topN ?? 8, head = f?.kind === 'date' ? all.slice(-N) : all.slice(0, N), rest = f?.kind === 'date' ? 0 : all.slice(N).reduce((a, b) => a + b.value, 0)
        if (rest > 0) head.push({ label: 'Other', value: rest })
        return { kind: 'group', items: head, total: all.reduce((a, b) => a + b.value, 0) }
      },
    }
  }
  if (w.type === 'timeline') {
    const days = new Map<string, { n: number; sum: number }>()
    return {
      add(rows) { for (const r of rows) { if (!pass(r)) continue; const t = Date.parse(String(r[w.field ?? 'Created'])); if (isNaN(t)) continue; const k = dayKey(t); const x = agg === 'count' ? 0 : num(r) ?? 0; const e = days.get(k); if (e) { e.n++; e.sum += x } else days.set(k, { n: 1, sum: x }) } },
      result: () => {
        const keys = [...days.keys()].sort(); if (!keys.length) return { kind: 'time', items: [] }
        const span = (Date.parse(keys[keys.length - 1]) - Date.parse(keys[0])) / DAY
        const b = w.bucket && w.bucket !== 'auto' ? w.bucket : span <= 75 ? 'day' : span <= 400 ? 'week' : span <= 1500 ? 'month' : 'year'
        const out = new Map<string, number>()
        for (const k of keys) { const e = days.get(k)!; out.set(rebucket(k, b), (out.get(rebucket(k, b)) ?? 0) + (agg === 'count' ? e.n : agg === 'sum' ? e.sum : e.n ? e.sum / e.n : 0)) }
        return { kind: 'time', items: [...out.entries()].map(([label, value]) => ({ label, value: Math.round(value * 100) / 100 })) }
      },
    }
  }
  if (w.type === 'top') {
    const N = w.topN ?? 5, desc = (w.sortDir ?? 'desc') === 'desc'
    let best: { row: Row; key: number }[] = []
    const key = (r: Row) => (vf ? num(r) : f?.kind === 'date' ? Date.parse(String(r[f.internal])) : r.__id)
    return {
      add(rows) { for (const r of rows) { if (!pass(r)) continue; const k = key(r); if (k == null || isNaN(k)) continue; best.push({ row: r, key: k }) } best.sort((a, b) => (desc ? b.key - a.key : a.key - b.key)); best = best.slice(0, N) },
      result: () => ({ kind: 'top', rows: best.map(({ row, key: k }) => ({ id: row.__id, title: String(row[titleField] ?? `#${row.__id}`), value: vf ? cellText(vf, row) : f ? cellText(f, row) : k })) }),
    }
  }
  return { add() {}, result: () => ({ kind: 'none' }) }
}

/** A sensible first dashboard built from the list's own columns (the admin edits it from here). */
export function starterWidgets(fields: SpField[], isLibrary: boolean): Widget[] {
  const w = (p: Partial<Widget> & Pick<Widget, 'type' | 'title'>): Widget => ({ id: uid(), size: 1, agg: 'count', ...p })
  const out: Widget[] = [w({ type: 'kpi', title: isLibrary ? 'Files' : 'Total items' })]
  const created = fields.find((f) => f.internal === 'Created'); if (created) out.push(w({ type: 'kpi', title: 'New in last 7 days', clause: { field: 'Created', op: 'lastdays', value: '7' } }))
  const num = fields.find((f) => (f.kind === 'currency' || f.kind === 'number') && !f.system && !['ID', 'File_x0020_Size', 'Version'].includes(f.internal))
  if (num) out.push(w({ type: 'kpi', title: `Total ${num.title}`, agg: 'sum', valueField: num.internal }))
  const choices = fields.filter((f) => f.kind === 'choice' && !f.system)
  if (choices[0]) out.push(w({ type: 'donut', title: `By ${choices[0].title}`, field: choices[0].internal, size: 1 }))
  if (choices[1]) out.push(w({ type: 'bar', title: `By ${choices[1].title}`, field: choices[1].internal, size: 1 }))
  if (created) out.push(w({ type: 'timeline', title: 'Activity over time', field: 'Created', size: 2 }))
  if (num) out.push(w({ type: 'top', title: `Top 5 by ${num.title}`, valueField: num.internal, topN: 5, size: 1 }))
  return out
}
