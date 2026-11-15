#!/usr/bin/env node
// Outage Watch (Power Platform) provisioning helper. Called by Deploy-OutageWatchPP.ps1; also usable by hand.
// Zero dependencies (Node 18+). Secrets come ONLY from environment variables and are never printed:
//   OWPP_TOKEN          bearer token for the Dataverse organisation (apply / smoke / uninstall)
//   OWPP_HEARTBEAT_URL  optional dead-man's-switch URL baked into the flow (apply)
import { writeFileSync } from 'node:fs'
import { createClient, DataverseError } from './lib/client.mjs'
import { createMockDataverse } from './lib/mock-dataverse.mjs'
import { apply, requestTestNotification, setDashboardUrl, smoke, uninstall, NeedsConnection, NeedsTeamsConnection, FlowNotOn } from './lib/provision.mjs'
import { estimateTestRequests, RATE_LIMIT_SECONDS } from './lib/test-flow.mjs'
import { estimateAlertRequests } from './lib/alert-flow.mjs'
import { assertTenantLabel, detectTenant, initialDomainLabels, initialFromGraphOrganization, probeTenant, sharePointCloudSupported } from './lib/tenant.mjs'
import { catalog } from './lib/schema.mjs'
import { PROBE_CONCURRENCY, estimateRequests, worstCaseRunSeconds } from './lib/flow.mjs'
import { InputError, assertConnectionId, assertDashboardUrl, assertGuid, assertHeartbeatUrl, assertInt, assertOrgUrl, assertTenantName, assertWebhookUrl, parseTeamsChannelLink } from './lib/validate.mjs'

export const EXIT = { ok: 0, failed: 1, badInput: 2, needsConnection: 3, flowNotOn: 4, smokeTimeout: 5, needsTeamsConnection: 6, testNotDelivered: 7, testTimeout: 8 }

function parseArgs(argv) {
  const [cmd, ...rest] = argv
  const a = { _: cmd }
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i]
    if (!/^--[a-z][a-z-]*$/.test(k)) throw new InputError(`unexpected argument #${i + 1}`)
    const flag = ['--purge', '--clear-heartbeat', '--no-wait', '--no-alerts', '--send-test-alert'].includes(k)
    a[k.slice(2)] = flag ? true : rest[++i]
    if (!flag && a[k.slice(2)] === undefined) throw new InputError(`${k} needs a value`)
  }
  return a
}

function options(a) {
  const d = catalog.defaults
  const o = {
    intervalMinutes: assertInt(a.interval ?? d.intervalMinutes, 1, 60, 'interval (minutes)'),
    retentionDays: assertInt(a.retention ?? d.retentionDays, 1, 90, 'retention (days)'),
    timeoutSeconds: assertInt(a.timeout ?? d.probeTimeoutSeconds, 2, 60, 'probe timeout (seconds)'),
    tenant: a.tenant ? assertTenantName(a.tenant) : null,
    connectionId: a['connection-id'] ? assertConnectionId(a['connection-id']) : null,
    clearHeartbeat: !!a['clear-heartbeat'],
    teams: a['teams-channel-link'] ? parseTeamsChannelLink(a['teams-channel-link']) : null,
    teamsConnectionId: a['teams-connection-id'] ? assertConnectionId(a['teams-connection-id']) : null,
    noAlerts: !!a['no-alerts'],
    sendTestAlert: !!a['send-test-alert'],
    heartbeatUrl: null,
  }
  const hb = process.env.OWPP_HEARTBEAT_URL
  if (hb) o.heartbeatUrl = assertHeartbeatUrl(hb)
  // webhook URLs are credentials: environment only, never an argument
  o.webhooks = {}
  for (const [kind, env] of [['slack', 'OWPP_SLACK_WEBHOOK'], ['webex', 'OWPP_WEBEX_WEBHOOK'], ['webhook', 'OWPP_ALERT_WEBHOOK']]) if (process.env[env]) o.webhooks[kind] = assertWebhookUrl(kind, process.env[env])
  o.removeChannels = a['remove-channels'] ? String(a['remove-channels']).split(',').map((c) => { if (!['teams', 'slack', 'webex', 'webhook'].includes(c)) throw new InputError('--remove-channels takes teams,slack,webex,webhook'); return c }) : []
  return o
}

function client(a) {
  const orgUrl = assertOrgUrl(a['org-url'], { allowLoopback: process.env.OWPP_TEST_MODE === '1' })
  // OWPP_TEST_MODE (loopback mock server only): no waiting. Real tenants keep the real waits.
  return createClient({ orgUrl, token: process.env.OWPP_TOKEN ?? '', sleep: process.env.OWPP_TEST_MODE === '1' ? async () => {} : undefined })
}

const say = (t) => console.log(t)
function out(a, obj) { if (a.out) writeFileSync(a.out, JSON.stringify(obj, null, 2), { encoding: 'utf8' }) }

function withAlerts(e, alertPerDay) {
  const perDay = e.perDay + alertPerDay
  const pctOf40k = Math.round((perDay / 40000) * 100)
  return { ...e, probePerDay: e.perDay, alertPerDay, perDay, pctOf40k, pctOf6k: Math.round((perDay / 6000) * 100), high: pctOf40k > 60, over: perDay > 40000 }
}

function alertsLine(al) {
  if (!al) return ''
  if (al.status === 'on') return `Alerts: ON to ${al.channels.join(', ')} (flow "Outage Watch - alert"; webhook URLs are never shown). Test button: ${al.test?.status === 'on' ? 'ON (flow "Outage Watch - test notification")' : 'NOT ACTIVE - ' + (al.test?.message ?? 'unknown reason')}`
  if (al.status === 'disabled') return 'Alerts: OFF (-NoAlerts)'
  if (al.status === 'failed') return 'Alerts: NOT ACTIVE - the alert flow could not be created or turned on: ' + al.message
  return 'Alerts: not configured (no channel given)'
}

function printEstimate(e, targets, interval, timeout = catalog.defaults.probeTimeoutSeconds) {
  if (e.over) say(`  *** WARNING: this needs MORE than the 40,000 requests/day of a Premium licence (${e.pctOf40k}%). The flow WILL be throttled. Use a longer -IntervalMinutes or a Process licence (250,000/day). ***`)
  else if (e.high) say(`  *** WARNING: this uses ${e.pctOf40k}% of the 40,000 requests/day of a Premium licence - little headroom for the owner's other flows. Consider a longer -IntervalMinutes (default 10) or a Process licence on the flow. ***`)
  const worst = worstCaseRunSeconds(targets, timeout)
  say(`  One run: ${targets} probes in parallel (up to ${PROBE_CONCURRENCY} at once, ${timeout} s timeout each) = at most ~${worst} s, inside the ${interval * 60} s interval${worst > interval * 30 ? ' (TIGHT: raise the interval)' : ''}.`)
  const probe = e.probePerDay ?? e.perDay
  say(`  Probe flow: ${targets} enabled targets every ${interval} min = ${e.runsPerDay} runs/day x ~${e.perRun} actions = ~${probe.toLocaleString('en-US')} Power Platform requests/day`)
  if (e.alertPerDay) say(`  Alert flow: ${e.runsPerDay} runs/day x ~${Math.round(e.alertPerDay / e.runsPerDay)} actions when nothing is failing = ~${e.alertPerDay.toLocaleString('en-US')} requests/day (plus about 7 per failing service per run, and about 12 per posted message)`)
  if (e.testWorstCasePerDay) say(`  Test button: ~${estimateTestRequests(4).perTest} requests per test with four channels, nothing while unused; at most one test per ${RATE_LIMIT_SECONDS / 60} min (${e.testWorstCasePerDay.toLocaleString('en-US')}/day only if pressed every ${RATE_LIMIT_SECONDS / 60} min all day; NOT in the total).`)
  say(`  TOTAL: ~${e.perDay.toLocaleString('en-US')} requests/day = about ${e.pctOf40k}% of the 40,000/day of a Power Automate Premium / Power Apps Premium user (${e.pctOf6k}% of the 6,000/day of a Microsoft 365 seeded licence); ${e.rowsPerDay.toLocaleString('en-US')} result rows/day.`)
}

export async function main(argv) {
  let a
  try {
    a = parseArgs(argv)
    switch (a._) {
      case 'validate': {
        assertGuid(a['environment-id'], 'environment id'); options(a)
        if (a['org-url']) assertOrgUrl(a['org-url'])
        say('ok'); return EXIT.ok
      }
      case 'estimate': {
        const o = options(a); const n = catalog.targets.length + (o.tenant ? catalog.tenantTargets.length : 0)
        const e = withAlerts(estimateRequests(n, o.intervalMinutes, !!o.heartbeatUrl), o.noAlerts ? 0 : estimateAlertRequests(o.intervalMinutes).perDay)
        if (!o.noAlerts) say('  (estimate INCLUDES the Teams alert flow; it costs nothing while alerts are not configured)')
        printEstimate(e, n, o.intervalMinutes, o.timeoutSeconds)
        out(a, e); return EXIT.ok
      }
      case 'plan': {
        // Offline: replays the provisioning against an in-memory model of an EMPTY environment and prints every request.
        const o = options(a); o.connectionId = o.connectionId ?? 'your-dataverse-connection-id'
        if (o.teams) o.teamsConnectionId = o.teamsConnectionId ?? 'your-teams-connection-id'
        const mock = createMockDataverse({ autoRun: false })
        const c = createClient({ orgUrl: 'https://plan.invalid', token: mock.token, fetchImpl: mock.mockFetch, sleep: async () => {} })
        const r = await apply(c, o)
        say('DRY RUN - nothing is sent anywhere. Requests a first deployment would make to <org>/api/data/v9.2/ :')
        mock.log.forEach((l, i) => say(`  ${String(i + 1).padStart(3)}. ${l.method.padEnd(6)} ${l.path}${l.query ? ' ' + l.query.slice(0, 90) : ''}${l.solution ? '   [solution ' + l.solution + ']' : ''}`))
        say(`  = ${mock.log.length} requests; creates: ${r.created.length} objects (${r.targets} targets, ${r.enabledTargets} enabled). A re-run only reads and patches what changed.`)
        say(`  Heartbeat (dead man's switch): ${r.heartbeat ? 'configured (URL not shown)' : 'not configured'}`)
        say('  ' + alertsLine(r.alerts) + (r.alerts.status === 'not-configured' ? '. With a channel (-TeamsChannelLink / -SetSlackWebhook / -SetWebexWebhook) the plan also creates the flows "Outage Watch - alert" and "Outage Watch - test notification" (and the connection reference owatch_teams for Teams). The table owatch_command (the test button) is always created.' : ''))
        if (r.unconfigured.length) say(`  SharePoint / OneDrive (${r.unconfigured.join(', ')}): in this offline plan they are shown as not set up. A real run AUTO-DETECTS the SharePoint tenant name (Get-AzTenant, then Microsoft Graph), verifies that https://<name>.sharepoint.com answers, and enables them; -TenantName contoso overrides.`)
        printEstimate(r.estimate, r.enabledTargets, o.intervalMinutes, o.timeoutSeconds)
        return EXIT.ok
      }
      case 'apply': {
        const o = options(a); const c = client(a)
        try {
          const r = await apply(c, o, say)
          out(a, { ok: true, ...r })
          say(`  ${r.created.length} created, ${r.updated.length} updated, flow is ON, heartbeat ${r.heartbeat ? 'configured' : 'not configured'}`)
          for (const w of r.warnings) say('  note: ' + w)
          say('  ' + alertsLine(r.alerts))
          if (r.unconfigured.length) say(`  Not set up (disabled, shown as "unconfigured"): ${r.unconfigured.join(', ')} - re-run with -TenantName contoso to enable them.`)
          printEstimate(r.estimate, r.enabledTargets, o.intervalMinutes, o.timeoutSeconds)
          return EXIT.ok
        } catch (e) {
          if (e instanceof NeedsTeamsConnection) { out(a, { ok: false, reason: 'needs-teams-connection' }); say('  NEEDS TEAMS CONNECTION: ' + e.message); return EXIT.needsTeamsConnection }
          if (e instanceof NeedsConnection) { out(a, { ok: false, reason: 'needs-connection' }); say('  NEEDS CONNECTION: ' + e.message); return EXIT.needsConnection }
          if (e instanceof FlowNotOn) { out(a, { ok: false, reason: 'flow-not-on', flowId: e.flowId, message: e.message }); say('  FLOW CREATED BUT NOT TURNED ON: ' + e.message); return EXIT.flowNotOn }
          throw e
        }
      }
      case 'set-dashboard-url': {
        const url = assertDashboardUrl(a.url)
        await setDashboardUrl(client(a), url)
        say('  dashboard link stored for alert messages'); return EXIT.ok
      }
      case 'check-teams-link': {       // offline: used by the deploy script to validate the pasted link before anything else happens
        const t = parseTeamsChannelLink(a['teams-channel-link'])
        say(`ok: channel "${t.channelName || '(no name in the link)'}"`); out(a, { ok: true, channelName: t.channelName }); return EXIT.ok
      }
      case 'detect-tenant': {
        // Finds and VERIFIES the SharePoint tenant name. Never fails the deployment: exit 0 with tenant = null means "not found".
        const orgUrl = assertOrgUrl(a['org-url'], { allowLoopback: process.env.OWPP_TEST_MODE === '1' })
        const test = process.env.OWPP_TEST_MODE === '1' && /^http:\/\/127\.0\.0\.1:[0-9]+$/.test(process.env.OWPP_TEST_SPO_BASE ?? '')
        const probeOptions = test ? { urlFor: (l) => `${process.env.OWPP_TEST_SPO_BASE}/${l}/` } : {}
        const res = { tenant: null, via: null, already: false, unsupported: false, reachable: null, tried: [] }
        if (!sharePointCloudSupported(orgUrl)) {
          res.unsupported = true
          say('  SharePoint / OneDrive: this environment is in a US Government (GCC High / DoD) or China cloud, whose SharePoint host names differ. Not supported yet: nothing is seeded.')
          out(a, res); return EXIT.ok
        }
        if (process.env.OWPP_TOKEN) {           // already set up on an earlier run? then there is nothing to detect and nothing to ask
          try {
            const c = client(a)
            const set = (await c.find(`EntityDefinitions(LogicalName='owatch_target')?$select=EntitySetName`))?.EntitySetName
            const row = set ? (await c.get(`${set}?$select=owatch_url&$filter=owatch_name eq 'sharepoint-online'`)).json.value[0] : null
            if (row?.owatch_url) { res.already = true; say('  SharePoint / OneDrive targets are already configured.'); out(a, res); return EXIT.ok }
          } catch { /* first deployment: the table does not exist yet */ }
        }
        if (a.candidate !== undefined) {          // -TenantName or the interactive answer: validate, probe, report
          const label = assertTenantLabel(String(a.candidate).toLowerCase())
          const r = await probeTenant(label, probeOptions)
          res.tenant = label; res.via = 'given'; res.reachable = r.ok
          say(r.ok ? `  SharePoint tenant "${label}": https://${label}.sharepoint.com answers (HTTP ${r.status}).` : `  WARNING: https://${label}.sharepoint.com did not answer like an existing tenant (${r.reason}). It is used because you gave it; check the spelling.`)
          out(a, res); return EXIT.ok
        }
        const sources = []
        const fromAz = initialDomainLabels(String(a.domains ?? '').split(',').slice(0, 200))
        if (fromAz.length) sources.push({ via: 'Get-AzTenant', labels: fromAz })
        if (process.env.OWPP_GRAPH_TOKEN) {
          try {
            const g = await fetch('https://graph.microsoft.com/v1.0/organization?$select=verifiedDomains', { headers: { Authorization: 'Bearer ' + process.env.OWPP_GRAPH_TOKEN, Accept: 'application/json' }, redirect: 'error' })
            if (g.ok) { const labels = initialFromGraphOrganization(await g.json()); if (labels.length) sources.push({ via: 'Microsoft Graph /organization', labels }) }
          } catch { /* Graph not reachable or not permitted: fall through quietly */ }
        }
        const d = await detectTenant(sources, probeOptions)
        res.tenant = d.tenant; res.via = d.via; res.tried = d.tried; res.reachable = d.tenant ? true : null
        if (d.tenant) say(`  SharePoint tenant detected via ${d.via}: ${d.tenant}  (https://${d.tenant}.sharepoint.com answers)`)
        else say('  SharePoint tenant name could not be detected and verified' + (d.tried.length ? ': ' + d.tried.map((t) => `${t.label} - ${t.detail}`).join('; ').slice(0, 300) : ' (no candidate domain was available).'))
        out(a, res); return EXIT.ok
      }
      case 'test-notification': {
        // Same mechanism as the dashboard button: one command row, the flow does the sending. Exit code = delivery.
        const channels = String(a.channels ?? 'all').toLowerCase()
        if (!/^(all|(teams|slack|webex|webhook)(,(teams|slack|webex|webhook)){0,3})$/.test(channels)) throw new InputError('--channels takes all, or a comma list of teams,slack,webex,webhook')
        const note = String(a.note ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
        if (note.length > 200) throw new InputError('--note is limited to 200 characters')
        const by = String(a['requested-by'] ?? 'command line').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100)
        const test = process.env.OWPP_TEST_MODE === '1'
        const r = await requestTestNotification(client(a), { channels, note, requestedBy: by, waitSeconds: assertInt(a['wait-seconds'] ?? 180, 0, 1800, 'wait seconds'), ...(test ? { pollSeconds: 0.05 } : {}) }, say)
        out(a, r)
        say(`  test notification: ${r.status.toUpperCase()}${r.result ? ' - ' + r.result : ''}`)
        if (r.status === 'done') return EXIT.ok
        if (r.status === 'timeout') return EXIT.testTimeout
        return EXIT.testNotDelivered
      }
      case 'smoke': {
        const c = client(a)
        const r = await smoke(c, { waitSeconds: a['no-wait'] ? 0 : assertInt(a['wait-seconds'] ?? 240, 0, 1800, 'wait seconds') }, say)
        out(a, r)
        for (const s of r.sample) say(`    ${String(s.name).slice(0, 24).padEnd(24)} http ${String(s.http ?? '-').padEnd(4)} ${String(s.ms ?? '-').padStart(6)} ms ${s.error ? String(s.error).slice(0, 40) : ''}`)
        return r.ok ? EXIT.ok : EXIT.smokeTimeout
      }
      case 'uninstall': {
        const c = client(a)
        const r = await uninstall(c, { purge: !!a.purge }, say)
        out(a, { ok: true, ...r })
        if (!r.removed.length) say('  nothing to remove')
        if (r.kept.length) say('  kept: ' + r.kept.join(', ') + ' (use -Purge to delete them too)')
        return EXIT.ok
      }
      default:
        say('usage: owpp.mjs <validate|estimate|plan|apply|smoke|uninstall|set-dashboard-url|check-teams-link|detect-tenant|test-notification> [--channels all|teams,slack,webex,webhook] [--note TEXT] [--org-url URL] [--environment-id GUID] [--connection-id ID] [--interval MIN] [--retention DAYS] [--timeout SEC] [--tenant NAME] [--out FILE] [--purge] [--clear-heartbeat] [--wait-seconds N]')
        return EXIT.badInput
    }
  } catch (e) {
    if (e instanceof InputError) { console.error('invalid input: ' + e.message); return EXIT.badInput }
    if (e instanceof DataverseError) { console.error('FAILED: ' + e.message); if (a?.out) { try { out(a, { ok: false, reason: 'error', status: e.status, message: e.message }) } catch { /* ignore */ } } return EXIT.failed }
    console.error('FAILED: ' + String(e?.message ?? e).slice(0, 400)); return EXIT.failed
  }
}

import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
const self = fileURLToPath(import.meta.url)
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(self)) main(process.argv.slice(2)).then((c) => { process.exitCode = c })
