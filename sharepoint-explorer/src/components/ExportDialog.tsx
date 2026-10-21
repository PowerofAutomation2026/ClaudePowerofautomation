import { useRef, useState } from 'react'
import type { Engine } from '../engine'
import { PDF_MAX_ROWS, runExport, type ExportFormat, type ExportScope } from '../export'
import { describeClause } from '../query'
import type { SpField } from '../types'
import { fmt } from '../util'
import { Icon, Modal, useToast } from './ui'

export function ExportDialog({ engine, cols, selected, title, initial, onClose }: { engine: Engine; cols: SpField[]; selected: Set<number>; title: string; initial: ExportFormat; onClose: () => void }) {
  const toast = useToast()
  const [format, setFormat] = useState<ExportFormat>(initial)
  const [scope, setScope] = useState<ExportScope>(selected.size ? 'selected' : engine.mode === 'server' ? 'view' : 'all')
  const [done, setDone] = useState<number | null>(null)
  const [error, setError] = useState('')
  const ctl = useRef<AbortController | null>(null)
  const running = done !== null && !error
  const server = engine.mode === 'server'
  const matched = scope === 'selected' ? selected.size : scope === 'view' ? engine.rows.length : server ? engine.total : engine.rows.length

  const go = async () => {
    setError(''); setDone(0)
    const c = (ctl.current = new AbortController())
    try {
      const filterText = [engine.q.search && `search “${engine.q.search}”`, ...engine.q.clauses.map((x) => describeClause(x, engine.fields))].filter(Boolean).join(' · ')
      const r = await runExport({ format, scope, engine, columns: cols, selected, title, filterText, signal: c.signal, onProgress: setDone })
      toast(r.note ? 'warn' : 'good', `Exported ${fmt(r.rows)} rows as ${format.toUpperCase()}.${r.note ? ' ' + r.note : ''}`)
      onClose()
    } catch (e) {
      if ((e as Error).name === 'AbortError') { toast('info', 'Export cancelled'); onClose() } else { setError((e as Error).message); setDone(null) }
    }
  }

  return (
    <Modal title="Export" onClose={() => { ctl.current?.abort(); onClose() }}>
      <h2 style={{ marginBottom: 12 }}><Icon n="download" /> Export data</h2>
      <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }} disabled={running}>
        <legend className="muted small" style={{ fontWeight: 700 }}>Format</legend>
        <div className="row">{(['csv', 'json', 'pdf'] as const).map((f) => <button key={f} className="btn" aria-pressed={format === f} onClick={() => setFormat(f)}>{f.toUpperCase()}</button>)}</div>
      </fieldset>
      <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }} disabled={running}>
        <legend className="muted small" style={{ fontWeight: 700 }}>What to export</legend>
        <label style={{ display: 'flex', gap: 8, padding: 4 }}><input type="radio" name="scope" checked={scope === 'selected'} onChange={() => setScope('selected')} disabled={!selected.size} />Selected rows ({fmt(selected.size)})</label>
        <label style={{ display: 'flex', gap: 8, padding: 4 }}><input type="radio" name="scope" checked={scope === 'view'} onChange={() => setScope('view')} />{server ? 'Rows loaded in the grid' : 'Current view'} ({fmt(engine.rows.length)})</label>
        {server && <label style={{ display: 'flex', gap: 8, padding: 4 }}><input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} />Everything matching the filters — streamed from SharePoint (up to {fmt(engine.total)} rows)</label>}
      </fieldset>
      <p className="small muted">{fmt(cols.length)} columns · {fmt(matched)} rows.{format === 'pdf' && ` PDF is limited to ${fmt(PDF_MAX_ROWS)} rows and ${Math.min(10, cols.length)} columns.`}{server && scope === 'all' && format !== 'pdf' && matched > 200_000 && ' Large export: pick a file in the save dialog so it streams to disk instead of memory.'}</p>
      {error && <div className="banner bad" role="alert">{error}</div>}
      {running && <div role="status" aria-live="polite"><b>{fmt(done)}</b> rows written…<div className="bar-progress" style={{ borderRadius: 9, margin: '8px 0' }}><i className={scope === 'all' ? 'indet' : ''} style={{ width: scope === 'all' ? undefined : `${Math.min(100, (done! / Math.max(1, matched)) * 100)}%` }} /></div></div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={() => { ctl.current?.abort(); onClose() }}>{running ? 'Cancel export' : 'Close'}</button>
        <button className="btn primary" onClick={go} disabled={running || (scope === 'selected' && !selected.size)}>Export {format.toUpperCase()}</button>
      </div>
    </Modal>
  )
}
