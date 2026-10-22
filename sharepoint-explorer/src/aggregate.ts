/**
 * Streaming aggregation: rows go in page by page, only small counters stay in memory. That is what lets the dashboard
 * "deep scan" a multi-million-row list without keeping the rows, and why it never blocks the UI (the caller yields).
 */
import type { Row, SpField } from './types'
import { cellText, fmt, bytes } from './util'

export interface FieldStat {
  field: SpField
  n: number
  missing: number
  counts: Map<string, number>
  overflow: boolean
  sum: number
  min: number
  max: number
}

const CAT_CAP = 3000
const DAY = 86_400_000
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10)

export class Aggregator {
  rows = 0
  stats = new Map<string, FieldStat>()
  created = new Map<string, number>()
  modified = new Map<string, number>()
  last7 = 0; prev7 = 0; last30 = 0; stale = 0
  titles = new Map<string, number>()
  dupes = 0
  ext = new Map<string, { count: number; bytes: number }>()
  big: { name: string; size: number }[] = []
  totalBytes = 0
  firstCreated = Infinity
  lastModified = 0

  constructor(readonly fields: SpField[], readonly isLibrary: boolean) {
    for (const f of fields) this.stats.set(f.internal, { field: f, n: 0, missing: 0, counts: new Map(), overflow: false, sum: 0, min: Infinity, max: -Infinity })
  }

  add(rows: Row[]) {
    const now = Date.now()
    const titleKey = this.isLibrary ? 'FileLeafRef' : 'Title'
    for (const r of rows) {
      this.rows++
      for (const s of this.stats.values()) {
        const f = s.field
        const v = r[f.internal]
        if (v == null || v === '' || (Array.isArray(v) && !v.length)) { s.missing++; continue }
        s.n++
        if (f.kind === 'number' || f.kind === 'currency') {
          const x = Number(v)
          if (!isNaN(x)) { s.sum += x; if (x < s.min) s.min = x; if (x > s.max) s.max = x }
        } else if (f.kind === 'date') {
          const t = Date.parse(String(v)); if (!isNaN(t)) { if (t < s.min) s.min = t; if (t > s.max) s.max = t }
        } else if (f.kind !== 'note' && f.kind !== 'url' && f.kind !== 'counter') {
          const keys = Array.isArray(v) ? v : f.kind === 'user' || f.kind === 'lookup' ? String(v).split('; ') : [f.kind === 'boolean' ? cellText(f, r) : String(v)]
          for (const k of keys) {
            const c = s.counts.get(k)
            if (c != null) s.counts.set(k, c + 1)
            else if (s.counts.size < CAT_CAP) s.counts.set(k, 1)
            else s.overflow = true
          }
        }
      }
      const c = Date.parse(String(r.Created)); const m = Date.parse(String(r.Modified))
      if (!isNaN(c)) {
        const k = dayKey(c); this.created.set(k, (this.created.get(k) ?? 0) + 1)
        const age = now - c
        if (age <= 7 * DAY) this.last7++; else if (age <= 14 * DAY) this.prev7++
        if (age <= 30 * DAY) this.last30++
        if (c < this.firstCreated) this.firstCreated = c
      }
      if (!isNaN(m)) {
        const k = dayKey(m); this.modified.set(k, (this.modified.get(k) ?? 0) + 1)
        if (now - m > 365 * DAY) this.stale++
        if (m > this.lastModified) this.lastModified = m
      }
      const t = r[titleKey]
      if (t) {
        const key = String(t).toLowerCase()
        const n = this.titles.get(key)
        if (n != null) { this.titles.set(key, n + 1); if (n === 1) this.dupes++ }
        else if (this.titles.size < 400_000) this.titles.set(key, 1)
      }
      if (this.isLibrary) {
        const e = String(r.File_x0020_Type ?? String(r.FileLeafRef ?? '').split('.').pop() ?? '').toLowerCase() || 'none'
        const size = Number(r.File_x0020_Size) || 0
        const x = this.ext.get(e) ?? { count: 0, bytes: 0 }
        x.count++; x.bytes += size; this.ext.set(e, x)
        this.totalBytes += size
        if (size && (this.big.length < 10 || size > this.big[this.big.length - 1].size)) {
          this.big.push({ name: String(r.FileLeafRef ?? r.__id), size }); this.big.sort((a, b) => b.size - a.size); this.big.length = Math.min(this.big.length, 10)
        }
      }
    }
  }

  /** items created per day for the last `days` days (oldest first), for sparklines */
  recent(days = 14): number[] {
    const out: number[] = []
    for (let i = days - 1; i >= 0; i--) out.push(this.created.get(dayKey(Date.now() - i * DAY)) ?? 0)
    return out
  }

  top(internal: string, n = 8): { label: string; value: number }[] {
    const s = this.stats.get(internal)
    if (!s) return []
    const all = [...s.counts.entries()].sort((a, b) => b[1] - a[1])
    const head = all.slice(0, n).map(([label, value]) => ({ label, value }))
    const rest = all.slice(n).reduce((a, [, v]) => a + v, 0)
    if (rest > 0) head.push({ label: 'Other', value: rest })
    return head
  }

  /** Items created per bucket, ready for a timeline. Chooses days for short spans, months for long ones. */
  timeline(source: 'created' | 'modified' = 'created'): { label: string; value: number }[] {
    const map = source === 'created' ? this.created : this.modified
    if (!map.size) return []
    const keys = [...map.keys()].sort()
    const span = (Date.parse(keys[keys.length - 1]) - Date.parse(keys[0])) / DAY
    const bucket = span <= 75 ? (k: string) => k : span <= 1500 ? (k: string) => k.slice(0, 7) : (k: string) => k.slice(0, 4)
    const out = new Map<string, number>()
    for (const k of keys) out.set(bucket(k), (out.get(bucket(k)) ?? 0) + map.get(k)!)
    return [...out.entries()].map(([label, value]) => ({ label, value }))
  }
}

export interface Insight { level: 'good' | 'warn' | 'info'; text: string }

export function insights(a: Aggregator, total: number, scope: string): Insight[] {
  const out: Insight[] = []
  if (!a.rows) return out
  const pct = (x: number, of = a.rows) => `${Math.round((x / Math.max(1, of)) * 100)}%`
  out.push({ level: 'info', text: `Based on ${fmt(a.rows)} ${a.rows === 1 ? 'item' : 'items'} (${scope}).` })
  if (a.last7 + a.prev7 > 0) {
    const d = a.last7 - a.prev7
    out.push({ level: d >= 0 ? 'good' : 'info', text: `${fmt(a.last7)} new in the last 7 days — ${d === 0 ? 'same as' : d > 0 ? `${pct(d, Math.max(1, a.prev7))} more than` : `${pct(-d, Math.max(1, a.prev7))} fewer than`} the week before.` })
  }
  for (const s of a.stats.values()) {
    const k = s.field.kind
    if (k === 'choice' && s.counts.size > 1 && !s.overflow) {
      const [label, v] = [...s.counts.entries()].sort((x, y) => y[1] - x[1])[0]
      if (v / Math.max(1, s.n) >= 0.4) out.push({ level: 'info', text: `${s.field.title}: “${label}” makes up ${pct(v, s.n)} of items.` })
    }
    if (k === 'boolean') {
      const t = s.counts.get('Yes') ?? 0
      if (t && /block|overdue|urgent|flag|escalat/i.test(s.field.title + s.field.internal)) out.push({ level: 'warn', text: `${fmt(t)} items are flagged “${s.field.title}” (${pct(t, s.n)}).` })
    }
    if (s.missing / Math.max(1, s.n + s.missing) > 0.3 && s.field.required !== false && !s.field.system) out.push({ level: 'warn', text: `${s.field.title} is empty on ${pct(s.missing)} of items — consider making it required.` })
  }
  if (a.stale / a.rows > 0.25) out.push({ level: 'warn', text: `${pct(a.stale)} of items haven’t been touched in over a year — a candidate for archiving.` })
  if (a.dupes > 0) out.push({ level: 'warn', text: `${fmt(a.dupes)} ${a.isLibrary ? 'file names' : 'titles'} appear more than once.` })
  if (a.isLibrary && a.ext.size) {
    const e = [...a.ext.entries()].sort((x, y) => y[1].bytes - x[1].bytes)[0]
    out.push({ level: 'info', text: `.${e[0]} files use the most space: ${bytes(e[1].bytes)} of ${bytes(a.totalBytes)}.` })
  }
  for (const s of a.stats.values()) {
    if ((s.field.kind === 'currency' || s.field.kind === 'number') && s.n > 0 && s.sum > 0 && s.field.internal !== 'File_x0020_Size' && s.field.internal !== 'ID') {
      out.push({ level: 'info', text: `${s.field.title}: total ${fmt(Math.round(s.sum))}, average ${fmt(Math.round(s.sum / s.n))}.` }); break
    }
  }
  if (total > 100_000) out.push({ level: 'info', text: `This is a large list (${fmt(total)} items). Search and filters run on the server; index the columns you filter by for instant results.` })
  return out
}
