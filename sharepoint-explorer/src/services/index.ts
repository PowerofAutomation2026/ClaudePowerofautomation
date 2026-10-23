import type { Backend } from '../types'
import { demo } from './demo'

export interface Chosen { backend?: Backend; error?: string }

const embedded = () => { try { return window.self !== window.top } catch { return true } }   // Power Apps hosts the app in an iframe
const isLocalHost = () => !embedded() && /^(localhost|127\.0\.0\.1|\[::1\]|)$/.test(location.hostname)
const withTimeout = <T,>(p: Promise<T>, ms: number, what: string) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} did not answer within ${ms / 1000} s`)), ms))])

/**
 * Inside Power Apps the app must be LIVE: if it cannot reach SharePoint it says exactly why (see Diagnostics) and never
 * quietly shows sample data. The demo tenant is used only on a developer machine (localhost / no connector) or with ?demo=1.
 */
export async function chooseBackend(): Promise<Chosen> {
  if (/[?&]demo=1/.test(location.search) && !embedded()) return { backend: demo }   // never inside Power Apps: a stray ?demo=1 must not turn a live app into sample data
  let live: typeof import('./sp')
  try { live = await import('./sp') } catch (e) {
    return isLocalHost() ? { backend: demo } : { error: `The SharePoint module failed to load: ${(e as Error).message}` }
  }
  if (!live.hasSharePointConnector()) {
    return isLocalHost() ? { backend: demo } : { error: live.compiledSources().length ? `This build contains the data source(s) ${live.compiledSources().join(', ')} but no SharePoint connection. It was dropped when a second connector was added at deploy time (pac regenerates the schema on every add). Run Deploy.cmd again — it now registers SharePoint last and checks the result — or, in the project folder, run: pac code add-data-source -a shared_sharepointonline -c <sharepoint connection id> -d <site url> -t <existing list>, then npm run build and pac code push.` : 'No SharePoint connector is compiled into this app. The deploy script must run “pac code add-data-source” before the build, so that .power/schemas/appschemas/dataSourcesInfo.ts exists.' }
  }
  try {
    const who = await withTimeout(live.sp.whoAmI(), 60_000, 'Power Apps (getContext)')
    if (!who.upn && !who.name) throw new Error('Power Apps returned no signed-in user')
    return { backend: live.sp }
  } catch (e) {
    return isLocalHost() ? { backend: demo } : { error: (e as Error).message }
  }
}
