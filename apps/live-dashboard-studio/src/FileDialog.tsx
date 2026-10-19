import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_EMU_URL, emuCall, setEmuKey } from './emulator'
import { WATCH_CHOICES, locLabel } from './files'
import type { FileLoc } from './files'
import type { SourceDef } from './store'
import { Modal } from './ui'

interface EmuFile { Name: string; Path: string; Size: number; LastModified: string; IsFolder: boolean }
type Via = FileLoc['via']

/** "File on a server": a web link, a SharePoint / OneDrive file, or a file on the test file share. Reloaded when the file changes. */
export function FileDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (d: { name: string; source: SourceDef }) => Promise<string | void> }) {
  const [via, setVia] = useState<Via>('emulator')
  const [url, setUrl] = useState('')
  const [emuUrl, setEmuUrl] = useState(() => { try { return localStorage.getItem('lds.emuUrl') ?? DEFAULT_EMU_URL } catch { return DEFAULT_EMU_URL } })
  const [emuKeyText, setEmuKeyText] = useState('')
  const [files, setFiles] = useState<EmuFile[] | null>(null)
  const [emuPath, setEmuPath] = useState('')
  const [emuErr, setEmuErr] = useState<string | null>(null)
  const [site, setSite] = useState('')
  const [spPath, setSpPath] = useState('')
  const [odPath, setOdPath] = useState('')
  const [sheet, setSheet] = useState('')
  const [watchSec, setWatchSec] = useState(10)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const connect = useCallback(async () => {
    setEmuErr(null)
    try {
      setEmuKey(emuUrl, emuKeyText)
      const j = await emuCall(emuUrl, '/files/folder?path=/')
      const list = (j.value as EmuFile[]).filter((f) => !f.IsFolder)
      setFiles(list); setEmuPath((p) => (list.some((f) => f.Path === p) ? p : list[0]?.Path ?? ''))
      try { localStorage.setItem('lds.emuUrl', emuUrl) } catch { /* ignore */ }
    } catch (e) { setFiles(null); setEmuErr(e instanceof Error ? e.message : String(e)) }
  }, [emuUrl, emuKeyText])
  useEffect(() => { if (via === 'emulator' && !files) void connect() }, [via]) // eslint-disable-line react-hooks/exhaustive-deps

  const loc = (): FileLoc | string => {
    if (via === 'url') return /^https?:\/\//i.test(url.trim()) ? { via, url: url.trim() } : 'Enter a web address that starts with https://'
    if (via === 'emulator') return emuPath ? { via, url: emuUrl, path: emuPath } : 'Pick a file (connect to the emulator first).'
    if (via === 'sharepoint') return site.trim() && spPath.trim() ? { via, site: site.trim(), path: spPath.trim() } : 'Enter the site address and the file path.'
    return odPath.trim() ? { via, path: odPath.trim() } : 'Enter the file path in OneDrive.'
  }
  const go = async () => {
    const l = loc()
    if (typeof l === 'string') { setErr(l); return }
    setBusy(true); setErr(null)
    const fileName = (l.via === 'url' ? l.url : l.path).split('?')[0].split('/').filter(Boolean).pop() ?? 'file'
    const r = await onCreate({ name: fileName, source: { kind: 'file', loc: l, watchSec, fileName, sheet: sheet.trim() || undefined, refreshSec: 0 } })
    if (r) setErr(r)
    setBusy(false)
  }
  const VIA: { v: Via; t: string }[] = [{ v: 'emulator', t: 'Test file share' }, { v: 'url', t: 'Web link' }, { v: 'sharepoint', t: 'SharePoint' }, { v: 'onedrive', t: 'OneDrive' }]
  return (
    <Modal title="Watch a file on a server" onClose={onClose} wide>
      <div className="form">
        <div className="muted small">The dashboard checks the file every few seconds and reloads it when it changes (new rows, edited cells, a re-exported Excel or CSV).</div>
        <div className="seg" role="radiogroup" aria-label="Where the file is">
          {VIA.map((v) => <button key={v.v} role="radio" aria-checked={via === v.v} className={via === v.v ? 'on' : ''} onClick={() => setVia(v.v)}>{v.t}</button>)}
        </div>

        {via === 'emulator' && (
          <>
            <label>Emulator address<span className="row"><input value={emuUrl} onChange={(e) => setEmuUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void connect()} aria-label="Emulator address" /><button className="btn" onClick={() => void connect()}>{files ? '↻ Reload list' : 'Connect'}</button></span></label>
            {emuErr && /API key|401/i.test(emuErr) && <label>API key<input type="password" value={emuKeyText} onChange={(e) => setEmuKeyText(e.target.value)} /></label>}
            {emuErr && <div className="banner error" role="alert">{emuErr}</div>}
            {files && <label>File<select value={emuPath} onChange={(e) => setEmuPath(e.target.value)}>
              {files.map((f) => <option key={f.Path} value={f.Path}>{f.Name} · {(f.Size / 1024).toFixed(f.Size > 10240 ? 0 : 1)} KB · changed {new Date(f.LastModified).toLocaleTimeString()}</option>)}</select></label>}
            <div className="muted small">The emulator's <code>data/files</code> folder: drop or edit a CSV / Excel file there and watch the dashboard follow. <code>sales-feed.csv</code> grows by itself.</div>
          </>
        )}
        {via === 'url' && (
          <>
            <label>Web address of the file<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/exports/sales.csv" aria-label="Web address" /></label>
            <div className="muted small">Works with CSV, TSV, JSON and .xlsx at any address your browser can reach that allows cross-origin reads (CORS), for example Azure Blob Storage, an internal web server or a public link. Changes are noticed through the file's ETag / modified time.</div>
          </>
        )}
        {via === 'sharepoint' && (
          <>
            <label>SharePoint site address<input value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://contoso.sharepoint.com/sites/Sales" /></label>
            <label>File path in the library<input value={spPath} onChange={(e) => setSpPath(e.target.value)} placeholder="/Shared Documents/Reports/weekly.xlsx" /></label>
            <div className="muted small">Uses the app's SharePoint connection, so people see the file only if they have access. Needs the deploy script's <code>-SharePoint</code> option (README, "Watching files"). Not tested against a real tenant.</div>
          </>
        )}
        {via === 'onedrive' && (
          <>
            <label>File path in OneDrive for Business<input value={odPath} onChange={(e) => setOdPath(e.target.value)} placeholder="/Documents/sales.xlsx" /></label>
            <div className="muted small">Uses the app's OneDrive connection (your own OneDrive). Needs the deploy script's <code>-OneDrive</code> option. Not tested against a real tenant.</div>
          </>
        )}
        <label>Excel sheet name (optional)<input value={sheet} onChange={(e) => setSheet(e.target.value)} placeholder="first sheet" /></label>
        <label>Check for changes<select value={watchSec} onChange={(e) => setWatchSec(Number(e.target.value))}>{WATCH_CHOICES.map((r) => <option key={r.v} value={r.v}>{r.t}</option>)}</select></label>
        {err && <div className="banner error" role="alert">{err}</div>}
      </div>
      <footer className="modal-foot"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => void go()}>{busy ? 'Loading…' : 'Load and watch'}</button></footer>
    </Modal>
  )
}
export { locLabel }
