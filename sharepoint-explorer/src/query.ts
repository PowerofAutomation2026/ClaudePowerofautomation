import type { Clause, Query, Row, SpField } from './types'
import { cellText, odataQuote } from './util'

export const emptyQuery = (): Query => ({ search: '', clauses: [], sort: { field: 'ID', dir: 'desc' }, folders: false })

export const isDefaultQuery = (q: Query) => !q.search && !q.clauses.length

export const OPS_BY_KIND: Record<string, { op: Clause['op']; label: string }[]> = {
  text: [{ op: 'contains', label: 'contains' }, { op: 'eq', label: 'is' }, { op: 'startswith', label: 'starts with' }, { op: 'neq', label: 'is not' }, { op: 'empty', label: 'is empty' }, { op: 'notempty', label: 'is not empty' }],
  number: [{ op: 'eq', label: '=' }, { op: 'gt', label: '>' }, { op: 'ge', label: '≥' }, { op: 'lt', label: '<' }, { op: 'le', label: '≤' }, { op: 'empty', label: 'is empty' }],
  date: [{ op: 'lastdays', label: 'in the last N days' }, { op: 'ge', label: 'on or after' }, { op: 'le', label: 'on or before' }, { op: 'empty', label: 'is empty' }],
  boolean: [{ op: 'eq', label: 'is' }],
  choice: [{ op: 'in', label: 'is any of' }, { op: 'neq', label: 'is not' }, { op: 'empty', label: 'is empty' }],
  user: [{ op: 'eq', label: 'is' }, { op: 'contains', label: 'contains' }, { op: 'empty', label: 'is empty' }],
}
export const opsFor = (f: SpField) => {
  const k = f.kind === 'currency' || f.kind === 'counter' ? 'number' : f.kind === 'note' || f.kind === 'url' || f.kind === 'other' ? 'text' : f.kind === 'lookup' || f.kind === 'multichoice' ? (f.kind === 'multichoice' ? 'choice' : 'user') : f.kind
  return OPS_BY_KIND[k] ?? OPS_BY_KIND.text
}

export const describeClause = (c: Clause, fields: SpField[]) => {
  const f = fields.find((x) => x.internal === c.field)
  const op = opsFor(f ?? ({ kind: 'text' } as SpField)).find((o) => o.op === c.op)?.label ?? c.op
  const v = c.op === 'in' ? (c.values ?? []).join(' | ') : c.op === 'empty' || c.op === 'notempty' ? '' : c.value
  return `${f?.title ?? c.field} ${op} ${v}`.trim()
}

/* ------------------------------------------------------------------ local evaluation */

const hay = new WeakMap<Row, string>()
export function haystack(row: Row, fields: SpField[]): string {
  let h = hay.get(row)
  if (h === undefined) {
    h = fields.map((f) => cellText(f, row)).join(' \u0001 ').toLowerCase()
    hay.set(row, h)
  }
  return h
}
export const resetHaystack = (rows: Row[]) => rows.forEach((r) => hay.delete(r))

export function searchTokens(s: string): string[] {
  return s.toLowerCase().split(/\s+/).filter(Boolean)
}

function clauseMatches(c: Clause, row: Row, f: SpField): boolean {
  const raw = row[f.internal]
  const text = cellText(f, row).toLowerCase()
  const v = c.value.toLowerCase()
  switch (c.op) {
    case 'empty': return raw == null || raw === '' || (Array.isArray(raw) && !raw.length)
    case 'notempty': return !(raw == null || raw === '')
    case 'contains': return text.includes(v)
    case 'startswith': return text.startsWith(v)
    case 'eq':
      if (f.kind === 'number' || f.kind === 'currency' || f.kind === 'counter') return Number(raw) === Number(c.value)
      if (f.kind === 'boolean') return (raw === true || raw === 'true') === (c.value === 'true' || c.value === 'Yes')
      return text === v
    case 'neq': return text !== v
    case 'in': return (c.values ?? []).some((x) => (Array.isArray(raw) ? raw.map(String) : [text]).some((y) => y.toLowerCase() === x.toLowerCase()))
    case 'gt': case 'ge': case 'lt': case 'le': {
      const a = f.kind === 'date' ? Date.parse(String(raw)) : Number(raw)
      const b = f.kind === 'date' ? Date.parse(c.value) : Number(c.value)
      if (isNaN(a) || isNaN(b)) return false
      return c.op === 'gt' ? a > b : c.op === 'ge' ? a >= b : c.op === 'lt' ? a < b : a <= b
    }
    case 'lastdays': {
      const t = Date.parse(String(raw)); if (isNaN(t)) return false
      return t >= Date.now() - Number(c.value || 0) * 86_400_000
    }
  }
  return true
}

export function matchRow(row: Row, q: Query, fields: SpField[], tokens: string[]): boolean {
  if (tokens.length) { const h = haystack(row, fields); for (const t of tokens) if (!h.includes(t)) return false }
  for (const c of q.clauses) {
    const f = fields.find((x) => x.internal === c.field)
    if (f && !clauseMatches(c, row, f)) return false
  }
  return true
}

export function sortRows(rows: Row[], q: Query, fields: SpField[]): Row[] {
  const f = fields.find((x) => x.internal === q.sort.field)
  const dir = q.sort.dir === 'asc' ? 1 : -1
  const key = (r: Row): number | string => {
    if (q.sort.field === 'ID') return r.__id
    const v = r[q.sort.field]
    if (v == null) return ''
    if (f?.kind === 'number' || f?.kind === 'currency' || f?.kind === 'counter') return Number(v)
    if (f?.kind === 'date') return Date.parse(String(v)) || 0
    return cellText(f ?? ({ kind: 'text', internal: q.sort.field } as SpField), r).toLowerCase()
  }
  const out = rows.slice()
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  out.sort((a, b) => {
    const x = key(a), y = key(b)
    const r = typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y))
    return r === 0 ? (a.__id - b.__id) * dir : r * dir
  })
  return out
}

/* ------------------------------------------------------------------ OData for SharePoint REST */

const dt = (d: Date) => `datetime'${d.toISOString()}'`

export function clauseToOData(c: Clause, f: SpField): string | null {
  const n = f.internal
  const fieldRef = f.kind === 'user' || f.kind === 'lookup' ? `${n}/Title` : n
  switch (c.op) {
    case 'empty': return `${n} eq null`
    case 'notempty': return `${n} ne null`
    case 'contains': return `substringof(${odataQuote(c.value)},${fieldRef})`
    case 'startswith': return `startswith(${fieldRef},${odataQuote(c.value)})`
    case 'in': {
      const vs = c.values ?? []
      return vs.length ? '(' + vs.map((v) => `${fieldRef} eq ${odataQuote(v)}`).join(' or ') + ')' : null
    }
    case 'lastdays': return `${n} ge ${dt(new Date(Date.now() - Number(c.value || 0) * 86_400_000))}`
    case 'eq': case 'neq': case 'gt': case 'ge': case 'lt': case 'le': {
      const o = c.op === 'neq' ? 'ne' : c.op
      if (f.kind === 'number' || f.kind === 'currency' || f.kind === 'counter') return `${n} ${o} ${Number(c.value)}`
      if (f.kind === 'boolean') return `${n} ${o} ${c.value === 'true' || c.value === 'Yes' ? 1 : 0}`
      if (f.kind === 'date') { const d = new Date(c.value); return isNaN(+d) ? null : `${n} ${o} ${dt(d)}` }
      return `${fieldRef} ${o} ${odataQuote(c.value)}`
    }
  }
  return null
}

/** Columns the free-text search should hit on the server (kept small so SharePoint can use its indexes). */
export function serverSearchFields(fields: SpField[], isLibrary: boolean): SpField[] {
  const primary = fields.filter((f) => f.internal === (isLibrary ? 'FileLeafRef' : 'Title'))
  const extra = fields.filter((f) => f.kind === 'text' && f.indexed && !primary.includes(f)).slice(0, 2)
  return [...primary, ...extra]
}

export function buildFilter(q: Query, fields: SpField[], isLibrary: boolean, extra: string[] = []): string {
  const parts = [...extra]
  if (isLibrary && !q.folders) parts.push('FSObjType eq 0')
  const tokens = searchTokens(q.search)
  const sf = serverSearchFields(fields, isLibrary)
  for (const t of tokens.slice(0, 4)) {
    if (sf.length) parts.push('(' + sf.map((f) => `substringof(${odataQuote(t)},${f.internal})`).join(' or ') + ')')
  }
  for (const c of q.clauses) {
    const f = fields.find((x) => x.internal === c.field)
    const s = f && clauseToOData(c, f)
    if (s) parts.push(s)
  }
  return parts.join(' and ')
}
