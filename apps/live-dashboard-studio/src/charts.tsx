import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { formatNumber } from './engine'
import type { Cell, Column, Point, Row } from './engine'

/* ------------------------------------------------------------------ tooltip */

interface Tip { x: number; y: number; body: ReactNode }
export function useTooltip() {
  const [tip, setTip] = useState<Tip | null>(null)
  const show = useCallback((e: { clientX: number; clientY: number }, body: ReactNode) => setTip({ x: e.clientX, y: e.clientY, body }), [])
  const hide = useCallback(() => setTip(null), [])
  const node = tip ? (
    <div className="tip" role="tooltip" style={{ left: Math.min(tip.x + 14, window.innerWidth - 220), top: tip.y + 16 }}>{tip.body}</div>
  ) : null
  return { show, hide, node }
}

const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)']
export const OTHER_COLOR = 'var(--other)'

/** Color follows the entity: pass the labels of the UNFILTERED series so a filter never repaints survivors. */
export function colorMap(labels: string[]): Map<string, string> {
  const m = new Map<string, string>()
  let i = 0
  for (const l of labels) { if (l === 'Other') m.set(l, OTHER_COLOR); else m.set(l, SERIES[Math.min(i++, SERIES.length - 1)]) }
  return m
}

/* --------------------------------------------------------------------- KPI */

export function Kpi({ value, previous }: { value: number; previous: number | null }) {
  const delta = previous === null ? null : value - previous
  return (
    <div className="kpi">
      <div className="kpi-value" title={formatNumber(value, false)}>{formatNumber(value)}</div>
      <div className="kpi-delta" aria-live="polite">
        {delta === null ? ' ' : delta === 0 ? 'no change since last refresh' : `${delta > 0 ? '▲ +' : '▼ '}${formatNumber(delta)} since last refresh`}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------- bars */

export function BarChart({ points, selected, onSelect, unit }: { points: Point[]; selected: string[]; onSelect: (label: string) => void; unit: string }) {
  const { show, hide, node } = useTooltip()
  const max = Math.max(...points.map((p) => p.value), 1e-9)
  const total = points.reduce((s, p) => s + p.value, 0)
  if (!points.length) return <Empty />
  return (
    <div className="bars" role="list">
      {points.map((p) => {
        const active = selected.length === 0 || selected.includes(p.label)
        return (
          <button
            key={p.label} role="listitem" className={`bar-row${active ? '' : ' dim'}`} type="button"
            aria-pressed={selected.includes(p.label)} aria-label={`${p.label}: ${formatNumber(p.value, false)} ${unit}`}
            onClick={() => onSelect(p.label)}
            onPointerMove={(e) => show(e, <TipBody title={p.label} value={`${formatNumber(p.value, false)} ${unit}`} sub={total > 0 && p.value >= 0 ? `${((p.value / total) * 100).toFixed(1)}% of shown · ${p.n} rows` : `${p.n} rows`} />)}
            onPointerLeave={hide} onFocus={(e) => { const r = e.currentTarget.getBoundingClientRect(); show({ clientX: r.left + 40, clientY: r.top }, <TipBody title={p.label} value={`${formatNumber(p.value, false)} ${unit}`} sub={`${p.n} rows`} />) }} onBlur={hide}
          >
            <span className="bar-label" title={p.label}>{p.label}</span>
            <span className="bar-track">
              <span className="bar-fill" style={{ width: `${Math.max((Math.max(p.value, 0) / max) * 100, p.value > 0 ? 0.8 : 0)}%` }} />
              <span className="bar-value">{formatNumber(p.value)}</span>
            </span>
          </button>
        )
      })}
      {node}
    </div>
  )
}

/* -------------------------------------------------------------------- line */

/** Round tick values (0, 5, 10 ...) covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, want = 4): number[] {
  const range = hi - lo || Math.abs(hi) || 1
  const raw = range / want
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  const n = raw / p
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p
  const out: number[] = []
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 1000; v += step) out.push(Math.round(v / step) * step)
  return out
}

export function LineChart({ points, unit }: { points: Point[]; unit: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(480)
  const [hover, setHover] = useState<number | null>(null)
  const { show, hide, node } = useTooltip()
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(Math.max(240, el.clientWidth)))
    ro.observe(el); setW(Math.max(240, el.clientWidth))
    return () => ro.disconnect()
  }, [])
  const H = 200, L = 40, Rm = 56, T = 12, B = 24
  const geo = useMemo(() => {
    const ticks = niceTicks(Math.min(0, ...points.map((p) => p.value)), Math.max(...points.map((p) => p.value), 0))
    const hi = ticks[ticks.length - 1]
    const lo = ticks[0]
    const x = (i: number) => L + (points.length < 2 ? (w - L - Rm) / 2 : (i * (w - L - Rm)) / (points.length - 1))
    const y = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B)
    return { hi, lo, x, y, ticks }
  }, [points, w])
  if (!points.length) return <Empty />
  const ticks = geo.ticks
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${geo.x(i).toFixed(1)},${geo.y(p.value).toFixed(1)}`).join(' ')
  const area = `${path} L${geo.x(points.length - 1).toFixed(1)},${geo.y(geo.lo).toFixed(1)} L${geo.x(0).toFixed(1)},${geo.y(geo.lo).toFixed(1)} Z`
  const nLab = Math.max(2, Math.floor((w - L - Rm) / 92))
  const labelIdx = new Set<number>(points.length <= nLab ? points.map((_, i) => i) : Array.from({ length: nLab }, (_, k) => Math.round((k * (points.length - 1)) / (nLab - 1))))
  const last = points[points.length - 1]
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    let best = 0, bd = Infinity
    points.forEach((_, i) => { const d = Math.abs(geo.x(i) - px); if (d < bd) { bd = d; best = i } })
    setHover(best)
    const p = points[best]
    show(e, <TipBody title={p.label} value={`${formatNumber(p.value, false)} ${unit}`} sub={`${p.n} rows`} line />)
  }
  return (
    <div ref={ref} className="line-wrap">
      <svg width={w} height={H} role="img" aria-label={`Line chart, ${points.length} points, latest ${formatNumber(last.value, false)} ${unit}`}
        onPointerMove={onMove} onPointerLeave={() => { setHover(null); hide() }}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={L} x2={w - Rm + 8} y1={geo.y(t)} y2={geo.y(t)} className="grid" />
            <text x={L - 6} y={geo.y(t) + 4} textAnchor="end" className="axis">{formatNumber(t)}</text>
          </g>
        ))}
        {points.map((p, i) => labelIdx.has(i) ? <text key={p.label} x={geo.x(i)} y={H - 6} textAnchor="middle" className="axis">{p.label}</text> : null)}
        <path d={area} className="area" />
        <path d={path} className="line" />
        {hover !== null && <line x1={geo.x(hover)} x2={geo.x(hover)} y1={T} y2={H - B} className="crosshair" />}
        {hover !== null && <circle cx={geo.x(hover)} cy={geo.y(points[hover].value)} r={4} className="dot" />}
        <circle cx={geo.x(points.length - 1)} cy={geo.y(last.value)} r={4} className="dot" />
        <text x={geo.x(points.length - 1) + 8} y={geo.y(last.value) + 4} className="endlabel">{formatNumber(last.value)}</text>
      </svg>
      {node}
    </div>
  )
}

/* ------------------------------------------------------------------- donut */

export function Donut({ points, colors, selected, onSelect, unit }: { points: Point[]; colors: Map<string, string>; selected: string[]; onSelect: (l: string) => void; unit: string }) {
  const { show, hide, node } = useTooltip()
  const total = points.reduce((s, p) => s + Math.max(p.value, 0), 0)
  if (!points.length || total <= 0) return <Empty />
  const R = 62, r = 40, C = 70
  let a0 = -Math.PI / 2
  const arcs = points.map((p) => {
    const frac = Math.max(p.value, 0) / total
    const a1 = a0 + frac * Math.PI * 2
    const large = a1 - a0 > Math.PI ? 1 : 0
    const pt = (a: number, rad: number) => `${(C + rad * Math.cos(a)).toFixed(2)},${(C + rad * Math.sin(a)).toFixed(2)}`
    const d = frac >= 0.9999
      ? `M${pt(a0, R)} A${R},${R} 0 1 1 ${pt(a0 + Math.PI, R)} A${R},${R} 0 1 1 ${pt(a0, R)} M${pt(a0, r)} A${r},${r} 0 1 0 ${pt(a0 + Math.PI, r)} A${r},${r} 0 1 0 ${pt(a0, r)}Z`
      : `M${pt(a0, R)} A${R},${R} 0 ${large} 1 ${pt(a1, R)} L${pt(a1, r)} A${r},${r} 0 ${large} 0 ${pt(a0, r)}Z`
    a0 = a1
    return { p, d, frac }
  })
  return (
    <div className="donut">
      <svg viewBox={`0 0 ${C * 2} ${C * 2}`} width={140} height={140} role="img" aria-label={`Share chart, ${points.length} parts`}>
        {arcs.map(({ p, d, frac }) => {
          const active = selected.length === 0 || selected.includes(p.label)
          return (
            <path key={p.label} d={d} fill={colors.get(p.label) ?? OTHER_COLOR} className={`slice${active ? '' : ' dim'}`} fillRule="evenodd" tabIndex={0} role="button"
              aria-label={`${p.label}: ${(frac * 100).toFixed(1)}%`} onClick={() => onSelect(p.label)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(p.label) } }}
              onPointerMove={(e) => show(e, <TipBody title={p.label} value={`${formatNumber(p.value, false)} ${unit}`} sub={`${(frac * 100).toFixed(1)}% · ${p.n} rows`} />)} onPointerLeave={hide} />
          )
        })}
        <text x={C} y={C - 2} textAnchor="middle" className="donut-total">{formatNumber(total)}</text>
        <text x={C} y={C + 14} textAnchor="middle" className="axis">total</text>
      </svg>
      <ul className="legend">
        {arcs.map(({ p, frac }) => (
          <li key={p.label}>
            <button type="button" className={selected.length && !selected.includes(p.label) ? 'dim' : ''} onClick={() => onSelect(p.label)}>
              <span className="swatch" style={{ background: colors.get(p.label) ?? OTHER_COLOR }} />
              <span className="lg-label" title={p.label}>{p.label}</span>
              <span className="lg-val">{(frac * 100).toFixed(0)}%</span>
            </button>
          </li>
        ))}
      </ul>
      {node}
    </div>
  )
}

/* ------------------------------------------------------------------- table */

export function DataTable({ columns, rows, limit = 200 }: { columns: Column[]; rows: Row[]; limit?: number }) {
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null)
  const [q, setQ] = useState('')
  const sorted = useMemo(() => {
    let r = rows
    if (q.trim()) { const s = q.toLowerCase(); r = r.filter((row) => columns.some((c) => String(row[c.name] ?? '').toLowerCase().includes(s))) }
    if (sort) { const { col, dir } = sort; r = [...r].sort((a, b) => { const x = a[col], y = b[col]; if (x === y) return 0; if (x === null) return 1; if (y === null) return -1; return (x < y ? -1 : 1) * dir }) }
    return r
  }, [rows, sort, q, columns])
  return (
    <div className="table-wrap">
      <input className="table-search" placeholder="Search rows…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search rows" />
      <div className="scroll">
        <table>
          <thead><tr>{columns.map((c) => (
            <th key={c.name} className={c.type === 'number' ? 'num' : ''} aria-sort={sort?.col === c.name ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
              <button type="button" onClick={() => setSort((s) => (s?.col === c.name ? (s.dir === 1 ? { col: c.name, dir: -1 } : null) : { col: c.name, dir: 1 }))}>
                {c.name}{sort?.col === c.name ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
              </button>
            </th>))}</tr></thead>
          <tbody>
            {sorted.slice(0, limit).map((r, i) => (
              <tr key={i}>{columns.map((c) => <td key={c.name} className={c.type === 'number' ? 'num' : ''}>{cellText(r[c.name], c)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="muted small">{sorted.length > limit ? `Showing first ${limit} of ${sorted.length.toLocaleString()} rows` : `${sorted.length.toLocaleString()} rows`}</div>
    </div>
  )
}
const cellText = (v: Cell | undefined, c: Column) => (v === null || v === undefined ? '' : c.type === 'number' ? formatNumber(Number(v), false) : String(v))

/** Accessible alternative for any chart: the plotted values as a table. */
export function SeriesTable({ points, dimLabel, valueLabel }: { points: Point[]; dimLabel: string; valueLabel: string }) {
  return (
    <div className="scroll">
      <table>
        <thead><tr><th>{dimLabel}</th><th className="num">{valueLabel}</th><th className="num">Rows</th></tr></thead>
        <tbody>{points.map((p) => <tr key={p.label}><td>{p.label}</td><td className="num">{formatNumber(p.value, false)}</td><td className="num">{p.n}</td></tr>)}</tbody>
      </table>
    </div>
  )
}

/* ------------------------------------------------------------------ helpers */

function TipBody({ title, value, sub, line }: { title: string; value: string; sub?: string; line?: boolean }) {
  return (
    <div>
      <div className="tip-value">{line && <span className="tip-key" />}{value}</div>
      <div className="tip-title">{title}</div>
      {sub && <div className="tip-sub">{sub}</div>}
    </div>
  )
}
export function Empty({ text = 'No data for the current filters' }: { text?: string }) { return <div className="empty">{text}</div> }

/** Re-render every `ms` so relative times ("12 s ago") stay fresh. */
export function useTick(ms = 1000) {
  const [, set] = useState(0)
  useEffect(() => { const t = setInterval(() => set((n) => n + 1), ms); return () => clearInterval(t) }, [ms])
}
