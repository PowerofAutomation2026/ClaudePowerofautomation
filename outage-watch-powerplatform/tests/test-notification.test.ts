/**
 * The "Send test notification now" button: command row -> third flow -> per-channel result on the row.
 *   1. reference lifecycle (provision/lib/test-logic.mjs);
 *   2. the GENERATED flow is executed with the workflow-language interpreter against the mock Dataverse and must
 *      produce the reference message (per channel encoding) and the reference result / status;
 *   3. duplicate trigger, rate limit, channel failure combinations, hostile note, permission denied, CLI exit codes.
 * Not Microsoft's engine, not a real channel: see DESIGN.md "Unconfirmed".
 */
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs helpers
import { createClient } from '../provision/lib/client.mjs'
// @ts-expect-error plain .mjs helpers
import { createMockDataverse } from '../provision/lib/mock-dataverse.mjs'
// @ts-expect-error plain .mjs helpers
import { apply, requestTestNotification } from '../provision/lib/provision.mjs'
// @ts-expect-error plain .mjs helpers
import { CHANNELS, SAME_FATE, buildAlertClientData } from '../provision/lib/alert-flow.mjs'
// @ts-expect-error plain .mjs helpers
import { latestCompleteRound, slackText, teamsHtml, utf8Bytes, webexText, webhookText } from '../provision/lib/alert-logic.mjs'
// @ts-expect-error plain .mjs helpers
import { COMMAND_NAME, RATE_LIMIT_SECONDS, TEST_TITLE, buildTestClientData, estimateTestRequests } from '../provision/lib/test-flow.mjs'
// @ts-expect-error plain .mjs helpers
import { commandDecision, commandResult, selectedChannels, testText } from '../provision/lib/test-logic.mjs'
// @ts-expect-error plain .mjs helpers
import { columnSpec, rowViolations, seedSettings } from '../provision/lib/schema.mjs'
// @ts-expect-error plain .mjs helpers
import { parseTeamsChannelLink } from '../provision/lib/validate.mjs'
// @ts-expect-error plain .mjs helpers
import { mockConnector, runFlow } from './helpers/wdl.mjs'
// @ts-expect-error plain .mjs helpers
import { EXIT, main } from '../provision/owpp.mjs'

/* eslint-disable @typescript-eslint/no-explicit-any */
const LINK = 'https://teams.microsoft.com/l/channel/19%3AaBc123_-xyz%40thread.tacv2/Ops%20Alerts?groupId=11111111-2222-3333-4444-555555555555&tenantId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const HOOKS = { slack: 'https://hooks.slack.com/services/T000SECRET/B000SECRET/slackSECRETtoken', webex: 'https://webexapis.com/v1/webhooks/incoming/webexSECRETid', webhook: 'https://alerts.example.org/hook/genericSECRET' }
const OPTS = { intervalMinutes: 10, retentionDays: 7, timeoutSeconds: 10, tenant: null, connectionId: 'aaaaaaaabbbbccccddddeeeeeeeeeeee', teamsConnectionId: 'ffffffffbbbbccccddddeeeeeeeeeeee', teams: parseTeamsChannelLink(LINK), webhooks: HOOKS, heartbeatUrl: null }
const closers: (() => Promise<void>)[] = []
afterEach(async () => { while (closers.length) await closers.pop()!() })
const MIN = 60_000
const ENC: Record<string, (t: string) => string> = { teams: teamsHtml, slack: slackText, webex: webexText, webhook: webhookText }

async function world(extra: any = {}) {
  const mock = createMockDataverse({ autoRun: false })
  const srv = await mock.listen(); closers.push(srv.close)
  const client = createClient({ orgUrl: srv.url, token: mock.token, sleep: async () => {} })
  const res = await apply(client, { ...OPTS, ...extra })
  const flow = (name: string) => JSON.parse(mock.db.workflows.find((w: any) => w.name === name).clientdata)
  let clock = Date.parse('2026-11-15T08:00:00Z')
  const sent: { channel: string; body: string }[] = []
  const teams: any[] = []
  const fails: Record<string, string | undefined> = {}
  const env = () => ({ now: () => clock, advance: (ms: number) => { clock += ms }, connector: async (api: string, op: string, p: any) => {
    const before = teams.length
    const r = await mockConnector(mock, { teams, teamsFails: () => fails.teams ?? null })(api, op, p)
    if (teams.length > before) sent.push({ channel: 'teams', body: teams[teams.length - 1].html })
    return r
  } })
  const hooks = async (inputs: any) => {
    const channel = Object.entries(HOOKS).find(([, u]) => u === inputs.uri)?.[0]
    if (!channel || inputs.method !== 'POST') throw new Error('unexpected HTTP call')
    if (typeof inputs.body?.text !== 'string') return { statusCode: 400, code: 'BadRequest', body: 'no text', elapsedMs: 0 }
    if (fails[channel]) return { statusCode: 404, code: 'NotFound', body: `no_service ${inputs.uri}`, message: `The webhook ${inputs.uri} was not found`, elapsedMs: 0 }
    sent.push({ channel, body: inputs.body.text })
    return { statusCode: 200, body: 'ok', elapsedMs: 0 }
  }
  const settings = () => Object.fromEntries(mock.db.owatch_settings.map((s: any) => [s.owatch_name, s.owatch_value ?? undefined]))
  const commands = () => (mock.db.owatch_commands ?? []) as any[]
  async function probeRound(bad: Record<string, any> = {}) {
    const start = clock
    const byUrl = new Map(mock.db.owatch_targets.map((t: any) => [t.owatch_url, t.owatch_name]))
    await runFlow(flow('Outage Watch - probe'), { ...env(), http: async (inputs: any) => { const b = bad[byUrl.get(inputs.uri) as string]; return b ? { elapsedMs: 150, ...b } : { statusCode: 200, body: 'ok', elapsedMs: 120 } } })
    clock = start + 3 * MIN
  }
  /** what the dashboard / CLI does: one row */
  async function press(row: any = {}) {
    const r = await client.post('owatch_commands', { owatch_name: COMMAND_NAME, owatch_channels: 'all', owatch_status: 'queued', owatch_requestedby: 'Ada Admin', ...row })
    return r.entityId as string
  }
  /** the Dataverse trigger fires for a row: runs the generated flow and checks it against the reference */
  async function fire(id: string, { check = true } = {}) {
    const nowMs = clock
    const before = { ...commands().find((c) => c.owatch_commandid === id) }
    const s = settings()
    const decision = commandDecision(before, s, nowMs)
    const round = latestCompleteRound([...new Set(mock.db.owatch_results.map((x: any) => x.owatch_round))], nowMs)
    const text = testText({ command: before, settings: s, nowMs, round, targets: mock.db.owatch_targets.filter((t: any) => (t.statecode ?? 0) === 0).map((t: any) => ({ ...t })), roundRows: mock.db.owatch_results.filter((x: any) => x.owatch_round === round).map((x: any) => ({ ...x })) })
    const n = sent.length
    const r = await runFlow(flow('Outage Watch - test notification'), { ...env(), http: hooks, trigger: { body: { owatch_commandid: id, owatch_name: before.owatch_name } } })
    const posted = sent.slice(n)
    const after = commands().find((c) => c.owatch_commandid === id)
    if (check) {
      expect(r.expressionErrors, 'no expression may fail').toEqual([])
      expect(r.status).toBe('Succeeded')
      if (decision === 'ignore') { expect(posted).toEqual([]); expect(after?.owatch_status).toBe(before.owatch_status) }
      if (decision === 'reject') { expect(posted).toEqual([]); expect(after.owatch_status).toBe('rejected'); expect(after.owatch_result).toContain('rate limit') }
      if (decision === 'send') {
        const selected = selectedChannels(before, res.alerts.channels)
        const outcome = Object.fromEntries(selected.filter((c: string) => fails[c]).map((c: string) => [c, c === 'teams' ? 'FAILED Forbidden' : 'FAILED HTTP 404']))
        const want = commandResult(res.alerts.channels, selected, outcome)
        expect({ status: after.owatch_status, result: after.owatch_result }).toEqual(want)
        expect(after.owatch_completedat).toBeTruthy()
        expect(posted.map((x) => x.channel).sort()).toEqual(selected.filter((c: string) => !fails[c]).sort())
        for (const x of posted) expect(x.body, `${x.channel} message`).toBe(ENC[x.channel](text))
        expect(settings().last_test_at).toBe(new Date(nowMs).toISOString().replace(/\.\d+Z$/, 'Z'))
      }
      for (const c of commands()) { const { owatch_commandid: _i, createdon: _c, ...cols } = c; void _i; void _c; expect(rowViolations('owatch_command', cols), 'command row fits its columns').toEqual([]) }
    }
    return { r, posted, after, text, decision }
  }
  return { url: srv.url, mock, client, res, flow, sent, fails, settings, commands, probeRound, press, fire, tick: (ms: number) => { clock += ms }, now: () => clock, env, hooks }
}

describe('test notification: reference lifecycle', () => {
  const now = Date.parse('2026-11-15T08:00:00Z')
  it('only a queued row named test_notification is processed; a recent test is rejected', () => {
    expect(commandDecision({ owatch_name: 'test_notification', owatch_status: 'queued' }, {}, now)).toBe('send')
    expect(commandDecision({ owatch_name: 'Test_Notification', owatch_status: 'QUEUED' }, { last_test_at: '' }, now)).toBe('send')
    for (const st of ['sending', 'done', 'partial', 'failed', 'rejected', '', undefined]) expect(commandDecision({ owatch_name: 'test_notification', owatch_status: st }, {}, now)).toBe('ignore')
    expect(commandDecision({ owatch_name: 'something_else', owatch_status: 'queued' }, {}, now)).toBe('ignore')
    expect(commandDecision(null, {}, now)).toBe('ignore')
    expect(commandDecision({ owatch_name: 'test_notification', owatch_status: 'queued' }, { last_test_at: '2026-11-15T07:56:00Z' }, now)).toBe('reject')
    expect(commandDecision({ owatch_name: 'test_notification', owatch_status: 'queued' }, { last_test_at: '2026-11-15T07:54:59Z' }, now)).toBe('send')
  })
  it('channel selection: all, a list, unknown names ignored, never a channel that is not configured', () => {
    expect(selectedChannels({ owatch_channels: 'all' }, ['teams', 'slack'])).toEqual(['teams', 'slack'])
    expect(selectedChannels({}, ['webex'])).toEqual(['webex'])
    expect(selectedChannels({ owatch_channels: ' Slack , WEBEX ' }, CHANNELS)).toEqual(['slack', 'webex'])
    expect(selectedChannels({ owatch_channels: 'webhook,pagerduty' }, ['teams', 'slack'])).toEqual([])
    expect(selectedChannels({ owatch_channels: 'teamsx' }, CHANNELS)).toEqual([])
  })
  it('result string and status: done / partial / failed; never longer than the column', () => {
    expect(commandResult(['teams', 'slack'], ['teams', 'slack'], {})).toEqual({ status: 'done', result: 'teams=delivered; slack=delivered; webex=not configured; webhook=not configured' })
    expect(commandResult(CHANNELS, ['teams', 'slack'], { slack: 'FAILED HTTP 404' })).toEqual({ status: 'partial', result: 'teams=delivered; slack=FAILED HTTP 404; webex=not selected; webhook=not selected' })
    expect(commandResult(CHANNELS, CHANNELS, Object.fromEntries(CHANNELS.map((c: string) => [c, 'FAILED HTTP 500']))).status).toBe('failed')
    expect(commandResult(['slack'], [], {}).status).toBe('failed')
    expect(commandResult(CHANNELS, CHANNELS, Object.fromEntries(CHANNELS.map((c: string) => [c, 'FAILED ' + 'x'.repeat(60)]))).result.length).toBeLessThanOrEqual(columnSpec('owatch_command').owatch_result.maxLength)
  })
  it('the schema has the command table, the rate-limit setting, and the estimate matches the generated flow', () => {
    expect(Object.keys(columnSpec('owatch_command')).sort()).toEqual(['owatch_channels', 'owatch_completedat', 'owatch_name', 'owatch_note', 'owatch_requestedby', 'owatch_result', 'owatch_status'])
    expect(seedSettings({ intervalMinutes: 10, retentionDays: 7, timeoutSeconds: 10 }).map((s: any) => s.name)).toContain('last_test_at')
    expect(estimateTestRequests(4)).toEqual({ perTest: 35, rejected: 11, worstCasePerDay: 288 * 35 })
    expect(RATE_LIMIT_SECONDS).toBe(300)
  })
})

describe('test notification: the generated flow, executed', () => {
  it('all services answering: every configured channel gets the TEST message; the row ends as done', async () => {
    const w = await world()
    await w.probeRound()
    const id = await w.press({ owatch_note: 'checking the wiring' })
    const { r, posted, text, after } = await w.fire(id)
    expect(posted).toHaveLength(4)
    expect(text.startsWith(TEST_TITLE)).toBe(true)
    expect(text).toContain('Requested by: Ada Admin at 2026-11-15T08:03:00Z UTC')
    expect(text).toContain('Note: checking the wiring')
    expect(text).toContain('Level: ok | probe round: 2026-11-15T08:00:00Z (3 min ago)')
    expect(text).toContain('All 34 probed services answered in that round.')
    expect(text.endsWith(SAME_FATE)).toBe(true)
    expect(after.owatch_result).toBe('teams=delivered; slack=delivered; webex=delivered; webhook=delivered')
    expect(r.count).toBe(estimateTestRequests(4).perTest)
    // the alert state of the targets is untouched: a test is not an alert
    expect(w.mock.db.owatch_targets.every((t: any) => (t.owatch_failcount ?? 0) === 0 && t.owatch_alertopen !== true)).toBe(true)
    expect((w.mock.db.owatch_incidents ?? [])).toEqual([])
  })
  it('failing services: names, HTTP status, time, error text, families; auth failing -> freeze + lead text', async () => {
    const w = await world()
    await w.probeRound({ 'github-copilot': { statusCode: 503, body: 'upstream <b>down</b>' }, auth: { code: 'Timeout', message: 'no answer @channel <!here>', timedOut: true }, graph: { statusCode: 500, body: 'x' } })
    const { text, posted } = await w.fire(await w.press())
    expect(text).toContain('Level: freeze')
    expect(text).toMatch(/3 of 34 probed services are failing:\n- auth: no HTTP answer after \d+ ms - /)
    expect(text).toContain('- github-copilot: HTTP 503 after')
    expect(text).toMatch(/- graph: HTTP 500 after \d+ ms - /)
    expect(text).toContain('no answer @channel <!here>')
    expect(text).toContain('Families with failures: ')
    const slack = posted.find((x) => x.channel === 'slack')!.body
    expect(slack).not.toContain('<!here>'); expect(slack).toContain('&lt;!here&gt;')
    expect(posted.find((x) => x.channel === 'teams')!.body).not.toMatch(/<b>down<\/b>/)
  })
  it('more than 10 failing: 10 lines and "... and N more"; every message stays inside its byte cap', async () => {
    const w = await world()
    const names = w.mock.db.owatch_targets.filter((t: any) => (t.statecode ?? 0) === 0).map((t: any) => t.owatch_name)
    await w.probeRound(Object.fromEntries(names.map((n: string) => [n, { statusCode: 500, body: '\u{1F525}'.repeat(600) }])))
    const { text, posted } = await w.fire(await w.press({ owatch_note: '\u{1F600}'.repeat(100) }))
    expect(text).toContain('... and 24 more (see the dashboard).')
    expect((text.match(/^- /gm) ?? []).length).toBe(10)
    expect(utf8Bytes(posted.find((x) => x.channel === 'webex')!.body)).toBeLessThanOrEqual(7439)
    expect(utf8Bytes(posted.find((x) => x.channel === 'teams')!.body)).toBeLessThanOrEqual(28000)
    expect(utf8Bytes(posted.find((x) => x.channel === 'slack')!.body)).toBeLessThanOrEqual(40000)
  })
  it('no probe round yet: says so instead of claiming everything is fine', async () => {
    const w = await world()
    const { text, after } = await w.fire(await w.press())
    expect(text).toContain('Level: unknown (no probe round yet)')
    expect(after.owatch_status).toBe('done')
  })
  it('chooser: only the selected channels are posted to; an unknown or unconfigured selection fails without posting', async () => {
    const w = await world()
    await w.probeRound()
    const a = await w.fire(await w.press({ owatch_channels: 'slack,webex' }))
    expect(a.after.owatch_result).toBe('teams=not selected; slack=delivered; webex=delivered; webhook=not selected')
    w.tick(6 * MIN)
    const b = await w.fire(await w.press({ owatch_channels: 'pagerduty' }))
    expect(b.posted).toEqual([]); expect(b.after.owatch_status).toBe('failed')
    const only = await world({ teams: null, webhooks: { slack: HOOKS.slack } })
    await only.probeRound()
    const c = await only.fire(await only.press({ owatch_channels: 'teams' }))
    expect(c.posted).toEqual([]); expect(c.after).toMatchObject({ owatch_status: 'failed', owatch_result: 'teams=not configured; slack=not selected; webex=not configured; webhook=not configured' })
  })
  it('every combination of failing channels: the others are still delivered, the row says which failed (status only, never a URL)', async () => {
    const w = await world()
    await w.probeRound()
    for (let mask = 0; mask < 16; mask++) {
      for (const [i, c] of CHANNELS.entries()) w.fails[c] = mask & (1 << i) ? 'channel says no' : undefined
      w.tick(6 * MIN)
      const { after } = await w.fire(await w.press())
      expect(after.owatch_status).toBe(mask === 0 ? 'done' : mask === 15 ? 'failed' : 'partial')
      expect(JSON.stringify(w.commands())).not.toMatch(/SECRET|hooks\.slack|webexapis|example\.org/)
    }
  }, 30000)
  it('duplicate trigger for the same row: the second run does nothing', async () => {
    const w = await world()
    await w.probeRound()
    const id = await w.press()
    const first = await w.fire(id)
    expect(first.posted).toHaveLength(4)
    const again = await w.fire(id)
    expect(again.decision).toBe('ignore'); expect(again.posted).toEqual([])
    expect(w.sent).toHaveLength(4)
    // a row that is not a test command, and a trigger for a row that no longer exists
    const other = await w.fire(await w.press({ owatch_name: 'something_else' }))
    expect(other.posted).toEqual([])
    const gone = await runFlow(w.flow('Outage Watch - test notification'), { ...w.env(), http: w.hooks, trigger: { body: { owatch_commandid: '00000000-0000-4000-8000-000000000000' } } })
    expect(gone.expressionErrors).toEqual([]); expect(gone.status).toBe('Succeeded'); expect(w.sent).toHaveLength(4)
  })
  it('rate limit: a second test inside 5 minutes is rejected with a reason and posts nothing; after 5 minutes it works again', async () => {
    const w = await world()
    await w.probeRound()
    await w.fire(await w.press())
    w.tick(2 * MIN)
    const second = await w.fire(await w.press())
    expect(second.decision).toBe('reject'); expect(second.after.owatch_result).toBe('rate limit: one test every 5 minutes')
    expect(second.r.count).toBe(estimateTestRequests(4).rejected)
    w.tick(3 * MIN + 1000)
    const third = await w.fire(await w.press())
    expect(third.decision).toBe('send'); expect(third.posted).toHaveLength(4)
  })
  it('hostile note and requester: mentions, links, markup, RTL / zero-width, newlines are escaped per channel and bounded', async () => {
    const w = await world()
    await w.probeRound()
    const note = '<!channel> <@U123> @all <at>x</at> <script>alert(1)</script> [x](javascript:alert(1)) **b** ‮evil​ `c`'
    const { posted, text } = await w.fire(await w.press({ owatch_note: note, owatch_requestedby: '<img src=x onerror=alert(1)>\n@everyone' }))
    expect(text.split('\n')[1]).toContain('Requested by: <img src=x onerror=alert(1)> @everyone at ')      // one line: the newline cannot forge a second line
    const by = Object.fromEntries(posted.map((x) => [x.channel, x.body]))
    expect(by.teams).not.toMatch(/<script|<img|<at>/i)
    expect(by.slack).not.toMatch(/<!channel>|<@U123>/)
    // Webex and the generic webhook receive it in the plain "text" field (never "markdown" / HTML): sent as is, not interpreted
    for (const c of CHANNELS) expect(by[c]).toBe(ENC[c](text))
  })
  it('old command rows are pruned (older than 7 days), recent ones kept', async () => {
    const w = await world()
    await w.probeRound()
    const old = await w.press({ owatch_status: 'done' }); const recent = await w.press({ owatch_status: 'done' })
    w.commands().find((c) => c.owatch_commandid === old).createdon = new Date(w.now() - 8 * 24 * 60 * MIN).toISOString()
    w.commands().find((c) => c.owatch_commandid === recent).createdon = new Date(w.now() - 6 * 24 * 60 * MIN).toISOString()
    await w.fire(await w.press())
    const ids = w.commands().map((c) => c.owatch_commandid)
    expect(ids).not.toContain(old); expect(ids).toContain(recent)
  })
  it('the flow definition: Dataverse row-added trigger on the command table, one run at a time, same post actions as the alert flow, secrets only in secured actions', async () => {
    const w = await world()
    const def = w.flow('Outage Watch - test notification').properties.definition
    const trig = def.triggers.When_a_command_is_added
    expect(trig.type).toBe('OpenApiConnectionWebhook')
    expect(trig.inputs.host.operationId).toBe('SubscribeWebhookTrigger')
    expect(trig.inputs.parameters).toEqual({ 'subscriptionRequest/message': 1, 'subscriptionRequest/entityname': 'owatch_command', 'subscriptionRequest/scope': 4 })
    expect(trig.runtimeConfiguration.concurrency.runs).toBe(1)
    const find = (actions: any, name: string): any => { for (const [k, v] of Object.entries<any>(actions ?? {})) { if (k === name) return v; const d = find(v.actions, name) ?? find(v.else?.actions, name); if (d) return d } return null }
    const alert = w.flow('Outage Watch - alert').properties.definition
    for (const c of CHANNELS) {
      const mine = find(def.actions, `Post_${c}`); const theirs = find(alert.actions, `Post_${c}`)
      expect(mine, c).toBeTruthy()
      const strip = (a: any) => JSON.parse(JSON.stringify({ ...a, runAfter: undefined }).replace(/outputs\('Message'\)/g, 'TEXT').replace(/outputs\('Text'\)/g, 'TEXT'))
      expect(strip(mine).type).toBe(strip(theirs).type)
      expect(strip(mine).inputs?.uri).toBe(strip(theirs).inputs?.uri)
      expect(strip(mine).runtimeConfiguration).toEqual(strip(theirs).runtimeConfiguration)
      if (c !== 'teams') expect(mine.runtimeConfiguration.secureData.properties).toEqual(['inputs', 'outputs'])
    }
    const text = JSON.stringify(def)
    for (const u of Object.values(HOOKS)) expect(text.split(u).length - 1).toBe(1)
    void buildAlertClientData; void buildTestClientData
  })
})

describe('test notification: requesting it (dashboard / CLI path)', () => {
  it('requestTestNotification creates one command row, waits, and returns the per-channel result', async () => {
    const w = await world()
    await w.probeRound()
    let fired = false
    const r = await requestTestNotification(w.client, { channels: 'slack', note: 'from the CLI', requestedBy: 'command line', waitSeconds: 60, pollSeconds: 1, now: () => w.now(), sleep: async () => { w.tick(1000); if (!fired) { fired = true; await w.fire(w.commands()[0].owatch_commandid) } } })
    expect(r).toMatchObject({ status: 'done', result: 'teams=not selected; slack=delivered; webex=not selected; webhook=not selected' })
    expect(w.commands()).toHaveLength(1)
    expect(w.sent.map((x) => x.channel)).toEqual(['slack'])
  })
  it('the flow never answers (turned off): timeout with a clear message, no hang', async () => {
    const w = await world()
    const r = await requestTestNotification(w.client, { waitSeconds: 10, pollSeconds: 1, now: () => w.now(), sleep: async () => { w.tick(1000) } })
    expect(r.status).toBe('timeout'); expect(r.result).toContain('Outage Watch - test notification')
    expect(w.commands()[0].owatch_status).toBe('queued')
  })
  it('permission denied (no Create privilege on the command table): 403 is reported, nothing is sent', async () => {
    const w = await world()
    w.mock.state.denyCreate = 'owatch_commands'
    await expect(requestTestNotification(w.client, {})).rejects.toMatchObject({ status: 403 })
    expect(w.commands()).toEqual([]); expect(w.sent).toEqual([])
  })
  it('an over-long note is refused before anything is written (column limit)', async () => {
    const w = await world()
    await expect(requestTestNotification(w.client, { note: 'x'.repeat(201) })).rejects.toThrow(/owatch_note/)
    expect(w.commands()).toEqual([])
  })
  it('CLI: bad channel list / long note are input errors; denied -> exit 1; no answer -> exit 8; never prints a secret', async () => {
    const w = await world()
    const logs: string[] = []; const orig = [console.log, console.error]
    console.log = (...a: any[]) => { logs.push(a.join(' ')) }; console.error = (...a: any[]) => { logs.push(a.join(' ')) }
    const env = { ...process.env }
    try {
      process.env.OWPP_TEST_MODE = '1'; process.env.OWPP_TOKEN = w.mock.token
      const url = w.url
      expect(await main(['test-notification', '--org-url', url, '--channels', 'teams;slack'])).toBe(EXIT.badInput)
      expect(await main(['test-notification', '--org-url', url, '--note', 'x'.repeat(201)])).toBe(EXIT.badInput)
      expect(await main(['test-notification', '--org-url', url, '--wait-seconds', '0'])).toBe(EXIT.testTimeout)
      w.mock.state.denyCreate = 'owatch_commands'
      expect(await main(['test-notification', '--org-url', url, '--wait-seconds', '0'])).toBe(EXIT.failed)
      expect(logs.join('\n')).toMatch(/prvCreate|privilege/)
      expect(logs.join('\n')).not.toMatch(/SECRET|test-token/)
    } finally { console.log = orig[0]; console.error = orig[1]; process.env = env }
  })
})
