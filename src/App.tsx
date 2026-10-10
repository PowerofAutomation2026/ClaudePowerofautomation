import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { emailReport, isDue, nextRun, reportCsv, reportPdfMulti, reportRows, saveBlob } from './report'
import type { ReportGroup, Schedule } from './report'
import { clearLog, getLog, log as opLog, subscribeLog } from './oplog'
import type { AgentCategory, Asset, SolutionGroup, AssetKind, AuditEntry, Backend, Env, ItemStatus, Person, ScanNote, TransferOptions } from './types'
import { hasConnectors, pickBackend } from './services'
import { runTransfer } from './transferPlan'
import ExposureView from './exposure/ExposureView'
import BlastView from './blast/BlastView'
import EgressView from './egress/EgressView'
import AgentView from './agents/AgentView'
import type { View } from './nav'
import { ago, assetRows, portalUrl, auditRows, download, explainTransferError, isPartialUpdate, powershellFor, risksFor, toCsv } from './util'

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
type Panel = null | 'transfer' | 'history' | 'diag' | 'solutions' | 'report' | 'schedules'


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
  const [schedules, setSchedules] = useState<Schedule[]>(() => ls.get<Schedule[]>('occ.schedules', []))
  useEffect(() => { ls.set('occ.schedules', schedules) }, [schedules])
  const [runningSched, setRunningSched] = useState<string | null>(null)
  const [audit, setAudit] = useState<AuditEntry[]>(() => ls.get('occ.audit', []))
  const [toast, setToast] = useState<string | null>(null)
  const [palette, setPalette] = useState(false)
  const [view, setView] = useState<View>(() => ls.get('occ.view', 'owner'))
  useEffect(() => { ls.set('occ.view', view) }, [view])
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

  /** Scan one more user (used by the multi-user report). */
  const scanOne = useCallback(async (em: string): Promise<ReportGroup> => {
    const p = await backend.resolveUser(em.trim())
    const scope = envScope.length ? envs.filter((e) => envScope.includes(e.id)) : envs
    const { assets: found } = await backend.listAssets(p, scope, () => {})
    return { user: p, assets: found.filter((a) => a.kind !== 'agent' || !a.category || a.category === 'agent' || a.category === 'agentbuilder') }
  }, [backend, envs, envScope])

  /** Run one saved report schedule now: scan its users, build the report, mail it. */
  const runSchedule = useCallback(async (s: Schedule) => {
    setRunningSched(s.id)
    let result: string
    try {
      const groups: ReportGroup[] = []
      for (const em of s.users) { const g = await scanOne(em); groups.push({ user: g.user, assets: g.assets.filter((x) => s.kinds.includes(x.kind)) }) }
      const n = await emailReport(backend, groups, s.to, s.name, s.csv, s.pdf)
      result = `Sent ${n} item(s) for ${groups.length} user(s) to ${s.to}`
    } catch (e) { result = `FAILED: ${(e as Error).message.slice(0, 220)}` }
    setSchedules((all) => all.map((x) => (x.id === s.id ? { ...x, lastRun: new Date().toISOString(), lastResult: result } : x)))
    setRunningSched(null)
    flash(result.startsWith('FAILED') ? 'Scheduled report failed - see Schedules' : 'Scheduled report sent')
  }, [backend, scanOne, flash])
  // The app is a browser page: schedules run while it is open (and catch up when it is opened).
  const schedRef = useRef({ schedules, runningSched, runSchedule })
  schedRef.current = { schedules, runningSched, runSchedule }
  useEffect(() => {
    if (!envs.length) return
    const tick = () => {
      const { schedules: list, runningSched: busy, runSchedule: run } = schedRef.current
      if (busy || busyRef.current) return
      const due = list.find((s) => isDue(s))
      if (due) void run(due)
    }
    const first = setTimeout(tick, 4000)
    const id = setInterval(tick, 60000)
    return () => { clearTimeout(first); clearInterval(id) }
  }, [envs.length])

  // Only real Copilot Studio agents by default; tools / MCP / Agent Builder / CLI items sit behind a toggle.
  const assets = useMemo(() => allAssets.filter((a) => showOthers || a.kind !== 'agent' || !a.category || a.category === 'agent' || a.category === 'agentbuilder'), [allAssets, showOthers])
  const hiddenCount = allAssets.length - assets.length
  const hiddenByCat = useMemo(() => {
    const m: Record<string, number> = {}
    allAssets.filter((a) => a.kind === 'agent' && a.category && a.category !== 'agent' && a.category !== 'agentbuilder').forEach((a) => { m[a.category!] = (m[a.category!] ?? 0) + 1 })
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
    { label: 'Schedules: email reports automatically', run: () => setPanel('schedules') },
    { label: 'Report: export CSV / PDF for this user', run: () => assets.length && setPanel('report') },
    { label: 'Transfer a whole solution…', run: () => assets.length && setPanel('solutions') },
    { label: 'Open history', run: () => setPanel('history') },
    { label: 'Connector diagnostics', run: () => setPanel('diag') },
    { label: 'Show operation log (real calls)', run: () => setPanel('diag') },
    { label: 'Open Agent Guard (Copilot Studio agent security)', run: () => setView('agents') },
    { label: 'Open Egress Radar (where flows send data)', run: () => setView('egress') },
    { label: 'Open Credential Blast-Radius Map (compromise / offboarding)', run: () => setView('blast') },
    { label: 'Open Exposure Auditor (sharing / guest / connection risk)', run: () => setView('exposure') },
  ]

  if (view === 'exposure') return <ExposureView demo={demo} setDemo={setDemo} theme={theme} setTheme={setTheme} go={setView} />
  if (view === 'blast') return <BlastView demo={demo} setDemo={setDemo} theme={theme} setTheme={setTheme} go={setView} />
  if (view === 'agents') return <AgentView demo={demo} setDemo={setDemo} theme={theme} setTheme={setTheme} go={setView} />
  if (view === 'egress') return <EgressView demo={demo} setDemo={setDemo} theme={theme} setTheme={setTheme} go={setView} />

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
        <button className="btn sm" onClick={() => setView('exposure')} title="Who can reach what: Everyone / guest shares, connection credential sharing">🔐 Exposure Auditor</button>
        <button className="btn sm" onClick={() => setView('blast')} title="If an account is compromised or leaves: which credentials can it act through?">🕸️ Blast-Radius Map</button>
        <button className="btn sm" onClick={() => setView('egress')} title="Where does every flow send data? destinations, secrets in flows, external mail">📡 Egress Radar</button>
        <button className="btn sm" onClick={() => setView('agents')} title="Copilot Studio agents: no auth, maker credentials, public sources">🤖 Agent Guard</button>
        <button className="btn sm" disabled={!assets.length} onClick={() => setPanel('report')}>📄 Report</button>
        <button className="btn sm" onClick={() => setPanel('schedules')}>⏰ Schedules{schedules.some((s) => s.enabled) ? ` (${schedules.filter((s) => s.enabled).length})` : ''}</button>
        <button className="btn sm" disabled={!assets.length} onClick={() => setPanel('solutions')}>📦 Solutions</button>
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

          {notes.some((n) => /could NOT be live-checked/.test(n.text)) && (
            <div className="banner" style={{ borderColor: 'var(--warn)' }}>
              ⚠ <b>Live agent check is not available for some environments.</b> Agents you created in the last 5–15 minutes may be missing, and deleted ones may still be listed (the tenant inventory lags).
              Open <b>🩺 Diagnostics → "Live Dataverse test"</b> to see why, then <button className="btn sm" onClick={() => void search(user?.email ?? email)}>↻ Re-scan now</button>
            </div>
          )}
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
                    <td><div className="name">{a.name} <a href={portalUrl(a)} target="_blank" rel="noreferrer" title="Open in its portal to check the owner" onClick={(e) => e.stopPropagation()} style={{ fontSize: 11, opacity: .8 }}>↗ open</a></div><div className="id">{a.id}</div></td>
                    <td><span className={`kind k-${a.kind}`}>{KIND_UI[a.kind].icon} {KIND_UI[a.kind].label}</span>{a.kind === 'agent' && a.category && a.category !== 'agent' && <span className="pill warn" style={{ marginLeft: 6 }} title={a.meta ? Object.entries(a.meta).map(([k, v]) => `${k}: ${v}`).join('\n') : ''}>{CAT_LABEL[a.category]}</span>}{a.kind === 'flow' && a.meta?.flowType && <span className="pill" style={{ marginLeft: 6, borderColor: 'var(--accent)' }} title="Agent flows / Workflows are cloud flows owned in Dataverse">{a.meta.flowType}</span>}{a.kind === 'app' && a.meta?.appType && <span className="pill" style={{ marginLeft: 6 }} title="Found through the tenant inventory">{a.meta.appType}</span>}{a.kind === 'agent' && a.meta?.flavor && <span className="pill" style={{ marginLeft: 6 }}>{a.meta.flavor}</span>}{a.kind === 'agent' && a.meta?.live === 'unverified' && <span className="pill warn" style={{ marginLeft: 6 }} title="The tenant inventory can still list deleted agents. This app could not confirm it exists (no Dataverse access to this environment). Deploy the app into this environment to live-check.">⚠ not live-checked</span>}{a.kind === 'agent' && a.meta?.live === 'verified' && <span className="pill ok" style={{ marginLeft: 6 }} title="Confirmed to exist in Dataverse just now">✓ live</span>}</td>
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
          onDone={(moved) => { setAssets((all) => all.filter((a) => !moved.includes(a.key))); setSel(new Set()) }} onRefresh={() => { void search(user.email) }} flash={flash} />)}
      {panel === 'schedules' && <ScheduleDrawer schedules={schedules} setSchedules={setSchedules} runningSched={runningSched} onRun={(s) => void runSchedule(s)} canMail={!!backend.sendMail} defaultTo={user?.email ?? ''} defaultUsers={user ? [user.email] : []} onClose={() => setPanel(null)} />}
      {panel === 'report' && user && <ReportDrawer backend={backend} user={user} assets={assets} selected={selected} scanOne={scanOne} onClose={() => setPanel(null)} flash={flash} />}
      {panel === 'solutions' && <SolutionsDrawer backend={backend} assets={assets} onClose={() => setPanel(null)} onPick={(keys) => { setSel(new Set(keys)); setPanel('transfer') }} />}
      {panel === 'history' && <HistoryDrawer audit={audit} backend={backend} onClose={() => setPanel(null)} onClear={() => setAudit([])} onAudit={(e) => setAudit((a) => [...a, ...e])} flash={flash} />}
      {panel === 'diag' && <DiagDrawer backend={backend} onClose={() => setPanel(null)} />}
      {palette && <Palette commands={commands} onClose={() => setPalette(false)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function Drawer({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (<><div className="drawer-bg" onClick={onClose} /><aside className="drawer">{children}</aside></>)
}

/** Real operation log: every connector call, pre-flight, transfer and read-back with timestamps. */
function OpLog() {
  const lines = useSyncExternalStore(subscribeLog, getLog)
  return (
    <details className="card" style={{ padding: 12 }} open={lines.length > 0 && lines.length < 40}>
      <summary><b>Operation log</b> – {lines.length} real call(s) recorded</summary>
      <div className="row" style={{ margin: '8px 0' }}>
        <button className="btn sm" onClick={() => navigator.clipboard?.writeText(lines.join('\n'))}>Copy log</button>
        <button className="btn sm" onClick={() => download(`transfer-receipt-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`, `Ownership Command Center - transfer receipt\nBuild ${typeof __BUILD__ === 'string' ? __BUILD__ : ''}\nGenerated ${new Date().toISOString()}\n\n${lines.join('\n')}\n`, 'text/plain')}>⬇ Download receipt</button>
        <button className="btn sm" onClick={clearLog}>Clear</button>
      </div>
      <pre style={{ maxHeight: 260, overflow: 'auto', fontSize: 11, whiteSpace: 'pre-wrap', margin: 0 }}>{lines.join('\n') || '(nothing yet)'}</pre>
    </details>
  )
}

function TransferDrawer({ backend, from, items: itemsIn, busyRef, onClose, onAudit, onDone, onRefresh, flash }: {
  backend: Backend; from: Person; items: Asset[]; busyRef: React.MutableRefObject<boolean>
  onClose: () => void; onAudit: (e: AuditEntry[]) => void; onDone: (keys: string[]) => void; onRefresh: () => void; flash: (m: string) => void
}) {
  const [items] = useState(itemsIn) // snapshot: results and errors must stay visible even if the table behind changes
  const [toEmail, setToEmail] = useState('')
  const [msg, setMsg] = useState<{ level: 'error' | 'info' | 'ok'; text: string } | null>(null)
  const ownerRef = useRef<HTMLInputElement>(null)
  const [opts, setOpts] = useState<TransferOptions>({ mode: 'replace', removeOldOwner: true })
  const [dry, setDry] = useState(true)
  const [status, setStatus] = useState<Record<string, { s: ItemStatus; err?: string; note?: string }>>({})
  const [running, setRunning] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [agentOk, setAgentOk] = useState(false)
  const [lastTo, setLastTo] = useState<Person | null>(null)
  const [prepare, setPrepare] = useState(true)
  const [notify, setNotify] = useState(false)
  const [notifyMgr, setNotifyMgr] = useState(false)
  const [lastBatch, setLastBatch] = useState<{ id: string; to: Person; keys: string[]; opts: TransferOptions } | null>(null)
  const [script, setScript] = useState(false)
  const needsConfirm = !dry && items.length > 5
  const needsAgentOk = items.some((a) => a.kind === 'agent') && !dry
  const doneCount = Object.values(status).filter((x) => x.s === 'done' || x.s === 'dry').length
  const failed = items.filter((a) => status[a.key]?.s === 'failed')
  const partial = failed.filter((a) => a.kind === 'agent' && isPartialUpdate(status[a.key]?.err ?? '') && !/^Rolled back automatically/.test(status[a.key]?.note ?? ''))

  /** Put failed (possibly half-updated) agents back on their original owner. */
  const restoreOriginal = async () => {
    setRunning(true); busyRef.current = true
    let okN = 0; const errs: string[] = []; const entries: AuditEntry[] = []
    for (const a of partial) {
      const orig = { id: a.ownerId, name: a.ownerName, email: a.ownerEmail }
      let st: ItemStatus = 'done'; let err: string | undefined
      try { await backend.transfer(a, orig, { mode: 'replace', removeOldOwner: false }); okN++ }
      catch (e) { st = 'failed'; err = (e as Error).message; errs.push(`${a.name}: ${err}`) }
      entries.push({ at: new Date().toISOString(), assetKey: a.key, name: a.name, kind: a.kind, envName: a.envName, from: { id: '', name: toEmail, email: toEmail }, to: orig, mode: 'replace', status: st, error: err, dryRun: false, batch: 'restore', note: 'Restore original owner after a partial transfer' })
      if (st === 'failed') break // one at a time; stop at the first failure
    }
    onAudit(entries)
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
    if (to.id === from.id && !list.every((a) => a.kind === 'agent')) { setMsg({ level: 'error', text: 'The new owner is the same person as the current owner.' }); setRunning(false); busyRef.current = false; return }
    // Same owner + agents only = "re-run the reassignment" to finish/repair an agent a previous attempt left half-updated.
    const batch = new Date().toISOString()
    const out = await runTransfer({
      backend, items: list, to, opts, dry, prepare, batch,
      hooks: {
        status: (key, st, err, note) => setStatus((m) => ({ ...m, [key]: { s: st, err, note } })),
        message: (text) => setMsg({ level: 'info', text }),
      },
    })
    onAudit(out.entries)
    setLastTo(to)
    if (!dry && notify && backend.sendMail && out.entries.some((e) => e.status === 'done')) {
      const rows = out.entries.filter((e) => e.status === 'done' || e.status === 'failed').map((e) => `<tr><td style="padding:4px 8px">${e.kind}</td><td style="padding:4px 8px"><b>${e.name.replace(/</g, '&lt;')}</b></td><td style="padding:4px 8px">${e.envName}</td><td style="padding:4px 8px">${e.status === 'done' ? (/^Verified/.test(e.note ?? '') ? 'transferred &#10003;' : 'accepted - please verify') : 'failed'}</td></tr>`).join('')
      void (async () => { const mgr = notifyMgr && backend.getManager ? await backend.getManager(from.id).catch(() => null) : null; await backend.sendMail!({ to: [to.email, mgr?.email].filter(Boolean).join(';'), subject: `Ownership transferred to you: ${out.entries.filter((e) => e.status === 'done').length} item(s) from ${from.name}`, html: `<div style="font-family:Segoe UI,Arial,sans-serif"><p>Hello ${to.name},</p><p>An administrator transferred ownership of the following items from <b>${from.name}</b> (${from.email}) to you:</p><table cellspacing="0" style="border-collapse:collapse;font-size:13px"><tr style="background:#ecebfa"><th>Type</th><th>Name</th><th>Environment</th><th>Result</th></tr>${rows}</table><p>Please open each item once and check its connections and settings. Flows keep using the previous owner's connections until you re-bind them.</p></div>` }) })()
        .then(() => flash(`Summary emailed to ${to.email}`)).catch((e) => flash(`Could not email ${to.email}: ${(e as Error).message.slice(0, 120)}`))
    }
    if (!dry && out.movedKeys.length) onDone(out.movedKeys) // only CONFIRMED rows leave the table
    if (!dry && out.acceptedKeys.length) setLastBatch({ id: batch, to, keys: out.acceptedKeys, opts: { ...opts } })
    const failedEntries = out.entries.filter((e) => e.status === 'failed')
    const skipped = out.entries.filter((e) => e.status === 'skipped').length
    const nFail = failedEntries.length
    const nOk = out.entries.filter((e) => e.status === 'done' || e.status === 'dry').length
    const nUnverified = out.unverifiedKeys.length
    const nConfirmed = out.entries.filter((e) => /^Verified/.test(e.note ?? '')).length
    const firstErr = failedEntries[0]?.error
    setMsg({ level: nFail ? 'error' : 'ok', text: dry
      ? `Dry run finished: ${nOk} OK, ${nFail} would fail. NOTHING was changed. Untick "Dry run" and click "Transfer now" to really move ownership to ${to.name}.${out.entries.filter((e) => e.status === 'failed' && /^Not attempted/.test(e.error ?? '')).map((e) => `\n• ${e.name}: ${e.error}`).join('')}`
      : `Transfer finished: ${nOk} accepted by the service for ${to.name} (${nConfirmed} CONFIRMED at the source${nUnverified ? `, ⚠ ${nUnverified} NOT confirmed yet – see below` : ''}), ${nFail} failed${skipped ? `, ${skipped} skipped (batch stopped to protect them)` : ''}.${firstErr ? `\n\nError from the service:\n${firstErr}` : ''}${out.halted ? '\n\nThe batch was STOPPED at the first agent failure so the remaining agents were not touched.' : ''}${out.prepNotes}` })
    flash(dry ? 'Dry run complete – nothing changed' : `${nConfirmed} confirmed, ${nUnverified} unverified, ${nFail} failed`)
    if (!dry && out.entries.length) { opLog('auto-refresh: re-reading live data in 5 s'); setTimeout(onRefresh, 5000) }
    setRunning(false); busyRef.current = false
  }

  /** Re-read the owner from the source for items that were accepted but not confirmed. */
  const recheck = async () => {
    if (!lastTo || !backend.verifyOwner) return
    setRunning(true); busyRef.current = true
    const confirmed: string[] = []
    for (const a of items) {
      const st = status[a.key]
      if (!st || st.s !== 'done' || /^Verified/.test(st.note ?? '')) continue
      const v = await backend.verifyOwner(a, lastTo).catch(() => null)
      if (v === true) { confirmed.push(a.key); setStatus((m) => ({ ...m, [a.key]: { s: 'done', note: 'Verified at the source: the new owner is now the owner.' } })) }
      else setStatus((m) => ({ ...m, [a.key]: { s: 'done', note: v === false ? '⚠ Still NOT showing the new owner at the source. Check the portal (right environment) and licence/membership.' : 'Still cannot read the owner back from here – confirm in the portal.' } }))
    }
    if (confirmed.length) onDone(confirmed)
    setMsg({ level: confirmed.length ? 'ok' : 'info', text: `Re-check: ${confirmed.length} newly confirmed at the source.` })
    setRunning(false); busyRef.current = false
  }

  const undo = async () => {
    if (!lastBatch) return
    setRunning(true); busyRef.current = true
    let n = 0
    const entries: AuditEntry[] = []
    for (const a of items.filter((x) => lastBatch.keys.includes(x.key))) {
      let st: ItemStatus = 'done'; let err: string | undefined
      try { await backend.transfer({ ...a, ownerId: lastBatch.to.id, ownerName: lastBatch.to.name, ownerEmail: lastBatch.to.email }, from, lastBatch.opts); n++ }
      catch (e) { st = 'failed'; err = (e as Error).message }
      entries.push({ at: new Date().toISOString(), assetKey: a.key, name: a.name, kind: a.kind, envName: a.envName, from: lastBatch.to, to: from, mode: lastBatch.opts.mode, status: st, error: err, dryRun: false, batch: 'undo ' + lastBatch.id, note: 'Undo of the previous batch' })
      if (st === 'failed' && a.kind === 'agent') break // protect the remaining agents
    }
    onAudit(entries)
    const firstErr = entries.find((e) => e.error)?.error
    setMsg({ level: firstErr ? 'error' : 'ok', text: `Rolled back ${n}/${lastBatch.keys.length}.${firstErr ? `\n${firstErr}` : ''} Rescan to refresh.` })
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
        {backend.sendMail && <label className="row"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> <b>✉ Email the new owner</b> a summary of what was transferred (from your mailbox)</label>}
        {backend.sendMail && notify && backend.getManager && <label className="row"><input type="checkbox" checked={notifyMgr} onChange={(e) => setNotifyMgr(e.target.checked)} /> also copy <b>{from.name}'s manager</b> (looked up in Office 365 Users)</label>}
        {needsConfirm && <div className="field"><label>Type <b>TRANSFER {items.length}</b> to confirm</label><input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} /></div>}
        {dry && <div className="risk info">Dry run is ON – nothing will be changed. Untick it to really transfer.</div>}
        {msg && <div className={`banner`} style={msg.level === 'error' ? { borderColor: 'var(--bad)', color: 'var(--bad)', background: 'rgba(251,113,133,.08)' } : msg.level === 'ok' ? { borderColor: 'var(--ok)', color: 'var(--ok)', background: 'rgba(52,211,153,.08)' } : { borderColor: 'var(--accent)', color: 'var(--accent2)', background: 'rgba(124,92,255,.08)' }}><span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.text}</span></div>}
        <OpLog />
        {failed.length > 0 && !running && (
          <div className="card" style={{ padding: 12 }}>
            <b>{partial.length ? '⚠ Agent left half-updated – what to do' : 'Why this usually fails'}</b>
            <ul style={{ margin: '6px 0 8px', paddingLeft: 18, fontSize: 12.5 }}>
              {explainTransferError(failed[0] ? (status[failed[0].key]?.err ?? '') : '', failed[0]!.kind).map((t, i) => <li key={i} style={{ marginBottom: 4 }}>{t}</li>)}
            </ul>
            {partial.length > 0 && <button className="btn sm" style={{ marginRight: 8 }} onClick={restoreOriginal}>↩ Restore original owner ({partial.length})</button>}
            <button className="btn sm" onClick={() => navigator.clipboard?.writeText(failed.map((a) => `${a.kind} ${a.name}\n  environment: ${a.envName} (${a.envId})\n  id: ${a.id}\n  new owner: ${toEmail}\n  when: ${new Date().toISOString()}\n  error: ${status[a.key]?.err}`).join('\n\n')).then(() => flash('Error details copied'))}>Copy error details</button>
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
            <label className="row" style={{ marginBottom: 6 }}><input type="checkbox" checked={prepare} onChange={(e) => setPrepare(e.target.checked)} /> <b>Add the new owner to each agent's environment first</b> (membership only – no security roles) – recommended</label>
            <label className="row"><input type="checkbox" checked={agentOk} onChange={(e) => setAgentOk(e.target.checked)} /> <b>I checked these</b> – a failed attempt can leave an agent half-updated.</label>
          </div>)}
        {running && <div className="progress"><i style={{ width: `${(doneCount / Math.max(1, items.length)) * 100}%` }} /></div>}
        <div className="row">
          <button className={`btn ${dry ? 'primary' : 'danger'}`} disabled={running || !items.length || (needsAgentOk && !agentOk) || (needsConfirm && confirmText !== `TRANSFER ${items.length}`)} onClick={() => run(items)}>
            {running ? <span className="spin" /> : dry ? '🧪 Simulate' : '🚀 Transfer now'}
          </button>
          {failed.length > 0 && !running && <button className="btn" onClick={() => run(failed)}>↻ Retry {failed.length} failed</button>}
          {Object.values(status).some((x) => x.s === 'done' && !/^Verified/.test(x.note ?? '')) && !running && backend.verifyOwner && <button className="btn" onClick={recheck}>🔄 Re-check at the source</button>}
          {lastBatch && !running && <button className="btn" onClick={undo}>↩ Undo last batch</button>}
          <button className="btn" onClick={() => setScript((s) => !s)}>{'</>'} PowerShell</button>
          <button className="btn" disabled={!items.length} title="Run later with scripts/Invoke-OwnershipPlan.ps1" onClick={() => download('plan.csv', toCsv(items.map((a) => ({ Type: a.kind, EnvironmentId: a.envId, Id: a.id, Name: a.name, OldOwnerId: a.ownerId, NewOwnerId: toEmail.trim() }))), 'text/csv')}>⬇ Plan CSV</button>
        </div>
        {script && (<><pre className="code">{powershellFor(items, { id: '<NEW_OWNER_OBJECT_ID>', name: toEmail, email: toEmail }, opts)}</pre>
          <button className="btn sm" onClick={() => navigator.clipboard?.writeText(powershellFor(items, { id: '<NEW_OWNER_OBJECT_ID>', name: toEmail, email: toEmail }, opts)).then(() => flash('Copied'))}>Copy</button></>)}
        {items.map((a) => {
          const s = status[a.key]; const rs = risksFor(a)
          return (<div key={a.key} className="item"><span className={`pill ${a.kind}`}>{a.kind}</span>
            <div><div className="name">{a.name} <a href={portalUrl(a)} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>↗ check the Owner in its portal</a></div><div className="id">{a.envName}</div>
              {rs.map((r, i) => <div key={i} className={`risk ${r.level}`}>{r.level === 'warn' ? '⚠' : 'ℹ'} {r.text}</div>)}
              {s?.err && <div className="risk" style={{ color: 'var(--bad)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{s.err}</div>}
              {s?.note && <div className="risk info" style={{ whiteSpace: 'pre-wrap' }}>{s.note}</div>}</div>
            <span className="st">{!s ? <span className="pill mut">queued</span> : s.s === 'running' ? <span className="spin" /> : <span className={`pill ${s.s === 'failed' ? 'bad' : s.s === 'skipped' ? 'warn' : 'ok'}`}>{s.s === 'dry' ? 'ok (dry)' : s.s}</span>}</span></div>)
        })}
      </div>
      <div className="row" style={{ marginTop: 16 }}><button className="btn" disabled={running} onClick={onClose}>Close</button></div>
    </Drawer>
  )
}

/** Saved report schedules: emailed automatically while the app is open (it catches up when opened). */
function ScheduleDrawer({ schedules, setSchedules, runningSched, onRun, canMail, defaultTo, defaultUsers, onClose }: {
  schedules: Schedule[]; setSchedules: React.Dispatch<React.SetStateAction<Schedule[]>>; runningSched: string | null; onRun: (s: Schedule) => void
  canMail: boolean; defaultTo: string; defaultUsers: string[]; onClose: () => void
}) {
  const blank = (): Schedule => ({ id: String(Date.now()), name: 'Weekly ownership report', users: defaultUsers, kinds: ['app', 'flow', 'agent'], to: defaultTo, freq: 'weekly', hour: 8, dow: 1, csv: true, pdf: true, enabled: true })
  const [f, setF] = useState<Schedule>(blank())
  const [usersText, setUsersText] = useState(defaultUsers.join(', '))
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const add = () => {
    const users = usersText.split(/[\s,;]+/).filter(Boolean)
    if (!users.length || !f.to.trim()) return
    setSchedules((s) => [...s, { ...f, users, id: String(Date.now()) }]); setF(blank())
  }
  return (
    <Drawer onClose={onClose}>
      <div className="row"><h2 style={{ margin: 0 }}>⏰ Scheduled reports</h2><div className="spacer" /><button className="btn sm" onClick={onClose}>Close</button></div>
      <div className="banner" style={{ borderColor: 'var(--warn)', margin: '10px 0' }}>
        ⚠ A code app has no server: schedules run <b>while this app is open in a browser tab</b> and catch up when someone opens it after a run was missed. For fully unattended delivery use a scheduled Power Automate flow (see the README, "Unattended reports").
      </div>
      {!canMail && <div className="banner" style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}>Email is not available in this build: add the Office 365 Outlook connector (re-run the deploy script).</div>}
      {schedules.map((s) => (
        <div className="card" key={s.id} style={{ padding: 12, marginBottom: 8, opacity: s.enabled ? 1 : .6 }}>
          <div className="row"><b>{s.name}</b><span className="pill mut">{s.freq}{s.freq === 'weekly' ? ` ${days[s.dow]}` : ''} {String(s.hour).padStart(2, '0')}:00</span><div className="spacer" />
            <button className="btn sm" disabled={!!runningSched} onClick={() => onRun(s)}>{runningSched === s.id ? 'Running…' : '▶ Run now'}</button>
            <button className="btn sm" onClick={() => setSchedules((all) => all.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)))}>{s.enabled ? 'Pause' : 'Resume'}</button>
            <button className="btn sm" onClick={() => setSchedules((all) => all.filter((x) => x.id !== s.id))}>✕</button></div>
          <div className="sub">Users: {s.users.join(', ')} · To: {s.to} · {s.kinds.join('/')} · {[s.csv && 'CSV', s.pdf && 'PDF'].filter(Boolean).join(' + ') || 'no attachments'}</div>
          <div className="sub">Next: {s.enabled ? nextRun(s).toLocaleString() : 'paused'}{s.lastRun ? ` · Last: ${new Date(s.lastRun).toLocaleString()} - ${s.lastResult ?? ''}` : ' · never run'}</div>
        </div>
      ))}
      <div className="card" style={{ padding: 12 }}>
        <b>➕ New schedule</b>
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Name (also the email subject)" style={{ width: '100%', margin: '6px 0' }} />
        <textarea value={usersText} onChange={(e) => setUsersText(e.target.value)} rows={2} placeholder="Users to report on (emails)" style={{ width: '100%' }} />
        <input value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} placeholder="Send to (emails, separated by ;)" style={{ width: '100%', margin: '6px 0' }} />
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select value={f.freq} onChange={(e) => setF({ ...f, freq: e.target.value as Schedule['freq'] })}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly (1st)</option></select>
          {f.freq === 'weekly' && <select value={f.dow} onChange={(e) => setF({ ...f, dow: +e.target.value })}>{days.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>}
          <select value={f.hour} onChange={(e) => setF({ ...f, hour: +e.target.value })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</select>
        </div>
        <div className="row" style={{ gap: 12, margin: '8px 0', flexWrap: 'wrap' }}>
          {(['app', 'flow', 'agent'] as AssetKind[]).map((k) => <label key={k} className="sub"><input type="checkbox" checked={f.kinds.includes(k)} onChange={(e) => setF({ ...f, kinds: e.target.checked ? [...f.kinds, k] : f.kinds.filter((x) => x !== k) })} /> {KIND_UI[k].plural}</label>)}
          <label className="sub"><input type="checkbox" checked={f.csv} onChange={(e) => setF({ ...f, csv: e.target.checked })} /> CSV</label>
          <label className="sub"><input type="checkbox" checked={f.pdf} onChange={(e) => setF({ ...f, pdf: e.target.checked })} /> PDF</label>
        </div>
        <button className="btn primary sm" onClick={add}>Save schedule</button>
      </div>
    </Drawer>
  )
}

/** Report studio: pick what to include, add more users, preview, download CSV (Excel) or PDF (one section per user). */
function ReportDrawer({ backend, user, assets, selected, scanOne, onClose, flash }: { backend: Backend; user: Person; assets: Asset[]; selected: Asset[]; scanOne: (email: string) => Promise<ReportGroup>; onClose: () => void; flash: (m: string) => void }) {
  const [inc, setInc] = useState<Record<AssetKind, boolean>>({ app: true, flow: true, agent: true })
  const [onlySel, setOnlySel] = useState(false)
  const [extra, setExtra] = useState<ReportGroup[]>([])
  const [emails, setEmails] = useState('')
  const [scanning, setScanning] = useState<string | null>(null)
  const [scanErr, setScanErr] = useState<string | null>(null)
  const first: ReportGroup = { user, assets: onlySel && selected.length ? selected : assets }
  const groups = [first, ...extra].map((g) => ({ user: g.user, assets: g.assets.filter((a) => inc[a.kind]) }))
  const all = groups.flatMap((g) => g.assets)
  const rows = reportRows(all)
  const stamp = new Date().toISOString().slice(0, 10)
  const slug = groups.length === 1 ? user.email.replace(/[^a-z0-9]+/gi, '_') : `${groups.length}_users`
  const tone = { app: '#3987e5', flow: '#d95926', agent: '#199e70' } as const
  const [mailTo, setMailTo] = useState('')
  const [mailCsv, setMailCsv] = useState(true)
  const [mailPdf, setMailPdf] = useState(true)
  const [mailBusy, setMailBusy] = useState(false)
  const [mailMsg, setMailMsg] = useState<string | null>(null)
  const sendNow = async () => {
    setMailBusy(true); setMailMsg(null)
    try {
      const n = await emailReport(backend, groups, mailTo.trim(), `Ownership report - ${groups.length === 1 ? user.email : `${groups.length} users`}`, mailCsv, mailPdf)
      setMailMsg(`✔ Sent ${n} item(s) to ${mailTo.trim()}`)
    } catch (e) { setMailMsg(`✖ ${(e as Error).message}`) }
    setMailBusy(false)
  }
  const addUsers = async () => {
    const list = emails.split(/[\s,;]+/).map((x) => x.trim()).filter((x) => x && !extra.some((g) => g.user.email.toLowerCase() === x.toLowerCase()) && x.toLowerCase() !== user.email.toLowerCase())
    if (!list.length) return
    setScanErr(null)
    for (const em of list) {
      setScanning(em)
      try { const g = await scanOne(em); setExtra((x) => [...x, g]) }
      catch (e) { setScanErr(`${em}: ${(e as Error).message}`) }
    }
    setScanning(null); setEmails('')
  }
  return (
    <Drawer onClose={onClose}>
      <div className="row"><h2 style={{ margin: 0 }}>📄 Report studio</h2><div className="spacer" /><button className="btn sm" onClick={onClose}>Close</button></div>
      <div className="card" style={{ padding: 16, marginTop: 10, background: 'linear-gradient(135deg, rgba(99,86,255,.28), rgba(25,158,112,.18))' }}>
        <div style={{ fontSize: 12, opacity: .8 }}>INVENTORY REPORT FOR</div>
        <div style={{ fontSize: 20, fontWeight: 700 }}>{groups.length === 1 ? user.name : `${groups.length} users`}</div>
        <div className="sub">{groups.map((g) => g.user.email).join(' · ')}</div>
        <div className="row" style={{ marginTop: 12, gap: 8 }}>
          {(['app', 'flow', 'agent'] as AssetKind[]).map((k) => (
            <button key={k} className="btn sm" onClick={() => setInc((s) => ({ ...s, [k]: !s[k] }))} style={{ borderColor: tone[k], opacity: inc[k] ? 1 : .4, minWidth: 110 }} title="Click to include / exclude">
              <b style={{ color: tone[k], fontSize: 18 }}>{[first, ...extra].flatMap((g) => g.assets).filter((a) => a.kind === k).length}</b> {KIND_UI[k].plural}
            </button>
          ))}
        </div>
        {selected.length > 0 && <label className="sub" style={{ display: 'block', marginTop: 10 }}><input type="checkbox" checked={onlySel} onChange={(e) => setOnlySel(e.target.checked)} /> First user: only the {selected.length} selected item(s)</label>}
      </div>
      <div className="card" style={{ padding: 12, marginTop: 10 }}>
        <b>➕ Add more users to this report</b>
        <div className="sub">Emails separated by comma, space or new line. Each user is scanned across all environments and gets their own section in the PDF.</div>
        <textarea value={emails} onChange={(e) => setEmails(e.target.value)} rows={2} placeholder="alex@contoso.com, sam@contoso.com" style={{ width: '100%', margin: '6px 0' }} disabled={!!scanning} />
        <div className="row"><button className="btn sm" disabled={!!scanning || !emails.trim()} onClick={addUsers}>{scanning ? `Scanning ${scanning}…` : 'Scan & add'}</button>
          {extra.map((g) => <span key={g.user.email} className="chip" onClick={() => setExtra((x) => x.filter((y) => y !== g))} title="Click to remove">{g.user.email} ✕</span>)}</div>
        {scanErr && <div className="sub" style={{ color: 'var(--bad)', marginTop: 6 }}>{scanErr}</div>}
      </div>
      <p className="sub" style={{ margin: '10px 0 6px' }}>Columns: type, name, id, created time, environment name, environment id, owner, state · {rows.length} row(s)</p>
      <div className="row" style={{ gap: 8, marginBottom: 10 }}>
        <button className="btn primary" disabled={!rows.length} onClick={() => { saveBlob(`ownership-report-${slug}-${stamp}.csv`, reportCsv(all), 'text/csv;charset=utf-8'); flash('CSV report downloaded') }}>⬇ CSV (Excel)</button>
        <button className="btn primary" disabled={!rows.length} onClick={() => { saveBlob(`ownership-report-${slug}-${stamp}.pdf`, reportPdfMulti(groups, __BUILD__), 'application/pdf'); flash('PDF report downloaded') }}>⬇ PDF</button>
      </div>
      <div className="card" style={{ padding: 12, marginBottom: 10 }}>
        <b>✉ Email this report</b>
        <div className="sub">Sent from your own mailbox through the Office 365 Outlook connector. Separate several recipients with a semicolon.</div>
        <input value={mailTo} onChange={(e) => setMailTo(e.target.value)} placeholder="admin@contoso.com; auditor@contoso.com" style={{ width: '100%', margin: '6px 0' }} />
        <div className="row" style={{ gap: 12 }}>
          <label className="sub"><input type="checkbox" checked={mailCsv} onChange={(e) => setMailCsv(e.target.checked)} /> attach CSV</label>
          <label className="sub"><input type="checkbox" checked={mailPdf} onChange={(e) => setMailPdf(e.target.checked)} /> attach PDF</label>
          <div className="spacer" />
          <button className="btn sm primary" disabled={!rows.length || !mailTo.trim() || mailBusy} onClick={sendNow}>{mailBusy ? 'Sending…' : 'Send now'}</button>
        </div>
        {mailMsg && <div className="sub" style={{ marginTop: 6, color: mailMsg.startsWith('✔') ? 'var(--ok)' : 'var(--bad)' }}>{mailMsg}</div>}
      </div>
      <div className="card" style={{ padding: 0, overflow: 'auto', maxHeight: 340 }}>
        <table><thead><tr><th>Type</th><th>Name</th><th>Created</th><th>Environment</th></tr></thead>
          <tbody>{rows.slice(0, 40).map((r) => <tr key={r.Owner + r.Id + r.EnvironmentId}><td><span className="pill" style={{ borderColor: tone[(r.Type === 'App' ? 'app' : r.Type === 'Agent' ? 'agent' : 'flow')] }}>{r.Type}</span></td><td><div className="name">{r.Name}</div><div className="id">{r.Id}{groups.length > 1 ? ` · ${r.Owner}` : ''}</div></td><td>{r.Created || '—'}</td><td>{r.Environment}<div className="id">{r.EnvironmentId}</div></td></tr>)}</tbody></table>
        {rows.length > 40 && <div className="sub" style={{ padding: 8 }}>… and {rows.length - 40} more in the file</div>}
      </div>
    </Drawer>
  )
}

/** Solutions that contain the user's apps / flows / agents. Picking one pre-selects those items for the normal (safe, verified) transfer. */
function SolutionsDrawer({ backend, assets, onClose, onPick }: { backend: Backend; assets: Asset[]; onClose: () => void; onPick: (keys: string[]) => void }) {
  const [groups, setGroups] = useState<SolutionGroup[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    if (!backend.listSolutions) { setErr('This build cannot read solutions.'); return }
    backend.listSolutions(assets).then((g) => { if (live) setGroups(g) }).catch((e) => { if (live) setErr((e as Error).message) })
    return () => { live = false }
  }, [backend, assets])
  const byKey = new Map(assets.map((a) => [a.key, a]))
  return (
    <Drawer onClose={onClose}>
      <div className="row"><h2 style={{ margin: 0 }}>📦 Transfer a whole solution</h2><div className="spacer" /><button className="btn sm" onClick={onClose}>Close</button></div>
      <p className="sub">Dataverse solutions themselves have no owner – the owners are the components inside. This lists the solutions that contain this user's apps, cloud flows and Copilot Studio agents. Pick one to select ALL of that user's items in it, then transfer them with the normal verified pipeline.</p>
      {!groups && !err && <div className="skeleton" style={{ height: 80 }} />}
      {err && <div className="banner" style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}>Could not read solutions: {err}<br />This needs the Microsoft Dataverse connector (the deploy script adds it) and admin rights in that environment.</div>}
      {groups && groups.length === 0 && <div className="empty"><div className="big">🫥</div>None of this user's items are inside a (non-default) solution.</div>}
      {groups?.map((g) => {
        const items = g.assetKeys.map((k) => byKey.get(k)).filter(Boolean) as Asset[]
        const n = (k: string) => items.filter((i) => i.kind === k).length
        const hasFlows = n('flow') > 0
        return (
          <div className="card" key={g.key} style={{ padding: 12, marginBottom: 10 }}>
            <div className="row"><b>{g.name}</b> <span className="pill mut">{g.uniqueName} {g.version ?? ''}</span>{g.managed && <span className="pill warn">managed</span>}<div className="spacer" /><span className="sub">{g.envName}</span></div>
            <div className="sub" style={{ margin: '6px 0' }}>{n('app')} app(s) · {n('flow')} flow(s) · {n('agent')} agent(s) owned by this user · {g.totalComponents} component(s) in the solution (tables, roles, connection references etc. are not owner-transferable here)</div>
            <ul style={{ margin: '4px 0 8px 18px', padding: 0, fontSize: 12 }}>{items.map((i) => <li key={i.key}>{KIND_UI[i.kind].icon} {i.name}</li>)}</ul>
            {g.managed && <div className="sub" style={{ color: 'var(--warn)' }}>Managed solution: ownership of some components may be blocked or create a customization layer – use the dry run first.</div>}
            {hasFlows && <div className="sub" style={{ color: 'var(--warn)' }}>Flows keep running on the OLD owner's connections after an owner change. The new owner should open each flow once and re-bind its connections (and the old account must not be disabled before that).</div>}
            <div className="row" style={{ marginTop: 8 }}><button className="btn primary sm" onClick={() => onPick(g.assetKeys)}>Select these {items.length} item(s) and transfer →</button></div>
          </div>
        )
      })}
    </Drawer>
  )
}

function HistoryDrawer({ audit, backend, onClose, onClear, onAudit, flash }: { audit: AuditEntry[]; backend: Backend; onClose: () => void; onClear: () => void; onAudit: (e: AuditEntry[]) => void; flash: (m: string) => void }) {
  const rows = [...audit].reverse()
  const [busy, setBusy] = useState<string | null>(null)
  /** Re-assign a (possibly half-updated) agent back to the owner it had before the failed attempt. */
  const restore = async (e: AuditEntry) => {
    const [, envId, ...rest] = e.assetKey.split(':')
    const stub: Asset = { key: e.assetKey, id: rest.join(':'), kind: e.kind, name: e.name, envId: envId ?? '', envName: e.envName, ownerId: e.to.id, ownerName: e.to.name, ownerEmail: e.to.email, state: 'Unknown' }
    setBusy(e.assetKey + e.at)
    let st: ItemStatus = 'done'; let err: string | undefined
    try { await backend.transfer(stub, e.from, { mode: 'replace', removeOldOwner: false }); flash(`Restored "${e.name}" to ${e.from.email}`) }
    catch (x) { st = 'failed'; err = (x as Error).message; flash(`Restore failed: ${err.slice(0, 160)}`) }
    finally { setBusy(null) }
    onAudit([{ at: new Date().toISOString(), assetKey: e.assetKey, name: e.name, kind: e.kind, envName: e.envName, from: e.to, to: e.from, mode: 'replace', status: st, error: err, dryRun: false, batch: 'restore', note: 'Restore after a failed/partial transfer' }])
  }
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
            <div className="col" style={{ alignItems: 'flex-end', marginLeft: 'auto' }}>
              <span className={`pill st ${e.status === 'failed' ? 'bad' : e.dryRun ? 'warn' : 'ok'}`}>{e.dryRun ? 'dry run' : e.status}</span>
              {e.status === 'failed' && !e.dryRun && e.kind === 'agent' && isPartialUpdate(e.error ?? '') && <button className="btn sm" disabled={busy !== null} onClick={() => restore(e)}>{busy === e.assetKey + e.at ? <span className="spin" /> : '↩'} Restore to {e.from.name}</button>}
            </div></div>))}
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
      <div style={{ marginTop: 10 }}><OpLog /></div>
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
