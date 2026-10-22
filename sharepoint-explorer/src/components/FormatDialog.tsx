import { useState } from 'react'
import type { Engine } from '../engine'
import { FMT_COLORS, FMT_MARKERS } from '../format'
import { describeClause, opsFor } from '../query'
import type { Clause, FmtColor, FormatRule, Op } from '../types'
import { uid } from '../util'
import { Icon, Modal } from './ui'

const MAX_RULES = 25

/** Colour rules: "highlight rows/cells when …". Rules only change how data LOOKS; SharePoint permissions still decide what anyone can read. */
export function FormatDialog({ engine, mine, shared, mayShare, onSave, onClose }: {
  engine: Engine; mine: FormatRule[]; shared: FormatRule[]; mayShare: boolean
  onSave: (rules: FormatRule[], audience: 'me' | 'everyone') => Promise<void>; onClose: () => void
}) {
  const fields = engine.fields.filter((f) => engine.select.includes(f.internal) && ['text', 'choice', 'multichoice', 'number', 'currency', 'date', 'boolean', 'user', 'lookup', 'counter'].includes(f.kind))
  const [aud, setAud] = useState<'me' | 'everyone'>('me')
  const [mineR, setMineR] = useState(mine), [sharedR, setSharedR] = useState(shared)
  const rules = aud === 'me' ? mineR : sharedR
  const setRules = (r: FormatRule[]) => (aud === 'me' ? setMineR(r) : setSharedR(r))
  const [fi, setFi] = useState(fields[0]?.internal ?? '')
  const f = fields.find((x) => x.internal === fi)
  const ops = f ? opsFor(f) : []
  const [op, setOp] = useState<Op>(ops[0]?.op ?? 'eq')
  const [val, setVal] = useState('')
  const [color, setColor] = useState<FmtColor>('red')
  const [marker, setMarker] = useState('●')
  const [text, setText] = useState<'' | 'bold' | 'strike'>('')
  const [scope, setScope] = useState<'row' | 'cell'>('row')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const needsVal = op !== 'empty' && op !== 'notempty'
  const ok = !!f && (!needsVal || val.trim() !== '') && rules.length < MAX_RULES
  const pickField = (n: string) => { setFi(n); const nf = fields.find((x) => x.internal === n); const o = nf ? opsFor(nf) : []; setOp(o[0]?.op ?? 'eq'); setVal('') }

  const add = () => {
    if (!f || !ok) return
    const clause: Clause = op === 'in' ? { field: f.internal, op, value: '', values: val.split(',').map((x) => x.trim()).filter(Boolean) } : { field: f.internal, op, value: val.trim() }
    setRules([...rules, { id: uid(), name: name.trim() || undefined, clause, scope, color, marker, text: text || undefined, enabled: true }])
    setName(''); setVal('')
  }
  const move = (i: number, d: number) => { const n = rules.slice(); const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; setRules(n) }

  return (
    <Modal title="Colour rules" onClose={onClose} className="wide">
      <h2 style={{ marginBottom: 4 }}>🎨 Colour rules</h2>
      <p className="muted small" style={{ marginTop: 0 }}>Highlight rows or cells that match a condition, for example <i>Status is Blocked</i> → red, or <i>Due date before today</i> → orange. The first matching row rule wins. Colour is always paired with a marker so it is readable without colour vision.</p>
      <div role="tablist" className="tabs" style={{ width: 'fit-content', marginBottom: 10 }}>
        <button role="tab" className="tab" aria-selected={aud === 'me'} onClick={() => setAud('me')}>Just me ({mineR.length})</button>
        <button role="tab" className="tab" aria-selected={aud === 'everyone'} disabled={!mayShare} title={mayShare ? '' : 'Data admins and app owners only'} onClick={() => setAud('everyone')}>Everyone on this list ({sharedR.length})</button>
      </div>

      <form className="filter-row" onSubmit={(e) => { e.preventDefault(); add() }}>
        <label className="field">When column<select className="input" value={fi} onChange={(e) => pickField(e.target.value)}>{fields.map((x) => <option key={x.internal} value={x.internal}>{x.title}</option>)}</select></label>
        <label className="field">is<select className="input" value={op} onChange={(e) => setOp(e.target.value as Op)}>{ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}</select></label>
        {needsVal && (f?.kind === 'choice' && f.choices?.length && op !== 'lastdays'
          ? <label className="field">value<select className="input" value={val} onChange={(e) => setVal(e.target.value)}><option value="">Choose…</option>{f.choices.map((c) => <option key={c}>{c}</option>)}</select></label>
          : f?.kind === 'boolean' ? <label className="field">value<select className="input" value={val} onChange={(e) => setVal(e.target.value)}><option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option></select></label>
            : <label className="field">value{f?.kind === 'date' ? ' (date, today, today-7, today+30)' : f?.percent ? ' (%)' : op === 'in' ? ' (comma separated)' : ''}<input className="input" value={val} onChange={(e) => setVal(e.target.value)} placeholder={f?.kind === 'date' ? 'today' : ''} /></label>)}
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="muted small" style={{ fontWeight: 700 }}>Colour</legend>
          <div role="radiogroup" aria-label="Colour" className="row" style={{ gap: 6 }}>{FMT_COLORS.map((c) => <button type="button" key={c} role="radio" aria-checked={color === c} aria-label={c} className={`fswatch fmt-${c}`} onClick={() => setColor(c)} />)}</div></fieldset>
        <label className="field">Marker<select className="input" value={marker} onChange={(e) => setMarker(e.target.value)}>{FMT_MARKERS.map((m) => <option key={m}>{m}</option>)}</select></label>
        <label className="field">Text<select className="input" value={text} onChange={(e) => setText(e.target.value as '' | 'bold' | 'strike')}><option value="">Normal</option><option value="bold">Bold</option><option value="strike">Strike-through</option></select></label>
        <label className="field">Applies to<select className="input" value={scope} onChange={(e) => setScope(e.target.value as 'row' | 'cell')}><option value="row">Whole row</option><option value="cell">This cell only</option></select></label>
        <label className="field">Name (optional)<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Overdue" /></label>
        <button className="btn primary" disabled={!ok}><Icon n="plus" size={15} />Add rule</button>
      </form>

      <ol className="perm-list" aria-label="Rules in priority order">
        {rules.map((r, i) => (
          <li key={r.id}>
            <span className={`fswatch fmt-${r.color}`} aria-hidden="true" style={{ width: 22, height: 22, display: 'grid', placeItems: 'center', fontSize: '.8rem' }}>{r.marker ?? '●'}</span>
            <div style={{ flex: 1, minWidth: 0 }}><b>{r.name ?? describeClause(r.clause, engine.fields)}</b><div className="muted small">{r.name ? describeClause(r.clause, engine.fields) + ' · ' : ''}{r.scope === 'row' ? 'whole row' : 'cell only'}{r.text ? ` · ${r.text}` : ''}</div></div>
            <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={r.enabled} onChange={(e) => setRules(rules.map((x) => (x.id === r.id ? { ...x, enabled: e.target.checked } : x)))} />On</label>
            <button className="btn icon sm ghost" aria-label={`Move ${r.name ?? 'rule'} up`} disabled={i === 0} onClick={() => move(i, -1)}><Icon n="up" size={14} /></button>
            <button className="btn icon sm ghost" aria-label={`Move ${r.name ?? 'rule'} down`} disabled={i === rules.length - 1} onClick={() => move(i, 1)}><Icon n="down" size={14} /></button>
            <button className="btn icon sm ghost" aria-label={`Delete rule ${r.name ?? ''}`} onClick={() => setRules(rules.filter((x) => x.id !== r.id))}><Icon n="trash" size={14} /></button>
          </li>
        ))}
        {!rules.length && <li className="muted">No rules yet. Add one above.</li>}
      </ol>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={async () => { setBusy(true); try { await onSave(rules, aud) } finally { setBusy(false) } }}>Save {aud === 'me' ? 'my rules' : 'for everyone'}</button>
      </div>
    </Modal>
  )
}
