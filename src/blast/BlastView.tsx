import { useEffect, useMemo, useState } from 'react'
import { pickBackend } from '../services'
import { pickExposure } from '../exposure'
import { download, toCsv } from '../util'
import type { Env } from '../types'
import type { ScanOutput } from '../exposure/types'
import { blast, blastFindings, buildGraph, offboarding, pathTo, topUsers, traverse, type EdgeType, type GNode } from './graph'

const KIND_ICON = { user: '👤', flow: '⚡', app: '📱', connection: '🔌', surface: '🗄️' } as const
const EDGE_COLOR: Record<EdgeType, string> = { edits: '#fb7185', views: '#8b90b0', uses: '#fbbf24', canUse: '#fb923c', actsAs: '#a78bfa', reaches: '#22d3ee' }
const EDGE_LABEL: Record<EdgeType, string> = { edits: 'can edit', views: 'can view / run', uses: 'runs with', canUse: 'can use', actsAs: 'acts as (control-plane credential)', reaches: 'reaches' }
const SEV_PILL = { High: 'bad', Medium: 'warn', Low: 'mut', Info: 'mut' } as const
type Mode = 'forward' | 'reverse' | 'offboard'

export default function BlastView({ demo, setDemo, theme, setTheme, onBack, onExposure }: { demo: boolean; setDemo: (d: boolean) => void; theme: string; setTheme: (t: string) => void; onBack: () => void; onExposure: () => void }) {
  const ex = useMemo(() => pickExposure(demo), [demo])
  const [envs, setEnvs] = useState<Env[]>([])
  const [scope, setScope] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [prog, setProg] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [data, setData] = useState<ScanOutput | null>(null)
  const [seed, setSeed] = useState('')
  const [mode, setMode] = useState<Mode>('forward')
  const [pick, setPick] = useState<string | null>(null)
  const [showNotes, setShowNotes] = useState(false)

  useEffect(() => { setEnvs([]); setData(null); pickBackend(demo).listEnvironments().then(setEnvs).catch((e) => setErr('Could not load environments: ' + (e as Error).message)) }, [demo])
  const g = useMemo(() => (data ? buildGraph(data.resources) : null), [data])
  const top = useMemo(() => (g ? topUsers(g, 10) : []), [g])
  const findings = useMemo(() => (g ? blastFindings(g) : []), [g])
  const users = useMemo(() => (g ? [...g.nodes.values()].filter((n) => n.kind === 'user' && n.ptype !== 'Tenant').sort((a, b) => a.label.localeCompare(b.label)) : []), [g])
  useEffect(() => { if (g && !seed && top[0]) setSeed(top[0].user.id) }, [g, top, seed])

  async function scan() {
    setErr(null); setBusy('Starting…'); setProg(0); setData(null); setSeed(''); setPick(null)
    try { const list = scope ? envs.filter((e) => e.id === scope) : envs; setData(await ex.scan(list, (d, t, l) => { setProg(d / Math.max(1, t)); setBusy(`Scanning ${l} (${Math.min(d + 1, t)}/${t})`) })) }
    catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }

  const reverse = mode === 'reverse'
  const reach = useMemo(() => (g && seed ? traverse(g, seed, reverse) : null), [g, seed, reverse])
  const summary = useMemo(() => (g && seed ? blast(g, seed) : null), [g, seed])
  const off = useMemo(() => (g && seed ? offboarding(g, seed) : null), [g, seed])
  const seedNode = g?.nodes.get(seed)

  // layered layout: column = distance from the seed
  const layout = useMemo(() => {
    if (!g || !reach) return null
    const cols: string[][] = []
    for (const [id, r] of reach) (cols[r.depth] ??= []).push(id)
    const W = 210, H = 52, pos = new Map<string, { x: number; y: number }>()
    const shown = cols.map((c) => c.slice(0, 40))
    shown.forEach((c, d) => c.forEach((id, i) => pos.set(id, { x: 20 + d * W, y: 20 + i * H })))
    const edges = [...reach].flatMap(([id, r]) => (r.prev ? [{ e: r.prev, a: reverse ? r.prev.to : r.prev.from, b: id }] : [])).filter((x) => pos.has(x.a) && pos.has(x.b))
    return { pos, w: 20 + shown.length * W + 40, h: 40 + Math.max(1, ...shown.map((c) => c.length)) * H, edges, hidden: cols.reduce((n, c) => n + Math.max(0, c.length - 40), 0) }
  }, [g, reach, reverse])
  const hot = useMemo(() => new Set(g && reach && pick ? pathTo(g, reach, pick, reverse) : []), [g, reach, pick, reverse])
  const pickNode: GNode | undefined = pick ? g?.nodes.get(pick) : undefined

  return (
    <div className="app">
      <div className="aurora" aria-hidden />
      <header className="top">
        <div className="logo">🕸️</div>
        <div><h1>Credential <span className="grad">Blast-Radius Map</span></h1><div className="sub">If this account is compromised or leaves — whose credentials can it act through, and what does it reach? · no app registration</div></div>
        <div className="spacer" />
        <span className={`pill ${demo ? 'warn' : 'ok'}`}>{demo ? 'DEMO DATA' : 'LIVE'}</span>
        <button className="btn sm" onClick={() => setDemo(!demo)}>{demo ? 'Go live' : 'Demo'}</button>
        <button className="btn sm" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☀️' : '🌙'}</button>
        <button className="btn sm" onClick={onExposure}>🔐 Exposure Auditor</button>
        <button className="btn sm" onClick={onBack}>← Ownership Command Center</button>
      </header>
      {demo && <div className="banner" style={{ borderColor: 'var(--accent)', color: 'var(--accent2)', background: 'rgba(124,92,255,.08)' }}>Demo mode – sample tenant with a planted escalation chain. Nothing is read or changed.</div>}

      <section className="card">
        <div className="search">
          <select value={scope} onChange={(e) => setScope(e.target.value)}><option value="">All environments ({envs.length})</option>{envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
          <div className="spacer" />
          <button className="btn primary" disabled={!!busy || !envs.length} onClick={() => void scan()}>{busy ? <span className="spin" /> : '🕸️'} Build the map</button>
        </div>
        {busy && <div style={{ marginTop: 14 }}><div className="sub"><span className="spin" /> {busy}</div><div className="progress"><i style={{ width: `${Math.max(4, prog * 100)}%` }} /></div></div>}
        {err && <div className="risk" style={{ marginTop: 10, color: 'var(--bad)' }}>⚠ {err}</div>}
        {!data && !busy && <div className="sub" style={{ marginTop: 10 }}>Links every <b>user → flow/app → connection → data</b> in your tenant, then answers: <b>if this person is compromised</b>, what can the attacker act through (including chains via admin-type credentials)? <b>Who can act as this person?</b> <b>What breaks and what stays reachable when they are offboarded?</b> Read-only.</div>}
      </section>

      {g && data && !busy && (<>
        <div className="stats">
          <div className="card stat"><div className="n">{[...g.nodes.values()].filter((n) => n.kind === 'user').length}</div><div className="l">Identities</div></div>
          <div className="card stat"><div className="n">{[...g.nodes.values()].filter((n) => n.kind === 'connection').length}</div><div className="l">Connections (credentials)</div></div>
          <div className="card stat"><div className="n">{findings.filter((f) => f.severity === 'High').length}</div><div className="l">High findings</div></div>
          <div className="card stat"><div className="n">{findings.filter((f) => f.rule === 'CHAIN').length}</div><div className="l">Escalation chains</div></div>
          <div className="card envcard"><div className="l sub">HIGHEST BLAST RADIUS · click to inspect</div>
            <div className="bars">{top.slice(0, 5).map((t) => <div key={t.user.id} className={`bar${seed === t.user.id ? ' on' : ''}`} onClick={() => { setSeed(t.user.id); setPick(null) }}><span>{t.user.label}</span><i style={{ width: `${(t.score / Math.max(1, top[0].score)) * 100}%` }} /><b>{t.score}</b></div>)}</div></div>
        </div>

        <section className="card" style={{ marginBottom: 12 }}>
          <div className="row">
            <select value={seed} onChange={(e) => { setSeed(e.target.value); setPick(null) }} style={{ minWidth: 240 }}>{users.map((u) => <option key={u.id} value={u.id}>{u.label}{u.sub ? ` — ${u.sub}` : ''}{u.ptype === 'Guest' ? ' (guest)' : ''}</option>)}</select>
            <div className="seg">
              <button className={mode === 'forward' ? 'on' : ''} onClick={() => setMode('forward')}>💥 If compromised</button>
              <button className={mode === 'reverse' ? 'on' : ''} onClick={() => setMode('reverse')}>🎭 Who can act as them</button>
              <button className={mode === 'offboard' ? 'on' : ''} onClick={() => setMode('offboard')}>🚪 Offboarding</button>
            </div>
            {summary && mode !== 'offboard' && <span className="pill mut">{mode === 'forward' ? `blast radius ${summary.score} · ${summary.conns.length} credential(s)` : `${(reach ? [...reach.keys()].filter((id) => g.nodes.get(id)?.kind === 'user').length - 1 : 0)} account(s) can act as them`}</span>}
          </div>

          {mode !== 'offboard' && layout && (<div style={{ overflow: 'auto', marginTop: 12, maxHeight: 520 }}>
            <svg width={layout.w} height={layout.h} role="img" aria-label="Credential reach graph">
              <defs>{(Object.keys(EDGE_COLOR) as EdgeType[]).map((t) => <marker key={t} id={`ar-${t}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill={EDGE_COLOR[t]} /></marker>)}</defs>
              {layout.edges.map(({ e, a, b }, i) => { const A = layout.pos.get(a)!, B = layout.pos.get(b)!; const on = hot.has(a) && hot.has(b); const x1 = A.x + 160, x2 = B.x, y1 = A.y + 18, y2 = B.y + 18
                return <path key={i} d={`M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`} fill="none" stroke={EDGE_COLOR[e.type]} strokeWidth={(on ? 2 : 0.8) + e.w * 2} opacity={pick && !on ? 0.2 : 0.85} markerEnd={`url(#ar-${e.type})`}><title>{EDGE_LABEL[e.type]}</title></path> })}
              {[...layout.pos].map(([id, p]) => { const n = g.nodes.get(id)!; const dead = n.disabled; const sel = pick === id
                return <g key={id} transform={`translate(${p.x},${p.y})`} onClick={() => setPick(sel ? null : id)} style={{ cursor: 'pointer' }} opacity={pick && !hot.has(id) ? 0.4 : 1}>
                  <rect width={160} height={36} rx={9} fill="var(--bg2)" stroke={sel ? 'var(--accent)' : n.kind === 'connection' && (n.sens ?? 0) >= 5 ? 'var(--bad)' : id === seed ? 'var(--accent2)' : 'var(--card-b)'} strokeWidth={sel || id === seed ? 2 : 1} />
                  <text x={8} y={15} fontSize={11} fill="var(--text)">{KIND_ICON[n.kind]} {n.label.length > 19 ? n.label.slice(0, 18) + '…' : n.label}{dead ? ' ⛔' : ''}</text>
                  <text x={8} y={29} fontSize={9.5} fill="var(--muted)">{(n.kind === 'user' ? (n.ptype === 'Guest' ? 'external guest' : n.ptype === 'Group' ? 'group (members unknown)' : n.sub ?? 'user') : n.sub ?? n.kind).slice(0, 28)}</text>
                  <title>{n.label}</title></g> })}
            </svg></div>)}
          {mode !== 'offboard' && layout && layout.hidden > 0 && <div className="sub">{layout.hidden} more node(s) hidden for readability.</div>}
          {mode !== 'offboard' && <div className="row sub" style={{ marginTop: 8 }}>{(Object.keys(EDGE_COLOR) as EdgeType[]).map((t) => <span key={t}><i style={{ display: 'inline-block', width: 18, height: 3, background: EDGE_COLOR[t], marginRight: 5, verticalAlign: 'middle' }} />{EDGE_LABEL[t]}</span>)}</div>}
          {pickNode && mode !== 'offboard' && <div className="item" style={{ marginTop: 10 }}><div><div className="name">{KIND_ICON[pickNode.kind]} {pickNode.label}</div><div className="id" style={{ whiteSpace: 'pre-wrap' }}>Path: {pathTo(g, reach!, pickNode.id, reverse).map((i) => g.nodes.get(i)?.label).join(' → ')}</div></div></div>}
          {mode === 'forward' && summary && summary.conns.length > 0 && <div className="col" style={{ marginTop: 10 }}>{summary.conns.slice(0, 8).map((c) => <div key={c.node.id} className="item" style={{ cursor: 'pointer' }} onClick={() => setPick(c.node.id)}><span className={`pill ${(c.node.sens ?? 0) >= 5 ? 'bad' : (c.node.sens ?? 0) >= 4 ? 'warn' : 'mut'}`}>sens {c.node.sens}</span><div><div className="name">{c.node.label} <span className="sub">· {c.node.sub}</span></div><div className="id">{c.path.map((i) => g.nodes.get(i)?.label).join(' → ')}</div></div></div>)}</div>}
          {mode === 'offboard' && off && seedNode && (<div className="col" style={{ marginTop: 12 }}>
            <div className="sub">If <b>{seedNode.label}</b> is disabled today:</div>
            <div className="item"><span className="pill warn">{off.breaks.length}</span><div><div className="name">flows / apps will stop working (they run with their credentials)</div><div className="id">{off.breaks.map((b) => `${KIND_ICON[b.kind]} ${b.label} (${b.sub})`).join(', ') || 'none'}</div></div></div>
            <div className="item"><span className="pill bad">{off.stillUsable.length}</span><div><div className="name">credential(s) others can still use, with nobody watching the identity</div><div className="id">{off.stillUsable.map((s) => `${s.who.label} → ${s.conn.label}`).join(', ') || 'none'}</div></div></div>
            <div className="item"><span className="pill warn">{off.orphaned.length}</span><div><div className="name">flow(s)/app(s) only they can edit (will be orphaned — transfer first)</div><div className="id">{off.orphaned.map((o) => o.label).join(', ') || 'none'}</div></div></div>
            <div className="row"><button className="btn sm" onClick={onBack}>Open Ownership Command Center to transfer →</button></div>
          </div>)}
        </section>

        <section className="card" style={{ marginBottom: 12 }}>
          <div className="row"><b>Findings</b><span className="pill mut">{findings.length}</span><div className="spacer" />
            <button className="btn sm" onClick={() => download('blast-findings.csv', toCsv(findings.map((f) => ({ Severity: f.severity, Rule: f.rule, Finding: f.title, Detail: f.detail, Path: (f.path ?? []).map((i) => g.nodes.get(i)?.label).join(' > ') }))), 'text/csv')}>⬇ CSV</button></div>
          <div className="col" style={{ marginTop: 10 }}>{findings.length === 0 ? <div className="sub">No findings. If the scan report shows failed reads, the map may be incomplete — that is not the same as safe.</div> : findings.map((f) => (
            <div key={f.id} className="item" style={{ cursor: f.path ? 'pointer' : undefined }} onClick={() => { if (f.path) { const s = f.path[0]; if (g.nodes.get(s)?.kind === 'user') { setSeed(s); setMode('forward'); setPick(f.path[f.path.length - 1]) } } }}>
              <span className={`pill ${SEV_PILL[f.severity]}`}>{f.severity}</span><div><div className="name">{f.title}</div><div className="id" style={{ whiteSpace: 'pre-wrap' }}>{f.detail}</div></div></div>))}</div>
        </section>

        <section className="card">
          <div className="row"><b>Scan report</b><span className="pill mut">{data.notes.length}</span><div className="spacer" /><button className="btn sm" onClick={() => setShowNotes(!showNotes)}>{showNotes ? 'Hide' : 'Show'}</button></div>
          {showNotes && <div className="col" style={{ marginTop: 10 }}>{data.notes.map((n, i) => <div key={i} className="item"><span className={`pill ${n.level === 'error' ? 'bad' : n.level === 'warn' ? 'warn' : 'mut'}`}>{n.level}</span><div><div className="name">{n.env}</div><div className="id" style={{ whiteSpace: 'pre-wrap' }}>{n.text}</div></div></div>)}</div>}
          <div className="sub" style={{ marginTop: 8 }}>Not knowable without an app registration (shown as unknown, never as safe): group membership, Entra roles, sign-in activity, what a credential is <i>actually</i> permitted to do at the data source. Reach means "can act through the stored credential", an upper bound. This tool is for defenders: audit, offboarding and least privilege.</div>
        </section>
      </>)}
    </div>
  )
}
