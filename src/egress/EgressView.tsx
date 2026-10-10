import { useEffect, useMemo, useState } from 'react'
import { pickBackend } from '../services'
import { NavButtons, type View } from '../nav'
import { download, toCsv } from '../util'
import type { Env } from '../types'
import { analyze, type FlowDef, type Sev } from './analyze'
import { demoScan } from './demo'
import { liveScan, stopBound, stopFlow } from './live'
import PublishBar from '../publish/PublishBar'
import { fromEgress } from '../publish/mappers'

const ls = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d } catch { return d } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* ignore */ } },
}
const SEV_PILL: Record<Sev, string> = { High: 'bad', Medium: 'warn', Low: 'mut', Info: 'mut' }

export default function EgressView({ demo, setDemo, theme, setTheme, go }: { demo: boolean; setDemo: (d: boolean) => void; theme: string; setTheme: (t: string) => void; go: (v: View) => void }) {
  const [envs, setEnvs] = useState<Env[]>([])
  const [scope, setScope] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [prog, setProg] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [data, setData] = useState<{ flows: FlowDef[]; notes: { env: string; level: 'info' | 'warn' | 'error'; text: string }[] } | null>(null)
  const [tab, setTab] = useState<'findings' | 'dests'>('findings')
  const [sev, setSev] = useState<'all' | Sev>('all')
  const [q, setQ] = useState('')
  const [allow, setAllow] = useState<string[]>(() => ls.get('egress.allow', []))
  const [domains, setDomains] = useState<string>(() => ls.get('egress.domains', ''))
  const [showNotes, setShowNotes] = useState(false)
  const [msg, setMsg] = useState<Record<string, string>>({})
  useEffect(() => { ls.set('egress.allow', allow) }, [allow])
  useEffect(() => { ls.set('egress.domains', domains) }, [domains])
  useEffect(() => { setEnvs([]); setData(null); pickBackend(demo).listEnvironments().then(setEnvs).catch((e) => setErr('Could not load environments: ' + (e as Error).message)) }, [demo])

  const internal = useMemo(() => domains.split(/[,\s;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean), [domains])
  const res = useMemo(() => (data ? analyze(data.flows, { allow, internalDomains: internal }) : null), [data, allow, internal])
  const flowByKey = useMemo(() => new Map((data?.flows ?? []).map((f) => [f.key, f])), [data])
  const visible = (res?.findings ?? []).filter((f) => (sev === 'all' || f.severity === sev) && (!q || `${f.name} ${f.host ?? ''} ${f.detail}`.toLowerCase().includes(q.toLowerCase())))
  const count = (s: Sev) => res?.findings.filter((f) => f.severity === s).length ?? 0

  async function scan() {
    setErr(null); setBusy('Starting…'); setProg(0); setData(null)
    try {
      const list = scope ? envs.filter((e) => e.id === scope) : envs
      const cb = (d: number, t: number, l: string) => { setProg(d / Math.max(1, t)); setBusy(`Reading flow definitions in ${l} (${Math.min(d + 1, t)}/${t})`) }
      setData(await (demo ? demoScan(list, cb) : liveScan(list, cb)))
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }
  async function stop(f: FlowDef) {
    if (!window.confirm(`Stop the flow "${f.name}" (${f.envName})?\n\nIts trigger is turned off; nothing is deleted. You can turn it back on in Power Automate.`)) return
    setMsg((m) => ({ ...m, [f.key]: 'stopping…' }))
    try {
      if (demo) { await new Promise((r) => setTimeout(r, 400)); setMsg((m) => ({ ...m, [f.key]: 'Stopped (demo)' })); return }
      const ok = await stopFlow(f)
      setMsg((m) => ({ ...m, [f.key]: ok === false ? '⚠ service answered OK but the flow is NOT stopped' : ok ? '✓ Stopped - verified at the source' : 'Stopped (could not verify)' }))
    } catch (e) { setMsg((m) => ({ ...m, [f.key]: (e as Error).message })) }
  }

  return (
    <div className="app">
      <div className="aurora" aria-hidden />
      <header className="top">
        <div className="logo">📡</div>
        <div><h1>Egress <span className="grad">Radar</span></h1><div className="sub">Where does every flow send your data? Destinations, secrets in flows, external mail · no app registration</div></div>
        <div className="spacer" />
        <span className={`pill ${demo ? 'warn' : 'ok'}`}>{demo ? 'DEMO DATA' : 'LIVE'}</span>
        <button className="btn sm" onClick={() => setDemo(!demo)}>{demo ? 'Go live' : 'Demo'}</button>
        <button className="btn sm" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☀️' : '🌙'}</button>
        <NavButtons view="egress" go={go} />
      </header>
      {demo && <div className="banner" style={{ borderColor: 'var(--accent)', color: 'var(--accent2)', background: 'rgba(124,92,255,.08)' }}>Demo mode – sample flow definitions with planted problems. Nothing is read or changed.</div>}

      <section className="card">
        <div className="search">
          <select value={scope} onChange={(e) => setScope(e.target.value)}><option value="">All environments ({envs.length})</option>{envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
          <input placeholder="Your email domains, e.g. contoso.com, contoso.onmicrosoft.com (for external-mail check)" value={domains} onChange={(e) => setDomains(e.target.value)} style={{ flex: 1, minWidth: 260 }} />
          <button className="btn primary" disabled={!!busy || !envs.length} onClick={() => void scan()}>{busy ? <span className="spin" /> : '📡'} Scan egress</button>
        </div>
        {busy && <div style={{ marginTop: 14 }}><div className="sub"><span className="spin" /> {busy}</div><div className="progress"><i style={{ width: `${Math.max(4, prog * 100)}%` }} /></div></div>}
        {err && <div className="risk" style={{ marginTop: 10, color: 'var(--bad)' }}>⚠ {err}</div>}
        {!data && !busy && <div className="sub" style={{ marginTop: 10 }}>Opens every flow definition and lists <b>every host a flow sends data to</b> — the thing DLP and the admin center don't show. Flags capture/paste/tunnel services, raw IPs, plain HTTP, <b>secrets typed into flows</b>, destinations computed at run time, fixed external email recipients and flows startable by HTTP request. Read-only.</div>}
      </section>

      {res && data && !busy && (<>
        <div className="stats">
          <div className="card stat"><div className="n">{data.flows.length}</div><div className="l">Flows analysed</div></div>
          <div className="card stat"><div className="n">{data.flows.filter((f) => f.agentFlow).length}</div><div className="l">Agent flows</div></div>
          <div className="card stat"><div className="n">{res.withHttp}</div><div className="l">Flows with HTTP calls</div></div>
          <div className="card stat"><div className="n">{res.dests.length}</div><div className="l">Distinct destinations</div></div>
          {(['High', 'Medium', 'Info'] as Sev[]).map((s) => <div key={s} className="card stat" style={{ cursor: 'pointer', outline: sev === s ? '2px solid var(--accent)' : undefined }} onClick={() => { setTab('findings'); setSev(sev === s ? 'all' : s) }}><div className="n">{count(s)}</div><div className="l">{s}</div></div>)}
        </div>

        <section className="card" style={{ marginBottom: 12 }}>
          <div className="row"><b>Scan report</b><span className="pill mut">{data.notes.length}</span>{data.notes.some((n) => n.level !== 'info') && <span className="pill warn">{data.notes.filter((n) => n.level !== 'info').length} warning(s)</span>}<div className="spacer" /><button className="btn sm" onClick={() => setShowNotes(!showNotes)}>{showNotes ? 'Hide' : 'Show'}</button></div>
          {showNotes && <div className="col" style={{ marginTop: 10 }}>{data.notes.map((n, i) => <div key={i} className="item"><span className={`pill ${n.level === 'error' ? 'bad' : n.level === 'warn' ? 'warn' : 'mut'}`}>{n.level}</span><div><div className="name">{n.env}</div><div className="id" style={{ whiteSpace: 'pre-wrap' }}>{n.text}</div></div></div>)}</div>}
          <div className="sub" style={{ marginTop: 8 }}>Flows whose definition could not be read are <b>unknown, not safe</b>. Custom connectors, child flows and Dataverse actions are not followed; only literal values in the definition are analysed (a secret held in an environment variable is correctly not flagged).</div>
        </section>

        <div className="toolbar">
          <div className="seg"><button className={tab === 'findings' ? 'on' : ''} onClick={() => setTab('findings')}>🚩 Findings <em>{res.findings.length}</em></button><button className={tab === 'dests' ? 'on' : ''} onClick={() => setTab('dests')}>🌐 Destinations <em>{res.dests.length}</em></button></div>
          <input placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="spacer" />
          <button className="btn sm" onClick={() => download('egress-findings.csv', toCsv(res.findings.map((f) => ({ Severity: f.severity, Rule: f.rule, Flow: f.name, Environment: f.envName, Host: f.host ?? '', Finding: f.title, Detail: f.detail }))), 'text/csv')}>⬇ Findings CSV</button>
          <button className="btn sm" onClick={() => download('egress-destinations.csv', toCsv(res.dests.map((d) => ({ Host: d.host, Flows: d.flows.size, Environments: [...d.envs].join('; '), MicrosoftService: d.first, CaptureService: d.exfil, AllowListed: d.allowed || allow.some((a) => d.host.endsWith(a)) }))), 'text/csv')}>⬇ Destinations CSV</button>
        </div>

        {tab === 'findings' && <div className="card tw">{visible.length === 0 ? <div className="empty"><div className="big">✅</div>No findings match.</div> : (
          <table><thead><tr><th>Severity</th><th>Flow</th><th>Environment</th><th>Finding</th><th /></tr></thead>
            <tbody>{visible.map((f) => { const fl = flowByKey.get(f.flowKey); return (
              <tr key={f.id}><td><span className={`pill ${SEV_PILL[f.severity]}`}>{f.severity}</span></td>
                <td><div className="name">{fl?.agentFlow ? '🤖' : '⚡'} {f.name}{fl?.agentFlow && <span className="pill warn" style={{ marginLeft: 6 }}>agent flow</span>}</div><div className="id">{fl?.state ?? ''}</div></td><td>{f.envName}</td>
                <td><div className="name">{f.title}</div><div className="id" style={{ whiteSpace: 'pre-wrap' }}>{f.detail}{msg[f.flowKey] && <div style={{ color: 'var(--accent2)' }}>{msg[f.flowKey]}</div>}</div></td>
                <td><div className="col">{f.rule === 'NEW_EXTERNAL' && f.host && <button className="btn sm" onClick={() => setAllow((a) => [...new Set([...a, f.host!])])}>✓ Allow {f.host}</button>}
                  {f.severity === 'High' && fl && /^started$/i.test(fl.state ?? '') && <button className="btn sm danger" disabled={!demo && !stopBound()} title={!demo && !stopBound() ? 'No "stop flow as admin" operation bound in this build (see 🩺)' : 'Turn the flow off (nothing is deleted)'} onClick={() => void stop(fl)}>⏹ Stop flow</button>}</div></td></tr>) })}</tbody></table>)}</div>}

        {tab === 'dests' && <div className="card tw"><table><thead><tr><th>Destination</th><th>Flows</th><th>Environments</th><th>Class</th><th /></tr></thead>
          <tbody>{res.dests.map((d) => (
            <tr key={d.host}><td><div className="name">{d.host}</div></td><td>{d.flows.size}</td><td>{[...d.envs].join(', ')}</td>
              <td>{d.exfil ? <span className="pill bad">capture / paste / tunnel</span> : d.first ? <span className="pill ok">Microsoft service</span> : d.allowed ? <span className="pill ok">allow-listed</span> : /^(\d{1,3}\.){3}\d{1,3}$/.test(d.host) ? <span className="pill bad">raw IP</span> : <span className="pill warn">external · unreviewed</span>}</td>
              <td>{!d.first && !d.allowed && !d.exfil && <button className="btn sm" onClick={() => setAllow((a) => [...new Set([...a, d.host])])}>✓ Allow</button>}</td></tr>))}</tbody></table></div>}

        <PublishBar module="egress" demo={demo} rows={fromEgress(res.findings)} />

        {allow.length > 0 && <section className="card" style={{ marginTop: 12 }}><b>Allow-list</b> <span className="sub">(kept in this browser)</span>
          <div className="chips">{allow.map((a) => <span key={a} className="chip" title="Remove" onClick={() => setAllow(allow.filter((x) => x !== a))}>{a} ✕</span>)}</div></section>}
      </>)}
    </div>
  )
}
