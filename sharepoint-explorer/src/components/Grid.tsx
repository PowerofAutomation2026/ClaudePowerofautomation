import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import type { Engine } from '../engine'
import type { Row, SpField } from '../types'
import { cellText, fmt } from '../util'
import { Icon, hashColor, initials } from './ui'
import { FileGlyph, extOf } from './FileGlyph'
import { bytes } from '../util'

export const ROW_H = 40
const CARD_H = 168
const CARD_MIN_W = 290

const defaultWidth = (f: SpField) =>
  f.internal === 'Title' || f.internal === 'FileLeafRef' ? 300 : f.kind === 'date' ? 150 : f.kind === 'number' || f.kind === 'currency' || f.kind === 'counter' ? 120 : f.kind === 'boolean' ? 100 : f.kind === 'user' ? 180 : f.kind === 'note' ? 280 : 160

function hl(text: string, tokens: string[]): ReactNode {
  if (!tokens.length || !text) return text
  const re = new RegExp('(' + tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'ig')
  const parts = text.split(re)
  if (parts.length === 1) return text
  return parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))
}

export function CellView({ f, row, tokens }: { f: SpField; row: Row; tokens: string[] }): ReactNode {
  const text = cellText(f, row)
  if (!text) return <span className="muted" aria-label="empty">–</span>
  switch (f.kind) {
    case 'choice': return <span className="tag" style={{ '--tc': hashColor(text) } as CSSProperties}>{hl(text, tokens)}</span>
    case 'multichoice': return <>{String(text).split('; ').map((t) => <span key={t} className="tag" style={{ '--tc': hashColor(t), marginRight: 4 } as CSSProperties}>{t}</span>)}</>
    case 'boolean': return <span className={`pill ${text === 'Yes' ? 'good' : ''}`}>{text === 'Yes' ? <Icon n="check" size={13} /> : null}{text}</span>
    case 'user': return <span className="who"><span className="av" style={{ '--tc': hashColor(text) } as CSSProperties} aria-hidden="true">{initials(text)}</span>{hl(text, tokens)}</span>
    case 'url': { const u = typeof row[f.internal] === 'object' ? row[f.internal].Url : row[f.internal]; return <a href={String(u)} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{text}</a> }
    case 'date': return <time dateTime={String(row[f.internal])}>{text}</time>
    default:
      if (f.internal === 'FileLeafRef') return <span className="who"><FileGlyph name={text} folder={row.FSObjType === 1} size={22} />{hl(text, tokens)}</span>
      if (/percent/i.test(f.internal + f.title) && !isNaN(Number(row[f.internal]))) return <span className="who" style={{ width: '100%' }}><span style={{ flex: 1, height: 6, background: 'var(--bg2)', borderRadius: 9, overflow: 'hidden' }} aria-hidden="true"><i style={{ display: 'block', height: '100%', width: `${Math.min(100, Number(row[f.internal]))}%`, background: 'var(--c5)' }} /></span>{text}</span>
      return hl(text, tokens)
  }
}

interface RowProps { row: Row; idx: number; cols: SpField[]; tpl: string; width: number; selected: boolean; active: boolean; tokens: string[]; onOpen: (r: Row) => void; onToggle: (id: number) => void; onMenu?: (r: Row, at: DOMRect) => void }
const GridRow = memo(function GridRow({ row, idx, cols, tpl, width, selected, active, tokens, onOpen, onToggle, onMenu }: RowProps) {
  return (
    <div role="row" id={`row-${idx}`} aria-rowindex={idx + 2} aria-selected={selected}
      className={`g-row${active ? ' active' : ''}${row.__new ? ' fresh' : ''}`}
      style={{ top: idx * ROW_H, height: ROW_H, gridTemplateColumns: tpl, width }} onClick={() => onOpen(row)}
      onContextMenu={(e) => { if (onMenu) { e.preventDefault(); onMenu(row, new DOMRect(e.clientX, e.clientY, 0, 0)) } }}>
      <div role="gridcell" className="g-c sel" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={selected} onChange={() => onToggle(row.__id)} aria-label={`Select item ${row.__id}`} />
      </div>
      {cols.map((f) => (
        <div role="gridcell" key={f.internal} className={`g-c${f.kind === 'number' || f.kind === 'currency' || f.kind === 'counter' ? ' num' : ''}`} title={cellText(f, row)}>
          <CellView f={f} row={row} tokens={tokens} />
        </div>
      ))}
      {onMenu && <div role="gridcell" className="g-c sel"><button className="btn icon sm ghost" aria-label={`Actions for ${cellText(cols[0], row) || 'item ' + row.__id}`} aria-haspopup="menu" onClick={(e) => { e.stopPropagation(); onMenu(row, e.currentTarget.getBoundingClientRect()) }}>⋯</button></div>}
    </div>
  )
})

export interface GridProps {
  engine: Engine
  version: number
  cols: SpField[]
  selected: Set<number>
  widths: Record<string, number>
  setWidth: (internal: string, w: number) => void
  onToggle: (id: number) => void
  onToggleAll: () => void
  onOpen: (r: Row) => void
  onSort: (internal: string) => void
  tokens: string[]
  view: 'table' | 'cards' | 'tiles'
  isLibrary: boolean
  onMenu?: (row: Row, at: DOMRect) => void
  onNavigate?: (row: Row) => void
  origin?: string
}

export function Grid(p: GridProps) {
  const { engine, cols, version } = p
  const rows = engine.rows
  const ref = useRef<HTMLDivElement>(null)
  const [vp, setVp] = useState({ top: 0, h: 600, w: 1000 })
  const [active, setActive] = useState(0)
  const raf = useRef(0)

  const measure = useCallback(() => {
    const el = ref.current; if (!el) return
    setVp((v) => (v.top === el.scrollTop && v.h === el.clientHeight && v.w === el.clientWidth ? v : { top: el.scrollTop, h: el.clientHeight, w: el.clientWidth }))
  }, [])
  useLayoutEffect(() => { measure(); const ro = new ResizeObserver(measure); if (ref.current) ro.observe(ref.current); return () => ro.disconnect() }, [measure])
  const onScroll = () => { cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(measure) }

  const cards = p.view !== 'table'
  const tiles = p.view === 'tiles'
  const cardW = tiles ? 190 : CARD_MIN_W, cardH = tiles ? 150 : CARD_H
  const perRow = cards ? Math.max(1, Math.floor((vp.w - 24) / cardW)) : 1
  const rh = cards ? cardH + 12 : ROW_H
  const lines = Math.ceil(rows.length / perRow)
  const first = Math.max(0, Math.floor((vp.top - (cards ? 0 : 42)) / rh) - 6)
  const last = Math.min(lines, Math.ceil((vp.top + vp.h) / rh) + 6)

  // near the end -> ask the engine for the next page
  useEffect(() => { if (engine.mode === 'server' && last >= lines - 8) engine.loadMore() }, [version, last, lines, engine])

  const widths = cols.map((f) => p.widths[f.internal] ?? defaultWidth(f))
  const act = p.onMenu ? 48 : 0
  const tpl = `44px ${widths.map((w) => `${w}px`).join(' ')}${act ? ` ${act}px` : ''}`
  const totalW = 44 + act + widths.reduce((a, b) => a + b, 0)

  const visibleRows = useMemo(() => {
    const out: { r: Row; i: number }[] = []
    for (let l = first; l < last; l++) for (let c = 0; c < perRow; c++) { const i = l * perRow + c; if (i < rows.length) out.push({ r: rows[i], i }) }
    return out
  }, [first, last, perRow, rows, version]) // eslint-disable-line react-hooks/exhaustive-deps

  const scrollTo = (i: number) => {
    const el = ref.current; if (!el) return
    const y = (cards ? Math.floor(i / perRow) : i) * rh + (cards ? 0 : 42)
    if (y < el.scrollTop + (cards ? 0 : 42)) el.scrollTop = y - (cards ? 0 : 42)
    else if (y + rh > el.scrollTop + el.clientHeight) el.scrollTop = y + rh - el.clientHeight
  }
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'checkbox') return
    const n = rows.length; if (!n) return
    const page = Math.max(1, Math.floor(vp.h / rh) - 1) * perRow
    let a = active
    switch (e.key) {
      case 'ArrowDown': a = Math.min(n - 1, a + perRow); break
      case 'ArrowUp': a = Math.max(0, a - perRow); break
      case 'ArrowRight': if (cards) a = Math.min(n - 1, a + 1); else return; break
      case 'ArrowLeft': if (cards) a = Math.max(0, a - 1); else return; break
      case 'PageDown': a = Math.min(n - 1, a + page); break
      case 'PageUp': a = Math.max(0, a - page); break
      case 'Home': a = 0; break
      case 'End': a = n - 1; break
      case 'Enter': e.preventDefault(); if (rows[a]) p.onOpen(rows[a]); return
      case ' ': if ((e.target as HTMLElement).tagName === 'INPUT') return; e.preventDefault(); if (rows[a]) p.onToggle(rows[a].__id); return
      default: return
    }
    e.preventDefault(); setActive(a); scrollTo(a)
  }
  useEffect(() => { setActive(0); if (ref.current) ref.current.scrollTop = 0 }, [engine.q, engine.src.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const titleF = cols[0]
  const allSel = rows.length > 0 && rows.every((r) => p.selected.has(r.__id))
  const cardFields = cols.slice(1, 5)

  const startResize = (f: SpField, e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault()
    const x0 = e.clientX, w0 = p.widths[f.internal] ?? defaultWidth(f)
    const move = (ev: PointerEvent) => p.setWidth(f.internal, Math.max(70, w0 + ev.clientX - x0))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  const sortOf = engine.q.sort
  return (
    <div className="gridwrap">
      {engine.loading && <div className="bar-progress" role="progressbar" aria-label="Loading"><i className={engine.mode === 'server' || engine.progress === 0 ? 'indet' : ''} style={{ width: engine.mode === 'local' && engine.progress ? `${engine.progress * 100}%` : undefined }} /></div>}
      <div ref={ref} className="grid" role="grid" tabIndex={0} aria-label="Items" aria-rowcount={Math.max(engine.total, rows.length) + 1} aria-colcount={cols.length + 1}
        aria-activedescendant={rows.length ? `row-${active}` : undefined} aria-multiselectable="true" onScroll={onScroll} onKeyDown={onKey}>
        {!cards && (
          <div role="row" className="g-head" style={{ gridTemplateColumns: tpl, width: totalW }}>
            <div role="columnheader" className="g-h" style={{ justifyContent: 'center' }}>
              <input type="checkbox" checked={allSel} onChange={p.onToggleAll} aria-label="Select all loaded rows" />
            </div>
            {cols.map((f) => {
              const sorted = sortOf.field === f.internal
              return (
                <div key={f.internal} role="columnheader" className="g-hc" aria-sort={sorted ? (sortOf.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button className={`g-h${f.sortable || f.internal === 'ID' ? ' sortable' : ''}`}
                    disabled={!(f.sortable || f.internal === 'ID')} onClick={() => p.onSort(f.internal)} title={f.sortable ? `Sort by ${f.title}` : f.title}>
                    <span className="t">{f.title}</span>
                    {sorted && <Icon n={sortOf.dir === 'asc' ? 'up' : 'down'} size={13} />}
                  </button>
                  <span className="rs" onPointerDown={(e) => startResize(f, e)} role="separator" aria-orientation="vertical" aria-label={`Resize ${f.title}`} />
                </div>
              )
            })}
            {act > 0 && <div role="columnheader" className="g-h"><span className="sr-only">Actions</span></div>}
          </div>
        )}
        <div className="g-body" style={{ height: lines * rh + (engine.hasMore || engine.loading ? 48 : 0), width: cards ? undefined : totalW }}>
          {!cards && visibleRows.map(({ r, i }) => (
            <GridRow key={r.__id} row={r} idx={i} cols={cols} tpl={tpl} width={totalW} selected={p.selected.has(r.__id)} active={i === active} tokens={p.tokens} onOpen={p.onOpen} onToggle={p.onToggle} onMenu={p.onMenu} />
          ))}
          {cards && visibleRows.map(({ r, i }) => {
            const line = Math.floor(i / perRow), col = i % perRow
            const style: CSSProperties = { position: 'absolute', top: line * rh + 12, left: `calc(12px + ${col} * ((100% - 24px + 12px) / ${perRow}))`, width: `calc((100% - 24px - ${(perRow - 1) * 12}px) / ${perRow})`, height: cardH }
            return (
              tiles ? (
              <button key={r.__id} id={`row-${i}`} className={`ptile${i === active ? ' active' : ''}${r.__new ? ' fresh' : ''}`} style={style} onClick={() => p.onOpen(r)} onContextMenu={(e) => { if (p.onMenu) { e.preventDefault(); p.onMenu(r, new DOMRect(e.clientX, e.clientY, 0, 0)) } }} aria-label={cellText(titleF, r) || `Item ${r.__id}`}>
                <span className="tile-art"><FileGlyph name={String(r.FileLeafRef ?? '')} folder={r.FSObjType === 1} size={r.FSObjType === 1 ? 64 : 56} thumb={p.origin && r.FileRef ? `${p.origin}/_layouts/15/getpreview.ashx?path=${encodeURIComponent(new URL(p.origin).origin + String(r.FileRef).split('/').map(encodeURIComponent).join('/'))}&resolution=1` : undefined} /></span>
                <b className="tile-name">{String(r.FileLeafRef ?? cellText(titleF, r))}</b>
                <span className="muted small">{r.FSObjType === 1 ? 'Folder' : `${extOf(String(r.FileLeafRef ?? '')).toUpperCase() || 'File'} · ${bytes(Number(r.File_x0020_Size))}`}</span>
              </button>
              ) :
              <button key={r.__id} id={`row-${i}`} className={`pcard${i === active ? ' active' : ''}${r.__new ? ' fresh' : ''}`} style={style} onClick={() => p.onOpen(r)} onContextMenu={(e) => { if (p.onMenu) { e.preventDefault(); p.onMenu(r, new DOMRect(e.clientX, e.clientY, 0, 0)) } }} aria-label={cellText(titleF, r) || `Item ${r.__id}`}>
                <h3>{titleF && <CellView f={{ ...titleF, kind: 'text' }} row={r} tokens={p.tokens} />}</h3>
                <dl>{cardFields.map((f) => <Fragment key={f.internal}><dt>{f.title}</dt><dd><CellView f={f} row={r} tokens={p.tokens} /></dd></Fragment>)}</dl>
              </button>
            )
          })}
          {rows.length === 0 && !engine.loading && !engine.error && (
            <div className="empty" style={{ position: 'absolute', inset: 0 }}><Icon n="search" size={36} /><b>No items match</b><span className="muted">Try a different search or clear the filters.</span></div>
          )}
          {(engine.hasMore || engine.loading) && rows.length > 0 && <div className="g-load" style={{ top: lines * rh }} aria-hidden="true">Loading more… ({fmt(rows.length)} loaded)</div>}
        </div>
      </div>
    </div>
  )
}
