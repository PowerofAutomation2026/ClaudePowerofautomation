import { useEffect, useRef, useState } from 'react'
import { copyMessage, openMailApp, openOutlookWeb, parseAddrs, validAddr } from '../mail'
import type { Engine } from '../engine'
import type { Row } from '../types'
import { bytes } from '../util'
import { itemUrl } from './Drawer'
import { FileGlyph } from './FileGlyph'
import { Icon, Modal, useToast } from './ui'

const MAX_ATTACH = 20 * 1024 * 1024
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const name = (r: Row) => String(r.FileLeafRef ?? r.Title ?? `#${r.__id}`)
const wrap = (b64: string) => b64.replace(/.{76}/g, '$&\r\n')
const b64bytes = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000) as unknown as number[]); return btoa(s) }
const b64str = (s: string) => b64bytes(new TextEncoder().encode(s))
const mimeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64str(s)}?=`)
const b64 = async (f: Blob) => b64bytes(new Uint8Array(await f.arrayBuffer()))

/** An unsent .eml draft: Outlook / Mail open it as a new message with the body and every attachment already in place. */
export async function buildDraft(to: string, subject: string, html: string, files: File[]): Promise<Blob> {
  const B = `spx_${Math.random().toString(36).slice(2)}`
  const parts = [
    'X-Unsent: 1', `To: ${to}`, `Subject: ${mimeWord(subject)}`, 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${B}"`, '',
    `--${B}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(b64str(html)),
  ]
  for (const f of files) {
    const fn = mimeWord(f.name).replace(/"/g, '')
    parts.push(`--${B}`, `Content-Type: ${f.type || 'application/octet-stream'}; name="${fn}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${fn}"`, '', wrap(await b64(f)))
  }
  parts.push(`--${B}--`, '')
  return new Blob([parts.join('\r\n')], { type: 'message/rfc822' })
}

/** Email files and folders from a library: links to the selected items, plus files from your PC attached. */
export function EmailDialog({ engine, rows, onClose }: { engine: Engine; rows: Row[]; mine?: string; onClose: () => void }) {
  const toast = useToast()
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState(rows.length === 1 ? name(rows[0]) : `${rows.length} items from ${engine.src.label}`)
  const [msg, setMsg] = useState('')
  const [shareLinks, setShareLinks] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const pick = useRef<HTMLInputElement>(null)
  const plain = () => rows.map((r) => ({ r, url: itemUrl(engine, r), folder: r.FSObjType === 1 }))
  // links are resolved up front so every button handler is synchronous (browsers only allow pop-ups straight from a click)
  const [links, setLinks] = useState(plain)
  useEffect(() => {
    if (!shareLinks) { setLinks(plain()); return }
    let live = true, failed = 0
    setBusy(true)
    Promise.all(rows.map(async (r) => { try { return { r, url: await engine.backend.createShareLink(engine.src, r.__id, false), folder: r.FSObjType === 1 } } catch { failed++; return { r, url: itemUrl(engine, r), folder: r.FSObjType === 1 } } }))
      .then((l) => { if (!live) return; setLinks(l); if (failed) toast('warn', `${failed} sharing link${failed > 1 ? 's' : ''} could not be created — direct links used instead.`) })
      .finally(() => live && setBusy(false))
    return () => { live = false }
  }, [shareLinks]) // eslint-disable-line react-hooks/exhaustive-deps

  const size = files.reduce((a, f) => a + f.size, 0)
  const addrs = parseAddrs(to)
  const badAddr = addrs.find((a) => !validAddr(a))
  const text = `${msg ? msg + '\n\n' : ''}${links.map((x) => `${x.folder ? '[Folder] ' : ''}${name(x.r)}: ${x.url}`).join('\n')}`
  const html = () => `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px">${msg ? `<p>${esc(msg).replace(/\n/g, '<br>')}</p>` : ''}<p>${links.length === 1 ? 'Link' : 'Links'} from <b>${esc(engine.src.label)}</b>:</p><ul>${links.map((x) => `<li>${x.folder ? '📁' : '📄'} <a href="${esc(x.url)}">${esc(name(x.r))}</a></li>`).join('')}</ul>${files.length ? `<p>Attached: ${files.map((f) => esc(f.name)).join(', ')}</p>` : ''}<p style="color:#666;font-size:12px">People need access to the items in SharePoint to open the links.</p></div>`
  const m = () => ({ to: addrs, subject, text, html: html() })
  const guard = (needTo = true) => { if (needTo && !addrs.length) { toast('warn', 'Enter at least one recipient.'); return false } if (badAddr) { toast('warn', `“${badAddr}” is not a valid email address.`); return false } return true }

  const copy = async () => { try { await copyMessage(m()); toast('good', 'Message copied — paste it into a new email.') } catch { toast('bad', 'Your browser blocked copying. Select the text in the preview below and copy it by hand.') } }
  const owa = () => {
    if (!guard()) return
    const r = openOutlookWeb(m())
    if (r === 'blocked') { void copy(); toast('warn', 'Pop-up blocked — the message was copied instead. Allow pop-ups for this app to open Outlook directly.') }
    else if (r === 'truncated') { void copy(); toast('warn', 'Outlook limits pre-filled text, so the full message was also copied — paste it over the body.') }
  }
  const app = () => { if (!guard()) return; if (!openMailApp(m())) { void copy(); toast('warn', 'Could not open your mail app from here — the message was copied instead.') } }
  const draft = async () => {
    if (!guard()) return
    setBusy(true)
    try {
      const blob = await buildDraft(addrs.join(', '), subject, html(), files)
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${subject.replace(/[^\w .-]+/g, '_').slice(0, 60) || 'message'}.eml`; document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(a.href), 4000)
      toast('info', 'Draft file prepared. If nothing downloaded, downloads are blocked for this app — use “Copy message”. Classic Outlook opens it as an editable draft; other apps show it read-only.')
    } catch (e) { toast('bad', (e as Error).message) } finally { setBusy(false) }
  }
  const onFiles = (list: FileList | null) => {
    const add = Array.from(list ?? []); if (pick.current) pick.current.value = ''
    const next = [...files, ...add]
    if (next.reduce((a, f) => a + f.size, 0) > MAX_ATTACH) return toast('warn', `Attachments are limited to ${bytes(MAX_ATTACH)} in total — share large files as links instead.`)
    setFiles(next)
  }

  return (
    <Modal title="Email files & folders" onClose={onClose}>
      <form style={{ display: 'grid', gap: 12 }} onSubmit={(e) => e.preventDefault()}>
        <div>
          <div className="small muted" style={{ marginBottom: 4 }}>Included as links ({rows.length})</div>
          <ul className="feed" style={{ maxHeight: 130, overflow: 'auto', margin: 0, padding: 0, listStyle: 'none' }}>
            {rows.map((r) => <li key={r.__id}><FileGlyph name={name(r)} folder={r.FSObjType === 1} size={18} /><span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name(r)}</span>{r.FSObjType === 1 && <span className="pill">folder</span>}</li>)}
          </ul>
        </div>
        <label className="small">To (separate several with commas)<input className="input" type="text" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@company.com" autoComplete="off" /></label>
        <label className="small">Subject<input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} /></label>
        <label className="small">Message<textarea className="input" rows={4} value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={4000} /></label>
        <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={shareLinks} onChange={(e) => setShareLinks(e.target.checked)} />Create “people in my organization can view” sharing links (so recipients without access can open them)</label>
        <details>
          <summary className="small">Attach files from my computer (optional, for the .eml draft)</summary>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            <input ref={pick} type="file" multiple hidden onChange={(e) => onFiles(e.target.files)} aria-label="Attach files from this computer" />
            <button type="button" className="btn sm" onClick={() => pick.current?.click()}><Icon n="plus" size={14} />Choose files</button>
            <span className="muted small">{files.length ? `${files.length} file${files.length > 1 ? 's' : ''} · ${bytes(size)} of ${bytes(MAX_ATTACH)}` : 'Attachments are only included in the downloaded .eml draft'}</span>
          </div>
          {files.length > 0 && <ul className="feed" style={{ margin: '6px 0 0', padding: 0, listStyle: 'none' }}>{files.map((f, i) => <li key={i}><FileGlyph name={f.name} size={16} /><span style={{ flex: 1 }}>{f.name}</span><span className="muted small">{bytes(f.size)}</span><button type="button" className="btn sm ghost" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}><Icon n="trash" size={13} /></button></li>)}</ul>}
        </details>
        <label className="small">Preview (what will be pasted / opened)<textarea className="input" rows={5} readOnly value={text} aria-label="Message preview" /></label>
        <p className="muted small" style={{ margin: 0 }}>Opening Outlook on the web or your mail app prefills the message; folders are sent as links. Nothing is sent until you press Send in your mail client.</p>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <button type="button" className="btn" onClick={() => void copy()} disabled={busy}><Icon n="copy" size={14} />Copy message</button>
          <button type="button" className="btn" onClick={app} disabled={busy}>Default mail app</button>
          <button type="button" className="btn" onClick={() => void draft()} disabled={busy}>Download .eml{files.length ? ' with attachments' : ''}</button>
          <button type="button" className="btn primary" onClick={owa} disabled={busy}><Icon n="ext" size={14} />Open in Outlook (web)</button>
        </div>
      </form>
    </Modal>
  )
}
