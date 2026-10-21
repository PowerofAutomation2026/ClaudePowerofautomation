import { useEffect, useMemo, useRef, useState } from 'react'
import type { Engine } from '../engine'
import { isEditable } from '../editable'
import { emptyQuery } from '../query'
import type { Row, SourceConfig, SpField, Backend } from '../types'
import { fmt } from '../util'
import { Icon, Modal, useToast } from './ui'

/* ------------------------------------------------------------------ bulk edit */
export function BulkDialog({ engine, rows, onClose, onDone }: { engine: Engine; rows: Row[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const fields = engine.fields.filter((f) => engine.select.includes(f.internal) && isEditable(f) && ['choice', 'boolean', 'text', 'number', 'currency', 'date'].includes(f.kind))
  const [fi, setFi] = useState(fields[0]?.internal ?? '')
  const f = fields.find((x) => x.internal === fi)
  const [val, setVal] = useState('')
  const [done, setDone] = useState<number | null>(null)
  const [fail, setFail] = useState(0)
  useEffect(() => setVal(''), [fi])
  const run = async () => {
    if (!f) return
    setDone(0); setFail(0); let ok = 0, bad = 0, next = 0
    const v = f.kind === 'boolean' ? val === 'true' : val
    const worker = async () => { for (;;) { const r = rows[next++]; if (!r) return; try { await engine.backend.updateItem(engine.src, engine.fields, r.__id, { [f.internal]: v }); const fresh = await engine.backend.getItem(engine.src, engine.fields, r.__id); if (fresh) engine.patchRow(fresh); ok++ } catch { bad++ } setDone(ok + bad); setFail(bad) } }
    await Promise.all([worker(), worker(), worker()])
    toast(bad ? 'warn' : 'good', `${fmt(ok)} updated${bad ? `, ${bad} failed (no permission or locked)` : ''}`); onDone()
  }
  const running = done !== null && done < rows.length
  return (
    <Modal title="Edit selected items" onClose={onClose}>
      <h2 style={{ marginBottom: 6 }}>Edit {fmt(rows.length)} items</h2>
      <p className="muted small" style={{ marginTop: 0 }}>Set one column to the same value on every selected item.</p>
      <div className="row" style={{ alignItems: 'end' }}>
        <label className="field">Column<select className="input" value={fi} onChange={(e) => setFi(e.target.value)} disabled={running}>{fields.map((x) => <option key={x.internal} value={x.internal}>{x.title}</option>)}</select></label>
        <label className="field" style={{ flex: 1 }}>New value
          {f?.kind === 'choice' ? <select className="input" value={val} onChange={(e) => setVal(e.target.value)}><option value="">—</option>{(f.choices ?? []).map((c) => <option key={c}>{c}</option>)}</select>
            : f?.kind === 'boolean' ? <select className="input" value={val} onChange={(e) => setVal(e.target.value)}><option value="">—</option><option value="true">Yes</option><option value="false">No</option></select>
            : <input className="input" value={val} onChange={(e) => setVal(e.target.value)} type={f?.kind === 'date' ? 'date' : f?.kind === 'number' || f?.kind === 'currency' ? 'number' : 'text'} />}
        </label>
      </div>
      {done !== null && <div role="status" style={{ marginTop: 10 }}>{fmt(done)} of {fmt(rows.length)} done{fail ? `, ${fail} failed` : ''}<div className="bar-progress" style={{ borderRadius: 9, marginTop: 6 }}><i style={{ width: `${(done / rows.length) * 100}%` }} /></div></div>}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="btn" onClick={onClose}>{done !== null && !running ? 'Close' : 'Cancel'}</button>
        <button className="btn primary" disabled={!f || running || (done !== null && !running)} onClick={() => void run()}>Apply to {fmt(rows.length)}</button>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ search everywhere (all connected lists + Power Platform community) */
const fieldCache = new Map<string, SpField[]>()
interface Hit { src: SourceConfig; title: string; id: number }

const COMMUNITY = (q: string) => {
  const e = encodeURIComponent(q)
  return [
    { label: 'Power Platform Community', sub: 'Forums, ideas and how-tos', url: `https://www.bing.com/search?q=${encodeURIComponent(`site:community.powerplatform.com ${q}`)}`, icon: '🌐' },
    { label: 'Power Apps community (powerusers)', sub: 'Power Apps, Power Automate, Power BI Q&A', url: `https://www.bing.com/search?q=${encodeURIComponent(`site:powerusers.microsoft.com ${q}`)}`, icon: '💬' },
    { label: 'Microsoft Learn documentation', sub: 'Official docs and training', url: `https://learn.microsoft.com/en-us/search/?terms=${e}`, icon: '📘' },
    { label: 'Microsoft Q&A', sub: 'Answers from Microsoft and MVPs', url: `https://www.bing.com/search?q=${encodeURIComponent(`site:learn.microsoft.com/answers ${q}`)}`, icon: '❓' },
    { label: 'SharePoint on Microsoft Tech Community', sub: 'Announcements and best practices', url: `https://www.bing.com/search?q=${encodeURIComponent(`site:techcommunity.microsoft.com sharepoint ${q}`)}`, icon: '🧩' },
  ]
}
const TOPICS = ['SharePoint list view threshold 5000', 'Power Apps code apps SharePoint connector', 'SharePoint item level permissions', 'Power Automate SharePoint trigger', 'SharePoint indexed columns large list']

export function SearchEverywhere({ backend, sources, onOpen, onClose, initial = '' }: { backend: Backend; sources: SourceConfig[]; onOpen: (s: SourceConfig, q: string) => void; onClose: () => void; initial?: string }) {
  const [q, setQ] = useState(initial)
  const [hits, setHits] = useState<Hit[]>([])
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return }
    let live = true; setBusy(true)
    const h = setTimeout(async () => {
      const all = await Promise.all(sources.map(async (s) => {
        try {
          let fields = fieldCache.get(s.id); if (!fields) { fields = await backend.getFields(s.siteUrl, s.listId); fieldCache.set(s.id, fields) }
          const tf = s.isLibrary ? 'FileLeafRef' : 'Title'
          const page = await backend.query(s, fields, [tf], { ...emptyQuery(), search: q.trim(), folders: false }, 5)
          return page.rows.map<Hit>((r) => ({ src: s, title: String(r[tf] ?? `#${r.__id}`), id: r.__id }))
        } catch { return [] as Hit[] }
      }))
      if (live) { setHits(all.flat()); setBusy(false) }
    }, 350)
    return () => { live = false; clearTimeout(h) }
  }, [q, sources, backend])
  const grouped = useMemo(() => sources.map((s) => ({ s, h: hits.filter((x) => x.src.id === s.id) })).filter((g) => g.h.length), [hits, sources])
  return (
    <Modal title="Search everywhere" onClose={onClose} className="wide">
      <div className="search" style={{ marginBottom: 12 }}><span className="lead"><Icon n="search" /></span><input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search all connected lists and libraries, and the Power Platform community…" aria-label="Search everywhere" style={{ paddingRight: 14 }} /></div>
      <h3 className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.08em' }}>In your data {busy && '· searching…'}</h3>
      {q.trim().length < 2 ? <p className="muted">Type at least two letters. Searches every list and library the owner connected.</p> : !grouped.length && !busy ? <p className="muted">No matches in your connected lists.</p> : (
        <div style={{ display: 'grid', gap: 10 }}>{grouped.map(({ s, h }) => (
          <div key={s.id}><div className="row" style={{ marginBottom: 4 }}><Icon n={s.isLibrary ? 'lib' : 'list'} size={15} /><b>{s.label}</b><button className="btn sm ghost" onClick={() => { onOpen(s, q.trim()); onClose() }}>See all results →</button></div>
            <ul className="upl">{h.map((x) => <li key={x.id}><span /><button className="nm" style={{ border: 0, background: 'none', textAlign: 'left', cursor: 'pointer', color: 'var(--accent)', fontWeight: 600 }} onClick={() => { onOpen(s, x.title); onClose() }}>{x.title}</button><span className="muted small">#{x.id}</span><span /></li>)}</ul></div>
        ))}</div>
      )}
      <h3 className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.08em', marginTop: 18 }}>Power Platform community &amp; docs {q.trim() ? `· “${q.trim()}”` : ''}</h3>
      <div className="listgrid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
        {COMMUNITY(q.trim() || 'SharePoint Power Apps').map((c) => <a key={c.label} className="lcard" href={c.url} target="_blank" rel="noreferrer noopener" style={{ textDecoration: 'none', color: 'inherit' }}><span style={{ fontSize: '1.4rem' }} aria-hidden="true">{c.icon}</span><b>{c.label}</b><span className="muted small">{c.sub} ↗</span></a>)}
      </div>
      <p className="muted small" style={{ marginBottom: 4 }}>Popular topics:</p>
      <div className="row" style={{ gap: 6 }}>{TOPICS.map((t) => <button key={t} className="btn sm" onClick={() => setQ(t)}>{t}</button>)}</div>
      <p className="muted small" style={{ marginBottom: 0 }}>Community results open in a new tab (search engine results limited to those sites).</p>
    </Modal>
  )
}
