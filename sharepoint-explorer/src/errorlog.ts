/** A small on-device error log + a "white page" guard. Nothing is sent anywhere. */
import { embedded, softReset } from './reset'
const KEY = 'spx.errors'
export interface LoggedError { at: string; kind: string; msg: string; stack?: string }

export function readErrors(): LoggedError[] { try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') } catch { return [] } }
export function clearErrors() { try { localStorage.removeItem(KEY) } catch { /* ignore */ } }
export function logError(kind: string, e: unknown) {
  const err = e as { message?: string; stack?: string } | string | undefined
  const msg = typeof err === 'string' ? err : String(err?.message ?? err ?? 'unknown')
  try { const list = readErrors(); list.unshift({ at: new Date().toISOString(), kind, msg: msg.slice(0, 400), stack: typeof err === 'object' ? String(err?.stack ?? '').slice(0, 1200) : undefined }); localStorage.setItem(KEY, JSON.stringify(list.slice(0, 20))) } catch { /* storage blocked */ }
}

let installed = false
export function installErrorHandlers() {
  if (installed) return; installed = true
  addEventListener('error', (e) => logError('error', e.error ?? e.message))
  addEventListener('unhandledrejection', (e) => logError('promise', (e as PromiseRejectionEvent).reason))
  // blank-page guard: if the React root is empty for ~6 s the user gets a visible way back instead of a white page
  let blank = 0
  setInterval(() => {
    const root = document.getElementById('root'); if (!root) return
    const empty = !root.firstElementChild || !(root.textContent ?? '').trim()
    blank = empty ? blank + 1 : 0
    const existing = document.getElementById('spx-blank')
    if (blank >= 3 && !existing) {
      const last = readErrors()[0]
      const d = document.createElement('div'); d.id = 'spx-blank'; d.setAttribute('role', 'alert')
      d.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;background:#0b1530;color:#fff;font:16px system-ui,sans-serif;z-index:99999;padding:24px;text-align:center'
      d.innerHTML = '<div style="max-width:560px"><h2 style="margin:0 0 8px">The app view went blank</h2><p style="opacity:.85">Your data is safe. Reload to continue.' + (last ? '</p><p style="opacity:.7;font-size:13px;overflow-wrap:anywhere">Last error: ' + last.msg.replace(/[<>&]/g, '') + '</p><p>' : ' ') + '<button id="spx-reload" style="padding:10px 18px;border-radius:10px;border:0;background:#f58220;color:#fff;font-weight:700;cursor:pointer">Reload</button></p></div>'
      document.body.appendChild(d); document.getElementById('spx-reload')?.addEventListener('click', () => { d.remove(); softReset(); setTimeout(() => { if (!(document.getElementById('root')?.textContent ?? '').trim() && !embedded()) location.reload() }, 2500) })
    }
    if (!empty && existing) existing.remove()
  }, 2000)
}
