import { useEffect, useMemo, useRef, useState } from 'react'
import type { Engine } from '../engine'
import { describeClause, opsFor } from '../query'
import type { Clause, Op, SpField } from '../types'
import { debounce } from '../util'
import { Icon, Menu, Modal } from './ui'

interface Props {
  engine: Engine
  version: number
  fields: SpField[]
  onChange: (patch: { search?: string; clauses?: Clause[] }) => void
  searchRef: React.RefObject<HTMLInputElement | null>
}

export function FilterBar({ engine, version, fields, onChange, searchRef }: Props) {
  const [text, setText] = useState(engine.q.search)
  const [adv, setAdv] = useState(false)
  const push = useMemo(() => debounce((s: string) => onChange({ search: s }), engine.mode === 'local' ? 120 : 450), [engine.mode]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setText(engine.q.search), [engine.q.search])
  useEffect(() => () => push.cancel(), [push])
  const clauses = engine.q.clauses

  const setClause = (c: Clause | null, field: string) =>
    onChange({ clauses: [...clauses.filter((x) => !(x.field === field && x.op === 'lastdays')), ...(c ? [c] : [])] })

  const filterable = fields.filter((f) => f.filterable && (engine.mode === 'local' || f.kind !== 'multichoice'))
  const quick = filterable.filter((f) => f.kind === 'choice').slice(0, 3)
  const dateF = fields.find((f) => f.internal === 'Created') ?? fields.find((f) => f.kind === 'date')

  const choicesOf = (f: SpField): string[] => {
    if (f.choices?.length) return f.choices
    const s = new Set<string>(); for (const r of engine.mode === 'local' ? engine.all : engine.rows) { const v = r[f.internal]; if (v != null && v !== '') s.add(String(v)); if (s.size > 60) break }
    return [...s].sort()
  }

  return (
    <>
      <div className="bar" role="search">
        <div className="search">
          <span className="lead"><Icon n="search" /></span>
          <input ref={searchRef} type="search" value={text} placeholder={engine.mode === 'local' ? 'Search everything — instant, all columns   ( / )' : 'Search title / name on the server   ( / )'}
            aria-label="Search items" onChange={(e) => { setText(e.target.value); push(e.target.value) }}
            onKeyDown={(e) => { if (e.key === 'Escape') { setText(''); push.cancel(); onChange({ search: '' }) } if (e.key === 'Enter') { push.cancel(); onChange({ search: text }) } }} />
          <span className="trail">
            {text && <button className="btn icon sm ghost" aria-label="Clear search" onClick={() => { setText(''); push.cancel(); onChange({ search: '' }) }}><Icon n="x" size={14} /></button>}
          </span>
        </div>

        {quick.map((f) => {
          const cur = clauses.find((c) => c.field === f.internal && c.op === 'in')?.values ?? []
          return (
            <Menu key={f.internal} align="left" label={<>{f.title}{cur.length ? <span className="pill accent">{cur.length}</span> : null}</>} pressed={cur.length > 0}>
              {() => (
                <div role="group" aria-label={`Filter by ${f.title}`}>
                  {choicesOf(f).map((c) => (
                    <label key={c} className="item"><input type="checkbox" checked={cur.includes(c)} onChange={(e) => {
                      const next = e.target.checked ? [...cur, c] : cur.filter((x) => x !== c)
                      onChange({ clauses: [...clauses.filter((x) => !(x.field === f.internal && x.op === 'in')), ...(next.length ? [{ field: f.internal, op: 'in' as Op, value: '', values: next }] : [])] })
                    }} />{c}</label>
                  ))}
                </div>
              )}
            </Menu>
          )
        })}

        {dateF && (
          <Menu align="left" label={<>{dateF.title}</>} icon="filter" pressed={clauses.some((c) => c.field === dateF.internal && c.op === 'lastdays')}>
            {(close) => (
              <div role="group" aria-label={`Filter ${dateF.title} by age`}>
                {[['Any time', 0], ['Last 24 hours', 1], ['Last 7 days', 7], ['Last 30 days', 30], ['Last 90 days', 90], ['Last year', 365]].map(([l, d]) => (
                  <button key={String(l)} onClick={() => { setClause(d ? { field: dateF.internal, op: 'lastdays', value: String(d) } : null, dateF.internal); close() }}>{l}</button>
                ))}
              </div>
            )}
          </Menu>
        )}
        <button className="btn" onClick={() => setAdv(true)}><Icon n="plus" size={15} />Filter</button>
      </div>

      {(clauses.length > 0 || engine.q.search) && (
        <div className="chips" aria-label="Active filters">
          {engine.q.search && <span className="chip">Search: “{engine.q.search}”<button aria-label="Remove search" onClick={() => onChange({ search: '' })}><Icon n="x" size={12} /></button></span>}
          {clauses.map((c, i) => (
            <span key={i} className="chip">{describeClause(c, engine.fields)}<button aria-label={`Remove filter ${describeClause(c, engine.fields)}`} onClick={() => onChange({ clauses: clauses.filter((_, j) => j !== i) })}><Icon n="x" size={12} /></button></span>
          ))}
          <button className="btn sm ghost" onClick={() => onChange({ search: '', clauses: [] })}>Clear all</button>
        </div>
      )}
      {adv && <AdvancedFilter fields={filterable} version={version} onClose={() => setAdv(false)} onAdd={(c) => { onChange({ clauses: [...clauses, c] }); setAdv(false) }} choicesOf={choicesOf} />}
    </>
  )
}

function AdvancedFilter({ fields, onClose, onAdd, choicesOf }: { fields: SpField[]; version: number; onClose: () => void; onAdd: (c: Clause) => void; choicesOf: (f: SpField) => string[] }) {
  const [fi, setFi] = useState(fields[0]?.internal ?? '')
  const f = fields.find((x) => x.internal === fi)
  const ops = f ? opsFor(f) : []
  const [op, setOp] = useState<Op>(ops[0]?.op ?? 'contains')
  const [val, setVal] = useState('')
  const [multi, setMulti] = useState<string[]>([])
  useEffect(() => { setOp(ops[0]?.op ?? 'contains'); setVal(''); setMulti([]) }, [fi]) // eslint-disable-line react-hooks/exhaustive-deps
  const needsValue = op !== 'empty' && op !== 'notempty'
  const ok = !!f && (!needsValue || (op === 'in' ? multi.length > 0 : val !== ''))
  return (
    <Modal title="Add filter" onClose={onClose}>
      <h2 style={{ marginBottom: 12 }}>Add a filter</h2>
      <form className="filter-row" onSubmit={(e) => { e.preventDefault(); if (ok && f) onAdd({ field: f.internal, op, value: val, values: op === 'in' ? multi : undefined }) }}>
        <label className="field">Column<select className="input" value={fi} onChange={(e) => setFi(e.target.value)}>{fields.map((x) => <option key={x.internal} value={x.internal}>{x.title}</option>)}</select></label>
        <label className="field">Condition<select className="input" value={op} onChange={(e) => setOp(e.target.value as Op)}>{ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}</select></label>
        {needsValue && (op === 'in' && f ? (
          <fieldset style={{ border: 0, padding: 0, margin: 0, maxHeight: 160, overflow: 'auto' }}><legend className="sr-only">Values</legend>
            {choicesOf(f).map((c) => <label key={c} style={{ display: 'flex', gap: 6 }}><input type="checkbox" checked={multi.includes(c)} onChange={(e) => setMulti(e.target.checked ? [...multi, c] : multi.filter((x) => x !== c))} />{c}</label>)}
          </fieldset>
        ) : f?.kind === 'boolean' ? (
          <label className="field">Value<select className="input" value={val} onChange={(e) => setVal(e.target.value)}><option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option></select></label>
        ) : (
          <label className="field">Value<input className="input" autoFocus value={val} onChange={(e) => setVal(e.target.value)} type={f?.kind === 'date' && op !== 'lastdays' ? 'date' : f?.kind === 'number' || f?.kind === 'currency' || op === 'lastdays' ? 'number' : 'text'} /></label>
        ))}
        <button className="btn primary" type="submit" disabled={!ok}>Apply</button>
        <button className="btn" type="button" onClick={onClose}>Cancel</button>
      </form>
      <p className="muted small">On very large lists SharePoint can only filter on <b>indexed</b> columns. If a filter is refused, ask the app owner to index that column.</p>
    </Modal>
  )
}

export function useShortcuts(handlers: Record<string, (e: KeyboardEvent) => void>) {
  const ref = useRef(handlers); ref.current = handlers
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable
      const key = (e.ctrlKey || e.metaKey ? 'mod+' : '') + e.key.toLowerCase()
      const h = ref.current[key]
      if (h && (!typing || key.startsWith('mod+'))) h(e)
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [])
}
