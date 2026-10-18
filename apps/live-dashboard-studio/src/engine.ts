/**
 * Data engine: parse any tabular input, detect column types, aggregate, and auto-build a dashboard.
 * Pure TypeScript (no React, no DOM) so it can be unit-tested with plain Node.
 */

export type ColType = 'number' | 'date' | 'text'
export type Cell = string | number | null
export type Row = Record<string, Cell>
export type Agg = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'distinct'
export type Grain = 'day' | 'week' | 'month' | 'year'
export type WidgetType = 'kpi' | 'bar' | 'line' | 'donut' | 'table'

export interface Column { name: string; type: ColType; distinct: number; blanks: number }
export interface Dataset { id: string; name: string; columns: Column[]; rows: Row[]; loadedAt: number; truncatedFrom?: number }

export interface Widget {
  id: string
  type: WidgetType
  title: string
  dim?: string          // category or date column
  measure?: string      // number column (or any column for distinct)
  agg: Agg
  grain?: Grain         // line charts: omit = automatic
  topN: number
  sort: 'value' | 'label'
  span: 1 | 2
}
export interface Filter { col: string; values: string[] }
export interface DateRange { col: string; days: number }   // last N days of the data (0 = all)
export interface Point { label: string; value: number; n: number }

export const MAX_ROWS = 200_000          // rows kept in the browser; more are cut and the app says so
export const MAX_SAVED_ROWS = 100_000    // larger datasets are not saved in this browser (avoids a long freeze)

/* ------------------------------------------------------------------ parsing */

export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 5).join('\n')
  const counts = [',', '\t', ';', '|'].map((d) => [d, sample.split(d).length - 1] as const)
  counts.sort((a, b) => b[1] - a[1])
  return counts[0][1] > 0 ? counts[0][0] : ','
}

export function parseDelimited(text: string, delim?: string): string[][] {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const d = delim ?? detectDelimiter(t)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let q = false
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { field += '"'; i++ } else q = false } else field += c
    } else if (c === '"' && field === '') q = true
    else if (c === d) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++
      row.push(field); field = ''; rows.push(row); row = []
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((v) => v.trim() !== ''))
}

/** JSON: array of objects, array of arrays (first row = header), or { data | rows | value | items: [...] }. */
export function parseJsonRows(text: string): unknown[][] | Record<string, unknown>[] {
  let j: unknown = JSON.parse(text)
  if (j && !Array.isArray(j) && typeof j === 'object') {
    const o = j as Record<string, unknown>
    const key = ['data', 'rows', 'value', 'items', 'records', 'results'].find((k) => Array.isArray(o[k]))
    if (key) j = o[key]
  }
  if (!Array.isArray(j)) throw new Error('JSON must be an array of rows (or an object holding one in data / rows / value / items).')
  if (j.length && Array.isArray(j[0])) return j as unknown[][]
  return j.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]
}

const CURRENCY = /[$€£¥₹]/g

export function parseNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  let s = v.trim()
  if (s === '') return null
  let neg = false
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1) }
  s = s.replace(CURRENCY, '').replace(/\s/g, '').replace(/%$/, '')
  if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '')
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return neg ? -n : n
}

const pad = (n: number) => String(n).padStart(2, '0')
const validYmd = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/** Returns 'YYYY-MM-DD' or null. Accepts ISO (with or without time), M/D/YYYY (D/M/YYYY when the first part > 12), and Date objects. */
export function parseDate(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`
  if (typeof v !== 'string') return null
  const s = v.trim()
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s)
  if (m && validYmd(+m[1], +m[2], +m[3])) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[T ].*)?$/.exec(s)
  if (m) {
    let a = +m[1], b = +m[2]
    if (a > 12) [a, b] = [b, a]
    if (validYmd(+m[3], a, b)) return `${m[3]}-${pad(a)}-${pad(b)}`
  }
  return null
}

const blank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
const ID_LIKE_WORD = /(^|[\s_.-])(id|uuid|guid|zip|zipcode|postal|phone|sku|code|number|no)$/i
const ID_LIKE_CAMEL = /[a-z](Id|ID|Code|Number|Sku|SKU)$/
const idLike = (name: string) => ID_LIKE_WORD.test(name) || ID_LIKE_CAMEL.test(name)

function cleanHeaders(raw: unknown[]): string[] {
  const seen = new Map<string, number>()
  return raw.map((h, i) => {
    let name = blank(h) ? `Column ${i + 1}` : String(h).trim()
    const k = name.toLowerCase()
    const n = (seen.get(k) ?? 0) + 1
    seen.set(k, n)
    if (n > 1) name = `${name} (${n})`
    return name
  })
}

function inferColumn(name: string, values: unknown[]): { type: ColType; distinct: number; blanks: number } {
  const filled = values.filter((v) => !blank(v))
  const blanks = values.length - filled.length
  const distinct = new Set(filled.map((v) => String(v))).size
  if (filled.length === 0) return { type: 'text', distinct, blanks }
  const need = Math.ceil(filled.length * 0.95)
  const nums = filled.filter((v) => parseNumber(v) !== null).length
  const dates = filled.filter((v) => parseDate(v) !== null).length
  if (dates >= need && nums < need) return { type: 'date', distinct, blanks }
  if (nums >= need) {
    const allInt = filled.every((v) => Number.isInteger(parseNumber(v)))
    if (idLike(name) && allInt && distinct >= filled.length * 0.9) return { type: 'text', distinct, blanks }
    return { type: 'number', distinct, blanks }
  }
  return { type: 'text', distinct, blanks }
}

let idCounter = 0
export const uid = (p = 'id') => `${p}_${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** Build a typed dataset from objects (one per row). Column order = first appearance. */
export function fromObjects(name: string, objs: Record<string, unknown>[], id = uid('ds')): Dataset {
  if (objs.length === 0) throw new Error('No rows found.')
  const keys: string[] = []
  const seen = new Set<string>()
  for (const o of objs.slice(0, 500)) for (const k of Object.keys(o)) if (!seen.has(k)) { seen.add(k); keys.push(k) }
  const heads = cleanHeaders(keys)
  const matrix = objs.slice(0, MAX_ROWS).map((o) => keys.map((k) => o[k]))
  return buildDataset(name, heads, matrix, id, objs.length)
}

/** Build a typed dataset from a matrix whose first row is the header. */
export function fromMatrix(name: string, matrix: unknown[][], id = uid('ds')): Dataset {
  if (matrix.length < 2) throw new Error('The data has only a header row or no rows.')
  const heads = cleanHeaders(matrix[0])
  return buildDataset(name, heads, matrix.slice(1, MAX_ROWS + 1), id, matrix.length - 1)
}

function makeRow(columns: Column[], r: unknown[]): Row {
  const o: Row = {}
  for (let c = 0; c < columns.length; c++) {
    const col = columns[c]
    const v = r[c]
    if (blank(v)) o[col.name] = null
    else if (col.type === 'number') o[col.name] = parseNumber(v)
    else if (col.type === 'date') o[col.name] = parseDate(v)
    else o[col.name] = typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v instanceof Date ? (parseDate(v) ?? String(v)) : String(v)
  }
  return o
}

function finish(name: string, columns: Column[], rows: Row[], id: string, totalRows: number): Dataset {
  const ds: Dataset = { id, name, columns, rows, loadedAt: Date.now() }
  if (totalRows > rows.length) ds.truncatedFrom = totalRows
  return ds
}

function buildDataset(name: string, heads: string[], body: unknown[][], id: string, totalRows = body.length): Dataset {
  const columns: Column[] = heads.map((h, c) => ({ name: h, ...inferColumn(h, body.map((r) => r[c])) }))
  return finish(name, columns, body.map((r) => makeRow(columns, r)), id, totalRows)
}

/* ---- the same work in slices that let the page breathe (no frozen UI on big files) ---- */

export type Progress = (fraction: number, message: string) => void
const yieldToUi = () => new Promise<void>((res) => setTimeout(res, 0))

export async function parseDelimitedAsync(text: string, delim?: string, onProgress?: Progress): Promise<string[][]> {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const d = delim ?? detectDelimiter(t)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let q = false
  const SLICE = 500_000
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { field += '"'; i++ } else q = false } else field += c
    } else if (c === '"' && field === '') q = true
    else if (c === d) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++
      row.push(field); field = ''; rows.push(row); row = []
    } else field += c
    if (i % SLICE === SLICE - 1) { onProgress?.(0.05 + 0.4 * (i / t.length), `Reading rows… ${rows.length.toLocaleString()}`); await yieldToUi() }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((v) => v.trim() !== ''))
}

export async function fromMatrixAsync(name: string, matrix: unknown[][], onProgress?: Progress, id = uid('ds')): Promise<Dataset> {
  if (matrix.length < 2) throw new Error('The data has only a header row or no rows.')
  const heads = cleanHeaders(matrix[0])
  const body = matrix.slice(1, MAX_ROWS + 1)
  const columns: Column[] = []
  for (let c = 0; c < heads.length; c++) {
    columns.push({ name: heads[c], ...inferColumn(heads[c], body.map((r) => r[c])) })
    onProgress?.(0.45 + 0.25 * ((c + 1) / heads.length), `Detecting column types… ${c + 1} of ${heads.length}`)
    await yieldToUi()
  }
  const rows: Row[] = new Array(body.length)
  const STEP = 20_000
  for (let i = 0; i < body.length; i += STEP) {
    const end = Math.min(i + STEP, body.length)
    for (let k = i; k < end; k++) rows[k] = makeRow(columns, body[k])
    onProgress?.(0.7 + 0.3 * (end / body.length), `Building ${end.toLocaleString()} of ${body.length.toLocaleString()} rows`)
    await yieldToUi()
  }
  return finish(name, columns, rows, id, matrix.length - 1)
}

export async function fromObjectsAsync(name: string, objs: Record<string, unknown>[], id = uid('ds'), onProgress?: Progress): Promise<Dataset> {
  if (objs.length === 0) throw new Error('No rows found.')
  const keys: string[] = []
  const seen = new Set<string>()
  for (const o of objs.slice(0, 500)) for (const k of Object.keys(o)) if (!seen.has(k)) { seen.add(k); keys.push(k) }
  const heads = cleanHeaders(keys)
  const d = await fromMatrixAsync(name, [heads, ...objs.slice(0, MAX_ROWS + 1).map((o) => keys.map((k) => o[k]))], onProgress, id)
  if (objs.length > MAX_ROWS) d.truncatedFrom = objs.length
  return d
}

export async function datasetFromTextAsync(name: string, text: string, onProgress?: Progress): Promise<Dataset> {
  const t = text.trim()
  if (t.startsWith('[') || t.startsWith('{')) {
    onProgress?.(0.2, 'Reading JSON…')
    await yieldToUi()
    const parsed = parseJsonRows(t)
    if (parsed.length && Array.isArray(parsed[0])) return fromMatrixAsync(name, parsed as unknown[][], onProgress)
    return fromObjectsAsync(name, parsed as Record<string, unknown>[], uid('ds'), onProgress)
  }
  const matrix = await parseDelimitedAsync(t, undefined, onProgress)
  return fromMatrixAsync(name, matrix, onProgress)
}

export function datasetFromText(name: string, text: string): Dataset {
  const t = text.trim()
  if (t.startsWith('[') || t.startsWith('{')) {
    const parsed = parseJsonRows(t)
    return parsed.length && Array.isArray(parsed[0]) ? fromMatrix(name, parsed as unknown[][]) : fromObjects(name, parsed as Record<string, unknown>[])
  }
  return fromMatrix(name, parseDelimited(t))
}

export function datasetToCsv(ds: Dataset): string {
  const cell = (v: Cell) => { const s = v === null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
  return [ds.columns.map((c) => cell(c.name)).join(',')].concat(ds.rows.map((r) => ds.columns.map((c) => cell(r[c.name])).join(','))).join('\n')
}

/* ------------------------------------------------------------- aggregation */

const OTHER = 'Other'
const BLANK = '(blank)'

export function weekStart(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  const dow = (dt.getUTCDay() + 6) % 7   // Monday = 0
  dt.setUTCDate(dt.getUTCDate() - dow)
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

export function bucket(iso: string, grain: Grain): string {
  if (grain === 'year') return iso.slice(0, 4)
  if (grain === 'month') return iso.slice(0, 7)
  if (grain === 'week') return weekStart(iso)
  return iso
}

export function dateSpanDays(ds: Dataset, col: string): number {
  let lo = '', hi = ''
  for (const r of ds.rows) { const v = r[col]; if (typeof v !== 'string') continue; if (!lo || v < lo) lo = v; if (!hi || v > hi) hi = v }
  if (!lo) return 0
  return Math.round((Date.parse(hi) - Date.parse(lo)) / 86400000) + 1
}

export function autoGrain(ds: Dataset, col: string): Grain {
  const span = dateSpanDays(ds, col)
  if (span <= 62) return 'day'
  if (span <= 240) return 'week'
  if (span <= 1100) return 'month'
  return 'year'
}

export function maxDate(ds: Dataset, col: string): string | null {
  let hi: string | null = null
  for (const r of ds.rows) { const v = r[col]; if (typeof v === 'string' && (!hi || v > hi)) hi = v }
  return hi
}

export function applyFilters(ds: Dataset, filters: Filter[], range?: DateRange | null): Row[] {
  let rows = ds.rows
  if (range && range.days > 0) {
    const hi = maxDate(ds, range.col)
    if (hi) {
      const lo = new Date(Date.parse(hi) - (range.days - 1) * 86400000).toISOString().slice(0, 10)
      rows = rows.filter((r) => { const v = r[range.col]; return typeof v === 'string' && v >= lo })
    }
  }
  for (const f of filters) {
    if (!f.values.length) continue
    const set = new Set(f.values)
    rows = rows.filter((r) => set.has(r[f.col] === null || r[f.col] === undefined ? BLANK : String(r[f.col])))
  }
  return rows
}

function reduce(agg: Agg, vals: number[], n: number, distinctVals?: Set<string>): number {
  switch (agg) {
    case 'sum': return vals.reduce((a, b) => a + b, 0)
    case 'avg': return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
    case 'min': return vals.length ? Math.min(...vals) : 0
    case 'max': return vals.length ? Math.max(...vals) : 0
    case 'distinct': return distinctVals ? distinctVals.size : 0
    default: return n
  }
}

interface Acc { vals: number[]; n: number; d: Set<string> }
const newAcc = (): Acc => ({ vals: [], n: 0, d: new Set() })
function feed(a: Acc, r: Row, measure: string | undefined, agg: Agg) {
  a.n++
  if (!measure) return
  const v = r[measure]
  if (v === null || v === undefined) return
  if (agg === 'distinct') a.d.add(String(v)); else if (typeof v === 'number') a.vals.push(v)
}

/** One number over all rows (KPI). */
export function kpiValue(rows: Row[], w: Pick<Widget, 'measure' | 'agg'>): number {
  const a = newAcc()
  for (const r of rows) feed(a, r, w.measure, w.agg)
  return reduce(w.agg, a.vals, a.n, a.d)
}

/** Grouped series for bar / donut / line / table-less charts. */
export function series(ds: Dataset, rows: Row[], w: Widget): Point[] {
  if (!w.dim) return []
  const dimCol = ds.columns.find((c) => c.name === w.dim)
  if (!dimCol) return []
  const grain = dimCol.type === 'date' ? (w.grain ?? autoGrain(ds, w.dim)) : undefined
  const groups = new Map<string, Acc>()
  for (const r of rows) {
    const raw = r[w.dim]
    const label = raw === null || raw === undefined ? BLANK : grain ? bucket(String(raw), grain) : String(raw)
    let a = groups.get(label)
    if (!a) { a = newAcc(); groups.set(label, a) }
    feed(a, r, w.measure, w.agg)
  }
  let pts: Point[] = [...groups.entries()].map(([label, a]) => ({ label, value: reduce(w.agg, a.vals, a.n, a.d), n: a.n }))
  if (dimCol.type === 'date') return pts.sort((x, y) => (x.label < y.label ? -1 : 1))
  pts.sort(w.sort === 'label' ? (x, y) => x.label.localeCompare(y.label) : (x, y) => y.value - x.value)
  if (pts.length > w.topN) {
    const keep = pts.slice(0, w.topN)
    const rest = pts.slice(w.topN)
    if (w.agg === 'sum' || w.agg === 'count') keep.push({ label: OTHER, value: rest.reduce((s, p) => s + p.value, 0), n: rest.reduce((s, p) => s + p.n, 0) })
    pts = keep
  }
  return pts
}

/* --------------------------------------------------------- auto dashboard */

const PERSON_DIM = /(assigned to|closed by|resolved by|opened by|owner|agent|engineer|member|analyst|technician)/i
const KEY_DIM = /(group|team|priority|category|status|state|department|region|product|channel|type|service)/i
const AVG_LIKE = /(rate|pct|percent|%|ratio|avg|average|price|score|margin|temp|age|time|duration|elapsed)/i

export function widgetIssue(ds: Dataset, w: Widget): string | null {
  const has = (n?: string) => !n || ds.columns.some((c) => c.name === n)
  if (!has(w.dim)) return `Column "${w.dim}" is not in the data any more`
  if (!has(w.measure)) return `Column "${w.measure}" is not in the data any more`
  const m = w.measure ? ds.columns.find((c) => c.name === w.measure) : undefined
  if (m && m.type !== 'number' && w.agg !== 'count' && w.agg !== 'distinct') return `"${m.name}" is not a number column`
  return null
}

export function defaultWidget(type: WidgetType, ds: Dataset): Widget {
  const nums = ds.columns.filter((c) => c.type === 'number')
  const cats = ds.columns.filter((c) => c.type === 'text')
  const dates = ds.columns.filter((c) => c.type === 'date')
  const m = nums[0]?.name
  const base: Widget = { id: uid('w'), type, title: '', agg: m ? 'sum' : 'count', measure: m, topN: 8, sort: 'value', span: 1 }
  if (type === 'kpi') return { ...base, title: m ? `Total ${m}` : 'Rows' }
  if (type === 'line') { const d = dates[0]?.name ?? cats[0]?.name; return { ...base, dim: d, span: 2, title: `${m ?? 'Rows'} over ${d ?? 'time'}` } }
  if (type === 'table') return { ...base, span: 2, title: 'Data', agg: 'count', measure: undefined }
  const d = cats[0]?.name
  return { ...base, dim: d, title: `${m ?? 'Rows'} by ${d ?? 'category'}`, topN: type === 'donut' ? 5 : 8 }
}

export function autoDashboard(ds: Dataset): Widget[] {
  const out: Widget[] = []
  const minDistinct = ds.rows.length >= 30 ? 6 : 2          // skip near-constant numbers (flags, targets with 3-4 values) as KPI measures
  const nums = ds.columns.filter((c) => c.type === 'number' && c.distinct >= minDistinct)
  const dates = ds.columns.filter((c) => c.type === 'date')
  const rowsN = ds.rows.length
  const cats = ds.columns
    .filter((c) => c.type === 'text' && c.distinct >= 2 && c.distinct <= 30 && (c.distinct <= 12 || c.distinct <= rowsN * 0.5))
    .sort((a, b) => tier(a) - tier(b) || a.distinct - b.distinct)   // people first, then key dimensions, then the rest; yes/no flags last
  function tier(c: Column): number { return c.distinct === 2 ? 3 : PERSON_DIM.test(c.name) ? 0 : KEY_DIM.test(c.name) ? 1 : 2 }
  const aggFor = (name: string): Agg => (AVG_LIKE.test(name) ? 'avg' : 'sum')
  const mk = (p: Partial<Widget> & Pick<Widget, 'type' | 'title'>): Widget => ({ id: uid('w'), agg: 'count', topN: 8, sort: 'value', span: 1, ...p })

  out.push(mk({ type: 'kpi', title: 'Rows', agg: 'count' }))
  nums.slice(0, 3).forEach((c) => out.push(mk({ type: 'kpi', title: `${aggFor(c.name) === 'avg' ? 'Average' : 'Total'} ${c.name}`, measure: c.name, agg: aggFor(c.name) })))
  if (dates[0] && nums[0]) out.push(mk({ type: 'line', title: `${nums[0].name} over ${dates[0].name}`, dim: dates[0].name, measure: nums[0].name, agg: aggFor(nums[0].name), span: 2 }))
  let personChart = false
  const barCols = cats.filter((c) => { if (tier(c) === 0) { if (personChart) return false; personChart = true } return true }).slice(0, 2)
  barCols.forEach((c, i) => {
    const m = nums[i % Math.max(nums.length, 1)]
    out.push(mk({ type: 'bar', title: m ? `${m.name} by ${c.name}` : `Rows by ${c.name}`, dim: c.name, measure: m?.name, agg: m ? aggFor(m.name) : 'count', topN: 10 }))
  })
  const pie = cats.find((c) => c.distinct <= 6 && !out.some((w) => w.type === 'bar' && w.dim === c.name)) ?? (cats[0] && cats[0].distinct <= 6 ? cats[0] : undefined)
  if (pie) out.push(mk({ type: 'donut', title: `${nums[0] ? nums[0].name : 'Rows'} share by ${pie.name}`, dim: pie.name, measure: nums[0]?.name, agg: nums[0] ? 'sum' : 'count', topN: 5 }))
  out.push(mk({ type: 'table', title: 'Data', span: 2 }))
  return out
}

/** Re-use the old widgets after the data was replaced; drop the ones whose columns vanished only if nothing is left. */
export function compareDatasets(prev: Dataset | null, next: Dataset) {
  const prevCols = new Set((prev?.columns ?? []).map((c) => c.name))
  const nextCols = new Set(next.columns.map((c) => c.name))
  return {
    rowDelta: next.rows.length - (prev?.rows.length ?? 0),
    added: [...nextCols].filter((c) => !prevCols.has(c)),
    removed: [...prevCols].filter((c) => !nextCols.has(c)),
  }
}

/* ----------------------------------------------------------------- format */

export function formatNumber(n: number, compact = true): string {
  if (!Number.isFinite(n)) return '–'
  const abs = Math.abs(n)
  if (compact && abs >= 10000) return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: abs >= 1e6 || abs < 100000 ? 1 : 0 }).format(n)
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: abs < 10 ? 2 : abs < 1000 ? 1 : 0 }).format(n)
}

/* -------------------------------------------------------- simulated source */

const REGIONS = ['North', 'South', 'East', 'West', 'Central']
const PRODUCTS = ['Widget', 'Gadget', 'Gizmo', 'Doohickey']
const CHANNELS = ['Online', 'Retail', 'Partner']

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) }

/** Deterministic sample "orders" for demos and tests. `count` rows ending today. */
export function makeDemoOrders(count: number, seed = 7, endDate = new Date()): Record<string, unknown>[] {
  const r = rng(seed)
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < count; i++) {
    const daysAgo = Math.floor((1 - i / count) * 120)
    const d = new Date(endDate.getTime() - daysAgo * 86400000)
    const units = 1 + Math.floor(r() * 12)
    const price = 10 + Math.floor(r() * 4) * 15
    rows.push({
      OrderId: 1000 + i, OrderDate: d.toISOString().slice(0, 10),
      Region: REGIONS[Math.floor(r() * REGIONS.length)], Product: PRODUCTS[Math.floor(r() * PRODUCTS.length)],
      Channel: CHANNELS[Math.floor(r() * CHANNELS.length)], Units: units, UnitPrice: price, Revenue: units * price,
    })
  }
  return rows
}
