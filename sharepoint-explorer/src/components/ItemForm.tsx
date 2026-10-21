import { useState } from 'react'
import { isEditable } from '../editable'
import type { Row, SpField } from '../types'

const toInput = (f: SpField, v: unknown) => (v == null ? '' : f.kind === 'date' ? String(v).slice(0, 10) : f.kind === 'boolean' ? (v === true || v === 'true' || v === 'Yes' ? 'true' : 'false') : String(v))

/** Create / edit form generated from the list's editable columns. Only changed values are returned when editing. */
export function ItemForm({ fields, row, onSubmit, onCancel, busy }: { fields: SpField[]; row: Row | null; onSubmit: (values: Record<string, unknown>) => void; onCancel: () => void; busy: boolean }) {
  const editable = fields.filter(isEditable)
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(editable.map((f) => [f.internal, toInput(f, row?.[f.internal])])))
  const [err, setErr] = useState<Record<string, string>>({})
  const set = (k: string, v: string) => { setVals((c) => ({ ...c, [k]: v })); setErr((c) => ({ ...c, [k]: '' })) }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const errors: Record<string, string> = {}, out: Record<string, unknown> = {}
    for (const f of editable) {
      const v = vals[f.internal] ?? ''
      if (f.required && v === '') errors[f.internal] = 'Required'
      if ((f.kind === 'number' || f.kind === 'currency') && v !== '' && isNaN(Number(v))) errors[f.internal] = 'Enter a number'
      if (row && v === toInput(f, row[f.internal])) continue
      out[f.internal] = f.kind === 'boolean' ? v === 'true' : v
    }
    setErr(errors)
    if (Object.keys(errors).length) return
    if (row && !Object.keys(out).length) { onCancel(); return }
    onSubmit(out)
  }

  return (
    <form onSubmit={submit} noValidate style={{ display: 'grid', gap: 12 }}>
      {editable.map((f) => {
        const id = `f-${f.internal}`, v = vals[f.internal] ?? ''
        const common = { id, 'aria-invalid': !!err[f.internal], 'aria-describedby': err[f.internal] ? `${id}-e` : undefined, className: 'input' }
        return (
          <label key={f.internal} className="field" htmlFor={id}>
            <span>{f.title}{f.required && <span aria-hidden="true" style={{ color: 'var(--bad)' }}> *</span>}</span>
            {f.kind === 'note' ? <textarea {...common} rows={4} value={v} onChange={(e) => set(f.internal, e.target.value)} />
              : f.kind === 'choice' ? <select {...common} value={v} onChange={(e) => set(f.internal, e.target.value)}><option value="">—</option>{(f.choices ?? []).map((c) => <option key={c}>{c}</option>)}</select>
              : f.kind === 'boolean' ? <select {...common} value={v} onChange={(e) => set(f.internal, e.target.value)}><option value="">—</option><option value="true">Yes</option><option value="false">No</option></select>
              : <input {...common} value={v} onChange={(e) => set(f.internal, e.target.value)} type={f.kind === 'date' ? 'date' : f.kind === 'number' || f.kind === 'currency' ? 'number' : 'text'} step="any" />}
            {err[f.internal] && <span id={`${id}-e`} role="alert" style={{ color: 'var(--bad)' }}>{err[f.internal]}</span>}
          </label>
        )
      })}
      {!editable.length && <p className="muted">This list has no columns the app can edit.</p>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy || !editable.length}>{busy ? 'Saving…' : row ? 'Save changes' : 'Create item'}</button>
      </div>
    </form>
  )
}
