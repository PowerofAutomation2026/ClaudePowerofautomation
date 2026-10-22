import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Aggregator, insights } from '../aggregate'
import { BULK, type Engine } from '../engine'
import { emptyQuery } from '../query'
import { exportDashboardPdf } from '../export'
import type { Clause, SpField } from '../types'
import { bytes, fmt, relTime, yieldToUi } from '../util'
import { BarList, Donut, Gauge, Spark, Timeline, type Datum } from './Charts'
import { Counter, Icon, useToast } from './ui'

const SAMPLE = 2000
interface Snapshot { agg: Aggregator; at: number; kind: 'sample' | 'full' }
const cache = new Map<string, { sample?: Snapshot; full?: Snapshot }>()

interface Props { engine: Engine; version: number; onFilter: (c: Clause) => void; onGoData: () => void; title: string }

export function Dashboard({ engine, version, onFilter, onGoData, title }: Props) {
  const toast = useToast()
  const fields = engine.fields.filter((f) => engine.select.includes(f.internal) || f.internal === 'ID')
  const local = engine.mode === 'local'
  const [scope, setScope] = useState<'sample' | 'full'>('sample')
  const [snap, setSnap] = useState<Snapshot | null>(cache.get(engine.src.id)?.sample ?? null)
  const [busy, setBusy] = useState(false)
  const [deep, setDeep] = useState<{ done: number; running: boolean; t0: number } | null>(null)
  const abort = useRef<AbortController | null>(null)

  // local mode: the dashboard is just the current view, always live and filter-aware
  const localAgg = useMemo(() => {
    if (!local) return null
    const a = new Aggregator(fields, engine.src.isLibrary); a.add(engine.rows); return a
  }, [local, version]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadSample = useCallback(async () => {
    if (local) return
    setBusy(true)
    try {
      const page = await engine.backend.query(engine.src, engine.fields, engine.select, { ...emptyQuery(), folders: false }, SAMPLE, undefined)
      const agg = new Aggregator(fields, engine.src.isLibrary); agg.add(page.rows)
      const s: Snapshot = { agg, at: Date.now(), kind: 'sample' }
      cache.set(engine.src.id, { ...cache.get(engine.src.id), sample: s }); setSnap(s)
    } catch (e) { toast('bad', (e as Error).message) } finally { setBusy(false) }
  }, [engine, local]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!local && !cache.get(engine.src.id)?.sample) void loadSample() }, [engine.src.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // keep the sample fresh when the live pulse sees the list grow
  useEffect(() => { if (!local && snap && engine.pendingNew > 0 && Date.now() - snap.at > 20_000) void loadSample() }, [engine.pendingNew]) // eslint-disable-line react-hooks/exhaustive-deps

  const startDeep = async () => {
    abort.current?.abort(); const ctl = (abort.current = new AbortController())
    const agg = new Aggregator(fields, engine.src.isLibrary)
    const t0 = Date.now(); let done = 0, cursor: string | undefined
    setDeep({ done: 0, running: true, t0 }); setScope('full')
    try {
      for (;;) {
        const page = await engine.backend.query(engine.src, engine.fields, engine.select, { ...emptyQuery(), sort: { field: 'ID', dir: 'asc' } }, BULK, cursor, ctl.signal)
        agg.add(page.rows); done += page.rows.length; cursor = page.cursor
        const s: Snapshot = { agg, at: Date.now(), kind: 'full' }
        cache.set(engine.src.id, { ...cache.get(engine.src.id), full: s }); setSnap(s); setDeep({ done, running: !!cursor, t0 })
        if (!cursor) break
        await yieldToUi()
      }
      toast('good', `Deep scan finished: ${fmt(done)} items analysed.`)
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast('bad', `Deep scan stopped: ${(e as Error).message}`)
      setDeep((d) => (d ? { ...d, running: false } : d))
    }
  }
  useEffect(() => () => abort.current?.abort(), [])
  useEffect(() => { // switch back to whichever snapshot the scope asks for
    if (local) return
    setSnap(scope === 'full' ? cache.get(engine.src.id)?.full ?? cache.get(engine.src.id)?.sample ?? null : cache.get(engine.src.id)?.sample ?? null)
  }, [scope, engine.src.id, local])

  const agg = local ? localAgg : snap?.agg
  const scopeLabel = local ? (engine.q.search || engine.q.clauses.length ? 'current filter' : 'all items, live') : snap?.kind === 'full' ? `deep scan${deep?.running ? ' in progress' : ''}` : `latest ${fmt(SAMPLE)} items`

  const model = useMemo(() => {
    if (!agg || !agg.rows) return null
    const cats: { f: SpField; data: Datum[] }[] = []
    for (const s of agg.stats.values()) {
      const f = s.field
      const isCat = ['choice', 'boolean', 'multichoice'].includes(f.kind) || (f.kind === 'text' && s.counts.size > 1 && s.counts.size <= 12 && f.internal !== 'Title' && f.internal !== 'FileLeafRef' && f.internal !== 'File_x0020_Type')
      const isPeople = f.kind === 'user' || f.kind === 'lookup'
      if ((isCat || isPeople) && s.counts.size > 1 && !s.overflow && !(f.system && !['Author', 'Editor'].includes(f.internal))) cats.push({ f, data: agg.top(f.internal, 7) })
      else if (isPeople && s.counts.size > 1 && !f.system) cats.push({ f, data: agg.top(f.internal, 7) })
    }
    cats.sort((a, b) => rank(a.f) - rank(b.f))
    const nums = [...agg.stats.values()].filter((s) => (s.field.kind === 'number' || s.field.kind === 'currency') && s.n > 0 && !['File_x0020_Size', 'ID', 'Version'].includes(s.field.internal) && s.max > s.min).slice(0, 4)
    const health = [...agg.stats.values()].filter((s) => !s.field.system && !['ID'].includes(s.field.internal) && s.field.kind !== 'counter').map((s) => ({ label: s.field.title, value: Math.round((s.n / Math.max(1, s.n + s.missing)) * 100) }))
    const score = health.length ? Math.round(health.reduce((a, b) => a + b.value, 0) / health.length) : 100
    return { cats: cats.slice(0, 6), nums, health: health.sort((a, b) => a.value - b.value).slice(0, 8), score, timeline: agg.timeline('created') }
  }, [agg, version]) // eslint-disable-line react-hooks/exhaustive-deps

  const notes = useMemo(() => (agg ? insights(agg, engine.total, scopeLabel) : []), [agg, engine.total, scopeLabel])
  const pick = (f: SpField, label: string) => {
    const c: Clause = f.kind === 'boolean' ? { field: f.internal, op: 'eq', value: label === 'Yes' ? 'true' : 'false' }
      : f.kind === 'user' || f.kind === 'lookup' ? { field: f.internal, op: 'eq', value: label } : { field: f.internal, op: 'in', value: '', values: [label] }
    onFilter(c); onGoData()
  }

  if (!agg || !model) return (
    <div className="dgrid" aria-busy="true"><div className="card skel" style={{ height: 140 }} /><div className="card skel" style={{ height: 140 }} /><div className="card skel" style={{ height: 140 }} /></div>
  )

  const delta = agg.last7 - agg.prev7
  const total = engine.total

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="pill accent"><Icon n="sparkle" size={13} /> Auto-built from live data · {scopeLabel}</span>
        {!local && (
          <div role="group" aria-label="Dashboard scope" className="row" style={{ gap: 4 }}>
            <button className="btn sm" aria-pressed={scope === 'sample'} onClick={() => setScope('sample')}>Quick sample</button>
            <button className="btn sm" aria-pressed={scope === 'full'} onClick={() => (cache.get(engine.src.id)?.full ? setScope('full') : void startDeep())} disabled={!!deep?.running}>
              <Icon n="scan" size={14} />{cache.get(engine.src.id)?.full ? 'Deep scan result' : 'Deep scan everything'}
            </button>
          </div>
        )}
        <span className="grow" />
        {!local && <button className="btn sm" onClick={loadSample} disabled={busy}><Icon n="refresh" size={14} />{busy ? 'Refreshing…' : 'Refresh'}</button>}
        <button className="btn sm" onClick={() => exportDashboardPdf(title, scopeLabel,
          [{ label: 'Total items', value: fmt(total) }, { label: 'Analysed', value: fmt(agg.rows) }, { label: 'New (7 days)', value: fmt(agg.last7) }, { label: 'Data health', value: `${model.score}%` }],
          model.cats.map((c) => ({ title: c.f.title, data: c.data })), notes)}>
          <Icon n="download" size={14} />Dashboard PDF
        </button>
      </div>

      {deep && (
        <div className="banner info" role="status" aria-live="polite">
          <Icon n="scan" />
          <div style={{ flex: 1 }}>
            <b>{deep.running ? 'Deep scan running' : 'Deep scan finished'}</b> — {fmt(deep.done)} of {fmt(total)} items ({Math.min(100, Math.round((deep.done / Math.max(1, total)) * 100))}%)
            {deep.running && <> · ~{fmt(Math.round(deep.done / Math.max(1, (Date.now() - deep.t0) / 1000)))} items/s · the app stays fully usable while this runs</>}
            <div className="bar-progress" style={{ marginTop: 6, borderRadius: 9 }}><i style={{ width: `${Math.min(100, (deep.done / Math.max(1, total)) * 100)}%` }} /></div>
          </div>
          {deep.running && <button className="btn sm" onClick={() => abort.current?.abort()}>Stop</button>}
        </div>
      )}

      <section className="kpis" aria-label="Key figures">
        <div className="card kpi"><div className="l">Items in {engine.src.isLibrary ? 'library' : 'list'}</div><div className="v"><Counter value={total} /></div><div className="d muted">{local ? 'fully loaded in memory' : 'server-side, never fully loaded'}</div></div>
        <div className="card kpi"><div className="l">Analysed</div><div className="v"><Counter value={agg.rows} /></div><div className="d muted">{scopeLabel}</div></div>
        <div className="card kpi"><div className="l">New in last 7 days</div><div className="v"><Counter value={agg.last7} /></div>
          <div className="d" style={{ color: delta >= 0 ? 'var(--good)' : 'var(--warn)' }}>{delta >= 0 ? '▲' : '▼'} {fmt(Math.abs(delta))} vs. previous week</div><Spark data={agg.recent(14)} label="Items created per day, last 14 days" /></div>
        <div className="card kpi"><div className="l">Last change</div><div className="v" style={{ fontSize: '1.4rem' }}>{agg.lastModified ? relTime(new Date(agg.lastModified).toISOString()) : '—'}</div><div className="d muted">{agg.stale ? `${fmt(agg.stale)} untouched > 1 year` : 'nothing stale'}</div></div>
        {engine.src.isLibrary
          ? <div className="card kpi"><div className="l">Storage (analysed files)</div><div className="v" style={{ fontSize: '1.5rem' }}>{bytes(agg.totalBytes)}</div><div className="d muted">{fmt(agg.ext.size)} file types</div></div>
          : model.nums[0] && <div className="card kpi"><div className="l">{model.nums[0].field.title} · total</div><div className="v" style={{ fontSize: '1.5rem' }}>{fmt(Math.round(model.nums[0].sum))}</div><div className="d muted">avg {fmt(Math.round(model.nums[0].sum / model.nums[0].n))}</div></div>}
        <div className="card kpi" style={{ display: 'flex', gap: 12, alignItems: 'center' }}><Gauge value={model.score} label="Data health" /><div><div className="l">Data health</div><div className="d muted">average fill rate of your columns</div></div></div>
      </section>

      <div className="dgrid">
        <section className="card span2" aria-labelledby="h-time"><h2 id="h-time"><Icon n="chart" /> Activity — items created over time</h2><Timeline data={model.timeline} label="Items created over time" /></section>

        <section className="card" aria-labelledby="h-ins"><h2 id="h-ins"><Icon n="sparkle" /> Smart insights</h2>
          {notes.map((n, i) => <div key={i} className={`insight ${n.level}`}>{n.level === 'warn' ? '⚠️' : n.level === 'good' ? '✅' : '💡'}<span>{n.text}</span></div>)}
        </section>

        {model.cats.map(({ f, data }) => (
          <section key={f.internal} className="card" aria-label={`${f.title} breakdown`}>
            <h2>{f.title}</h2>
            {data.length <= 5 && f.kind !== 'user' && f.kind !== 'lookup' ? <Donut data={data} onPick={(l) => pick(f, l)} /> : <BarList data={data} onPick={(l) => pick(f, l)} />}
          </section>
        ))}

        {engine.src.isLibrary && agg.ext.size > 0 && <>
          <section className="card"><h2><Icon n="file" /> File types by count</h2><BarList data={[...agg.ext.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 8).map(([label, v]) => ({ label: '.' + label, value: v.count }))} /></section>
          <section className="card"><h2><Icon n="lib" /> Storage by file type</h2><BarList format={bytes} data={[...agg.ext.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8).map(([label, v]) => ({ label: '.' + label, value: v.bytes }))} /></section>
          <section className="card"><h2>Largest files</h2><BarList format={bytes} data={agg.big.slice(0, 8).map((b) => ({ label: b.name, value: b.size }))} /></section>
        </>}

        {model.nums.length > 0 && !engine.src.isLibrary && (
          <section className="card"><h2>Numbers</h2>
            <table className="data"><thead><tr><th>Column</th><th>Sum</th><th>Avg</th><th>Min</th><th>Max</th></tr></thead>
              <tbody>{model.nums.map((s) => <tr key={s.field.internal}><td>{s.field.title}</td><td>{fmt(Math.round(s.sum))}</td><td>{fmt(Math.round(s.sum / s.n))}</td><td>{fmt(s.min)}</td><td>{fmt(s.max)}</td></tr>)}</tbody></table>
          </section>
        )}

        <section className="card" aria-labelledby="h-health"><h2 id="h-health"><Icon n="check" /> Data health — fill rate per column</h2>
          <BarList data={model.health} format={(n) => `${n}%`} color="var(--c5)" />
        </section>

        <PulseFeed engine={engine} version={version} />
      </div>
    </div>
  )
}

const rank = (f: SpField) => (f.kind === 'choice' ? 0 : f.kind === 'boolean' ? 1 : f.kind === 'multichoice' ? 2 : f.kind === 'text' ? 3 : f.kind === 'lookup' ? 4 : 5)

export function PulseFeed({ engine, version }: { engine: Engine; version: number }) {
  void version
  return (
    <section className="card" aria-labelledby="h-pulse">
      <h2 id="h-pulse"><Icon n="bolt" /> Live pulse</h2>
      {engine.pulse.length === 0 ? <p className="muted">Waiting for changes… new and edited items appear here as they happen (turn on Live in the header).</p> : (
        <ul className="feed" aria-live="polite">
          {engine.pulse.slice(0, 30).map((e, i) => (
            <li key={`${e.id}-${e.at}-${i}`}><span className={`pill ${e.kind === 'new' ? 'good' : 'accent'}`}>{e.kind === 'new' ? 'New' : 'Edited'}</span><span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title}</span><span className="muted small">{relTime(new Date(e.at).toISOString())}</span></li>
          ))}
        </ul>
      )}
    </section>
  )
}
