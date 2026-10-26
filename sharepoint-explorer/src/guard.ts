import { useSyncExternalStore } from 'react'

/**
 * Production safety nets. Nothing here changes what the app does while it is healthy; it only stops runaway work:
 *  - request circuit breaker: more than MAX_PER_MIN SharePoint calls in a minute pauses further calls for a cool-down;
 *  - heap watchdog: when the JS heap gets close to the browser's limit, caches are dropped and background work stops;
 *  - safe mode: if the previous session of THIS tab ended without a clean unload (tab crash / out of memory), the next one starts with background features off.
 */
export interface GuardState { tripped: boolean; reason: '' | 'requests' | 'memory'; msg: string; safe: boolean }
let state: GuardState = { tripped: false, reason: '', msg: '', safe: false }
let trippedAt = 0
const subs = new Set<() => void>()
const dropHooks = new Set<() => void>()
const emit = () => { state = { ...state }; subs.forEach((f) => f()) }

export class GuardError extends Error { constructor(m: string) { super(m); this.name = 'GuardError' } }

const MAX_PER_MIN = 400
const COOLDOWN_MS = 30_000
const HEAP_LIMIT = 700_000_000   // bytes of used JS heap (Chrome): hard stop; the browser kills a tab around 2-4 GB
const HEAP_SOFT = 420_000_000    // soft: forget caches quietly
const times: number[] = []

export const getGuard = () => state
export const backgroundAllowed = () => !state.tripped && !state.safe && !document.hidden
export const onGuardDrop = (f: () => void) => { dropHooks.add(f); return () => { dropHooks.delete(f) } }

function trip(reason: GuardState['reason'], msg: string) {
  if (state.tripped) return
  trippedAt = Date.now(); state = { ...state, tripped: true, reason, msg }
  dropHooks.forEach((f) => { try { f() } catch { /* best effort */ } })
  emit()
}
export function resume() { times.length = 0; state = { ...state, tripped: false, reason: '', msg: '', safe: false }; try { localStorage.removeItem('spx.safe') } catch { /* ignore */ } emit() }

/** call before every SharePoint request */
export function guardRequest() {
  const now = Date.now()
  if (state.tripped) {
    if (state.reason === 'requests' && now - trippedAt > COOLDOWN_MS) resume()
    else throw new GuardError(state.msg)
  }
  times.push(now); while (times.length && times[0] < now - 60_000) times.shift()
  if (times.length > MAX_PER_MIN) { trip('requests', `The app paused for a moment: it was sending too many requests to SharePoint (${times.length} in a minute). Nothing is wrong with your data. It resumes by itself in 30 seconds.`); throw new GuardError(state.msg) }
}

let started = false
export function startGuard() {
  if (started) return; started = true
  // heap watchdog (performance.memory exists in Chromium browsers only)
  setInterval(() => {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    if (m && m.usedJSHeapSize > HEAP_SOFT && m.usedJSHeapSize <= HEAP_LIMIT) dropHooks.forEach((f) => { try { f() } catch { /* best effort */ } })
    if (m && m.usedJSHeapSize > HEAP_LIMIT) trip('memory', 'The app is using a lot of browser memory, so background updates were stopped and caches cleared to keep it from crashing. Reload the page to continue.')
  }, 5000)
  // crash detection: a heartbeat per tab that is removed on a clean unload
  try {
    let id = sessionStorage.getItem('spx.tab'); if (!id) { id = Math.random().toString(36).slice(2); sessionStorage.setItem('spx.tab', id) }
    const key = `spx.alive.${id}`
    const prev = Number(localStorage.getItem(key) ?? 0)
    if (prev && Date.now() - prev < 90_000) { state = { ...state, safe: true }; localStorage.setItem('spx.safe', String(Date.now())) }
    const beat = () => localStorage.setItem(key, String(Date.now()))
    beat(); setInterval(beat, 5000)
    const clean = () => { try { localStorage.removeItem(key) } catch { /* ignore */ } }
    addEventListener('pagehide', clean); addEventListener('beforeunload', clean)
    // opening many tabs would leave stale keys: drop the ones older than a day
    for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k?.startsWith('spx.alive.') && Date.now() - Number(localStorage.getItem(k)) > 86_400_000) localStorage.removeItem(k) }
  } catch { /* storage blocked: no crash detection */ }
}

export function useGuard(): GuardState {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb) } }, getGuard, getGuard)
}
