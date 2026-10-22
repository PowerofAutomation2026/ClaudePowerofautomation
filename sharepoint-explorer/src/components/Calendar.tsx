import { useEffect, useMemo, useState } from 'react'
import type { Engine } from '../engine'
import type { Clause, Row, SpField } from '../types'
import { cellText, fmt } from '../util'
import { Icon, hashColor } from './ui'

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const dayOf = (v: unknown) => { const t = Date.parse(String(v)); return isNaN(t) ? '' : ymd(new Date(t)) }
const isCalClause = (c: Clause, f: string) => c.field === f && (c.op === 'ge' || c.op === 'le')

/** Month calendar over any date column. Click an empty day to add an item on that date; drag an item to another day to reschedule it. */
export function Calendar({ engine, version, dateFields, canAdd, canEdit, onNew, onOpen, onMove }: {
  engine: Engine; version: number; dateFields: SpField[]; canAdd: boolean; canEdit: boolean
  onNew: (field: SpField, iso: string) => void; onOpen: (r: Row) => void; onMove: (r: Row, field: SpField, iso: string) => Promise<void>
}) {
  const [field, setField] = useState<SpField>(dateFields.find((f) => /due|start|event|date/i.test(f.internal) && !f.system) ?? dateFields[0])
  const [month, setMonth] = useState(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1) })
  const [drag, setDrag] = useState<number | null>(null)
  const [openDay, setOpenDay] = useState<string | null>(null)
  const title = engine.src.isLibrary ? 'FileLeafRef' : 'Title'
  const colorF = engine.fields.find((f) => f.kind === 'choice' && engine.select.includes(f.internal))

  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const start = new Date(first); start.setDate(1 - first.getDay())
  const days = useMemo(() => Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d }), [month]) // eslint-disable-line react-hooks/exhaustive-deps

  // ask the engine only for the visible weeks (server-side on big lists, instant on small ones)
  useEffect(() => {
    const lo = days[0], hi = new Date(days[41]); hi.setHours(23, 59, 59)
    const keep = engine.q.clauses.filter((c) => !isCalClause(c, field.internal))
    engine.setQuery({ clauses: [...keep, { field: field.internal, op: 'ge', value: ymd(lo) }, { field: field.internal, op: 'le', value: `${ymd(hi)}T23:59:59` }] })
  }, [month, field.internal]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { engine.setQuery({ clauses: engine.q.clauses.filter((c) => !(c.op === 'ge' || c.op === 'le') || !dateFields.some((f) => f.internal === c.field)) }) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const byDay = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of engine.rows) { const k = dayOf(r[field.internal]); if (k) (m.get(k) ?? m.set(k, []).get(k)!).push(r) }
    return m
  }, [engine.rows, field, version]) // eslint-disable-line react-hooks/exhaustive-deps
  const today = ymd(new Date())
  const label = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

  return (
    <div className="cal">
      <div className="row" style={{ marginBottom: 10 }}>
        <button className="btn icon" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><Icon n="chevL" /></button>
        <h2 style={{ minWidth: 190, textAlign: 'center' }} aria-live="polite">{label}</h2>
        <button className="btn icon" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><Icon n="chevR" /></button>
        <button className="btn sm" onClick={() => { const n = new Date(); setMonth(new Date(n.getFullYear(), n.getMonth(), 1)) }}>Today</button>
        <span className="grow" />
        <label className="row small" style={{ gap: 6 }}><span className="muted">Show by</span><select className="input" value={field.internal} onChange={(e) => setField(dateFields.find((f) => f.internal === e.target.value)!)} aria-label="Date column">{dateFields.map((f) => <option key={f.internal} value={f.internal}>{f.title}</option>)}</select></label>
        <span className="muted small">{fmt(engine.rows.length)} items this period{canEdit ? ' · drag to reschedule' : ''}</span>
      </div>
      <div className="cal-grid" role="grid" aria-label={label}>
        {DOW.map((d) => <div key={d} role="columnheader" className="cal-dow">{d}</div>)}
        {days.map((d) => {
          const k = ymd(d), items = byDay.get(k) ?? [], out = d.getMonth() !== month.getMonth()
          return (
            <div key={k} role="gridcell" className={`cal-day${out ? ' out' : ''}${k === today ? ' today' : ''}`} aria-label={`${d.toDateString()}, ${items.length} items`}
              onDragOver={(e) => { if (canEdit && drag != null) e.preventDefault() }}
              onDrop={async (e) => { e.preventDefault(); const r = engine.rows.find((x) => x.__id === drag); setDrag(null); if (r && dayOf(r[field.internal]) !== k) await onMove(r, field, k) }}>
              <div className="cal-head"><b>{d.getDate()}</b>{canAdd && !engine.src.isLibrary && <button className="cal-add" aria-label={`Add item on ${d.toDateString()}`} onClick={() => onNew(field, k)}>＋</button>}</div>
              {items.slice(0, 3).map((r) => {
                const c = colorF && r[colorF.internal] ? hashColor(String(r[colorF.internal])) : 'var(--c1)'
                return <button key={r.__id} className="cal-ev" style={{ ['--tc' as string]: c }} draggable={canEdit} onDragStart={(e) => { setDrag(r.__id); e.dataTransfer.setData('text/plain', String(r.__id)) }} onDragEnd={() => setDrag(null)} onClick={() => onOpen(r)} title={cellText({ internal: title, kind: 'text' } as SpField, r)}>{String(r[title] ?? `#${r.__id}`)}</button>
              })}
              {items.length > 3 && <button className="cal-more" onClick={() => setOpenDay(openDay === k ? null : k)} aria-expanded={openDay === k}>+{items.length - 3} more</button>}
              {openDay === k && <div className="cal-pop" role="dialog" aria-label={`All items on ${d.toDateString()}`}>{items.map((r) => <button key={r.__id} className="cal-ev" style={{ ['--tc' as string]: colorF && r[colorF.internal] ? hashColor(String(r[colorF.internal])) : 'var(--c1)' }} onClick={() => { setOpenDay(null); onOpen(r) }}>{String(r[title] ?? `#${r.__id}`)}</button>)}</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
