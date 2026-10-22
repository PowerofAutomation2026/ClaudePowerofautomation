import { useEffect, useRef, useState } from 'react'
import { isEditable } from '../editable'
import type { Row, SpField } from '../types'
import { dateOnlyDay } from '../util'

export type Move = 'down' | 'right' | 'left' | 'stay'
const INLINE = new Set(['text', 'number', 'currency', 'date', 'boolean', 'choice'])

/** Cells that can be edited right in the grid (everything else opens the full form). */
export const canInline = (f: SpField, row: Row, isLibrary: boolean) =>
  (f.internal === 'FileLeafRef' ? true : isEditable(f) && INLINE.has(f.kind)) && !(isLibrary && row.FSObjType === 1 && f.internal !== 'FileLeafRef')

const toInput = (f: SpField, row: Row): string => {
  const v = row[f.internal]
  if (v == null || v === '') return ''
  if (f.kind === 'date') return f.dateOnly ? dateOnlyDay(String(v)) : String(v).slice(0, 10)
  if (f.kind === 'boolean') return v === true || v === 'true' || v === 'Yes' ? 'true' : 'false'
  if (f.percent && f.kind === 'number') return String(Math.round(Number(v) * 100))
  return String(v)
}

/** Validate typed text and turn it into the value the backend expects. */
export function parseCell(f: SpField, raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const v = raw.trim()
  if (v === '' && f.required) return { ok: false, error: `${f.title} is required` }
  if (v === '') return { ok: true, value: f.kind === 'boolean' ? null : '' }
  switch (f.kind) {
    case 'number': case 'currency': { const n = Number(v.replace(/[$,\s%]/g, '')); return isNaN(n) ? { ok: false, error: 'Enter a number' } : { ok: true, value: n } }
    case 'boolean': return { ok: true, value: v === 'true' }
    case 'choice': return f.choices?.length && !f.choices.includes(v) ? { ok: false, error: 'Pick one of the choices' } : { ok: true, value: v }
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(v) ? { ok: true, value: v } : { ok: false, error: 'Enter a valid date' }
    default: return { ok: true, value: v }
  }
}

export function CellEditor({ f, row, label, onCommit, onCancel }: { f: SpField; row: Row; label: string; onCommit: (value: unknown, move: Move) => void; onCancel: () => void }) {
  const [v, setV] = useState(toInput(f, row))
  const [err, setErr] = useState('')
  const ref = useRef<HTMLInputElement & HTMLSelectElement>(null)
  const done = useRef(false)
  useEffect(() => { ref.current?.focus(); ref.current?.select?.() }, [])
  const commit = (move: Move, val = v) => {
    if (done.current) return
    const r = parseCell(f, val)
    if (!r.ok) { setErr(r.error); return }
    done.current = true; onCommit(f.percent && typeof r.value === 'number' ? r.value : r.value, move)
  }
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done.current = true; onCancel() }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit('down') }
    else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); commit(e.shiftKey ? 'left' : 'right') }
  }
  const common = { ref, 'aria-label': label, 'aria-invalid': !!err, onKeyDown: key, className: 'cell-input', onClick: (e: React.MouseEvent) => e.stopPropagation() }
  return (
    <span className="cell-edit" onClick={(e) => e.stopPropagation()}>
      {f.kind === 'choice' && f.choices?.length
        ? <select {...common} value={v} onChange={(e) => { setV(e.target.value); setTimeout(() => commit('stay', e.target.value), 0) }} onBlur={() => commit('stay')}><option value="">—</option>{f.choices.map((c) => <option key={c}>{c}</option>)}</select>
        : f.kind === 'boolean'
          ? <select {...common} value={v} onChange={(e) => { setV(e.target.value); setTimeout(() => commit('stay', e.target.value), 0) }} onBlur={() => commit('stay')}><option value="">—</option><option value="true">Yes</option><option value="false">No</option></select>
          : <input {...common} value={v} onChange={(e) => { setV(e.target.value); setErr('') }} onBlur={() => commit('stay')} type={f.kind === 'date' ? 'date' : 'text'} inputMode={f.kind === 'number' || f.kind === 'currency' ? 'decimal' : undefined} />}
      {err && <span role="alert" className="cell-err">{err}</span>}
    </span>
  )
}
