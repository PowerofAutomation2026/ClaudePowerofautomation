import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentCategory, Asset, AssetKind, AuditEntry, Backend, Env, ItemStatus, Person, ScanNote, TransferOptions } from './types'
import { hasConnectors, pickBackend } from './services'
import { ago, assetRows, auditRows, download, explainTransferError, isPartialUpdate, powershellFor, risksFor, toCsv } from './util'

const ls = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d } catch { return d } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* ignore */ } },
}

/** Crash forensics: remember what we were doing; if the tab dies (e.g. out of memory) the next load reports where. */
const crumb = {
  set(step: string) { ls.set('occ.crumb', { step, at: Date.now(), busy: true }) },
  clear() { ls.set('occ.crumb', { busy: false }) },
}

type SortKey = 'name' | 'kind' | 'envName' | 'state' | 'modifiedTime'
type Panel = null | 'transfer' | 'history' | 'diag'


const KIND_UI: Record<AssetKind, { label: string; plural: string; icon: string }> = {
  app: { label: 'App', plural: 'Apps', icon: '📱' },
  flow: { label: 'Flow', plural: 'Flows', icon: '⚡' },
  agent: { label: 'Agent', plural: 'Agents', icon: '🤖' },
}
const CAT_LABEL: Record<AgentCategory, string> = { agent: 'Copilot Studio agent', agentbuilder: 'Agent Builder', tool: 'Tool', mcp: 'MCP', cli: 'CLI agent', other: 'Other' }

function useCountUp(target: number) {
  const [v, setV] = useState(0)
  useEffect(() => {
    let raf = 0
    const t0 = performance.now()
    const step = (t: number) => { const p = Math.min(1, (t - t0) / 650); setV(Math.round(target * (1 - Math.pow(1 - p, 3)))); if (p < 1) raf = requestAnimationFrame(step) }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target])
  return v
}
const Num = ({ n }: { n: number }) => <>{useCountUp(n)}</>

function Avatar({ name }: { name: string }) {
  const initials = name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join('') || '?'
  return <div className="avatar" aria-hidden>{initials}</div>
}

/** Part-to-whole: one stacked bar, 2px gaps, direct count labels + a legend (identity never colour-only). */
function MixBar({ counts, active, onPick }: { counts: Record<AssetKind, number>; active: 'all' | AssetKind; onPick: (k: 'all' | AssetKind) => void }) {
  const total = counts.app + counts.flow + counts.agent
  const kinds = (['app', 'flow', 'agent'] as const).filter((k) => counts[k] > 0)
  if (!total) return null
  return (
    <div className="mix">
      <div className="mixbar" role="img" aria-label={`Mix of ${total} items: ${kinds.map((k) => `${counts[k]} ${KIND_UI[k].plural.toLowerCase()}`).join(', ')}`}>
        {kinds.map((k) => (
          <button key={k} className={`seg-${k}${active === k ? ' on' : ''}`} style={{ flexGrow: counts[k] }} title={`${KIND_UI[k].plural}: ${counts[k]} (${Math.round((counts[k] / total) * 100)}%) – click to filter`}
            onClick={() => onPick(active === k ? 'all' : k)}>
            <span>{KIND_UI[k].icon} {counts[k]}</span>
          </button>))}
      </div>
      <div className="mixlegend">
        {kinds.map((k) => <span key={k}><i className={`sw-${k}`} />{KIND_UI[k].plural} <b>{counts[k]}</b> <em>{Math.round((counts[k] / total) * 100)}%</em></span>)}
      </div>
    </div>)
}

export default function App() {
  const [theme, setTheme] = useState<string>(() => ls.get('occ.theme', 'dark'))
  const [demo, setDemo] = useState<boolean>(() => ls.get('occ.demo', !hasConnectors))
  const backend: Backend = useMemo(() => pickBackend(demo), [demo])

  const [envs, setEnvs] = useState<Env[]>([])
  const [envScope, setEnvScope] = useState<string[]>([]) // empty = all
  const [email, setEmail] = useState('')
  const [user, setUser] = useState<Person | null>(null)
  const [allAssets, setAssets] = useState<Asset[]>([])
  const [showOthers, setShowOthers] = useState(false)
  const [notes, setNotes] = useState<ScanNote[]>([])
  const [lastCrash, setLastCrash] = useState<{ step: string; at: number } | null>(() => { const c = ls.get<{ busy?: boolean; step?: string; at?: number }>('occ.crumb', {}); return c.busy && c.step ? { step: c.step, at: c.at ?? 0 } : null })
  const [showNotes, setShowNotes] = useState(false)
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [prog, setProg] = useState(0)
  const [recent, setRecent] = useState<string[]>(() => ls.get('occ.recent', []))

  const [q, setQ] = useState('')
  const [kind, setKind] = useState<'all' | AssetKind>('all')
  const [envFilter, setEnvFilter] = useState('all')
  const [stateFilter, setStateFilter] = useState('all')
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: 'name', dir: 1 })
  const [sel, setSel] = useState<Set<string>>(new Set())

  const [panel, setPanel] = useState<Panel>(null)
  const [audit, setAudit] = useState<AuditEntry[]>(() => ls.get('occ.audit', []))
  const [toast, setToast] = useState<string | null>(null)
  const [palette, setPalette] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => { document.documentElement.dataset.theme = theme; ls.set('occ.theme', theme) }, [theme])
  useEffect(() => { ls.set('occ.demo', demo) }, [demo])
  useEffect(() => { ls.set('occ.audit', audit.slice(-500)) }, [audit])
  useEffect(() => { crumb.clear() }, []) // reaching here means the page loaded; lastCrash was captured above
  const flash = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(null), 2600) }, [])

  useEffect(() => {
    setEnvs([]); setUser(null); setAssets([]); setSel(new Set()); setError(null)
    backend.listEnvironments().then(setEnvs).catch((e) => setError('Could not load environments: ' + (e as Error).message))
  }, [backend])

  const search = useCallback(async (em = email) => {
    const target = em.trim()
    if (!target) return
    setError(null); setLoading('Resolving user…'); setProg(0); setSel(new Set()); setAssets([]); setNotes([])
    try {
      const p = await backend.resolveUser(target)
      setUser(p)
      const scope = envScope.length ? envs.filter((e) => envScope.includes(e.id)) : envs
      crumb.set(`scanning ${p.email} (${scope.length} environment(s))`)
      const { assets: found, notes: scanNotes } = await backend.listAssets(p, scope, (d, t, name) => { crumb.set(`scanning ${name} for ${p.email}`); setProg(d / t); setLoading(`Scanning ${name} (${d}/${t})`) })
      crumb.clear()
      setAssets(found)
      setNotes(scanNotes)
      setShowNotes(scanNotes.some((n) => n.level !== 'info') || !found.some((a) => a.kind === 'flow'))
      const r = [p.email, ...recent.filter((x) => x !== p.email)].slice(0, 6)
      setRecent(r); ls.set('occ.recent', r)
      flash(`Found ${found.length} item(s) for ${p.name}`)
    } catch (e) { setError((e as Error).message); setUser(null) }
    finally { setLoading(null); crumb.clear() }
  }, [backend, email, envs, envScope, recent, flash])

  // Only real Copilot Studio agents by default; tools / MCP / Agent Builder / CLI items sit behind a toggle.
  const assets = useMemo(() => allAssets.filter((a) => showOthers || a.kind !== 'agent' || !a.category || a.category === 'agent'), [allAssets, showOthers])
  const hiddenCount = allAssets.length - assets.length
  const hiddenByCat = useMemo(() => {
    const m: Record<string, number> = {}
    allAssets.filter((a) => a.kind === 'agent' && a.category && a.category !== 'agent').forEach((a) => { m[a.category!] = (m[a.category!] ?? 0) + 1 })
    return m
  }, [allAssets])
  const counts = useMemo(() => ({ app: assets.filter((a) => a.kind === 'app').length, flow: assets.filter((a) => a.kind === 'flow').length, agent: assets.filter((a) => a.kind === 'agent').length }), [assets])

  const visible = useMemo(() => {
    const t = q.toLowerCase()
    const list = assets.filter((a) =>
      (kind === 'all' || a.kind === kind) && (envFilter === 'all' || a.envId === envFilter) &&
      (stateFilter === 'all' || a.state === stateFilter) && (!t || (a.name + a.id + a.envName).toLowerCase().includes(t)))
    return list.sort((a, b) => ((a[sort.k] ?? '') > (b[sort.k] ?? '') ? 1 : -1) * sort.dir)
  }, [assets, q, kind, envFilter, stateFilter, sort])

  const selected = useMemo(() => assets.filter((a) => sel.has(a.key)), [assets, sel])
  const toggle = (k: string) => setSel((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n })
  const allVisibleSelected = visible.length > 0 && visible.every((a) => sel.has(a.key))
  const selectVisible = () => setSel(allVisibleSelected ? new Set() : new Set(visible.map((a) => a.key)))
  const sortBy = (k: SortKey) => setSort((s) => ({ k, dir: s.k === k ? (s.dir === 1 ? -1 : 1) : 1 }))

  const byEnv = useMemo(() => {
    const m = new Map<string, { id: string; name: string; n: number }>()
    assets.forEach((a) => { const e = m.get(a.envId) ?? { id: a.envId, name: a.envName, n: 0 }; e.n++; m.set(a.envId, e) })
    return [...m.values()].sort((a, b) => b.n - a.n)
  }, [assets])
  const maxEnv = Math.max(1, ...byEnv.map((e) => e.n))
  const stale = assets.filter((a) => a.modifiedTime && Date.now() - new Date(a.modifiedTime).getTime() > 180 * 864e5).length

  // keyboard
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p) }
      else if (e.key === 'Escape') { setPalette(false); setPanel((p) => (p === 'transfer' && busyRef.current ? p : null)) }
      else if (e.key === '/' && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); searchRef.current?.focus() }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])
  const busyRef = useRef(false)

  const commands = [
    { label: 'Toggle dark / light theme', run: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) },
    { label: demo ? 'Switch to Live mode' : 'Switch to Demo mode', run: () => setDemo((d) => !d) },
    { label: 'Select all visible', run: selectVisible },
    { label: 'Select all apps', run: () => setSel(new Set(assets.filter((a) => a.kind === 'app').map((a) => a.key))) },
    { label: 'Select all flows', run: () => setSel(new Set(assets.filter((a) => a.kind === 'flow').map((a) => a.key))) },
    { label: 'Select all Copilot Studio agents', run: () => setSel(new Set(assets.filter((a) => a.kind === 'agent').map((a) => a.key))) },
    { label: 'Show scan report', run: () => setShowNotes(true) },
    { label: 'Select stale items (no changes in 6 months)', run: () => setSel(new Set(assets.filter((a) => a.modifiedTime && Date.now() - new Date(a.modifiedTime).getTime() > 180 * 864e5).map((a) => a.key))) },
    { label: 'Transfer selected…', run: () => selected.length && setPanel('transfer') },
    { label: 'Transfer EVERYTHING…', run: () => { setSel(new Set(assets.map((a) => a.key))); setPanel('transfer') } },
    { label: 'Export inventory (CSV)', run: () => download('inventory.csv', toCsv(assetRows(visible)), 'text/csv') },
    { label: 'Open history', run: () => setPanel('history') },
    { label: 'Connector diagnostics', run: () => setPanel('diag') },
  ]

  return (
    <div className="app">
      <div className="aurora" aria-hidden />
      <header className="top">
        <div className="logo">🛡️</div>
        <div><h1>Ownership <span className="grad">Command Center</span></h1><div className="sub">Find &amp; transfer Power Apps, Flows and Copilot Studio agents across every environment · no app registration</div></div>
        <div className="spacer" />
        <span className="pill mut" title="Build running in this tab - if it is old, hard-refresh (Ctrl+Shift+R)">{__BUILD__}</span>
        <span className={`pill ${demo ? 'warn' : 'ok'}`}>{demo ? 'DEMO DATA' : 'LIVE'}</span>
        <button className="btn sm" onClick={() => setPalette(true)}>⌘ <kbd>Ctrl K</kbd></button>
        <button className="btn sm" onClick={() => setPanel('history')}>🕘 History ({audit.filter((a) => !a.dryRun).length})</button>
        <button className="btn sm" onClick={() => setPanel('diag')}>🩺</button>
        <button className="btn sm" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☀️' : '🌙'}</button>
      </header>

      {lastCrash && <div className="banner" style={{ borderColor: 'var(--bad)', color: 'var(--bad)', background: 'rgba(251,113,133,.08)' }}>
        Last time this page stopped unexpectedly while <b>{lastCrash.step}</b>{lastCrash.at ? ` (${new Date(lastCrash.at).toLocaleTimeString()})` : ''}. Likely too much data for the browser tab:
        scan <b>one environment at a time</b> (use the dropdown) and close other tabs. <a href="#" style={{ color: 'inherit' }} onClick={(e) => { e.preventDefault(); setLastCrash(null) }}>Dismiss</a></div>}
      {!hasConnectors && !demo && <div className="banner">No connectors found in this build. Run the deploy script (it adds them), or switch to Demo mode.</div>}
      {demo && <div className="banner" style={{ borderColor: 'var(--accent)', color: 'var(--accent2)', background: 'rgba(124,92,255,.08)' }}>Demo mode – sample tenant, nothing is changed. Try <b>alex.morgan@contoso.com</b>.{' '}
        <a href="#" onClick={(e) => { e.preventDefault(); setDemo(false) }} style={{ color: 'inherit' }}>Go live</a></div>}

      <section className="card">
        <form className="search" onSubmit={(e) => { e.preventDefault(); search() }}>
          <input ref={searchRef} className="email" type="email" placeholder="Enter user email (press / to focus) — e.g. alex.morgan@contoso.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select value={envScope.length === 1 ? envScope[0] : ''} onChange={(e) => setEnvScope(e.target.value ? [e.target.value] : [])}>
            <option value="">All environments ({envs.length})</option>
            {envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <button className="btn primary" disabled={!!loading || !email.trim() || !envs.length}>{loading ? <span className="spin" /> : '🔎'} Scan</button>
        </form>
        {recent.length > 0 && <div className="chips">{recent.map((r) => <span key={r} className="chip" onClick={() => { setEmail(r); search(r) }}>{r}</span>)}</div>}
        {loading && <div style={{ marginTop: 14 }}><div className="sub"><span className="spin" /> {loading}</div><div className="progress"><i style={{ width: `${Math.max(4, prog * 100)}%` }} /></div>
          <div className="skeleton-row"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div></div>}
        {error && <div className="risk" style={{ marginTop: 10, color: 'var(--bad)' }}>⚠ {error} <button type="button" className="btn sm" onClick={() => setPanel('diag')}>🩺 Open diagnostics</button></div>}
      </section>

      {user && !loading && notes.length > 0 && (
        <section className="card" style={{ marginTop: 12 }}>
          <div className="row">
            <b>Scan report</b>
            <span className="pill mut">{notes.length} note(s)</span>
            {notes.some((n) => n.level === 'error') && <span className="pill bad">{notes.filter((n) => n.level === 'error').length} error(s)</span>}
            {notes.some((n) => n.level === 'warn') && <span className="pill warn">{notes.filter((n) => n.level === 'warn').length} warning(s)</span>}
            <div className="spacer" />
            <button className="btn sm" onClick={() => setShowNotes((v) => !v)}>{showNotes ? 'Hide' : 'Show'}</button>
            <button className="btn sm" onClick={() => navigator.clipboard?.writeText(notes.map((n) => `[${n.level}] ${n.env} / ${n.kind}: ${n.text}`).join('\n')).then(() => flash('Report copied'))}>Copy</button>
          </div>
          {showNotes && <div className="col" style={{ marginTop: 10 }}>{notes.map((n, i) => (
            <div key={i} className="item"><span className={`pill ${n.level === 'error' ? 'bad' : n.level === 'warn' ? 'warn' : 'mut'}`}>{n.level}</span>
              <div><div className="name">{n.env} · {n.kind}</div><div className="id" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{n.text}</div></div></div>))}</div>}
        </section>)}

      {user && !loading && (
        <>
          <section className="card hero">
            <Avatar name={user.name} />
            <div className="hero-id">
              <div className="hero-name">{user.name}</div>
              <div className="sub">{user.email}</div>
              <div className="sub">{allAssets.length ? `${assets.length} item(s) across ${byEnv.length} environment(s)` : 'Nothing owned in the scanned environments'}</div>
            </div>
            <MixBar counts={counts} active={kind} onPick={setKind} />
          </section>

          <div className="stats">
            <div className="card stat"><div className="ico">📦</div><div className="n"><Num n={assets.length} /></div><div className="l">Items owned</div></div>
            <div className="card stat t-app"><div className="ico">📱</div><div className="n"><Num n={counts.app} /></div><div className="l">Apps</div></div>
            <div className="card stat t-flow"><div className="ico">⚡</div><div className="n"><Num n={counts.flow} /></div><div className="l">Cloud flows</div></div>
            <div className="card stat t-agent"><div className="ico">🤖</div><div className="n"><Num n={counts.agent} /></div><div className="l">Copilot Studio agents</div></div>
            <div className="card stat"><div className="ico">🕸️</div><div className="n"><Num n={stale} /></div><div className="l">Stale &gt; 6 months</div></div>
            <div className="card envcard">
              <div className="l sub">BY ENVIRONMENT · click to filter</div>
              <div className="bars">{byEnv.map((e) => <div key={e.id} className={`bar${envFilter === e.id ? ' on' : ''}`} onClick={() => setEnvFilter(envFilter === e.id ? 'all' : e.id)}><span>{e.name}</span><i style={{ width: `${(e.n / maxEnv) * 100}%` }} /><b>{e.n}</b></div>)}</div>
            </div>
          </div>

          {hiddenCount > 0 && (
            <div className="banner hidden-note">
              🛈 <b>{hiddenCount}</b> other inventory item(s) are {showOthers ? 'shown' : 'hidden'} because they are <b>not Copilot Studio agents</b>
              ({Object.entries(hiddenByCat).map(([c, n]) => `${n} ${CAT_LABEL[c as AgentCategory] ?? c}`).join(', ')}).{' '}
              <a href="#" onClick={(e) => { e.preventDefault(); setShowOthers((v) => !v) }}>{showOthers ? 'Hide them' : 'Show them'}</a>
            </div>)}

          <div className="toolbar">
            <div className="seg">{(['all', 'app', 'flow', 'agent'] as const).map((k) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{k === 'all' ? '✨ All' : `${KIND_UI[k].icon} ${KIND_UI[k].plural}`} <em>{k === 'all' ? assets.length : counts[k]}</em></button>)}</div>
            <input placeholder="Filter by name…" value={q} onChange={(e) => setQ(e.target.value)} />
            <select value={envFilter} onChange={(e) => setEnvFilter(e.target.value)}><option value="all">Any environment</option>{byEnv.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
            <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}><option value="all">Any state</option>{['Started', 'Stopped', 'Suspended', 'Published'].map((s) => <option key={s}>{s}</option>)}</select>
            <div className="spacer" />
            <button className="btn sm" onClick={() => download('inventory.csv', toCsv(assetRows(visible)), 'text/csv')}>⬇ CSV</button>
            <button className="btn sm" onClick={() => download('inventory.json', JSON.stringify(visible, null, 2), 'application/json')}>⬇ JSON</button>
          </div>

          <div className="card tw">
            {visible.length === 0 ? <div className="empty"><div className="big">🫥</div>Nothing matches these filters.</div> : (
              <table>
                <thead><tr>
                  <th><input type="checkbox" checked={allVisibleSelected} onChange={selectVisible} /></th>
                  <th onClick={() => sortBy('name')}>Name</th><th onClick={() => sortBy('kind')}>Type</th><th onClick={() => sortBy('envName')}>Environment</th>
                  <th onClick={() => sortBy('state')}>State</th><th onClick={() => sortBy('modifiedTime')}>Modified</th><th>Flags</th>
                </tr></thead>
                <tbody>{visible.map((a) => (
                  <tr key={a.key} className={sel.has(a.key) ? 'sel' : ''} onClick={() => toggle(a.key)}>
                    <td><input type="checkbox" checked={sel.has(a.key)} readOnly /></td>
                    <td><div className="name">{a.name}</div><div className="id">{a.id}</div></td>
                    <td><span className={`kind k-${a.kind}`}>{KIND_UI[a.kind].icon} {KIND_UI[a.kind].label}</span>{a.kind === 'agent' && a.category && a.category !== 'agent' && <span className="pill warn" style={{ marginLeft: 6 }} title={a.meta ? Object.entries(a.meta).map(([k, v]) => `${k}: ${v}`).join('\n') : ''}>{CAT_LABEL[a.category]}</span>}</td>
                    <td>{a.envName}</td>
                    <td><span className="state"><i className={`dot ${a.state === 'Started' || a.state === 'Published' ? 'on' : a.state === 'Suspended' ? 'bad' : 'off'}`} />{a.state}</span></td>
                    <td>{ago(a.modifiedTime)}</td>
                    <td>{a.inSolution && <span className="pill warn" title="Solution-aware">solution</span>} {(a.connections ?? 0) > 0 && a.kind === 'flow' && <span className="pill mut">{a.connections} conn</span>}</td>
                  </tr>))}</tbody>
              </table>)}
          </div>

          {assets.length > 0 && (
            <div className="sticky">
              <b>{selected.length}</b> selected
              <button className="btn sm" onClick={selectVisible}>{allVisibleSelected ? 'Clear' : 'Select visible'}</button>
              <div className="spacer" />
              <button className="btn" disabled={!selected.length} onClick={() => setPanel('transfer')}>Transfer selected →</button>
              <button className="btn primary" onClick={() => { setSel(new Set(assets.map((a) => a.key))); setPanel('transfer') }}>Transfer all {assets.length} →</button>
            </div>)}
        </>
      )}

      {panel === 'transfer' && user && (
        <TransferDrawer backend={backend} from={user} items={selected} busyRef={busyRef}
          onClose={() => setPanel(null)}
          onAudit={(e) => setAudit((a) => [...a, ...e])}
          onDone={(moved) => { setAssets((all) => all.filter((a) => !moved.includes(a.key))); setSel(new Set()) }} flash={flash} />)}
      {panel === 'history' && <HistoryDrawer audit={audit} onClose={() => setPanel(null)} onClear={() => setAudit([])} />}
      {panel === 'diag' && <DiagDrawer backend={backend} onClose={() => setPanel(null)} />}
      {palette && <Palette commands={commands} onClose={() => setPalette(false)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function Drawer({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (<><div className="drawer-bg" onClick={onClose} /><aside className="drawer">{children}</aside></>)
}

function TransferDrawer({ backend, from, items: itemsIn, busyRef, onClose, onAudit, onDone, flash }: {
  backend: Backend; from: Person; items: Asset[]; busyRef: React.MutableRefObject<boolean>
  onClose: () => void; onAudit: (e: AuditEntry[]) => void; onDone: (keys: string[]) => void; flash: (m: string) => void
}) {
  const [items] = useState(itemsIn) // snapshot: results and errors must stay visible even if the table behind changes
  const [toEmail, setToEmail] = useState('')
  const [msg, setMsg] = useState<{ level: 'error' | 'info' | 'ok'; text: string } | null>(null)
  const ownerRef = useRef<HTMLInputElement>(null)
  const [opts, setOpts] = useState<TransferOptions>({ mode: 'replace', removeOldOwner: true })
  const [dry, setDry] = useState(true)
  const [status, setStatus] = useState<Record<string, { s: ItemStatus; err?: string }>>({})
  const [running, setRunning] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [agentOk, setAgentOk] = useState(false)
  const [lastBatch, setLastBatch] = useState<{ id: string; to: Person; keys: string[] } | null>(null)
  const [script, setScript] = useState(false)
  const needsConfirm = !dry && items.length > 5
  const needsAgentOk = items.some((a) => a.kind === 'agent') && !dry
  const doneCount = Object.values(status).filter((x) => x.s === 'done' || x.s === 'dry').length
  const failed = items.filter((a) => status[a.key]?.s === 'failed')
  const partial = failed.filter((a) => a.kind === 'agent' && isPartialUpdate(status[a.key]?.err ?? ''))

  /** Put failed (possibly half-updated) agents back on their original owner. */
  const restoreOriginal = async () => {
    setRunning(true); busyRef.current = true
    let okN = 0; const errs: string[] = []
    for (const a of partial) {
      try { await backend.transfer(a, { id: a.ownerId, name: a.ownerName, email: a.ownerEmail }, { mode: 'replace', removeOldOwner: false }); okN++ }
      catch (e) { errs.push(`${a.name}: ${(e as Error).message}`) }
    }
    setMsg({ level: errs.length ? 'error' : 'ok', text: `Restore original owner: ${okN}/${partial.length} restored.${errs.length ? '\n' + errs.join('\n') : ' Check the agents in Copilot Studio.'}` })
    setRunning(false); busyRef.current = false
  }

  const run = async (list: Asset[]) => {
    const target = toEmail.trim()
    if (!target) { setMsg({ level: 'error', text: 'Enter the NEW owner\'s email address first (the box above), then click again.' }); ownerRef.current?.focus(); return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target) && !/^[0-9a-f-]{36}$/i.test(target)) { setMsg({ level: 'error', text: `"${target}" does not look like an email address or Entra object id.` }); ownerRef.current?.focus(); return }
    setMsg({ level: 'info', text: `Looking up ${target}…` })
    setRunning(true); busyRef.current = true
    let to: Person
    try { to = await backend.resolveUser(target) } catch (e) {
      setMsg({ level: 'error', text: `New owner not found: ${(e as Error).message}` }); setRunning(false); busyRef.current = false; return
    }
    if (to.id === from.id) { setMsg({ level: 'error', text: 'The new owner is the same person as the current owner.' }); setRunning(false); busyRef.current = false; return }
    setMsg({ level: 'info', text: `${dry ? 'Simulating' : 'Transferring'} ${list.length} item(s) to ${to.name} (${to.email})…` })
    const batch = new Date().toISOString()
    const entries: AuditEntry[] = []
    const ok: string[] = []
    const queue = [...list]
    const worker = async () => {
      for (let a = queue.shift(); a; a = queue.shift()) {
        setStatus((s) => ({ ...s, [a.key]: { s: 'running' } }))
        let st: ItemStatus = dry ? 'dry' : 'done'; let err: string | undefined
        try {
          if (dry) await new Promise((r) => setTimeout(r, 120))
          else await backend.transfer(a, to, opts)
          if (!dry) ok.push(a.key)
        } catch (e) { st = 'failed'; err = (e as Error).message }
        setStatus((s) => ({ ...s, [a.key]: { s: st, err } }))
        entries.push({ at: new Date().toISOString(), assetKey: a.key, name: a.name, kind: a.kind, envName: a.envName, from: { id: a.ownerId, name: a.ownerName, email: a.ownerEmail }, to, mode: opts.mode, status: st, error: err, dryRun: dry, batch })
      }
    }
    await Promise.all([worker(), worker(), worker()]) // light concurrency to stay under connector throttling
    onAudit(entries)
    if (!dry && ok.length) { onDone(ok); setLastBatch({ id: batch, to, keys: ok }) }
    const failedEntries = entries.filter((e) => e.status === 'failed')
    const nFail = failedEntries.length
    const nOk = entries.length - nFail
    const firstErr = failedEntries[0]?.error
    setMsg({ level: nFail ? 'error' : 'ok', text: dry
      ? `Dry run finished: ${nOk} OK, ${nFail} would fail. NOTHING was changed. Untick "Dry run" and click "Transfer now" to really move ownership to ${to.name}.`
      : `Transfer finished: ${nOk} moved to ${to.name}, ${nFail} failed.${firstErr ? `\n\nError from the service:\n${firstErr}` : ''}` })
    flash(dry ? 'Dry run complete – nothing changed' : `Transferred ${ok.length}/${list.length}`)
    setRunning(false); busyRef.current = false
  }

  const undo = async () => {
    if (!lastBatch) return
    setRunning(true); busyRef.current = true
    let n = 0
    for (const a of items.filter((x) => lastBatch.keys.includes(x.key))) {
      try { await backend.transfer({ ...a, ownerId: lastBatch.to.id }, from, opts); n++ } catch { /* reported by count */ }
    }
    flash(`Rolled back ${n}/${lastBatch.keys.length} – rescan to refresh`)
    setLastBatch(null); setRunning(false); busyRef.current = false
  }

  return (
    <Drawer onClose={() => !running && onClose()}>
      <h2>Transfer ownership</h2>
      <div className="sub">{items.length} item(s) from <b>{from.name}</b> ({from.email})</div>
      <div className="col" style={{ marginTop: 14 }}>
        <div className="field"><label><b>① New owner</b> – email address (or Entra object id) of the person who should own these items</label><input ref={ownerRef} autoFocus value={toEmail} onChange={(e) => { setToEmail(e.target.value); setMsg(null) }} onKeyDown={(e) => { if (e.key === 'Enter' && !running) run(items) }} placeholder="new.owner@contoso.com" disabled={running} /></div>
        <div className="seg">
          <button className={opts.mode === 'replace' ? 'on' : ''} onClick={() => setOpts({ ...opts, mode: 'replace' })}>Replace owner</button>
          <button className={opts.mode === 'coowner' ? 'on' : ''} onClick={() => setOpts({ ...opts, mode: 'coowner' })}>Add as co-owner (flows only)</button>
        </div>
        {opts.mode === 'replace' && <label className="row"><input type="checkbox" checked={opts.removeOldOwner} onChange={(e) => setOpts({ ...opts, removeOldOwner: e.target.checked })} /> Remove previous owner from flows</label>}
        <label className="row"><input type="checkbox" checked={dry} onChange={(e) => setDry(e.target.checked)} /> <b>Dry run</b> (simulate, change nothing)</label>
        {needsConfirm && <div className="field"><label>Type <b>TRANSFER {items.length}</b> to confirm</label><input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} /></div>}
        {dry && <div className="risk info">Dry run is ON – nothing will be changed. Untick it to really transfer.</div>}
        {msg && <div className={`banner`} style={msg.level === 'error' ? { borderColor: 'var(--bad)', color: 'var(--bad)', background: 'rgba(251,113,133,.08)' } : msg.level === 'ok' ? { borderColor: 'var(--ok)', color: 'var(--ok)', background: 'rgba(52,211,153,.08)' } : { borderColor: 'var(--accent)', color: 'var(--accent2)', background: 'rgba(124,92,255,.08)' }}><span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.text}</span></div>}
        {failed.length > 0 && !running && (
          <div className="card" style={{ padding: 12 }}>
            <b>{partial.length ? '⚠ Agent left half-updated – what to do' : 'Why this usually fails'}</b>
            <ul style={{ margin: '6px 0 8px', paddingLeft: 18, fontSize: 12.5 }}>
              {explainTransferError(failed[0] ? (status[failed[0].key]?.err ?? '') : '', failed[0]!.kind).map((t, i) => <li key={i} style={{ marginBottom: 4 }}>{t}</li>)}
            </ul>
            {partial.length > 0 && <button className="btn sm" style={{ marginRight: 8 }} onClick={restoreOriginal}>↩ Restore original owner ({partial.length})</button>}
            <button className="btn sm" onClick={() => navigator.clipboard?.writeText(failed.map((a) => `${a.kind} ${a.name} (${a.envName}) [${a.id}]: ${status[a.key]?.err}`).join('\n\n')).then(() => flash('Error details copied'))}>Copy error details</button>
          </div>)}
        {needsAgentOk && !running && (
          <div className="card" style={{ padding: 12, fontSize: 12.5 }}>
            <b>🤖 Before you transfer agents</b>
            <ol style={{ margin: '6px 0 8px', paddingLeft: 18 }}>
              <li>The <b>new owner is a member (user) of each agent's environment</b> – Power Platform admin center → Environments → the environment → Users → Add user (lowest role is fine; the transfer itself grants Environment Maker). No System Customizer needed unless this fails.</li>
              <li>The new owner has a <b>Copilot Studio / Microsoft 365 Copilot licence</b>.</li>
              <li>Your connection account is an admin with <b>System Administrator</b> in that environment.</li>
              <li>The agent is not a classic chatbot and not locked in a managed solution.</li>
            </ol>
            <label className="row"><input type="checkbox" checked={agentOk} onChange={(e) => setAgentOk(e.target.checked)} /> <b>I checked these</b> – a failed attempt can leave an agent half-updated.</label>
          </div>)}
        {running && <div className="progress"><i style={{ width: `${(doneCount / Math.max(1, items.length)) * 100}%` }} /></div>}
        <div className="row">
          <button className={`btn ${dry ? 'primary' : 'danger'}`} disabled={running || !items.length || (needsAgentOk && !agentOk) || (needsConfirm && confirmText !== `TRANSFER ${items.length}`)} onClick={() => run(items)}>
            {running ? <span className="spin" /> : dry ? '🧪 Simulate' : '🚀 Transfer now'}
          </button>
          {failed.length > 0 && !running && <button className="btn" onClick={() => run(failed)}>↻ Retry {failed.length} failed</button>}
          {lastBatch && !running && <button className="btn" onClick={undo}>↩ Undo last batch</button>}
          <button className="btn" onClick={() => setScript((s) => !s)}>{'</>'} PowerShell</button>
          <button className="btn" disabled={!items.length} title="Run later with scripts/Invoke-OwnershipPlan.ps1" onClick={() => download('plan.csv', toCsv(items.map((a) => ({ Type: a.kind, EnvironmentId: a.envId, Id: a.id, Name: a.name, OldOwnerId: a.ownerId, NewOwnerId: toEmail.trim() }))), 'text/csv')}>⬇ Plan CSV</button>
        </div>
        {script && (<><pre className="code">{powershellFor(items, { id: '<NEW_OWNER_OBJECT_ID>', name: toEmail, email: toEmail }, opts)}</pre>
          <button className="btn sm" onClick={() => navigator.clipboard?.writeText(powershellFor(items, { id: '<NEW_OWNER_OBJECT_ID>', name: toEmail, email: toEmail }, opts)).then(() => flash('Copied'))}>Copy</button></>)}
        {items.map((a) => {
          const s = status[a.key]; const rs = risksFor(a)
          return (<div key={a.key} className="item"><span className={`pill ${a.kind}`}>{a.kind}</span>
            <div><div className="name">{a.name}</div><div className="id">{a.envName}</div>
              {rs.map((r, i) => <div key={i} className={`risk ${r.level}`}>{r.level === 'warn' ? '⚠' : 'ℹ'} {r.text}</div>)}
              {s?.err && <div className="risk" style={{ color: 'var(--bad)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{s.err}</div>}</div>
            <span className="st">{!s ? <span className="pill mut">queued</span> : s.s === 'running' ? <span className="spin" /> : <span className={`pill ${s.s === 'failed' ? 'bad' : 'ok'}`}>{s.s === 'dry' ? 'ok (dry)' : s.s}</span>}</span></div>)
        })}
      </div>
      <div className="row" style={{ marginTop: 16 }}><button className="btn" disabled={running} onClick={onClose}>Close</button></div>
    </Drawer>
  )
}

function HistoryDrawer({ audit, onClose, onClear }: { audit: AuditEntry[]; onClose: () => void; onClear: () => void }) {
  const rows = [...audit].reverse()
  return (
    <Drawer onClose={onClose}>
      <h2>Audit history</h2><div className="sub">Stored in this browser only. Export for your records.</div>
      <div className="row" style={{ margin: '12px 0' }}>
        <button className="btn sm" onClick={() => download('audit.csv', toCsv(auditRows(audit)), 'text/csv')}>⬇ CSV</button>
        <button className="btn sm" onClick={onClear}>🗑 Clear</button>
      </div>
      <div className="col">{rows.length === 0 && <div className="empty">No transfers yet.</div>}
        {rows.slice(0, 200).map((e, i) => (
          <div key={i} className="item"><span className={`pill ${e.kind}`}>{e.kind}</span>
            <div><div className="name">{e.name}</div><div className="id">{e.envName} · {e.from.email} → {e.to.email}</div><div className="id">{new Date(e.at).toLocaleString()}{e.error ? ' · ' + e.error : ''}</div></div>
            <span className={`pill st ${e.status === 'failed' ? 'bad' : e.dryRun ? 'warn' : 'ok'}`}>{e.dryRun ? 'dry run' : e.status}</span></div>))}
      </div>
    </Drawer>)
}

function DiagDrawer({ backend, onClose }: { backend: Backend; onClose: () => void }) {
  const [rows, setRows] = useState<{ name: string; ok: boolean; detail: string }[] | null>(null)
  useEffect(() => { backend.diagnostics().then(setRows) }, [backend])
  return (
    <Drawer onClose={onClose}>
      <h2>Connector diagnostics</h2><div className="sub">Operations are discovered from the connectors by REST path. If one is missing, the connector was not added or its path differs.</div>
      <div className="row" style={{ marginTop: 10 }}><button className="btn sm" disabled={!rows} onClick={() => navigator.clipboard?.writeText((rows ?? []).map((r) => `${r.ok ? 'OK ' : 'MISSING '}${r.name}\n${r.detail}`).join('\n\n'))}>Copy diagnostics</button></div>
      <div className="col" style={{ marginTop: 12 }}>{!rows ? <span className="spin" /> : rows.map((r) => (
        <div key={r.name} className="item"><span className={`pill ${r.ok ? 'ok' : 'bad'}`}>{r.ok ? 'bound' : 'missing'}</span><div><div className="name">{r.name}</div><div className="id" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{r.detail}</div></div></div>))}</div>
    </Drawer>)
}

function Palette({ commands, onClose }: { commands: { label: string; run: () => void }[]; onClose: () => void }) {
  const [q, setQ] = useState(''); const [i, setI] = useState(0)
  const list = commands.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()))
  const exec = (c?: { run: () => void }) => { if (c) { onClose(); c.run() } }
  return (<><div className="drawer-bg" onClick={onClose} />
    <div className="palette">
      <input autoFocus placeholder="Type a command…" value={q} onChange={(e) => { setQ(e.target.value); setI(0) }}
        onKeyDown={(e) => { if (e.key === 'ArrowDown') setI((x) => Math.min(list.length - 1, x + 1)); else if (e.key === 'ArrowUp') setI((x) => Math.max(0, x - 1)); else if (e.key === 'Enter') exec(list[i]) }} />
      <ul>{list.map((c, n) => <li key={c.label} className={n === i ? 'on' : ''} onClick={() => exec(c)}>{c.label}</li>)}</ul>
    </div></>)
}
