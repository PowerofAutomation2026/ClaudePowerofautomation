import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'

const P: Record<string, string> = {
  search: 'M11 4a7 7 0 1 0 4.2 12.6l4.1 4.1 1.4-1.4-4.1-4.1A7 7 0 0 0 11 4Zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z',
  x: 'M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6Z',
  list: 'M4 6h2v2H4V6Zm4 0h12v2H8V6ZM4 11h2v2H4v-2Zm4 0h12v2H8v-2ZM4 16h2v2H4v-2Zm4 0h12v2H8v-2Z',
  lib: 'M4 4h6l2 2h8v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v12h16V8h-8.8l-2-2H4Z',
  chart: 'M4 20V4h2v14h14v2H4Zm4-4V9h3v7H8Zm5 0V5h3v11h-3Zm5 0v-5h3v5h-3Z',
  table: 'M3 4h18v16H3V4Zm2 2v3h14V6H5Zm0 5v3h4v-3H5Zm6 0v3h8v-3h-8Zm-6 5v2h4v-2H5Zm6 0v2h8v-2h-8Z',
  plug: 'M8 2h2v5h4V2h2v5h2v4a6 6 0 0 1-5 5.9V22h-2v-5.1A6 6 0 0 1 6 11V7h2V2Z',
  sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM11 1h2v3h-2V1Zm0 19h2v3h-2v-3ZM1 11h3v2H1v-2Zm19 0h3v2h-3v-2ZM4.2 5.6l1.4-1.4 2.1 2.1-1.4 1.4-2.1-2.1Zm12.1 12.1 1.4-1.4 2.1 2.1-1.4 1.4-2.1-2.1ZM5.6 19.8l-1.4-1.4 2.1-2.1 1.4 1.4-2.1 2.1ZM17.7 7.7l-1.4-1.4 2.1-2.1 1.4 1.4-2.1 2.1Z',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z',
  contrast: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 2v14a7 7 0 0 1 0-14Z',
  download: 'M11 3h2v9.2l3.3-3.3 1.4 1.4L12 16 6.3 10.3l1.4-1.4 3.3 3.3V3ZM5 18h14v2H5v-2Z',
  filter: 'M3 5h18l-7 8.5V20l-4-2v-4.5L3 5Z',
  cols: 'M3 4h5v16H3V4Zm7 0h4v16h-4V4Zm6 0h5v16h-5V4Z',
  refresh: 'M12 4a8 8 0 0 1 7.5 5.2l1.9-.7-.5 5.2-4.8-2 1.6-.6A6 6 0 1 0 18 12h2a8 8 0 1 1-8-8Z',
  cmd: 'M7 3a4 4 0 0 0 0 8h2v2H7a4 4 0 1 0 4 4v-2h2v2a4 4 0 1 0 4-4h-2v-2h2a4 4 0 1 0-4-4v2h-2V7a4 4 0 0 0-4-4Zm4 8h2v2h-2v-2Z',
  bolt: 'M13 2 4 14h6l-1 8 9-12h-6l1-8Z',
  grid: 'M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z',
  cards: 'M3 5h8v6H3V5Zm10 0h8v6h-8V5ZM3 13h8v6H3v-6Zm10 0h8v6h-8v-6Z',
  lock: 'M7 10V7a5 5 0 0 1 10 0v3h2v11H5V10h2Zm2 0h6V7a3 3 0 0 0-6 0v3Z',
  check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z',
  ext: 'M14 3h7v7h-2V6.4l-8.3 8.3-1.4-1.4L17.6 5H14V3ZM5 5h6v2H7v10h10v-4h2v6H5V5Z',
  copy: 'M8 3h12v14H8V3Zm2 2v10h8V5h-8ZM4 7h2v12h10v2H4V7Z',
  star: 'M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5-5.9-3.2-5.9 3.2 1.2-6.5L2.5 9.4l6.6-.9L12 2.5Z',
  pause: 'M6 5h4v14H6V5Zm8 0h4v14h-4V5Z',
  play: 'M7 4v16l13-8L7 4Z',
  up: 'M12 5 5 13h4v6h6v-6h4l-7-8Z',
  down: 'M12 19l7-8h-4V5H9v6H5l7 8Z',
  chevL: 'M15 5 8 12l7 7 1.4-1.4L10.8 12l5.6-5.6L15 5Z',
  chevR: 'M9 5l7 7-7 7-1.4-1.4L13.2 12 7.6 6.4 9 5Z',
  file: 'M6 2h8l6 6v14H6V2Zm7 1.5V9h5.5L13 3.5Z',
  trash: 'M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z',
  info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1 5h2v2h-2V7Zm0 4h2v6h-2v-6Z',
  scan: 'M3 7V3h4v2H5v2H3Zm14-4h4v4h-2V5h-2V3ZM3 17h2v2h2v2H3v-4Zm16 0h2v4h-4v-2h2v-2ZM6 11h12v2H6v-2Z',
  sparkle: 'M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2Zm7 11 .9 2.6 2.6.9-2.6.9L19 20l-.9-2.6-2.6-.9 2.6-.9.9-2.6Z',
  text: 'M5 4h14v4h-2V6h-4v12h2v2H9v-2h2V6H7v2H5V4Z',
}
export type IconName = keyof typeof P
export const Icon = ({ n, size = 18 }: { n: IconName; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d={P[n]} /></svg>
)

/* ---------------------------------------------------------------- toasts */
export interface Toast { id: number; level: 'info' | 'good' | 'warn' | 'bad'; text: string }
const ToastCtx = createContext<(level: Toast['level'], text: string) => void>(() => {})
export const useToast = () => useContext(ToastCtx)
export function Toaster({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([])
  const push = useCallback((level: Toast['level'], text: string) => {
    const id = Math.random()
    setList((l) => [...l.slice(-3), { id, level, text }])
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), level === 'bad' ? 9000 : 4500)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite" aria-atomic="false">
        {list.map((t) => <div key={t.id} className={`toast ${t.level}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  )
}

/* ---------------------------------------------------------------- menu */
export function Menu({ label, icon, children, align = 'right', wide, pressed }: { label: ReactNode; icon?: IconName; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; wide?: boolean; pressed?: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); (ref.current?.querySelector('button.trigger') as HTMLElement)?.focus() } }
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [open])
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="btn trigger" aria-haspopup="true" aria-expanded={open} aria-controls={id} aria-pressed={pressed} onClick={() => setOpen(!open)}>
        {icon && <Icon n={icon} />}{label}
      </button>
      {open && <div id={id} className={`menu ${align === 'left' ? 'left' : ''}`} style={wide ? { minWidth: 320 } : undefined}>{children(() => setOpen(false))}</div>}
    </div>
  )
}

/* ---------------------------------------------------------------- modal with focus trap */
export function Modal({ title, onClose, children, className = '', side }: { title: string; onClose: () => void; children: ReactNode; className?: string; side?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const prev = useRef<Element | null>(null)
  useEffect(() => {
    prev.current = document.activeElement
    const el = ref.current
    const focusables = () => Array.from(el?.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])') ?? []).filter((x) => !x.hasAttribute('disabled'))
    ;(focusables()[0] ?? el)?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      if (e.key === 'Tab') {
        const f = focusables(); if (!f.length) return
        const first = f[0], last = f[f.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); (prev.current as HTMLElement | null)?.focus?.() }
  }, [onClose])
  const dialog = <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className={side ? `drawer ${className}` : `modal ${className}`}>{children}</div>
  return side ? <><div className="scrim" style={{ background: 'rgba(5,10,25,.35)', zIndex: 85 }} onMouseDown={onClose} />{dialog}</> : <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>{dialog}</div>
}

export function Counter({ value }: { value: number }) {
  const [v, setV] = useState(value)
  const from = useRef(value)
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setV(value); return }
    const a = from.current, t0 = performance.now(); let raf = 0
    const tick = (t: number) => { const p = Math.min(1, (t - t0) / 700); setV(Math.round(a + (value - a) * (1 - Math.pow(1 - p, 3)))); if (p < 1) raf = requestAnimationFrame(tick); else from.current = value }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <>{v.toLocaleString()}</>
}

export const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)']
export const hashColor = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return COLORS[h % COLORS.length] }
export const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]?.toUpperCase()).join('')
