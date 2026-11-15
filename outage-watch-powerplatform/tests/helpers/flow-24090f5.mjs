// Verbatim copy of provision/lib/flow.mjs at commit 24090f5 (the version deployed on the real tenant before alerts existed).
// TEST FIXTURE ONLY: used to rebuild "the currently deployed state" for the upgrade test. Do not edit.
// Builds the cloud flow (`workflow.clientdata`) for the probe.
//
// The flow is deliberately DUMB: it records raw facts (HTTP status, elapsed ms, raw error code) and never
// decides whether something is "up" or "down". All classification is done client-side (src/logic/classify.ts).
//
// Documented parts: the clientdata envelope, connectionReferences, the Dataverse `ListRecords` action shape,
// the Logic Apps workflow definition language (Recurrence, Foreach, Http, runAfter, retryPolicy, limit.timeout,
// operationOptions, runtimeConfiguration). NOT documented by Microsoft: the exact parameter names of the
// Dataverse `CreateRecord` / `DeleteRecord` operations inside clientdata ("item/<column>", "recordId") - they
// follow what the Power Automate designer itself writes. See DESIGN.md "Unconfirmed".
import { CONNREF, columnSpec } from '../../provision/lib/schema.mjs'

/** Format of the round id: fixed width (20 characters, e.g. 2026-11-15T08:30:00Z), well inside the 40-character column. */
export const ROUND_FORMAT = 'yyyy-MM-ddTHH:mm:ssZ'

/** Documented maximum for "for each" concurrency in Azure Logic Apps / Power Automate. */
export const PROBE_CONCURRENCY = 50

const ALWAYS = ['Succeeded', 'Failed', 'Skipped', 'TimedOut']
const AUTH = "@parameters('$authentication')"

const dv = (operationId, parameters, runAfter) => ({
  runAfter, metadata: {}, type: 'OpenApiConnection',
  inputs: { host: { apiId: CONNREF.connectorId, connectionName: CONNREF.api, operationId }, parameters, authentication: AUTH },
})

/**
 * @param {{intervalMinutes:number, retentionDays:number, timeoutSeconds:number, heartbeatUrl?:string|null,
 *          sets:{target:string,result:string}}} o   `sets` are the Dataverse entity set names read back from metadata.
 */
export function buildClientData(o) {
  const probe = {
    runAfter: {}, metadata: {}, type: 'Http',
    inputs: {
      method: 'GET', uri: "@items('For_each_target')?['owatch_url']",
      headers: { 'User-Agent': 'outage-watch-pp/1.0' },
      retryPolicy: { type: 'none' },                 // a retried probe would hide the first failure and distort elapsed time
    },
    limit: { timeout: `PT${o.timeoutSeconds}S` },
    operationOptions: 'DisableAsyncPattern',         // never poll a 202 + Location answer
  }
  // Every runtime value is bounded to its column BEFORE the row is written, so an unexpectedly long error code or
  // an odd duration can never make a row write fail (which would silently lose that probe's result).
  // The limits are read from the table definition, not typed twice.
  const lim = columnSpec('owatch_result')
  const elapsed = `@max(${lim.owatch_elapsedms.min},min(${lim.owatch_elapsedms.max},div(sub(ticks(coalesce(actions('Probe')?['endTime'],utcNow())),ticks(coalesce(actions('Probe')?['startTime'],utcNow()))),10000)))`
  const errorKind = `@take(string(if(equals(actions('Probe')?['status'],'Succeeded'),'',coalesce(actions('Probe')?['code'],actions('Probe')?['status'],'Failed'))),${lim.owatch_errorkind.maxLength})`
  const record = dv('CreateRecord', {
    entityName: o.sets.result,
    'item/owatch_name': `@take(string(items('For_each_target')?['owatch_name']),${lim.owatch_name.maxLength})`,
    'item/owatch_httpstatus': "@outputs('Probe')?['statusCode']",
    'item/owatch_elapsedms': elapsed,
    'item/owatch_errorkind': errorKind,
    'item/owatch_probedat': '@utcNow()',
    'item/owatch_round': "@outputs('Round')",
  }, { Probe: ALWAYS })                              // one failing probe must never stop the others, or its own record

  const actions = {
    Round: { runAfter: {}, metadata: {}, type: 'Compose', inputs: `@utcNow('${ROUND_FORMAT}')` },     // fixed-width: always 20 characters
    List_targets: dv('ListRecords', {
      entityName: o.sets.target, $select: 'owatch_name,owatch_url', $filter: 'owatch_enabled eq true and owatch_url ne null and statecode eq 0', $top: 100,
    }, { Round: ['Succeeded'] }),
    For_each_target: {
      runAfter: { List_targets: ['Succeeded'] }, metadata: {}, type: 'Foreach',
      foreach: "@outputs('List_targets')?['body/value']",
      actions: { Probe: probe, Record: record },
      // All probes of a round start together (documented maximum: 50 parallel iterations). A round of 36 targets
      // therefore takes about ONE probe timeout at worst, not 36 of them. More than 50 enabled targets = a second wave.
      runtimeConfiguration: { concurrency: { repetitions: PROBE_CONCURRENCY } },
    },
    Prune_list: dv('ListRecords', {
      entityName: o.sets.result, $select: 'owatch_resultid',
      $filter: `owatch_probedat lt @{addDays(utcNow(), -${o.retentionDays})}`, $top: 200,
    }, { For_each_target: ALWAYS }),
    Prune_each: {
      runAfter: { Prune_list: ['Succeeded'] }, metadata: {}, type: 'Foreach',
      foreach: "@outputs('Prune_list')?['body/value']",
      actions: { Delete_old: dv('DeleteRecord', { entityName: o.sets.result, recordId: "@items('Prune_each')?['owatch_resultid']" }, {}) },
      runtimeConfiguration: { concurrency: { repetitions: 10 } },
    },
  }
  if (o.heartbeatUrl) {
    // Dead man's switch: pings an EXTERNAL watcher only when the whole probe round was written.
    // If Power Platform (or this flow) dies, the pings stop and the outside service notices the silence.
    actions.Heartbeat = {
      runAfter: { For_each_target: ['Succeeded'] }, metadata: {}, type: 'Http',
      inputs: { method: 'GET', uri: o.heartbeatUrl, retryPolicy: { type: 'none' } },
      limit: { timeout: 'PT10S' },
      operationOptions: 'DisableAsyncPattern',
      runtimeConfiguration: { secureData: { properties: ['inputs', 'outputs'] } },   // keep the URL out of the run history
    }
  }
  return {
    properties: {
      connectionReferences: {
        [CONNREF.api]: { runtimeSource: 'embedded', connection: { connectionReferenceLogicalName: CONNREF.logicalName }, api: { name: CONNREF.api } },
      },
      definition: {
        $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
        contentVersion: '1.0.0.0',
        parameters: { $connections: { defaultValue: {}, type: 'Object' }, $authentication: { defaultValue: {}, type: 'SecureObject' } },
        triggers: {
          Recurrence: { type: 'Recurrence', recurrence: { frequency: 'Minute', interval: o.intervalMinutes }, runtimeConfiguration: { concurrency: { runs: 1 } } },
        },
        actions,
      },
    },
    schemaVersion: '1.0.0.0',
  }
}

/** Heartbeat URL of an existing deployment (so an upgrade without the flag keeps it). Never log the result. */
export function existingHeartbeatUrl(clientdataText) {
  try {
    const u = JSON.parse(clientdataText)?.properties?.definition?.actions?.Heartbeat?.inputs?.uri
    return typeof u === 'string' && u.startsWith('https://') ? u : null
  } catch { return null }
}

/** Stable JSON for "did the definition change?" comparisons. */
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
  return JSON.stringify(v)
}

/**
 * Rough Power Platform request usage. "Each trigger and action that runs counts as one request" (Microsoft).
 * Per run: trigger + Round + List_targets + For_each_target + 2 per target (Probe, Record) + Prune_list + Prune_each
 * + in steady state one Delete_old per row written a retention period ago (= targets) + optional Heartbeat.
 */
export function estimateRequests(targets, intervalMinutes, heartbeat) {
  // `targets` = ENABLED targets (disabled / unconfigured ones are never probed and cost nothing)
  const perRun = 6 + 3 * targets + (heartbeat ? 1 : 0)
  const runsPerDay = Math.floor(1440 / intervalMinutes)
  const perDay = perRun * runsPerDay
  const pctOf40k = Math.round((perDay / 40000) * 100)
  return { perRun, runsPerDay, perDay, pctOf40k, pctOf6k: Math.round((perDay / 6000) * 100), rowsPerDay: targets * runsPerDay, high: pctOf40k > 60, over: perDay > 40000 }
}

/**
 * Worst-case duration of one run: probes run in waves of PROBE_CONCURRENCY, each wave at most one probe timeout,
 * plus a generous allowance for the Dataverse actions. Must stay well inside the interval (the trigger also has
 * concurrency 1, so a slow run can never overlap the next one; it would delay it).
 */
export function worstCaseRunSeconds(targets, timeoutSeconds) {
  const waves = Math.max(1, Math.ceil(targets / PROBE_CONCURRENCY))
  return waves * timeoutSeconds + 60
}
