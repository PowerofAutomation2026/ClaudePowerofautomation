import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Engine, LOCAL_MAX } from './engine'
import { chooseBackend } from './services'
import type { AppConfig, Backend, Clause, Query, Row, SourceConfig, SpField } from './types'
import { searchTokens } from './query'
import { fmt, lsGet, lsSet, relTime, sameUser } from './util'
import { Connect } from './components/Connect'
import { Dashboard } from './components/Dashboard'
import { Drawer } from './components/Drawer'
import { ExportDialog } from './components/ExportDialog'
import { FilterBar, useShortcuts } from './components/Filters'
import { Grid } from './components/Grid'
import { Palette, type Cmd } from './components/Palette'
import { Icon, Menu, Toaster, useToast } from './components/ui'
import type { ExportFormat } from './export'

type Tab = 'dashboard' | 'data' | 'connect'
type ThemePref = 'system' | 'light' | 'dark' | 'contrast'

export default function App() { return <Toaster><Shell /></Toaster> }

/** Which columns to load: title first, the list's default view next, then the audit columns the dashboard needs. */
function pickColumns(fields: SpField[], isLibrary: boolean): string[] {
  const title = isLibrary ? 'FileLeafRef' : 'Title'
  const out: string[] = []
  let expands = 0
  const add = (f?: SpField) => {
    if (!f || out.includes(f.internal) || f.internal === 'ID' || f.kind === 'other' || f.kind === 'note' || out.length >= 24) return
    if (f.kind === 'user' || f.kind === 'lookup') { if (expands >= 8) return; expands++ }
    out.push(f.internal)
  }
  const by = (n: string) => fields.find((f) => f.internal === n)
  add(by(title)); fields.filter((f) => !f.system).forEach(add)
  ;['Created', 'Modified', 'Author', 'Editor'].forEach((n) => add(by(n)))
  fields.forEach(add)
  return out
}
const defaultVisible = (fields: SpField[], loaded: string[], isLibrary: boolean) => {
  const v = loaded.filter((n) => !fields.find((f) => f.internal === n)?.system).slice(0, 8)
  for (const n of isLibrary ? ['Modified', 'Editor'] : ['Modified']) if (loaded.includes(n) && !v.includes(n)) v.push(n)
  return v
}

function Shell() {
  const toast = useToast()
  const [boot, setBoot] = useState<{ backend: Backend; who: { upn: string; name: string }; config: AppConfig } | null>(null)
  const [bootErr, setBootErr] = useState('')
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [tab, setTab] = useState<Tab>('dashboard')
  const [src, setSrc] = useState<SourceConfig | null>(null)
  const [engine, setEngine] = useState<Engine | null>(null)
  const [loadingSrc, setLoadingSrc] = useState(false)
  const [srcErr, setSrcErr] = useState('')
  const [theme, setTheme] = useState<ThemePref>(lsGet('spx.theme', 'system'))
  const [fs, setFs] = useState<number>(lsGet('spx.fs', 16))
  const [view, setView] = useState<'table' | 'cards'>(lsGet('spx.view', 'table'))
  const [visible, setVisible] = useState<string[]>([])
  const [widths, setWidths] = useState<Record<string, number>>({})
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [open, setOpen] = useState<Row | null>(null)
  const [palette, setPalette] = useState(false)
  const [exp, setExp] = useState<ExportFormat | null>(null)
  const [live, setLive] = useState<boolean>(lsGet('spx.live', false))
  const searchRef = useRef<HTMLInputElement>(null)

  /* ------------------------------------------------ boot */
  useEffect(() => {
    (async () => {
      try {
        const backend = await chooseBackend()
        const [who, config] = await Promise.all([backend.whoAmI(), backend.loadConfig()])
        setBoot({ backend, who, config }); setConfig(config)
      } catch (e) { setBootErr((e as Error).message) }
    })()
  }, [])

  const isOwner = !!boot && (boot.backend.mode === 'demo' || config?.owners.some((o) => sameUser(o, boot.who.upn)) === true)

  /* ------------------------------------------------ theme + text size */
  useEffect(() => {
    lsSet('spx.theme', theme)
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme }
    apply(); mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
  useEffect(() => { lsSet('spx.fs', fs); document.documentElement.style.fontSize = `${fs}px` }, [fs])

  /* ------------------------------------------------ opening a source */
  const openSource = useCallback(async (s: SourceConfig, goTab?: Tab) => {
    if (!boot) return
    setLoadingSrc(true); setSrcErr(''); setSelected(new Set()); setOpen(null)
    engine?.dispose()
    try {
      const [fields, list] = await Promise.all([boot.backend.getFields(s.siteUrl, s.listId), boot.backend.getList(s.siteUrl, s.listId).catch(() => null)])
      const cur: SourceConfig = { ...s, itemCount: list?.itemCount ?? s.itemCount }
      const select = pickColumns(fields, cur.isLibrary)
      const eng = new Engine(boot.backend, cur, fields, select)
      const vis = lsGet<string[]>(`spx.cols.${s.id}`, []).filter((n) => select.includes(n))
      setVisible(vis.length ? vis : defaultVisible(fields, select, cur.isLibrary))
      setWidths(lsGet(`spx.w.${s.id}`, {}))
      setSrc(cur); setEngine(eng); lsSet('spx.active', s.id)
      if (goTab) setTab(goTab)
      void eng.start()
    } catch (e) { setSrcErr((e as Error).message); setEngine(null) } finally { setLoadingSrc(false) }
  }, [boot, engine])

  useEffect(() => {
    if (!boot || !config || src || loadingSrc) return
    const want = config.sources.find((s) => s.id === lsGet('spx.active', '')) ?? config.sources.find((s) => s.id === config.activeId) ?? config.sources[0]
    if (want) void openSource(want, 'dashboard')
    else setTab(isOwner ? 'connect' : 'data')
  }, [boot, config]) // eslint-disable-line react-hooks/exhaustive-deps

  const ver = useSyncExternalStore(engine?.subscribe ?? noopSub, engine?.getVersion ?? zero)

  /* ------------------------------------------------ live pulse */
  useEffect(() => {
    lsSet('spx.live', live)
    if (!live || !engine) return
    let stop = false
    const tick = async () => {
      if (stop || document.hidden) return
      const n = await engine.poll()
      if (n > 0) toast('info', `${n} item${n === 1 ? '' : 's'} added or changed`)
    }
    const t = setInterval(tick, 20_000)
    return () => { stop = true; clearInterval(t) }
  }, [live, engine]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------------------------ query plumbing */
  const change = useCallback((patch: Partial<Query>) => { engine?.setQuery(patch); setSelected(new Set()) }, [engine])
  const addClause = useCallback((c: Clause) => engine && change({ clauses: [...engine.q.clauses.filter((x) => !(x.field === c.field && x.op === c.op)), c] }), [engine, change])
  const sortBy = (field: string) => engine && change({ sort: { field, dir: engine.q.sort.field === field && engine.q.sort.dir === 'asc' ? 'desc' : 'asc' } })

  const cols = useMemo(() => (engine ? visible.map((n) => engine.fields.find((f) => f.internal === n)).filter(Boolean) as SpField[] : []), [engine, visible])
  const tokens = useMemo(() => searchTokens(engine?.q.search ?? ''), [ver, engine]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleCol = (n: string) => { const v = visible.includes(n) ? visible.filter((x) => x !== n) : engine!.select.filter((x) => visible.includes(x) || x === n); if (!v.length) return; setVisible(v); lsSet(`spx.cols.${src!.id}`, v) }
  const setWidth = useCallback((n: string, w: number) => setWidths((cur) => { const next = { ...cur, [n]: w }; if (src) lsSet(`spx.w.${src.id}`, next); return next }), [src])

  /* ------------------------------------------------ saved views */
  const [views, setViews] = useState<{ name: string; q: Query; cols: string[] }[]>([])
  useEffect(() => { setViews(src ? lsGet(`spx.views.${src.id}`, []) : []) }, [src])
  const saveView = () => {
    if (!engine || !src) return
    const name = prompt('Name this view (search, filters, sort and columns are saved):', engine.q.search || 'My view')
    if (!name) return
    const next = [...views.filter((v) => v.name !== name), { name, q: engine.q, cols: visible }]
    setViews(next); lsSet(`spx.views.${src.id}`, next); toast('good', `View “${name}” saved`)
  }
  const applyView = (v: { q: Query; cols: string[] }) => { setVisible(v.cols.filter((c) => engine?.select.includes(c))); change(v.q) }

  /* ------------------------------------------------ shortcuts + palette */
  useShortcuts({
    '/': (e) => { e.preventDefault(); setTab('data'); setTimeout(() => searchRef.current?.focus(), 30) },
    'mod+k': (e) => { e.preventDefault(); setPalette(true) },
  })
  const cmds: Cmd[] = useMemo(() => {
    const c: Cmd[] = [
      { id: 'dash', label: 'Go to Dashboard', icon: 'chart', run: () => setTab('dashboard') },
      { id: 'data', label: 'Go to Data', icon: 'table', run: () => setTab('data') },
      { id: 'conn', label: isOwner ? 'Connect a list or library' : 'Data source info', icon: 'plug', run: () => setTab('connect') },
      { id: 'search', label: 'Search items', hint: '/', icon: 'search', run: () => { setTab('data'); setTimeout(() => searchRef.current?.focus(), 30) } },
      { id: 'csv', label: 'Export CSV', icon: 'download', run: () => setExp('csv') },
      { id: 'json', label: 'Export JSON', icon: 'download', run: () => setExp('json') },
      { id: 'pdf', label: 'Export PDF', icon: 'download', run: () => setExp('pdf') },
      { id: 'live', label: live ? 'Turn live pulse off' : 'Turn live pulse on', icon: 'bolt', run: () => setLive(!live) },
      { id: 'cards', label: 'Switch to ' + (view === 'table' ? 'card' : 'table') + ' view', icon: 'cards', run: () => { const v = view === 'table' ? 'cards' : 'table'; setView(v); lsSet('spx.view', v) } },
      { id: 'refresh', label: 'Refresh data', icon: 'refresh', run: () => void engine?.refresh() },
      { id: 'clear', label: 'Clear search and filters', icon: 'x', run: () => change({ search: '', clauses: [] }) },
      ...(['system', 'light', 'dark', 'contrast'] as const).map<Cmd>((t) => ({ id: 'th-' + t, label: `Theme: ${t === 'contrast' ? 'high contrast' : t}`, icon: t === 'dark' ? 'moon' : t === 'contrast' ? 'contrast' : 'sun', run: () => setTheme(t) })),
    ]
    for (const s of config?.sources ?? []) c.push({ id: 'src-' + s.id, label: `Open: ${s.label}`, hint: s.isLibrary ? 'library' : 'list', icon: s.isLibrary ? 'lib' : 'list', run: () => void openSource(s, 'dashboard') })
    return c
  }, [config, live, view, isOwner, engine]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------------------------ render */
  if (bootErr) return <main style={{ padding: 24 }}><div className="banner bad" role="alert"><Icon n="info" /><div><b>Could not start.</b> {bootErr}</div></div></main>
  if (!boot || !config) return <main style={{ padding: 24 }} aria-busy="true"><div className="card skel" style={{ height: 120 }} /><span className="sr-only" role="status">Loading…</span></main>

  const onSaved = async (cfg: AppConfig, s?: SourceConfig) => {
    setConfig(cfg)
    if (s) await openSource(s, 'dashboard')
    else if (cfg.sources.length === 0) { engine?.dispose(); setEngine(null); setSrc(null) }
  }
  const total = engine?.total ?? 0

  return (
    <div className="app">
      <a className="skip" href="#main">Skip to content</a>
      <header className="top">
        <div className="brand"><span className="logo"><Icon n="grid" size={20} /></span><span>SharePoint Explorer</span></div>

        {config.sources.length > 0 && (
          <Menu align="left" icon={src?.isLibrary ? 'lib' : 'list'} label={<span style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{src?.label ?? 'Choose data'}</span>}>
            {(close) => <div role="group" aria-label="Connected sources">{config.sources.map((s) => (
              <button key={s.id} aria-checked={src?.id === s.id} role="menuitemradio" onClick={() => { close(); void openSource(s) }}><Icon n={s.isLibrary ? 'lib' : 'list'} />{s.label}<span className="muted small" style={{ marginLeft: 'auto' }}>{fmt(s.itemCount)}</span></button>
            ))}</div>}
          </Menu>
        )}

        <nav className="tabs" role="tablist" aria-label="Sections">
          {([['dashboard', 'chart', 'Dashboard'], ['data', 'table', 'Data'], ['connect', isOwner ? 'plug' : 'lock', isOwner ? 'Connect' : 'Source']] as const).map(([t, ic, l]) => (
            <button key={t} role="tab" className="tab" aria-selected={tab === t} onClick={() => setTab(t)} disabled={t !== 'connect' && !engine && !loadingSrc}><Icon n={ic} size={16} />{l}</button>
          ))}
        </nav>
        <span className="grow" />
        {boot.backend.mode === 'demo' && <span className="pill warn" title="Not running inside Power Apps: using generated sample data">Demo data</span>}

        <button className="btn" aria-pressed={live} onClick={() => setLive(!live)} title="Live pulse: check for new and changed items every 20 seconds" disabled={!engine}>
          <span className={`live-dot${live ? '' : ' off'}`} aria-hidden="true" /><span className="lbl-t">Live</span>{live && engine && engine.pendingNew > 0 && <span className="pill accent">{engine.pendingNew}</span>}
        </button>
        <button className="btn icon" onClick={() => setPalette(true)} aria-label="Command palette (Ctrl+K)" title="Command palette (Ctrl+K)"><Icon n="cmd" /></button>
        <Menu icon={theme === 'dark' ? 'moon' : theme === 'contrast' ? 'contrast' : 'sun'} label={<span className="lbl-t">Display</span>}>
          {(close) => <div role="group" aria-label="Display settings">
            <div className="hd">Theme</div>
            {(['system', 'light', 'dark', 'contrast'] as const).map((t) => <button key={t} role="menuitemradio" aria-checked={theme === t} onClick={() => { setTheme(t); close() }}><Icon n={t === 'dark' ? 'moon' : t === 'contrast' ? 'contrast' : 'sun'} />{t === 'contrast' ? 'High contrast' : t[0].toUpperCase() + t.slice(1)}</button>)}
            <hr /><div className="hd">Text size</div>
            <div className="row" style={{ padding: '4px 10px' }}>
              <button className="btn sm" onClick={() => setFs(Math.max(12, fs - 1))} aria-label="Smaller text">A−</button><span aria-live="polite">{fs}px</span><button className="btn sm" onClick={() => setFs(Math.min(24, fs + 1))} aria-label="Larger text">A+</button>
              <button className="btn sm ghost" onClick={() => setFs(16)}>Reset</button>
            </div>
          </div>}
        </Menu>
      </header>

      <main id="main" tabIndex={-1}>
        <h1 className="sr-only">{src ? `${src.label} — ${tab}` : 'SharePoint Explorer'}</h1>
        <div aria-live="polite" className="sr-only">{engine ? `${fmt(engine.rows.length)} rows shown` : ''}</div>
        {srcErr && <div className="banner bad" role="alert"><Icon n="info" /><div><b>Could not open the data source.</b> {srcErr}</div></div>}
        {loadingSrc && <div className="card skel" style={{ height: 160 }} aria-busy="true" />}

        {!loadingSrc && tab === 'connect' && <Connect backend={boot.backend} config={config} isOwner={isOwner} who={boot.who} engine={engine} onSaved={onSaved} />}

        {!loadingSrc && tab !== 'connect' && !engine && (
          <div className="card empty"><Icon n="plug" size={44} /><h2>No list or library connected yet</h2>
            <p className="muted">{isOwner ? 'Press Connect to choose the SharePoint list or library this app should show.' : 'The app owner has not connected a list or library yet.'}</p>
            {isOwner && <button className="btn primary big" onClick={() => setTab('connect')}><Icon n="plug" />Connect</button>}
          </div>
        )}

        {!loadingSrc && engine && src && tab === 'dashboard' && (
          <Dashboard engine={engine} version={ver} title={src.label} onFilter={addClause} onGoData={() => setTab('data')} />
        )}

        {!loadingSrc && engine && src && tab === 'data' && (
          <section aria-label="Data">
            {engine.error && <div className="banner bad" role="alert"><Icon n="info" /><div style={{ flex: 1 }}>{engine.error}</div><button className="btn sm" onClick={() => void engine.refresh()}>Retry</button></div>}
            <FilterBar engine={engine} version={ver} fields={engine.fields.filter((f) => engine.select.includes(f.internal))} searchRef={searchRef} onChange={change} />
            <div className="bar">
              <span className="muted" role="status">
                {engine.mode === 'local'
                  ? <><b>{fmt(engine.rows.length)}</b> of {fmt(engine.all.length)} items{engine.loading ? ` (loading ${Math.round(engine.progress * 100)}%…)` : ''}</>
                  : <><b>{fmt(engine.rows.length)}</b> loaded · list has {fmt(total)} items{engine.loading ? ' · loading…' : ''}</>}
              </span>
              {engine.pendingNew > 0 && <button className="btn sm primary" onClick={() => engine.absorbNew()}><Icon n="refresh" size={14} />{engine.pendingNew} new — show</button>}
              <span className="grow" />
              {src.isLibrary && <button className="btn sm" aria-pressed={engine.q.folders} onClick={() => change({ folders: !engine.q.folders })}><Icon n="lib" size={14} />Folders</button>}
              <Menu icon="star" label={<span className="lbl-t">Views</span>}>
                {(close) => <div>
                  <button onClick={() => { close(); saveView() }}><Icon n="plus" />Save current view…</button>
                  {views.length > 0 && <hr />}
                  {views.map((v) => <div key={v.name} className="row" style={{ flexWrap: 'nowrap' }}><button onClick={() => { close(); applyView(v) }}>{v.name}</button>
                    <button className="btn icon sm ghost" aria-label={`Delete view ${v.name}`} style={{ width: 'auto' }} onClick={() => { const n = views.filter((x) => x.name !== v.name); setViews(n); lsSet(`spx.views.${src.id}`, n) }}><Icon n="trash" size={14} /></button></div>)}
                </div>}
              </Menu>
              <Menu icon="cols" label={<span className="lbl-t">Columns</span>}>
                {() => <div role="group" aria-label="Visible columns">{engine.select.map((n) => { const f = engine.fields.find((x) => x.internal === n)!; return <label key={n} className="item"><input type="checkbox" checked={visible.includes(n)} onChange={() => toggleCol(n)} />{f.title}</label> })}</div>}
              </Menu>
              <div role="group" aria-label="Layout" className="row" style={{ gap: 2 }}>
                <button className="btn icon" aria-pressed={view === 'table'} aria-label="Table view" onClick={() => { setView('table'); lsSet('spx.view', 'table') }}><Icon n="table" /></button>
                <button className="btn icon" aria-pressed={view === 'cards'} aria-label="Card view" onClick={() => { setView('cards'); lsSet('spx.view', 'cards') }}><Icon n="cards" /></button>
              </div>
              <Menu icon="download" label={<span className="lbl-t">Export</span>}>
                {(close) => <div>{(['csv', 'json', 'pdf'] as const).map((f) => <button key={f} onClick={() => { close(); setExp(f) }}><Icon n="download" />{f.toUpperCase()}{f === 'pdf' && <span className="muted small" style={{ marginLeft: 'auto' }}>report</span>}</button>)}</div>}
              </Menu>
            </div>

            <Grid engine={engine} version={ver} cols={cols} selected={selected} widths={widths} setWidth={setWidth} tokens={tokens} view={view} isLibrary={src.isLibrary}
              onToggle={(id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })}
              onToggleAll={() => setSelected((s) => (engine.rows.every((r) => s.has(r.__id)) ? new Set() : new Set(engine.rows.map((r) => r.__id))))}
              onOpen={setOpen} onSort={sortBy} />
            <div className="gfoot" style={{ borderRadius: 12, border: '1px solid var(--line)', marginTop: 8 }}>
              <span>{selected.size ? <b>{fmt(selected.size)} selected</b> : 'Click a row for details · ↑↓ to move · Space to select'}</span>
              {engine.mode === 'server' && <label className="row" style={{ flex: 1, minWidth: 220 }}>Jump
                <input type="range" min={0} max={100} defaultValue={0} aria-label="Jump to position in list" style={{ flex: 1 }} onChange={(e) => engine.seek(Number(e.target.value) / 100)} />
              </label>}
              <span className="muted">{engine.mode === 'local' ? `In-memory mode (≤ ${fmt(LOCAL_MAX)} items)` : engine.capped ? 'Memory cap reached — refine the filters or export everything' : 'Heavy-duty mode: server-side paging'} · synced {relTime(engine.lastSync)}</span>
            </div>
          </section>
        )}
      </main>

      {open && engine && (() => {
        const i = engine.rows.findIndex((r) => r.__id === open.__id)
        return <Drawer engine={engine} row={open} index={Math.max(0, i)} onClose={() => setOpen(null)} onNav={(d) => { const n = engine.rows[i + d]; if (n) setOpen(n) }} />
      })()}
      {exp && engine && src && <ExportDialog engine={engine} cols={cols} selected={selected} title={src.label} initial={exp} onClose={() => setExp(null)} />}
      {palette && <Palette cmds={cmds} onClose={() => setPalette(false)} />}
    </div>
  )
}

const noopSub = () => () => {}
const zero = () => 0
