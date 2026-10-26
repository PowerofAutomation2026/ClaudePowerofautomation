/** Soft reset: remount the whole React tree (no page reload — reloading an embedded Power Apps frame can leave a blank page). */
let handler: (() => void) | null = null
export const setSoftReset = (f: () => void) => { handler = f }
export const softReset = () => { if (handler) handler(); else location.reload() }
export const embedded = () => { try { return window.self !== window.top } catch { return true } }
