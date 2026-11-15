/**
 * Insights are deterministic and explainable: every test checks the statement AND the evidence it shows.
 * Covers hostile names, huge error text, empty and tiny history, clock skew. (No time-zone logic exists here:
 * everything is UTC, so there are no DST edges to test.)
 */
import { describe, expect, it } from 'vitest'
import catalog from '../shared/catalog.json'
import { buildFrames, dependencyEdges, type RawRow, type TargetSpec } from '../src/logic/classify'
import { derive, topo } from '../src/logic/graph'
import { DEFAULT_DRIFT, commonCause, drifting, errorTheme, flapping, incidentReport, incidentStats, parseHeadcount, percentile, relatedIncidents, scorecard, staffUpdate } from '../src/logic/insights'
import type { IncidentRow } from '../src/data/types'

const targets = catalog.targets.map((t) => ({ name: t.name, alive: t.alive, dependsOnAuth: t.dependsOnAuth, copilotNeeds: t.copilotNeeds, family: t.family }))
const spec: TargetSpec[] = targets
const names = targets.map((t) => t.name)
const T = topo(names, dependencyEdges(spec))
const at = (i: number) => new Date(Date.UTC(2026, 10, 15, 8, i * 10)).toISOString()
type Bad = Record<string, number | null>
const round = (i: number, bad: Bad = {}, ms: Record<string, number> = {}): RawRow[] => names.map((n) => ({ name: n, httpStatus: n in bad ? bad[n] : 200, elapsedMs: ms[n] ?? 100, errorKind: n in bad && bad[n] == null ? 'ActionTimedOut' : '', at: at(i), round: at(i) }))
const frames = (rounds: RawRow[][]) => buildFrames(rounds.flat(), spec)
const cause = (bad: Bad, n = 2) => { const f = frames(Array.from({ length: n }, (_, i) => round(i, bad))); const last = f[f.length - 1]; return commonCause(last, derive(last, T), targets) }
const familyOf = (n: string) => targets.find((t) => t.name === n)?.family ?? 'Independent'

describe('I1 probable common cause', () => {
  it('nothing failing -> no statement at all', () => { expect(cause({})).toBeNull() })
  it('sign-in failing: ONE statement, with evidence and what cannot be known - instead of 28 separate alarms', () => {
    const c = cause({ auth: null, exchange: 503, 'office-cdn': 503 })!
    expect(c.kind).toBe('sign-in')
    expect(c.title).toBe('Probable common cause: sign-in (auth) is not answering')
    expect(c.evidence).toEqual(['auth: down, no HTTP answer (ActionTimedOut)', '1 of the 2 other failing services need sign-in', '27 more services answer their own probe but depend on sign-in (shown as "at risk")'])
    expect(c.cannotKnow).toMatch(/cannot know the real root cause/)
    expect(cause({ auth: 503 }, 1)!.evidence[1]).toBe('no other service is failing its own probe yet')       // already on the first failed probe (suspect)
  })
  it('nearly everything failing points at the probe path, not at Microsoft', () => {
    const bad: Bad = {}; for (const n of names.slice(0, 30)) bad[n] = null
    const c = cause(bad)!
    expect(c.kind).toBe('everything'); expect(c.evidence[0]).toBe('30 of 34 probed services failed in the same round')
    expect(c.cannotKnow).toMatch(/independent monitor/)
  })
  it('Copilot failing together with a service it reads from', () => {
    const c = cause({ 'm365-copilot': 503, exchange: 503 })!
    expect(c.kind).toBe('copilot-underneath'); expect(c.evidence).toEqual(['m365-copilot: down, HTTP 503', 'exchange: down, HTTP 503'])
    expect(cause({ 'm365-copilot': 503 })).toBeNull()                         // alone: nothing shared, nothing claimed
  })
  it('failures concentrated in one family; scattered failures claim nothing', () => {
    const c = cause({ 'power-bi': 503, 'power-automate': 503, 'power-apps-maker': 503, planner: 503 })!
    expect(c.kind).toBe('family'); expect(c.title).toBe('Failures are concentrated in one family: Power Platform & dashboards')
    expect(c.evidence[0]).toBe('3 of 4 failing services belong to it: power-apps-maker, power-automate, power-bi')
    expect(cause({ 'power-bi': 503, planner: 503, intune: 503 })).toBeNull()
    expect(cause({ 'power-bi': 404 })).toBeNull()                             // a warning is not a failure
  })
  it('hostile service names are length-limited, control characters removed (the UI renders them as text)', () => {
    const evil = '<img src=x onerror=alert(1)>\n\u0000' + 'A'.repeat(300)
    const t2 = [...targets, { name: evil, alive: null, dependsOnAuth: true, copilotNeeds: false, family: 'X' }]
    const rows = [...round(0), { name: evil, httpStatus: null, elapsedMs: 5, errorKind: 'E'.repeat(500), at: at(0), round: at(0) }, ...round(0, { auth: null }).filter((r) => r.name === 'auth').map((r) => ({ ...r, at: at(1), round: at(1) }))]
    const f = buildFrames([...rows, ...round(1, { auth: null }), { name: evil, httpStatus: null, elapsedMs: 5, errorKind: 'E'.repeat(500), at: at(1), round: at(1) }], t2)
    const c = commonCause(f[f.length - 1], derive(f[f.length - 1], topo(t2.map((t) => t.name), dependencyEdges(t2))), t2)!
    for (const e of [c.title, ...c.evidence]) { expect(e.length).toBeLessThan(400); expect(e).not.toMatch(/[\u0000\n]/) }
  })
})

describe('I3 drift: slow degradation before the warning rule', () => {
  const steady = (n: number, ms: Record<string, number> = {}) => Array.from({ length: n }, (_, i) => round(i, {}, ms))
  it('reports the numbers: recent median, baseline, percent', () => {
    const rounds = [...steady(14, { teams: 180 }), ...Array.from({ length: 6 }, (_, i) => round(14 + i, {}, { teams: 420 }))]
    const d = drifting(frames(rounds))
    expect(d).toEqual([{ name: 'teams', recentMedian: 420, baseline: 180, percentUp: 133, samples: 20 }])
    expect(frames(rounds).pop()!.services.get('teams')!.state).toBe('up')      // still below the 3x / +800 ms warning rule
    expect(frames(rounds).pop()!.level).toBe('ok')                            // drift never raises the level
  })
  it('needs BOTH the percentage and the absolute change; ignores services already warning or failing; ignores tiny history', () => {
    const up = (ms: number, base = 100) => drifting(frames([...steady(14, { teams: base }), ...Array.from({ length: 6 }, (_, i) => round(14 + i, {}, { teams: ms }))]))
    expect(up(190)).toEqual([])                                               // +90%: but only +90 ms
    expect(up(260).map((x) => x.name)).toEqual(['teams'])                     // +160%, +160 ms
    expect(up(1300, 1000)).toEqual([])                                        // +300 ms but only +30%
    expect(up(2500)).toEqual([])                                              // that is a WARNING already, not drift
    expect(drifting(frames(steady(5, { teams: 900 })))).toEqual([])           // not enough samples
    expect(drifting([])).toEqual([])
    expect(DEFAULT_DRIFT).toEqual({ window: 6, percent: 50, minMs: 150 })
  })
  it('thresholds are parameters', () => {
    const rounds = [...steady(14, { teams: 100 }), ...Array.from({ length: 6 }, (_, i) => round(14 + i, {}, { teams: 190 }))]
    expect(drifting(frames(rounds), { window: 6, percent: 50, minMs: 50 }).map((x) => x.name)).toEqual(['teams'])
  })
})

describe('I4 flapping', () => {
  it('counts changes between answering and failing; a steady outage or a single blip is not flapping', () => {
    const flap = Array.from({ length: 12 }, (_, i) => round(i, i % 2 ? { exchange: 503 } : {}))
    expect(flapping(frames(flap))).toEqual([{ name: 'exchange', changes: 11, rounds: 12 }])
    expect(flapping(frames(Array.from({ length: 12 }, (_, i) => round(i, i > 3 ? { exchange: 503 } : {}))))).toEqual([])
    expect(flapping(frames(Array.from({ length: 12 }, (_, i) => round(i, i === 5 ? { exchange: 503 } : {}))))).toEqual([])
    expect(flapping([])).toEqual([])
  })
})

describe('I7 scorecard (for the loaded window)', () => {
  it('answered %, p50 / p95 per service and per family; worst first', () => {
    const rounds = Array.from({ length: 10 }, (_, i) => round(i, i < 3 ? { exchange: 503 } : {}, { exchange: 200 + i * 10 }))
    const s = scorecard(frames(rounds), familyOf)
    expect(s.rounds).toBe(10); expect(s.from).toBe(at(0)); expect(s.to).toBe(at(9))
    expect(s.services[0]).toEqual({ name: 'exchange', rounds: 10, answeredPct: 70, p50: 260, p95: 290 })
    expect(s.families[0].name).toBe('Exchange'); expect(s.families[0].answeredPct).toBe(90)
    expect(s.services.find((x) => x.name === 'teams')).toMatchObject({ answeredPct: 100, p50: 100, p95: 100 })
  })
  it('empty history and percentiles', () => {
    expect(scorecard([], familyOf)).toEqual({ from: null, to: null, rounds: 0, services: [], families: [] })
    expect(percentile([], 95)).toBeNull(); expect(percentile([5], 95)).toBe(5); expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5); expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10)
  })
})

const NOW = Date.parse('2026-11-15T12:00:00Z')
const inc = (o: Partial<IncidentRow>): IncidentRow => ({ name: 'exchange', family: 'Exchange', open: false, openedAt: '2026-11-15T08:10:00Z', closedAt: '2026-11-15T09:30:00Z', minutes: 80, rounds: 8, reminders: 1, error: 'HTTP 503 - ServiceUnavailable upstream connect error', ...o })

describe('incident statistics: MTTR, chronic offenders, alert noise', () => {
  it('counts only the window, means only closed incidents, lists services with 2+ incidents', () => {
    const rows = [inc({}), inc({ openedAt: '2026-11-10T08:00:00Z', closedAt: '2026-11-10T08:20:00Z', minutes: 20, reminders: 0 }), inc({ name: 'teams', family: 'Teams', open: true, closedAt: null, minutes: 30, reminders: 0, openedAt: '2026-11-15T11:30:00Z' }), inc({ openedAt: '2026-09-01T00:00:00Z' })]
    const s = incidentStats(rows, NOW)
    expect(s).toMatchObject({ days: 30, total: 3, open: 1, mttrMinutes: 50, alerts: 6, reminderPct: 17 })
    expect(s.chronic).toEqual([{ name: 'exchange', incidents: 2, minutes: 100 }])
    expect(s.hint).toBeNull()
  })
  it('noise hint only with enough data, and it states the number it is based on', () => {
    const many = Array.from({ length: 4 }, (_, i) => inc({ openedAt: `2026-11-1${i}T08:00:00Z`, closedAt: `2026-11-1${i}T20:00:00Z`, minutes: 720, reminders: 11 }))
    expect(incidentStats(many, NOW).hint).toMatch(/^85% of the messages were reminders/)
    expect(incidentStats([], NOW)).toMatchObject({ total: 0, mttrMinutes: null, alerts: 0, reminderPct: null, alertsPerWeek: null, chronic: [], hint: null })
  })
  it('ignores unreadable and future-dated rows (clock skew) instead of failing', () => {
    expect(incidentStats([inc({ openedAt: 'garbage' }), inc({ openedAt: '2027-01-01T00:00:00Z' }), inc({ minutes: -5 })], NOW)).toMatchObject({ total: 1, mttrMinutes: 0 })
  })
})

describe('I5 incident narrative / post-incident report', () => {
  it('error themes: ids, numbers and times removed so equal errors group; markup from error pages dropped', () => {
    expect(errorTheme('HTTP 503 - request 3f2c1a9e-0000-4000-8000-123456789abc failed at 2026-11-15T08:10:05Z after 1532 ms')).toBe('HTTP # - request <id> failed at <time> after # ms')
    expect(errorTheme('HTTP 503 - request aaaaaaaa-0000-4000-8000-000000000000 failed at 2026-11-14T01:00:00Z after 9 ms')).toBe(errorTheme('HTTP 503 - request 3f2c1a9e-0000-4000-8000-123456789abc failed at 2026-11-15T08:10:05Z after 1532 ms'))
    expect(errorTheme('<html><body><script>alert(1)</script>Service Unavailable</body></html>')).toBe('alert(#) Service Unavailable')
    expect(errorTheme('')).toBe('(no error text)'); expect(errorTheme('x'.repeat(50000)).length).toBe(120)
  })
  it('groups what happened together, in time order', () => {
    const all = [inc({}), inc({ name: 'outlook-web', openedAt: '2026-11-15T08:20:00Z', closedAt: '2026-11-15T09:10:00Z', minutes: 50 }), inc({ name: 'intune', family: 'Security, compliance & admin', openedAt: '2026-11-13T08:00:00Z', closedAt: '2026-11-13T08:30:00Z' })]
    expect(relatedIncidents(all[0], all, NOW).map((x) => x.name)).toEqual(['exchange', 'outlook-web'])
    expect(relatedIncidents(inc({ openedAt: 'garbage' }), all, NOW)).toHaveLength(1)
  })
  it('is deterministic Markdown built only from recorded facts, and says what it cannot say', () => {
    const all = [inc({}), inc({ name: 'outlook-web', openedAt: '2026-11-15T08:20:00Z', closedAt: '2026-11-15T09:10:00Z', minutes: 50, reminders: 0, error: 'HTTP 503 - ServiceUnavailable upstream connect error' }), inc({ name: 'auth', family: 'Identity & platform', openedAt: '2026-11-15T08:10:00Z', closedAt: '2026-11-15T09:00:00Z', minutes: 50, reminders: 0, error: 'no HTTP answer - ActionTimedOut' })]
    const r = incidentReport(all[0], all, NOW, { intervalMinutes: 10, headcount: { 'Email & calendar': 240 }, roles: catalog.roles })
    expect(r).toBe(incidentReport(all[0], all, NOW, { intervalMinutes: 10, headcount: { 'Email & calendar': 240 }, roles: catalog.roles }))
    expect(r).toContain('# Post-incident report: auth and 2 more service(s)')
    expect(r).toContain('- Status: **resolved**')
    expect(r).toContain('- First failed probe: 2026-11-15 08:10 UTC (auth)')
    expect(r).toContain('- Duration: 80 min, last recovery 2026-11-15 09:30 UTC')
    expect(r).toContain('- Scope: 3 service(s) in 2 families: Identity & platform (1), Exchange (2)')
    expect(r).toContain('Sign-in (auth) was among the failing services')
    expect(r).toContain('- People who rely on the affected tasks (admin-supplied figures, not measured): Email & calendar about 240')
    expect(r).toContain('| exchange | Exchange | 2026-11-15 08:10 UTC | 2026-11-15 09:30 UTC | 80 min | 8 |')
    expect(r).toContain('- `HTTP # - ServiceUnavailable upstream connect error` - 2 service(s): exchange, outlook-web')
    expect(r).toMatch(/2026-11-15 09:00 UTC - auth answered again after 50 min\n[\s\S]*2026-11-15 09:10 UTC - outlook-web answered again/)   // recovery order
    expect(r).toContain('No cause is asserted'); expect(r).toContain('cannot show the root cause')
  })
  it('ongoing incident, and no headcount -> no invented number', () => {
    const open = inc({ open: true, closedAt: null, minutes: 0 })
    const r = incidentReport(open, [open], NOW)
    expect(r).toContain('- Status: **ONGOING (1 of 1 still failing)**'); expect(r).toContain('- Duration so far: 3.8 h'); expect(r).toContain('| still failing |')
    expect(r).not.toMatch(/People who rely/)
  })
  it('hostile names and a huge error text cannot break the Markdown or grow it without bound', () => {
    const evil = inc({ name: 'evil|`<script>alert(1)</script>\n# heading', family: '[x](javascript:alert(1))|', error: '`|</td><img src=x onerror=alert(1)>' + 'Z'.repeat(100000) })
    const r = incidentReport(evil, [evil], NOW)
    expect(r.length).toBeLessThan(6000)
    expect(r).not.toMatch(/<script|<img|<\/td>/)
    const tableRow = r.split('\n').find((l) => l.startsWith('| evil'))!
    expect(tableRow.split('|')).toHaveLength(8)                                // exactly 6 cells: no injected pipe
    expect(r.split('\n').filter((l) => l.startsWith('# '))).toHaveLength(1)    // no injected heading
  })
  it('staff update draft: plain, no cause claimed', () => {
    const open = inc({ open: true, closedAt: null })
    expect(staffUpdate(open, [open], NOW)).toBe('We are seeing problems with exchange since 2026-11-15 08:10 UTC. Our monitoring shows these services are not answering normally. We do not yet know the cause. We will update when they answer again.')
    expect(staffUpdate(inc({}), [inc({})], NOW)).toMatch(/are over: .* Longest interruption: 80 min\. The cause is not known to us yet\.$/)
  })
})

describe('I6 impact estimate: admin-supplied numbers only', () => {
  it('parses "Task=number; Task=number" and ignores everything else', () => {
    expect(parseHeadcount('Email & calendar=240; Meetings = 300 ;Files & sharing=0; x=abc; =5; Low-code apps=12.5; A=B=7')).toEqual({ 'Email & calendar': 240, Meetings: 300, 'A=B': 7 })
    expect(parseHeadcount('')).toEqual({}); expect(parseHeadcount(null)).toEqual({}); expect(parseHeadcount('<script>=5')).toEqual({ '<script>': 5 })   // rendered as text by the UI
    expect(Object.keys(parseHeadcount(Array.from({ length: 60 }, (_, i) => `r${i}=1`).join(';'))).length).toBeLessThanOrEqual(30)
    expect(parseHeadcount('a=999999999')).toEqual({})
  })
})
