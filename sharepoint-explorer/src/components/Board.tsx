import { useMemo, useState } from 'react'
import type { Engine } from '../engine'
import type { Row, SpField } from '../types'
import { cellText, fmt } from '../util'
import { CellView } from './Grid'
import { Icon, hashColor, initials } from './ui'

const NONE = '— No value —'
const PER_COL = 60

/** Kanban board: one column per choice value; drag a card to another column to change that value (contributors and admins). */
export function Board({ engine, version, field, setField, canEdit, favs, onToggleFav, onMove, onOpen, tokens }: {
  engine: Engine; version: number; field: SpField; setField: (f: SpField) => void; canEdit: boolean; favs: Set<number>; onToggleFav: (id: number) => void
  onMove: (row: Row, value: string) => Promise<void>; onOpen: (r: Row) => void; tokens: string[]
}) {
  void version; void tokens
  const choiceFields = engine.fields.filter((f) => f.kind === 'choice' && engine.select.includes(f.internal) && (f.choices?.length ?? 0) > 1)
  const [drag, setDrag] = useState<number | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [more, setMore] = useState<Record<string, number>>({})
  const title = engine.fields.find((f) => f.internal === (engine.src.isLibrary ? 'FileLeafRef' : 'Title'))
  const meta = engine.fields.filter((f) => engine.select.includes(f.internal) && f !== title && f.internal !== field.internal && ['user', 'date', 'number', 'currency', 'boolean'].includes(f.kind) && !f.system).slice(0, 3)
  const cols = useMemo(() => {
    const vals = [...(field.choices ?? [])]
    const extra = new Set<string>()
    for (const r of engine.rows) { const v = String(r[field.internal] ?? ''); if (v && !vals.includes(v)) extra.add(v) }
    return [...vals, ...extra, NONE]
  }, [field, engine.rows, version]) // eslint-disable-line react-hooks/exhaustive-deps
  const grouped = useMemo(() => {
    const m = new Map<string, Row[]>(cols.map((c) => [c, []]))
    for (const r of engine.rows) { const v = String(r[field.internal] ?? '') || NONE; (m.get(v) ?? m.get(NONE)!).push(r) }
    return m
  }, [cols, engine.rows, field, version]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="board-wrap">
      <div className="row" style={{ marginBottom: 10 }}>
        <label className="row small" style={{ gap: 6 }}><span className="muted">Group by</span>
          <select className="input" value={field.internal} onChange={(e) => setField(choiceFields.find((f) => f.internal === e.target.value)!)} aria-label="Group board by">{choiceFields.map((f) => <option key={f.internal} value={f.internal}>{f.title}</option>)}</select></label>
        <span className="muted small">{canEdit ? 'Drag cards between columns to update — or use the card’s move menu.' : 'Read-only: you can view but not move cards.'}</span>
        {engine.hasMore && <button className="btn sm" onClick={() => engine.loadMore()}>Load more cards ({fmt(engine.rows.length)} loaded)</button>}
      </div>
      <div className="board" role="list" aria-label={`Board grouped by ${field.title}`}>
        {cols.map((c) => {
          const rows = grouped.get(c) ?? []
          if (c === NONE && !rows.length) return null
          const limit = PER_COL + (more[c] ?? 0)
          const color = c === NONE ? 'var(--c8)' : hashColor(c)
          return (
            <div key={c} role="listitem" className={`bcol${over === c ? ' over' : ''}`} style={{ ['--tc' as string]: color }} aria-label={`${c}, ${rows.length} items`}
              onDragOver={(e) => { if (canEdit && drag != null) { e.preventDefault(); setOver(c) } }} onDragLeave={() => setOver((o) => (o === c ? null : o))}
              onDrop={async (e) => { e.preventDefault(); setOver(null); const id = drag; setDrag(null); const row = engine.rows.find((r) => r.__id === id); if (row && (String(row[field.internal] ?? '') || NONE) !== c) await onMove(row, c === NONE ? '' : c) }}>
              <header><i aria-hidden="true" /><b>{c}</b><span className="pill">{fmt(rows.length)}</span></header>
              <div className="bcards">
                {rows.slice(0, limit).map((r) => (
                  <article key={r.__id} className={`bcard${drag === r.__id ? ' dragging' : ''}${r.__new ? ' fresh' : ''}`} draggable={canEdit} onDragStart={(e) => { setDrag(r.__id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(r.__id)) }} onDragEnd={() => { setDrag(null); setOver(null) }}>
                    <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start', gap: 6 }}>
                      <button className="bt" onClick={() => onOpen(r)}>{cellText(title ?? field, r) || `Item ${r.__id}`}</button>
                      <button className={`fav${favs.has(r.__id) ? ' on' : ''}`} aria-pressed={favs.has(r.__id)} aria-label={`Favorite ${cellText(title ?? field, r)}`} onClick={() => onToggleFav(r.__id)}><Icon n="star" size={15} /></button>
                    </div>
                    <div className="bmeta">{meta.map((f) => r[f.internal] != null && r[f.internal] !== '' ? <span key={f.internal} title={f.title}><CellView f={f} row={r} tokens={[]} /></span> : null)}</div>
                    {canEdit && <select className="bmove" aria-label={`Move ${cellText(title ?? field, r)} to another column`} value="" onChange={(e) => { if (e.target.value) void onMove(r, e.target.value === NONE ? '' : e.target.value) }}><option value="">Move to…</option>{cols.filter((x) => x !== c).map((x) => <option key={x}>{x}</option>)}</select>}
                    {String(r.Author ?? '') && <div className="bwho"><span className="av" style={{ ['--tc' as string]: hashColor(String(r.Author)) }} aria-hidden="true">{initials(String(r.Author))}</span></div>}
                  </article>
                ))}
                {rows.length > limit && <button className="btn sm ghost" onClick={() => setMore((m) => ({ ...m, [c]: (m[c] ?? 0) + PER_COL }))}>Show {Math.min(PER_COL, rows.length - limit)} more</button>}
                {!rows.length && <div className="bempty">Drop a card here</div>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
