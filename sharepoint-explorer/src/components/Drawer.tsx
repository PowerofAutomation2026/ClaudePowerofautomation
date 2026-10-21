import { useEffect, useState } from 'react'
import type { Engine } from '../engine'
import type { Attachment, Row, SpField, VersionInfo } from '../types'
import { bytes, cellText, fmtDate, relTime } from '../util'
import { CellView } from './Grid'
import { FileGlyph, extOf, isImage } from './FileGlyph'
import type { MenuItem } from './Library'
import { Icon, Modal, useToast } from './ui'

export function itemUrl(engine: Engine, row: Row): string {
  const site = new URL(engine.src.siteUrl)
  if (engine.src.isLibrary && row.FileRef) return site.origin + row.FileRef
  return `${engine.src.siteUrl.replace(/\/$/, '')}/_layouts/15/listform.aspx?PageType=4&ListId=${encodeURIComponent('{' + engine.src.listId + '}')}&ID=${row.__id}`
}
export const downloadUrl = (engine: Engine, row: Row) => `${new URL(engine.src.siteUrl).origin}/_layouts/15/download.aspx?SourceUrl=${encodeURIComponent(new URL(engine.src.siteUrl).origin + row.FileRef)}`

export function Drawer({ engine, row, index, actions, onClose, onNav }: { engine: Engine; row: Row; index: number; actions: MenuItem[]; onClose: () => void; onNav: (d: number) => void }) {
  const toast = useToast()
  const [full, setFull] = useState<Row>(row)
  const [tab, setTab] = useState<'details' | 'history'>('details')
  const [versions, setVersions] = useState<VersionInfo[] | null>(null)
  const [atts, setAtts] = useState<Attachment[]>([])
  const lib = engine.src.isLibrary
  useEffect(() => {
    setFull(row); setTab('details'); setVersions(null); setAtts([])
    let live = true
    engine.backend.getItem(engine.src, engine.fields, row.__id).then((r) => { if (live && r) setFull({ ...row, ...r }) }).catch(() => {})
    if (!lib) engine.backend.listAttachments(engine.src, row.__id).then((a) => live && setAtts(a)).catch(() => {})
    return () => { live = false }
  }, [row.__id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'history' && !versions) engine.backend.getVersions(engine.src, row.__id).then(setVersions).catch(() => setVersions([])) }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  const title = cellText(engine.fields.find((f) => f.internal === (lib ? 'FileLeafRef' : 'Title')) ?? ({ kind: 'text', internal: 'Title' } as SpField), full) || `Item ${row.__id}`
  const isFolder = full.FSObjType === 1
  const shown = engine.fields.filter((f) => full[f.internal] != null && full[f.internal] !== '' && f.kind !== 'other' && !(f.internal === 'FileDirRef'))
  const url = itemUrl(engine, full)
  const ext = extOf(String(full.FileLeafRef ?? ''))
  const origin = new URL(engine.src.siteUrl).origin
  const primary = actions.filter((a) => !a.hidden)

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
        {lib && !isFolder && isImage(ext) && engine.backend.mode === 'live' && <div className="dprev"><img src={`${origin}/_layouts/15/getpreview.ashx?path=${encodeURIComponent(origin + full.FileRef)}&resolution=3`} alt={`Preview of ${title}`} onError={(e) => ((e.currentTarget.parentElement as HTMLElement).style.display = 'none')} /></div>}
        <div className="row" style={{ marginBottom: 8, gap: 6 }}>
          <a className="btn primary" href={url} target="_blank" rel="noreferrer noopener"><Icon n="ext" size={16} />Open in SharePoint</a>
          {lib && !isFolder && <a className="btn" href={downloadUrl(engine, full)} target="_blank" rel="noreferrer noopener"><Icon n="download" size={16} />Download</a>}
          <button className="btn" onClick={() => navigator.clipboard?.writeText(url).then(() => toast('good', 'Link copied'))}><Icon n="copy" size={16} />Copy link</button>
        </div>
        {primary.length > 0 && <div className="row" style={{ marginBottom: 10, gap: 6 }}>{primary.map((a, i) => <button key={i} className="btn sm" style={a.danger ? { color: 'var(--bad)' } : undefined} onClick={() => { a.run() }}>{typeof a.icon === 'string' ? <Icon n={a.icon as never} size={14} /> : a.icon}{a.label}</button>)}</div>}

        <div role="tablist" className="tabs" style={{ marginBottom: 10, width: 'fit-content' }}>
          <button role="tab" className="tab" aria-selected={tab === 'details'} onClick={() => setTab('details')}>Details</button>
          <button role="tab" className="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>Version history</button>
        </div>

        {tab === 'details' && <>
          <dl style={{ margin: 0 }}>{shown.map((f) => <div className="kv" key={f.internal}><dt>{f.title}</dt><dd><CellView f={f.kind === 'note' ? { ...f, kind: 'text' } : f} row={full} tokens={[]} /></dd></div>)}</dl>
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
