/** Mail helpers that work inside the Power Apps player iframe: ordinary pop-ups and the clipboard (no downloads, no protocol navigation, no retired SharePoint mail API). */
export interface Msg { to: string[]; subject: string; text: string; html?: string }

export async function copyMessage(m: Msg): Promise<void> {
  const text = `To: ${m.to.join(', ')}\nSubject: ${m.subject}\n\n${m.text}`
  const html = m.html ?? `<div>${m.text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!).replace(/\n/g, '<br>')}</div>`
  try { await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]); return } catch { /* fall through */ }
  try { await navigator.clipboard.writeText(text); return } catch { /* fall through */ }
  const d = document.createElement('div'); d.contentEditable = 'true'; d.style.cssText = 'position:fixed;opacity:0'; d.innerHTML = html; document.body.appendChild(d)
  const s = getSelection()!, rg = document.createRange(); rg.selectNodeContents(d); s.removeAllRanges(); s.addRange(rg); document.execCommand('copy'); s.removeAllRanges(); d.remove()
}

/** window.open with the 'noopener' feature always returns null, which looks like a blocked pop-up: open normally, then cut the link to the opener */
export function openTab(url: string): boolean { const w = window.open(url, '_blank'); if (!w) return false; try { w.opener = null } catch { /* cross-origin */ } return true }
/** clipboard that also works where the Power Apps frame has no clipboard-write permission */
export async function copyText(t: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(t); return true } catch { /* fall through */ }
  try { const ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok } catch { return false }
}

const LIMIT = 1500
/** Outlook on the web compose window, prefilled. Returns what happened so the caller can tell the user. */
export function openOutlookWeb(m: Msg): 'opened' | 'truncated' | 'blocked' {
  const cut = m.text.length > LIMIT
  const u = `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(m.to.join(';'))}&subject=${encodeURIComponent(m.subject)}&body=${encodeURIComponent(cut ? m.text.slice(0, LIMIT) + '\n…' : m.text)}`
  return openTab(u) ? (cut ? 'truncated' : 'opened') : 'blocked'
}
export function openMailApp(m: Msg): boolean {
  return openTab(`mailto:${encodeURIComponent(m.to.join(','))}?subject=${encodeURIComponent(m.subject)}&body=${encodeURIComponent(m.text.slice(0, 1800))}`)
}
export const validAddr = (a: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)
export const parseAddrs = (s: string) => s.split(/[;,\s]+/).map((x) => (/<([^>]+)>/.exec(x)?.[1] ?? x).trim()).filter(Boolean)
