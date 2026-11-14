import { describe, expect, it } from 'vitest'
import {
  BLOCKED_KINDS, Monitor, buildFrames, formatAliveCodes, groupRounds, isStale, parseAliveCodes, rawState,
  type RawRow, type TargetSpec,
} from '../src/logic/classify'

const T = (name: string, alive: number[] | null = null, dependsOnAuth = false, copilotNeeds = false): TargetSpec => ({ name, alive, dependsOnAuth, copilotNeeds })
const row = (round: number, name: string, httpStatus: number | null = 200, elapsedMs = 100, errorKind = ''): RawRow => {
  const at = new Date(Date.UTC(2026, 0, 1, 0, round * 5)).toISOString()
  return { name, httpStatus, elapsedMs, errorKind, at, round: at }
}

describe('alive codes', () => {
  it('parses and formats', () => {
    expect(parseAliveCodes('200,401, 403')).toEqual([200, 401, 403])
    expect(parseAliveCodes('')).toBeNull()
    expect(parseAliveCodes(null)).toBeNull()
    expect(parseAliveCodes('any')).toBeNull()
    expect(parseAliveCodes('<script>,200;999')).toEqual([200])
    expect(formatAliveCodes(null)).toBe('')
    expect(formatAliveCodes([200, 401])).toBe('200,401')
  })
})

describe('rawState (flow-specific cases the Python probe cannot produce)', () => {
  const r = (httpStatus: number | null, elapsedMs = 10, errorKind = '') => ({ name: 't', httpStatus, elapsedMs, errorKind })
  it('3xx is proof of life when no alive list is set (redirects are never required to be followed)', () => {
    expect(rawState(r(302), null)).toBe('up')
    expect(rawState(r(302), [200])).toBe('degraded')
  })
  it('a failed flow action WITH an HTTP answer is judged by the status, not by the action error', () => {
    expect(rawState(r(404, 10, 'NotFound'), null)).toBe('up')
    expect(rawState(r(401, 10, 'Unauthorized'), [200, 401, 403])).toBe('up')
    expect(rawState(r(502, 10, 'BadGateway'), null)).toBe('down')
  })
  it('no HTTP answer is down; slow is degraded; blocked needs an exact known kind', () => {
    expect(rawState(r(null, 10000, 'ActionTimedOut'), null)).toBe('down')
    expect(rawState(r(200, 3001), null)).toBe('degraded')
    expect(rawState(r(200, 3000), null)).toBe('up')
    for (const k of BLOCKED_KINDS) expect(rawState(r(null, 5, k), null)).toBe('blocked')
    expect(rawState(r(null, 5, 'blocked-ish'), null)).toBe('down')
  })
})

describe('buildFrames', () => {
  const targets = [T('auth', [200]), T('teams', null, true, true), T('m365-copilot', null, true), T('office-cdn')]
  const healthy = (i: number) => targets.map((t) => row(i, t.name))

  it('replays rounds oldest first regardless of row order', () => {
    const rows = [...healthy(2), ...healthy(0), ...healthy(1)]
    const f = buildFrames(rows, targets)
    expect(f).toHaveLength(3)
    expect(f.map((x) => x.t)).toEqual([...f.map((x) => x.t)].sort())
    expect(f[2].level).toBe('ok')
    expect(f[2].verdict).toBe('all healthy')
  })

  it('auth: suspect -> freeze at once, dependants at risk, confirmed down next round, slow recovery', () => {
    const rows: RawRow[] = []
    for (let i = 0; i < 6; i++) rows.push(...healthy(i))
    for (const i of [6, 7]) rows.push(row(i, 'auth', null, 10000, 'ActionTimedOut'), row(i, 'teams'), row(i, 'm365-copilot'), row(i, 'office-cdn'))
    for (let i = 8; i < 12; i++) rows.push(...healthy(i))
    const f = buildFrames(rows, targets)
    expect(f[6].services.get('auth')!.state).toBe('suspect')
    expect(f[6].level).toBe('freeze')
    expect(f[6].verdict).toContain('at risk: m365-copilot, teams')
    expect(f[6].verdict).toContain('LEVEL -> freeze')
    expect(f[7].services.get('auth')!.state).toBe('down')
    expect(f[8].services.get('auth')!.state).toBe('up')
    expect([f[8].level, f[9].level, f[10].level]).toEqual(['freeze', 'freeze', 'ok'])
  })

  it('latency: warning at > max(3x baseline, baseline + 800 ms), exposes baseline and threshold', () => {
    const rows: RawRow[] = []
    for (let i = 0; i < 6; i++) rows.push(row(i, 'teams', 200, 100))
    rows.push(row(6, 'teams', 200, 900))    // == baseline + 800: not above
    rows.push(row(7, 'teams', 200, 901))
    const f = buildFrames(rows, targets)
    expect(f[6].services.get('teams')!.state).toBe('up')
    expect(f[7].services.get('teams')!.state).toBe('warning')
    expect(f[7].services.get('teams')!.baseline).toBe(100)
    expect(f[7].services.get('teams')!.warnMs).toBe(900)
    expect(f[7].level).toBe('caution')
    expect(f[7].early).toEqual(['teams']); expect(f[6].early).toEqual([])
  })

  it('copilot note names the unhealthy service underneath', () => {
    const rows = [row(0, 'auth'), row(0, 'teams', 503), row(0, 'm365-copilot', 503), row(0, 'office-cdn')]
    expect(buildFrames(rows, targets)[0].verdict).toContain('Copilot affected; underlying services also unhealthy: teams')
  })

  it('ignores rows of unknown targets and keeps the last view of a target missing from a round', () => {
    const rows = [...healthy(0), row(1, 'auth'), row(1, 'ghost'), row(2, 'ghost')]
    const f = buildFrames(rows, targets)
    expect(f).toHaveLength(2)
    expect(f[1].services.has('ghost')).toBe(false)
    expect(f[1].services.get('teams')!.state).toBe('up')
  })

  it('is deterministic and does not mutate its input', () => {
    const rows = [...healthy(0), ...healthy(1)]
    const copy = JSON.stringify(rows)
    expect(JSON.stringify([...buildFrames(rows, targets)[1].services])).toBe(JSON.stringify([...buildFrames(rows, targets)[1].services]))
    expect(JSON.stringify(rows)).toBe(copy)
  })

  it('duplicate rows for one target in one round: the latest wins', () => {
    const a = row(0, 'auth', 503); const b = { ...row(0, 'auth', 200), at: '2026-01-01T00:00:30.000Z' }
    expect(groupRounds([a, b])[0].rows).toEqual([b])
  })
})

describe('Monitor window', () => {
  it('keeps only the last `window` healthy samples', () => {
    const m = new Monitor({ window: 5, minHistory: 3 })
    for (let i = 0; i < 5; i++) m.step([{ name: 'a', state: 'up', ms: 100 }])
    for (let i = 0; i < 5; i++) m.step([{ name: 'a', state: 'up', ms: 200 }])
    expect(m.baseline('a')).toBe(200)
  })
})

describe('STALE rule (newest result older than 3x the interval)', () => {
  const now = Date.parse('2026-01-01T01:00:00Z')
  it('fresh / boundary / stale', () => {
    expect(isStale('2026-01-01T00:50:00Z', 5, now)).toBe(false)
    expect(isStale('2026-01-01T00:45:00Z', 5, now)).toBe(false)   // exactly 3x: not yet
    expect(isStale('2026-01-01T00:44:59Z', 5, now)).toBe(true)
  })
  it('no data is not "stale" (it is "waiting"); a broken timestamp is', () => {
    expect(isStale(null, 5, now)).toBe(false)
    expect(isStale('garbage', 5, now)).toBe(true)
  })
})
