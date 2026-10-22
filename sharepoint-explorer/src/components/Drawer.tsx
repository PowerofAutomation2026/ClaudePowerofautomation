import { useEffect, useState } from 'react'
import type { Engine } from '../engine'
import type { Access, Attachment, Row, SpField, VersionInfo } from '../types'
import { isEditable } from '../editable'
import { bytes, cellText, fmtDate, relTime } from '../util'
import { CellView } from './Grid'
import { FileGlyph, extOf, isImage } from './FileGlyph'
import type { MenuItem } from './Library'
import { Icon, Menu, Modal, hashColor, initials, useToast } from './ui'

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/')   // encode each segment: spaces, # and % in names broke the old links (404)
const OFFICE = /^(docx?|xlsx?|pptx?|vsdx?|one)$/i

/** A link that really opens the item/file/folder in SharePoint. */
export function itemUrl(engine: Engine, row: Row): string {
  const origin = new URL(engine.src.siteUrl).origin
  const web = engine.src.siteUrl.replace(/\/$/, '')
  if (engine.src.isLibrary && row.FileRef) {
    const ref = String(row.FileRef)
    if (row.FSObjType === 1 && engine.src.url) return `${origin}${encPath(engine.src.url)}/Forms/AllItems.aspx?id=${encodeURIComponent(ref)}`
    if (row.FSObjType === 1) return `${web}/_layouts/15/listform.aspx?PageType=4&ListId=${encodeURIComponent('{' + engine.src.listId + '}')}&ID=${row.__id}`
    return `${origin}${encPath(ref)}${OFFICE.test(ref.split('.').pop() ?? '') ? '?web=1' : ''}`   // ?web=1 = open Office files in the browser
  }
  if (engine.src.url) return `${origin}${encPath(engine.src.url)}/DispForm.aspx?ID=${row.__id}`
  return `${web}/_layouts/15/listform.aspx?PageType=4&ListId=${encodeURIComponent('{' + engine.src.listId + '}')}&ID=${row.__id}`
}
/** SharePoint's own "Share" dialog for this item (it cannot be embedded in an iframe, so it opens as a pop-up window). */
export const shareUrl = (engine: Engine, row: Row) => `${engine.src.siteUrl.replace(/\/$/, '')}/_layouts/15/sharedialog.aspx?listId=${encodeURIComponent('{' + engine.src.listId + '}')}&listItemId=${row.__id}&clientId=spx-share&ma=0&fam=1&chrome=1&mbl=0`
export function openShareDialog(engine: Engine, row: Row): boolean {
  const w = 640, h = 680, l = Math.max(0, (screen.width - w) / 2), t = Math.max(0, (screen.height - h) / 2)
  return !!window.open(shareUrl(engine, row), 'spx_share', `popup=yes,width=${w},height=${h},left=${l},top=${t}`)
}
export const downloadUrl = (engine: Engine, row: Row) => `${new URL(engine.src.siteUrl).origin}/_layouts/15/download.aspx?SourceUrl=${encodeURIComponent(new URL(engine.src.siteUrl).origin + encPath(String(row.FileRef)))}`

export function Drawer({ engine, row, index, actions, access, fav, onFav, onInline, onClose, onNav }: { engine: Engine; row: Row; index: number; actions: MenuItem[]; access: Access; fav: boolean; onFav: () => void; onInline: (row: Row, field: SpField, value: unknown) => Promise<void>; onClose: () => void; onNav: (d: number) => void }) {
  const toast = useToast()
  const [full, setFull] = useState<Row>(row)
  const [tab, setTab] = useState<'details' | 'history'>('details')
  const [versions, setVersions] = useState<VersionInfo[] | null>(null)
  const [atts, setAtts] = useState<Attachment[]>([])
  const lib = engine.src.isLibrary
  useEffect(() => { setTab('details'); setVersions(null); setAtts([]) }, [row.__id])
  useEffect(() => {
    setFull(row)
    let live = true
    engine.backend.getItem(engine.src, engine.fields, row.__id).then((r) => { if (live && r) setFull({ ...row, ...r }) }).catch(() => {})
    if (!lib) engine.backend.listAttachments(engine.src, row.__id).then((a) => live && setAtts(a)).catch(() => {})
    return () => { live = false }
  }, [row]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'history' && !versions) engine.backend.getVersions(engine.src, row.__id).then(setVersions).catch(() => setVersions([])) }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  const title = cellText(engine.fields.find((f) => f.internal === (lib ? 'FileLeafRef' : 'Title')) ?? ({ kind: 'text', internal: 'Title' } as SpField), full) || `Item ${row.__id}`
  const isFolder = full.FSObjType === 1
  const shown = engine.fields.filter((f) => full[f.internal] != null && full[f.internal] !== '' && f.kind !== 'other' && !(f.internal === 'FileDirRef'))
  const url = itemUrl(engine, full)
  const ext = extOf(String(full.FileLeafRef ?? ''))
  const origin = new URL(engine.src.siteUrl).origin
  const primary = actions.filter((a) => !a.hidden)
  const copyLink = async (edit: boolean) => {
    try { const u = await engine.backend.createShareLink(engine.src, full.__id, edit); await navigator.clipboard?.writeText(u); toast('good', `${edit ? 'Edit' : 'View'} link copied — anyone in your organization with the link can ${edit ? 'edit' : 'view'}`) }
    catch (e) { toast('bad', (e as Error).message) }
  }

  return (
    <Modal title={`Details: ${title}`} onClose={onClose} side>
      <div className="dhead">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="muted small">{engine.src.title} · #{row.__id} · {index + 1} of {engine.rows.length.toLocaleString()}</div>
          <h2 style={{ overflowWrap: 'anywhere', display: 'flex', gap: 10, alignItems: 'center' }}>{lib && <FileGlyph name={title} folder={isFolder} size={30} />}{title}</h2>
          {full.Modified && <div className="muted small">Modified {fmtDate(String(full.Modified), true)} ({relTime(String(full.Modified))}){full.Editor ? ` by ${full.Editor}` : ''}</div>}
        </div>
        <button className="btn icon" onClick={() => onNav(-1)} aria-label="Previous item" disabled={index <= 0}><Icon n="chevL" /></button>
        <button className="btn icon" onClick={() => onNav(1)} aria-label="Next item" disabled={index >= engine.rows.length - 1}><Icon n="chevR" /></button>
        <button className="btn icon" onClick={onClose} aria-label="Close details"><Icon n="x" /></button>
      </div>
      <div className="body">
        {!lib && <RecordHero engine={engine} row={full} />}
        {lib && !isFolder && isImage(ext) && engine.backend.mode === 'live' && <div className="dprev"><img src={`${origin}/_layouts/15/getpreview.ashx?path=${encodeURIComponent(origin + full.FileRef)}&resolution=3`} alt={`Preview of ${title}`} onError={(e) => ((e.currentTarget.parentElement as HTMLElement).style.display = 'none')} /></div>}
        <div className="row" style={{ marginBottom: 8, gap: 6 }}>
          <a className="btn primary" href={url} target="_blank" rel="noreferrer noopener"><Icon n="ext" size={16} />Open in SharePoint</a>
          <Menu label="Share" icon="share" align="left">
            {(close) => <div>
              <button onClick={() => { close(); copyLink(false) }}><Icon n="copy" size={16} />Copy link — people in my organization can view</button>
              <button onClick={() => { close(); copyLink(true) }}><Icon n="copy" size={16} />Copy link — people in my organization can edit</button>
              <hr />
              <button onClick={() => { close(); if (!openShareDialog(engine, full)) toast('warn', 'Pop-up blocked. Allow pop-ups for this site, or use “Open in SharePoint” and press Share there.') }}><Icon n="ext" size={16} />Open SharePoint’s Share dialog…</button>
            </div>}
          </Menu>
          {lib && !isFolder && <a className="btn" href={downloadUrl(engine, full)} target="_blank" rel="noreferrer noopener"><Icon n="download" size={16} />Download</a>}
          <button className="btn" aria-pressed={fav} onClick={onFav}><Icon n="star" size={16} />{fav ? 'Favorited' : 'Favorite'}</button>
          <button className="btn" onClick={() => navigator.clipboard?.writeText(url).then(() => toast('good', 'Link copied'))}><Icon n="copy" size={16} />Copy link</button>
        </div>
        {primary.length > 0 && <div className="row" style={{ marginBottom: 10, gap: 6 }}>{primary.map((a, i) => <button key={i} className="btn sm" style={a.danger ? { color: 'var(--bad)' } : undefined} onClick={() => { a.run() }}>{typeof a.icon === 'string' ? <Icon n={a.icon as never} size={14} /> : a.icon}{a.label}</button>)}</div>}

        <div role="tablist" className="tabs" style={{ marginBottom: 10, width: 'fit-content' }}>
          <button role="tab" className="tab" aria-selected={tab === 'details'} onClick={() => setTab('details')}>Details</button>
          <button role="tab" className="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>Version history</button>
        </div>

        {tab === 'details' && <>
          <dl style={{ margin: 0 }}>{shown.map((f) => <div className="kv" key={f.internal}><dt>{f.title}</dt><dd>{inlineEditable(f, access) ? <InlineEdit f={f} row={full} onSet={async (v) => { await onInline(full, f, v); setFull((c) => ({ ...c, [f.internal]: v === true ? true : v })) }} /> : <CellView f={f.kind === 'note' ? { ...f, kind: 'text' } : f} row={full} tokens={[]} />}</dd></div>)}</dl>
          {!lib && atts.length > 0 && <><h3 style={{ margin: '14px 0 6px' }}>Attachments</h3><ul className="upl">{atts.map((a) => <li key={a.name}><FileGlyph name={a.name} size={22} /><a className="nm" href={a.url} target="_blank" rel="noreferrer noopener">{a.name}</a><span /><span /></li>)}</ul></>}
        </>}
        {tab === 'history' && (
          versions === null ? <div className="skel" style={{ height: 100 }} aria-busy="true" /> :
          !versions.length ? <p className="muted">No earlier versions (version history may be turned off for this {lib ? 'library' : 'list'}).</p> :
          <ol className="vlist">{versions.map((v) => <li key={v.label}><span className="pill accent">v{v.label}</span>{v.current && <span className="pill good">current</span>}<div style={{ flex: 1 }}><b>{v.by || 'Unknown'}</b><div className="muted small">{fmtDate(v.modified, true)}{v.size != null ? ` · ${bytes(v.size)}` : ''}{v.comment ? ` · “${v.comment}”` : ''}</div></div></li>)}</ol>
        )}
      </div>
    </Modal>
  )
}

const inlineEditable = (f: SpField, a: Access) => a.canEdit && isEditable(f) && ((f.kind === 'choice' && (f.choices?.length ?? 0) > 0 && (f.choices?.length ?? 0) <= 7) || f.kind === 'boolean')

/** Click a value to change it right away (contributors/admins): no form needed for quick status changes. */
function InlineEdit({ f, row, onSet }: { f: SpField; row: Row; onSet: (v: string | boolean) => Promise<void> }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const run = async (v: string | boolean) => { setBusy(true); try { await onSet(v) } catch (e) { toast('bad', (e as Error).message) } finally { setBusy(false) } }
  const cur = row[f.internal]
  if (f.kind === 'boolean') { const on = cur === true || cur === 'true'; return <button type="button" role="switch" aria-checked={on} aria-label={f.title} disabled={busy} className="switch" onClick={() => void run(!on)}><span /><b>{on ? 'Yes' : 'No'}</b></button> }
  return <div role="radiogroup" aria-label={f.title} className="chipset">{(f.choices ?? []).map((c) => <button type="button" key={c} role="radio" aria-checked={cur === c} disabled={busy} className="chipbtn" style={{ ['--tc' as string]: hashColor(c) }} onClick={() => void run(cur === c ? '' : c)}><i aria-hidden="true" />{c}</button>)}</div>
}

/** The top of a list item's "record page": status pills, progress ring and people at a glance. */
function RecordHero({ engine, row }: { engine: Engine; row: Row }) {
  const fs = engine.fields.filter((f) => engine.select.includes(f.internal))
  const chips = fs.filter((f) => f.kind === 'choice' && row[f.internal]).slice(0, 4)
  const pct = fs.find((f) => /percent|progress|complete/i.test(f.internal + f.title) && !isNaN(Number(row[f.internal])) && row[f.internal] !== '' && row[f.internal] != null)
  const people = fs.filter((f) => f.kind === 'user' && row[f.internal]).slice(0, 2)
  const due = fs.find((f) => f.kind === 'date' && /due|end|deadline|date/i.test(f.internal) && row[f.internal])
  if (!chips.length && !pct && !people.length) return null
  const v = pct ? Math.max(0, Math.min(100, Number(row[pct.internal]))) : 0
  return (
    <div className="rhero">
      {pct && <svg width="64" height="64" viewBox="0 0 64 64" role="img" aria-label={`${pct.title}: ${v}%`}><circle cx="32" cy="32" r="26" fill="none" stroke="var(--bg2)" strokeWidth="8" /><circle cx="32" cy="32" r="26" fill="none" stroke="var(--c5)" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${(v / 100) * 163.4} 163.4`} transform="rotate(-90 32 32)" /><text x="32" y="37" textAnchor="middle" fontWeight="800" fontSize="15" fill="var(--text)">{v}%</text></svg>}
      <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 8 }}>
        <div className="row" style={{ gap: 6 }}>{chips.map((f) => <span key={f.internal} className="tag" title={f.title} style={{ ['--tc' as string]: hashColor(String(row[f.internal])) }}>{String(row[f.internal])}</span>)}</div>
        <div className="row" style={{ gap: 10 }}>{people.map((f) => <span key={f.internal} className="who" title={f.title}><span className="av" style={{ ['--tc' as string]: hashColor(String(row[f.internal])) }} aria-hidden="true">{initials(String(row[f.internal]))}</span>{String(row[f.internal]).split('; ')[0]}</span>)}{due && <span className="muted small">⏰ {fmtDate(String(row[due.internal]))}</span>}</div>
      </div>
    </div>
  )
}
