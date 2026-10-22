import { clauseMatches } from './query'
import type { FormatRule, Row, SpField } from './types'

export const FMT_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'] as const
export const FMT_MARKERS = ['●', '!', '✓', '⚑', '⏰', '★']
export type Painted = { row?: FormatRule; cells: Record<string, FormatRule> } | null
export type Painter = (row: Row) => Painted

/** "today", "today-7", "today+30" -> a date (YYYY-MM-DD); anything else is returned unchanged. */
export function resolveRelative(v: string): string {
  const m = /^today\s*([+-]\s*\d+)?$/i.exec(v.trim()); if (!m) return v
  const d = new Date(); d.setDate(d.getDate() + Number((m[1] ?? '0').replace(/\s/g, '')))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Turns the rule list into a function that says how to paint a row. First matching ROW rule wins; each cell keeps its first matching cell rule. */
export function compileRules(rules: FormatRule[], fields: SpField[]): Painter | undefined {
  const act = rules.filter((r) => r.enabled).map((r) => ({ r, f: fields.find((x) => x.internal === r.clause.field), c: { ...r.clause, value: r.clause.op === 'lastdays' ? r.clause.value : resolveRelative(r.clause.value) } })).filter((x) => x.f)
  if (!act.length) return undefined
  for (const a of act) if (a.f!.percent && ['gt', 'ge', 'lt', 'le', 'eq'].includes(a.c.op) && !isNaN(Number(a.c.value))) a.c = { ...a.c, value: String(Number(a.c.value) / 100) }   // typed as 90 (%), stored as 0.9
  return (row) => {
    let rr: FormatRule | undefined; const cells: Record<string, FormatRule> = {}
    for (const { r, f, c } of act) {
      if (!clauseMatches(c, row, f!)) continue
      if (r.scope === 'row') { if (!rr) rr = r } else if (!cells[f!.internal]) cells[f!.internal] = r
    }
    return rr || Object.keys(cells).length ? { row: rr, cells } : null
  }
}

export function legendCounts(rows: Row[], rules: FormatRule[], fields: SpField[]): { rule: FormatRule; n: number }[] {
  const act = rules.filter((r) => r.enabled && r.scope === 'row')
  const out = act.map((rule) => ({ rule, n: 0 }))
  for (const o of out) { const f = fields.find((x) => x.internal === o.rule.clause.field); if (!f) continue; const c = { ...o.rule.clause, value: resolveRelative(o.rule.clause.value) }; for (const r of rows) if (clauseMatches(c, r, f)) o.n++ }
  return out
}
