import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BULK, type Engine } from '../engine'
import { resolveRelative } from '../format'
import { describeClause, emptyQuery, opsFor } from '../query'
import type { Clause, DashConfig, Op, SpField, Widget, WidgetType } from '../types'
import { fmt, uid, yieldToUi } from '../util'
import { stats as apprStats } from '../approval'
import { useApprovalList } from '../approvalStore'
import { makeAcc, starterWidgets, type WidgetRes } from '../widgets'
import { Dashboard } from './Dashboard'
import { BarList, Donut, Gauge, Timeline } from './Charts'
import { Counter, Icon, Modal, useToast } from './ui'

const SAMPLE = 1500
const TYPES: { t: WidgetType; label: string; hint: string }[] = [
  { t: 'approvals', label: 'Approvals', hint: 'Pending, overdue, approved and average turnaround of approval requests' },
  { t: 'kpi', label: 'Number (KPI)', hint: 'One big figure: a count, sum, average, min or max' },
  { t: 'goal', label: 'Goal gauge', hint: 'Progress towards a target number' },
  { t: 'bar', label: 'Bar chart', hint: 'Compare groups of a column' },
  { t: 'donut', label: 'Donut chart', hint: 'Share of each group' },
  { t: 'timeline', label: 'Timeline', hint: 'Items or totals over time' },
  { t: 'top', label: 'Top list', hint: 'Highest or lowest items' },
  { t: 'text', label: 'Note', hint: 'A heading or message for your team' },
]
const AGGS = [['count', 'Count of items'], ['sum', 'Sum'], ['avg', 'Average'], ['min', 'Smallest'], ['max', 'Largest']] as const

interface HostProps { engine: Engine; version: number; title: string; canEdit: boolean; who: string; onFilter: (c: Clause) => void; onGoData: () => void }

/** Shows the admin's saved dashboard to everyone; admins/owners can design it. Falls back to the auto-built dashboard until one is saved. */
export function DashboardHost(p: HostProps) {
  const { engine, canEdit } = p
  const toast = useToast()
  const [cfg, setCfg] = useState<DashConfig | null | undefined>(undefined)
  const [editing, setEditing] = useState(false)
  const [auto, setAuto] = useState(false)
  useEffect(() => {
    let live = true; setCfg(undefined); setEditing(false); setAuto(false)
    const t = setTimeout(() => { if (live) setCfg((c) => (c === undefined ? null : c)) }, 10_000)   // slow tenant: show the auto dashboard meanwhile...
    engine.backend.loadDashboard(engine.src.id).then((c) => live && setCfg(c && c.widgets?.length ? c : null)).catch(() => live && setCfg((c) => (c === undefined ? null : c)))   // ...and still apply the saved layout when it lands
    return () => { live = false; clearTimeout(t) }
  }, [engine.src.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (widgets: Widget[], refreshSec: number) => {
    const next: DashConfig = { v: 1, widgets, refreshSec, updated: new Date().toISOString(), updatedBy: p.who }
    try { await engine.backend.saveDashboard(engine.src.id, next); setCfg(widgets.length ? next : null); setEditing(false); toast('good', widgets.length ? 'Dashboard saved for everyone.' : 'Dashboard reset to the auto-built layout.') }
    catch (e) { toast('bad', `Could not save the dashboard: ${(e as Error).message}`) }
  }

  if (cfg === undefined) return <div className="dgrid" aria-busy="true"><div className="card skel" style={{ height: 140 }} /><div className="card skel" style={{ height: 140 }} /></div>
  if (cfg && !editing && !auto) return <CustomDashboard key="view" {...p} cfg={cfg} editing={false} onEdit={() => setEditing(true)} onAuto={() => setAuto(true)} />
  if (editing) return <CustomDashboard key="edit" {...p} cfg={cfg} editing onSave={save} onCancel={() => setEditing(false)} />
  return (
    <div>
      {canEdit && (
        <div className="banner info" role="note"><Icon n="sparkle" />
          <div style={{ flex: 1 }}><b>Make this dashboard yours.</b> Pick the figures, charts and goals your team cares about — everyone sees your layout, kept live from the data.</div>
          <button className="btn primary sm" onClick={() => setEditing(true)}><Icon n="edit" size={14} />Customize dashboard</button>
          {auto && cfg && <button className="btn sm" onClick={() => setAuto(false)}>Back to custom view</button>}
        </div>
      )}
      <Dashboard engine={engine} version={p.version} title={p.title} onFilter={p.onFilter} onGoData={p.onGoData} />
    </div>
  )
}

function useWidgetResults(engine: Engine, widgets: Widget[], version: number, refreshSec: number) {
  const local = engine.mode === 'local'
  const [res, setRes] = useState<Record<string, WidgetRes>>({})
  const [info, setInfo] = useState<{ n: number; full: boolean; busy: boolean; at: number; err?: string }>({ n: 0, full: false, busy: false, at: 0 })
  const abort = useRef<AbortController | null>(null)
  const scanning = useRef(false)
  const titleField = engine.fields.find((f) => f.internal === 'Title') ? 'Title' : engine.fields.find((f) => f.internal === 'FileLeafRef') ? 'FileLeafRef' : 'ID'
  const sig = JSON.stringify(widgets)

  const accs = useCallback(() => widgets.map((w) => [w.id, makeAcc(w, engine.fields, titleField)] as const), [sig, engine.fields]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { // local mode: everything is in memory, so the dashboard is always exact and instant
    if (!local) return
    const a = accs(); for (const [, x] of a) x.add(engine.all as never)   // the whole list, not the filtered grid
    setRes(Object.fromEntries(a.map(([id, x]) => [id, x.result()]))); setInfo({ n: engine.all.length, full: true, busy: false, at: Date.now() })
  }, [local, sig, version]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = useCallback(async (full: boolean) => {
    if (local) return
    if (scanning.current && !full) return   // a timer / pulse refresh must never cancel "Scan everything"
    abort.current?.abort(); const ctl = (abort.current = new AbortController()); scanning.current = full
    const a = accs(); let n = 0, cursor: string | undefined
    const wanted = new Set<string>([titleField, 'Created', 'Modified'])   // only what the widgets need: fewer columns = faster and safer on big libraries
    for (const w of widgets) { for (const f of [w.field, w.valueField, w.clause?.field]) if (f) wanted.add(f) }
    const sel = [...wanted].filter((n) => engine.fields.some((f) => f.internal === n))
    setInfo((i) => ({ ...i, busy: true, full, err: undefined }))
    try {
      for (;;) {
        const page = await engine.backend.query(engine.src, engine.fields, sel, { ...emptyQuery(), folders: false, sort: { field: 'ID', dir: full ? 'asc' : 'desc' } }, full ? BULK : SAMPLE, cursor, ctl.signal)
        for (const [, x] of a) x.add(page.rows); n += page.rows.length; cursor = page.cursor
        setRes(Object.fromEntries(a.map(([id, x]) => [id, x.result()]))); setInfo({ n, full, busy: !!cursor && full, at: Date.now() })
        if (!full || !cursor) break
        await yieldToUi()
      }
    } catch (e) { if ((e as Error).name !== 'AbortError') setInfo((i) => ({ ...i, busy: false, err: (e as Error).message })) }
    finally { if (abort.current === ctl) scanning.current = false }
  }, [local, sig, engine]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!local) void run(false); return () => abort.current?.abort() }, [local, sig, engine.src.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { // scheduled live refresh (server mode); local mode already follows the live pulse
    if (local || !refreshSec) return
    const t = setInterval(() => { if (!document.hidden) void run(false) }, refreshSec * 1000)
    return () => clearInterval(t)
  }, [local, refreshSec, run])
  useEffect(() => { if (!local && engine.pendingNew > 0 && Date.now() - info.at > 20_000) void run(false) }, [engine.pendingNew]) // eslint-disable-line react-hooks/exhaustive-deps
  return { res, info, run }
}

function CustomDashboard(p: HostProps & { cfg: DashConfig | null | undefined; editing: boolean; onEdit?: () => void; onAuto?: () => void; onSave?: (w: Widget[], refreshSec: number) => Promise<void>; onCancel?: () => void }) {
  const { engine, version, editing, canEdit } = p
  const fields = useMemo(() => engine.fields.filter((f) => engine.select.includes(f.internal) || f.internal === 'ID'), [engine.fields, engine.select])
  const [widgets, setWidgets] = useState<Widget[]>(() => p.cfg?.widgets ?? starterWidgets(fields, engine.src.isLibrary))
  const [refresh, setRefresh] = useState(p.cfg?.refreshSec ?? 60)
  const [edit, setEdit] = useState<Widget | null>(null)
  const [saving, setSaving] = useState(false)
  const live = editing ? widgets : p.cfg?.widgets ?? []
  const { res, info, run } = useWidgetResults(engine, live, version, editing ? 0 : p.cfg?.refreshSec ?? 0)
  const local = engine.mode === 'local'

  const move = (i: number, d: -1 | 1) => setWidgets((ws) => { const a = [...ws], j = i + d; if (j < 0 || j >= a.length) return ws; [a[i], a[j]] = [a[j], a[i]]; return a })
  const upsert = (w: Widget) => { setWidgets((ws) => (ws.some((x) => x.id === w.id) ? ws.map((x) => (x.id === w.id ? w : x)) : [...ws, w])); setEdit(null) }
  const open = (w: Widget, label?: string) => {
    const f = fields.find((x) => x.internal === w.field)
    if (w.clause && (w.type === 'kpi' || w.type === 'goal')) { p.onFilter({ ...w.clause, value: w.clause.op === 'lastdays' ? w.clause.value : resolveRelative(w.clause.value) }); p.onGoData() }
    else if (label && f && (w.type === 'bar' || w.type === 'donut') && label !== '(empty)' && f.kind !== 'date') {
      p.onFilter(f.kind === 'boolean' ? { field: f.internal, op: 'eq', value: label === 'Yes' ? 'true' : 'false' } : f.kind === 'user' || f.kind === 'lookup' ? { field: f.internal, op: 'eq', value: label } : { field: f.internal, op: 'in', value: '', values: [label] }); p.onGoData()
    }
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <span className="pill accent"><Icon n="sparkle" size={13} /> {editing ? 'Designing the dashboard' : 'Team dashboard'}{!editing && p.cfg?.updatedBy ? ` · set by ${p.cfg.updatedBy}` : ''}</span>
        <span className="muted small" role="status">{local ? 'live · all items' : `${fmt(info.n)} items ${info.full ? 'scanned' : 'sampled (latest)'}${info.busy ? '…' : ''}`}</span>
        <span className="grow" />
        {!local && !editing && <>
          <button className="btn sm" onClick={() => void run(false)} disabled={info.busy}><Icon n="refresh" size={14} />Refresh</button>
          <button className="btn sm" onClick={() => void run(true)} disabled={info.busy}><Icon n="scan" size={14} />Scan everything</button>
        </>}
        {!editing && canEdit && <>
          <button className="btn sm primary" onClick={p.onEdit}><Icon n="edit" size={14} />Customize</button>
          <button className="btn sm ghost" onClick={p.onAuto} title="See the auto-built dashboard">Auto view</button>
        </>}
      </div>

      {editing && (
        <div className="card" style={{ marginBottom: 14 }} role="region" aria-label="Dashboard designer">
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button className="btn primary sm" onClick={() => setEdit({ id: uid(), type: 'kpi', title: '', size: 1, agg: 'count' })}><Icon n="plus" size={14} />Add widget</button>
            <label className="row small" style={{ gap: 6 }}>Auto-refresh
              <select className="input" value={refresh} onChange={(e) => setRefresh(Number(e.target.value))} aria-label="Auto-refresh interval">
                <option value={0}>Off</option><option value={30}>30 s</option><option value={60}>1 min</option><option value={300}>5 min</option>
              </select>
            </label>
            <span className="grow" />
            <button className="btn sm ghost" onClick={() => setWidgets(starterWidgets(fields, engine.src.isLibrary))}>Start from suggested</button>
            {p.cfg && <button className="btn sm ghost" onClick={() => { if (confirm('Remove the custom dashboard and go back to the auto-built one for everyone?')) void p.onSave!([], 0) }}>Reset to auto</button>}
            <button className="btn sm" onClick={p.onCancel}>Cancel</button>
            <button className="btn primary sm" disabled={saving || !widgets.length} onClick={async () => { setSaving(true); await p.onSave!(widgets, refresh); setSaving(false) }}><Icon n="check" size={14} />{saving ? 'Saving…' : 'Save for everyone'}</button>
          </div>
          <p className="muted small" style={{ margin: '8px 0 0' }}>Changes are only visible to others after you save. Widgets are computed from live data and respect each person’s SharePoint permissions.</p>
        </div>
      )}

      {info.err && !Object.keys(res).length && <div className="banner bad" role="alert" style={{ marginBottom: 12 }}><Icon n="info" /><div style={{ flex: 1 }}><b>The dashboard could not load its data.</b><div className="small" style={{ overflowWrap: 'anywhere' }}>{info.err}</div></div><button className="btn sm" onClick={() => void run(false)} disabled={info.busy}>Retry</button><button className="btn sm ghost" onClick={p.onGoData}>Open data</button></div>}
      <div className="dgrid cdash">
        {live.map((w, i) => (
          <section key={w.id} className="card cwidget" style={{ gridColumn: `span ${Math.min(w.size, 3)}` }} aria-label={w.title || 'Widget'}>
            {editing && (
              <div className="row wtools" style={{ gap: 4, marginBottom: 6 }}>
                <button className="btn sm ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${w.title} earlier`}><Icon n="up" size={13} /></button>
                <button className="btn sm ghost" onClick={() => move(i, 1)} disabled={i === live.length - 1} aria-label={`Move ${w.title} later`}><Icon n="down" size={13} /></button>
                <span className="grow" />
                <button className="btn sm ghost" onClick={() => setEdit(w)} aria-label={`Edit ${w.title}`}><Icon n="edit" size={13} />Edit</button>
                <button className="btn sm ghost" onClick={() => setWidgets((ws) => ws.filter((x) => x.id !== w.id))} aria-label={`Remove ${w.title}`}><Icon n="trash" size={13} /></button>
              </div>
            )}
            <WidgetView w={w} r={res[w.id]} fields={fields} allFields={engine.fields} total={engine.total} sampled={!local && !info.full} onOpen={(l) => open(w, l)} />
          </section>
        ))}
        {!live.length && <div className="card empty"><p className="muted">No widgets yet.</p></div>}
      </div>
      {edit && <WidgetEditor w={edit} fields={fields} onSave={upsert} onClose={() => setEdit(null)} />}
    </div>
  )
}

function WidgetView({ w, r: r0, fields, allFields, total, sampled, onOpen }: { w: Widget; r?: WidgetRes; fields: SpField[]; allFields: SpField[]; total: number; sampled: boolean; onOpen: (label?: string) => void }) {
  const h = <h2 style={{ marginBottom: 8 }}>{w.title}</h2>
  if (w.type === 'approvals') return <ApprovalTiles title={w.title} />
  const missing = [w.field, w.valueField, w.clause?.field].filter((n): n is string => !!n && !allFields.some((f) => f.internal === n))
  if (missing.length && w.type !== 'text') return <div>{h}<p className="muted">This widget uses a column that no longer exists ({missing.join(', ')}). Edit the widget and pick another column.</p></div>
  if (w.type === 'text') return <div>{h}<p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{w.text}</p></div>
  let r = r0
  if (!r || r.kind === 'none') return <div aria-busy="true">{h}<div className="skel" style={{ height: 60 }} /></div>
  const cls = w.clause && fields.find((f) => f.internal === w.clause!.field)
  if (r.kind === 'kpi' && !w.clause && (w.agg ?? 'count') === 'count' && total > 0) r = { ...r, value: total } // the exact server count beats a sample
  const approx = sampled && r.kind !== 'time' && !(r.kind === 'kpi' && !w.clause && (w.agg ?? 'count') === 'count')
  const sub = (cls && w.clause ? `where ${describeClause(w.clause, fields)}` : '') + (approx ? ' · latest sample' : '')
  if (r.kind === 'kpi' && w.type === 'goal') {
    const goal = w.goal || 100, pct = Math.min(100, Math.round((r.value / goal) * 100))
    return <div>{h}<div className="row" style={{ gap: 14 }}><Gauge value={pct} label={`${w.title} progress`} /><div><div className="v" style={{ fontSize: '1.6rem', fontWeight: 800 }}><Counter value={Math.round(r.value)} /></div><div className="muted small">of {fmt(goal)} goal</div>{sub && <div className="muted small">{sub}</div>}</div></div></div>
  }
  if (r.kind === 'kpi') {
    return (
      <div className="kpi" style={{ padding: 0, border: 0, boxShadow: 'none', background: 'transparent' }}>
        <div className="l">{w.title}</div>
        <div className="v">{r.field?.percent ? `${Math.round(r.value * 100)}%` : <Counter value={Math.round(r.value * 100) / 100} />}</div>
        <div className="d muted">{AGGS.find((a) => a[0] === (w.agg ?? 'count'))?.[1]}{r.field ? ` · ${r.field.title}` : ''} {sub}</div>
        {w.clause && <button className="btn sm ghost" onClick={() => onOpen()}>Show items</button>}
      </div>
    )
  }
  if (r.kind === 'group') return <div>{h}{!r.items.length ? <p className="muted">No data.</p> : w.type === 'donut' ? <Donut data={r.items} onPick={onOpen} /> : <BarList data={r.items} onPick={onOpen} />}</div>
  if (r.kind === 'time') return <div>{h}<Timeline data={r.items} label={w.title} /></div>
  return (
    <div>{h}
      {!r.rows.length ? <p className="muted">No items match.</p> : (
        <ol className="feed" tabIndex={0} aria-label={w.title || 'Top items'} style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {r.rows.map((x, i) => <li key={x.id}><b style={{ width: 22 }}>{i + 1}</b><span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.title}</span><b>{String(x.value)}</b></li>)}
        </ol>
      )}
    </div>
  )
}

function WidgetEditor({ w, fields, onSave, onClose }: { w: Widget; fields: SpField[]; onSave: (w: Widget) => void; onClose: () => void }) {
  const [d, setD] = useState<Widget>(w)
  const set = (p: Partial<Widget>) => setD((x) => ({ ...x, ...p }))
  const groupable = fields.filter((f) => ['choice', 'multichoice', 'boolean', 'user', 'lookup', 'text', 'date'].includes(f.kind) && f.internal !== 'ID')
  const nums = fields.filter((f) => f.kind === 'number' || f.kind === 'currency')
  const dates = fields.filter((f) => f.kind === 'date')
  const filterable = fields.filter((f) => ['text', 'choice', 'multichoice', 'number', 'currency', 'date', 'boolean', 'user', 'lookup', 'counter'].includes(f.kind))
  const cf = d.clause && fields.find((f) => f.internal === d.clause!.field)
  const ops = cf ? opsFor(cf) : []
  const isAppr = d.type === 'approvals'
  const needsField = d.type === 'bar' || d.type === 'donut' || d.type === 'timeline'
  const needsAgg = d.type === 'kpi' || d.type === 'goal' || d.type === 'bar' || d.type === 'donut' || d.type === 'timeline'
  const needsNum = (needsAgg && (d.agg ?? 'count') !== 'count') || d.type === 'top'
  const fieldList = d.type === 'timeline' ? dates : groupable
  const valid = (d.type === 'text' ? !!d.text?.trim() || !!d.title.trim() : true) && (!needsField || !!d.field) && (!needsNum || !!d.valueField)
  const title = d.title.trim() || TYPES.find((t) => t.t === d.type)!.label

  const changeType = (t: WidgetType) => set({ type: t, field: t === 'timeline' ? dates[0]?.internal : t === 'bar' || t === 'donut' ? groupable.find((f) => f.kind === 'choice')?.internal ?? groupable[0]?.internal : undefined, valueField: t === 'top' ? nums[0]?.internal : d.valueField })

  return (
    <Modal title={w.title ? 'Edit widget' : 'Add widget'} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (valid) onSave({ ...d, title }) }} style={{ display: 'grid', gap: 12 }}>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small muted">Type</legend>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }} role="radiogroup" aria-label="Widget type">
            {TYPES.map((t) => <button type="button" key={t.t} role="radio" aria-checked={d.type === t.t} className={`btn sm ${d.type === t.t ? 'primary' : ''}`} title={t.hint} onClick={() => changeType(t.t)}>{t.label}</button>)}
          </div>
          <p className="muted small" style={{ margin: '6px 0 0' }}>{TYPES.find((t) => t.t === d.type)!.hint}</p>
        </fieldset>
        <label className="small">Title<input className="input" value={d.title} onChange={(e) => set({ title: e.target.value })} placeholder={title} maxLength={80} /></label>
        {d.type === 'text' && <label className="small">Message<textarea className="input" rows={4} value={d.text ?? ''} onChange={(e) => set({ text: e.target.value })} maxLength={1000} /></label>}
        {needsField && <label className="small">{d.type === 'timeline' ? 'Date column' : 'Group by'}
          <select className="input" value={d.field ?? ''} onChange={(e) => set({ field: e.target.value })}>{fieldList.map((f) => <option key={f.internal} value={f.internal}>{f.title}</option>)}</select></label>}
        {needsAgg && <label className="small">Measure
          <select className="input" value={d.agg ?? 'count'} onChange={(e) => set({ agg: e.target.value as Widget['agg'] })}>{AGGS.filter((a) => nums.length || a[0] === 'count').map((a) => <option key={a[0]} value={a[0]}>{a[1]}</option>)}</select></label>}
        {needsNum && <label className="small">{d.type === 'top' ? 'Rank by' : 'Number column'}
          <select className="input" value={d.valueField ?? ''} onChange={(e) => set({ valueField: e.target.value })}><option value="">Choose…</option>{nums.map((f) => <option key={f.internal} value={f.internal}>{f.title}</option>)}</select></label>}
        {d.type === 'top' && <div className="row" style={{ gap: 10 }}>
          <label className="small">How many<input className="input" type="number" min={1} max={20} value={d.topN ?? 5} onChange={(e) => set({ topN: Math.max(1, Math.min(20, Number(e.target.value) || 5)) })} /></label>
          <label className="small">Order<select className="input" value={d.sortDir ?? 'desc'} onChange={(e) => set({ sortDir: e.target.value as 'asc' | 'desc' })}><option value="desc">Highest first</option><option value="asc">Lowest first</option></select></label></div>}
        {(d.type === 'bar' || d.type === 'donut') && <label className="small">Show top groups<input className="input" type="number" min={2} max={20} value={d.topN ?? 8} onChange={(e) => set({ topN: Math.max(2, Math.min(20, Number(e.target.value) || 8)) })} /></label>}
        {(d.type === 'timeline' || (d.type === 'bar' || d.type === 'donut') && fields.find((f) => f.internal === d.field)?.kind === 'date') && <label className="small">Group dates by
          <select className="input" value={d.bucket ?? 'auto'} onChange={(e) => set({ bucket: e.target.value as Widget['bucket'] })}>{['auto', 'day', 'week', 'month', 'year'].map((b) => <option key={b}>{b}</option>)}</select></label>}
        {d.type === 'goal' && <label className="small">Goal (target number)<input className="input" type="number" min={1} value={d.goal ?? ''} onChange={(e) => set({ goal: Number(e.target.value) })} required /></label>}
        {d.type !== 'text' && !isAppr && (
          <fieldset style={{ border: '1px dashed var(--line)', borderRadius: 10, padding: 10 }}>
            <legend className="small muted">Only count items where… (optional)</legend>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              <select className="input" aria-label="Filter column" value={d.clause?.field ?? ''} onChange={(e) => { const f = fields.find((x) => x.internal === e.target.value); set({ clause: f ? { field: f.internal, op: opsFor(f)[0].op, value: '' } : undefined }) }}>
                <option value="">No filter</option>{filterable.map((f) => <option key={f.internal} value={f.internal}>{f.title}</option>)}</select>
              {d.clause && cf && <>
                <select className="input" aria-label="Filter condition" value={d.clause.op} onChange={(e) => set({ clause: { ...d.clause!, op: e.target.value as Op } })}>{ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}</select>
                {!['empty', 'notempty'].includes(d.clause.op) && <input className="input" aria-label="Filter value" value={d.clause.value} onChange={(e) => set({ clause: { ...d.clause!, value: e.target.value } })} placeholder={cf.kind === 'date' ? 'e.g. today-30' : 'value'} />}
              </>}
            </div>
          </fieldset>
        )}
        <label className="small">Width
          <select className="input" value={d.size} onChange={(e) => set({ size: Number(e.target.value) as 1 | 2 | 3 })}><option value={1}>Normal</option><option value={2}>Wide</option><option value={3}>Full row</option></select></label>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!valid}>{w.title ? 'Update widget' : 'Add widget'}</button>
        </div>
      </form>
    </Modal>
  )
}

function ApprovalTiles({ title }: { title: string }) {
  const st = apprStats(useApprovalList())
  const t = (l: string, v: string | number, bad?: boolean) => <div><div className="v" style={{ fontSize: '1.5rem', fontWeight: 800, color: bad && Number(v) > 0 ? 'var(--bad)' : undefined }}>{v}</div><div className="muted small">{l}</div></div>
  return <div><h2 style={{ marginBottom: 8 }}>{title}</h2><div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>{t('Pending', st.pending)}{t('Overdue', st.overdue, true)}{t('Approved', st.approved)}{t('Rejected', st.rejected)}{t('Avg. days to approve', st.avgDays ? st.avgDays.toFixed(1) : '—')}</div></div>
}
