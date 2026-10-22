import { useEffect, useState } from 'react'
import { Icon, Modal } from './ui'

interface Check { label: string; ok: boolean | null; detail: string }

/** Plain-language health check of the live connection. Also shown (full screen) when the app cannot start live. */
export function DiagnosticsPanel({ site }: { site?: string }) {
  const [checks, setChecks] = useState<Check[] | null>(null)
  const [url, setUrl] = useState(site ?? '')
  const run = (u?: string) => { setChecks(null); import('../services/sp').then((m) => m.diagnose(u)).then(setChecks).catch((e) => setChecks([{ label: 'Diagnostics', ok: false, detail: String(e?.message ?? e) }])) }
  useEffect(() => { run(site) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      {!checks ? <div className="skel" style={{ height: 140 }} aria-busy="true" /> : (
        <ul className="perm-list">
          {checks.map((c) => (
            <li key={c.label} style={{ alignItems: 'flex-start' }}>
              <span className={`pill ${c.ok ? 'good' : c.ok === false ? 'bad' : ''}`}>{c.ok ? 'OK' : c.ok === false ? 'Problem' : '…'}</span>
              <div style={{ flex: 1, minWidth: 0 }}><b>{c.label}</b><div className="muted small" style={{ overflowWrap: 'anywhere' }}>{c.detail}</div></div>
            </li>
          ))}
        </ul>
      )}
      <form className="row" style={{ marginTop: 10, alignItems: 'end' }} onSubmit={(e) => { e.preventDefault(); run(url.trim()) }}>
        <label className="field" style={{ flex: '1 1 300px' }}>Test a SharePoint site address<input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://contoso.sharepoint.com/sites/Finance" /></label>
        <button className="btn">Run checks again</button>
      </form>
    </div>
  )
}

export function DiagnosticsDialog({ onClose, site }: { onClose: () => void; site?: string }) {
  return (
    <Modal title="Connection diagnostics" onClose={onClose} className="wide">
      <h2 style={{ marginBottom: 8 }}><Icon n="info" /> Connection diagnostics</h2>
      <DiagnosticsPanel site={site} />
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}><button className="btn primary" onClick={onClose}>Close</button></div>
    </Modal>
  )
}

export function StartFailure({ error }: { error: string }) {
  return (
    <main style={{ padding: 24, maxWidth: 900, margin: '0 auto' }} role="alert">
      <div className="banner bad"><Icon n="info" /><div><b>The app could not connect to SharePoint.</b><div>{error}</div></div></div>
      <div className="card"><h2>Why am I not seeing my list?</h2>
        <p className="muted">Inside Power Apps this app only shows <b>live</b> data. It never switches to sample data on its own. Details below tell the owner what to fix.</p>
        <DiagnosticsPanel />
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn primary" onClick={() => location.reload()}><Icon n="refresh" size={15} />Retry</button>
          {(() => { try { return window.self === window.top } catch { return false } })() && <a className="btn" href={`${location.pathname}?demo=1`}>Look at the sample data instead</a>}
        </div>
      </div>
    </main>
  )
}
