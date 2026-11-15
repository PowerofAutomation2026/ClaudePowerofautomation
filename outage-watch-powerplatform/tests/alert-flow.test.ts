/**
 * Teams alerts. Three layers:
 *   1. the reference logic (provision/lib/alert-logic.mjs) is unit-tested directly;
 *   2. the GENERATED flow definitions (probe + alert) are EXECUTED with a small workflow-language interpreter
 *      (tests/helpers/wdl.mjs) against the mock Dataverse, round after round, and must produce exactly what the
 *      reference logic says: same row updates, same message, same bookkeeping;
 *   3. structure checks on the generated JSON (Teams action, connection references, run-after, columns).
 * None of this is Microsoft's engine or a real Teams channel: it proves the two implementations agree and the
 * definitions are self-consistent, not that Power Automate behaves identically.
 */
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs helpers
import { createClient } from '../provision/lib/client.mjs'
// @ts-expect-error plain .mjs helpers
import { createMockDataverse } from '../provision/lib/mock-dataverse.mjs'
// @ts-expect-error plain .mjs helpers
import { apply } from '../provision/lib/provision.mjs'
// @ts-expect-error plain .mjs helpers
import { CAPS, SAME_FATE, TAGS, TITLES, buildAlertClientData, estimateAlertRequests, existingChannel } from '../provision/lib/alert-flow.mjs'
// @ts-expect-error plain .mjs helpers
import { context, decide, escapeHtml, evaluateRun, isFailure, latestCompleteRound, worstCaseMessageChars } from '../provision/lib/alert-logic.mjs'
// @ts-expect-error plain .mjs helpers
import { columnSpec, rowViolations } from '../provision/lib/schema.mjs'
// @ts-expect-error plain .mjs helpers
import { parseTeamsChannelLink } from '../provision/lib/validate.mjs'
// @ts-expect-error plain .mjs helpers
import { evaluate, mockConnector, runFlow } from './helpers/wdl.mjs'

/* eslint-disable @typescript-eslint/no-explicit-any */
const LINK = 'https://teams.microsoft.com/l/channel/19%3AaBc123_-xyz%40thread.tacv2/Ops%20Alerts?groupId=11111111-2222-3333-4444-555555555555&tenantId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const TEAMS = parseTeamsChannelLink(LINK)
const OPTS = { intervalMinutes: 10, retentionDays: 7, timeoutSeconds: 10, tenant: null, connectionId: 'aaaaaaaabbbbccccddddeeeeeeeeeeee', teamsConnectionId: 'ffffffffbbbbccccddddeeeeeeeeeeee', teams: TEAMS, heartbeatUrl: null }
const closers: (() => Promise<void>)[] = []
afterEach(async () => { while (closers.length) await closers.pop()!() })
const MIN = 60_000

type Probe = { statusCode?: number; body?: unknown; code?: string; message?: string; timedOut?: boolean; elapsedMs?: number }

/** A deployed environment (mock) plus a clock, and helpers that RUN the two generated flows. */
async function world(extra: any = {}) {
  const mock = createMockDataverse({ autoRun: false })
  const srv = await mock.listen(); closers.push(srv.close)
  const client = createClient({ orgUrl: srv.url, token: mock.token, sleep: async () => {} })
  const res = await apply(client, { ...OPTS, ...extra })
  const flows = () => ({ probe: JSON.parse(mock.db.workflows.find((w: any) => w.name === 'Outage Watch - probe').clientdata), alert: JSON.parse(mock.db.workflows.find((w: any) => w.name === 'Outage Watch - alert').clientdata) })
  let clock = Date.parse('2026-11-15T08:00:00Z')
  const teams: any[] = []
  const state = { teamsFails: null as string | null, bad: {} as Record<string, Probe> }
  const env = () => ({ now: () => clock, advance: (ms: number) => { clock += ms }, connector: (api: string, op: string, p: any) => mockConnector(mock, { teams, teamsFails: state.teamsFails })(api, op, p) })
  const setting = (n: string) => mock.db.owatch_settings.find((s: any) => s.owatch_name === n)
  const settingsMap = () => Object.fromEntries(mock.db.owatch_settings.map((s: any) => [s.owatch_name, s.owatch_value ?? undefined]))
  const target = (n: string) => mock.db.owatch_targets.find((t: any) => t.owatch_name === n)

  /** One run of the PROBE flow. `bad` maps target name -> what its endpoint does this round. */
  async function probeRound(bad: Record<string, Probe> = state.bad) {
    const start = clock
    const byUrl = new Map(mock.db.owatch_targets.map((t: any) => [t.owatch_url, t.owatch_name]))
    const r = await runFlow(flows().probe, { ...env(), http: async (inputs: any) => { const b = bad[byUrl.get(inputs.uri) as string]; return b ? { elapsedMs: 150, ...b } : { statusCode: 200, body: '<html>ok</html>', elapsedMs: 120 } } })
    clock = start + 3 * MIN            // the alert flow looks 3 minutes later: the round is complete
    return r
  }
  /** One run of the ALERT flow, checked against the reference logic. Returns what happened. */
  async function alertRun({ check = true } = {}) {
    const nowMs = clock
    const rounds = [...new Set(mock.db.owatch_results.map((x: any) => x.owatch_round))]
    const round = latestCompleteRound(rounds, nowMs)
    const expected = evaluateRun({
      targets: mock.db.owatch_targets.map((t: any) => ({ ...t })), settings: settingsMap(), nowMs, round,
      failingRows: mock.db.owatch_results.filter((x: any) => x.owatch_round === round && x.owatch_failed === true).map((x: any) => ({ ...x })),
    })
    const before = teams.length
    const prevRound = setting('alert_last_round')?.owatch_value ?? ''
    const r = await runFlow(flows().alert, { ...env(), http: async () => { throw new Error('the alert flow must not use the HTTP connector') } })
    const posted = teams.slice(before)
    if (check) {
      expect(r.expressionErrors, 'no expression may fail').toEqual([])
      expect(r.status).toBe('Succeeded')
      for (const u of expected.updates) { const { name, ...cols } = u; expect(target(name), `state of ${name}`).toMatchObject(cols) }
      expect(setting('alert_last_round').owatch_value ?? '').toBe(expected.saveRound ?? prevRound)
      if (state.teamsFails) expect(posted).toHaveLength(0)
      else if (expected.message === null) expect(posted, 'no message expected').toHaveLength(0)
      else { expect(posted).toHaveLength(1); const got = posted[0].html as string; const want = expected.message as string; if (got !== want) { let i = 0; while (got[i] === want[i]) i++; throw new Error(`flow message differs from the reference at ${i}:\n flow: ${got.slice(Math.max(0, i - 60), i + 120)}\n  ref: ${want.slice(Math.max(0, i - 60), i + 120)}`) } expect(posted[0]).toMatchObject({ groupId: TEAMS.groupId, channelId: TEAMS.channelId, poster: 'Flow bot', location: 'Channel' }) }
    }
    clock = nowMs + 7 * MIN            // next probe round starts 10 minutes after the previous one
    return { r, posted, expected }
  }
  const round = async (bad: Record<string, Probe> = state.bad) => { await probeRound(bad); return alertRun() }
  return { mock, client, res, teams, state, setting, target, probeRound, alertRun, round, flows, clockNow: () => clock, setClock: (ms: number) => { clock = ms } }
}
const DOWN503: Probe = { statusCode: 503, body: '<html><body>Service Unavailable - upstream connect error</body></html>', code: 'ServiceUnavailable' }
const NO_ANSWER: Probe = { code: 'BadGateway', message: "Http request failed as there is an error: 'No such host is known. (login.microsoftonline.com:443)'." }

// ------------------------------------------------------------------------------------------------
describe('reference logic: what counts as a failure (same rule the probe flow writes into owatch_failed)', () => {
  it('no answer, 5xx, 429; anything else is fine without an alive list (a redirect is proof of life)', () => {
    for (const s of [null, 0, 500, 502, 503, 599, 429]) expect(isFailure(s, '')).toBe(true)
    for (const s of [200, 204, 301, 302, 401, 403, 404]) expect(isFailure(s, '')).toBe(false)
  })
  it('with an alive list: a status outside the list is a failure; spaces in the list do not matter', () => {
    expect(isFailure(200, '200')).toBe(false); expect(isFailure(404, '200')).toBe(true)
    expect(isFailure(401, '200, 401,403')).toBe(false); expect(isFailure(20, '200')).toBe(true); expect(isFailure(40, '200,401,403')).toBe(true)
    expect(isFailure(503, '503')).toBe(true)           // 5xx is always a failure, even if someone lists it
  })
})

describe('reference logic: decision table (open / reminder / recovered / dedupe / confirm / snooze)', () => {
  const ctx = (o: any = {}) => ({ ...context({ alert_last_round: '2026-11-15T07:50:00Z', ...o }, Date.parse('2026-11-15T08:03:00Z'), '2026-11-15T08:00:00Z') })
  const row = { owatch_probedat: '2026-11-15T08:00:05Z' }
  const fresh = { failcount: null, failingsince: null, lastok: null, alertopen: null, lastalertat: null }
  it('first failure: counted, not announced (confirm = 2)', () => {
    expect(decide(fresh, row, ctx())).toMatchObject({ event: 'none', count: 1, open: false, since: '2026-11-15T08:00:05Z', lastok: '2026-11-15T07:50:00Z' })
  })
  it('second failure in a row: incident opens, once', () => {
    const d = decide({ ...fresh, failcount: 1, failingsince: '2026-11-15T07:50:05Z', lastok: 'r0' }, row, ctx())
    expect(d).toMatchObject({ event: 'open', count: 2, open: true, since: '2026-11-15T07:50:05Z', lastok: 'r0', lastAlert: '2026-11-15T08:03:00Z' })
    expect(decide({ failcount: 2, failingsince: 'x', lastok: 'r0', alertopen: true, lastalertat: '2026-11-15T07:53:00Z' }, row, ctx()).event).toBe('none')   // no duplicate
  })
  it('alert_confirm = 1 opens at once; 3 waits for the third', () => {
    expect(decide(fresh, row, ctx({ alert_confirm: '1' })).event).toBe('open')
    expect(decide({ ...fresh, failcount: 1 }, row, ctx({ alert_confirm: '3' })).event).toBe('none')
    expect(decide({ ...fresh, failcount: 2 }, row, ctx({ alert_confirm: '3' })).event).toBe('open')
  })
  it('reminder only after alert_reminder_minutes, measured from the last message', () => {
    const open = { failcount: 5, failingsince: 'x', lastok: 'r0', alertopen: true }
    expect(decide({ ...open, lastalertat: '2026-11-15T07:04:00Z' }, row, ctx()).event).toBe('none')        // 59 min
    expect(decide({ ...open, lastalertat: '2026-11-15T07:03:00Z' }, row, ctx())).toMatchObject({ event: 'reminder', lastAlert: '2026-11-15T08:03:00Z' })
    expect(decide({ ...open, lastalertat: '2026-11-15T07:50:00Z' }, row, ctx({ alert_reminder_minutes: '10' })).event).toBe('reminder')
  })
  it('recovery: announced only if an incident was open; a blip that never opened just resets', () => {
    expect(decide({ failcount: 4, failingsince: 'x', lastok: 'r0', alertopen: true, lastalertat: 'y' }, null, ctx())).toMatchObject({ event: 'recovered', count: 0, open: false })
    expect(decide({ ...fresh, failcount: 1 }, null, ctx())).toMatchObject({ event: 'none', count: 0, open: false })
  })
  it('snoozed or disabled: nothing is announced, the streak is still counted, and the incident opens when alerts resume', () => {
    for (const o of [{ alert_snooze_until: '2026-11-15T09:00:00Z' }, { alert_enabled: 'no' }, { alert_enabled: 'NO' }]) {
      const d = decide({ ...fresh, failcount: 1 }, row, ctx(o))
      expect(d).toMatchObject({ event: 'none', count: 2, open: false })
      expect(decide({ ...fresh, failcount: d.count }, row, ctx()).event).toBe('open')
    }
    expect(decide({ ...fresh, failcount: 1 }, row, ctx({ alert_snooze_until: '2026-11-15T08:00:00Z' })).event).toBe('open')    // snooze already over
    expect(decide({ failcount: 3, alertopen: true, failingsince: 'x', lastok: 'r', lastalertat: 'y' }, null, ctx({ alert_enabled: 'no' }))).toMatchObject({ event: 'none', open: false })
  })
  it('bad settings never throw: defaults and limits apply', () => {
    expect(ctx({ alert_confirm: 'abc', alert_reminder_minutes: '-5' })).toMatchObject({ confirm: 2, reminder: 5 })
    expect(ctx({ alert_confirm: '999', alert_reminder_minutes: '99999999' })).toMatchObject({ confirm: 10, reminder: 10080 })
    expect(ctx({ alert_confirm: '', alert_reminder_minutes: '1.5', alert_test: 'YES' })).toMatchObject({ confirm: 2, reminder: 60, test: true })
  })
  it('only complete rounds are judged (started more than 2 minutes ago)', () => {
    const now = Date.parse('2026-11-15T08:03:00Z')
    expect(latestCompleteRound(['2026-11-15T07:50:00Z', '2026-11-15T08:00:00Z', '2026-11-15T08:02:30Z'], now)).toBe('2026-11-15T08:00:00Z')
    expect(latestCompleteRound(['2026-11-15T08:02:30Z'], now)).toBeNull()
    expect(latestCompleteRound([], now)).toBeNull()
  })
})

describe('reference logic: message (full details, escaping, caps)', () => {
  it('HTML-escapes everything that comes from targets and probes', () => {
    expect(escapeHtml('<script>alert("x")</script> & co')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co')
  })
  it('the size cap holds for ANY input and is far below the Teams limit', () => {
    expect(worstCaseMessageChars()).toBeLessThan(20000)        // Teams message limit is about 28 KB
    expect(CAPS.detailed).toBeGreaterThanOrEqual(10); expect(CAPS.error).toBe(300)
  })
  it('the fixed texts contain no apostrophe (they sit inside workflow-language string literals) and the same-fate line is honest', () => {
    for (const t of [SAME_FATE, ...Object.values(TITLES), ...Object.values(TAGS)]) expect(String(t)).not.toContain("'")
    expect(SAME_FATE).toMatch(/same Microsoft cloud/); expect(SAME_FATE).toMatch(/may be late or never arrive/)
  })
})

// ------------------------------------------------------------------------------------------------
describe('generated flows, executed: the probe flow records what the alert flow needs', () => {
  it('writes one row per enabled target with error text and the failure flag; one bad probe never stops the others', async () => {
    const w = await world()
    const r = await w.probeRound({ exchange: DOWN503, auth: NO_ANSWER, teams: { timedOut: true, elapsedMs: 10000 }, graph: { statusCode: 404, body: 'not here' }, 'power-bi': { statusCode: 302, body: '' } })
    expect(r.expressionErrors).toEqual([])
    expect(r.status).toBe('Succeeded')
    const rows = Object.fromEntries(w.mock.db.owatch_results.map((x: any) => [x.owatch_name, x]))
    expect(Object.keys(rows)).toHaveLength(34)                                    // every enabled target got its row
    expect(rows.exchange).toMatchObject({ owatch_httpstatus: 503, owatch_failed: true, owatch_errorkind: 'ServiceUnavailable' })
    expect(rows.exchange.owatch_errormessage).toContain('upstream connect error')   // no error object: the start of the response body
    expect(rows.auth.owatch_httpstatus ?? null).toBeNull()
    expect(rows.auth).toMatchObject({ owatch_failed: true, owatch_errorkind: 'BadGateway' })
    expect(rows.auth.owatch_errormessage).toContain('No such host is known')
    expect(rows.teams).toMatchObject({ owatch_failed: true, owatch_errorkind: 'ActionTimedOut' })
    expect(rows.graph).toMatchObject({ owatch_httpstatus: 404, owatch_failed: true })          // graph lists 200,401,403: 404 is outside
    expect(rows['power-bi']).toMatchObject({ owatch_httpstatus: 302, owatch_failed: false })    // no alive list: a redirect is proof of life
    expect(rows.planner).toMatchObject({ owatch_httpstatus: 200, owatch_failed: false }); expect(rows.planner.owatch_errorkind ?? '').toBe('')
    expect(rows.planner.owatch_errormessage ?? '').toBe('')
    for (const x of w.mock.db.owatch_results) expect(isFailure(x.owatch_httpstatus ?? null, w.target(x.owatch_name).owatch_alivecodes ?? ''), x.owatch_name).toBe(x.owatch_failed)
    for (const x of w.mock.db.owatch_results) { const { owatch_resultid, ...cols } = x; expect(rowViolations('owatch_result', cols), x.owatch_name).toEqual([]) }
    expect(w.mock.problems).toEqual([])
  })
  it('a huge or hostile error text is cut to the column and stored as inert text', async () => {
    const w = await world()
    const r = await w.probeRound({ exchange: { statusCode: 500, body: '<script>alert(1)</script>' + 'E'.repeat(50000), code: 'X'.repeat(500) }, intune: { code: 'BadGateway', message: 'm'.repeat(9000) }, teams: { statusCode: 503, body: { error: { message: 'json body' } } } })
    expect(r.expressionErrors).toEqual([]); expect(r.status).toBe('Succeeded')
    const rows = Object.fromEntries(w.mock.db.owatch_results.map((x: any) => [x.owatch_name, x]))
    expect(rows.exchange.owatch_errormessage).toHaveLength(columnSpec('owatch_result').owatch_errormessage.maxLength)
    expect(rows.exchange.owatch_errorkind).toHaveLength(100); expect(rows.intune.owatch_errormessage).toHaveLength(1000)
    expect(rows.teams.owatch_errormessage).toContain('json body')
    expect(w.mock.db.owatch_results).toHaveLength(34)
  })
  it('the probe flow has no Teams dependency at all: an alert problem cannot stop probing', async () => {
    const w = await world()
    const probe = JSON.stringify(w.flows().probe)
    expect(probe).not.toContain('shared_teams'); expect(probe).not.toContain('owatch_teams'); expect(probe).not.toMatch(/owatch_alertopen|owatch_failcount/)
    expect(Object.keys(w.flows().probe.properties.connectionReferences)).toEqual(['shared_commondataserviceforapps'])
  })
})

describe('generated flows, executed: incident lifecycle in Teams (each run compared with the reference logic)', () => {
  it('healthy: no message, no row touched, 22 requests per run', async () => {
    const w = await world()
    for (let i = 0; i < 3; i++) { const { r, posted } = await w.round({}); expect(posted).toEqual([]); expect(r.count).toBe(estimateAlertRequests(10).perQuietRun) }
    expect(w.mock.db.owatch_targets.every((t: any) => (t.owatch_failcount ?? 0) === 0 && t.owatch_alertopen !== true)).toBe(true)
    expect(estimateAlertRequests(10)).toMatchObject({ perQuietRun: 22, runsPerDay: 144, perDay: 3168 })
  })

  it('blip (one failed round) is never announced', async () => {
    const w = await world()
    await w.round({})
    expect((await w.round({ exchange: DOWN503 })).posted).toEqual([])
    expect(w.target('exchange').owatch_failcount).toBe(1)
    expect((await w.round({})).posted).toEqual([])
    expect(w.target('exchange')).toMatchObject({ owatch_failcount: 0, owatch_alertopen: false })
  })

  it('OPEN after 2 failed rounds with full details incl. the error; no duplicate; REMINDER after 60 min; RECOVERED with downtime', async () => {
    const w = await world()
    await w.round({})
    await w.round({ exchange: DOWN503 })
    const open = (await w.round({ exchange: DOWN503 })).posted
    expect(open).toHaveLength(1)
    const h = open[0].html as string
    expect(h).toContain(TITLES.failure)
    expect(h).toContain('New failures: 1 | still failing (reminder): 0 | recovered: 0')
    expect(h).toContain('<p><b>Exchange</b></p>')                                           // family heading
    expect(h).toContain('[NEW FAILURE] exchange')
    expect(h).toContain('URL: https://autodiscover-s.outlook.com/autodiscover/autodiscover.xml')
    expect(h).toContain('Result: HTTP 503 after 150 ms')
    expect(h).toContain('Error: ServiceUnavailable &lt;html&gt;&lt;body&gt;Service Unavailable - upstream connect error')
    expect(h).toMatch(/Failing since: 2026-11-15T08:10:\S+ UTC \| consecutive failures: 2 \| last success \(probe round\): 2026-11-15T08:00:00Z/)
    expect(h).toContain('Failing in this probe round: 1 service(s).')
    expect(h).toMatch(/Time: 2026-11-15T08:23:00Z UTC \| probe round: 2026-11-15T08:20:00Z/)
    expect(h.endsWith('<p><i>' + SAME_FATE + '</i></p>')).toBe(true)
    expect(h).not.toContain('Open the Outage Watch dashboard')                               // no URL known: no link is invented
    expect(w.setting('last_alert_at').owatch_value).toBe('2026-11-15T08:23:00Z')
    expect(w.target('exchange')).toMatchObject({ owatch_alertopen: true, owatch_failcount: 2 })

    for (let i = 0; i < 5; i++) expect((await w.round({ exchange: DOWN503 })).posted, `round ${i}: still failing, already announced`).toEqual([])
    const rem = (await w.round({ exchange: DOWN503 })).posted                                // 60 minutes after the first message
    expect(rem).toHaveLength(1)
    expect(rem[0].html).toContain('[STILL FAILING] exchange'); expect(rem[0].html).toContain('still failing (reminder): 1'); expect(rem[0].html).toContain('consecutive failures: 8')

    const rec = (await w.round({})).posted
    expect(rec).toHaveLength(1)
    expect(rec[0].html).toContain(TITLES.recovered); expect(rec[0].html).toContain('[RECOVERED] exchange')
    expect(rec[0].html).toMatch(/Answering again\. Was failing since 2026-11-15T08:10:\S+ UTC \(about 8\d min, 8 failed round\(s\)\)\./)
    expect(w.target('exchange')).toMatchObject({ owatch_alertopen: false, owatch_failcount: 0 })
    expect((await w.round({})).posted).toEqual([])
    expect(w.teams).toHaveLength(3)                                                          // open, reminder, recovered. Nothing else.
  })

  it('ONE message per round: several services, grouped by family, with the at-risk list and the Copilot note', async () => {
    const w = await world()
    const bad = { auth: NO_ANSWER, exchange: DOWN503, 'm365-copilot': DOWN503, 'power-bi': DOWN503 }
    await w.round({}); await w.round(bad)
    const { posted } = await w.round(bad)
    expect(posted).toHaveLength(1)
    const h = posted[0].html as string
    expect(h).toContain('New failures: 4')
    const order = ['<p><b>Copilot</b></p>', '[NEW FAILURE] m365-copilot', '<p><b>Exchange</b></p>', '[NEW FAILURE] exchange', '<p><b>Identity &amp; platform</b></p>', '[NEW FAILURE] auth', '<p><b>Power Platform &amp; dashboards</b></p>', '[NEW FAILURE] power-bi'].map((x) => h.indexOf(x))
    expect(order.every((x) => x >= 0)).toBe(true); expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(h).toContain('Result: no HTTP answer after 150 ms'); expect(h).toContain('Error: BadGateway Http request failed as there is an error: &#39;'.replace('&#39;', "'") + 'No such host is known')
    expect(h).toMatch(/<b>At risk downstream \(sign-in is failing\):<\/b> admin-center, azure-portal, .* and \d+ more<\/p>/)
    expect(h).not.toMatch(/At risk[^<]*sharepoint-online/)                                   // unconfigured targets are never listed as at risk
    expect(h).toContain('Copilot affected; underlying services also unhealthy: exchange')
  })

  it('an unexpected status for a target with alive codes alerts too (auth answering 404)', async () => {
    const w = await world()
    const bad = { auth: { statusCode: 404, body: 'gone' } }
    await w.round(bad)
    const { posted } = await w.round(bad)
    expect(posted[0].html).toContain('[NEW FAILURE] auth'); expect(posted[0].html).toContain('Result: HTTP 404')
  })

  it('disabled and unconfigured targets never alert', async () => {
    const w = await world()
    w.target('planner').owatch_enabled = false
    for (let i = 0; i < 3; i++) expect((await w.round({ planner: DOWN503, 'sharepoint-online': DOWN503 })).posted).toEqual([])
    expect(w.mock.db.owatch_results.some((x: any) => x.owatch_name === 'planner' || x.owatch_name === 'sharepoint-online')).toBe(false)
  })

  it('alert_snooze_until mutes posting but not recording; the incident is announced when the mute ends', async () => {
    const w = await world()
    w.setting('alert_snooze_until').owatch_value = '2026-11-15T08:40:00Z'
    await w.round({})
    for (let i = 0; i < 3; i++) expect((await w.round({ teams: DOWN503 })).posted).toEqual([])      // 08:13, 08:23, 08:33: muted
    expect(w.target('teams')).toMatchObject({ owatch_failcount: 3, owatch_alertopen: false })
    expect(w.mock.db.owatch_results.filter((x: any) => x.owatch_name === 'teams' && x.owatch_failed).length).toBe(3)   // still recorded
    const { posted } = await w.round({ teams: DOWN503 })                                             // 08:43: mute over
    expect(posted).toHaveLength(1); expect(posted[0].html).toContain('[NEW FAILURE] teams'); expect(posted[0].html).toContain('consecutive failures: 4')
  })

  it('alert_enabled = no: no posts; bad setting values: defaults, no failed expression', async () => {
    const w = await world()
    w.setting('alert_enabled').owatch_value = 'no'
    for (let i = 0; i < 3; i++) expect((await w.round({ teams: DOWN503 })).posted).toEqual([])
    w.setting('alert_enabled').owatch_value = 'yes'
    w.setting('alert_confirm').owatch_value = 'two'; w.setting('alert_reminder_minutes').owatch_value = 'soon'; w.setting('alert_snooze_until').owatch_value = null
    const { posted, r } = await w.round({ teams: DOWN503 })
    expect(r.expressionErrors).toEqual([]); expect(posted).toHaveLength(1)
  })

  it('TEST message: alert_test = yes posts a clearly labelled test within one run, then resets the flag', async () => {
    const w = await world({ sendTestAlert: true })
    expect(w.setting('alert_test').owatch_value).toBe('yes')
    const { posted } = await w.alertRun()                                      // no probe round exists at all yet: the test still goes out
    expect(posted).toHaveLength(1)
    expect(posted[0].html).toContain(TITLES.test); expect(posted[0].html).toContain('TEST requested with the setting alert_test'); expect(posted[0].html).toContain('New failures: 0')
    expect(posted[0].html).toContain(SAME_FATE)
    expect(w.setting('alert_test').owatch_value).toBe('no')
    expect(w.setting('last_alert_at').owatch_value).toBeTruthy()
    expect((await w.alertRun()).posted).toEqual([])                             // exactly once
  })

  it('a failing Teams post is recorded in last_alert_error, never stops probing, and a TEST is retried', async () => {
    const w = await world({ sendTestAlert: true })
    w.state.teamsFails = 'The bot is not part of the conversation roster. secret-free message ' + 'x'.repeat(600)
    const { r } = await w.alertRun()
    expect(r.status).toBe('Succeeded')                                          // the failure is handled inside the flow
    expect(r.statuses.get('Post_to_Teams')).toBe('Failed'); expect(r.statuses.get('Note_error')).toBe('Succeeded'); expect(r.statuses.get('Mark_sent')).toBe('Skipped')
    const err = w.setting('last_alert_error').owatch_value as string
    expect(err).toMatch(/^2026-11-15T08:00:00Z The bot is not part of the conversation roster/); expect(err.length).toBeLessThanOrEqual(CAPS.lastErr)
    expect(w.setting('alert_test').owatch_value).toBe('yes')                    // not cleared: it is tried again
    expect(w.setting('last_alert_at').owatch_value ?? '').toBe('')
    expect((await w.probeRound({})).status).toBe('Succeeded')                   // probing carries on
    w.state.teamsFails = null
    expect((await w.alertRun()).posted).toHaveLength(1)
  })

  it('each round is judged at most once, a round still being written is ignored', async () => {
    const w = await world()
    await w.probeRound({ teams: DOWN503 })
    await w.alertRun(); await w.alertRun(); await w.alertRun()                 // three runs, one round
    expect(w.target('teams').owatch_failcount).toBe(1)
    const now = w.clockNow()
    await w.probeRound({ teams: DOWN503 })                                      // sets the clock 3 min after the round start...
    w.setClock(now + 60_000)                                                    // ...but look only 1 minute after it started
    await w.alertRun()
    expect(w.target('teams').owatch_failcount).toBe(1)                          // not counted yet
    w.setClock(now + 4 * MIN)
    expect((await w.alertRun()).posted).toHaveLength(1)
    expect(w.target('teams').owatch_failcount).toBe(2)
  })

  it('if the bookkeeping row is missing the round is NOT judged (no duplicates possible) and the failed step is visible', async () => {
    const w = await world()
    w.mock.db.owatch_settings.splice(w.mock.db.owatch_settings.findIndex((s: any) => s.owatch_name === 'alert_last_round'), 1)
    await w.probeRound({ teams: DOWN503 })
    const { r, posted } = await w.alertRun({ check: false })
    expect(r.statuses.get('Save_round')).toBe('Failed'); expect(r.statuses.get('List_failing')).toBe('Skipped')
    expect(posted).toEqual([]); expect(w.target('teams').owatch_failcount ?? 0).toBe(0)
    expect(r.expressionErrors).toEqual([])                                      // the failed action is visible in the run history
  })

  it('hostile target names and error texts cannot inject markup; many failures are capped with "and N more"; size stays bounded', async () => {
    const w = await world()
    const evil = '<img src=x onerror=alert(1)>"&' + 'A'.repeat(200)
    w.target('planner').owatch_name = evil.slice(0, 100)
    w.target('loop').owatch_family = '<script>fam</script>'
    w.target('forms').owatch_url = 'https://forms.office.com/?q=<script>&x="' + 'u'.repeat(400)
    const all: Record<string, Probe> = {}
    for (const t of w.mock.db.owatch_targets) all[t.owatch_name] = { statusCode: 500, body: '<script>alert("pwn")</script><a href="https://evil.example">x</a>' + '&<>"'.repeat(2000), code: '<b>Kind</b>' }
    await w.round(all)
    const { posted } = await w.round(all)
    expect(posted).toHaveLength(1)
    const h = posted[0].html as string
    expect(h).toContain('New failures: 34')
    expect(h).toContain(`<p>... and ${34 - CAPS.detailed} more (see the dashboard).</p>`)
    expect((h.match(/\[NEW FAILURE\]/g) ?? []).length).toBe(CAPS.detailed)
    // the only tags in the message are the ones the flow itself writes
    const tags = new Set((h.match(/<\/?[a-zA-Z][^>]*>/g) ?? []))
    for (const t of tags) expect(['<p>', '</p>', '<b>', '</b>', '<br>', '<i>', '</i>'], `unexpected tag ${t}`).toContain(t)
    expect(h).not.toMatch(/<script|<img|onerror=alert\(1\)>|href="https:\/\/evil/)
    expect(h.length).toBeLessThanOrEqual(worstCaseMessageChars()); expect(h.length).toBeLessThan(20000)
    expect(h).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('the dashboard link appears only when its URL is stored, and is escaped', async () => {
    const w = await world({ sendTestAlert: true })
    w.mock.db.owatch_settings.push({ owatch_settingid: '66666666-6666-6666-6666-666666666666', owatch_name: 'dashboard_url', owatch_value: 'https://apps.powerapps.com/play/e/x/a/y?a=1&b="2"' })
    const { posted } = await w.alertRun()
    expect(posted[0].html).toContain('<p><a href="https://apps.powerapps.com/play/e/x/a/y?a=1&amp;b=&quot;2&quot;">Open the Outage Watch dashboard</a></p>')
    w.setting('dashboard_url').owatch_value = 'javascript:alert(1)'; w.setting('alert_test').owatch_value = 'yes'
    expect((await w.alertRun()).posted[0].html).not.toContain('<a ')
  })

  it('seeded fuzz: 60 rounds of random failures, setting changes and Teams outages agree with the reference at every step', async () => {
    const w = await world()
    let seed = 20261115
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    const names = ['auth', 'exchange', 'teams', 'graph', 'm365-copilot', 'copilot-substrate', 'power-bi', 'office-cdn', 'intune']
    const kinds: Probe[] = [DOWN503, NO_ANSWER, { statusCode: 429, body: 'slow down' }, { statusCode: 404, body: 'nope' }, { timedOut: true }]
    let posts = 0
    for (let i = 0; i < 60; i++) {
      const bad: Record<string, Probe> = {}
      for (const n of names) if (rnd() < 0.25) bad[n] = kinds[Math.floor(rnd() * kinds.length)]
      if (rnd() < 0.08) w.setting('alert_confirm').owatch_value = ['1', '2', '3', 'x'][Math.floor(rnd() * 4)]
      if (rnd() < 0.08) w.setting('alert_reminder_minutes').owatch_value = ['10', '30', '60'][Math.floor(rnd() * 3)]
      if (rnd() < 0.06) w.setting('alert_snooze_until').owatch_value = rnd() < 0.5 ? null : new Date(w.clockNow() + 25 * MIN).toISOString().replace(/\.\d+Z$/, 'Z')
      if (rnd() < 0.05) w.setting('alert_enabled').owatch_value = rnd() < 0.5 ? 'no' : 'yes'
      w.state.teamsFails = rnd() < 0.07 ? 'Teams is unavailable' : null
      posts += (await w.round(bad)).posted.length              // round() asserts equality with the reference
    }
    expect(posts).toBeGreaterThan(5)
    expect(w.mock.problems).toEqual([])
  }, 30000)
})

// ------------------------------------------------------------------------------------------------
describe('generated alert flow: structure', () => {
  const sets = { target: 'owatch_targets', result: 'owatch_results', setting: 'owatch_settings' }
  const cd = buildAlertClientData({ intervalMinutes: 10, groupId: TEAMS.groupId, channelId: TEAMS.channelId, sets })
  const walk = (a: any, path = ''): [string, any][] => Object.entries(a ?? {}).flatMap(([n, x]: [string, any]) => [[path + n, x] as [string, any], ...walk(x.actions, path + n + '/'), ...walk(x.else?.actions, path + n + '/else/')])
  const all = walk(cd.properties.definition.actions)

  it('is plain JSON with the documented envelope, both connection references, and a recurrence that cannot overlap', () => {
    expect(JSON.parse(JSON.stringify(cd))).toEqual(cd)
    expect(cd.schemaVersion).toBe('1.0.0.0')
    expect(cd.properties.connectionReferences).toEqual({
      shared_commondataserviceforapps: { runtimeSource: 'embedded', connection: { connectionReferenceLogicalName: 'owatch_dataverse' }, api: { name: 'shared_commondataserviceforapps' } },
      shared_teams: { runtimeSource: 'embedded', connection: { connectionReferenceLogicalName: 'owatch_teams' }, api: { name: 'shared_teams' } },
    })
    expect(cd.properties.definition.triggers.Recurrence).toMatchObject({ type: 'Recurrence', recurrence: { frequency: 'Minute', interval: 10 }, runtimeConfiguration: { concurrency: { runs: 1 } } })
  })
  it('posts with the Teams connector as Flow bot into the channel - never with the premium HTTP connector', () => {
    const post = all.find(([n]) => n.endsWith('Post_to_Teams'))![1]
    expect(post.inputs.host).toEqual({ apiId: '/providers/Microsoft.PowerApps/apis/shared_teams', connectionName: 'shared_teams', operationId: 'PostMessageToConversation' })
    expect(post.inputs.parameters).toEqual({ poster: 'Flow bot', location: 'Channel', 'body/recipient/groupId': TEAMS.groupId, 'body/recipient/channelId': TEAMS.channelId, 'body/messageBody': "@outputs('Message')" })
    expect(all.some(([, a]) => a.type === 'Http')).toBe(false)
    expect(all.filter(([, a]) => a.inputs?.host?.connectionName === 'shared_teams')).toHaveLength(1)
    expect(existingChannel(JSON.stringify(cd))).toEqual({ groupId: TEAMS.groupId, channelId: TEAMS.channelId })
  })
  it('run-after protection: a failed evaluation still lets a TEST go out; a failed post is noted; state is saved before judging', () => {
    const top = cd.properties.definition.actions
    expect([...top.If_should_post.runAfter.If_new_round].sort()).toEqual(['Failed', 'Skipped', 'Succeeded', 'TimedOut'])
    const post = top.If_should_post.actions
    expect(post.Note_error.runAfter).toEqual({ Post_to_Teams: ['Failed', 'TimedOut'] })
    expect(post.Mark_sent.runAfter).toEqual({ Post_to_Teams: ['Succeeded'] })
    expect(top.If_new_round.actions.Save_round.runAfter).toEqual({})
    expect(top.If_new_round.actions.List_failing.runAfter).toEqual({ Save_round: ['Succeeded'] })
    expect(top.If_new_round.actions.For_each_interesting.runtimeConfiguration.concurrency.repetitions).toBe(1)
  })
  it('every Dataverse action names an existing entity set and only columns that exist; every runAfter names a sibling', () => {
    const cols: Record<string, string[]> = { owatch_targets: [...Object.keys(columnSpec('owatch_target')), 'owatch_targetid', 'statecode'], owatch_results: [...Object.keys(columnSpec('owatch_result')), 'owatch_resultid'], owatch_settings: [...Object.keys(columnSpec('owatch_setting')), 'owatch_settingid'] }
    for (const [n, a] of all.filter(([, x]) => x.inputs?.host?.connectionName === 'shared_commondataserviceforapps')) {
      const p = a.inputs.parameters
      expect(Object.keys(cols), n).toContain(p.entityName)
      expect(['ListRecords', 'UpdateRecord']).toContain(a.inputs.host.operationId)        // the alert flow never creates or deletes rows
      for (const c of String(p.$select ?? '').split(',').filter(Boolean)) expect(cols[p.entityName], `${n} $select ${c}`).toContain(c)
      for (const c of [...String(p.$filter ?? '').matchAll(/\bowatch_[a-z]+\b/g)].map((m) => m[0])) expect(cols[p.entityName], `${n} $filter ${c}`).toContain(c)
      for (const c of String(p.$orderby ?? '').split(',').filter(Boolean).map((x) => x.trim().split(' ')[0])) expect(cols[p.entityName], `${n} $orderby ${c}`).toContain(c)
      for (const k of Object.keys(p).filter((k) => k.startsWith('item/'))) expect(cols[p.entityName], `${n} writes ${k}`).toContain(k.slice(5))
    }
    // every owatch_ column mentioned anywhere in any expression exists in some table
    const known = new Set(Object.values(cols).flat())
    for (const c of new Set(JSON.stringify(cd).match(/\bowatch_[a-z]+\b/g))) if (!['owatch_dataverse', 'owatch_teams', 'owatch_targets', 'owatch_results', 'owatch_settings'].includes(c)) expect(known.has(c), c).toBe(true)
  })
  it('every expression parses and has balanced quotes and parentheses', () => {
    const strings = (v: any): string[] => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [])
    const env = { now: () => 0, vars: new Map() }
    for (const s of strings(cd).filter((x) => x.includes('@'))) {
      let depth = 0; let inStr = false
      for (const ch of s) { if (ch === "'") inStr = !inStr; else if (!inStr && ch === '(') depth++; else if (!inStr && ch === ')') depth-- }
      expect(depth, s.slice(0, 80)).toBe(0); expect(inStr, s.slice(0, 80)).toBe(false)
      try { evaluate(s, env, { parent: null, results: new Map() }) } catch (e) { expect(String((e as Error).message), s.slice(0, 80)).not.toMatch(/expression syntax|unsupported function/) }
    }
  })
  it('contains no secret and no URL other than the schema: the channel ids are the only deployment data', () => {
    const text = JSON.stringify(cd)
    const urls = (text.match(/https?:\/\/[A-Za-z0-9.-]+/g) ?? []).filter((u) => u !== 'https://')
    expect([...new Set(urls)]).toEqual(['https://schema.management.azure.com'])
    expect(text).not.toMatch(/hc-ping|Bearer |password|webhook|client_secret/i)
  })
})
