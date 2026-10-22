import { useMemo, useRef, useState } from 'react'
import type { Engine } from '../engine'
import { isEditable } from '../editable'
import type { Principal, SpField } from '../types'
import { download, fmt } from '../util'
import { Icon, Modal, useToast } from './ui'

/** RFC-4180-style CSV/TSV parser (quotes, doubled quotes, newlines inside quotes, ; or tab delimiters). */
export function parseCsv(text: string): string[][] {
  text = text.replace(/^﻿/, '')
  const first = text.split(/\r?\n/, 1)[0] ?? ''
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0]
  const rows: string[][] = []; let row: string[] = [], cur = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++ } else q = false } else cur += c }
    else if (c === '"') q = true
    else if (c === delim) { row.push(cur); cur = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x.trim() !== '')) rows.push(row); row = [] }
    else cur += c
  }
  row.push(cur); if (row.some((x) => x.trim() !== '')) rows.push(row)
  return rows
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const parseDate = (v: string): string | null => {
  v = v.trim(); if (!v) return ''
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10)
  const m = v.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/)
  if (m) { const y = Number(m[3].length === 2 ? '20' + m[3] : m[3]); const a = Number(m[1]), b = Number(m[2]); const [mo, d] = a > 12 ? [b, a] : [a, b]; return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` }
  const t = Date.parse(v); if (isNaN(t)) return null
  const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const yes = /^(y|yes|true|1|x|✓)$/i, no = /^(n|no|false|0|)$/i

export function ImportDialog({ engine, onClose, onDone }: { engine: Engine; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const fields = useMemo(() => engine.fields.filter((f) => engine.select.includes(f.internal) && isEditable(f)), [engine])
  const [rows, setRows] = useState<string[][] | null>(null)
  const [name, setName] = useState('')
  const [map, setMap] = useState<string[]>([])           // csv column index -> field internal ('' = skip)
  const [state, setState] = useState<{ done: number; ok: number; bad: { line: number; msg: string; row: string[] }[]; running: boolean } | null>(null)
  const stop = useRef(false)
  const cache = useRef(new Map<string, Principal | null>())
  const MAX = 5000

  const load = (text: string, fname: string) => {
    const r = parseCsv(text); if (r.length < 2) { toast('bad', 'That file has no data rows.'); return }
    setRows(r); setName(fname)
    const heads = r[0]; setMap(heads.map((h) => fields.find((f) => norm(f.title) === norm(h) || norm(f.internal) === norm(h))?.internal ?? ''))
  }
  const header = rows?.[0] ?? [], data = rows?.slice(1, MAX + 1) ?? []

  /** convert one CSV cell to the value the backend expects; returns [value, problem] */
  const convert = async (f: SpField, raw: string): Promise<[unknown, string | null]> => {
    const v = raw.trim()
    if (v === '') return [f.kind === 'multichoice' || f.kind === 'user' ? [] : '', f.required ? `${f.title} is required` : null]
    switch (f.kind) {
      case 'number': case 'currency': { const n = Number(v.replace(/[$,\s]/g, '')); return isNaN(n) ? ['', `${f.title}: “${v}” is not a number`] : [n, null] }
      case 'boolean': return yes.test(v) ? [true, null] : no.test(v) ? [false, null] : ['', `${f.title}: “${v}” is not Yes/No`]
      case 'date': { const d = parseDate(v); return d === null ? ['', `${f.title}: “${v}” is not a date`] : [d, null] }
      case 'choice': { const c = (f.choices ?? []).find((x) => x.toLowerCase() === v.toLowerCase()); return c ? [c, null] : (f.choices?.length ? ['', `${f.title}: “${v}” is not one of the choices`] : [v, null]) }
      case 'multichoice': { const parts = v.split(/[;|]/).map((x) => x.trim()).filter(Boolean); const ch = parts.map((p) => (f.choices ?? []).find((x) => x.toLowerCase() === p.toLowerCase()) ?? null); return ch.includes(null) ? [[], `${f.title}: unknown choice in “${v}”`] : [ch, null] }
      case 'url': return [{ url: v, desc: '' }, /^https?:\/\//i.test(v) ? null : `${f.title}: “${v}” should start with https://`]
      case 'user': {
        const names = v.split(/[;|]/).map((x) => x.trim()).filter(Boolean), out: Principal[] = []
        for (const n of f.multi ? names : names.slice(0, 1)) {
          if (!cache.current.has(n)) { const r = await engine.backend.searchPrincipals(engine.src, n).catch(() => []); cache.current.set(n, r.find((p) => p.kind === 'user' && (p.email?.toLowerCase() === n.toLowerCase() || p.title.toLowerCase() === n.toLowerCase())) ?? r.find((p) => p.kind === 'user') ?? null) }
          const p = cache.current.get(n); if (!p) return [[], `${f.title}: person “${n}” not found`]; out.push(p)
        }
        return [out, null]
      }
      default: return [v, null]
    }
  }

  const run = async () => {
    stop.current = false
    const st = { done: 0, ok: 0, bad: [] as { line: number; msg: string; row: string[] }[], running: true }
    setState({ ...st })
    let next = 0
    const worker = async () => {
      while (!stop.current) {
        const i = next++; if (i >= data.length) return
        const r = data[i]; const values: Record<string, unknown> = {}; const problems: string[] = []
        for (let c = 0; c < map.length; c++) {
          const f = fields.find((x) => x.internal === map[c]); if (!f) continue
          const [val, prob] = await convert(f, r[c] ?? ''); if (prob) problems.push(prob); else if (!(val === '' || (Array.isArray(val) && !val.length))) values[f.internal] = val
        }
        for (const f of fields) if (f.required && !(f.internal in values) && !problems.some((p) => p.startsWith(f.title))) problems.push(`${f.title} is required`)
        if (problems.length) st.bad.push({ line: i + 2, msg: problems.join('; '), row: r })
        else { try { await engine.backend.createItem(engine.src, engine.fields, values); st.ok++ } catch (e) { st.bad.push({ line: i + 2, msg: (e as Error).message, row: r }) } }
        st.done++; setState({ ...st, bad: [...st.bad] })
      }
    }
    await Promise.all([worker(), worker(), worker()])
    st.running = false; setState({ ...st, bad: [...st.bad] })
    toast(st.bad.length ? 'warn' : 'good', `Imported ${fmt(st.ok)} item${st.ok === 1 ? '' : 's'}${st.bad.length ? `, ${st.bad.length} skipped` : ''}`)
    onDone()
  }
  const errorCsv = () => {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`
    download(new Blob(['﻿' + [[...header, 'Import error'].map(esc).join(','), ...(state?.bad ?? []).map((b) => [...b.row, b.msg].map(esc).join(','))].join('\r\n')], { type: 'text/csv' }), 'import-errors.csv')
  }
  const template = () => download(new Blob(['﻿' + fields.map((f) => `"${f.title}"`).join(',') + '\r\n'], { type: 'text/csv' }), `${engine.src.label}-import-template.csv`)
  const mapped = map.filter(Boolean).length
  const missingReq = fields.filter((f) => f.required && !map.includes(f.internal))

  return (
    <Modal title="Import from CSV" onClose={() => { stop.current = true; onClose() }} className="wide">
      <h2 style={{ marginBottom: 4 }}><Icon n="download" /> Import items from CSV</h2>
      <p className="muted small" style={{ marginTop: 0 }}>Add many items at once. Works with CSV exported from Excel (comma, semicolon or tab separated). First row = column headers. Up to {fmt(MAX)} rows per import.</p>

      {!rows && (
        <div className="ip-drop" onDragOver={(e) => e.preventDefault()} onDrop={async (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) load(await f.text(), f.name) }}>
          <label className="btn primary"><Icon n="plus" size={15} />Choose CSV file<input type="file" accept=".csv,.tsv,.txt,text/csv" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) load(await f.text(), f.name); e.target.value = '' }} /></label>
          <span className="muted small">or drop it here</span><span className="grow" /><button className="btn sm" onClick={template}>Download a template</button>
        </div>
      )}

      {rows && !state && <>
        <div className="muted small" style={{ margin: '4px 0 8px' }}><b>{name}</b> · {fmt(rows.length - 1)} rows{rows.length - 1 > MAX ? ` (only the first ${fmt(MAX)} will be imported)` : ''}</div>
        <div style={{ maxHeight: '38vh', overflow: 'auto', border: '1px solid var(--line)', borderRadius: 12 }}>
          <table className="data"><thead><tr><th>CSV column</th><th>Example</th><th>Import into</th></tr></thead>
            <tbody>{header.map((h, c) => (
              <tr key={c}><td><b>{h || `(column ${c + 1})`}</b></td><td className="muted">{(rows[1]?.[c] ?? '').slice(0, 40)}</td>
                <td><select className="input" value={map[c] ?? ''} aria-label={`Map ${h}`} onChange={(e) => setMap((m) => { const n = m.slice(); n[c] = e.target.value; return n })}><option value="">— skip —</option>{fields.map((f) => <option key={f.internal} value={f.internal} disabled={map.includes(f.internal) && map[c] !== f.internal}>{f.title}{f.required ? ' *' : ''}</option>)}</select></td></tr>
            ))}</tbody></table>
        </div>
        {missingReq.length > 0 && <div className="banner" role="alert" style={{ marginTop: 10 }}><Icon n="info" /><div>Required column{missingReq.length > 1 ? 's' : ''} not mapped: <b>{missingReq.map((f) => f.title).join(', ')}</b>. Rows will be skipped unless you map {missingReq.length > 1 ? 'them' : 'it'}.</div></div>}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="btn" onClick={() => setRows(null)}>Choose another file</button>
          <button className="btn primary" disabled={!mapped} onClick={() => void run()}>Import {fmt(data.length)} rows</button>
        </div>
      </>}

      {state && <div role="status" aria-live="polite">
        <div style={{ fontWeight: 700, margin: '8px 0 4px' }}>{state.running ? 'Importing…' : 'Import finished'} — {fmt(state.done)} of {fmt(data.length)} · {fmt(state.ok)} created{state.bad.length ? ` · ${fmt(state.bad.length)} skipped` : ''}</div>
        <div className="bar-progress" style={{ borderRadius: 9, height: 8 }}><i style={{ width: `${(state.done / Math.max(1, data.length)) * 100}%` }} /></div>
        {state.bad.length > 0 && <ul className="upl" style={{ marginTop: 10, maxHeight: '26vh' }}>{state.bad.slice(0, 50).map((b) => <li key={b.line} style={{ gridTemplateColumns: '60px 1fr' }}><span className="pill bad">Row {b.line}</span><span className="small">{b.msg}</span></li>)}</ul>}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          {state.bad.length > 0 && !state.running && <button className="btn" onClick={errorCsv}>Download skipped rows</button>}
          {state.running ? <button className="btn" onClick={() => { stop.current = true }}>Stop</button> : <button className="btn primary" onClick={onClose}>Done</button>}
        </div>
      </div>}
    </Modal>
  )
}
