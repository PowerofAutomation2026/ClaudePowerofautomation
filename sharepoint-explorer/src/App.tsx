import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Engine, LOCAL_MAX } from './engine'
import { chooseBackend } from './services'
import type { Access, AppConfig, Backend, Clause, Query, Role, Row, SourceConfig, SpField, ViewDef } from './types'
import { roleLabel } from './access'
import { ItemPanel } from './components/ItemPanel'
import { ActionMenu, Breadcrumb, FolderPicker, NameDialog, UploadDialog, collectDropped, fromPicker, type MenuItem, type UploadItem } from './components/Library'
import { PermissionsDialog } from './components/Permissions'
import { BulkDialog, SearchEverywhere } from './components/Tools'
import { downloadUrl, itemUrl, openShareDialog } from './components/Drawer'
import { FolderIcon } from './components/FileGlyph'
import { Board } from './components/Board'
import type { PermTarget } from './types'
import { ViewsMenu } from './components/ViewsMenu'
import { searchTokens } from './query'
import { fmt, lsGet, lsSet, relTime, sameUser, uid } from './util'
import { Connect } from './components/Connect'
import { Dashboard } from './components/Dashboard'
import { Drawer } from './components/Drawer'
import { ExportDialog } from './components/ExportDialog'
import { FilterBar, useShortcuts } from './components/Filters'
import { Grid } from './components/Grid'
import { Palette, type Cmd } from './components/Palette'
import { Icon, Menu, Modal, Toaster, useToast } from './components/ui'
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
  const title = isLibrary ? 'FileLeafRef' : 'Title'
  const v = [...new Set([...loaded.filter((n) => n === title), ...loaded.filter((n) => !fields.find((f) => f.internal === n)?.system)])].slice(0, 8)
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
  const [view, setView] = useState<'table' | 'cards' | 'tiles' | 'board'>(lsGet('spx.view', 'table'))
  const [accent, setAccent] = useState<string>(lsGet('spx.accent', 'pnc'))
  const [favs, setFavs] = useState<Set<number>>(new Set())
  const [boardField, setBoardField] = useState<SpField | null>(null)
  const [visible, setVisible] = useState<string[]>([])
  const [widths, setWidths] = useState<Record<string, number>>({})
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [open, setOpen] = useState<Row | null>(null)
  const [palette, setPalette] = useState(false)
  const [exp, setExp] = useState<ExportFormat | null>(null)
  const [live, setLive] = useState<boolean>(lsGet('spx.live', false))
  const searchRef = useRef<HTMLInputElement>(null)
  const [access, setAccess] = useState<Access>({ role: 'reader', canAdd: false, canEdit: false, canDelete: false, canManage: false, groups: [], isSiteAdmin: false, reason: 'Checking your permissions…' })
  const [viewsAll, setViewsAll] = useState<{ shared: ViewDef[]; mine: ViewDef[] }>({ shared: [], mine: [] })
  const [panel, setPanel] = useState<{ row: Row | null } | null>(null)
  const [menu, setMenu] = useState<{ row: Row; at: DOMRect } | null>(null)
  const [uploads, setUploads] = useState<UploadItem[] | null>(null)
  const [nameDlg, setNameDlg] = useState<{ mode: 'folder' | 'rename'; row?: Row } | null>(null)
  const [picker, setPicker] = useState<{ mode: 'Move' | 'Copy'; row: Row } | null>(null)
  const [perm, setPerm] = useState<{ target: PermTarget; title: string } | null>(null)
  const [bulk, setBulk] = useState<Row[] | null>(null)
  const [everywhere, setEverywhere] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileIn = useRef<HTMLInputElement>(null)
  const dirIn = useRef<HTMLInputElement>(null)
  const [confirmDel, setConfirmDel] = useState<Row[] | null>(null)
  const [busy, setBusy] = useState(false)

  /* ------------------------------------------------ boot */
  useEffect(() => {
    (async () => {
      try {
        const backend = await chooseBackend()
        const [who, config] = await Promise.all([backend.whoAmI(), backend.loadConfig()])
        setBoot({ backend, who, config }); setConfig(config)
        backend.loadViews(who.upn).then(setViewsAll).catch(() => {})
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

  useEffect(() => { lsSet('spx.accent', accent); document.documentElement.dataset.accent = accent }, [accent])

  /* ------------------------------------------------ opening a source */
  const openSource = useCallback(async (s: SourceConfig, goTab?: Tab) => {
    if (!boot) return
    setLoadingSrc(true); setSrcErr(''); setSelected(new Set()); setOpen(null)
    engine?.dispose()
    try {
      const [fields, list] = await Promise.all([boot.backend.getFields(s.siteUrl, s.listId), boot.backend.getList(s.siteUrl, s.listId).catch(() => null)])
      const cur: SourceConfig = { ...s, itemCount: list?.itemCount ?? s.itemCount, url: s.url ?? list?.url }
      const select = pickColumns(fields, cur.isLibrary)
      const eng = new Engine(boot.backend, cur, fields, select)
      const vis = lsGet<string[]>(`spx.cols.${s.id}`, []).filter((n) => select.includes(n))
      setVisible(vis.length ? vis : defaultVisible(fields, select, cur.isLibrary))
      setWidths(lsGet(`spx.w.${s.id}`, {}))
      setFavs(new Set(lsGet<number[]>(`spx.fav.${s.id}`, [])))
      setBoardField(fields.find((f) => f.kind === 'choice' && select.includes(f.internal) && (f.choices?.length ?? 0) > 1) ?? null)
      setSrc(cur); setEngine(eng); lsSet('spx.active', s.id)
      boot.backend.getAccess(cur, config!, boot.who.upn).then(setAccess).catch(() => setAccess((a) => ({ ...a, role: 'reader', canAdd: false, canEdit: false, canDelete: false, canManage: false, reason: 'Could not read your permissions: read-only.' })))
      if (goTab) setTab(goTab)
      void eng.start()
    } catch (e) { setSrcErr((e as Error).message); setEngine(null) } finally { setLoadingSrc(false) }
  }, [boot, engine, config])

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

  /* ------------------------------------------------ views (personal + shared with audience) */
  const srcViews = useMemo(() => [...viewsAll.shared, ...viewsAll.mine].filter((v) => v.sourceId === src?.id), [viewsAll, src])
  const saveView = async (name: string, audience: ViewDef['audience'], groups: string[]) => {
    if (!engine || !src || !boot) return
    const v: ViewDef = { id: uid(), name, sourceId: src.id, q: engine.q, cols: visible, layout: view, owner: boot.who.upn, audience, groups, created: new Date().toISOString() }
    try {
      if (audience === 'me') { const mine = [...viewsAll.mine, v]; setViewsAll((c) => ({ ...c, mine })); const where = await boot.backend.saveMine(boot.who.upn, mine); toast('good', `View “${name}” saved${where === 'device' ? ' on this device' : ''}`) }
      else { const shared = [...viewsAll.shared, v]; await boot.backend.saveShared(shared); setViewsAll((c) => ({ ...c, shared })); toast('good', `View “${name}” shared`) }
    } catch (e) { toast('bad', `Could not save the view: ${(e as Error).message}`) }
  }
  const deleteView = async (v: ViewDef) => {
    if (!boot) return
    try {
      if (v.audience === 'me') { const mine = viewsAll.mine.filter((x) => x.id !== v.id); setViewsAll((c) => ({ ...c, mine })); await boot.backend.saveMine(boot.who.upn, mine) }
      else { const shared = viewsAll.shared.filter((x) => x.id !== v.id); await boot.backend.saveShared(shared); setViewsAll((c) => ({ ...c, shared })) }
    } catch (e) { toast('bad', (e as Error).message) }
  }
  const applyView = (v: ViewDef) => { setVisible(v.cols.filter((c) => engine?.select.includes(c))); setView(v.layout); change(v.q) }

  /* ------------------------------------------------ writing data (permission-gated; SharePoint enforces it again) */
  const saveItem = async (id: number | null, values: Record<string, unknown>, files: File[], again: boolean) => {
    if (!engine || !boot) return
    let rid = id
    if (id == null) rid = await boot.backend.createItem(engine.src, engine.fields, values)
    else if (Object.keys(values).length) await boot.backend.updateItem(engine.src, engine.fields, id, values)
    let failed = 0
    for (const f of files) { try { await boot.backend.addAttachment(engine.src, rid!, f) } catch { failed++ } }
    if (id != null) { const fresh = await boot.backend.getItem(engine.src, engine.fields, id); if (fresh) engine.patchRow(fresh) } else void engine.refresh()
    toast(failed ? 'warn' : 'good', id == null ? 'Item created' : 'Saved' + (failed ? ` — ${failed} attachment(s) failed` : ''))
    if (!again) { setPanel(null); if (id != null) setOpen((o) => o) }
  }
  const toggleFav = (id: number) => setFavs((cur) => { const n = new Set(cur); n.has(id) ? n.delete(id) : n.add(id); if (src) lsSet(`spx.fav.${src.id}`, [...n]); return n })
  const favActive = !!engine?.q.clauses.some((c) => c.field === 'ID' && c.op === 'in')
  const toggleFavFilter = () => { if (!engine) return; const rest = engine.q.clauses.filter((c) => !(c.field === 'ID' && c.op === 'in')); change({ clauses: favActive ? rest : [...rest, { field: 'ID', op: 'in', value: `★ Favorites (${favs.size})`, values: [...favs].slice(0, 100).map(String) }] }) }
  const moveCard = async (row: Row, value: string) => {
    if (!engine || !boot || !boardField) return
    const prev = row[boardField.internal]
    engine.patchRow({ ...row, [boardField.internal]: value })   // optimistic: the card jumps immediately
    try { await boot.backend.updateItem(engine.src, engine.fields, row.__id, { [boardField.internal]: value }); toast('good', value ? `Moved to ${value}` : 'Cleared') }
    catch (e) { engine.patchRow({ ...row, [boardField.internal]: prev }); toast('bad', `Could not move the card: ${(e as Error).message}`) }
  }
  const inlineSave = async (row: Row, f: SpField, value: unknown) => {
    if (!engine || !boot) return
    await boot.backend.updateItem(engine.src, engine.fields, row.__id, { [f.internal]: value })
    engine.patchRow({ ...row, [f.internal]: value })
    toast('good', `${f.title} updated`)
  }
  const libRoot = src?.url ?? ''
  const curFolder = engine?.q.folder ?? libRoot
  const origin = src ? new URL(src.siteUrl).origin : ''
  const rowName = (r: Row) => String(r.FileLeafRef ?? r.Title ?? `#${r.__id}`)
  const openRow = (r: Row) => { if (src?.isLibrary && r.FSObjType === 1 && r.FileRef) { engine?.openFolder(String(r.FileRef)); setSelected(new Set()) } else setOpen(r) }
  const actionsFor = (r: Row): MenuItem[] => {
    if (!engine || !src) return []
    const isFolder = r.FSObjType === 1, lib = src.isLibrary
    return [
      { label: isFolder ? 'Open folder' : 'Details', icon: isFolder ? <FolderIcon size={16} /> : 'info', run: () => openRow(r) },
      { label: lib ? 'Edit properties' : 'Edit item', icon: '✎', hidden: !access.canEdit, run: () => setPanel({ row: r }) },
      { label: 'Rename', icon: 'A', hidden: !(lib && access.canEdit), run: () => setNameDlg({ mode: 'rename', row: r }) },
      { label: 'Move to…', icon: '↦', hidden: !(lib && access.canEdit), run: () => setPicker({ mode: 'Move', row: r }) },
      { label: 'Copy to…', icon: 'copy', hidden: !(lib && access.canEdit && !isFolder), run: () => setPicker({ mode: 'Copy', row: r }) },
      { label: 'Download', icon: 'download', hidden: !(lib && !isFolder), run: () => window.open(downloadUrl(engine, r), '_blank', 'noopener') },
      { label: favs.has(r.__id) ? 'Remove favorite' : 'Add to favorites', icon: 'star', run: () => toggleFav(r.__id) },
      { label: 'Share…', icon: 'share', run: () => { if (!openShareDialog(engine, r)) toast('warn', 'Pop-up blocked: allow pop-ups for this site to open SharePoint’s Share dialog.') } },
      { label: 'Copy link', icon: 'copy', run: () => navigator.clipboard?.writeText(itemUrl(engine, r)).then(() => toast('good', 'Link copied')) },
      { label: access.canManage ? 'Manage access' : 'Who has access', icon: 'lock', sep: true, run: () => setPerm({ target: { kind: 'item', id: r.__id, name: rowName(r) }, title: rowName(r) }) },
      { label: 'Delete', icon: 'trash', danger: true, sep: true, hidden: !access.canDelete, run: () => setConfirmDel([r]) },
    ]
  }
  const startUpload = (items: UploadItem[]) => { if (items.length) setUploads(items) }
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    if (!src?.isLibrary || !access.canAdd) { toast('warn', access.canAdd ? 'Drop files onto a library to upload.' : 'You have read-only access.'); return }
    startUpload(await collectDropped(e.dataTransfer))
  }
  const deleteRows = async () => {
    if (!engine || !boot || !confirmDel) return
    setBusy(true); let ok = 0
    try { for (const r of confirmDel) { await boot.backend.deleteItem(engine.src, r.__id); engine.removeRow(r.__id); ok++ } toast('good', `${ok} item${ok === 1 ? '' : 's'} moved to the recycle bin`) }
    catch (e) { toast('bad', `Stopped after ${ok}: ${(e as Error).message}`) }
    finally { setBusy(false); setConfirmDel(null); setOpen(null); setSelected(new Set()) }
  }

  /* ------------------------------------------------ shortcuts + palette */
  useShortcuts({
    '/': (e) => { e.preventDefault(); setTab('data'); setTimeout(() => searchRef.current?.focus(), 30) },
    'mod+k': (e) => { e.preventDefault(); setPalette(true) },
    'mod+shift+f': (e) => { e.preventDefault(); setEverywhere('') },
    n: (e) => { if (access.canAdd && src && !src.isLibrary && tab === 'data') { e.preventDefault(); setPanel({ row: null }) } },
  })
  const cmds: Cmd[] = useMemo(() => {
    const c: Cmd[] = [
      { id: 'dash', label: 'Go to Dashboard', icon: 'chart', run: () => setTab('dashboard') },
      { id: 'data', label: 'Go to Data', icon: 'table', run: () => setTab('data') },
      { id: 'conn', label: isOwner ? 'Connect a list or library' : 'Data source info', icon: 'plug', run: () => setTab('connect') },
      { id: 'every', label: 'Search everywhere (all lists + Power Platform community)', icon: 'search', run: () => setEverywhere('') },
      ...(access.canAdd && src && !src.isLibrary ? [{ id: 'new', label: 'New item', hint: 'N', icon: 'plus' as const, run: () => setPanel({ row: null }) }] : []),
      ...(access.canAdd && src?.isLibrary ? [{ id: 'nf', label: 'New folder', icon: 'lib' as const, run: () => setNameDlg({ mode: 'folder' }) }, { id: 'up', label: 'Upload files', icon: 'download' as const, run: () => fileIn.current?.click() }] : []),
      ...(access.canManage && src ? [{ id: 'acc', label: 'Manage access to this ' + (src.isLibrary ? 'library' : 'list'), icon: 'lock' as const, run: () => setPerm({ target: { kind: 'list' }, title: src.label }) }] : []),
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
  }, [config, live, view, isOwner, engine, access, src]) // eslint-disable-line react-hooks/exhaustive-deps

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
        <div className="brand" aria-label="PNC SharePoint Team — Explorer">
          <PncMark />
          <span className="brand-t"><b>PNC SharePoint Team</b><small>Explorer</small></span>
        </div>

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
        {engine && <span className={`pill ${access.role === 'admin' ? 'accent' : access.role === 'writer' ? 'good' : ''}`} title={access.reason} role="status"><Icon n={access.role === 'reader' ? 'lock' : 'check'} size={13} />{roleLabel(access.role)}</span>}
        {boot.backend.mode === 'demo' && (
          <Menu label={<span className="lbl-t">Try role</span>} icon="star">
            {(close) => <div role="group" aria-label="Demo role">{(['reader', 'writer', 'admin'] as Role[]).map((r) => <button key={r} role="menuitemradio" aria-checked={access.role === r} onClick={() => { close(); boot.backend.setRole?.(r); if (engine && src) boot.backend.getAccess(src, config, boot.who.upn).then(setAccess) }}>{roleLabel(r)}</button>)}</div>}
          </Menu>
        )}

        <button className="btn" aria-pressed={live} onClick={() => setLive(!live)} title="Live pulse: check for new and changed items every 20 seconds" disabled={!engine}>
          <span className={`live-dot${live ? '' : ' off'}`} aria-hidden="true" /><span className="lbl-t">Live</span>{live && engine && engine.pendingNew > 0 && <span className="pill accent">{engine.pendingNew}</span>}
        </button>
        <button className="btn" onClick={() => setEverywhere('')} title="Search every connected list and the Power Platform community (Ctrl+Shift+F)"><Icon n="search" /><span className="lbl-t">Search all</span></button>
        <button className="btn icon" onClick={() => setPalette(true)} aria-label="Command palette (Ctrl+K)" title="Command palette (Ctrl+K)"><Icon n="cmd" /></button>
        <Menu icon={theme === 'dark' ? 'moon' : theme === 'contrast' ? 'contrast' : 'sun'} label={<span className="sr-only">Display settings</span>}>
          {(close) => <div role="group" aria-label="Display settings">
            <div className="hd">Theme</div>
            {(['system', 'light', 'dark', 'contrast'] as const).map((t) => <button key={t} role="menuitemradio" aria-checked={theme === t} onClick={() => { setTheme(t); close() }}><Icon n={t === 'dark' ? 'moon' : t === 'contrast' ? 'contrast' : 'sun'} />{t === 'contrast' ? 'High contrast' : t[0].toUpperCase() + t.slice(1)}</button>)}
            <hr /><div className="hd">Accent colour</div>
            <div className="row" style={{ padding: '4px 10px', gap: 8 }} role="radiogroup" aria-label="Accent colour">{(['pnc', 'teal', 'violet', 'rose', 'emerald'] as const).map((a) => <button key={a} role="radio" aria-checked={accent === a} aria-label={a === 'pnc' ? 'PNC blue and orange' : a} className="swatch" data-sw={a} onClick={() => setAccent(a)} />)}</div>
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

        {!loadingSrc && tab === 'connect' && <Connect backend={boot.backend} config={config} isOwner={isOwner} who={boot.who} engine={engine} access={access} onSaved={onSaved} />}

        {!loadingSrc && tab !== 'connect' && !engine && (
          <div className="card empty"><Icon n="plug" size={44} /><h2>No list or library connected yet</h2>
            <p className="muted">{isOwner ? 'Press Connect to choose the SharePoint list or library this app should show.' : 'The app owner has not connected a list or library yet.'}</p>
            {isOwner && <button className="btn primary big" onClick={() => setTab('connect')}><Icon n="plug" />Connect</button>}
          </div>
        )}

        {!loadingSrc && engine && src && tab === 'dashboard' && (
          <DashHero name={boot.who.name} src={src} total={total} access={access} onData={() => setTab('data')} onNew={() => (src.isLibrary ? fileIn.current?.click() : setPanel({ row: null }))} onSearch={() => setEverywhere('')} onAccess={() => setPerm({ target: { kind: 'list' }, title: src.label })} />
        )}
        {!loadingSrc && engine && src && tab === 'dashboard' && (
          <Dashboard engine={engine} version={ver} title={src.label} onFilter={addClause} onGoData={() => setTab('data')} />
        )}

        {!loadingSrc && engine && src && tab === 'data' && (
          <section aria-label="Data">
            {engine.error && <div className="banner bad" role="alert"><Icon n="info" /><div style={{ flex: 1 }}>{engine.error}</div><button className="btn sm" onClick={() => void engine.refresh()}>Retry</button></div>}
            {src.isLibrary && src.url && (
              <div className="row" style={{ marginBottom: 8, minHeight: 34 }}>
                {engine.q.folder
                  ? (engine.q.search || engine.q.clauses.length ? <span className="pill accent">Searching the whole library — clear the search to return to folders</span> : <Breadcrumb root={libRoot} rootLabel={src.label} path={engine.q.folder} onGo={(p) => { engine.openFolder(p); setSelected(new Set()) }} />)
                  : <span className="pill">All files in {src.label}, every folder</span>}
                {access.canAdd && <span className="muted small">Drag files or folders here to upload</span>}
              </div>
            )}
            <FilterBar engine={engine} version={ver} fields={engine.fields.filter((f) => engine.select.includes(f.internal))} searchRef={searchRef} onChange={change} />
            <div className="bar">
              <span className="muted" role="status">
                {engine.mode === 'local'
                  ? <><b>{fmt(engine.rows.length)}</b> of {fmt(engine.all.length)} items{engine.loading ? ` (loading ${Math.round(engine.progress * 100)}%…)` : ''}</>
                  : <><b>{fmt(engine.rows.length)}</b> loaded · list has {fmt(total)} items{engine.loading ? ' · loading…' : ''}</>}
              </span>
              {engine.pendingNew > 0 && <button className="btn sm primary" onClick={() => engine.absorbNew()}><Icon n="refresh" size={14} />{engine.pendingNew} new — show</button>}
              <span className="grow" />
              {access.canAdd && !src.isLibrary && <button className="btn sm primary" onClick={() => setPanel({ row: null })}><Icon n="plus" size={14} />New item</button>}
              {access.canAdd && src.isLibrary && (
                <Menu icon="plus" label={<span><b>New</b></span>}>
                  {(close) => <div>
                    <button onClick={() => { close(); setNameDlg({ mode: 'folder' }) }}><FolderIcon size={18} />Folder</button>
                    <button onClick={() => { close(); fileIn.current?.click() }}><Icon n="download" size={16} />Upload files…</button>
                    <button onClick={() => { close(); dirIn.current?.click() }}><Icon n="lib" size={16} />Upload folder…</button>
                  </div>}
                </Menu>
              )}
              {favs.size > 0 && <button className="btn sm" aria-pressed={favActive} onClick={toggleFavFilter}><Icon n="star" size={14} />Favorites <span className="pill">{favs.size}</span></button>}
              {access.canEdit && selected.size > 1 && <button className="btn sm" onClick={() => setBulk(engine.rows.filter((r) => selected.has(r.__id)))}>✎ Edit {selected.size}</button>}
              {(access.canManage || access.role === 'admin') && <button className="btn sm" onClick={() => setPerm({ target: { kind: 'list' }, title: src.label })}><Icon n="lock" size={14} />Access</button>}
              {access.canDelete && selected.size > 0 && <button className="btn sm danger" onClick={() => setConfirmDel(engine.rows.filter((r) => selected.has(r.__id)))}><Icon n="trash" size={14} />Delete {selected.size}</button>}
              {src.isLibrary && src.url && (
                <div role="group" aria-label="Library layout" className="row" style={{ gap: 2 }}>
                  <button className="btn sm" aria-pressed={!!engine.q.folder} onClick={() => engine.setBrowse(true)}><FolderIcon size={15} />Folders</button>
                  <button className="btn sm" aria-pressed={!engine.q.folder} onClick={() => engine.setBrowse(false)}><Icon n="list" size={14} />All files</button>
                </div>
              )}
              <ViewsMenu views={srcViews} access={access} cfg={config} upn={boot.who.upn} onApply={applyView} onSave={saveView} onDelete={(v) => void deleteView(v)} />
              <Menu icon="cols" label={<span className="lbl-t">Columns</span>}>
                {() => <div role="group" aria-label="Visible columns">{engine.select.map((n) => { const f = engine.fields.find((x) => x.internal === n)!; return <label key={n} className="item"><input type="checkbox" checked={visible.includes(n)} onChange={() => toggleCol(n)} />{f.title}</label> })}</div>}
              </Menu>
              <div role="group" aria-label="Layout" className="row" style={{ gap: 2 }}>
                <button className="btn icon" aria-pressed={view === 'table'} aria-label="Table view" onClick={() => { setView('table'); lsSet('spx.view', 'table') }}><Icon n="table" /></button>
                <button className="btn icon" aria-pressed={view === 'cards'} aria-label="Card view" onClick={() => { setView('cards'); lsSet('spx.view', 'cards') }}><Icon n="cards" /></button>
                {!src.isLibrary && boardField && <button className="btn icon" aria-pressed={view === 'board'} aria-label="Board view" title="Board (Kanban)" onClick={() => { setView('board'); lsSet('spx.view', 'board') }}><Icon n="board" /></button>}
                {src.isLibrary && <button className="btn icon" aria-pressed={view === 'tiles'} aria-label="Tile view" onClick={() => { setView('tiles'); lsSet('spx.view', 'tiles') }}><Icon n="grid" /></button>}
              </div>
              <Menu icon="download" label={<span className="lbl-t">Export</span>}>
                {(close) => <div>{(['csv', 'json', 'pdf'] as const).map((f) => <button key={f} onClick={() => { close(); setExp(f) }}><Icon n="download" />{f.toUpperCase()}{f === 'pdf' && <span className="muted small" style={{ marginLeft: 'auto' }}>report</span>}</button>)}</div>}
              </Menu>
            </div>

            <div className="dropzone" onDragOver={(e) => { if (src.isLibrary && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true) } }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false) }} onDrop={(e) => void onDrop(e)}>
              {dragging && <div className="dropveil" role="status"><div><FolderIcon size={44} /><div>Drop to upload to <b>{decodeURIComponent(curFolder.split('/').pop() ?? '')}</b></div></div></div>}
              {view === 'board' && !src.isLibrary && boardField
                ? <Board engine={engine} version={ver} field={boardField} setField={setBoardField} canEdit={access.canEdit} favs={favs} onToggleFav={toggleFav} onMove={moveCard} onOpen={openRow} tokens={tokens} />
                : <Grid engine={engine} version={ver} cols={cols} selected={selected} widths={widths} setWidth={setWidth} tokens={tokens} view={view === 'board' ? 'table' : src.isLibrary || view !== 'tiles' ? view : 'table'} isLibrary={src.isLibrary} origin={boot.backend.mode === 'live' ? origin : undefined}
                onToggle={(id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })}
                onToggleAll={() => setSelected((s) => (engine.rows.every((r) => s.has(r.__id)) ? new Set() : new Set(engine.rows.map((r) => r.__id))))}
                onOpen={openRow} onSort={sortBy} onMenu={(row, at) => setMenu({ row, at })} />}
            </div>
            <div className="gfoot" style={{ borderRadius: 12, border: '1px solid var(--line)', marginTop: 8 }}>
              <span>{selected.size ? <b>{fmt(selected.size)} selected</b> : 'Click a row for details · ↑↓ to move · Space to select'}</span>
              {engine.mode === 'server' && <label className="row" style={{ flex: 1, minWidth: 220 }}>Jump
                <input type="range" min={0} max={100} defaultValue={0} aria-label="Jump to position in list" style={{ flex: 1 }} onChange={(e) => engine.seek(Number(e.target.value) / 100)} />
              </label>}
              <span className="muted">{engine.mode === 'local' ? `In-memory mode (≤ ${fmt(LOCAL_MAX)} items)` : engine.capped ? 'Memory cap reached — refine the filters or export everything' : 'Heavy-duty mode: server-side paging'} · synced {relTime(engine.lastSync)}</span>
            </div>
          </section>
        )}
      {menu && engine && <ActionMenu at={menu.at} title={rowName(menu.row)} items={actionsFor(menu.row)} onClose={() => setMenu(null)} />}
      </main>

      {open && engine && (() => {
        const i = engine.rows.findIndex((r) => r.__id === open.__id)
        return <Drawer engine={engine} row={open} index={Math.max(0, i)} access={access} fav={favs.has(open.__id)} onFav={() => toggleFav(open.__id)} onInline={inlineSave} actions={actionsFor(open).filter((a) => a.label !== 'Details' && a.label !== 'Copy link' && a.label !== 'Download')} onClose={() => setOpen(null)} onNav={(d) => { const n = engine.rows[i + d]; if (n) setOpen(n) }} />
      })()}
      {exp && engine && src && <ExportDialog engine={engine} cols={cols} selected={selected} title={src.label} initial={exp} onClose={() => setExp(null)} />}
      {panel && engine && <ItemPanel engine={engine} row={panel.row} onClose={() => setPanel(null)} onSave={(v, f, again) => saveItem(panel.row ? panel.row.__id : null, v, f, again)} />}
      {uploads && engine && src && <UploadDialog backend={boot.backend} src={src} dest={curFolder} items={uploads} onClose={() => setUploads(null)} onDone={() => void engine.refresh()} />}
      {nameDlg && engine && src && (nameDlg.mode === 'folder'
        ? <NameDialog title="New folder" label="Folder name" cta="Create" onClose={() => setNameDlg(null)} onSubmit={async (n) => { await boot.backend.createFolder(src, curFolder, n); toast('good', `Folder “${n}” created`); void engine.refresh() }} />
        : <NameDialog title={nameDlg.row?.FSObjType === 1 ? 'Rename folder' : 'Rename file'} label="New name" initial={rowName(nameDlg.row!)} cta="Rename" onClose={() => setNameDlg(null)} onSubmit={async (n) => { await boot.backend.renameItem(src, engine.fields, nameDlg.row!.__id, n); toast('good', 'Renamed'); void engine.refresh() }} />)}
      {picker && engine && src && <FolderPicker backend={boot.backend} src={src} root={libRoot} start={curFolder} title={`${picker.mode} “${rowName(picker.row)}” to…`} onClose={() => setPicker(null)}
        onPick={async (dest) => { const m = picker; setPicker(null); try { await (m.mode === 'Move' ? boot.backend.moveItem(src, m.row, dest) : boot.backend.copyItem(src, m.row, dest)); toast('good', `${m.mode === 'Move' ? 'Moved' : 'Copied'} to ${decodeURIComponent(dest.split('/').pop() ?? '')}`); void engine.refresh() } catch (e) { toast('bad', (e as Error).message) } }} />}
      {perm && engine && src && <PermissionsDialog backend={boot.backend} src={src} target={perm.target} title={perm.title} canManage={access.canManage} onClose={() => setPerm(null)} />}
      {bulk && engine && <BulkDialog engine={engine} rows={bulk} onClose={() => setBulk(null)} onDone={() => { setBulk(null); setSelected(new Set()) }} />}
      {everywhere !== null && config && <SearchEverywhere backend={boot.backend} sources={config.sources} initial={everywhere} onClose={() => setEverywhere(null)} onOpen={async (s, q) => { if (s.id !== src?.id) await openSource(s, 'data'); else setTab('data'); setTimeout(() => engine && change({ search: q }), 300) }} />}
      <input ref={fileIn} type="file" multiple hidden onChange={(e) => { if (e.target.files) startUpload(Array.from(e.target.files).map((file) => ({ file, rel: '' }))); e.target.value = '' }} />
      <input ref={dirIn} type="file" hidden {...({ webkitdirectory: '', directory: '' } as object)} onChange={(e) => { if (e.target.files) startUpload(fromPicker(e.target.files)); e.target.value = '' }} />
      {confirmDel && (
        <Modal title="Confirm delete" onClose={() => setConfirmDel(null)}>
          <h2 style={{ marginBottom: 8 }}>Delete {confirmDel.length} item{confirmDel.length === 1 ? '' : 's'}?</h2>
          <p className="muted">They move to the SharePoint recycle bin, where they can be restored.</p>
          <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={() => setConfirmDel(null)}>Cancel</button><button className="btn primary" style={{ background: 'var(--bad)' }} disabled={busy} onClick={() => void deleteRows()}>{busy ? 'Deleting…' : 'Delete'}</button></div>
        </Modal>
      )}
      {palette && <Palette cmds={cmds} onClose={() => setPalette(false)} />}
    </div>
  )
}

function DashHero({ name, src, total, access, onData, onNew, onSearch, onAccess }: { name: string; src: SourceConfig; total: number; access: Access; onData: () => void; onNew: () => void; onSearch: () => void; onAccess: () => void }) {
  const h = new Date().getHours()
  const hi = h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
  return (
    <section className="hero2" aria-label="Welcome">
      <div>
        <div className="hero2-k">{src.isLibrary ? 'Document library' : 'List'} · {roleLabel(access.role)}</div>
        <h2>{hi}{name ? `, ${name.split(' ')[0]}` : ''} 👋</h2>
        <p>{fmt(total)} items in <b>{src.label}</b>. Search, filter, edit and share — everything updates live.</p>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn big hero-btn" onClick={onData}><Icon n="table" />Open {src.isLibrary ? 'files' : 'items'}</button>
          {access.canAdd && <button className="btn big hero-btn ghosty" onClick={onNew}><Icon n="plus" />{src.isLibrary ? 'Upload' : 'New item'}</button>}
          <button className="btn big hero-btn ghosty" onClick={onSearch}><Icon n="search" />Search all</button>
          {(access.canManage || access.role === 'admin') && <button className="btn big hero-btn ghosty" onClick={onAccess}><Icon n="lock" />Access</button>}
        </div>
      </div>
      <svg className="hero2-art" viewBox="0 0 200 120" aria-hidden="true"><rect x="10" y="20" width="110" height="80" rx="12" fill="#fff" opacity=".18" /><rect x="40" y="8" width="110" height="80" rx="12" fill="#fff" opacity=".28" /><rect x="72" y="34" width="110" height="80" rx="12" fill="#fff" opacity=".9" /><rect x="86" y="50" width="60" height="8" rx="4" fill="#0b3f78" /><rect x="86" y="68" width="82" height="6" rx="3" fill="#f58025" /><rect x="86" y="82" width="70" height="6" rx="3" fill="#0b3f78" opacity=".35" /></svg>
    </section>
  )
}

function PncMark() {
  return (
    <svg className="pnc-mark" width="38" height="38" viewBox="0 0 38 38" role="img" aria-label="PNC">
      <rect width="38" height="38" rx="9" fill="#0B3F78" />
      <path d="M0 26h38v3a9 9 0 0 1-9 9H9a9 9 0 0 1-9-9v-3Z" fill="#F58025" />
      <text x="19" y="21" textAnchor="middle" fontFamily="Segoe UI, Arial, sans-serif" fontWeight="800" fontSize="13" fill="#fff">PNC</text>
    </svg>
  )
}
const noopSub = () => () => {}
const zero = () => 0
