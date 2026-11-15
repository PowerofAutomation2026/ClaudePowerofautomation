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
import { CAPS, CHANNELS, COMMON, SAME_FATE, TAGS, TITLES, buildAlertClientData, estimateAlertRequests, existingChannels } from '../provision/lib/alert-flow.mjs'
// @ts-expect-error plain .mjs helpers
import { ciStatus, context, decide, escapeHtml, evaluateRun, isFailure, latestCompleteRound, slackText, teamsHtml, webexText, webhookText, worstCaseTextChars } from '../provision/lib/alert-logic.mjs'
// @ts-expect-error plain .mjs helpers
import { columnSpec, rowViolations } from '../provision/lib/schema.mjs'
// @ts-expect-error plain .mjs helpers
import { assertWebhookUrl, parseTeamsChannelLink } from '../provision/lib/validate.mjs'
// @ts-expect-error plain .mjs helpers
import { evaluate, mockConnector, runFlow } from './helpers/wdl.mjs'

/* eslint-disable @typescript-eslint/no-explicit-any */
const LINK = 'https://teams.microsoft.com/l/channel/19%3AaBc123_-xyz%40thread.tacv2/Ops%20Alerts?groupId=11111111-2222-3333-4444-555555555555&tenantId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const TEAMS = parseTeamsChannelLink(LINK)
const HOOKS = { slack: 'https://hooks.slack.com/services/T000SECRET/B000SECRET/slackSECRETtoken', webex: 'https://webexapis.com/v1/webhooks/incoming/webexSECRETid', webhook: 'https://alerts.example.org/hook/genericSECRET' }
const OPTS = { intervalMinutes: 10, retentionDays: 7, timeoutSeconds: 10, tenant: null, connectionId: 'aaaaaaaabbbbccccddddeeeeeeeeeeee', teamsConnectionId: 'ffffffffbbbbccccddddeeeeeeeeeeee', teams: TEAMS, webhooks: HOOKS, heartbeatUrl: null }
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
  /** everything that reached a channel: { channel, body } (Teams: body = html) */
  const sent: { channel: string; body: string }[] = []
  const teams: any[] = []
  const state = { fails: {} as Record<string, string | undefined>, bad: {} as Record<string, Probe> }
  const env = () => ({ now: () => clock, advance: (ms: number) => { clock += ms }, connector: async (api: string, op: string, p: any) => {
    const before = teams.length
    const r = await mockConnector(mock, { teams, teamsFails: () => state.fails.teams ?? null })(api, op, p)
    if (teams.length > before) sent.push({ channel: 'teams', body: teams[teams.length - 1].html })
    return r
  } })
  /** the webhook endpoints of Slack / Webex / generic, as the HTTP action sees them */
  const hooks = async (inputs: any) => {
    const channel = Object.entries(HOOKS).find(([, u]) => u === inputs.uri)?.[0]
    if (!channel || inputs.method !== 'POST') throw new Error('unexpected HTTP call from the alert flow')
    if (typeof inputs.body?.text !== 'string') return { statusCode: 400, code: 'BadRequest', body: 'no text', elapsedMs: 0 }
    if (state.fails[channel]) return { statusCode: 404, code: 'NotFound', body: `no_service ${inputs.uri}`, message: `The webhook ${inputs.uri} was not found`, elapsedMs: 0 }
    sent.push({ channel, body: inputs.body.text })
    return { statusCode: 200, body: 'ok', elapsedMs: 0 }
  }
  const setting = (n: string) => mock.db.owatch_settings.find((s: any) => s.owatch_name === n)
  const settingsMap = () => Object.fromEntries(mock.db.owatch_settings.map((s: any) => [s.owatch_name, s.owatch_value ?? undefined]))
  const target = (n: string) => mock.db.owatch_targets.find((t: any) => t.owatch_name === n)
  const incidents = () => mock.db.owatch_incidents ?? []

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
    const settingsBefore = settingsMap()
    const expected = evaluateRun({
      targets: mock.db.owatch_targets.map((t: any) => ({ ...t })), settings: settingsBefore, nowMs, round,
      failingRows: mock.db.owatch_results.filter((x: any) => x.owatch_round === round && x.owatch_failed === true).map((x: any) => ({ ...x })),
    })
    const before = sent.length
    const prevRound = setting('alert_last_round')?.owatch_value ?? ''
    const r = await runFlow(flows().alert, { ...env(), http: hooks })
    const posted = sent.slice(before)
    const by = (c: string) => posted.filter((x) => x.channel === c).map((x) => x.body)
    if (check) {
      expect(r.expressionErrors, 'no expression may fail').toEqual([])
      expect(r.status).toBe('Succeeded')
      for (const u of expected.updates) { const { name, ...cols } = u; expect(target(name), `state of ${name}`).toMatchObject(cols) }
      expect(setting('alert_last_round').owatch_value ?? '').toBe(expected.saveRound ?? prevRound)
      if (expected.ci !== null) expect(setting('ci_status').owatch_value, 'CI status').toBe(expected.ci)
      const off = String(settingsBefore.alert_channels_off ?? '').toLowerCase().replace(/ /g, '').split(',')
      const want: Record<string, string> = expected.text === null ? {} : { teams: teamsHtml(expected.text), slack: slackText(expected.text), webex: webexText(expected.text), webhook: webhookText(expected.text) }
      for (const c of CHANNELS) {
        const should = expected.text !== null && res.alerts.channels.includes(c) && !off.includes(c) && !state.fails[c]
        if (!should) { expect(by(c), `${c}: nothing expected`).toEqual([]); continue }
        expect(by(c), `${c}: exactly one message`).toHaveLength(1)
        const got = by(c)[0]
        if (got !== want[c]) { let i = 0; while (got[i] === want[c][i]) i++; throw new Error(`${c} message differs from the reference at ${i}:\n flow: ${JSON.stringify(got.slice(Math.max(0, i - 60), i + 120))}\n  ref: ${JSON.stringify(want[c].slice(Math.max(0, i - 60), i + 120))}`) }
      }
      // incident records follow the reference operations
      for (const op of expected.incidents) {
        const rows = incidents().filter((x: any) => x.owatch_name === op.name)
        if (op.op === 'open') expect(rows.filter((x: any) => x.owatch_isopen === true).pop(), `incident opened for ${op.name}`).toMatchObject(op.row)
        else if (rows.length) expect(rows[rows.length - 1], `incident ${op.op} for ${op.name}`).toMatchObject(op.row)
      }
    }
    clock = nowMs + 7 * MIN            // next probe round starts 10 minutes after the previous one
    return { r, posted, expected, text: expected.text as string | null, teams: by('teams'), slack: by('slack'), webex: by('webex'), webhook: by('webhook') }
  }
  const round = async (bad: Record<string, Probe> = state.bad) => { await probeRound(bad); return alertRun() }
  return { mock, client, res, sent, state, setting, target, incidents, probeRound, alertRun, round, flows, clockNow: () => clock, setClock: (ms: number) => { clock = ms } }
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

describe('reference logic: one text, safely encoded per channel', () => {
  const hostile = 'a <script>alert("x")</script> & <!channel> <https://evil.example|click> line2\nnext'
  it('Teams: HTML-escaped, line breaks as <br>, no other tag can appear', () => {
    const h = teamsHtml(hostile)
    expect(h).toBe('<p>a &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;!channel&gt; &lt;https://evil.example|click&gt; line2<br>next</p>')
    expect(escapeHtml('"&<>')).toBe('&quot;&amp;&lt;&gt;')
  })
  it('Slack: &, < and > escaped, so no mention, link or channel-wide ping can be injected', () => {
    expect(slackText(hostile)).toBe('a &lt;script&gt;alert("x")&lt;/script&gt; &amp; &lt;!channel&gt; &lt;https://evil.example|click&gt; line2\nnext')
  })
  it('Webex and generic webhooks: plain text field (not markdown), bounded', () => {
    expect(webexText('x'.repeat(9000))).toHaveLength(CAPS.webexText); expect(webhookText('x'.repeat(20000))).toHaveLength(CAPS.webhookText)
    expect(CAPS.webexText).toBeLessThan(7439 / 2)                 // Webex limit is 7439 BYTES: room for 2-byte characters
  })
  it('the size caps hold for ANY input and are far below the channel limits', () => {
    expect(worstCaseTextChars()).toBeLessThan(16000)
    expect(CAPS.teamsEscaped + 20).toBeLessThan(28000)            // Teams message limit is about 28 KB
    expect(CAPS.slackEscaped).toBeLessThan(40000)                 // Slack text limit
    expect(CAPS.detailed).toBeGreaterThanOrEqual(10); expect(CAPS.error).toBe(300)
  })
  it('the fixed texts contain no apostrophe (they sit inside workflow-language string literals) and the same-fate line is honest', () => {
    for (const t of [SAME_FATE, ...Object.values(TITLES), ...Object.values(TAGS), ...Object.values(COMMON)]) expect(String(t)).not.toContain("'")
    expect(SAME_FATE).toMatch(/same Microsoft cloud/); expect(SAME_FATE).toMatch(/may be late or never arrive/)
  })
})

describe('reference logic: CI / agent status', () => {
  const ctx = context({}, Date.parse('2026-11-15T08:03:00Z'), '2026-11-15T08:00:00Z')
  const t = (n: string, failcount = 0) => ({ owatch_name: n, owatch_failcount: failcount })
  it('ok / caution (first failure) / freeze (confirmed, or sign-in failing at all)', () => {
    expect(JSON.parse(ciStatus([t('teams')], [], ctx, ''))).toEqual({ level: 'ok', since: '2026-11-15T08:03:00Z', updated: '2026-11-15T08:03:00Z', round: '2026-11-15T08:00:00Z', failing: 0, confirmed: 0, services: '' })
    expect(JSON.parse(ciStatus([t('teams')], ['teams'], ctx, ''))).toMatchObject({ level: 'caution', failing: 1, confirmed: 0, services: 'teams' })
    expect(JSON.parse(ciStatus([t('teams', 1)], ['teams'], ctx, ''))).toMatchObject({ level: 'freeze', confirmed: 1 })
    expect(JSON.parse(ciStatus([t('auth')], ['auth'], ctx, ''))).toMatchObject({ level: 'freeze', confirmed: 0 })
  })
  it('"since" is kept while the level stays the same, reset when it changes or the old value is unreadable', () => {
    const prev = '{"level":"caution","since":"2026-11-15T07:13:00Z","updated":"x","round":"y","failing":1,"confirmed":0,"services":"teams"}'
    expect(JSON.parse(ciStatus([t('teams')], ['teams'], ctx, prev)).since).toBe('2026-11-15T07:13:00Z')
    expect(JSON.parse(ciStatus([t('teams')], [], ctx, prev)).since).toBe('2026-11-15T08:03:00Z')
    for (const junk of ['', 'garbage', '{"level":"caution"}', '{"level":"caution","since":']) expect(JSON.parse(ciStatus([t('teams')], ['teams'], ctx, junk)).since).toBe('2026-11-15T08:03:00Z')
  })
  it('always valid JSON within the 400-character setting, whatever the service names are', () => {
    const names = Array.from({ length: 60 }, (_, i) => `svc"\\${'x'.repeat(90)}${i}`)
    const v = ciStatus(names.map((n) => t(n, 5)), names, ctx, '')
    expect(v.length).toBeLessThanOrEqual(400); expect(JSON.parse(v)).toMatchObject({ level: 'freeze', failing: 60, confirmed: 60 })
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

describe('generated flows, executed: incident lifecycle on every channel (each run compared with the reference logic)', () => {
  it('healthy: no message, no row touched, 25 requests per run, CI status ok', async () => {
    const w = await world()
    for (let i = 0; i < 3; i++) { const { r, posted } = await w.round({}); expect(posted).toEqual([]); expect(r.count).toBe(estimateAlertRequests(10).perQuietRun) }
    expect(w.mock.db.owatch_targets.every((t: any) => (t.owatch_failcount ?? 0) === 0 && t.owatch_alertopen !== true)).toBe(true)
    expect(estimateAlertRequests(10)).toMatchObject({ perQuietRun: 25, runsPerDay: 144, perDay: 3600 })
    expect(JSON.parse(w.setting('ci_status').owatch_value)).toMatchObject({ level: 'ok', failing: 0, since: '2026-11-15T08:03:00Z', updated: '2026-11-15T08:23:00Z' })
    expect(w.incidents()).toEqual([])
  })

  it('blip (one failed round) is never announced, but CI sees "caution" for that round', async () => {
    const w = await world()
    await w.round({})
    expect((await w.round({ exchange: DOWN503 })).posted).toEqual([])
    expect(w.target('exchange').owatch_failcount).toBe(1)
    expect(JSON.parse(w.setting('ci_status').owatch_value)).toMatchObject({ level: 'caution', services: 'exchange' })
    expect((await w.round({})).posted).toEqual([])
    expect(w.target('exchange')).toMatchObject({ owatch_failcount: 0, owatch_alertopen: false })
    expect(JSON.parse(w.setting('ci_status').owatch_value).level).toBe('ok')
    expect(w.incidents()).toEqual([])
  })

  it('OPEN after 2 failed rounds with full details incl. the error, to Teams + Slack + Webex + webhook; no duplicate; REMINDER after 60 min; RECOVERED with downtime; incident record kept', async () => {
    const w = await world()
    await w.round({})
    await w.round({ exchange: DOWN503 })
    const open = await w.round({ exchange: DOWN503 })
    expect(open.posted.map((x) => x.channel).sort()).toEqual(['slack', 'teams', 'webex', 'webhook'])
    const t = open.text!
    expect(t.split('\n')[0]).toBe(TITLES.failure)
    expect(t).toContain('Time: 2026-11-15T08:23:00Z UTC | probe round: 2026-11-15T08:20:00Z')
    expect(t).toContain('New failures: 1 | still failing (reminder): 0 | recovered: 0')
    expect(t).toContain('Failing in this probe round: 1 service(s).')
    expect(t).toContain('== Exchange ==\n[NEW FAILURE] exchange\n  URL: https://autodiscover-s.outlook.com/autodiscover/autodiscover.xml\n  Result: HTTP 503 after 150 ms\n  Error: ServiceUnavailable <html><body>Service Unavailable - upstream connect error</body></html>\n')
    expect(t).toMatch(/Failing since: 2026-11-15T08:10:\S+ UTC \| consecutive failures: 2 \| last success \(probe round\): 2026-11-15T08:00:00Z/)
    expect(t.endsWith(SAME_FATE)).toBe(true)
    expect(t).not.toContain('Dashboard:')                                                    // no URL known: no link is invented
    expect(open.teams[0]).toContain('Error: ServiceUnavailable &lt;html&gt;&lt;body&gt;Service Unavailable'); expect(open.teams[0]).toContain('<br>')
    expect(open.slack[0]).toContain('Error: ServiceUnavailable &lt;html&gt;&lt;body&gt;'); expect(open.webex[0]).toContain('Error: ServiceUnavailable <html><body>')
    expect(w.setting('last_alert_at').owatch_value).toBe('2026-11-15T08:23:00Z')
    for (const c of CHANNELS) expect(w.setting('last_delivery_' + c).owatch_value).toBe('ok 2026-11-15T08:23:00Z')
    expect(w.target('exchange')).toMatchObject({ owatch_alertopen: true, owatch_failcount: 2 })
    expect(JSON.parse(w.setting('ci_status').owatch_value)).toMatchObject({ level: 'freeze', confirmed: 1, services: 'exchange', since: '2026-11-15T08:23:00Z' })
    expect(w.incidents()).toHaveLength(1)
    expect(w.incidents()[0]).toMatchObject({ owatch_name: 'exchange', owatch_family: 'Exchange', owatch_isopen: true, owatch_reminders: 0, owatch_failedrounds: 2 })
    expect(w.incidents()[0].owatch_firsterror).toMatch(/^HTTP 503 - ServiceUnavailable <html>/)

    for (let i = 0; i < 5; i++) expect((await w.round({ exchange: DOWN503 })).posted, `round ${i}: still failing, already announced`).toEqual([])
    const rem = await w.round({ exchange: DOWN503 })                                         // 60 minutes after the first message
    expect(rem.posted).toHaveLength(4)
    expect(rem.text).toContain('[STILL FAILING] exchange'); expect(rem.text).toContain('still failing (reminder): 1'); expect(rem.text).toContain('consecutive failures: 8')
    expect(w.incidents()[0]).toMatchObject({ owatch_isopen: true, owatch_reminders: 1, owatch_failedrounds: 8 })
    expect(JSON.parse(w.setting('ci_status').owatch_value).since).toBe('2026-11-15T08:23:00Z')   // freeze since the first confirmed round

    const rec = await w.round({})
    expect(rec.posted).toHaveLength(4)
    expect(rec.text!.split('\n')[0]).toBe(TITLES.recovered); expect(rec.text).toContain('[RECOVERED] exchange')
    expect(rec.text).toMatch(/Answering again\. Was failing since 2026-11-15T08:10:\S+ UTC \(about 8\d min, 8 failed round\(s\)\)\./)
    expect(w.target('exchange')).toMatchObject({ owatch_alertopen: false, owatch_failcount: 0 })
    expect(w.incidents()).toHaveLength(1)
    expect(w.incidents()[0]).toMatchObject({ owatch_isopen: false, owatch_closedat: '2026-11-15T09:33:00Z', owatch_reminders: 1, owatch_failedrounds: 8 })
    expect(w.incidents()[0].owatch_durationminutes).toBeGreaterThanOrEqual(80)
    expect((await w.round({})).posted).toEqual([])
    expect(w.sent.filter((x) => x.channel === 'teams')).toHaveLength(3)                      // open, reminder, recovered. Nothing else.
    for (const x of w.incidents()) { const { owatch_incidentid, ...cols } = x; expect(rowViolations('owatch_incident', cols)).toEqual([]) }
  })

  it('ONE message per round: several services, grouped by family, with the at-risk list and the Copilot note', async () => {
    const w = await world()
    const bad = { auth: NO_ANSWER, exchange: DOWN503, 'm365-copilot': DOWN503, 'power-bi': DOWN503 }
    await w.round({}); await w.round(bad)
    const { text, teams } = await w.round(bad)
    expect(teams).toHaveLength(1)
    const h = text!
    expect(h).toContain('New failures: 4')
    const order = ['== Copilot ==', '[NEW FAILURE] m365-copilot', '== Exchange ==', '[NEW FAILURE] exchange', '== Identity & platform ==', '[NEW FAILURE] auth', '== Power Platform & dashboards ==', '[NEW FAILURE] power-bi'].map((x) => h.indexOf(x))
    expect(order.every((x) => x >= 0)).toBe(true); expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(h).toContain("Result: no HTTP answer after 150 ms\n  Error: BadGateway Http request failed as there is an error: 'No such host is known.")
    // root cause first: ONE statement of the probable common cause, with its evidence and what cannot be known
    expect(h).toContain('PROBABLE COMMON CAUSE: sign-in (auth) is failing its probe.')
    expect(h).toContain('Evidence: 3 of the other 3 failing service(s) need sign-in; 28 monitored services need sign-in in total.')
    expect(h).toMatch(/At risk downstream: copilot-studio, .* and \d+ more\n/)
    expect(h).toContain('What the probes cannot know: the actual root cause')
    expect(h.indexOf('PROBABLE COMMON CAUSE')).toBeLessThan(h.indexOf('[NEW FAILURE]'))
    expect(h).not.toMatch(/At risk[^\n]*sharepoint-online/)                                  // unconfigured targets are never listed as at risk
    expect(h).toContain('Probable cause of the Copilot failure: services it reads from are failing too: exchange')
    expect(teams[0]).toContain('== Identity &amp; platform ==')
    expect(w.incidents().filter((x: any) => x.owatch_isopen)).toHaveLength(4)
    expect(JSON.parse(w.setting('ci_status').owatch_value)).toMatchObject({ level: 'freeze', failing: 4, confirmed: 4 })
  })

  it('an unexpected status for a target with alive codes alerts too (auth answering 404), and sign-in failing freezes CI at once', async () => {
    const w = await world()
    const bad = { auth: { statusCode: 404, body: 'gone' } }
    await w.round(bad)
    expect(JSON.parse(w.setting('ci_status').owatch_value)).toMatchObject({ level: 'freeze', confirmed: 0 })
    const { text } = await w.round(bad)
    expect(text).toContain('[NEW FAILURE] auth'); expect(text).toContain('Result: HTTP 404')
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
    expect(JSON.parse(w.setting('ci_status').owatch_value).level).toBe('freeze')                    // CI is not muted
    const { text } = await w.round({ teams: DOWN503 })                                               // 08:43: mute over
    expect(text).toContain('[NEW FAILURE] teams'); expect(text).toContain('consecutive failures: 4')
  })

  it('alert_enabled = no: no posts; bad setting values: defaults, no failed expression', async () => {
    const w = await world()
    w.setting('alert_enabled').owatch_value = 'no'
    for (let i = 0; i < 3; i++) expect((await w.round({ teams: DOWN503 })).posted).toEqual([])
    w.setting('alert_enabled').owatch_value = 'yes'
    w.setting('alert_confirm').owatch_value = 'two'; w.setting('alert_reminder_minutes').owatch_value = 'soon'; w.setting('alert_snooze_until').owatch_value = null
    const { posted, r } = await w.round({ teams: DOWN503 })
    expect(r.expressionErrors).toEqual([]); expect(posted).toHaveLength(4)
  })

  it('TEST message: alert_test = yes sends a clearly labelled test to EVERY channel within one run, then resets the flag', async () => {
    const w = await world({ sendTestAlert: true })
    expect(w.setting('alert_test').owatch_value).toBe('yes')
    const { posted, text } = await w.alertRun()                                // no probe round exists at all yet: the test still goes out
    expect(posted.map((x) => x.channel).sort()).toEqual(['slack', 'teams', 'webex', 'webhook'])
    expect(text!.split('\n')[0]).toBe(TITLES.test); expect(text).toContain('(TEST requested with the setting alert_test)'); expect(text).toContain('New failures: 0')
    expect(text).toContain(SAME_FATE)
    expect(w.setting('alert_test').owatch_value).toBe('no')
    expect(w.setting('last_alert_at').owatch_value).toBeTruthy()
    expect((await w.alertRun()).posted).toEqual([])                             // exactly once
  })

  it('one failing channel never blocks the others or the probes; its status shows a short error WITHOUT the webhook URL', async () => {
    const w = await world({ sendTestAlert: true })
    w.state.fails.slack = 'revoked'; w.state.fails.teams = 'The bot is not part of the conversation roster. ' + 'x'.repeat(600)
    const { r, posted } = await w.alertRun()
    expect(r.status).toBe('Succeeded')                                          // the failures are handled inside the flow
    expect(posted.map((x) => x.channel).sort()).toEqual(['webex', 'webhook'])   // the other two still got it
    expect(r.statuses.get('Post_teams')).toBe('Failed'); expect(r.statuses.get('Post_slack')).toBe('Failed'); expect(r.statuses.get('Post_webex')).toBe('Succeeded')
    const teamsErr = w.setting('last_delivery_teams').owatch_value as string
    expect(teamsErr).toMatch(/^FAILED 2026-11-15T08:00:00Z The bot is not part of the conversation roster/); expect(teamsErr.length).toBeLessThanOrEqual(CAPS.delivery)
    expect(w.setting('last_delivery_slack').owatch_value).toBe('FAILED 2026-11-15T08:00:00Z HTTP 404 NotFound')      // status code only
    expect(w.setting('last_delivery_webex').owatch_value).toBe('ok 2026-11-15T08:00:00Z')
    const everything = JSON.stringify(w.mock.db.owatch_settings) + JSON.stringify(w.mock.db.owatch_targets) + JSON.stringify(w.incidents())
    expect(everything).not.toMatch(/SECRET|hooks\.slack\.com|webexapis\.com|alerts\.example\.org/)
    expect((await w.probeRound({})).status).toBe('Succeeded')                   // probing carries on
    expect(r.secured.sort()).toEqual(['Post_slack', 'Post_webex', 'Post_webhook'])   // webhook actions keep inputs/outputs out of the run history
  })

  it('alert_channels_off silences chosen channels without redeploying', async () => {
    const w = await world({ sendTestAlert: true })
    w.setting('alert_channels_off').owatch_value = 'Slack, webex'
    const { posted } = await w.alertRun()
    expect(posted.map((x) => x.channel).sort()).toEqual(['teams', 'webhook'])
    expect(w.setting('last_delivery_slack').owatch_value ?? '').toBe('')
  })

  it('channel subsets: Slack only needs no Teams connection at all; Teams only uses no HTTP action', async () => {
    const slackOnly = await world({ teams: null, teamsConnectionId: null, webhooks: { slack: HOOKS.slack }, sendTestAlert: true })
    expect(slackOnly.res.alerts).toMatchObject({ status: 'on', channels: ['slack'] })
    expect(Object.keys(slackOnly.flows().alert.properties.connectionReferences)).toEqual(['shared_commondataserviceforapps'])
    expect(slackOnly.mock.db.connectionreferences.map((c: any) => c.connectionreferencelogicalname)).toEqual(['owatch_dataverse'])
    expect((await slackOnly.alertRun()).posted.map((x) => x.channel)).toEqual(['slack'])
    const teamsOnly = await world({ webhooks: {}, sendTestAlert: true })
    expect(JSON.stringify(teamsOnly.flows().alert)).not.toContain('"type":"Http"')
    expect((await teamsOnly.alertRun()).posted.map((x) => x.channel)).toEqual(['teams'])
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
    expect((await w.alertRun()).teams).toHaveLength(1)
    expect(w.target('teams').owatch_failcount).toBe(2)
  })

  it('if the bookkeeping row is missing the round is NOT judged (no duplicates possible) and the failed step is visible', async () => {
    const w = await world()
    w.mock.db.owatch_settings.splice(w.mock.db.owatch_settings.findIndex((s: any) => s.owatch_name === 'alert_last_round'), 1)
    await w.probeRound({ teams: DOWN503 })
    const { r, posted } = await w.alertRun({ check: false })
    expect(r.statuses.get('Save_round')).toBe('Failed'); expect(r.statuses.get('List_failing')).toBe('Skipped')
    expect(posted).toEqual([]); expect(w.target('teams').owatch_failcount ?? 0).toBe(0)
    expect(r.expressionErrors).toEqual([])
  })

  it('a missing CI status row does not stop alerting', async () => {
    const w = await world()
    w.mock.db.owatch_settings.splice(w.mock.db.owatch_settings.findIndex((s: any) => s.owatch_name === 'ci_status'), 1)
    await w.probeRound({ teams: DOWN503 }); await w.alertRun({ check: false })
    await w.probeRound({ teams: DOWN503 })
    const { posted, r } = await w.alertRun({ check: false })
    expect(r.statuses.get('Save_ci')).toBe('Failed'); expect(posted).toHaveLength(4)
  })

  it('hostile target names and error texts cannot inject markup or mentions; many failures are capped with "and N more"; sizes stay bounded', async () => {
    const w = await world()
    const evil = '<img src=x onerror=alert(1)>"&<!channel>' + 'A'.repeat(200)
    w.target('planner').owatch_name = evil.slice(0, 100)
    w.target('loop').owatch_family = '<script>fam</script>'
    w.target('forms').owatch_url = 'https://forms.office.com/?q=<script>&x="' + 'u'.repeat(400)
    const all: Record<string, Probe> = {}
    for (const t of w.mock.db.owatch_targets) all[t.owatch_name] = { statusCode: 500, body: '<script>alert("pwn")</script><a href="https://evil.example">x</a>\n<!here>' + '&<>"'.repeat(2000), code: '<b>Kind</b>' }
    await w.round(all)
    const { text, teams, slack, webex } = await w.round(all)
    expect(text).toContain('New failures: 34')
    expect(text).toContain(`... and ${34 - CAPS.detailed} more (see the dashboard).`)
    expect((text!.match(/\[NEW FAILURE\]/g) ?? []).length).toBe(CAPS.detailed)
    expect(text!.length).toBeLessThanOrEqual(worstCaseTextChars())
    // Teams: the only tags are the wrapper and line breaks
    const tags = new Set(teams[0].match(/<\/?[a-zA-Z!][^>]*>/g) ?? [])
    expect([...tags].sort()).toEqual(['</p>', '<br>', '<p>'])
    expect(teams[0].length).toBeLessThan(28000); expect(teams[0]).toContain('&lt;img src=x onerror=alert(1)&gt;')
    // Slack: no raw angle bracket at all, so no <!channel>, <!here> or <url|text>
    expect(slack[0]).not.toMatch(/[<>]/); expect(slack[0].length).toBeLessThanOrEqual(CAPS.slackEscaped)
    expect(webex[0].length).toBeLessThanOrEqual(CAPS.webexText)
    for (const x of w.incidents()) { const { owatch_incidentid, ...cols } = x; expect(rowViolations('owatch_incident', cols), x.owatch_name).toEqual([]) }
    expect(w.incidents()).toHaveLength(34)
    expect(w.setting('ci_status').owatch_value.length).toBeLessThanOrEqual(400); expect(JSON.parse(w.setting('ci_status').owatch_value).level).toBe('freeze')
  })

  it('a service name with an apostrophe still finds and closes its incident', async () => {
    const w = await world()
    w.target('planner').owatch_name = "o'brien's app"
    const bad = { "o'brien's app": DOWN503 }
    await w.round(bad); await w.round(bad)
    expect(w.incidents()).toHaveLength(1)
    await w.round({})
    expect(w.incidents()[0]).toMatchObject({ owatch_name: "o'brien's app", owatch_isopen: false })
  })

  it('the dashboard link appears only when its URL is stored and is https', async () => {
    const w = await world({ sendTestAlert: true })
    w.mock.db.owatch_settings.push({ owatch_settingid: '66666666-6666-6666-6666-666666666666', owatch_name: 'dashboard_url', owatch_value: 'https://apps.powerapps.com/play/e/x/a/y?a=1&b="2"' })
    const first = await w.alertRun()
    expect(first.text).toContain('\nDashboard: https://apps.powerapps.com/play/e/x/a/y?a=1&b="2"\n')
    expect(first.teams[0]).toContain('Dashboard: https://apps.powerapps.com/play/e/x/a/y?a=1&amp;b=&quot;2&quot;')
    w.setting('dashboard_url').owatch_value = 'javascript:alert(1)'; w.setting('alert_test').owatch_value = 'yes'
    expect((await w.alertRun()).text).not.toContain('Dashboard:')
  })

  it('seeded fuzz: 60 rounds of random failures, setting changes and channel outages agree with the reference at every step', async () => {
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
      if (rnd() < 0.05) w.setting('alert_channels_off').owatch_value = ['', 'slack', 'teams,webex'][Math.floor(rnd() * 3)]
      for (const c of CHANNELS) w.state.fails[c] = rnd() < 0.06 ? 'down' : undefined
      posts += (await w.round(bad)).posted.length              // round() asserts equality with the reference
    }
    expect(posts).toBeGreaterThan(10)
    // invariant: every open incident belongs to a target whose alert is open, one each
    const open = w.incidents().filter((x: any) => x.owatch_isopen).map((x: any) => x.owatch_name).sort()
    expect(open).toEqual(w.mock.db.owatch_targets.filter((t: any) => t.owatch_alertopen === true).map((t: any) => t.owatch_name).sort())
    expect(w.incidents().length).toBeGreaterThanOrEqual(3)
    expect(w.mock.problems).toEqual([])
  }, 30000)
})

// ------------------------------------------------------------------------------------------------
describe('generated alert flow: structure', () => {
  const sets = { target: 'owatch_targets', result: 'owatch_results', setting: 'owatch_settings', incident: 'owatch_incidents' }
  const cd = buildAlertClientData({ intervalMinutes: 10, channels: { teams: { groupId: TEAMS.groupId, channelId: TEAMS.channelId }, ...HOOKS }, sets })
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
    expect(new Set(all.map(([n]) => n.split('/').pop())).size).toBe(all.length)        // action names are unique across the whole flow
  })
  it('Teams: the Teams connector as Flow bot into the channel - not the HTTP connector', () => {
    const post = all.find(([n]) => n.endsWith('Post_teams'))![1]
    expect(post.inputs.host).toEqual({ apiId: '/providers/Microsoft.PowerApps/apis/shared_teams', connectionName: 'shared_teams', operationId: 'PostMessageToConversation' })
    expect(Object.keys(post.inputs.parameters).sort()).toEqual(['body/messageBody', 'body/recipient/channelId', 'body/recipient/groupId', 'location', 'poster'])
    expect(post.inputs.parameters).toMatchObject({ poster: 'Flow bot', location: 'Channel', 'body/recipient/groupId': TEAMS.groupId, 'body/recipient/channelId': TEAMS.channelId })
    expect(all.filter(([, a]) => a.inputs?.host?.connectionName === 'shared_teams')).toHaveLength(1)
  })
  it('Slack / Webex / webhook: POST {"text": ...} to the incoming webhook, no retries, secure inputs and outputs', () => {
    for (const c of ['slack', 'webex', 'webhook'] as const) {
      const post = all.find(([n]) => n.endsWith('Post_' + c))![1]
      expect(post.type).toBe('Http')
      expect(post.inputs).toMatchObject({ method: 'POST', uri: HOOKS[c], headers: { 'Content-Type': 'application/json' }, retryPolicy: { type: 'none' } })
      expect(Object.keys(post.inputs.body)).toEqual(['text'])
      expect(post.runtimeConfiguration.secureData.properties).toEqual(['inputs', 'outputs'])
      expect(post.limit.timeout).toBe('PT20S')
      // the status written for a webhook channel never uses an error MESSAGE (which could repeat the URL)
      expect(all.find(([n]) => n.endsWith('Status_' + c))![1].inputs.parameters['item/owatch_value']).not.toContain("['message']")
    }
    expect(all.filter(([, a]) => a.type === 'Http')).toHaveLength(3)
    // the webhook URLs appear exactly once each, only as the uri of their own action
    const text = JSON.stringify(cd)
    for (const u of Object.values(HOOKS)) expect(text.split(u).length - 1).toBe(1)
    expect(existingChannels(JSON.stringify(cd))).toEqual({ teams: { groupId: TEAMS.groupId, channelId: TEAMS.channelId }, ...HOOKS })
  })
  it('run-after protection: channels are independent, a failed evaluation still lets a TEST go out, state is saved before judging', () => {
    const top = cd.properties.definition.actions
    expect([...top.If_should_post.runAfter.If_new_round].sort()).toEqual(['Failed', 'Skipped', 'Succeeded', 'TimedOut'])
    const post = top.If_should_post.actions
    expect(post.S_del_slack.runAfter).toEqual({ If_teams: ['Succeeded', 'Failed', 'Skipped', 'TimedOut'] })
    expect(post.S_del_webex.runAfter).toEqual({ If_slack: ['Succeeded', 'Failed', 'Skipped', 'TimedOut'] })
    expect(post.If_slack.actions.Status_slack.runAfter).toEqual({ Post_slack: ['Succeeded', 'Failed', 'TimedOut'] })
    expect(post.Mark_sent.runAfter).toEqual({ If_webhook: ['Succeeded', 'Failed', 'Skipped', 'TimedOut'] })
    expect(top.If_new_round.actions.Save_round.runAfter).toEqual({})
    expect(top.If_new_round.actions.List_failing.runAfter).toEqual({ Save_round: ['Succeeded'] })
    expect(top.If_new_round.actions.For_each_interesting.runtimeConfiguration.concurrency.repetitions).toBe(1)
  })
  it('every Dataverse action names an existing entity set and only columns that exist', () => {
    const cols: Record<string, string[]> = { owatch_targets: [...Object.keys(columnSpec('owatch_target')), 'owatch_targetid', 'statecode'], owatch_results: [...Object.keys(columnSpec('owatch_result')), 'owatch_resultid'], owatch_settings: [...Object.keys(columnSpec('owatch_setting')), 'owatch_settingid'], owatch_incidents: [...Object.keys(columnSpec('owatch_incident')), 'owatch_incidentid'] }
    for (const [n, a] of all.filter(([, x]) => x.inputs?.host?.connectionName === 'shared_commondataserviceforapps')) {
      const p = a.inputs.parameters
      expect(Object.keys(cols), n).toContain(p.entityName)
      expect(['ListRecords', 'UpdateRecord', 'CreateRecord']).toContain(a.inputs.host.operationId)     // nothing is ever deleted by the alert flow
      if (a.inputs.host.operationId === 'CreateRecord') expect(p.entityName).toBe('owatch_incidents')
      for (const c of String(p.$select ?? '').split(',').filter(Boolean)) expect(cols[p.entityName], `${n} $select ${c}`).toContain(c)
      for (const c of [...String(p.$filter ?? '').matchAll(/\bowatch_[a-z]+\b/g)].map((m) => m[0])) expect(cols[p.entityName], `${n} $filter ${c}`).toContain(c)
      for (const c of String(p.$orderby ?? '').split(',').filter(Boolean).map((x) => x.trim().split(' ')[0])) expect(cols[p.entityName], `${n} $orderby ${c}`).toContain(c)
      for (const k of Object.keys(p).filter((k) => k.startsWith('item/'))) expect(cols[p.entityName], `${n} writes ${k}`).toContain(k.slice(5))
    }
    const known = new Set(Object.values(cols).flat())
    for (const c of new Set(JSON.stringify(cd).match(/\bowatch_[a-z]+\b/g))) if (!['owatch_dataverse', 'owatch_teams', ...Object.keys(cols)].includes(c)) expect(known.has(c), c).toBe(true)
  })
  it('every text the flow writes is bounded to its column (take / min / fixed values)', () => {
    const inc = all.find(([n]) => n.endsWith('Create_incident'))![1].inputs.parameters
    for (const [k, max] of [['owatch_name', 100], ['owatch_family', 100]] as const) expect(inc['item/' + k]).toMatch(new RegExp(`,${max}\\)$`))
    expect(inc['item/owatch_firsterror']).toMatch(/^@take\(.*,500\)$/)
    for (const [n, a] of all.filter(([name]) => /Status_|Save_ci|Mark_sent|Save_round|Clear_test/.test(name))) {
      const v = a.inputs.parameters['item/owatch_value']
      expect(/^@take\(.*,300\)$/.test(v) || v === 'no' || /^@outputs\('Ctx'\)\?\['(now|round)'\]$/.test(v) || n.endsWith('Save_ci'), `${n}: ${String(v).slice(0, 60)}`).toBe(true)
    }
  })
  it('every expression parses and has balanced quotes and parentheses', () => {
    const strings = (v: any): string[] => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [])
    const env = { now: () => 0, vars: new Map() }
    for (const s of strings(cd).filter((x) => x.includes('@') && !x.startsWith('https://'))) {
      let depth = 0; let inStr = false
      for (const ch of s) { if (ch === "'") inStr = !inStr; else if (!inStr && ch === '(') depth++; else if (!inStr && ch === ')') depth-- }
      expect(depth, s.slice(0, 80)).toBe(0); expect(inStr, s.slice(0, 80)).toBe(false)
      try { evaluate(s, env, { parent: null, results: new Map() }) } catch (e) { expect(String((e as Error).message), s.slice(0, 80)).not.toMatch(/expression syntax|unsupported function/) }
    }
  })
  it('without webhooks there is no URL in the definition except the schema', () => {
    const teamsOnly = JSON.stringify(buildAlertClientData({ intervalMinutes: 10, channels: { teams: { groupId: TEAMS.groupId, channelId: TEAMS.channelId } }, sets }))
    const urls = (teamsOnly.match(/https?:\/\/[A-Za-z0-9.-]+/g) ?? []).filter((u) => u !== 'https://')
    expect([...new Set(urls)]).toEqual(['https://schema.management.azure.com'])
    expect(teamsOnly).not.toMatch(/hc-ping|Bearer |password|client_secret/i)
  })
})

describe('webhook URL validation (the URL is a credential: never echoed)', () => {
  it('accepts the documented shapes', () => {
    expect(assertWebhookUrl('slack', HOOKS.slack)).toBe(HOOKS.slack); expect(assertWebhookUrl('webex', HOOKS.webex)).toBe(HOOKS.webex); expect(assertWebhookUrl('webhook', HOOKS.webhook)).toBe(HOOKS.webhook)
  })
  it('rejects everything else without repeating the value', () => {
    const bad: [string, string][] = [['slack', 'http://hooks.slack.com/services/T0/B0/SECRETxyz'], ['slack', 'https://hooks.slack.com.evil.example/services/T0/B0/SECRETxyz'], ['slack', 'https://evil.example/services/SECRETxyz12345'],
      ['webex', 'https://webexapis.com/v1/messages?SECRETxyz=1'], ['webex', 'https://webexapis.com.evil.example/v1/webhooks/incoming/SECRETxyz'], ['webhook', 'https://user:SECRETxyz@host.example/hook'],
      ['webhook', 'https://localhost/SECRETxyz-hook-path'], ['webhook', 'https://host.example/hook SECRETxyz'], ['webhook', 'ftp://host.example/SECRETxyz-hook'], ['pager', 'https://host.example/SECRETxyz-hook'], ['webhook', '']]
    for (const [kind, u] of bad) {
      let msg = ''
      try { assertWebhookUrl(kind, u) } catch (e) { msg = (e as Error).message }
      expect(msg, `${kind} ${u}`).toMatch(/webhook URL not accepted/); expect(msg).not.toContain('SECRET')
    }
  })
})
