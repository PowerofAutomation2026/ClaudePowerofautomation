import { useState } from 'react'
import { liveStore, tableBound } from './live'
import { memoryStore, publish, type FindingRow, type Module } from './persist'

const demoStore = memoryStore()

/** One button that saves the current scan's findings to Dataverse so a Copilot Studio agent can answer questions about them. */
export default function PublishBar({ module, rows, demo }: { module: Module; rows: FindingRow[]; demo: boolean }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  async function go() {
    setMsg(null); setBusy('Publishing…')
    try {
      const store = demo ? demoStore : liveStore()
      const r = await publish(store, module, rows, (d, t) => setBusy(`Publishing ${d}/${t}…`))
      setMsg({ ok: !r.failed, text: `${demo ? '[demo, nothing saved] ' : ''}${r.created} new · ${r.updated} updated · ${r.fixed} marked fixed${r.failed ? ` · ${r.failed} FAILED (${r.errors[0] ?? ''})` : ''}` })
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(null) }
  }
  const missing = !demo && !tableBound()
  return (
    <section className="card" style={{ marginTop: 12 }}>
      <div className="row">
        <b>🤝 Copilot agent</b><span className="sub">Save these {rows.length} finding(s) to Dataverse so a Copilot Studio agent can answer questions about them (the asking user's own permissions apply).</span>
        <div className="spacer" />
        <button className="btn primary" disabled={!!busy || missing || !rows.length} title={missing ? 'Table occ_finding is not added to this app yet - see agent/README.md' : ''} onClick={() => void go()}>{busy ?? '📤 Publish to Copilot agent'}</button>
      </div>
      {missing && <div className="sub" style={{ marginTop: 6, color: 'var(--warn)' }}>⚠ Not set up: the Dataverse table <code>occ_finding</code> is not part of this build. Run <code>scripts/Setup-OccDataverse.ps1</code>, then re-run Deploy.cmd (one time). Steps: <code>agent/README.md</code>.</div>}
      {msg && <div className="sub" style={{ marginTop: 6, color: msg.ok ? 'var(--ok)' : 'var(--bad)' }}>{msg.text}</div>}
    </section>
  )
}
