import { useState } from 'react'
import { parsePeople } from './share'
import type { Me, ShareConfig, ShareEntry } from './share'
import type { DashboardDef } from './store'
import { Modal } from './ui'

const SNAPSHOT_MAX_ROWS = 50_000

export interface ShareDialogProps {
  def: DashboardDef
  me: Me
  cfg: ShareConfig
  onCfg: (c: ShareConfig) => void
  initial: { sharedWith: ShareEntry[]; everyone: 'none' | 'view' | 'edit' }      // current sharing (when already shared)
  rowCount: number
  needsSnapshot: boolean                                                          // file / pasted data that others cannot read from a source
  hasSnapshot: boolean
  onPublish: (x: { sharedWith: ShareEntry[]; everyone: 'none' | 'view' | 'edit'; snapshot: boolean }) => Promise<string | void>
  onSaveSharing: (x: { sharedWith: ShareEntry[]; everyone: 'none' | 'view' | 'edit' }) => Promise<string | void>
  onStop: () => Promise<string | void>
  appLink: string
  layoutLink: string
  onClose: () => void
}

export function ShareDialog(p: ShareDialogProps) {
  const sh = p.def.shared
  const isOwner = !sh || sh.permission === 'owner'
  const [people, setPeople] = useState<ShareEntry[]>(p.initial.sharedWith)
  const [everyone, setEveryone] = useState(p.initial.everyone)
  const [text, setText] = useState('')
  const [perm, setPerm] = useState<'view' | 'edit'>('view')
  const [snapshot, setSnapshot] = useState(p.needsSnapshot && p.rowCount <= SNAPSHOT_MAX_ROWS)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const add = () => {
    const { ok, bad } = parsePeople(text)
    if (bad.length) { setErr(`Not an email address: ${bad.join(', ')}`); return }
    setErr(null)
    setPeople((cur) => { const m = new Map(cur.map((x) => [x.user, x])); ok.filter((u) => u !== p.me.email).forEach((u) => m.set(u, { user: u, permission: perm })); return [...m.values()] })
    setText('')
  }
  const run = async (fn: () => Promise<string | void>, done: string) => {
    setBusy(true); setErr(null); setInfo(null)
    const r = await fn()
    if (r) setErr(r); else setInfo(done)
    setBusy(false)
  }
  const copy = async (what: string, value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(what) } catch { setCopied(`${what} (copy failed: select and copy this address) ${value}`) }
  }
  const tooBig = p.needsSnapshot && p.rowCount > SNAPSHOT_MAX_ROWS
  return (
    <Modal title={`Share “${p.def.name}”`} onClose={p.onClose} wide>
      <div className="form">
        <div className="share-status" role="status">
          {sh
            ? <>Shared · you are <b>{sh.permission === 'owner' ? 'the owner' : `an editor`}</b> · owner <b>{sh.owner}</b> · version {sh.version}{sh.updatedBy ? ` · last saved by ${sh.updatedBy}` : ''}</>
            : <>Not shared yet: this dashboard exists only in this browser. Signed in as <b>{p.me.email}</b>.</>}
        </div>

        <details className="where" open={!sh}>
          <summary>Where shared dashboards are stored</summary>
          <div className="seg" role="radiogroup" aria-label="Storage for shared dashboards">
            <button role="radio" aria-checked={p.cfg.kind === 'emulator'} className={p.cfg.kind === 'emulator' ? 'on' : ''} onClick={() => p.onCfg({ kind: 'emulator', url: p.cfg.kind === 'emulator' ? p.cfg.url : 'http://127.0.0.1:3200' })}>Test share store</button>
            <button role="radio" aria-checked={p.cfg.kind === 'sharepoint'} className={p.cfg.kind === 'sharepoint' ? 'on' : ''} onClick={() => p.onCfg({ kind: 'sharepoint', site: p.cfg.kind === 'sharepoint' ? p.cfg.site : '', folder: p.cfg.kind === 'sharepoint' ? p.cfg.folder : '/Shared Documents/Dashboards' })}>SharePoint folder</button>
          </div>
          {p.cfg.kind === 'emulator'
            ? <label>Emulator address<input value={p.cfg.url} onChange={(e) => p.onCfg({ kind: 'emulator', url: e.target.value })} aria-label="Share store address" /></label>
            : <>
                <label>SharePoint site address<input value={p.cfg.site} onChange={(e) => p.onCfg({ kind: 'sharepoint', site: e.target.value, folder: (p.cfg as { folder: string }).folder })} placeholder="https://contoso.sharepoint.com/sites/Sales" /></label>
                <label>Folder for shared dashboards<input value={p.cfg.folder} onChange={(e) => p.onCfg({ kind: 'sharepoint', site: (p.cfg as { site: string }).site, folder: e.target.value })} /></label>
                <div className="muted small">Experimental, not tested against a real tenant. Real access control is the folder's SharePoint permissions: share the folder with the people who should see these dashboards.</div>
              </>}
        </details>

        {isOwner ? (
          <>
            <div className="form-row">
              <label className="grow">Add people (email addresses, separated by commas)
                <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="bob@contoso.com, carol@contoso.com" aria-label="People to add" />
              </label>
              <label>Can<select value={perm} onChange={(e) => setPerm(e.target.value as 'view' | 'edit')} aria-label="Permission for new people"><option value="view">View</option><option value="edit">Edit</option></select></label>
              <button className="btn" onClick={add} disabled={!text.trim()}>Add</button>
            </div>
            {people.length > 0 && (
              <ul className="people" aria-label="People with access">
                {people.map((x) => (
                  <li key={x.user}>
                    <span className="who">{x.user}</span>
                    <select value={x.permission} aria-label={`Permission for ${x.user}`} onChange={(e) => setPeople((c) => c.map((y) => (y.user === x.user ? { ...y, permission: e.target.value as 'view' | 'edit' } : y)))}><option value="view">View</option><option value="edit">Edit</option></select>
                    <button className="icon" aria-label={`Remove ${x.user}`} onClick={() => setPeople((c) => c.filter((y) => y.user !== x.user))}>✕</button>
                  </li>
                ))}
              </ul>
            )}
            <label>Everyone who can reach the share store
              <select value={everyone} onChange={(e) => setEveryone(e.target.value as 'none' | 'view' | 'edit')} aria-label="Everyone">
                <option value="none">Only the people above</option><option value="view">Can view</option><option value="edit">Can edit</option>
              </select>
            </label>
            {p.needsSnapshot && (
              <label className="check">
                <input type="checkbox" checked={snapshot && !tooBig} disabled={tooBig} onChange={(e) => setSnapshot(e.target.checked)} />
                Include a copy of the data ({p.rowCount.toLocaleString()} rows){tooBig ? ` (too many rows, the limit is ${SNAPSHOT_MAX_ROWS.toLocaleString()})` : ''}
              </label>
            )}
          </>
        ) : (
          <div className="muted">Only the owner can change who this is shared with. You can copy the link below.</div>
        )}

        <div className="muted small">
          {p.needsSnapshot
            ? 'This dashboard reads a file or pasted data from your computer, so other people can only see it if you include a copy of the data. The copy does not refresh by itself: update it with "Save to shared" after replacing the data.'
            : 'Everyone opens this dashboard with their own access: database dashboards run through each person\'s own connection and file locations through their own access to the file, so they need access to the data too.'}
        </div>
        {err && <div className="banner error" role="alert">{err}</div>}
        {info && <div className="banner info" role="status">{info}</div>}
        {sh && <div className="links">
          <button className="btn" onClick={() => void copy('Link to open it in the app', p.appLink)}>Copy link to this shared dashboard</button>
          {copied && <span className="muted small" role="status">{copied === 'Link to open it in the app' ? 'Copied' : copied}</span>}
        </div>}
        <div className="links">
          <button className="btn" onClick={() => void copy('Layout link', p.layoutLink)}>Copy layout link (works without a share store)</button>
          <span className="muted small">Opens the same layout and data source, without data and without keeping it in sync.</span>
        </div>
      </div>
      <footer className="modal-foot">
        {sh && isOwner && <button className="btn danger" disabled={busy} onClick={() => { if (confirm('Stop sharing? Other people lose access and the shared copy is deleted. Your own copy stays.')) void run(p.onStop, 'Sharing stopped.') }}>Stop sharing</button>}
        <span className="spacer" />
        <button className="btn" onClick={p.onClose}>Close</button>
        {isOwner && (sh
          ? <button className="btn primary" disabled={busy} onClick={() => void run(() => p.onSaveSharing({ sharedWith: people, everyone }), 'Sharing updated.')}>Save sharing</button>
          : <button className="btn primary" disabled={busy} onClick={() => void run(() => p.onPublish({ sharedWith: people, everyone, snapshot: snapshot && !tooBig }), 'Published. The people above can now open it.')}>Publish and share</button>)}
      </footer>
    </Modal>
  )
}
