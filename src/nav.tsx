export type View = 'owner' | 'exposure' | 'blast' | 'egress' | 'agents'
const ITEMS: { v: View; label: string }[] = [
  { v: 'owner', label: '← Ownership Command Center' },
  { v: 'exposure', label: '🔐 Exposure Auditor' },
  { v: 'blast', label: '🕸️ Blast-Radius Map' },
  { v: 'egress', label: '📡 Egress Radar' },
  { v: 'agents', label: '🤖 Agent Guard' },
]
/** Buttons that jump to every module except the current one. */
export function NavButtons({ view, go }: { view: View; go: (v: View) => void }) {
  return <>{ITEMS.filter((i) => i.v !== view).map((i) => <button key={i.v} className="btn sm" onClick={() => go(i.v)}>{i.label}</button>)}</>
}
