import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from './ui'

export interface Cmd { id: string; label: string; hint?: string; icon: IconName; run: () => void }

export function Palette({ cmds, onClose }: { cmds: Cmd[]; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  const list = useMemo(() => {
    const t = q.toLowerCase().split(/\s+/).filter(Boolean)
    return cmds.filter((c) => t.every((w) => (c.label + ' ' + (c.hint ?? '')).toLowerCase().includes(w))).slice(0, 40)
  }, [q, cmds])
  useEffect(() => setSel(0), [q])
  const run = (c?: Cmd) => { if (c) { onClose(); setTimeout(c.run, 0) } }
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal palette" role="dialog" aria-modal="true" aria-label="Command palette"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(list.length - 1, s + 1)) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
          if (e.key === 'Enter') { e.preventDefault(); run(list[sel]) }
        }}>
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a command…  (switch list, export, theme, deep scan…)" role="combobox" aria-expanded="true" aria-controls="cmd-list" aria-activedescendant={list[sel] ? `cmd-${list[sel].id}` : undefined} aria-label="Command" />
        <ul id="cmd-list" role="listbox">
          {list.map((c, i) => (
            <li key={c.id} id={`cmd-${c.id}`} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => run(c)}>
              <Icon n={c.icon} /><span style={{ flex: 1 }}>{c.label}</span>{c.hint && <span className="muted small">{c.hint}</span>}
            </li>
          ))}
          {!list.length && <li className="muted" role="option" aria-selected="false">No matching command</li>}
        </ul>
      </div>
    </div>
  )
}
