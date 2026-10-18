import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import {
  applyFilters, autoDashboard, compareDatasets, datasetToCsv, defaultWidget, fromObjectsAsync, kpiValue, maxDate, series, uid, widgetIssue,
} from './engine'
import type { Agg, Dataset, DateRange, Filter, Grain, Widget, WidgetType } from './engine'
import { BarChart, DataTable, Donut, Kpi, LineChart, SeriesTable, colorMap, useTick } from './charts'
import {
  DEMO_KEY, canWatchFiles, describeConnectors, fetchSimulated, fetchTable, listDbSources, pickWatchableFile, readFile, readPasted, resetSimulated, runSqlQuery,
} from './sources'
import type { DbSource, WatchHandle } from './sources'
import { delDataset, getDataset, loadDashboards, loadPrefs, putDataset, saveDashboards, savePrefs } from './store'
import type { DashboardDef, SourceDef } from './store'

declare const __BUILD__: string

const REFRESH_CHOICES = [
  { v: 0, t: 'Manual' }, { v: 5, t: 'Every 5 s' }, { v: 15, t: 'Every 15 s' }, { v: 30, t: 'Every 30 s' }, { v: 60, t: 'Every minute' }, { v: 300, t: 'Every 5 min' },
]
const RANGES = [{ d: 0, t: 'All' }, { d: 7, t: '7 days' }, { d: 30, t: '30 days' }, { d: 90, t: '90 days' }, { d: 365, t: '1 year' }]
const AGGS: { v: Agg; t: string }[] = [
  { v: 'sum', t: 'Sum' }, { v: 'avg', t: 'Average' }, { v: 'count', t: 'Count of rows' }, { v: 'min', t: 'Minimum' }, { v: 'max', t: 'Maximum' }, { v: 'distinct', t: 'Distinct count' },
]
const WTYPES: { v: WidgetType; t: string }[] = [
  { v: 'kpi', t: 'Number' }, { v: 'bar', t: 'Bars' }, { v: 'line', t: 'Line over time' }, { v: 'donut', t: 'Share (donut)' }, { v: 'table', t: 'Table' },
]

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const ago = (t: number) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 5 ? 'just now' : s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago` }

function download(name: string, text: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export default function App() {
  const [dashboards, setDashboards] = useState<DashboardDef[]>(() => loadDashboards())
  const [activeId, setActiveId] = useState<string | null>(null)
  const [ds, setDs] = useState<Dataset | null>(null)
  const [loading, setLoading] = useState(false)
  const loadingRef = useRef(false)
  const [progress, setProgress] = useState<{ f: number; msg: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [live, setLive] = useState(true)
  const [edit, setEdit] = useState(false)
  const [editing, setEditing] = useState<Widget | null>(null)
  const [dialog, setDialog] = useState<null | 'paste' | 'db' | 'diag'>(null)
  const [dragging, setDragging] = useState(false)
  const [tableView, setTableView] = useState<Record<string, boolean>>({})
  const [theme, setTheme] = useState<'light' | 'dark'>(() => loadPrefs().theme ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
  const [log, setLog] = useState<string[]>([])
  const [prevSnapshot, setPrevSnapshot] = useState<{ sig: string; map: Map<string, number> }>({ sig: '', map: new Map() })
  const [sideOpen, setSideOpen] = useState(true)
  const watch = useRef<Map<string, WatchHandle>>(new Map())
  const reqId = useRef(0)
  const justCreated = useRef<string | null>(null)   // dashboard whose data was just loaded: do not load it twice
  const fileInput = useRef<HTMLInputElement>(null)
  const replaceInput = useRef<HTMLInputElement>(null)
  const importInput = useRef<HTMLInputElement>(null)
  useTick(1000)

  const active = useMemo(() => dashboards.find((d) => d.id === activeId) ?? null, [dashboards, activeId])
  const activeRef = useRef<DashboardDef | null>(null)
  activeRef.current = active

  useEffect(() => { document.documentElement.dataset.theme = theme; savePrefs({ theme }) }, [theme])
  const addLog = useCallback((m: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 60)), [])

  /** Save file data in this browser; big datasets are skipped (it would freeze the page) and the user is told. */
  const saveData = useCallback(async (id: string, data: Dataset) => {
    const saved = await putDataset(id, data)
    if (!saved && data.rows.length > 100_000) setNotice(`${data.rows.length.toLocaleString()} rows is too big to keep in this browser, so the data is gone after a reload (the layout is kept). Add the file again next time, or load it from a database.`)
  }, [])

  const persist = useCallback((fn: (list: DashboardDef[]) => DashboardDef[]) => {
    setDashboards((list) => { const next = fn(list); saveDashboards(next); return next })
  }, [])
  const patchActive = useCallback((patch: Partial<DashboardDef>) => {
    persist((list) => list.map((d) => (d.id === activeRef.current?.id ? { ...d, ...patch, updated: Date.now() } : d)))
  }, [persist])

  /* ------------------------------------------------------------ data loading */

  const snapshotKpis = useCallback((data: Dataset, def: DashboardDef) => {
    const m = new Map<string, number>()
    const rows = applyFilters(data, def.filters, def.range)
    def.widgets.filter((w) => w.type === 'kpi' && !widgetIssue(data, w)).forEach((w) => m.set(w.id, kpiValue(rows, w)))
    return { sig: JSON.stringify([def.filters, def.range]), map: m }
  }, [])

  const acceptDataset = useCallback((next: Dataset, def: DashboardDef, quiet = false) => {
    setDs((prev) => {
      if (prev) {
        setPrevSnapshot(snapshotKpis(prev, def))
        const c = compareDatasets(prev, next)
        if (!quiet && (c.added.length || c.removed.length)) setNotice(`Columns changed: ${c.added.length ? 'new ' + c.added.join(', ') : ''}${c.added.length && c.removed.length ? '; ' : ''}${c.removed.length ? 'missing ' + c.removed.join(', ') : ''}. Use Edit, then "Rebuild widgets" to match.`)
      }
      return next
    })
  }, [snapshotKpis])

  const fetchFromSource = useCallback(async (def: DashboardDef): Promise<Dataset> => {
    const s = def.source
    if (s.kind === 'demo') return fromObjectsAsync(def.name, await fetchSimulated(), def.id)
    if (s.kind === 'db' && s.dbKey) { setProgress({ f: 0.05, msg: 'Reading rows from the database…' }); const rows = await fetchTable(s.dbKey, { top: s.top ?? 5000, filter: s.filter, orderBy: s.orderBy, select: s.select }); return fromObjectsAsync(def.name, rows, def.id, (f, msg) => setProgress({ f, msg })) }
    if (s.kind === 'sql') { setProgress({ f: 0.05, msg: 'Running the query…' }); const rows = await runSqlQuery({ server: s.sqlServer ?? '', database: s.sqlDatabase ?? '', query: s.sqlQuery ?? '' }); return fromObjectsAsync(def.name, rows, def.id, (f, msg) => setProgress({ f, msg })) }
    const h = watch.current.get(def.id)
    if (h) { const f = await h.getFile(); const r = await readFile(f, s.sheet, (f2, msg) => setProgress({ f: f2, msg })); return { ...r.dataset, id: def.id, name: def.name } }
    const cached = await getDataset(def.id)
    if (cached) return cached
    throw new Error('This dashboard\'s data is not stored in this browser. Use "Replace data" to add the file again.')
  }, [])

  const refresh = useCallback(async (opts: { quiet?: boolean; manual?: boolean } = {}) => {
    const def = activeRef.current
    if (!def) return
    if (loadingRef.current && !opts.manual) return       // a slow load is still running: do not pile another on top
    const my = ++reqId.current
    loadingRef.current = true
    setLoading(true)
    try {
      const data = await fetchFromSource(def)
      if (my !== reqId.current) return
      acceptDataset(data, def, opts.quiet)
      setError(null)
      if (def.source.kind === 'file' || def.source.kind === 'paste') void saveData(def.id, data)
      addLog(`Loaded ${data.rows.length} rows from ${def.name}`)
    } catch (e) {
      if (my !== reqId.current) return
      setError(errMsg(e)); addLog('ERROR ' + errMsg(e))
    } finally { if (my === reqId.current) { setLoading(false); loadingRef.current = false; setProgress(null) } }
  }, [acceptDataset, addLog, fetchFromSource, saveData])

  /* open a dashboard: load its data */
  useEffect(() => {
    const fresh = justCreated.current === activeId
    justCreated.current = null
    if (!fresh) setDs(null)
    setError(null); setNotice(null); setEdit(false); setTableView({}); setPrevSnapshot({ sig: '', map: new Map() }); if (activeId) setSideOpen(false)
    if (!activeId || fresh) return
    void refresh({ quiet: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  /* live refresh loop */
  const sec = active?.source.refreshSec ?? 0
  useEffect(() => {
    if (!active || !live || sec <= 0) return
    const t = setInterval(() => { if (!document.hidden) void refresh() }, sec * 1000)
    return () => clearInterval(t)
  }, [active?.id, live, sec, refresh]) // eslint-disable-line react-hooks/exhaustive-deps

  /* watched local file: poll its modified time every 2 s */
  useEffect(() => {
    const id = active?.id
    if (!id || !watch.current.has(id)) return
    let last = 0
    const t = setInterval(async () => {
      try { const f = await watch.current.get(id)!.getFile(); if (f.lastModified !== last) { if (last) void refresh(); last = f.lastModified } } catch { /* file moved */ }
    }, 2000)
    return () => clearInterval(t)
  }, [active?.id, watch.current.size, refresh]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ----------------------------------------------------------- create / open */

  const createDashboard = useCallback((data: Dataset, source: SourceDef, name = data.name, activate = true) => {
    const id = data.id
    const def: DashboardDef = { id, name, source, widgets: autoDashboard(data), filters: [], range: null, created: Date.now(), updated: Date.now() }
    if (source.kind === 'file' || source.kind === 'paste') void saveData(id, data)
    persist((list) => [def, ...list.filter((d) => d.id !== id)])
    if (activate) { justCreated.current = id; setDs(data); setActiveId(id); setError(null) }
    return def
  }, [persist, saveData])

  const handleFiles = useCallback(async (files: File[], replace: boolean) => {
    if (!files.length) return
    setError(null)
    let first = true
    for (const file of files) {
      try {
        setProgress({ f: 0, msg: `Reading ${file.name}…` })
        const r = await readFile(file, undefined, (f, msg) => setProgress({ f, msg: `${file.name}: ${msg}` }))
        if (replace && activeRef.current && first) {
          const def = activeRef.current
          const next = { ...r.dataset, id: def.id, name: def.name }
          acceptDataset(next, def)
          void saveData(def.id, next)
          patchActive({ source: { ...def.source, kind: 'file', fileName: file.name, sheet: r.sheet } })
          addLog(`Replaced data with ${file.name} (${next.rows.length} rows)`)
        } else {
          createDashboard(r.dataset, { kind: 'file', fileName: file.name, sheet: r.sheet, refreshSec: 0 }, r.dataset.name, first)
        }
        first = false
      } catch (e) { setError(`${file.name}: ${errMsg(e)}`); addLog('ERROR ' + file.name + ' ' + errMsg(e)) }
    }
    setProgress(null)
    if (!replace && files.length > 1) setNotice(`${files.length} dashboards were created. Pick one in the list on the left.`)
  }, [acceptDataset, addLog, createDashboard, patchActive, saveData])

  const onDrop = (e: DragEvent, replace: boolean) => {
    e.preventDefault(); setDragging(false)
    void handleFiles([...e.dataTransfer.files], replace)
  }
  const dragProps = (replace: boolean) => ({
    onDragOver: (e: DragEvent) => { e.preventDefault(); setDragging(true) },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent) => onDrop(e, replace),
  })

  const remove = (id: string) => {
    if (!confirm('Delete this dashboard? Its saved file data is removed from this browser.')) return
    persist((l) => l.filter((d) => d.id !== id)); void delDataset(id); watch.current.delete(id)
    if (activeId === id) setActiveId(null)
  }

  /* ----------------------------------------------------------------- derived */

  const rows = useMemo(() => (ds && active ? applyFilters(ds, active.filters, active.range) : []), [ds, active?.filters, active?.range]) // eslint-disable-line react-hooks/exhaustive-deps
  const dateCol = useMemo(() => ds?.columns.find((c) => c.type === 'date')?.name ?? null, [ds])
  const latest = ds && dateCol ? maxDate(ds, dateCol) : null

  const toggleFilter = (col: string, value: string) => {
    if (!active) return
    const cur = active.filters.find((f) => f.col === col)
    let next: Filter[]
    if (!cur) next = [...active.filters, { col, values: [value] }]
    else {
      const vals = cur.values.includes(value) ? cur.values.filter((v) => v !== value) : [...cur.values, value]
      next = vals.length ? active.filters.map((f) => (f.col === col ? { ...f, values: vals } : f)) : active.filters.filter((f) => f.col !== col)
    }
    patchActive({ filters: next })
  }
  const setRange = (days: number) => patchActive({ range: days && dateCol ? ({ col: dateCol, days } as DateRange) : null })

  const saveWidget = (w: Widget) => {
    if (!active) return
    const exists = active.widgets.some((x) => x.id === w.id)
    patchActive({ widgets: exists ? active.widgets.map((x) => (x.id === w.id ? w : x)) : [...active.widgets, w] })
    setEditing(null)
  }
  const removeWidget = (id: string) => active && patchActive({ widgets: active.widgets.filter((w) => w.id !== id) })
  const moveWidget = (id: string, dir: -1 | 1) => {
    if (!active) return
    const a = [...active.widgets]; const i = a.findIndex((w) => w.id === id); const j = i + dir
    if (j < 0 || j >= a.length) return
    ;[a[i], a[j]] = [a[j], a[i]]; patchActive({ widgets: a })
  }

  const exportConfig = () => {
    if (!active) return
    const { source, widgets, filters, range, name } = active
    download(`${name.replace(/[^\w.-]+/g, '_')}.dashboard.json`, JSON.stringify({ lds: 1, name, source: { ...source, sqlQuery: source.sqlQuery }, widgets, filters, range }, null, 2), 'application/json')
  }
  const importConfig = async (file: File) => {
    try {
      const j = JSON.parse(await file.text())
      if (j?.lds !== 1 || !Array.isArray(j.widgets)) throw new Error('Not a Live Dashboard Studio file.')
      const def: DashboardDef = { id: uid('ds'), name: String(j.name ?? 'Imported'), source: j.source, widgets: j.widgets, filters: j.filters ?? [], range: j.range ?? null, created: Date.now(), updated: Date.now() }
      persist((l) => [def, ...l]); setActiveId(def.id)
      if (def.source.kind === 'file' || def.source.kind === 'paste') setNotice('Dashboard layout imported. Add your data with "Replace data".')
    } catch (e) { setError(errMsg(e)) }
  }

  /* ------------------------------------------------------------------- views */

  const showWelcome = !active
  const sig = JSON.stringify([active?.filters, active?.range])

  return (
    <div className={`app${dragging ? ' dragging' : ''}`}>
      <header className="topbar">
        <button className="icon burger" aria-label="Show or hide the dashboard list" aria-expanded={sideOpen} onClick={() => setSideOpen(!sideOpen)}>☰</button>
        <div className="brand"><span className="logo" aria-hidden>◧</span> Live Dashboard Studio</div>
        <div className="spacer" />
        <button className="btn ghost" onClick={() => setDialog('diag')} title="Connection status and log">Diagnostics</button>
        <button className="btn ghost" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Toggle dark mode">{theme === 'dark' ? '☀ Light' : '☾ Dark'}</button>
      </header>

      <div className="layout">
        <aside className={`side${sideOpen ? ' open' : ''}`} {...dragProps(false)}>
          <div className="side-title">New dashboard</div>
          <button className="btn primary wide" onClick={() => fileInput.current?.click()}>⬆ Upload files…</button>
          <input ref={fileInput} type="file" hidden multiple accept=".csv,.tsv,.txt,.json,.xlsx" onChange={(e) => { void handleFiles([...(e.target.files ?? [])], false); e.target.value = '' }} />
          <button className="btn wide" onClick={() => setDialog('paste')}>📋 Paste data</button>
          <button className="btn wide" onClick={() => setDialog('db')}>🗄 Database (SQL / Oracle)</button>
          <button className="btn wide" onClick={() => void startDemo()}>✨ Try the live demo</button>
          <div className="drop-hint muted small">…or drag files anywhere on this panel</div>

          <div className="side-title">Saved dashboards</div>
          {dashboards.length === 0 && <div className="muted small">Nothing yet.</div>}
          <ul className="dash-list">
            {dashboards.map((d) => (
              <li key={d.id} className={d.id === activeId ? 'on' : ''}>
                <button type="button" className="dash-open" onClick={() => setActiveId(d.id)}>
                  <span className="dash-name">{d.name}</span>
                  <span className="muted small">{kindLabel(d.source)}</span>
                </button>
                <button type="button" className="icon" aria-label={`Delete ${d.name}`} onClick={() => remove(d.id)}>✕</button>
              </li>
            ))}
          </ul>
          <div className="side-foot muted small">
            <button className="link" onClick={() => importInput.current?.click()}>Import layout…</button>
            <input ref={importInput} type="file" hidden accept=".json" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importConfig(f); e.target.value = '' }} />
            <div>{__BUILD__}</div>
          </div>
        </aside>

        <main className="main" {...(active ? dragProps(true) : {})}>
          {dragging && <div className="drop-overlay">{active ? 'Drop to replace the data (widgets stay)' : 'Drop files to build dashboards'}</div>}
          {progress && <div className="progress" role="status" aria-live="polite"><div className="progress-bar"><i style={{ width: `${Math.round(progress.f * 100)}%` }} /></div><span>{progress.msg}</span></div>}
          {ds?.truncatedFrom && <div className="banner warn" role="alert"><span><b>Only the first {ds.rows.length.toLocaleString()} of {ds.truncatedFrom.toLocaleString()} rows were loaded.</b> Totals cover just those rows. Filter or aggregate at the source (a database filter or view), or split the file.</span></div>}
          {error && <div className="banner error" role="alert"><span>{error}</span><button className="icon" onClick={() => setError(null)} aria-label="Dismiss">✕</button></div>}
          {notice && <div className="banner info"><span>{notice}</span><button className="icon" onClick={() => setNotice(null)} aria-label="Dismiss">✕</button></div>}

          {showWelcome && (
            <section className="welcome" {...dragProps(false)}>
              <h1>Drop a file. Get a live dashboard.</h1>
              <p className="lead">CSV, Excel, JSON, pasted data or a SQL / Oracle table. The dashboard builds itself, then stays up to date.</p>
              <div className="cards">
                <button className="card-btn" onClick={() => fileInput.current?.click()}><b>⬆ Upload a file</b><span>CSV, TSV, JSON or Excel (.xlsx). Drag onto this page works too.</span></button>
                <button className="card-btn" onClick={() => setDialog('db')}><b>🗄 Connect a database</b><span>SQL Server, Oracle or Dataverse tables through your own Power Apps connections.</span></button>
                <button className="card-btn" onClick={() => setDialog('paste')}><b>📋 Paste data</b><span>Copy cells from Excel or a web page and paste.</span></button>
                <button className="card-btn" onClick={() => void startDemo()}><b>✨ Live demo</b><span>Simulated orders that change every few seconds.</span></button>
              </div>
              <p className="muted small">PDF tables are not read directly: export the table to CSV or Excel first.</p>
            </section>
          )}

          {active && (
            <>
              <div className="dash-head">
                <input className="dash-title" value={active.name} aria-label="Dashboard name" onChange={(e) => patchActive({ name: e.target.value })} />
                <StatusChip def={active} ds={ds} loading={loading} live={live} error={!!error} lastLoaded={ds?.loadedAt ?? 0} />
                <div className="spacer" />
                <RefreshControls def={active} live={live} setLive={setLive} onInterval={(v) => patchActive({ source: { ...active.source, refreshSec: v } })} onNow={() => void refresh({ manual: true })} />
                <button className="btn" onClick={() => replaceInput.current?.click()}>⟳ Replace data</button>
                <input ref={replaceInput} type="file" hidden accept=".csv,.tsv,.txt,.json,.xlsx" onChange={(e) => { void handleFiles([...(e.target.files ?? [])], true); e.target.value = '' }} />
                {canWatchFiles() && <button className="btn" title="Pick a local file; the dashboard updates whenever you save it" onClick={async () => {
                  const h = await pickWatchableFile(); if (!h) return
                  watch.current.set(active.id, h); const f = await h.getFile()
                  patchActive({ source: { ...active.source, kind: 'file', fileName: f.name } }); await handleFiles([f], true); setNotice(`Watching ${f.name}: save the file and this dashboard updates within 2 seconds.`)
                }}>👁 Watch file</button>}
                <Menu label="Export">
                  <button onClick={() => ds && download(`${active.name}.csv`, datasetToCsv({ ...ds, rows }))}>Data as CSV (current filters)</button>
                  <button onClick={exportConfig}>Dashboard layout (.json)</button>
                  <button onClick={() => window.print()}>Print / save as PDF</button>
                </Menu>
                <button className={`btn${edit ? ' primary' : ''}`} onClick={() => setEdit(!edit)}>{edit ? '✓ Done' : '✎ Edit'}</button>
              </div>

              {ds && (
                <div className="filters" role="group" aria-label="Filters">
                  {dateCol && (
                    <div className="seg" role="radiogroup" aria-label={`Date range on ${dateCol}`}>
                      {RANGES.map((r) => (
                        <button key={r.d} role="radio" aria-checked={(active.range?.days ?? 0) === r.d} className={(active.range?.days ?? 0) === r.d ? 'on' : ''} onClick={() => setRange(r.d)}>{r.t}</button>
                      ))}
                    </div>
                  )}
                  {dateCol && latest && active.range && <span className="muted small">last {active.range.days} days up to {latest}</span>}
                  {active.filters.map((f) => (
                    <span key={f.col} className="chip">{f.col}: {f.values.join(', ')}<button aria-label={`Remove filter ${f.col}`} onClick={() => patchActive({ filters: active.filters.filter((x) => x.col !== f.col) })}>✕</button></span>
                  ))}
                  {(active.filters.length > 0 || active.range) && <button className="link" onClick={() => patchActive({ filters: [], range: null })}>Clear all</button>}
                  <span className="muted small push">{rows.length.toLocaleString()} of {ds.rows.length.toLocaleString()} rows</span>
                </div>
              )}

              {!ds && !error && <div className="loading">Loading data…</div>}
              {ds && (
                <div className={`grid${loading ? ' reloading' : ''}`}>
                  {active.widgets.map((w, i) => (
                    <WidgetCard key={w.id} w={w} ds={ds} rows={rows} filters={active.filters} edit={edit} prev={prevSnapshot.sig === sig ? (prevSnapshot.map.get(w.id) ?? null) : null}
                      asTable={!!tableView[w.id]} onToggleTable={() => setTableView((t) => ({ ...t, [w.id]: !t[w.id] }))}
                      onFilter={toggleFilter} onEdit={() => setEditing(w)} onRemove={() => removeWidget(w.id)}
                      onMove={(d) => moveWidget(w.id, d)} first={i === 0} last={i === active.widgets.length - 1} />
                  ))}
                  {edit && (
                    <div className="card add-card">
                      <b>Add a widget</b>
                      <div className="add-row">{WTYPES.map((t) => <button key={t.v} className="btn" onClick={() => setEditing(defaultWidget(t.v, ds))}>{t.t}</button>)}</div>
                      <button className="btn" onClick={() => { if (confirm('Replace all widgets with an automatic layout?')) patchActive({ widgets: autoDashboard(ds) }) }}>↻ Rebuild widgets automatically</button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {editing && ds && <WidgetEditor w={editing} ds={ds} onSave={saveWidget} onClose={() => setEditing(null)} isNew={!active?.widgets.some((x) => x.id === editing.id)} />}
      {dialog === 'paste' && <PasteDialog onClose={() => setDialog(null)} onCreate={(name, text) => {
        try { const d = readPasted(text, name); createDashboard(d, { kind: 'paste', refreshSec: 0 }); setDialog(null) } catch (e) { return errMsg(e) }
      }} />}
      {dialog === 'db' && <DbDialog onClose={() => setDialog(null)} onCreate={async (def) => {
        const id = uid('ds')
        const full: DashboardDef = { id, name: def.name, source: def.source, widgets: [], filters: [], range: null, created: Date.now(), updated: Date.now() }
        try {
          const data = await fetchFromSource(full)
          createDashboard(data, def.source, def.name); setDialog(null)
        } catch (e) { return errMsg(e) }
      }} />}
      {dialog === 'diag' && <Diagnostics log={log} onClose={() => setDialog(null)} />}
    </div>
  )

  async function startDemo() {
    resetSimulated()
    const id = uid('ds')
    const full: DashboardDef = { id, name: 'Demo orders (simulated)', source: { kind: 'demo', refreshSec: 5 }, widgets: [], filters: [], range: null, created: Date.now(), updated: Date.now() }
    const data = await fetchFromSource(full)
    createDashboard(data, full.source, full.name)
  }
}

/* ============================================================== components */

function kindLabel(s: SourceDef): string {
  if (s.kind === 'file') return `File · ${s.fileName ?? ''}`
  if (s.kind === 'paste') return 'Pasted data'
  if (s.kind === 'demo') return 'Demo · live'
  if (s.kind === 'sql') return `SQL query${s.refreshSec ? ' · live' : ''}`
  return `${s.dbKind ?? 'Table'} · ${s.dbKey ?? ''}${s.refreshSec ? ' · live' : ''}`
}

function StatusChip({ def, ds, loading, live, error, lastLoaded }: { def: DashboardDef; ds: Dataset | null; loading: boolean; live: boolean; error: boolean; lastLoaded: number }) {
  const auto = def.source.refreshSec > 0 && live
  return (
    <span className={`status${error ? ' bad' : auto ? ' live' : ''}`} aria-live="polite">
      <i className="pulse" aria-hidden />
      {error ? 'Update failed' : loading ? 'Updating…' : auto ? `Live · ${ago(lastLoaded)}` : ds ? `Updated ${ago(lastLoaded)}` : 'Loading'}
      {ds && <span className="muted"> · {ds.rows.length.toLocaleString()} rows</span>}
    </span>
  )
}

function RefreshControls({ def, live, setLive, onInterval, onNow }: { def: DashboardDef; live: boolean; setLive: (b: boolean) => void; onInterval: (v: number) => void; onNow: () => void }) {
  const file = def.source.kind === 'file' || def.source.kind === 'paste'
  return (
    <div className="refresh">
      {!file && (
        <>
          <select value={def.source.refreshSec} aria-label="Refresh interval" onChange={(e) => onInterval(Number(e.target.value))}>
            {REFRESH_CHOICES.map((r) => <option key={r.v} value={r.v}>{r.t}</option>)}
          </select>
          {def.source.refreshSec > 0 && <button className="btn" onClick={() => setLive(!live)} aria-pressed={live}>{live ? '⏸ Pause' : '▶ Resume'}</button>}
          <button className="btn" onClick={onNow}>↻ Refresh now</button>
        </>
      )}
    </div>
  )
}

function Menu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="menu" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false) }}>
      <button className="btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{label} ▾</button>
      {open && <div className="menu-pop" role="menu" onClick={() => setOpen(false)}>{children}</div>}
    </div>
  )
}

interface CardProps {
  w: Widget; ds: Dataset; rows: ReturnType<typeof applyFilters>; filters: Filter[]; edit: boolean; prev: number | null; asTable: boolean
  onToggleTable: () => void; onFilter: (col: string, v: string) => void; onEdit: () => void; onRemove: () => void; onMove: (d: -1 | 1) => void; first: boolean; last: boolean
}

function WidgetCard({ w, ds, rows, filters, edit, prev, asTable, onToggleTable, onFilter, onEdit, onRemove, onMove, first, last }: CardProps) {
  const issue = widgetIssue(ds, w)
  const points = useMemo(() => (!issue && (w.type === 'bar' || w.type === 'line' || w.type === 'donut') ? series(ds, rows, w) : []), [ds, rows, w, issue])
  const colors = useMemo(() => {
    if (w.type !== 'donut' || issue) return new Map<string, string>()
    return colorMap(series(ds, ds.rows, w).map((p) => p.label))
  }, [ds, w, issue])
  const unit = w.measure && w.agg !== 'count' ? `${aggWord(w.agg)} ${w.measure}` : 'rows'
  const sel = filters.find((f) => f.col === w.dim)?.values ?? []
  const dimType = ds.columns.find((c) => c.name === w.dim)?.type
  const canFilter = dimType === 'text'
  return (
    <section className={`card ${w.type === 'kpi' ? 'w-kpi kpi-card' : `w-${w.span}`}`} aria-label={w.title}>
      <header className="card-head">
        <h3>{w.title || 'Untitled'}</h3>
        <div className="card-actions">
          {(w.type === 'bar' || w.type === 'line' || w.type === 'donut') && !issue && <button className="icon" onClick={onToggleTable} aria-pressed={asTable} title="Show the values as a table">▦</button>}
          {edit && <>
            <button className="icon" onClick={() => onMove(-1)} disabled={first} aria-label="Move earlier">◀</button>
            <button className="icon" onClick={() => onMove(1)} disabled={last} aria-label="Move later">▶</button>
            <button className="icon" onClick={onEdit} aria-label="Edit widget">⚙</button>
            <button className="icon" onClick={onRemove} aria-label="Remove widget">✕</button>
          </>}
        </div>
      </header>
      {issue ? <div className="empty warn">{issue}. {edit ? 'Open ⚙ to pick another column.' : 'Turn on Edit to fix it.'}</div> : (
        <>
          {w.type === 'kpi' && <Kpi value={kpiValue(rows, w)} previous={prev} />}
          {w.type === 'table' && <DataTable columns={ds.columns} rows={rows} />}
          {w.type === 'bar' && (asTable ? <SeriesTable points={points} dimLabel={w.dim ?? ''} valueLabel={unit} /> : <BarChart points={points} selected={sel} onSelect={(l) => canFilter && l !== 'Other' && onFilter(w.dim!, l)} unit={unit} />)}
          {w.type === 'line' && (asTable ? <SeriesTable points={points} dimLabel={w.dim ?? ''} valueLabel={unit} /> : <LineChart points={points} unit={unit} />)}
          {w.type === 'donut' && (asTable ? <SeriesTable points={points} dimLabel={w.dim ?? ''} valueLabel={unit} /> : <Donut points={points} colors={colors} selected={sel} onSelect={(l) => canFilter && l !== 'Other' && onFilter(w.dim!, l)} unit={unit} />)}
          {(w.type === 'bar' || w.type === 'donut') && canFilter && <div className="muted small hint">Click a {w.type === 'bar' ? 'bar' : 'slice'} to filter the whole dashboard.</div>}
        </>
      )}
    </section>
  )
}
const aggWord = (a: Agg) => ({ sum: 'Total', avg: 'Average', count: 'Count', min: 'Minimum', max: 'Maximum', distinct: 'Distinct' }[a])

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [onClose])
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button className="icon" onClick={onClose} aria-label="Close">✕</button></header>
        {children}
      </div>
    </div>
  )
}

function WidgetEditor({ w, ds, onSave, onClose, isNew }: { w: Widget; ds: Dataset; onSave: (w: Widget) => void; onClose: () => void; isNew: boolean }) {
  const [v, setV] = useState<Widget>(w)
  const nums = ds.columns.filter((c) => c.type === 'number')
  const dims = ds.columns.filter((c) => (v.type === 'line' ? c.type === 'date' || c.type === 'text' : c.type !== 'number'))
  const set = <K extends keyof Widget>(k: K, val: Widget[K]) => setV((o) => ({ ...o, [k]: val }))
  const needsDim = v.type === 'bar' || v.type === 'line' || v.type === 'donut'
  const dimIsDate = ds.columns.find((c) => c.name === v.dim)?.type === 'date'
  return (
    <Modal title={isNew ? 'Add widget' : 'Edit widget'} onClose={onClose}>
      <div className="form">
        <label>Type<select value={v.type} onChange={(e) => set('type', e.target.value as WidgetType)}>{WTYPES.map((t) => <option key={t.v} value={t.v}>{t.t}</option>)}</select></label>
        <label>Title<input value={v.title} onChange={(e) => set('title', e.target.value)} /></label>
        {needsDim && <label>{v.type === 'line' ? 'Over (date or category)' : 'Group by'}<select value={v.dim ?? ''} onChange={(e) => set('dim', e.target.value)}>{dims.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select></label>}
        {v.type !== 'table' && <label>Measure<select value={v.measure ?? ''} onChange={(e) => { set('measure', e.target.value || undefined); if (!e.target.value) set('agg', 'count') }}>
          <option value="">(count rows)</option>{ds.columns.map((c) => <option key={c.name} value={c.name}>{c.name}{c.type === 'number' ? '' : ' (text)'}</option>)}</select></label>}
        {v.type !== 'table' && <label>Calculation<select value={v.agg} onChange={(e) => set('agg', e.target.value as Agg)}>
          {AGGS.filter((a) => (a.v === 'sum' || a.v === 'avg' || a.v === 'min' || a.v === 'max' ? nums.some((n) => n.name === v.measure) : true)).map((a) => <option key={a.v} value={a.v}>{a.t}</option>)}</select></label>}
        {v.type === 'line' && dimIsDate && <label>Time step<select value={v.grain ?? ''} onChange={(e) => set('grain', (e.target.value || undefined) as Grain | undefined)}>
          <option value="">Automatic</option><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option><option value="year">Year</option></select></label>}
        {(v.type === 'bar' || v.type === 'donut') && <label>Show top<input type="number" min={2} max={30} value={v.topN} onChange={(e) => set('topN', Math.min(30, Math.max(2, Number(e.target.value) || 8)))} /></label>}
        {(v.type === 'bar') && <label>Sort by<select value={v.sort} onChange={(e) => set('sort', e.target.value as 'value' | 'label')}><option value="value">Value</option><option value="label">Name</option></select></label>}
        <label>Width<select value={v.span} onChange={(e) => set('span', Number(e.target.value) as 1 | 2)}><option value={1}>Half</option><option value={2}>Full</option></select></label>
      </div>
      <footer className="modal-foot"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => onSave({ ...v, title: v.title || 'Untitled' })}>Save</button></footer>
    </Modal>
  )
}

function PasteDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, text: string) => string | void }) {
  const [text, setText] = useState('')
  const [name, setName] = useState('Pasted data')
  const [err, setErr] = useState<string | null>(null)
  return (
    <Modal title="Paste data" onClose={onClose} wide>
      <div className="form">
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Paste cells from Excel, CSV text or JSON (first row = column names)
          <textarea rows={12} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Date,Region,Units\n2026-10-01,North,12\n…'} autoFocus />
        </label>
        {err && <div className="banner error">{err}</div>}
      </div>
      <footer className="modal-foot"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!text.trim()} onClick={() => { const r = onCreate(name || 'Pasted data', text); if (r) setErr(r) }}>Build dashboard</button></footer>
    </Modal>
  )
}

function DbDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (d: { name: string; source: SourceDef }) => Promise<string | void> }) {
  const sources = useMemo<DbSource[]>(() => listDbSources(), [])
  const real = sources.filter((s) => s.kind !== 'demo')
  const [mode, setMode] = useState<'table' | 'sql'>('table')
  const [key, setKey] = useState(real[0]?.key ?? DEMO_KEY)
  const [top, setTop] = useState(5000)
  const [filter, setFilter] = useState('')
  const [orderBy, setOrderBy] = useState('')
  const [select, setSelect] = useState('')
  const [server, setServer] = useState('')
  const [database, setDatabase] = useState('')
  const [query, setQuery] = useState('SELECT TOP 5000 * FROM dbo.YourTable')
  const [refreshSec, setRefreshSec] = useState(30)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const chosen = sources.find((s) => s.key === key)
  const go = async () => {
    setBusy(true); setErr(null)
    const source: SourceDef = mode === 'sql'
      ? { kind: 'sql', sqlServer: server, sqlDatabase: database, sqlQuery: query, refreshSec }
      : key === DEMO_KEY ? { kind: 'demo', refreshSec } : { kind: 'db', dbKey: key, dbKind: chosen?.kind, top, filter, orderBy, select, refreshSec }
    const r = await onCreate({ name: mode === 'sql' ? 'SQL query' : chosen?.label ?? key, source })
    if (r) setErr(r)
    setBusy(false)
  }
  return (
    <Modal title="Connect a database" onClose={onClose} wide>
      <div className="form">
        {real.length === 0 && (
          <div className="banner info">No database tables are connected to this app yet. See README, "Database sources": run the deploy script with your SQL Server / Oracle connection and table names, then reopen the app. You can try the simulated table below meanwhile.</div>
        )}
        <div className="seg" role="radiogroup" aria-label="How to read data">
          <button role="radio" aria-checked={mode === 'table'} className={mode === 'table' ? 'on' : ''} onClick={() => setMode('table')}>Table</button>
          <button role="radio" aria-checked={mode === 'sql'} className={mode === 'sql' ? 'on' : ''} onClick={() => setMode('sql')}>SQL query (advanced)</button>
        </div>
        {mode === 'table' ? (
          <>
            <label>Table<select value={key} onChange={(e) => setKey(e.target.value)}>
              {sources.map((s) => <option key={s.key} value={s.key}>{s.label}{s.kind !== 'demo' ? ` · ${s.kind.toUpperCase()}` : ''}</option>)}</select></label>
            {key !== DEMO_KEY && <>
              <label>Max rows<input type="number" min={1} max={200000} value={top} onChange={(e) => setTop(Number(e.target.value) || 5000)} /></label>
              <label>Filter (OData, optional)<input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Status eq 'Open' and Amount gt 100" /></label>
              <label>Sort (optional)<input value={orderBy} onChange={(e) => setOrderBy(e.target.value)} placeholder="OrderDate desc" /></label>
              <label>Columns (optional, comma separated)<input value={select} onChange={(e) => setSelect(e.target.value)} placeholder="OrderDate, Region, Amount" /></label>
            </>}
          </>
        ) : (
          <>
            <label>Server<input value={server} onChange={(e) => setServer(e.target.value)} placeholder="myserver.database.windows.net" /></label>
            <label>Database<input value={database} onChange={(e) => setDatabase(e.target.value)} /></label>
            <label>Query (one SELECT statement)<textarea rows={5} value={query} onChange={(e) => setQuery(e.target.value)} /></label>
          </>
        )}
        <label>Live refresh<select value={refreshSec} onChange={(e) => setRefreshSec(Number(e.target.value))}>{REFRESH_CHOICES.map((r) => <option key={r.v} value={r.v}>{r.t}</option>)}</select></label>
        {err && <div className="banner error" role="alert">{err}</div>}
      </div>
      <footer className="modal-foot"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => void go()}>{busy ? 'Loading…' : 'Load and build dashboard'}</button></footer>
    </Modal>
  )
}

function Diagnostics({ log, onClose }: { log: string[]; onClose: () => void }) {
  const info = useMemo(() => describeConnectors(), [])
  return (
    <Modal title="Diagnostics" onClose={onClose} wide>
      <div className="form">
        <p>Running inside Power Apps with connections: <b>{info.inPowerApps ? 'yes' : 'no (browser preview: only files, pasted data and the demo work)'}</b></p>
        <h4>Database tables available to this app</h4>
        {info.tables.length ? <ul>{info.tables.map((t) => <li key={t.key}><b>{t.key}</b> · {t.kind.toUpperCase()} · {t.tableId}</li>)}</ul> : <div className="muted">None.</div>}
        <h4>Connectors (operations)</h4>
        {info.connectors.length ? <ul>{info.connectors.map((c) => <li key={c.key}>{c.key} · {c.operations} operations</li>)}</ul> : <div className="muted">None.</div>}
        <h4>Recent activity</h4>
        <pre className="logbox">{log.length ? log.join('\n') : 'Nothing yet.'}</pre>
      </div>
      <footer className="modal-foot"><button className="btn primary" onClick={onClose}>Close</button></footer>
    </Modal>
  )
}

