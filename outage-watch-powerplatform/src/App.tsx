import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import catalog from '../shared/catalog.json'
import { DEFAULT_THRESHOLDS, buildFrames, dependencyEdges, isStale, stressScore, type Frame, type Level, type RawRow, type State, type Thresholds } from './logic/classify'
import { ROLE_WORD, SEV, derive, downstream, familySummary, groupFamilies, isProblem, layoutFamilies, list, roleStatus, topo, type Derived, type Family, type FamilySummary, type Kind, type Topology } from './logic/graph'
import { SCENARIOS, demoSource, demoTargetList, probed, simulateRows, type Scenario } from './data/demo'
import { hasDataverse, liveSource } from './data/live'
import type { Snapshot } from './data/types'

// ---------- glyphs: state is always shape + icon + word, never colour alone ----------
const OCT = (() => { const p: string[] = []; for (let i = 0; i < 8; i++) { const a = ((22.5 + 45 * i) * Math.PI) / 180; p.push((23 * Math.cos(a)).toFixed(1) + ',' + (23 * Math.sin(a)).toFixed(1)) } return 'M' + p.join('L') + 'Z' })()
const CIRCLE = 'M-21,0a21,21 0 1,0 42,0a21,21 0 1,0 -42,0Z'
const CASCADE = 'M-8,-9L0,-1L8,-9M-8,1L0,9L8,1'
const KIND: Record<Kind, [string, string]> = {
  up: [CIRCLE, 'M-9,1L-3,7L9,-6'],
  warning: ['M0,-24L24,17L-24,17Z', 'M0,-7L0,4M0,10.5L0,11'],
  suspect: ['M0,-25L25,0L0,25L-25,0Z', 'M-5,-5C-5,-12 6,-12 6,-5C6,-1 0,-1 0,4M0,10.5L0,11'],
  down: [OCT, 'M-8,-8L8,8M8,-8L-8,8'],
  blocked: [CIRCLE, 'M-14,14L14,-14'],
  unconfigured: [CIRCLE, 'M-9,0L9,0'],
  'risk-down': [CIRCLE, CASCADE],
  'risk-warn': [CIRCLE, CASCADE],
}
const KIND_TEXT: Record<Kind, string> = {
  up: 'answering normally', warning: 'answering, but slow or unexpected', suspect: 'one failed probe, not yet confirmed',
  down: 'not answering (confirmed)', blocked: 'probe refused on our side', unconfigured: 'not set up: needs your tenant name (not a failure)', 'risk-down': 'at risk: depends on a failing service', 'risk-warn': 'may be slow: depends on a slow service',
}
const LEGEND: [Kind, string][] = [['up', 'up'], ['warning', 'warning'], ['suspect', 'suspect'], ['down', 'down'], ['blocked', 'blocked'], ['risk-down', 'at risk downstream'], ['unconfigured', 'not set up']]
const LEVEL_MEAN: Record<Level, string> = { ok: 'No action needed.', caution: 'Something is slow or failing once. Watch closely.', freeze: 'A service is confirmed down or sign-in is failing. Hold risky changes.' }
const LEVEL_KIND: Record<Level, Kind> = { ok: 'up', caution: 'warning', freeze: 'down' }

function Glyph({ kind }: { kind: Kind }) {
  return (
    <svg viewBox="-28 -28 56 56" className={'gl k-' + kind} aria-hidden="true">
      <path className="shape" d={KIND[kind][0]} />
      <path className="icon" d={KIND[kind][1]} transform={kind === 'warning' ? 'translate(0,3)' : undefined} />
    </svg>
  )
}

// ---------- helpers ----------
const hms = (t: string) => { const d = new Date(t); return Number.isNaN(d.getTime()) ? String(t) : d.toISOString().slice(11, 19) + ' UTC' }
function ago(sec: number): string { sec = Math.max(0, Math.round(sec)); if (sec < 90) return sec + ' s ago'; if (sec < 5400) return Math.round(sec / 60) + ' min ago'; return Math.round(sec / 3600) + ' h ago' }
const clampNum = (v: string | undefined, lo: number, hi: number, dflt: number) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) && n >= lo && n <= hi ? n : dflt }

function parseRoles(text: string | undefined): Record<string, string[]> {
  try {
    const o = JSON.parse(text ?? '')
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const out: Record<string, string[]> = {}
      for (const [k, v] of Object.entries(o).slice(0, 30)) if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k.slice(0, 80)] = (v as string[]).slice(0, 30)
      if (Object.keys(out).length) return out
    }
  } catch { /* fall through to the defaults */ }
  return catalog.roles
}

/** Two label lines at most, split at the separator nearest the middle (same rule as the Python dashboard). */
function splitName(n: string): [string, string] {
  const max = 13
  if (n.length <= max) return [n, '']
  const mid = n.length / 2
  let best = -1
  for (let i = 1; i < n.length - 1; i++) if (/[-_. ]/.test(n[i]) && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i
  const parts = best > 0 ? [n.slice(0, best + 1), n.slice(best + 1)] : [n.slice(0, max), n.slice(max)]
  const cut = (x: string) => (x.length > 15 ? x.slice(0, 14) + '\u2026' : x)
  return [cut(parts[0]), cut(parts[1])]
}

function nodeSub(v: { state: State; ms: number; code: number | null }, d: Derived): string {
  if (d.kind === 'risk-down') return 'at risk'
  if (d.kind === 'risk-warn') return 'may be slow'
  if (v.state === 'blocked') return 'blocked'
  if (v.state === 'unconfigured') return 'not set up'
  if (v.state === 'down' || v.state === 'suspect') return v.state + ' · ' + (v.code ? 'HTTP ' + v.code : 'no answer')
  return v.state + ' · ' + v.ms + ' ms'
}
function describe(n: string, v: { state: State; ms: number }, d: Derived): string {
  let t = n + ': ' + KIND_TEXT[d.kind]
  if (d.kind.startsWith('risk')) t += ', its own probe answers in ' + v.ms + ' ms but it depends on ' + list(d.via)
  else if (v.state === 'unconfigured') t = n + ': needs your tenant name (re-run the deploy with -TenantName contoso). This is not a failure'
  else if (v.state === 'up' || v.state === 'warning') t += ', ' + v.ms + ' ms'
  return t
}

// ---------- blast-radius map: family bands on two buses ----------
interface MapProps {
  frame: Frame; D: Map<string, Derived>; T: Topology; families: Family[]; summaries: Map<string, FamilySummary>
  dep: ReadonlySet<string>; cop: ReadonlySet<string>; sim: boolean; selected: string | null; onSelect: (n: string | null) => void
  collapsed: ReadonlySet<string>; onToggle: (family: string) => void
}
const sevOf = (d: Derived | undefined) => (d ? Math.max(SEV[d.own], d.risk) : 0)

function BlastMap({ frame, D, T, families, summaries, dep, cop, sim, selected, onSelect, collapsed, onToggle }: MapProps) {
  const box = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 700)
  const [hover, setHover] = useState<string | null>(null)
  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((e) => setNarrow(e[0].contentRect.width < 640))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const L = useMemo(() => layoutFamilies(families, dep, cop, { narrow, collapsed }), [families, dep, cop, narrow, collapsed])
  const focus = hover ?? selected
  const hl = useMemo(() => { if (!focus || !D.has(focus)) return null; const s = downstream(focus, T.out); s.add(focus); return s }, [focus, T, D])

  return (
    <div ref={box} className="graphBox">
      <svg className={'graph' + (hl ? ' has-hl' : '') + (narrow ? ' narrow' : '')} viewBox={`0 0 ${L.width} ${L.height}`} role="group" aria-label="Dependency map by service family: which services are failing and what depends on them">
        {sim && <text className="wm" x={L.width / 2} y={Math.min(L.height / 2, 300)} textAnchor="middle">SIMULATION</text>}
        <g>
          {L.bands.map((b) => {
            const sm = summaries.get(b.name)
            const x = narrow ? 20 : 40; const w = L.width - 2 * x
            const label = `${b.name}: ${sm ? sm.total + ' services, ' + sm.text : ''}. ${b.collapsed ? 'Collapsed, activate to expand' : 'Activate to collapse'}`
            const short = sm ? (narrow && sm.text.length > 16 ? (sm.problems ? sm.problems + ' of ' + sm.total + ' affected' : sm.total + ' services') : sm.text) : ''
            return (
              <g key={b.name} className={'band k-' + (sm?.worst ?? 'up') + (sm && sm.problems ? ' bad' : '')}>
                <rect className="bandBox" x={x} y={b.y} width={w} height={b.h} rx="8" />
                <g className="bandHead" tabIndex={0} role="button" aria-expanded={!b.collapsed} aria-label={label} onClick={() => onToggle(b.name)}
                  onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onToggle(b.name) } }}>
                  <rect className="bandHit" x={x} y={b.y} width={w} height="28" rx="8" />
                  <path className="chev" d={b.collapsed ? 'M-3,-5L3,0L-3,5' : 'M-5,-3L0,3L5,-3'} transform={`translate(${x + 13},${b.y + 14})`} />
                  <g transform={`translate(${x + 31},${b.y + 14}) scale(.36)`}><path className="shape" d={KIND[sm?.worst ?? 'up'][0]} /><path className="icon" d={KIND[sm?.worst ?? 'up'][1]} /></g>
                  <text className="bandName" x={x + 45} y={b.y + 18}>{(() => { const room = Math.floor((w - 62 - short.length * 7.4) / 8.2); return b.name.length > room ? b.name.slice(0, Math.max(6, room - 1)) + '\u2026' : b.name })()}</text>
                  <text className="bandSum" x={x + w - 10} y={b.y + 18} textAnchor="end">{short}</text>
                </g>
              </g>
            )
          })}
        </g>
        <g>
          {L.rails.map((rl, i) => {
            const sv = rl.kind === 'signin' ? sevOf(D.get(L.hub ?? '')) : Math.max(0, ...rl.from.map((n) => sevOf(D.get(n))))
            const lit = !!focus && (rl.kind === 'signin' ? focus === L.hub : rl.from.includes(focus))
            return (
              <g key={i} className={'e r-' + rl.kind + (sv >= 2 ? ' hot-down' : sv === 1 ? ' hot-warn' : '') + (lit ? ' hl' : '')}>
                <path className="edge" d={rl.d} /><path className="flow" d={rl.d} />
              </g>
            )
          })}
          {L.sink && L.pos.get(L.sink) && <path className="tip" d="M0,0L-4.5,-8L4.5,-8Z" transform={`translate(${L.pos.get(L.sink)!.x.toFixed(1)},${(L.pos.get(L.sink)!.y - L.r - 1).toFixed(1)})`} />}
        </g>
        <g>
          {[...L.pos.entries()].map(([n, p]) => {
            const v = frame.services.get(n); const d = D.get(n)
            if (!v || !d) return null
            const label = describe(n, v, d)
            const [l1, l2] = splitName(n)
            const toggle = () => onSelect(selected === n ? null : n)
            return (
              <g key={n} className={'node k-' + d.kind + (hl && hl.has(n) ? ' hl' : '') + (selected === n ? ' sel' : '')} transform={`translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`}
                tabIndex={0} role="button" aria-pressed={selected === n} aria-label={label}
                onClick={toggle} onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle() } }}
                onMouseEnter={() => setHover(n)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(n)} onBlur={() => setHover(null)}>
                <title>{label}</title>
                <circle className="halo" r={L.r + 9} />
                <circle className="fr" r={L.r + 6} />
                <g transform={`scale(${(L.r / 25).toFixed(3)})`}>
                  <path className="shape" d={KIND[d.kind][0]} />
                  <path className="icon" d={KIND[d.kind][1]} transform={d.kind === 'warning' ? 'translate(0,3)' : undefined} />
                </g>
                <text className="nl" y={L.r + 16}>{l1}</text>
                {l2 && <text className="nl" y={L.r + 29}>{l2}</text>}
                <text className="ns" y={L.r + (l2 ? 42 : 29)}>{nodeSub(v, d)}</text>
              </g>
            )
          })}
        </g>
      </svg>
      <ul className="legend" aria-label="Legend">
        {LEGEND.map(([k, t]) => <li key={k} className={'k-' + k}><Glyph kind={k} />{t}</li>)}
        <li className="legendNote">Each box is a service family. Left line: needs sign-in (auth). Right line: what Microsoft 365 Copilot reads. A failure travels along the lines; select a service to see what it can take down.</li>
      </ul>
    </div>
  )
}

// ---------- app ----------
type Theme = 'auto' | 'light' | 'dark'
const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')
const qTheme = params.get('theme')
const qSim = params.get('sim')
const qDemo = params.get('demo')
const qTenant = params.get('tenant')
const qFilter = params.get('filter') ?? ''
const qOnly = params.get('only') === '1'
const qCollapse = params.get('collapse')
const DEMO_TARGETS = demoTargetList(qTenant ? 'contoso' : null)
const SIM_STEP_MS = 2500

export default function App() {
  const source = useMemo(() => (hasDataverse && !qDemo ? liveSource() : demoSource(qDemo === 'stale' ? 60 : 0, qTenant ? 'contoso' : null)), [])
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [failedSince, setFailedSince] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [selected, setSelected] = useState<string | null>(null)
  const [theme, setTheme] = useState<Theme>(() => {
    if (qTheme === 'light' || qTheme === 'dark') return qTheme
    try { const t = localStorage.getItem('ow-theme'); if (t === 'light' || t === 'dark') return t } catch { /* storage unavailable */ }
    return 'auto'
  })
  const [sim, setSim] = useState<{ on: boolean; scenario: Scenario; rows: RawRow[]; k: number }>(() => {
    const sc = SCENARIOS.find((s) => s.id === qSim)?.id
    if (!sc) return { on: false, scenario: 'healthy', rows: [], k: 0 }
    const names = probed(DEMO_TARGETS)
    return { on: true, scenario: sc, rows: simulateRows(names, 11, Date.now(), SIM_STEP_MS, (i) => (i < 8 ? 'healthy' : sc)), k: 11 }
  })

  useEffect(() => {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', theme)
    try { localStorage.setItem('ow-theme', theme) } catch { /* storage unavailable */ }
  }, [theme])

  const refresh = useCallback(async () => {
    try {
      const s = await source.load()
      setSnap(s); setError(null); setFailedSince(null)
    } catch (e) {
      setError(String((e as Error)?.message ?? e).slice(0, 300))
      setFailedSince((t) => t ?? Date.now())
    }
  }, [source])
  useEffect(() => {
    void refresh()
    const a = setInterval(() => void refresh(), 60_000)
    const b = setInterval(() => setNow(Date.now()), 5_000)
    return () => { clearInterval(a); clearInterval(b) }
  }, [refresh])

  // simulation clock: one synthetic probe round every few seconds, through the real classification pipeline
  useEffect(() => {
    if (!sim.on || qSim) return
    const t = setInterval(() => setSim((s) => {
      const names = probed(snap?.targets.length ? snap.targets : DEMO_TARGETS)
      const add = simulateRows(names, 1, Date.now(), SIM_STEP_MS, () => s.scenario).map((r) => ({ ...r }))
      return { ...s, rows: [...s.rows, ...add].slice(-names.length * 60), k: s.k + 1 }
    }), SIM_STEP_MS)
    return () => clearInterval(t)
  }, [sim.on, snap])

  const settings = snap?.settings ?? {}
  const interval = clampNum(settings.interval_minutes, 1, 1440, catalog.defaults.intervalMinutes)
  const th: Thresholds = useMemo(() => ({
    ...DEFAULT_THRESHOLDS,
    confirm: clampNum(settings.confirm, 1, 10, DEFAULT_THRESHOLDS.confirm), factor: clampNum(settings.factor, 1.1, 20, DEFAULT_THRESHOLDS.factor),
    floorMs: clampNum(settings.floor_ms, 0, 60000, DEFAULT_THRESHOLDS.floorMs), slowMs: clampNum(settings.slow_ms, 100, 120000, DEFAULT_THRESHOLDS.slowMs),
    recoverAfter: clampNum(settings.recover_after, 1, 20, DEFAULT_THRESHOLDS.recoverAfter),
  }), [settings.confirm, settings.factor, settings.floor_ms, settings.slow_ms, settings.recover_after])
  const roles = useMemo(() => parseRoles(settings.roles_json), [settings.roles_json])

  const targets = useMemo(() => (snap?.targets.length ? snap.targets : sim.on ? DEMO_TARGETS : []).filter((t) => t.enabled || t.unconfigured), [snap, sim.on])
  const rows = sim.on ? sim.rows : snap?.rows ?? []
  const frames = useMemo(() => buildFrames(rows, targets, th), [rows, targets, th])
  const frame = frames.length ? frames[frames.length - 1] : null
  const T = useMemo(() => topo(targets.map((t) => t.name), dependencyEdges(targets)), [targets])
  const D = useMemo(() => (frame ? derive(frame, T) : new Map<string, Derived>()), [frame, T])
  const roleRows = useMemo(() => (frame ? roleStatus(roles, frame, D) : []), [roles, frame, D])

  const newest = snap?.rows.reduce<string | null>((m, r) => (m === null || r.at > m ? r.at : m), null) ?? null
  const stale = !sim.on && isStale(newest, interval, now)
  const unreachable = !sim.on && failedSince !== null && now - failedSince > 8000
  const level: Level = frame?.level ?? 'ok'

  const counts = useMemo(() => {
    const c = { up: 0, warning: 0, suspect: 0, down: 0, blocked: 0, unconfigured: 0, risk: 0 }
    D.forEach((d) => { c[d.own]++; if (d.kind.startsWith('risk')) c.risk++ })
    return c
  }, [D])

  const startSim = () => {
    const names = probed(targets.length ? targets : DEMO_TARGETS)
    setSelected(null)
    setSim({ on: true, scenario: 'healthy', rows: simulateRows(names, 8, Date.now(), SIM_STEP_MS, () => 'healthy'), k: 8 })
  }
  const stopSim = () => { setSelected(null); setSim({ on: false, scenario: 'healthy', rows: [], k: 0 }) }

  const sel = selected && frame?.services.get(selected) ? selected : null
  const selView = sel ? frame!.services.get(sel)! : null
  const selD = sel ? D.get(sel)! : null
  const selStress = useMemo(() => {
    if (!sel) return 0
    const samples: [State, number][] = []
    for (const f of frames) { const v = f.services.get(sel); if (v) samples.push([v.state, v.ms]) }
    return stressScore(samples, selView?.baseline ?? null, selView?.warnMs ?? null)
  }, [sel, frames, selView])
  // ----- families, filter, "only problems", collapse -----
  const [filter, setFilter] = useState(qFilter)
  const [onlyProblems, setOnlyProblems] = useState(qOnly)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set(qCollapse === 'all' ? catalog.families.map((f) => f[0] as string) : []))
  const familyOf = useMemo(() => { const m = new Map(targets.map((t) => [t.name, t.family])); return (n: string) => m.get(n) }, [targets])
  const allFamilies = useMemo(() => groupFamilies(frame ? [...frame.services.keys()] : [], catalog.families as [string, string[]][], familyOf), [frame, familyOf])
  const summaries = useMemo(() => new Map(allFamilies.map((f) => [f.name, familySummary(f.nodes, D)])), [allFamilies, D])
  const dep = useMemo(() => new Set(targets.filter((t) => t.dependsOnAuth).map((t) => t.name)), [targets])
  const cop = useMemo(() => new Set(targets.filter((t) => t.copilotNeeds).map((t) => t.name)), [targets])
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase().slice(0, 60)
    return allFamilies.map((f) => ({ name: f.name, nodes: f.nodes.filter((n) => (!q || n.toLowerCase().includes(q) || f.name.toLowerCase().includes(q)) && (!onlyProblems || isProblem(D.get(n)?.kind ?? 'up'))) })).filter((f) => f.nodes.length)
  }, [allFamilies, filter, onlyProblems, D])
  const shownCount = shown.reduce((n, f) => n + f.nodes.length, 0)
  const toggleFamily = useCallback((name: string) => setCollapsed((c) => { const s = new Set(c); if (s.has(name)) s.delete(name); else s.add(name); return s }), [])
  const collapseHealthy = () => setCollapsed(new Set(allFamilies.filter((f) => !(summaries.get(f.name)?.problems)).map((f) => f.name)))

  const levelChanges = useMemo(() => frames.filter((f) => f.levelChanged).slice(-6).reverse(), [frames])

  return (
    <div className={'wrap' + (sim.on ? ' sim' : '')}>
      <header>
        <h1>Outage Watch<small>Microsoft 365 + Copilot · blast radius · Power Platform edition</small></h1>
        <div className="tools">
          <button type="button" className="simToggle" aria-pressed={sim.on} onClick={sim.on ? stopSim : startSim}>{sim.on ? 'Exit simulation' : 'Simulation'}</button>
          <button type="button" onClick={() => setTheme(theme === 'auto' ? 'dark' : theme === 'dark' ? 'light' : 'auto')} aria-label={'Theme: ' + theme + '. Change theme'}>Theme: {theme}</button>
          {!sim.on && <button type="button" onClick={() => void refresh()}>Refresh</button>}
        </div>
      </header>

      {sim.on && (
        <section className="simBar" aria-label="Simulation controls">
          <div className="simHead"><b>SIMULATION</b>Made-up data for drills. Nothing here is a real probe result.</div>
          <div className="simBody">
            {SCENARIOS.map((s) => (
              <button key={s.id} type="button" aria-pressed={sim.scenario === s.id} title={s.hint} onClick={() => setSim((x) => ({ ...x, scenario: s.id }))}>{s.label}</button>
            ))}
            <p>Scenarios produce raw probe facts and run through the same classification as live data (confirm after {th.confirm} failures, slow recovery after {th.recoverAfter} clean rounds). Live data is not shown while this is on.</p>
          </div>
        </section>
      )}

      {!sim.on && source.kind === 'demo' && (
        <p className="demoBar" role="note"><b>DEMO DATA</b>This build is not connected to Dataverse. The numbers below are generated samples, not probe results.</p>
      )}

      {unreachable && <p className="staleBar" role="alert"><b>NO DATA</b>The dashboard cannot read the Outage Watch tables{error ? ' (' + error + ')' : ''}. Dataverse or sign-in may be affected. Everything below is the last known state, not the present.</p>}
      {stale && !unreachable && (
        <p className="staleBar" role="alert"><b>STALE</b>No new probe result for {ago((now - Date.parse(newest!)) / 1000).replace(' ago', '')} (expected every {interval} min). The probe flow may be stopped, throttled, or Power Platform itself may be failing. Everything below is the last known state, not the present. Check your independent monitor.</p>
      )}

      <section className={'banner l-' + level} aria-live="polite">
        <div className={'lvl k-' + LEVEL_KIND[level]}>
          <Glyph kind={LEVEL_KIND[level]} />
          <div><strong>{level}</strong><span>{LEVEL_MEAN[level]}</span></div>
        </div>
        <div>
          <p className="verdict">{frame ? frame.verdict : error ? 'Cannot read probe results.' : snap ? 'Waiting for the first probe round.' : 'Loading...'}{sim.on && <span className="simTag">SIMULATED</span>}</p>
          {frame && frame.early.length > 0 && <p className="early">Early warning: latency far above its own baseline for {list(frame.early)} (still answering).</p>}
          {frame && (
            <p className="meta">
              <span className="mono">{[(D.size - counts.unconfigured) + ' probed', counts.up + ' answering', ...(counts.unconfigured ? [counts.unconfigured + ' need a tenant name'] : []), ...(['warning', 'suspect', 'down', 'blocked'] as const).filter((k) => counts[k]).map((k) => counts[k] + ' ' + k), ...(counts.risk ? [counts.risk + ' at risk downstream'] : [])].join(' · ')}</span>
              <span>probe round at {hms(frame.t)} · {ago((now - Date.parse(frame.t)) / 1000)}</span>
              {stale && <span className="chip stale">STALE</span>}
            </p>
          )}
        </div>
      </section>

      <div className="cols">
        <section className="panel" aria-labelledby="hMap">
          <h2 id="hMap">Blast radius{sim.on && <span className="simTag">SIMULATED</span>}</h2>
          <div className="mapTools">
            <label htmlFor="flt">Filter</label>
            <input id="flt" type="search" value={filter} maxLength={60} placeholder="service or family name" autoComplete="off" onChange={(e) => setFilter(e.target.value)} />
            <label className="chk"><input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Show only problems</label>
            <button type="button" onClick={collapseHealthy}>Collapse healthy</button>
            <button type="button" onClick={() => setCollapsed(new Set(allFamilies.map((f) => f.name)))}>Collapse all</button>
            <button type="button" onClick={() => setCollapsed(new Set())}>Expand all</button>
            <span className="hint" role="status">{frame ? `showing ${shownCount} of ${D.size} services in ${shown.length} of ${allFamilies.length} families` : ''}</span>
          </div>
          {!frame ? <p className="hint">No probe data yet.</p>
            : !shown.length ? <p className="empty">{onlyProblems && !filter.trim() ? 'No problems right now: every probed service is answering.' : 'Nothing matches this filter.'}</p>
            : <BlastMap frame={frame} D={D} T={T} families={shown} summaries={summaries} dep={dep} cop={cop} sim={sim.on} selected={sel} onSelect={setSelected} collapsed={collapsed} onToggle={toggleFamily} />}
          <div className="detail" aria-live="polite">
            {sel && selView && selD ? (
              <>
                <h3>{sel}</h3>
                <p className="big">{KIND_TEXT[selD.kind]}</p>
                {selView.state === 'unconfigured' && <p>Not probed. Re-run <span className="mono">Deploy-OutageWatchPP.cmd &lt;environment-id&gt; -TenantName contoso</span> (the name in contoso.sharepoint.com) to set it up.</p>}
                <p className="mono">{familyOf(sel) ?? 'Independent'} · HTTP {selView.code ?? '-'} · {selView.ms} ms{selView.error ? ' · ' + selView.error : ''} · baseline {selView.baseline == null ? 'learning' : selView.baseline + ' ms'}{selView.warnMs == null ? '' : ' · warns above ' + Math.round(selView.warnMs) + ' ms'} · stress {selStress}/100</p>
                {selD.via.length > 0 && <p>Depends on: {list(selD.via)}.</p>}
                <p>{(() => { const d = [...downstream(sel, T.out)].sort(); return d.length ? 'If it fails, at risk: ' + list(d, 14) + '.' : 'Nothing else depends on it in this map.' })()}</p>
              </>
            ) : <p className="hint">Select a service in the map to see its numbers and what depends on it.</p>}
          </div>
        </section>

        <div className="side">
          <section className="panel" aria-labelledby="hRoles">
            <h2 id="hRoles">Can I do my job?</h2>
            <ul className="roles">
              {!frame && <li>No probe data yet.</li>}
              {roleRows.map((r) => { const gk: Kind = r.k === 'none' ? 'blocked' : r.k; return (
                <li key={r.name} className={'k-' + gk}><Glyph kind={gk} /><div><b>{r.name}</b><strong>{ROLE_WORD[r.k]}</strong><small>{r.why}</small></div></li>
              ) })}
            </ul>
          </section>
          <section className="panel" aria-labelledby="hChanges">
            <h2 id="hChanges">Recent level changes</h2>
            {levelChanges.length ? (
              <ul className="changes">{levelChanges.map((f) => <li key={f.t} className={'k-' + LEVEL_KIND[f.level]}><Glyph kind={LEVEL_KIND[f.level]} /><div><b>{f.level}</b> <span className="mono">{hms(f.t)}</span><small>{f.verdict}</small></div></li>)}</ul>
            ) : <p className="hint">No level change in the loaded window ({frames.length} probe rounds).</p>}
          </section>
        </div>
      </div>

      <section className="panel" aria-labelledby="hAll">
        <h2 id="hAll">Services (same information as the map, as text; follows the filter above)</h2>
        <div className="tblWrap">
          <table>
            <thead><tr><th scope="col">Service</th><th scope="col">State</th><th scope="col">Family</th><th scope="col">HTTP</th><th scope="col">ms</th><th scope="col">Baseline</th></tr></thead>
            <tbody>
              {frame && shown.flatMap((f) => f.nodes.map((n) => { const v = frame.services.get(n)!; const d = D.get(n)!; return (
                <tr key={n}><th scope="row">{n}</th><td className={'k-' + d.kind}><span className="st"><Glyph kind={d.kind} />{KIND_TEXT[d.kind]}</span></td><td className="fam">{f.name}</td><td>{v.code ?? '-'}</td><td>{v.state === 'unconfigured' ? '-' : v.ms}</td><td>{v.baseline ?? '-'}</td></tr>
              ) }))}
              {frame && !shown.length && <tr><td colSpan={6} className="fam">Nothing to show with the current filter.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <footer>
        <p><b>Same-fate warning.</b> These probes run in a Power Automate flow inside Microsoft's cloud, and this page is served by Power Apps. If Power Platform, Dataverse or sign-in fails, this monitor fails with it: it is not an independent vantage point. A STALE banner appears when results stop arriving{settings.heartbeat_configured === 'yes' ? '; an external heartbeat is configured' : '; no external heartbeat is configured'}. Keep the independent host-based monitor (outage-watch-package) as the witness.</p>
        <p>States are computed in your browser from raw facts (HTTP status, elapsed time) with the same rules as the Python monitor. Data: {sim.on ? 'simulation' : source.kind === 'live' ? 'Dataverse (this environment)' : 'demo samples'} · probes every {interval} min · {__BUILD__}</p>
      </footer>
    </div>
  )
}
