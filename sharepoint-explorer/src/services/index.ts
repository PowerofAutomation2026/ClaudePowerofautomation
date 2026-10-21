import type { Backend } from '../types'
import { demo } from './demo'

/** Live mode needs the Power Apps host + the SharePoint connector; anywhere else (npm run dev) the demo tenant is used. */
export async function chooseBackend(): Promise<Backend> {
  const forceDemo = /[?&]demo=1/.test(location.search)
  if (!forceDemo) {
    try {
      const live = await import('./sp')
      if (live.hasSharePointConnector()) {
        const who = await Promise.race([live.sp.whoAmI(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000))])
        if (who.upn || who.name) return live.sp
      }
    } catch { /* not hosted in Power Apps */ }
  }
  return demo
}
