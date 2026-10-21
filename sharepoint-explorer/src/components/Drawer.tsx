import { useEffect, useState } from 'react'
import type { Engine } from '../engine'
import type { Row, SpField } from '../types'
import { cellText, fmtDate } from '../util'
import { CellView } from './Grid'
import { Icon, Modal, useToast } from './ui'

export function itemUrl(engine: Engine, row: Row): string {
  const site = new URL(engine.src.siteUrl)
  if (engine.src.isLibrary && row.FileRef) return site.origin + row.FileRef
  return `${engine.src.siteUrl.replace(/\/$/, '')}/_layouts/15/listform.aspx?PageType=4&ListId=${encodeURIComponent('{' + engine.src.listId + '}')}&ID=${row.__id}`
}

export function Drawer({ engine, row, index, onClose, onNav }: { engine: Engine; row: Row; index: number; onClose: () => void; onNav: (d: number) => void }) {
  const toast = useToast()
  const [full, setFull] = useState<Row>(row)
  useEffect(() => {
    setFull(row)
    let live = true
    engine.backend.getItem(engine.src, engine.fields, row.__id).then((r) => { if (live && r) setFull({ ...row, ...r }) }).catch(() => {})
    return () => { live = false }
  }, [row.__id]) // eslint-disable-line react-hooks/exhaustive-deps
  const title = cellText(engine.fields.find((f) => f.internal === (engine.src.isLibrary ? 'FileLeafRef' : 'Title')) ?? ({ kind: 'text', internal: 'Title' } as SpField), full) || `Item ${row.__id}`
  const shown = engine.fields.filter((f) => full[f.internal] != null && full[f.internal] !== '' && f.kind !== 'other')
  const url = itemUrl(engine, full)
  return (
    <Modal title={`Details: ${title}`} onClose={onClose} side>
      <div className="dhead">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="muted small">{engine.src.title} · #{row.__id} · {index + 1} of {engine.rows.length.toLocaleString()}</div>
          <h2 style={{ overflowWrap: 'anywhere' }}>{title}</h2>
          {full.Modified && <div className="muted small">Modified {fmtDate(String(full.Modified), true)}{full.Editor ? ` by ${full.Editor}` : ''}</div>}
        </div>
        <button className="btn icon" onClick={() => onNav(-1)} aria-label="Previous item" disabled={index <= 0}><Icon n="chevL" /></button>
        <button className="btn icon" onClick={() => onNav(1)} aria-label="Next item" disabled={index >= engine.rows.length - 1}><Icon n="chevR" /></button>
        <button className="btn icon" onClick={onClose} aria-label="Close details"><Icon n="x" /></button>
      </div>
      <div className="body">
        <div className="row" style={{ marginBottom: 8 }}>
          <a className="btn primary" href={url} target="_blank" rel="noreferrer noopener"><Icon n="ext" size={16} />Open in SharePoint</a>
          <button className="btn" onClick={() => navigator.clipboard?.writeText(url).then(() => toast('good', 'Link copied'))}><Icon n="copy" size={16} />Copy link</button>
          <button className="btn" onClick={() => navigator.clipboard?.writeText(JSON.stringify(full, null, 2)).then(() => toast('good', 'JSON copied'))}>JSON</button>
        </div>
        <dl style={{ margin: 0 }}>
          {shown.map((f) => <div className="kv" key={f.internal}><dt>{f.title}</dt><dd><CellView f={f.kind === 'note' ? { ...f, kind: 'text' } : f} row={full} tokens={[]} /></dd></div>)}
        </dl>
      </div>
    </Modal>
  )
}
