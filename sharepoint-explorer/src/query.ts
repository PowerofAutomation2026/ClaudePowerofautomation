import type { Clause, Query, Row, SpField } from './types'
import { cellText, odataQuote } from './util'

/** REST exposes columns whose internal name starts with '_' as 'OData_' + name (e.g. _ColorTag -> OData__ColorTag). */
export const restName = (internal: string) => (internal.startsWith('_') ? `OData_${internal}` : internal)
export const emptyQuery = (): Query => ({ search: '', clauses: [], sort: { field: 'ID', dir: 'desc' }, folders: false })

/** Library folder browsing applies only when no search/filter is active (search always covers the whole library). */
export const isFolderMode = (q: Query) => !!q.folder && !q.search && !q.clauses.length
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
  const v = c.op === 'in' ? (c.value || (c.values ?? []).join(' | ')) : c.op === 'empty' || c.op === 'notempty' ? '' : c.value
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

/**
 * Search syntax (same everywhere: in-memory, server filter, demo):
 *   word word        all words must appear
 *   "exact phrase"   phrase
 *   -word            must NOT appear
 *   Column:value     only that column (internal or display name, no spaces: Status:open  Assigned:ann)
 */
export interface ParsedSearch { terms: string[]; excludes: string[]; fielded: { field: string; value: string }[] }
export function parseSearch(s: string): ParsedSearch {
  const out: ParsedSearch = { terms: [], excludes: [], fielded: [] }
  const re = /(-?)(?:([\w]+):)?(?:"([^"]+)"|(\S+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s.toLowerCase()))) {
    const val = (m[3] ?? m[4] ?? '').trim(); if (!val) continue
    if (m[1]) out.excludes.push(val)
    else if (m[2]) out.fielded.push({ field: m[2], value: val })
    else out.terms.push(val)
  }
  return out
}
export function searchTokens(s: string): string[] { const p = parseSearch(s); return [...p.terms, ...p.fielded.map((f) => f.value)] }

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

const resolveField = (fields: SpField[], name: string) => fields.find((f) => f.internal.toLowerCase() === name || f.title.toLowerCase().replace(/\s+/g, '') === name || f.title.toLowerCase().startsWith(name))

export function matchRow(row: Row, q: Query, fields: SpField[], _tokens?: string[]): boolean {
  if (q.search) {
    const ps = parseSearch(q.search)
    const h = haystack(row, fields)
    for (const t of ps.terms) if (!h.includes(t)) return false
    for (const t of ps.excludes) if (h.includes(t)) return false
    for (const f of ps.fielded) { const fd = resolveField(fields, f.field); if (!fd || !cellText(fd, row).toLowerCase().includes(f.value)) return false }
  }
  for (const c of q.clauses) {
    const f = fields.find((x) => x.internal === c.field)
    if (f && !clauseMatches(c, row, f)) return false
  }
  return true
}

/** Relevance: title hits count most, then exact-start, then anywhere. Used when a search is active and no explicit sort was chosen. */
export function relevance(row: Row, terms: string[], titleField: string): number {
  const t = String(row[titleField] ?? '').toLowerCase()
  let sc = 0
  for (const w of terms) { if (t === w) sc += 6; else if (t.startsWith(w)) sc += 4; else if (t.includes(w)) sc += 3; else sc += 1 }
  return sc
}

export function sortRows(rows: Row[], q: Query, fields: SpField[], isLibrary = false): Row[] {
  if (q.search && q.sort.field === 'ID' && q.sort.dir === 'desc') {
    const terms = parseSearch(q.search).terms
    if (terms.length) { const tf = isLibrary ? 'FileLeafRef' : 'Title'; return rows.map((r) => [r, relevance(r, terms, tf)] as const).sort((a, b) => b[1] - a[1] || b[0].__id - a[0].__id).map((x) => x[0]) }
  }
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
  const n = restName(f.internal)
  const fieldRef = f.kind === 'user' ? `${n}/Title` : f.kind === 'lookup' ? `${n}/${f.lookupField || 'Title'}` : n
  switch (c.op) {
    case 'empty': return `${n} eq null`
    case 'notempty': return `${n} ne null`
    case 'contains': return `substringof(${odataQuote(c.value)},${fieldRef})`
    case 'startswith': return `startswith(${fieldRef},${odataQuote(c.value)})`
    case 'in': {
      const vs = c.values ?? []
      const num = f.kind === 'counter' || f.kind === 'number' || f.kind === 'currency'
      return vs.length ? '(' + vs.map((v) => `${fieldRef} eq ${num ? Number(v) : odataQuote(v)}`).join(' or ') + ')' : null
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
  const ps = parseSearch(q.search)
  const sf = serverSearchFields(fields, isLibrary)
  for (const t of ps.terms.slice(0, 4)) {
    if (sf.length) parts.push('(' + sf.map((f) => `substringof(${odataQuote(t)},${restName(f.internal)})`).join(' or ') + ')')
  }
  for (const t of ps.excludes.slice(0, 3)) { if (sf.length) parts.push('not (' + sf.map((f) => `substringof(${odataQuote(t)},${restName(f.internal)})`).join(' or ') + ')') }
  for (const fv of ps.fielded.slice(0, 3)) {
    const fd = resolveField(fields, fv.field)
    if (fd && fd.filterable) { const c = clauseToOData({ field: fd.internal, op: fd.kind === 'choice' ? 'eq' : 'contains', value: fv.value }, fd); if (c) parts.push(c) }
  }
  for (const c of q.clauses) {
    const f = fields.find((x) => x.internal === c.field)
    const s = f && clauseToOData(c, f)
    if (s) parts.push(s)
  }
  return parts.join(' and ')
}

/** Folder view sorting: folders first, then the chosen sort (default: name). Whole folder is in memory, so this is instant. */
export function sortFolderRows(rows: Row[], q: Query, fields: SpField[]): Row[] {
  const sorted = sortRows(rows, q.sort.field === 'ID' && q.sort.dir === 'desc' ? { ...q, sort: { field: 'FileLeafRef', dir: 'asc' }, search: '' } : { ...q, search: '' }, fields, true)
  return [...sorted.filter((r) => r.FSObjType === 1), ...sorted.filter((r) => r.FSObjType !== 1)]
}
