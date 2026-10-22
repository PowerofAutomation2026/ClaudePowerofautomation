import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Backend, SourceConfig } from '../types'
import { bytes, fmt } from '../util'
import { FileGlyph, FolderIcon } from './FileGlyph'
import { Icon, Modal, useToast, type IconName } from './ui'

/* ------------------------------------------------------------------ breadcrumb */
export function Breadcrumb({ root, rootLabel, path, onGo }: { root: string; rootLabel: string; path: string; onGo: (p: string) => void }) {
  const rel = path.startsWith(root) ? path.slice(root.length).split('/').filter(Boolean) : []
  const crumbs = [{ label: rootLabel, path: root }, ...rel.map((seg, i) => ({ label: decodeURIComponent(seg), path: root + '/' + rel.slice(0, i + 1).join('/') }))]
  return (
    <nav aria-label="Folder path" className="crumbs">
      <ol>
        {crumbs.map((c, i) => (
          <li key={c.path}>
            {i > 0 && <span aria-hidden="true" className="sep">›</span>}
            {i === crumbs.length - 1
              ? <b aria-current="page">{i === 0 && <FolderIcon size={18} />}{c.label}</b>
              : <button className="crumb" onClick={() => onGo(c.path)}>{i === 0 && <FolderIcon size={18} />}{c.label}</button>}
          </li>
        ))}
      </ol>
    </nav>
  )
}

/* ------------------------------------------------------------------ small dialogs */
export function NameDialog({ title, label, initial = '', cta, onSubmit, onClose }: { title: string; label: string; initial?: string; cta: string; onSubmit: (name: string) => Promise<void>; onClose: () => void }) {
  const [v, setV] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const bad = /[~"#%&*:<>?/\\{|}]/.test(v) || /^\.|\.$/.test(v.trim())
  return (
    <Modal title={title} onClose={onClose}>
      <h2 style={{ marginBottom: 12 }}>{title}</h2>
      <form onSubmit={async (e) => { e.preventDefault(); if (!v.trim() || bad) return; setBusy(true); setErr(''); try { await onSubmit(v.trim()); onClose() } catch (x) { setErr((x as Error).message); setBusy(false) } }} style={{ display: 'grid', gap: 12 }}>
        <label className="field">{label}<input className="input" value={v} autoFocus onFocus={(e) => e.target.select()} onChange={(e) => setV(e.target.value)} aria-invalid={bad} /></label>
        {bad && <span role="alert" style={{ color: 'var(--bad)' }}>Names can’t contain  ~ " # % &amp; * : &lt; &gt; ? / \ {'{ | }'}  or start/end with a dot.</span>}
        {err && <div className="banner bad" role="alert">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !v.trim() || bad}>{busy ? 'Working…' : cta}</button></div>
      </form>
    </Modal>
  )
}

export function FolderPicker({ backend, src, root, start, title, onPick, onClose }: { backend: Backend; src: SourceConfig; root: string; start: string; title: string; onPick: (path: string) => void; onClose: () => void }) {
  const [path, setPath] = useState(start)
  const [list, setList] = useState<{ name: string; url: string }[] | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { let live = true; setList(null); setErr(''); backend.listFolders(src, path).then((l) => live && setList(l)).catch((e) => { if (live) { setErr((e as Error).message); setList([]) } }); return () => { live = false } }, [path]) // eslint-disable-line react-hooks/exhaustive-deps
  const up = path !== root ? path.slice(0, path.lastIndexOf('/')) : null
  return (
    <Modal title={title} onClose={onClose}>
      <h2 style={{ marginBottom: 8 }}>{title}</h2>
      <Breadcrumb root={root} rootLabel={src.label} path={path} onGo={setPath} />
      <div style={{ minHeight: 180, maxHeight: 320, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 12, margin: '10px 0' }} role="listbox" aria-label="Folders">
        {up && <button className="pick-row" onClick={() => setPath(up)}>↰ Up one level</button>}
        {list === null && <p className="muted" style={{ padding: 12 }}>Loading…</p>}
        {list?.map((f) => <button key={f.url} className="pick-row" onClick={() => setPath(f.url)}><FolderIcon size={20} />{f.name}</button>)}
        {list && !list.length && !err && <p className="muted" style={{ padding: 12 }}>No sub-folders here.</p>}
        {err && <p role="alert" style={{ padding: 12, color: 'var(--bad)' }}>{err}</p>}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => onPick(path)}>{title.split(' ')[0]} here</button></div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ uploads */
export interface UploadItem { file: File; rel: string }   // rel = sub-folder path inside the destination ('' for top level)
type St = 'wait' | 'busy' | 'done' | 'fail' | 'skip'
export const MAX_UPLOAD = 100 * 1024 * 1024

/** Reads dropped files AND folders (recursively) via the directory-entry API. */
export async function collectDropped(dt: DataTransfer): Promise<UploadItem[]> {
  const out: UploadItem[] = []
  const walk = async (entry: any, rel: string): Promise<void> => {
    if (entry.isFile) { const file: File = await new Promise((res, rej) => entry.file(res, rej)); out.push({ file, rel }) }
    else if (entry.isDirectory) {
      const reader = entry.createReader()
      for (;;) {
        const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej))
        if (!batch.length) break
        for (const e of batch) await walk(e, rel ? `${rel}/${entry.name}` : entry.name)
      }
    }
  }
  const items = Array.from(dt.items ?? [])
  if (items.length && (items[0] as any).webkitGetAsEntry) {
    const entries = items.map((i) => (i as any).webkitGetAsEntry()).filter(Boolean)
    for (const e of entries) await walk(e, '')
    return out
  }
  return Array.from(dt.files).map((file) => ({ file, rel: '' }))
}
/** picker with webkitdirectory gives file.webkitRelativePath = "Folder/sub/file.txt" */
export const fromPicker = (files: FileList): UploadItem[] => Array.from(files).map((file) => { const rp = (file as any).webkitRelativePath as string; return { file, rel: rp ? rp.split('/').slice(0, -1).join('/') : '' } })

export function UploadDialog({ backend, src, dest, items, onClose, onDone }: { backend: Backend; src: SourceConfig; dest: string; items: UploadItem[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [st, setSt] = useState<St[]>(() => items.map((i) => (i.file.size > MAX_UPLOAD ? 'skip' : 'wait')))
  const [msg, setMsg] = useState<string[]>(() => items.map((i) => (i.file.size > MAX_UPLOAD ? `Over ${bytes(MAX_UPLOAD)}: upload large files in SharePoint` : '')))
  const [running, setRunning] = useState(true)
  const cancel = useRef(false)
  const set = (i: number, s: St, m = '') => { setSt((a) => { const n = a.slice(); n[i] = s; return n }); if (m) setMsg((a) => { const n = a.slice(); n[i] = m; return n }) }

  const run = useCallback(async () => {
    const base = dest.replace(/\/$/, '')
    const made = new Set<string>()
    const ensure = async (rel: string) => {   // create each missing folder level once
      let cur = base
      for (const seg of rel.split('/').filter(Boolean)) {
        cur += '/' + seg
        if (made.has(cur)) continue
        made.add(cur)
        try { await backend.createFolder(src, cur.slice(0, cur.lastIndexOf('/')), seg) } catch { /* already exists */ }
      }
    }
    const queue = items.map((u, i) => ({ u, i })).filter(({ i }) => st[i] === 'wait')
    let next = 0
    const worker = async () => {
      while (!cancel.current) {
        const j = next++; if (j >= queue.length) return
        const { u, i } = queue[j]
        set(i, 'busy')
        try { await ensure(u.rel); await backend.uploadFile(src, u.rel ? `${base}/${u.rel}` : base, u.file); set(i, 'done') }
        catch (e) { set(i, 'fail', (e as Error).message) }
      }
    }
    await Promise.all([worker(), worker()])
    setRunning(false); onDone()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void run() }, [run])

  const done = st.filter((s) => s === 'done').length, failed = st.filter((s) => s === 'fail' || s === 'skip').length
  useEffect(() => { if (!running && done) toast(failed ? 'warn' : 'good', `${fmt(done)} file${done === 1 ? '' : 's'} uploaded${failed ? `, ${failed} not uploaded` : ''}`) }, [running]) // eslint-disable-line react-hooks/exhaustive-deps
  const pct = Math.round(((done + failed) / Math.max(1, items.length)) * 100)
  return (
    <Modal title="Uploading" onClose={() => { cancel.current = true; onClose() }} className="wide">
      <h2 style={{ marginBottom: 6 }}>{running ? 'Uploading…' : 'Upload finished'}</h2>
      <div className="muted small">to {dest.split('/').slice(-2).join(' / ')} · {fmt(done)} of {fmt(items.length)} done</div>
      <div className="bar-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} style={{ margin: '10px 0', borderRadius: 9, height: 8 }}><i style={{ width: `${pct}%` }} /></div>
      <ul className="upl" aria-live="polite">
        {items.slice(0, 300).map((u, i) => (
          <li key={i}><FileGlyph name={u.file.name} size={22} /><span className="nm" title={u.rel ? `${u.rel}/${u.file.name}` : u.file.name}>{u.rel ? `${u.rel}/` : ''}{u.file.name}</span><span className="muted small">{bytes(u.file.size)}</span>
            <span className={`pill ${st[i] === 'done' ? 'good' : st[i] === 'fail' || st[i] === 'skip' ? 'bad' : ''}`} title={msg[i]}>{st[i] === 'done' ? 'Done' : st[i] === 'busy' ? 'Uploading' : st[i] === 'wait' ? 'Waiting' : st[i] === 'skip' ? 'Skipped' : 'Failed'}</span>
            {msg[i] && <span className="small" style={{ color: 'var(--bad)', gridColumn: '2 / -1' }}>{msg[i]}</span>}</li>
        ))}
        {items.length > 300 && <li className="muted">…and {fmt(items.length - 300)} more</li>}
      </ul>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
        {running ? <button className="btn" onClick={() => { cancel.current = true }}>Stop after current files</button> : <button className="btn primary" onClick={onClose}>Close</button>}
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ fixed-position action menu (rows are paint-contained, so it cannot live inside them) */
export interface MenuItem { label: string; icon?: IconName | ReactNode; danger?: boolean; hidden?: boolean; sep?: boolean; run: () => void }
export function ActionMenu({ at, items, onClose, title }: { at: DOMRect; items: MenuItem[]; onClose: () => void; title: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const shown = items.filter((i) => !i.hidden)
  const [pos, setPos] = useState({ left: at.left, top: at.bottom })
  useEffect(() => {
    const el = ref.current; if (!el) return
    const opener = document.activeElement as HTMLElement | null
    const r = el.getBoundingClientRect()
    setPos({ left: Math.max(8, Math.min(at.left - (at.width ? r.width - at.width : 0), window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(at.bottom + 4, window.innerHeight - r.height - 8)) })
    ;(el.querySelector('button') as HTMLElement)?.focus()
    const down = (e: MouseEvent) => { if (!el.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      const b = Array.from(el.querySelectorAll('button')); const i = b.indexOf(document.activeElement as HTMLButtonElement)
      if (e.key === 'ArrowDown') { e.preventDefault(); b[(i + 1) % b.length]?.focus() }
      if (e.key === 'ArrowUp') { e.preventDefault(); b[(i - 1 + b.length) % b.length]?.focus() }
    }
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); opener?.isConnected && opener.focus?.() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={ref} className="menu actionmenu" role="menu" aria-label={`Actions for ${title}`} style={{ position: 'fixed', left: pos.left, top: pos.top, right: 'auto' }}>
      {shown.map((i, n) => (
        <div key={n}>
          {i.sep && <hr />}
          <button role="menuitem" style={i.danger ? { color: 'var(--bad)' } : undefined} onClick={() => { onClose(); i.run() }}>{typeof i.icon === 'string' ? <Icon n={i.icon as IconName} size={16} /> : i.icon ?? <span style={{ width: 16 }} />}{i.label}</button>
        </div>
      ))}
    </div>
  )
}
