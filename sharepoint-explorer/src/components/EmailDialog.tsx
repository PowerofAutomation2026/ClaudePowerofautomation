import { useRef, useState } from 'react'
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
const mimeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`)
const b64 = async (f: Blob) => { const u = new Uint8Array(await f.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s) }

/** An unsent .eml draft: Outlook / Mail open it as a new message with the body and every attachment already in place. */
export async function buildDraft(to: string, subject: string, html: string, files: File[]): Promise<Blob> {
  const B = `spx_${Math.random().toString(36).slice(2)}`
  const parts = [
    'X-Unsent: 1', `To: ${to}`, `Subject: ${mimeWord(subject)}`, 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${B}"`, '',
    `--${B}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(btoa(String.fromCharCode(...new TextEncoder().encode(html)))),
  ]
  for (const f of files) {
    const fn = mimeWord(f.name).replace(/"/g, '')
    parts.push(`--${B}`, `Content-Type: ${f.type || 'application/octet-stream'}; name="${fn}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${fn}"`, '', wrap(await b64(f)))
  }
  parts.push(`--${B}--`, '')
  return new Blob([parts.join('\r\n')], { type: 'message/rfc822' })
}

/** Email files and folders from a library: links to the selected items, plus files from your PC attached. */
export function EmailDialog({ engine, rows, mine, onClose }: { engine: Engine; rows: Row[]; mine: string; onClose: () => void }) {
  const toast = useToast()
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState(rows.length === 1 ? name(rows[0]) : `${rows.length} items from ${engine.src.label}`)
  const [msg, setMsg] = useState('')
  const [shareLinks, setShareLinks] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState('')
  const pick = useRef<HTMLInputElement>(null)
  const size = files.reduce((a, f) => a + f.size, 0)
  const addrs = to.split(/[;,\s]+/).filter(Boolean)
  const badAddr = addrs.find((a) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a))

  const links = async () => Promise.all(rows.map(async (r) => {
    let url = itemUrl(engine, r)
    if (shareLinks) { try { url = await engine.backend.createShareLink(engine.src, r.__id, false) } catch { /* fall back to the plain link */ } }
    return { r, url, folder: r.FSObjType === 1 }
  }))
  const body = async () => {
    const l = await links()
    return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px">${msg ? `<p>${esc(msg).replace(/\n/g, '<br>')}</p>` : ''}<p>${l.length === 1 ? 'Link' : 'Links'} from <b>${esc(engine.src.label)}</b>:</p><ul>${l.map((x) => `<li>${x.folder ? '📁' : '📄'} <a href="${esc(x.url)}">${esc(name(x.r))}</a></li>`).join('')}</ul>${files.length ? `<p>Attached: ${files.map((f) => esc(f.name)).join(', ')}</p>` : ''}<p style="color:#666;font-size:12px">Sent from PNC SharePoint Team Explorer. People need access to the items in SharePoint to open the links.</p></div>`
  }
  const guard = () => { if (!addrs.length) { toast('warn', 'Enter at least one recipient.'); return false } if (badAddr) { toast('warn', `“${badAddr}” is not a valid email address.`); return false } return true }

  const draft = async () => {
    if (!guard() && addrs.length) return
    setBusy('draft')
    try {
      const blob = await buildDraft(addrs.join('; '), subject, await body(), files)
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${subject.replace(/[^\w .-]+/g, '_').slice(0, 60) || 'message'}.eml`; document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(a.href), 4000)
      toast('good', 'Draft downloaded — open it to review and send from Outlook (attachments included).'); onClose()
    } catch (e) { toast('bad', (e as Error).message) } finally { setBusy('') }
  }
  const sendNow = async () => {
    if (!guard()) return
    setBusy('send')
    try { await engine.backend.sendMail(engine.src, addrs, subject, await body()); toast('good', `Email sent to ${addrs.length} recipient${addrs.length > 1 ? 's' : ''}.`); onClose() }
    catch (e) { toast('bad', `SharePoint could not send the email: ${(e as Error).message} — use “Open as draft” instead.`) } finally { setBusy('') }
  }
  const mailto = async () => {
    const l = await links()
    const text = `${msg ? msg + '\n\n' : ''}${l.map((x) => `${name(x.r)}: ${x.url}`).join('\n')}`
    window.location.href = `mailto:${encodeURIComponent(addrs.join(','))}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text.slice(0, 1800))}`
  }
  const onFiles = (list: FileList | null) => {
    const add = Array.from(list ?? []); if (pick.current) pick.current.value = ''
    const next = [...files, ...add]
    if (next.reduce((a, f) => a + f.size, 0) > MAX_ATTACH) return toast('warn', `Attachments are limited to ${bytes(MAX_ATTACH)} in total — share large files as links instead.`)
    setFiles(next)
  }

  return (
    <Modal title="Email files & folders" onClose={onClose}>
      <form style={{ display: 'grid', gap: 12 }} onSubmit={(e) => { e.preventDefault(); void draft() }}>
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
        <div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input ref={pick} type="file" multiple hidden onChange={(e) => onFiles(e.target.files)} aria-label="Attach files from this computer" />
            <button type="button" className="btn sm" onClick={() => pick.current?.click()}><Icon n="plus" size={14} />Attach files from my computer</button>
            <span className="muted small">{files.length ? `${files.length} file${files.length > 1 ? 's' : ''} · ${bytes(size)} of ${bytes(MAX_ATTACH)}` : 'Optional · added to the draft (not to SharePoint)'}</span>
          </div>
          {files.length > 0 && <ul className="feed" style={{ margin: '6px 0 0', padding: 0, listStyle: 'none' }}>{files.map((f, i) => <li key={i}><FileGlyph name={f.name} size={16} /><span style={{ flex: 1 }}>{f.name}</span><span className="muted small">{bytes(f.size)}</span><button type="button" className="btn sm ghost" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}><Icon n="trash" size={13} /></button></li>)}</ul>}
        </div>
        <p className="muted small" style={{ margin: 0 }}>Folders are sent as links. “Open as draft” saves a ready-to-send message (.eml) with your attachments for Outlook or Mail; “Send from SharePoint” sends links only, from {mine || 'you'} via SharePoint.</p>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" onClick={() => void mailto()} disabled={!!busy}>Links in my mail app</button>
          <button type="button" className="btn" onClick={() => void sendNow()} disabled={!!busy || files.length > 0} title={files.length ? 'Attachments need “Open as draft”' : undefined}>{busy === 'send' ? 'Sending…' : 'Send from SharePoint'}</button>
          <button type="submit" className="btn primary" disabled={!!busy}><Icon n="download" size={14} />{busy === 'draft' ? 'Preparing…' : 'Open as draft'}</button>
        </div>
      </form>
    </Modal>
  )
}
