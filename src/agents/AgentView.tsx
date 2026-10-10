import { useEffect, useMemo, useState } from 'react'
import { pickBackend } from '../services'
import { NavButtons, type View } from '../nav'
import { download, toCsv } from '../util'
import type { Env } from '../types'
import type { Sev } from '../egress/analyze'
import { accessLabel, analyzeAgents, authLabel, type AgentInfo } from './analyze'
import { demoAgents } from './demo'
import { liveAgents } from './live'
import PublishBar from '../publish/PublishBar'
import { fromAgents } from '../publish/mappers'

const ls = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d } catch { return d } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* ignore */ } },
}
const SEV: Record<Sev, string> = { High: 'bad', Medium: 'warn', Low: 'mut', Info: 'mut' }

export default function AgentView({ demo, setDemo, theme, setTheme, go }: { demo: boolean; setDemo: (d: boolean) => void; theme: string; setTheme: (t: string) => void; go: (v: View) => void }) {
  const [envs, setEnvs] = useState<Env[]>([])
  const [scope, setScope] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [prog, setProg] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [data, setData] = useState<{ agents: AgentInfo[]; notes: { env: string; level: 'info' | 'warn' | 'error'; text: string }[] } | null>(null)
  const [tab, setTab] = useState<'findings' | 'agents'>('findings')
  const [sev, setSev] = useState<'all' | Sev>('all')
  const [allow, setAllow] = useState<string[]>(() => ls.get('egress.allow', []))   // shared with Egress Radar
  const [showNotes, setShowNotes] = useState(false)
  useEffect(() => { ls.set('egress.allow', allow) }, [allow])
  useEffect(() => { setEnvs([]); setData(null); pickBackend(demo).listEnvironments().then(setEnvs).catch((e) => setErr('Could not load environments: ' + (e as Error).message)) }, [demo])
  const res = useMemo(() => (data ? analyzeAgents(data.agents, allow) : null), [data, allow])
  const visible = (res?.findings ?? []).filter((f) => sev === 'all' || f.severity === sev)
  const n = (s: Sev) => res?.findings.filter((f) => f.severity === s).length ?? 0

  async function scan() {
    setErr(null); setBusy('Starting…'); setProg(0); setData(null)
    try {
      const list = scope ? envs.filter((e) => e.id === scope) : envs
      const cb = (d: number, t: number, l: string) => { setProg(d / Math.max(1, t)); setBusy(`Reading agents in ${l} (${Math.min(d + 1, t)}/${t})`) }
      setData(await (demo ? demoAgents(list, cb) : liveAgents(list, cb)))
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }

  return (
    <div className="app">
      <div className="aurora" aria-hidden />
      <header className="top">
        <div className="logo">🤖</div>
        <div><h1>Agent <span className="grad">Guard</span></h1><div className="sub">Copilot Studio agents: no-auth, maker credentials, public sources, HTTP calls · no app registration, no Defender needed</div></div>
        <div className="spacer" />
        <span className={`pill ${demo ? 'warn' : 'ok'}`}>{demo ? 'DEMO DATA' : 'LIVE'}</span>
        <button className="btn sm" onClick={() => setDemo(!demo)}>{demo ? 'Go live' : 'Demo'}</button>
        <button className="btn sm" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☀️' : '🌙'}</button>
        <NavButtons view="agents" go={go} />
      </header>
      {demo && <div className="banner" style={{ borderColor: 'var(--accent)', color: 'var(--accent2)', background: 'rgba(124,92,255,.08)' }}>Demo mode – sample agents with planted problems. Nothing is read or changed.</div>}

      <section className="card">
        <div className="search">
          <select value={scope} onChange={(e) => setScope(e.target.value)}><option value="">All environments ({envs.length})</option>{envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
          <div className="spacer" />
          <button className="btn primary" disabled={!!busy || !envs.length} onClick={() => void scan()}>{busy ? <span className="spin" /> : '🤖'} Scan agents</button>
        </div>
        {busy && <div style={{ marginTop: 14 }}><div className="sub"><span className="spin" /> {busy}</div><div className="progress"><i style={{ width: `${Math.max(4, prog * 100)}%` }} /></div></div>}
        {err && <div className="risk" style={{ marginTop: 10, color: 'var(--bad)' }}>⚠ {err}</div>}
        {!data && !busy && <div className="sub" style={{ marginTop: 10 }}>Reads every Copilot Studio agent from Dataverse and flags the misconfigurations Microsoft's own security write-ups call out: <b>no authentication</b>, tools that run with the <b>maker's credentials</b> (worst combined: an anonymous visitor acting as the maker), <b>public-website knowledge</b>, HTTP request nodes to unknown hosts, and <b>secrets typed into topics</b>. Agent flows are covered in 📡 Egress Radar. Read-only.</div>}
      </section>

      {res && data && !busy && (<>
        <div className="stats">
          <div className="card stat"><div className="n">{data.agents.length}</div><div className="l">Agents</div></div>
          <div className="card stat"><div className="n">{res.rows.filter((r) => r.f.noAuth).length}</div><div className="l">No authentication</div></div>
          <div className="card stat"><div className="n">{res.rows.filter((r) => r.f.makerTools > 0).length}</div><div className="l">Run as maker</div></div>
          {(['High', 'Medium'] as Sev[]).map((s) => <div key={s} className="card stat" style={{ cursor: 'pointer', outline: sev === s ? '2px solid var(--accent)' : undefined }} onClick={() => { setTab('findings'); setSev(sev === s ? 'all' : s) }}><div className="n">{n(s)}</div><div className="l">{s}</div></div>)}
        </div>
        <section className="card" style={{ marginBottom: 12 }}>
          <div className="row"><b>Scan report</b><span className="pill mut">{data.notes.length}</span>{data.notes.some((x) => x.level !== 'info') && <span className="pill warn">{data.notes.filter((x) => x.level !== 'info').length} warning(s)</span>}<div className="spacer" /><button className="btn sm" onClick={() => setShowNotes(!showNotes)}>{showNotes ? 'Hide' : 'Show'}</button></div>
          {showNotes && <div className="col" style={{ marginTop: 10 }}>{data.notes.map((x, i) => <div key={i} className="item"><span className={`pill ${x.level === 'error' ? 'bad' : x.level === 'warn' ? 'warn' : 'mut'}`}>{x.level}</span><div><div className="name">{x.env}</div><div className="id" style={{ whiteSpace: 'pre-wrap' }}>{x.text}</div></div></div>)}</div>}
          <div className="sub" style={{ marginTop: 8 }}>Authentication / access are read from the Dataverse <code>bot</code> columns; the raw value is shown beside each verdict because the code→meaning mapping is unverified. Who an agent is <i>shared</i> with is not read yet. Unreadable agents are unknown, not safe.</div>
        </section>
        <div className="toolbar">
          <div className="seg"><button className={tab === 'findings' ? 'on' : ''} onClick={() => setTab('findings')}>🚩 Findings <em>{res.findings.length}</em></button><button className={tab === 'agents' ? 'on' : ''} onClick={() => setTab('agents')}>🤖 Agents <em>{data.agents.length}</em></button></div>
          <div className="spacer" />
          <button className="btn sm" onClick={() => download('agent-findings.csv', toCsv(res.findings.map((f) => ({ Severity: f.severity, Rule: f.rule, Agent: f.name, Environment: f.envName, Host: f.host ?? '', Finding: f.title, Detail: f.detail }))), 'text/csv')}>⬇ CSV</button>
        </div>
        {tab === 'findings' && <div className="card tw">{visible.length === 0 ? <div className="empty"><div className="big">✅</div>No findings.</div> : <table><thead><tr><th>Severity</th><th>Agent</th><th>Environment</th><th>Finding</th><th /></tr></thead><tbody>{visible.map((f) => (
          <tr key={f.id}><td><span className={`pill ${SEV[f.severity]}`}>{f.severity}</span></td><td><div className="name">🤖 {f.name}</div></td><td>{f.envName}</td>
            <td><div className="name">{f.title}</div><div className="id" style={{ whiteSpace: 'pre-wrap' }}>{f.detail}</div></td>
            <td>{f.rule === 'NEW_EXTERNAL' && f.host && <button className="btn sm" onClick={() => setAllow((a) => [...new Set([...a, f.host!])])}>✓ Allow {f.host}</button>}</td></tr>))}</tbody></table>}</div>}
        {tab === 'agents' && <div className="card tw"><table><thead><tr><th>Agent</th><th>Environment</th><th>Authentication</th><th>Access</th><th>Maker tools</th><th>HTTP hosts</th><th>Public sites</th></tr></thead><tbody>{res.rows.map(({ a, f }) => (
          <tr key={a.key}><td><div className="name">🤖 {a.name}</div></td><td>{a.envName}</td>
            <td>{!a.fieldsOk ? <span className="pill mut">unknown</span> : <span className={`pill ${f.noAuth ? 'bad' : 'ok'}`} title={`raw ${String(a.auth?.raw)}`}>{authLabel(a.auth)}</span>}</td>
            <td>{!a.fieldsOk ? <span className="pill mut">unknown</span> : <span className={`pill ${f.openAccess ? 'warn' : 'ok'}`} title={`raw ${String(a.access?.raw)}`}>{accessLabel(a.access)}</span>}</td>
            <td>{a.compsOk ? (f.makerTools ? <span className="pill bad">{f.makerTools}</span> : '0') : <span className="pill mut">unknown</span>}</td>
            <td>{a.compsOk ? f.http.map((h) => h.host ?? '(dynamic)').join(', ') || '—' : '—'}</td><td>{a.compsOk ? f.publicSites.join(', ') || '—' : '—'}</td></tr>))}</tbody></table></div>}
        <PublishBar module="agents" demo={demo} rows={fromAgents(res.findings)} />
      </>)}
    </div>
  )
}
