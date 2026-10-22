import type { Backend } from '../types'
import { demo } from './demo'

export interface Chosen { backend?: Backend; error?: string }

const isLocalHost = () => /^(localhost|127\.0\.0\.1|\[::1\]|)$/.test(location.hostname)
const withTimeout = <T,>(p: Promise<T>, ms: number, what: string) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} did not answer within ${ms / 1000} s`)), ms))])

/**
 * Inside Power Apps the app must be LIVE: if it cannot reach SharePoint it says exactly why (see Diagnostics) and never
 * quietly shows sample data. The demo tenant is used only on a developer machine (localhost / no connector) or with ?demo=1.
 */
export async function chooseBackend(): Promise<Chosen> {
  if (/[?&]demo=1/.test(location.search)) return { backend: demo }
  let live: typeof import('./sp')
  try { live = await import('./sp') } catch (e) {
    return isLocalHost() ? { backend: demo } : { error: `The SharePoint module failed to load: ${(e as Error).message}` }
  }
  if (!live.hasSharePointConnector()) {
    return isLocalHost() ? { backend: demo } : { error: 'No SharePoint connector is compiled into this app. The deploy script must run “pac code add-data-source” before the build, so that .power/schemas/appschemas/dataSourcesInfo.ts exists.' }
  }
  try {
    const who = await withTimeout(live.sp.whoAmI(), 25_000, 'Power Apps (getContext)')
    if (!who.upn && !who.name) throw new Error('Power Apps returned no signed-in user')
    return { backend: live.sp }
  } catch (e) {
    return isLocalHost() ? { backend: demo } : { error: (e as Error).message }
  }
}
