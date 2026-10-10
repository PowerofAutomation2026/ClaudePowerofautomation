import { useEffect, useMemo, useState } from 'react'
import { pickBackend } from '../services'
import { download, toCsv } from '../util'
import type { Env } from '../types'
import { pickExposure } from '.'
import { evaluate, findingRows, powershellFix, score, SEV_ORDER } from './rules'
import type { Finding, Resource, ScanOutput, Severity, Share } from './types'
import { DEFAULT_THRESHOLDS } from './types'

type Status = { s: 'running' | 'done' | 'failed' | 'dry' | 'skipped'; msg?: string }
const SEV_PILL: Record<Severity, string> = { High: 'bad', Medium: 'warn', Low: 'mut', Info: 'mut' }
const KIND_ICON = { app: '📱', flow: '⚡', connection: '🔌' } as const

export default function ExposureView({ demo, setDemo, theme, setTheme, onBack, onBlast }: { demo: boolean; setDemo: (d: boolean) => void; theme: string; setTheme: (t: string) => void; onBack: () => void; onBlast: () => void }) {
  const ex = useMemo(() => pickExposure(demo), [demo])
  const [envs, setEnvs] = useState<Env[]>([])
  const [scope, setScope] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [prog, setProg] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [data, setData] = useState<ScanOutput | null>(null)
  const [sev, setSev] = useState<'all' | Severity>('all')
  const [kind, setKind] = useState<'all' | 'app' | 'flow' | 'connection'>('all')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<string | null>(null)
  const [fixOpen, setFixOpen] = useState(false)
  const [dry, setDry] = useState(true)
  const [confirm, setConfirm] = useState('')
  const [status, setStatus] = useState<Record<string, Status>>({})
  const [running, setRunning] = useState(false)
  const [showNotes, setShowNotes] = useState(false)
  const [diag, setDiag] = useState<{ name: string; ok: boolean; detail: string }[] | null>(null)
  const [maxEditors, setMaxEditors] = useState(DEFAULT_THRESHOLDS.maxEditors)

  useEffect(() => {
    setEnvs([]); setData(null); setErr(null)
    pickBackend(demo).listEnvironments().then(setEnvs).catch((e) => setErr('Could not load environments: ' + (e as Error).message))
  }, [demo])

  const findings = useMemo(() => (data ? evaluate(data.resources, { ...DEFAULT_THRESHOLDS, maxEditors }) : []), [data, maxEditors])
  const byKey = useMemo(() => new Map((data?.resources ?? []).map((r) => [r.key, r])), [data])
  const visible = findings.filter((f) => (sev === 'all' || f.severity === sev) && (kind === 'all' || f.kind === kind) && (!q || `${f.name} ${f.detail} ${f.envName}`.toLowerCase().includes(q.toLowerCase())))
  const fixable = (f: Finding) => !!f.share && f.kind !== 'connection'
  const counts = (['High', 'Medium', 'Low', 'Info'] as Severity[]).map((s) => [s, findings.filter((f) => f.severity === s).length] as const)
  const pts = score(findings)
  const selected = findings.filter((f) => sel.has(f.id) && fixable(f))

  async function scan() {
    setErr(null); setBusy('Starting…'); setProg(0); setSel(new Set()); setStatus({}); setData(null)
    try {
      const list = scope ? envs.filter((e) => e.id === scope) : envs
      setData(await ex.scan(list, (d, t, label) => { setProg(d / Math.max(1, t)); setBusy(`Scanning ${label} (${Math.min(d + 1, t)}/${t})`) }))
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }

  async function runFix() {
    setRunning(true)
    const todo = selected.map((f) => ({ f, r: byKey.get(f.resourceKey)!, s: f.share as Share }))
    setStatus(Object.fromEntries(todo.map((t) => [t.f.id, { s: 'running' } as Status])))
    let stop = false
    for (const { f, r, s } of todo) {
      if (stop) { setStatus((m) => ({ ...m, [f.id]: { s: 'skipped', msg: 'Not attempted - an earlier fix failed' } })); continue }
      if (dry) { setStatus((m) => ({ ...m, [f.id]: { s: 'dry', msg: `Would remove ${s.principal.name} (${s.role}) from ${r.name}` } })); continue }
      try {
        await ex.removeShare(r, s)
        const gone = await ex.verifyGone(r, s)
        setStatus((m) => ({ ...m, [f.id]: gone === false ? { s: 'failed', msg: '⚠ The service answered OK but the share is STILL there' } : { s: 'done', msg: gone ? 'Removed - verified at the source' : 'Removed (could not verify)' } }))
        if (gone === false) stop = true
      } catch (e) { stop = true; setStatus((m) => ({ ...m, [f.id]: { s: 'failed', msg: (e as Error).message } })) } // stop on first failure, like the ownership transfers
    }
    setRunning(false)
  }
  const done = new Set(Object.entries(status).filter(([, v]) => v.s === 'done').map(([k]) => k))
  const needsTyped = !dry && selected.length > 5
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  return (
    <div className="app">
      <div className="aurora" aria-hidden />
      <header className="top">
        <div className="logo">🔐</div>
        <div><h1>Exposure <span className="grad">Auditor</span></h1><div className="sub">Who can reach your Power Apps, Flows and connections — across every environment · no app registration</div></div>
        <div className="spacer" />
        <span className={`pill ${demo ? 'warn' : 'ok'}`}>{demo ? 'DEMO DATA' : 'LIVE'}</span>
        <button className="btn sm" onClick={() => setDemo(!demo)}>{demo ? 'Go live' : 'Demo'}</button>
        <button className="btn sm" onClick={() => { setDiag(null); void ex.diagnostics().then(setDiag) }}>🩺</button>
        <button className="btn sm" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☀️' : '🌙'}</button>
        <button className="btn sm" onClick={onBlast}>🕸️ Blast-Radius Map</button>
        <button className="btn sm" onClick={onBack}>← Ownership Command Center</button>
      </header>

      {demo && <div className="banner" style={{ borderColor: 'var(--accent)', color: 'var(--accent2)', background: 'rgba(124,92,255,.08)' }}>Demo mode – sample tenant with planted problems, nothing is changed.</div>}
      {diag && <section className="card" style={{ marginBottom: 12 }}>
        <div className="row"><b>Connector operations</b><div className="spacer" /><button className="btn sm" onClick={() => setDiag(null)}>Close</button></div>
        <div className="col" style={{ marginTop: 8 }}>{diag.map((r) => <div key={r.name} className="item"><span className={`pill ${r.ok ? 'ok' : 'bad'}`}>{r.ok ? 'bound' : 'missing'}</span><div><div className="name">{r.name}</div><div className="id" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{r.detail}</div></div></div>)}</div>
      </section>}

      <section className="card">
        <div className="search">
          <select value={scope} onChange={(e) => setScope(e.target.value)}><option value="">All environments ({envs.length})</option>{envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
          <label className="sub row" title="Apps with more CanEdit principals than this raise 'Too many editors'">editors &gt; <input type="number" min={1} value={maxEditors} onChange={(e) => setMaxEditors(Math.max(1, +e.target.value || 1))} style={{ width: 64 }} /></label>
          <div className="spacer" />
          <button className="btn primary" disabled={!!busy || !envs.length} onClick={() => void scan()}>{busy ? <span className="spin" /> : '🔎'} Scan exposure</button>
        </div>
        {busy && <div style={{ marginTop: 14 }}><div className="sub"><span className="spin" /> {busy}</div><div className="progress"><i style={{ width: `${Math.max(4, prog * 100)}%` }} /></div></div>}
        {err && <div className="risk" style={{ marginTop: 10, color: 'var(--bad)' }}>⚠ {err}</div>}
        {!data && !busy && <div className="sub" style={{ marginTop: 10 }}>Reads who every app, flow and connection is shared with, and flags: shared with <b>everyone</b>, <b>guests</b>, <b>credential sharing</b> through connections, connections owned by <b>disabled accounts</b>, and <b>editor / co-owner sprawl</b>. Read-only until you choose to fix something.</div>}
      </section>

      {data && !busy && (<>
        <div className="stats">
          <div className="card stat"><div className="ico">🛡️</div><div className="n">{pts}</div><div className="l">Exposure score (100 = clean)</div></div>
          {counts.map(([s, c]) => <div key={s} className="card stat" style={{ cursor: 'pointer', outline: sev === s ? '2px solid var(--accent)' : undefined }} onClick={() => setSev(sev === s ? 'all' : s)}><div className="n">{c}</div><div className="l">{s}</div></div>)}
          <div className="card stat"><div className="n">{data.resources.length}</div><div className="l">Resources inspected</div></div>
        </div>

        <section className="card" style={{ marginBottom: 12 }}>
          <div className="row"><b>Scan report</b><span className="pill mut">{data.notes.length} note(s)</span>{data.notes.some((n) => n.level !== 'info') && <span className="pill warn">{data.notes.filter((n) => n.level !== 'info').length} warning(s)</span>}
            <div className="spacer" /><button className="btn sm" onClick={() => setShowNotes(!showNotes)}>{showNotes ? 'Hide' : 'Show'}</button></div>
          {showNotes && <div className="col" style={{ marginTop: 10 }}>{data.notes.map((n, i) => <div key={i} className="item"><span className={`pill ${n.level === 'error' ? 'bad' : n.level === 'warn' ? 'warn' : 'mut'}`}>{n.level}</span><div><div className="name">{n.env}</div><div className="id" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{n.text}</div></div></div>)}</div>}
          <div className="sub" style={{ marginTop: 8 }}>An empty result can also mean a permission read failed — the report above says how many reads succeeded. A group's members cannot be expanded without a Graph app registration, so groups are reported as one principal.</div>
        </section>

        <div className="toolbar">
          <div className="seg">{(['all', 'app', 'flow', 'connection'] as const).map((k) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{k === 'all' ? '✨ All' : `${KIND_ICON[k]} ${k[0].toUpperCase() + k.slice(1)}s`} <em>{k === 'all' ? findings.length : findings.filter((f) => f.kind === k).length}</em></button>)}</div>
          <input placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="spacer" />
          <button className="btn sm" onClick={() => download('exposure-findings.csv', toCsv(findingRows(visible)), 'text/csv')}>⬇ CSV</button>
          <button className="btn sm" onClick={() => download('exposure-fix.ps1', powershellFix(findings.filter((f) => f.share).map((f) => ({ r: byKey.get(f.resourceKey)!, s: f.share! }))))}>⬇ PowerShell</button>
        </div>

        <div className="card tw">
          {visible.length === 0 ? <div className="empty"><div className="big">✅</div>No findings match these filters.</div> : (
            <table>
              <thead><tr><th /><th>Severity</th><th>Resource</th><th>Environment</th><th>Finding</th><th>Fix</th></tr></thead>
              <tbody>{visible.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]).map((f) => {
                const st = status[f.id]; const r: Resource | undefined = byKey.get(f.resourceKey)
                return (
                  <tr key={f.id} className={sel.has(f.id) ? 'sel' : ''} onClick={() => setOpen(open === f.id ? null : f.id)} style={done.has(f.id) ? { opacity: .45 } : undefined}>
                    <td onClick={(e) => e.stopPropagation()}>{fixable(f) && <input type="checkbox" checked={sel.has(f.id)} onChange={() => toggle(f.id)} />}</td>
                    <td><span className={`pill ${SEV_PILL[f.severity]}`}>{f.severity}</span></td>
                    <td><div className="name">{KIND_ICON[f.kind]} {f.name}</div><div className="id">{r?.owner?.email ?? r?.owner?.name ?? ''}</div></td>
                    <td>{f.envName}</td>
                    <td><div className="name">{f.title}</div>{(open === f.id || st) && <div className="id" style={{ whiteSpace: 'pre-wrap' }}>{f.detail}{st && <div style={{ color: st.s === 'failed' ? 'var(--bad)' : st.s === 'done' ? 'var(--ok)' : 'var(--muted)' }}>{st.s === 'running' ? '⏳ working…' : st.msg}</div>}</div>}</td>
                    <td>{f.share ? (f.kind === 'connection' ? <span className="pill mut" title="Report-only: remove in the admin center or with the PowerShell export">manual</span> : <span className="pill ok">1-click</span>) : <span className="pill mut">review</span>}</td>
                  </tr>)
              })}</tbody>
            </table>)}
        </div>

        <div className="sticky">
          <b>{selected.length}</b> fixable finding(s) selected
          <button className="btn sm" onClick={() => setSel(new Set(visible.filter(fixable).map((f) => f.id)))}>Select all fixable</button>
          <button className="btn sm" onClick={() => setSel(new Set())}>Clear</button>
          <div className="spacer" />
          <button className="btn primary" disabled={!selected.length} onClick={() => { setFixOpen(true); setConfirm(''); setStatus({}) }}>Remove selected shares →</button>
        </div>
      </>)}

      {fixOpen && (<><div className="drawer-bg" onClick={() => !running && setFixOpen(false)} />
        <div className="drawer">
          <h2>Remove shares</h2>
          <div className="sub">Removes the listed principal from each app / flow. The resource itself, its data and its owner are untouched. Connection shares are report-only.</div>
          <label className="row" style={{ margin: '12px 0' }}><input type="checkbox" checked={dry} onChange={(e) => setDry(e.target.checked)} /> <b>Dry run</b> <span className="sub">(nothing is changed)</span></label>
          <div className="col">{selected.map((f) => { const st = status[f.id]; return (
            <div key={f.id} className="item"><span className={`pill ${st?.s === 'done' ? 'ok' : st?.s === 'failed' ? 'bad' : st?.s === 'dry' ? 'warn' : 'mut'}`}>{st?.s ?? 'pending'}</span>
              <div><div className="name">{f.name} · {f.share!.principal.name}</div><div className="id">{f.share!.role} · {f.envName}{st?.msg ? ` — ${st.msg}` : ''}</div></div></div>) })}</div>
          {needsTyped && <div style={{ marginTop: 12 }}><div className="sub">Type <b>REMOVE {selected.length}</b> to confirm</div><input value={confirm} onChange={(e) => setConfirm(e.target.value)} /></div>}
          <div className="row" style={{ marginTop: 14 }}>
            <button className={`btn ${dry ? 'primary' : 'danger'}`} disabled={running || !selected.length || (needsTyped && confirm !== `REMOVE ${selected.length}`)} onClick={() => void runFix()}>{running ? <span className="spin" /> : null} {dry ? 'Run dry run' : `Remove ${selected.length} share(s)`}</button>
            <button className="btn" disabled={running} onClick={() => { setFixOpen(false); if (done.size) void scan() }}>{done.size ? 'Close & re-scan' : 'Close'}</button>
          </div>
          <div className="sub" style={{ marginTop: 10 }}>Stops at the first failure and reads the share back from the source to confirm it is gone. Unverified connector paths: see 🩺 for what is bound on this build.</div>
        </div></>)}
    </div>
  )
}
