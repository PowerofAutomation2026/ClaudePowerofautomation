#!/usr/bin/env node
// Outage Watch (Power Platform) provisioning helper. Called by Deploy-OutageWatchPP.ps1; also usable by hand.
// Zero dependencies (Node 18+). Secrets come ONLY from environment variables and are never printed:
//   OWPP_TOKEN          bearer token for the Dataverse organisation (apply / smoke / uninstall)
//   OWPP_HEARTBEAT_URL  optional dead-man's-switch URL baked into the flow (apply)
import { writeFileSync } from 'node:fs'
import { createClient, DataverseError } from './lib/client.mjs'
import { createMockDataverse } from './lib/mock-dataverse.mjs'
import { apply, smoke, uninstall, NeedsConnection, FlowNotOn } from './lib/provision.mjs'
import { catalog } from './lib/schema.mjs'
import { PROBE_CONCURRENCY, estimateRequests, worstCaseRunSeconds } from './lib/flow.mjs'
import { InputError, assertConnectionId, assertGuid, assertHeartbeatUrl, assertInt, assertOrgUrl, assertTenantName } from './lib/validate.mjs'

export const EXIT = { ok: 0, failed: 1, badInput: 2, needsConnection: 3, flowNotOn: 4, smokeTimeout: 5 }

function parseArgs(argv) {
  const [cmd, ...rest] = argv
  const a = { _: cmd }
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i]
    if (!/^--[a-z][a-z-]*$/.test(k)) throw new InputError(`unexpected argument #${i + 1}`)
    const flag = ['--purge', '--clear-heartbeat', '--no-wait'].includes(k)
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
    heartbeatUrl: null,
  }
  const hb = process.env.OWPP_HEARTBEAT_URL
  if (hb) o.heartbeatUrl = assertHeartbeatUrl(hb)
  return o
}

function client(a) {
  const orgUrl = assertOrgUrl(a['org-url'], { allowLoopback: process.env.OWPP_TEST_MODE === '1' })
  // OWPP_TEST_MODE (loopback mock server only): no waiting. Real tenants keep the real waits.
  return createClient({ orgUrl, token: process.env.OWPP_TOKEN ?? '', sleep: process.env.OWPP_TEST_MODE === '1' ? async () => {} : undefined })
}

const say = (t) => console.log(t)
function out(a, obj) { if (a.out) writeFileSync(a.out, JSON.stringify(obj, null, 2), { encoding: 'utf8' }) }

function printEstimate(e, targets, interval, timeout = catalog.defaults.probeTimeoutSeconds) {
  if (e.over) say(`  *** WARNING: this needs MORE than the 40,000 requests/day of a Premium licence (${e.pctOf40k}%). The flow WILL be throttled. Use a longer -IntervalMinutes or a Process licence (250,000/day). ***`)
  else if (e.high) say(`  *** WARNING: this uses ${e.pctOf40k}% of the 40,000 requests/day of a Premium licence - little headroom for the owner's other flows. Consider a longer -IntervalMinutes (default 10) or a Process licence on the flow. ***`)
  const worst = worstCaseRunSeconds(targets, timeout)
  say(`  One run: ${targets} probes in parallel (up to ${PROBE_CONCURRENCY} at once, ${timeout} s timeout each) = at most ~${worst} s, inside the ${interval * 60} s interval${worst > interval * 30 ? ' (TIGHT: raise the interval)' : ''}.`)
  say(`  Flow usage estimate: ${targets} enabled targets every ${interval} min = ${e.runsPerDay} runs/day x ~${e.perRun} actions = ~${e.perDay.toLocaleString('en-US')} Power Platform requests/day`)
  say(`  (about ${e.pctOf40k}% of the 40,000/day of a Power Automate Premium / Power Apps Premium user; ${e.pctOf6k}% of the 6,000/day of a Microsoft 365 seeded licence), and ${e.rowsPerDay.toLocaleString('en-US')} result rows/day.`)
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
        const e = estimateRequests(n, o.intervalMinutes, !!o.heartbeatUrl)
        printEstimate(e, n, o.intervalMinutes, o.timeoutSeconds)
        out(a, e); return EXIT.ok
      }
      case 'plan': {
        // Offline: replays the provisioning against an in-memory model of an EMPTY environment and prints every request.
        const o = options(a); o.connectionId = o.connectionId ?? 'your-dataverse-connection-id'
        const mock = createMockDataverse({ autoRun: false })
        const c = createClient({ orgUrl: 'https://plan.invalid', token: mock.token, fetchImpl: mock.mockFetch, sleep: async () => {} })
        const r = await apply(c, o)
        say('DRY RUN - nothing is sent anywhere. Requests a first deployment would make to <org>/api/data/v9.2/ :')
        mock.log.forEach((l, i) => say(`  ${String(i + 1).padStart(3)}. ${l.method.padEnd(6)} ${l.path}${l.query ? ' ' + l.query.slice(0, 90) : ''}${l.solution ? '   [solution ' + l.solution + ']' : ''}`))
        say(`  = ${mock.log.length} requests; creates: ${r.created.length} objects (${r.targets} targets, ${r.enabledTargets} enabled). A re-run only reads and patches what changed.`)
        say(`  Heartbeat (dead man's switch): ${r.heartbeat ? 'configured (URL not shown)' : 'not configured'}`)
        if (r.unconfigured.length) say(`  Not set up (seeded disabled, never probed, shown as "unconfigured"): ${r.unconfigured.join(', ')} - pass -TenantName contoso to enable them.`)
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
          if (r.unconfigured.length) say(`  Not set up (disabled, shown as "unconfigured"): ${r.unconfigured.join(', ')} - re-run with -TenantName contoso to enable them.`)
          printEstimate(r.estimate, r.enabledTargets, o.intervalMinutes, o.timeoutSeconds)
          return EXIT.ok
        } catch (e) {
          if (e instanceof NeedsConnection) { out(a, { ok: false, reason: 'needs-connection' }); say('  NEEDS CONNECTION: ' + e.message); return EXIT.needsConnection }
          if (e instanceof FlowNotOn) { out(a, { ok: false, reason: 'flow-not-on', flowId: e.flowId, message: e.message }); say('  FLOW CREATED BUT NOT TURNED ON: ' + e.message); return EXIT.flowNotOn }
          throw e
        }
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
        say('usage: owpp.mjs <validate|estimate|plan|apply|smoke|uninstall> [--org-url URL] [--environment-id GUID] [--connection-id ID] [--interval MIN] [--retention DAYS] [--timeout SEC] [--tenant NAME] [--out FILE] [--purge] [--clear-heartbeat] [--wait-seconds N]')
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
