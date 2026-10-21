import { useId, useState } from 'react'
import { fmt } from '../util'
import { COLORS } from './ui'

export interface Datum { label: string; value: number }
const total = (d: Datum[]) => d.reduce((a, b) => a + b.value, 0)

/** Every chart has a text equivalent: bars are a list with numbers, donut has a legend, timeline has a table. */
export function BarList({ data, onPick, color, format = fmt }: { data: Datum[]; onPick?: (label: string) => void; color?: string; format?: (n: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value)), sum = total(data)
  return (
    <ul className="bars">
      {data.map((d, i) => (
        <li key={d.label}>
          {onPick && d.label !== 'Other' ? <button className="lbl" onClick={() => onPick(d.label)} title={`Filter by “${d.label}”`}>{d.label}</button> : <span className="lbl" style={{ padding: '2px 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label}</span>}
          <span className="track" aria-hidden="true"><span className="fill" style={{ width: `${(d.value / max) * 100}%`, background: color ?? COLORS[i % COLORS.length] }} /></span>
          <span className="n">{format(d.value)} <span className="muted small">{sum ? `${Math.round((d.value / sum) * 100)}%` : ''}</span></span>
        </li>
      ))}
    </ul>
  )
}

export function Donut({ data, onPick, centerLabel }: { data: Datum[]; onPick?: (label: string) => void; centerLabel?: string }) {
  const sum = total(data) || 1
  const R = 52, C = 2 * Math.PI * R
  let acc = 0
  const [hot, setHot] = useState<number | null>(null)
  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 140 140" width="150" height="150" role="img" aria-label={data.map((d) => `${d.label} ${Math.round((d.value / sum) * 100)}%`).join(', ')}>
        <g transform="rotate(-90 70 70)">
          {data.map((d, i) => {
            const len = (d.value / sum) * C
            const el = <circle key={d.label} cx="70" cy="70" r={R} fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth={hot === i ? 24 : 20}
              strokeDasharray={`${Math.max(0, len - 1.5)} ${C}`} strokeDashoffset={-acc} onMouseEnter={() => setHot(i)} onMouseLeave={() => setHot(null)} style={{ transition: 'stroke-width .15s' }} />
            acc += len
            return el
          })}
        </g>
        <text x="70" y="68" textAnchor="middle" fontSize="19" fontWeight="800" fill="var(--text)">{hot != null ? `${Math.round((data[hot].value / sum) * 100)}%` : fmt(sum)}</text>
        <text x="70" y="84" textAnchor="middle" fontSize="8.5" fill="var(--muted)">{hot != null ? data[hot].label.slice(0, 18) : centerLabel ?? 'items'}</text>
      </svg>
      <ul className="legend">
        {data.map((d, i) => (
          <li key={d.label}>
            <button onClick={() => onPick?.(d.label)} disabled={!onPick || d.label === 'Other'} onMouseEnter={() => setHot(i)} onMouseLeave={() => setHot(null)} onFocus={() => setHot(i)} onBlur={() => setHot(null)}>
              <span className="sw" style={{ background: COLORS[i % COLORS.length] }} aria-hidden="true" />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label}</span>
              <b>{fmt(d.value)}</b><span className="muted small">{Math.round((d.value / sum) * 100)}%</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Timeline({ data, label }: { data: Datum[]; label: string }) {
  const id = useId()
  const [showTable, setShowTable] = useState(false)
  const [hot, setHot] = useState<number | null>(null)
  if (!data.length) return <p className="muted">No dated items.</p>
  const W = 640, H = 170, P = { l: 38, r: 8, t: 10, b: 24 }
  const max = Math.max(1, ...data.map((d) => d.value))
  const bw = (W - P.l - P.r) / data.length
  const ticks = [0, 0.5, 1].map((t) => Math.round(max * t))
  const step = Math.ceil(data.length / 8)
  return (
    <div>
      <svg className="timeline" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-labelledby={id} onMouseLeave={() => setHot(null)}>
        <title id={id}>{label}: {data.length} periods, peak {fmt(max)} in {data.reduce((a, b) => (b.value > a.value ? b : a)).label}</title>
        {ticks.map((t) => { const y = P.t + (H - P.t - P.b) * (1 - t / max); return <g key={t}><line x1={P.l} x2={W - P.r} y1={y} y2={y} stroke="var(--line)" /><text x={P.l - 5} y={y + 3} textAnchor="end">{fmt(t)}</text></g> })}
        {data.map((d, i) => {
          const h = ((H - P.t - P.b) * d.value) / max
          return <rect key={d.label} x={P.l + i * bw + 1} y={H - P.b - h} width={Math.max(1, bw - 2)} height={h} rx={Math.min(3, bw / 3)} fill={hot === i ? 'var(--c2)' : 'var(--c1)'} onMouseEnter={() => setHot(i)}><title>{`${d.label}: ${fmt(d.value)}`}</title></rect>
        })}
        {data.map((d, i) => i % step === 0 ? <text key={d.label} x={P.l + i * bw + bw / 2} y={H - 8} textAnchor="middle">{d.label.length > 7 ? d.label.slice(2) : d.label}</text> : null)}
        {hot != null && <text x={W - P.r} y={12} textAnchor="end" style={{ fill: 'var(--text)', fontWeight: 700, fontSize: 12 }}>{data[hot].label}: {fmt(data[hot].value)}</text>}
      </svg>
      <button className="btn sm ghost" onClick={() => setShowTable(!showTable)} aria-expanded={showTable}>{showTable ? 'Hide' : 'View'} data table</button>
      {showTable && <div style={{ maxHeight: 180, overflow: 'auto' }}><table className="data"><caption className="sr-only">{label}</caption><thead><tr><th>Period</th><th>Items</th></tr></thead><tbody>{data.map((d) => <tr key={d.label}><td>{d.label}</td><td>{fmt(d.value)}</td></tr>)}</tbody></table></div>}
    </div>
  )
}
