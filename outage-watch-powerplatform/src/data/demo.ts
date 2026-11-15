/**
 * DEMO / SIMULATION data. Nothing here touches a network.
 *  - demoSource: sample rows so the dashboard can be opened without a Dataverse connection (local dev, screenshots).
 *  - simulateRows: scripted outage scenarios. They produce RAW rows and run through the SAME classification
 *    pipeline as live data, so what you see in a drill is what the real logic would publish.
 */
import catalog from '../../shared/catalog.json'
import type { RawRow } from '../logic/classify'
import type { DataSource, Snapshot, TargetRow } from './types'

/** 34 fixed services + the two tenant-specific ones, which are "unconfigured" unless a tenant name is given. */
export function demoTargetList(tenant: string | null): TargetRow[] {
  const fixed: TargetRow[] = catalog.targets.map((t) => ({ name: t.name, url: t.url, alive: t.alive, dependsOnAuth: t.dependsOnAuth, copilotNeeds: t.copilotNeeds, family: t.family, enabled: true }))
  const ten: TargetRow[] = catalog.tenantTargets.map((t) => ({
    name: t.name, url: tenant ? t.urlTemplate.replace('{tenant}', tenant) : '', alive: t.alive, dependsOnAuth: t.dependsOnAuth, copilotNeeds: t.copilotNeeds,
    family: t.family, enabled: !!tenant, unconfigured: !tenant,
  }))
  return [...fixed, ...ten]
}
export const demoTargets: TargetRow[] = demoTargetList(null)
/** Names that are actually probed (enabled and set up). */
export const probed = (targets: TargetRow[]) => targets.filter((t) => t.enabled && !t.unconfigured).map((t) => t.name)

export type Scenario = 'healthy' | 'auth' | 'slow' | 'copilot' | 'exchange' | 'mixed'
export const SCENARIOS: { id: Scenario; label: string; hint: string }[] = [
  { id: 'auth', label: 'Sign-in outage', hint: 'auth stops answering: everything that needs sign-in is at risk' },
  { id: 'exchange', label: 'Exchange down', hint: 'mail fails; Copilot is affected underneath' },
  { id: 'slow', label: 'Teams slow', hint: 'latency far above its own baseline: early warning' },
  { id: 'copilot', label: 'Copilot errors', hint: 'Copilot returns 503 while the services underneath are fine' },
  { id: 'mixed', label: 'Several at once', hint: 'Power BI down, Purview failing, Teams CDN slow: problems in three families' },
  { id: 'healthy', label: 'Recover', hint: 'everything answers again; the level de-escalates slowly' },
]

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')

/** Small deterministic jitter (no Math.random: screenshots and tests are reproducible). */
function jitter(name: string, i: number): number {
  let h = 2166136261
  for (const ch of name + ':' + i) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) }
  return ((h >>> 0) % 41) - 20
}
const BASE: Record<string, number> = { auth: 140, exchange: 210, teams: 180, graph: 120, 'office-cdn': 60 }

export function sampleRow(name: string, i: number, atMs: number, scenario: Scenario): RawRow {
  const at = new Date(atMs).toISOString()
  let ms = (BASE[name] ?? 160) + jitter(name, i)
  let httpStatus: number | null = 200
  let errorKind = ''
  if (scenario === 'auth' && name === 'auth') { httpStatus = null; ms = 10000; errorKind = 'ActionTimedOut' }
  if (scenario === 'exchange' && name === 'exchange') { httpStatus = 503; errorKind = 'ServiceUnavailable' }
  if (scenario === 'slow' && name === 'teams') ms = 2400 + jitter(name, i) * 10
  if (scenario === 'copilot' && name === 'm365-copilot') { httpStatus = 503; errorKind = 'ServiceUnavailable' }
  if (scenario === 'mixed' && (name === 'power-bi' || name === 'purview')) { httpStatus = 503; errorKind = 'ServiceUnavailable' }
  if (scenario === 'mixed' && name === 'teams-cdn') ms = 2600
  return { name, httpStatus, elapsedMs: ms, errorKind, at, round: at }
}

/** `rounds` rounds ending at `endMs`, spaced by `stepMs`; `scenarioAt(i)` picks the scenario of round i. */
export function simulateRows(names: string[], rounds: number, endMs: number, stepMs: number, scenarioAt: (i: number) => Scenario): RawRow[] {
  const rows: RawRow[] = []
  for (let i = 0; i < rounds; i++) {
    const at = endMs - (rounds - 1 - i) * stepMs
    for (const n of names) rows.push(sampleRow(n, i, at, scenarioAt(i)))
  }
  return rows
}

/** Demo source. `staleMinutes` makes the newest row that old (to show the STALE banner). */
/** `alerts`: 'on' = channels configured with sample deliveries and incidents, 'off' = not configured (the default). */
export function demoSource(staleMinutes = 0, tenant: string | null = null, alerts: 'on' | 'off' = 'off'): DataSource {
  const targets = demoTargetList(tenant)
  return {
    kind: 'demo',
    async load(): Promise<Snapshot> {
      const interval = catalog.defaults.intervalMinutes
      const end = Date.now() - staleMinutes * 60_000 - 20_000
      return {
        targets,
        rows: simulateRows(probed(targets), 24, end, interval * 60_000, () => 'healthy'),
        settings: {
          interval_minutes: String(interval), retention_days: String(catalog.defaults.retentionDays), heartbeat_configured: 'no',
          ...(alerts === 'on' ? {
            alert_configured: 'yes', alert_channels: 'teams,slack,webex', alert_channel_name: 'Ops Alerts', alert_enabled: 'yes', alert_snooze_until: '', alert_channels_off: '',
            last_alert_at: iso(end - 95 * 60_000), last_delivery_teams: 'ok ' + iso(end - 95 * 60_000), last_delivery_slack: 'ok ' + iso(end - 95 * 60_000),
            last_delivery_webex: 'FAILED ' + iso(end - 95 * 60_000) + ' HTTP 404 NotFound',
            ci_status: JSON.stringify({ level: 'ok', since: iso(end - 95 * 60_000), updated: iso(end), round: iso(end), failing: 0, confirmed: 0, services: '' }),
          } : { alert_configured: 'no' }),
        },
        incidents: alerts === 'on' ? [
          { name: 'exchange', family: 'Exchange', open: false, openedAt: iso(end - 175 * 60_000), closedAt: iso(end - 95 * 60_000), minutes: 80, rounds: 8, reminders: 1, error: 'HTTP 503 - ServiceUnavailable <html><body>Service Unavailable - upstream connect error</body></html>' },
          { name: 'power-bi', family: 'Power Platform & dashboards', open: false, openedAt: iso(end - 26 * 3_600_000), closedAt: iso(end - 25.5 * 3_600_000), minutes: 30, rounds: 3, reminders: 0, error: 'no HTTP answer - ActionTimedOut The execution of template action timed out.' },
        ] : [],
      }
    },
  }
}
