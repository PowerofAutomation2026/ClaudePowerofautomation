/**
 * DEMO / SIMULATION data. Nothing here touches a network.
 *  - demoSource: sample rows so the dashboard can be opened without a Dataverse connection (local dev, screenshots).
 *  - simulateRows: scripted outage scenarios. They produce RAW rows and run through the SAME classification
 *    pipeline as live data, so what you see in a drill is what the real logic would publish.
 */
import catalog from '../../shared/catalog.json'
import type { RawRow } from '../logic/classify'
import type { DataSource, Snapshot, TargetRow } from './types'

export const demoTargets: TargetRow[] = catalog.targets.map((t) => ({ name: t.name, url: t.url, alive: t.alive, dependsOnAuth: t.dependsOnAuth, copilotNeeds: t.copilotNeeds, enabled: true }))

export type Scenario = 'healthy' | 'auth' | 'slow' | 'copilot' | 'exchange'
export const SCENARIOS: { id: Scenario; label: string; hint: string }[] = [
  { id: 'auth', label: 'Sign-in outage', hint: 'auth stops answering: everything that needs sign-in is at risk' },
  { id: 'exchange', label: 'Exchange down', hint: 'mail fails; Copilot is affected underneath' },
  { id: 'slow', label: 'Teams slow', hint: 'latency far above its own baseline: early warning' },
  { id: 'copilot', label: 'Copilot errors', hint: 'Copilot returns 503 while the services underneath are fine' },
  { id: 'healthy', label: 'Recover', hint: 'everything answers again; the level de-escalates slowly' },
]

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
export function demoSource(staleMinutes = 0): DataSource {
  return {
    kind: 'demo',
    async load(): Promise<Snapshot> {
      const interval = catalog.defaults.intervalMinutes
      const end = Date.now() - staleMinutes * 60_000 - 20_000
      return {
        targets: demoTargets,
        rows: simulateRows(demoTargets.map((t) => t.name), 24, end, interval * 60_000, () => 'healthy'),
        settings: { interval_minutes: String(interval), retention_days: String(catalog.defaults.retentionDays), heartbeat_configured: 'no', roles_json: JSON.stringify(catalog.roles) },
      }
    },
  }
}
