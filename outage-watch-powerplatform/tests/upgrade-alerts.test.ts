/**
 * Upgrade from the CURRENTLY DEPLOYED state (commit 24090f5: 3 tables, 36 targets, probe flow ON, no alert
 * columns, no incident table, no alert flow) to this version, on the mock Dataverse. The old probe-flow
 * definition is the real one from that commit (tests/helpers/flow-24090f5.mjs).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
// @ts-expect-error plain .mjs helpers
import { createClient } from '../provision/lib/client.mjs'
// @ts-expect-error plain .mjs helpers
import { createMockDataverse } from '../provision/lib/mock-dataverse.mjs'
// @ts-expect-error plain .mjs helpers
import { apply, uninstall, NeedsTeamsConnection } from '../provision/lib/provision.mjs'
// @ts-expect-error plain .mjs helpers
import { existingChannels } from '../provision/lib/alert-flow.mjs'
// @ts-expect-error plain .mjs helpers
import { rowViolations, seedSettings } from '../provision/lib/schema.mjs'
// @ts-expect-error plain .mjs helpers
import { parseTeamsChannelLink } from '../provision/lib/validate.mjs'
// @ts-expect-error test fixture
import { buildClientData as oldProbeFlow } from './helpers/flow-24090f5.mjs'

/* eslint-disable @typescript-eslint/no-explicit-any */
const LINK = 'https://teams.microsoft.com/l/channel/19%3AaBc123_-xyz%40thread.tacv2/Ops%20Alerts?groupId=11111111-2222-3333-4444-555555555555&tenantId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const BASE = { intervalMinutes: 10, retentionDays: 7, timeoutSeconds: 10, tenant: null, connectionId: 'aaaaaaaabbbbccccddddeeeeeeeeeeee', heartbeatUrl: null }
const SLACK = 'https://hooks.slack.com/services/T000SECRET/B000SECRET/slackSECRETtoken'
const closers: (() => Promise<void>)[] = []
afterEach(async () => { while (closers.length) await closers.pop()!() })
const NEW_TARGET_COLS = ['owatch_failcount', 'owatch_failingsince', 'owatch_lastok', 'owatch_alertopen', 'owatch_lastalertat']
const NEW_RESULT_COLS = ['owatch_errormessage', 'owatch_failed']

/** A mock environment rewound to what commit 24090f5 deployed. */
async function deployed24090f5() {
  const mock = createMockDataverse({ autoRun: false }); const srv = await mock.listen(); closers.push(srv.close)
  const client = createClient({ orgUrl: srv.url, token: mock.token, sleep: async () => {} })
  await apply(client, BASE)
  const db = mock.db
  // no incident table, no alert columns
  db.owatch_incidents = undefined; mock.entities.delete('owatch_incident')
  delete db.owatch_commands; mock.entities.delete('owatch_command')
  for (const c of NEW_TARGET_COLS) { mock.entities.get('owatch_target').attributes.delete(c); for (const r of db.owatch_targets) delete r[c] }
  for (const c of NEW_RESULT_COLS) mock.entities.get('owatch_result').attributes.delete(c)
  // settings exactly as that version wrote them
  const old = new Set(['interval_minutes', 'retention_days', 'probe_timeout_seconds', 'schema_version', 'heartbeat_configured', 'confirm', 'factor', 'floor_ms', 'slow_ms', 'recover_after', 'flow_workflowid'])
  expect(seedSettings({ ...BASE, heartbeat: false }).filter((s: any) => old.has(s.name))).toHaveLength(10)
  db.owatch_settings = db.owatch_settings.filter((s: any) => old.has(s.owatch_name))
  db.owatch_settings.find((s: any) => s.owatch_name === 'schema_version').owatch_value = '2'
  // the probe flow as that version built it, turned ON, with a week of result rows it wrote
  const flow = db.workflows.find((w: any) => w.name === 'Outage Watch - probe')
  flow.clientdata = JSON.stringify(oldProbeFlow({ ...BASE, heartbeatUrl: 'https://hc-ping.example.com/keepSECRETbeat', sets: { target: 'owatch_targets', result: 'owatch_results' } }))
  flow.statecode = 1
  db.workflows = [flow]
  db.owatch_results = db.owatch_targets.filter((t: any) => t.owatch_enabled).map((t: any, i: number) => ({ owatch_resultid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, owatch_name: t.owatch_name, owatch_httpstatus: 200, owatch_elapsedms: 100 + i, owatch_errorkind: null, owatch_probedat: '2026-11-14T12:00:00Z', owatch_round: '2026-11-14T12:00:00Z' }))
  // an admin edit that must survive
  db.owatch_targets.find((t: any) => t.owatch_name === 'planner').owatch_enabled = false
  db.owatch_settings.find((s: any) => s.owatch_name === 'confirm').owatch_value = '3'
  mock.log.length = 0
  return { mock, client, flowId: flow.workflowid as string, targetsBefore: JSON.stringify(db.owatch_targets), resultsBefore: JSON.stringify(db.owatch_results) }
}

describe('upgrade from the deployed version (24090f5) to alerts + incidents + CI status', () => {
  it('re-run WITHOUT any channel: adds table, columns and settings; probe flow updated in place; no alert flow; nothing lost', async () => {
    const e = await deployed24090f5()
    const r = await apply(e.client, BASE)
    expect(e.mock.problems).toEqual([])
    expect(r.created.filter((c: string) => c.startsWith('table '))).toEqual(['table owatch_command', 'table owatch_incident'])
    expect(r.created.filter((c: string) => c.startsWith('column owatch_target.') || c.startsWith('column owatch_result.')).sort()).toEqual([...NEW_RESULT_COLS.map((c) => 'column owatch_result.' + c), ...NEW_TARGET_COLS.map((c) => 'column owatch_target.' + c)].sort())
    expect(r.created.some((c: string) => c.startsWith('target '))).toBe(false)
    expect(JSON.stringify(e.mock.db.owatch_targets)).toBe(e.targetsBefore)                    // 36 rows byte-for-byte, incl. the admin's disabled one
    expect(JSON.stringify(e.mock.db.owatch_results)).toBe(e.resultsBefore)                    // history untouched
    expect(e.mock.db.workflows).toHaveLength(1)
    const flow = e.mock.db.workflows[0]
    expect(flow.workflowid).toBe(e.flowId); expect(flow.statecode).toBe(1)                    // same flow, back ON
    const rec = JSON.parse(flow.clientdata).properties.definition.actions.For_each_target.actions.Record.inputs.parameters
    expect(rec['item/owatch_failed']).toBeTruthy(); expect(rec['item/owatch_errormessage']).toBeTruthy()
    expect(JSON.parse(flow.clientdata).properties.definition.actions.Heartbeat.inputs.uri).toBe('https://hc-ping.example.com/keepSECRETbeat')   // heartbeat kept
    const wf = e.mock.log.filter((l: any) => l.method !== 'GET' && l.path.startsWith('workflows')).map((l: any) => l.method)
    expect(wf).toEqual(['PATCH', 'PATCH', 'PATCH'])                                           // off, new definition, on
    expect(r.alerts).toEqual({ status: 'not-configured', channels: [] })
    expect(e.mock.db.owatch_settings.find((s: any) => s.owatch_name === 'confirm').owatch_value).toBe('3')
    expect(e.mock.db.owatch_settings.find((s: any) => s.owatch_name === 'schema_version').owatch_value).toBe('3')
    for (const n of ['alert_enabled', 'alert_confirm', 'alert_reminder_minutes', 'alert_snooze_until', 'alert_test', 'alert_channels_off', 'alert_last_round', 'last_alert_at', 'last_delivery_teams', 'last_delivery_slack', 'last_delivery_webex', 'last_delivery_webhook', 'ci_status', 'alert_configured'])
      expect(e.mock.db.owatch_settings.filter((s: any) => s.owatch_name === n), n).toHaveLength(1)
    for (const s of e.mock.db.owatch_settings) expect(rowViolations('owatch_setting', { owatch_name: s.owatch_name, owatch_value: s.owatch_value }), s.owatch_name).toEqual([])
    expect(r.estimate).toMatchObject({ probePerDay: 15264, alertPerDay: 0 })                  // 33 enabled targets + heartbeat; the alert flow costs nothing while off
    e.mock.log.length = 0
    await apply(e.client, BASE)
    expect(e.mock.log.filter((l: any) => l.method !== 'GET')).toEqual([])                     // and the upgrade is idempotent
  })

  it('re-run WITH Teams + Slack: alert flow created and ON, Teams connection reference bound, secrets only in the flow definition', async () => {
    const e = await deployed24090f5()
    const lines: string[] = []
    const r = await apply(e.client, { ...BASE, teams: parseTeamsChannelLink(LINK), teamsConnectionId: 'ffffffffbbbbccccddddeeeeeeeeeeee', webhooks: { slack: SLACK }, sendTestAlert: true }, (t: string) => lines.push(t))
    expect(e.mock.problems).toEqual([])
    expect(r.alerts).toMatchObject({ status: 'on', channels: ['teams', 'slack'] })
    expect(e.mock.db.workflows.map((w: any) => [w.name, w.statecode]).sort()).toEqual([['Outage Watch - alert', 1], ['Outage Watch - probe', 1], ['Outage Watch - test notification', 1]])
    expect(e.mock.db.connectionreferences.map((c: any) => c.connectionreferencelogicalname).sort()).toEqual(['owatch_dataverse', 'owatch_teams'])
    const set = (n: string) => e.mock.db.owatch_settings.find((s: any) => s.owatch_name === n)?.owatch_value
    expect([set('alert_configured'), set('alert_channels'), set('alert_channel_name'), set('alert_test')]).toEqual(['yes', 'teams,slack', 'Ops Alerts', 'yes'])
    // the Slack URL exists in exactly one place
    const everywhere = JSON.stringify(e.mock.db.owatch_settings) + JSON.stringify(e.mock.db.owatch_targets) + JSON.stringify(r) + lines.join('\n') + JSON.stringify(e.mock.db.connectionreferences)
    expect(everywhere).not.toContain('SECRET'); expect(everywhere).not.toContain('hooks.slack.com')
    expect(existingChannels(e.mock.db.workflows.find((w: any) => w.name === 'Outage Watch - alert').clientdata).slack).toBe(SLACK)
    expect(r.estimate).toMatchObject({ probePerDay: 15264, alertPerDay: 4032, perDay: 19296, pctOf40k: 48, high: false })
    // later runs without channel options keep both channels and write nothing
    e.mock.log.length = 0
    const again = await apply(e.client, BASE)
    expect(again.alerts.channels).toEqual(['teams', 'slack'])
    expect(e.mock.log.filter((l: any) => l.method !== 'GET')).toEqual([])
    // add Webex, remove Slack: one flow, updated in place
    const third = await apply(e.client, { ...BASE, webhooks: { webex: 'https://webexapis.com/v1/webhooks/incoming/webexSECRETid' }, removeChannels: ['slack'] })
    expect(third.alerts.channels).toEqual(['teams', 'webex'])
    expect(e.mock.db.workflows).toHaveLength(3)
    expect(JSON.stringify(e.mock.db.workflows)).not.toContain('hooks.slack.com')
  })

  it('Teams asked for but no Teams connection yet: says so (the script then opens the page and retries); the rest is already upgraded', async () => {
    const e = await deployed24090f5()
    await expect(apply(e.client, { ...BASE, teams: parseTeamsChannelLink(LINK) })).rejects.toBeInstanceOf(NeedsTeamsConnection)
    expect(e.mock.entities.has('owatch_incident')).toBe(true); expect(e.mock.db.workflows[0].statecode).toBe(1)      // probing is back on before alerts are attempted
    const r = await apply(e.client, { ...BASE, teams: parseTeamsChannelLink(LINK), teamsConnectionId: 'ffffffffbbbbccccddddeeeeeeeeeeee' })
    expect(r.alerts.status).toBe('on'); expect(e.mock.db.workflows).toHaveLength(3)
  })

  it('if the service rejects the alert flow, the deployment still succeeds and says exactly why alerts are not active', async () => {
    for (const how of ['failAlertCreate', 'failAlertActivation']) {
      const e = await deployed24090f5()
      e.mock.state[how] = 'InvalidOpenApiFlow: operation PostMessageToConversation not found'
      const r = await apply(e.client, { ...BASE, teams: parseTeamsChannelLink(LINK), teamsConnectionId: 'ffffffffbbbbccccddddeeeeeeeeeeee' })
      expect(r.flowOn).toBe(true)
      expect(r.alerts.status).toBe('failed'); expect(r.alerts.message).toContain('PostMessageToConversation not found')
      expect(e.mock.db.owatch_settings.find((s: any) => s.owatch_name === 'alert_configured').owatch_value).toBe('no')
      expect(e.mock.db.workflows.find((w: any) => w.name === 'Outage Watch - probe').statecode).toBe(1)
      expect(r.estimate.alertPerDay).toBe(0)
    }
  })

  it('-NoAlerts turns the alert flow off and keeps everything else; uninstall removes both flows; -Purge also the incident table and Teams reference', async () => {
    const e = await deployed24090f5()
    const withTeams = { ...BASE, teams: parseTeamsChannelLink(LINK), teamsConnectionId: 'ffffffffbbbbccccddddeeeeeeeeeeee' }
    await apply(e.client, withTeams)
    const off = await apply(e.client, { ...BASE, noAlerts: true })
    expect(off.alerts.status).toBe('disabled')
    expect(e.mock.db.workflows.map((w: any) => [w.name, w.statecode]).sort()).toEqual([['Outage Watch - alert', 0], ['Outage Watch - probe', 1], ['Outage Watch - test notification', 0]])
    expect((await apply(e.client, BASE)).alerts.status).toBe('on')                              // a run without -NoAlerts turns it back on with the kept channel
    await uninstall(e.client, { purge: false })
    expect(e.mock.db.workflows).toEqual([]); expect(e.mock.entities.size).toBe(5)
    await apply(e.client, withTeams)
    await uninstall(e.client, { purge: true })
    expect(e.mock.entities.size).toBe(0); expect(e.mock.db.connectionreferences).toEqual([]); expect(e.mock.problems).toEqual([])
  })
})

describe('CLI: channels, secrets from the environment only, exit codes', () => {
  const run = (args: string[], extraEnv: Record<string, string> = {}) => new Promise<{ code: number; out: string }>((resolve) => {
    execFile(process.execPath, ['provision/owpp.mjs', ...args], { env: { ...process.env, ...extraEnv } as Record<string, string> }, (err, stdout, stderr) => resolve({ code: err ? Number((err as any).code) : 0, out: stdout + stderr }))
  })
  it('apply: Teams without a connection -> exit 6; with everything -> exit 0; no secret in output or result file', async () => {
    const mock = createMockDataverse({ autoRun: false }); const srv = await mock.listen(); closers.push(srv.close)
    const env = { OWPP_TOKEN: mock.token, OWPP_TEST_MODE: '1', OWPP_SLACK_WEBHOOK: SLACK }
    const need = await run(['apply', '--org-url', srv.url, '--connection-id', BASE.connectionId, '--teams-channel-link', LINK], env)
    expect(need.code).toBe(6); expect(need.out).toContain('NEEDS TEAMS CONNECTION')
    const ok = await run(['apply', '--org-url', srv.url, '--connection-id', BASE.connectionId, '--teams-channel-link', LINK, '--teams-connection-id', 'ffffffffbbbbccccddddeeeeeeeeeeee', '--send-test-alert'], env)
    expect(ok.code).toBe(0); expect(ok.out).toContain('Alerts: ON to teams, slack'); expect(ok.out).toContain('TEST message requested')
    expect(ok.out + need.out).not.toContain('SECRET'); expect(ok.out + need.out).not.toContain(mock.token)
    const url = await run(['set-dashboard-url', '--org-url', srv.url, '--url', 'https://apps.powerapps.com/play/e/11111111-2222-3333-4444-555555555555/a/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'], env)
    expect(url.code).toBe(0)
    expect(mock.db.owatch_settings.find((s: any) => s.owatch_name === 'dashboard_url').owatch_value).toContain('https://apps.powerapps.com/play/')
    expect((await run(['set-dashboard-url', '--org-url', srv.url, '--url', 'https://evil.example/app'], env)).code).toBe(2)
  }, 30000)
  it('validates the Teams link offline and rejects a webhook passed in a bad shape, without echoing it', async () => {
    expect((await run(['check-teams-link', '--teams-channel-link', LINK])).out).toContain('ok: channel "Ops Alerts"')
    for (const bad of ['https://evil.example/l/channel/19%3Aa%40thread.tacv2/x?groupId=11111111-2222-3333-4444-555555555555', 'https://teams.microsoft.com/l/team/19%3Aa%40thread.tacv2/x?groupId=11111111-2222-3333-4444-555555555555', 'https://teams.microsoft.com/l/channel/19%3Aa%40thread.tacv2/x?groupId=not-a-guid', 'https://teams.microsoft.com/l/channel/evil%2F..%2F/x?groupId=11111111-2222-3333-4444-555555555555', 'http://teams.microsoft.com/l/channel/19%3Aa%40thread.tacv2/x?groupId=11111111-2222-3333-4444-555555555555'])
      expect((await run(['check-teams-link', '--teams-channel-link', bad])).code, bad).toBe(2)
    const r = await run(['estimate'], { OWPP_SLACK_WEBHOOK: 'https://evil.example/services/SECRETvalue123' })
    expect(r.code).toBe(2); expect(r.out).not.toContain('SECRETvalue'); expect(r.out).toContain('slack webhook URL not accepted')
    expect((await run(['estimate', '--remove-channels', 'pager'])).code).toBe(2)
  }, 30000)
  it('-DryRun plan lists the new steps: incident table, alert columns, Teams reference, second flow, with the combined quota', async () => {
    const r = await run(['plan', '--teams-channel-link', LINK], { OWPP_SLACK_WEBHOOK: SLACK, OWPP_WEBEX_WEBHOOK: 'https://webexapis.com/v1/webhooks/incoming/webexSECRETid' })
    expect(r.code).toBe(0)
    expect(r.out).toContain("EntityDefinitions(LogicalName='owatch_incident')")
    expect((r.out.match(/POST   workflows/g) ?? []).length).toBe(3)                               // probe, alert, test notification
    expect(r.out).toContain("EntityDefinitions(LogicalName='owatch_command')"); expect(r.out).toContain('Test button: ON'); expect(r.out).toMatch(/Test button: ~29 requests per test|Test button: ~35 requests per test/)
    expect((r.out.match(/POST   connectionreferences/g) ?? []).length).toBe(2)
    expect(r.out).toContain('Alerts: ON to teams, slack, webex')
    expect(r.out).toMatch(/Alert flow: 144 runs\/day x ~28 actions when nothing is failing = ~4,032 requests\/day/)
    expect(r.out).toMatch(/TOTAL: ~19,584 requests\/day = about 49% of the 40,000/)
    expect(r.out).not.toContain('SECRET'); expect(r.out).not.toContain('hooks.slack.com')
  }, 30000)
})

// ------------------------------------------------------------------------------------------------
// @ts-expect-error test fixture
import { buildAlertClientData as alertFlow5a09ecd } from './helpers/alert-flow-5a09ecd.mjs'
// @ts-expect-error plain .mjs helpers
import { buildAlertClientData as alertFlow1cf41bd } from './helpers/alert-flow-1cf41bd.mjs'

describe('upgrade from commit 5a09ecd (alerts already deployed) to the insights version', () => {
  const NEW_SETTINGS = ['drift_percent', 'drift_min_ms', 'flap_changes', 'impact_headcount']
  async function deployed5a09ecd() {
    const mock = createMockDataverse({ autoRun: false }); const srv = await mock.listen(); closers.push(srv.close)
    const client = createClient({ orgUrl: srv.url, token: mock.token, sleep: async () => {} })
    await apply(client, { ...BASE, teams: parseTeamsChannelLink(LINK), teamsConnectionId: 'ffffffffbbbbccccddddeeeeeeeeeeee', webhooks: { slack: SLACK } })
    const db = mock.db
    // the alert flow exactly as that commit built it; the settings that commit did not know are absent
    const alert = db.workflows.find((w: any) => w.name === 'Outage Watch - alert')
    alert.clientdata = JSON.stringify(alertFlow5a09ecd({ intervalMinutes: 10, channels: { teams: { groupId: '11111111-2222-3333-4444-555555555555', channelId: '19:aBc123_-xyz@thread.tacv2' }, slack: SLACK }, sets: { target: 'owatch_targets', result: 'owatch_results', setting: 'owatch_settings', incident: 'owatch_incidents' } }))
    db.owatch_settings = db.owatch_settings.filter((s: any) => !NEW_SETTINGS.includes(s.owatch_name))
    // state the running system has accumulated and that must survive
    db.owatch_incidents = [{ owatch_incidentid: '12121212-1212-4121-8121-121212121212', owatch_name: 'exchange', owatch_family: 'Exchange', owatch_isopen: true, owatch_openedat: '2026-11-15T08:10:00Z', owatch_closedat: '2000-01-01T00:00:00Z', owatch_firsterror: 'HTTP 503 - x', owatch_reminders: 1, owatch_durationminutes: 60, owatch_failedrounds: 7 }]
    Object.assign(db.owatch_targets.find((t: any) => t.owatch_name === 'exchange'), { owatch_failcount: 7, owatch_alertopen: true, owatch_failingsince: '2026-11-15T08:10:00Z', owatch_lastalertat: '2026-11-15T09:23:00Z', owatch_lastok: '2026-11-15T08:00:00Z' })
    db.owatch_settings.find((s: any) => s.owatch_name === 'alert_reminder_minutes').owatch_value = '120'
    db.owatch_settings.find((s: any) => s.owatch_name === 'alert_last_round').owatch_value = '2026-11-15T09:20:00Z'
    mock.log.length = 0
    return { mock, client, alertId: alert.workflowid as string, probe: JSON.stringify(db.workflows.find((w: any) => w.name === 'Outage Watch - probe')), targets: JSON.stringify(db.owatch_targets), incidents: JSON.stringify(db.owatch_incidents) }
  }

  it('plain re-run: only the alert flow definition and four new settings change; channels (incl. the Slack secret), alert state, incidents and admin settings survive', async () => {
    const e = await deployed5a09ecd()
    const lines: string[] = []
    const r = await apply(e.client, BASE, (t: string) => lines.push(t))
    expect(e.mock.problems).toEqual([])
    const writes = e.mock.log.filter((l: any) => l.method !== 'GET').map((l: any) => `${l.method} ${l.path.replace(/\(.*/, '')}`)
    expect(writes.sort()).toEqual(['PATCH workflows', 'PATCH workflows', 'PATCH workflows', 'POST owatch_settings', 'POST owatch_settings', 'POST owatch_settings', 'POST owatch_settings'])
    expect(r.created.sort()).toEqual(NEW_SETTINGS.map((n) => 'setting ' + n).sort())
    expect(r.updated).toEqual(['cloud flow "Outage Watch - alert" definition', 'cloud flow "Outage Watch - alert" turned ON'])
    const alert = e.mock.db.workflows.find((w: any) => w.name === 'Outage Watch - alert')
    expect(alert.workflowid).toBe(e.alertId); expect(alert.statecode).toBe(1)
    expect(alert.clientdata).toContain('PROBABLE COMMON CAUSE')                                 // the new wording is in
    expect(existingChannels(alert.clientdata)).toEqual({ teams: { groupId: '11111111-2222-3333-4444-555555555555', channelId: '19:aBc123_-xyz@thread.tacv2' }, slack: SLACK, webex: null, webhook: null })
    expect(r.alerts).toMatchObject({ status: 'on', channels: ['teams', 'slack'] })
    expect(JSON.stringify(e.mock.db.workflows.find((w: any) => w.name === 'Outage Watch - probe'))).toBe(e.probe)   // the probe flow is not touched at all
    expect(JSON.stringify(e.mock.db.owatch_targets)).toBe(e.targets); expect(JSON.stringify(e.mock.db.owatch_incidents)).toBe(e.incidents)
    expect(e.mock.db.owatch_settings.find((s: any) => s.owatch_name === 'alert_reminder_minutes').owatch_value).toBe('120')
    expect(e.mock.db.owatch_settings.find((s: any) => s.owatch_name === 'alert_last_round').owatch_value).toBe('2026-11-15T09:20:00Z')
    expect(lines.join('\n') + JSON.stringify(r) + JSON.stringify(e.mock.db.owatch_settings)).not.toContain('SECRET')
    for (const s of e.mock.db.owatch_settings) expect(rowViolations('owatch_setting', { owatch_name: s.owatch_name, owatch_value: s.owatch_value }), s.owatch_name).toEqual([])
    expect(r.estimate).toMatchObject({ alertPerDay: 4032, pctOf40k: 49, high: false })           // quota unchanged: insights run in the browser
    e.mock.log.length = 0
    await apply(e.client, BASE)
    expect(e.mock.log.filter((l: any) => l.method !== 'GET')).toEqual([])
  })
})

describe('upgrade from commit 1cf41bd (the deployed version) to delivery-checked alerts + the test-notification button', () => {
  const NEW_SETTINGS = ['alert_stale_notified', 'last_test_at', 'test_button']
  async function deployed1cf41bd() {
    const mock = createMockDataverse({ autoRun: false }); const srv = await mock.listen(); closers.push(srv.close)
    const client = createClient({ orgUrl: srv.url, token: mock.token, sleep: async () => {} })
    await apply(client, { ...BASE, teams: parseTeamsChannelLink(LINK), teamsConnectionId: 'ffffffffbbbbccccddddeeeeeeeeeeee', webhooks: { slack: SLACK } })
    const db = mock.db
    // back to what that commit had: its alert flow, no command table, no test flow, none of the new settings
    const alert = db.workflows.find((w: any) => w.name === 'Outage Watch - alert')
    alert.clientdata = JSON.stringify(alertFlow1cf41bd({ intervalMinutes: 10, channels: { teams: { groupId: '11111111-2222-3333-4444-555555555555', channelId: '19:aBc123_-xyz@thread.tacv2' }, slack: SLACK }, sets: { target: 'owatch_targets', result: 'owatch_results', setting: 'owatch_settings', incident: 'owatch_incidents' } }))
    db.workflows.splice(db.workflows.findIndex((w: any) => w.name === 'Outage Watch - test notification'), 1)
    mock.entities.delete('owatch_command'); delete db.owatch_commands
    db.owatch_settings = db.owatch_settings.filter((s: any) => !NEW_SETTINGS.includes(s.owatch_name))
    db.owatch_incidents = [{ owatch_incidentid: '12121212-1212-4121-8121-121212121212', owatch_name: 'exchange', owatch_family: 'Exchange', owatch_isopen: true, owatch_openedat: '2026-11-15T08:10:00Z', owatch_closedat: '2000-01-01T00:00:00Z', owatch_firsterror: 'HTTP 503 - x', owatch_reminders: 1, owatch_durationminutes: 60, owatch_failedrounds: 7 }]
    Object.assign(db.owatch_targets.find((t: any) => t.owatch_name === 'exchange'), { owatch_failcount: 7, owatch_alertopen: true, owatch_failingsince: '2026-11-15T08:10:00Z', owatch_lastalertat: '2026-11-15T09:23:00Z', owatch_lastok: '2026-11-15T08:00:00Z' })
    db.owatch_settings.find((s: any) => s.owatch_name === 'alert_reminder_minutes').owatch_value = '120'
    db.owatch_settings.find((s: any) => s.owatch_name === 'drift_percent').owatch_value = '75'
    mock.log.length = 0
    return { mock, client, alertId: alert.workflowid as string, probe: JSON.stringify(db.workflows.find((w: any) => w.name === 'Outage Watch - probe')), targets: JSON.stringify(db.owatch_targets), results: JSON.stringify(db.owatch_results ?? []), incidents: JSON.stringify(db.owatch_incidents) }
  }

  it('plain re-run adds the command table, the third flow and three settings, replaces the alert flow definition in place; nothing else changes and a second run changes nothing', async () => {
    const e = await deployed1cf41bd()
    const lines: string[] = []
    const r = await apply(e.client, BASE, (t: string) => lines.push(t))
    expect(e.mock.problems).toEqual([])
    const writes = e.mock.log.filter((l: any) => l.method !== 'GET').map((l: any) => `${l.method} ${l.path.replace(/\(.*/, '')}`)
    expect(writes.filter((w: string) => w.startsWith('DELETE'))).toEqual([])
    expect(writes.filter((w: string) => w === 'POST workflows')).toHaveLength(1)                      // only the new test-notification flow
    expect(writes.filter((w: string) => w === 'POST owatch_settings')).toHaveLength(NEW_SETTINGS.length)
    expect(writes.filter((w: string) => /owatch_(targets|results|incidents)/.test(w))).toEqual([])     // no data row is written
    expect(r.created).toEqual(expect.arrayContaining(['cloud flow "Outage Watch - test notification"', ...NEW_SETTINGS.map((n) => 'setting ' + n)]))
    expect(r.created.filter((c: string) => !/owatch_command|test notification|^setting /.test(c))).toEqual([])
    expect(r.updated.filter((u: string) => !/test_button/.test(u))).toEqual(['cloud flow "Outage Watch - alert" definition', 'cloud flow "Outage Watch - alert" turned ON', 'cloud flow "Outage Watch - test notification" turned ON'])
    expect(e.mock.entities.has('owatch_command')).toBe(true)
    expect([...e.mock.entities.get('owatch_command').attributes.keys()].sort()).toEqual(['owatch_channels', 'owatch_commandid', 'owatch_completedat', 'owatch_name', 'owatch_note', 'owatch_requestedby', 'owatch_result', 'owatch_status'])
    const alert = e.mock.db.workflows.find((w: any) => w.name === 'Outage Watch - alert')
    expect(alert.workflowid).toBe(e.alertId); expect(alert.statecode).toBe(1)
    expect(alert.clientdata).toContain('If_delivered'); expect(alert.clientdata).toContain('message shortened')
    expect(existingChannels(alert.clientdata)).toEqual({ teams: { groupId: '11111111-2222-3333-4444-555555555555', channelId: '19:aBc123_-xyz@thread.tacv2' }, slack: SLACK, webex: null, webhook: null })
    const test = e.mock.db.workflows.find((w: any) => w.name === 'Outage Watch - test notification')
    expect(test.statecode).toBe(1)
    expect(test.clientdata.split(SLACK).length - 1).toBe(1)                                            // the kept Slack webhook is carried into the new flow, once
    expect(r.alerts).toMatchObject({ status: 'on', channels: ['teams', 'slack'], test: { status: 'on' } })
    expect(JSON.stringify(e.mock.db.workflows.find((w: any) => w.name === 'Outage Watch - probe'))).toBe(e.probe)
    expect(JSON.stringify(e.mock.db.owatch_targets)).toBe(e.targets); expect(JSON.stringify(e.mock.db.owatch_incidents)).toBe(e.incidents); expect(JSON.stringify(e.mock.db.owatch_results ?? [])).toBe(e.results)
    expect(e.mock.db.owatch_settings.find((s: any) => s.owatch_name === 'alert_reminder_minutes').owatch_value).toBe('120')
    expect(e.mock.db.owatch_settings.find((s: any) => s.owatch_name === 'drift_percent').owatch_value).toBe('75')
    expect(e.mock.db.owatch_settings.find((s: any) => s.owatch_name === 'test_button').owatch_value).toBe('yes')
    expect(lines.join('\n') + JSON.stringify(r) + JSON.stringify(e.mock.db.owatch_settings)).not.toContain('SECRET')
    for (const s of e.mock.db.owatch_settings) expect(rowViolations('owatch_setting', { owatch_name: s.owatch_name, owatch_value: s.owatch_value }), s.owatch_name).toEqual([])
    expect(r.estimate).toMatchObject({ alertPerDay: 4032, pctOf40k: 49, high: false, testWorstCasePerDay: 288 * 29 })
    e.mock.log.length = 0
    await apply(e.client, BASE)
    expect(e.mock.log.filter((l: any) => l.method !== 'GET')).toEqual([])
  })

  it('the test-notification flow cannot be created (e.g. trigger rejected): alerts stay ON, the button is reported as not active, the deployment does not fail', async () => {
    const e = await deployed1cf41bd()
    e.mock.state.failTestCreate = 'The trigger operation is not valid.'
    const lines: string[] = []
    const r = await apply(e.client, BASE, (t: string) => lines.push(t))
    expect(r.alerts.status).toBe('on'); expect(r.alerts.test.status).toBe('failed')
    expect(e.mock.db.workflows.find((w: any) => w.name === 'Outage Watch - alert').statecode).toBe(1)
    expect(e.mock.db.owatch_settings.find((s: any) => s.owatch_name === 'test_button').owatch_value).toBe('no')
    expect(lines.join('\n')).toContain('TEST-NOTIFICATION FLOW NOT ACTIVE')
  })

  it('-NoAlerts turns the test flow off too', async () => {
    const e = await deployed1cf41bd()
    await apply(e.client, BASE)
    await apply(e.client, { ...BASE, noAlerts: true })
    expect(e.mock.db.workflows.map((w: any) => [w.name, w.statecode]).sort()).toEqual([['Outage Watch - alert', 0], ['Outage Watch - probe', 1], ['Outage Watch - test notification', 0]])
    expect(e.mock.db.owatch_settings.find((s: any) => s.owatch_name === 'test_button').owatch_value).toBe('no')
  })
})
