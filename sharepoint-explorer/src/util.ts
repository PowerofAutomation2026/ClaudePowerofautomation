import type { Row, SpField } from './types'

export const nf = new Intl.NumberFormat()
export const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
export const fmt = (n: number | null | undefined) => (n == null ? '—' : nf.format(n))
export const cmp = (n: number | null | undefined) => (n == null ? '—' : compact.format(n))

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
/** Give the browser a chance to paint / handle input between heavy chunks. */
export const yieldToUi = () =>
  new Promise<void>((r) => {
    const w = globalThis as any
    if (w.scheduler?.yield) w.scheduler.yield().then(r)
    else setTimeout(r, 0)
  })

export function bytes(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`
}

export function relTime(iso?: string | null): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (isNaN(t)) return String(iso)
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60); if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24); if (d < 30) return `${d} d ago`
  const mo = Math.round(d / 30); if (mo < 12) return `${mo} mo ago`
  return `${Math.round(mo / 12)} y ago`
}

export const fmtDate = (iso?: string | null, withTime = false) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(+d)) return String(iso)
  return withTime ? d.toLocaleString() : d.toLocaleDateString()
}

/** Display text of one cell. Same function feeds the grid, search, CSV and PDF so they always agree. */
export function cellText(f: SpField, row: Row): string {
  const v = row[f.internal]
  if (v == null || v === '') return ''
  switch (f.kind) {
    case 'date': return fmtDate(String(v), /time|modified|created/i.test(f.internal) ? true : false)
    case 'boolean': return v === true || v === 'true' || v === 1 ? 'Yes' : 'No'
    case 'currency': return typeof v === 'number' ? v.toLocaleString(undefined, { style: 'currency', currency: 'USD' }) : String(v)
    case 'number': return typeof v === 'number' ? (f.internal === 'File_x0020_Size' ? bytes(v) : nf.format(v)) : String(v)
    case 'multichoice': return Array.isArray(v) ? v.join('; ') : String(v)
    case 'url': return typeof v === 'object' ? String(v.Url ?? v.Description ?? '') : String(v)
    default: return Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? String(v.Title ?? v.Label ?? JSON.stringify(v)) : String(v)
  }
}

/** Raw (unformatted) text for exports. */
export function rawText(f: SpField, row: Row): string {
  const v = row[f.internal]
  if (v == null) return ''
  if (f.kind === 'date' || f.kind === 'number' || f.kind === 'currency') return String(v)
  return cellText(f, row)
}

export const download = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export const safeName = (s: string) => s.replace(/[^\w\-. ]+/g, '_').trim().slice(0, 80) || 'export'

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined
  const d = (...a: A) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }
  d.cancel = () => clearTimeout(t)
  return d
}

export const lsGet = <T,>(k: string, def: T): T => {
  try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : def } catch { return def }
}
export const lsSet = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode / blocked */ } }

export const odataQuote = (s: string) => `'${s.replace(/'/g, "''")}'`
export const sameUser = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()
export const uid = () => Math.random().toString(36).slice(2, 10)
