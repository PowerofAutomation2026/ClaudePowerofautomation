// Builds the THIRD cloud flow, "Outage Watch - test notification": the admin's "send a live test now" button.
//
// The browser never posts to a channel (it cannot hold the webhook URLs, and must not). The dashboard - or
// `owpp.mjs test-notification` - creates ONE row in the table owatch_command. The Dataverse trigger "When a row is
// added" starts this flow, which reads the CURRENT status (newest complete probe round), builds a clearly labelled
// TEST message with the same per-channel encodings and post actions as a real alert (buildPosts), sends it to the
// selected channels independently, and writes the per-channel result back to the command row.
//
// Safety: only rows named test_notification in status "queued" are processed (a duplicate trigger finds "sending" /
// "done" and does nothing); at most one test per RATE_LIMIT_SECONDS; the note and the requester name are plain,
// bounded text that goes through the same escaping as probe data; webhook URLs exist only in the flow definition.
// The trigger operation (SubscribeWebhookTrigger and its parameters) is what the designer writes; it is NOT in
// Microsoft's reference documentation. See DESIGN.md "Unconfirmed".
import { CONNREF, TEAMS_CONNREF, columnSpec } from './schema.mjs'
import { CAPS, CHANNELS, COMMON, ROUND_SETTLE_MINUTES, SAME_FATE, buildPosts, kit } from './alert-flow.mjs'

export const RATE_LIMIT_SECONDS = 300
export const TEST_TITLE = '\u{1F9EA} TEST - Outage Watch live status. Sent on request; this is NOT an alert.'
export const COMMAND_NAME = 'test_notification'
const { NL, FMT, ALWAYS, DONE, dv, query, select, compose, ok, cap, setting, settingId, settingQuery } = kit

export function buildTestClientData(o) {
  const ch = o.channels ?? {}
  const lim = columnSpec('owatch_command')
  const ctx = (k) => `outputs('Ctx')?['${k}']`
  const cmd = (c) => `first(body('Get_command')?['value'])?['${c}']`
  const failNames = "body('FailNames')"
  const round = "first(body('Latest_round')?['value'])?['owatch_round']"

  const errText = `concat(${cap("item()?['owatch_errorkind']", CAPS.kind)},' ',${cap("item()?['owatch_errormessage']", CAPS.error)})`
  const line = `@concat('- ',${cap("item()?['owatch_name']", CAPS.name)},': ',if(equals(coalesce(item()?['owatch_httpstatus'],0),0),'no HTTP answer',concat('HTTP ',string(coalesce(item()?['owatch_httpstatus'],0)))),' after ',string(coalesce(item()?['owatch_elapsedms'],0)),' ms - ',if(equals(length(${errText}),1),'no error text',${errText}))`
  const level = `if(empty(coalesce(${round},'')),'unknown (no probe round yet)',if(or(contains(${failNames},'auth'),greater(length(body('OpenNow')),0)),'freeze',if(greater(length(${failNames}),0),'caution','ok')))`
  const age = `div(sub(ticks(${ctx('now')}),ticks(coalesce(${round},${ctx('now')}))),600000000)`
  const nFail = `length(${failNames})`; const nProbed = "length(body('List_round')?['value'])"
  const dash = `coalesce(${setting('S_dashboard')},'')`
  const message = `@concat('${TEST_TITLE}',${NL},'Requested by: ',${ctx('by')},' at ',${ctx('now')},' UTC',${NL},if(empty(${ctx('note')}),'',concat('Note: ',${ctx('note')},${NL})),` +
    `'Level: ',${level},' | probe round: ',${cap(`coalesce(${round},'-')`, 40)},' (',string(${age}),' min ago)',${NL},` +
    `if(equals(${nFail},0),concat('All ',string(${nProbed}),' probed services answered in that round.',${NL}),concat(string(${nFail}),' of ',string(${nProbed}),' probed services are failing:',${NL},join(take(body('Lines'),${CAPS.detailed}),${NL}),${NL},` +
    `if(greater(${nFail},${CAPS.detailed}),concat('... and ',string(sub(${nFail},${CAPS.detailed})),' more (see the dashboard).',${NL}),''),'Families with failures: ',join(take(union(body('FailFamilies'),body('FailFamilies')),20),', '),${NL})),` +
    `if(contains(${failNames},'auth'),concat('${COMMON.authLead}',${NL}),''),` +
    `if(startsWith(${dash},'https://'),concat('Dashboard: ',${cap(dash, 400)},${NL}),''),${NL},'${SAME_FATE}')`

  const posts = buildPosts(ch, "outputs('Message')")
  const configured = CHANNELS.filter((c) => posts[c])
  const branches = {}
  let after = 'Message'
  for (const c of configured) {
    const P = `Post_${c}`
    const failed = c === 'teams' ? `concat('FAILED ',string(coalesce(actions('${P}')?['code'],'error')))` : `concat('FAILED HTTP ',string(coalesce(outputs('${P}')?['statusCode'],0)))`    // never an error text: it could repeat a webhook URL
    branches[`If_${c}`] = {
      runAfter: after === 'Message' ? ok('Message') : { [after]: ALWAYS }, type: 'If',
      expression: { or: [{ contains: [`@${ctx('channels')}`, ',all,'] }, { contains: [`@${ctx('channels')}`, `,${c},`] }] },
      actions: { [P]: { runAfter: {}, ...posts[c] }, [`R_${c}`]: compose(`@if(equals(actions('${P}')?['status'],'Succeeded'),'delivered',${failed})`, { [P]: DONE }) },
      else: { actions: {} },
    }
    after = `If_${c}`
  }
  const resultParts = CHANNELS.map((c) => (configured.includes(c) ? `'${c}=',coalesce(outputs('R_${c}'),'not selected')` : `'${c}=not configured'`)).join(",'; ',")
  const anyOk = configured.length ? `or(${configured.map((c) => `equals(coalesce(outputs('R_${c}'),''),'delivered')`).join(',')}${configured.length === 1 ? ',false' : ''})` : 'false'
  const allOk = configured.length ? `not(contains(concat(${resultParts}),'FAILED'))` : 'false'

  const actions = {
    List_settings: dv('ListRecords', { entityName: o.sets.setting, $select: 'owatch_name,owatch_value,owatch_settingid', $top: 200 }, {}),
    S_lasttest: settingQuery('last_test_at', ok('List_settings')),
    S_dashboard: settingQuery('dashboard_url', ok('S_lasttest')),
    // read the row again: a trigger that fires twice finds the status already changed and stops
    Get_command: dv('ListRecords', { entityName: o.sets.command, $select: 'owatch_commandid,owatch_name,owatch_status,owatch_channels,owatch_note,owatch_requestedby', $filter: "owatch_commandid eq @{triggerOutputs()?['body/owatch_commandid']}", $top: 1 }, ok('S_dashboard')),
    Ctx: compose({
      now: `@utcNow('${FMT}')`,
      id: `@${cmd('owatch_commandid')}`,
      isTest: `@equals(toLower(coalesce(${cmd('owatch_name')},'')),'${COMMAND_NAME}')`,
      queued: `@equals(toLower(coalesce(${cmd('owatch_status')},'')),'queued')`,
      channels: `@concat(',',replace(toLower(take(string(coalesce(${cmd('owatch_channels')},'all')),${lim.owatch_channels.maxLength})),' ',''),',')`,
      note: `@${cap(cmd('owatch_note'), lim.owatch_note.maxLength)}`,
      by: `@if(empty(coalesce(${cmd('owatch_requestedby')},'')),'(not stated)',${cap(cmd('owatch_requestedby'), lim.owatch_requestedby.maxLength)})`,
      tooSoon: `@greater(coalesce(${setting('S_lasttest')},''),addSeconds(utcNow(),-${RATE_LIMIT_SECONDS},'${FMT}'))`,
    }, ok('Get_command')),
    If_mine: {
      runAfter: ok('Ctx'), type: 'If', expression: { and: [{ equals: [`@${ctx('isTest')}`, true] }, { equals: [`@${ctx('queued')}`, true] }] },
      actions: {
        If_allowed: {
          runAfter: {}, type: 'If', expression: { equals: [`@${ctx('tooSoon')}`, false] },
          actions: {
            Mark_sending: dv('UpdateRecord', { entityName: o.sets.command, recordId: `@${ctx('id')}`, 'item/owatch_status': 'sending' }, {}),
            Save_last_test: dv('UpdateRecord', { entityName: o.sets.setting, recordId: `@${settingId('S_lasttest')}`, 'item/owatch_value': `@${ctx('now')}` }, ok('Mark_sending')),
            Latest_round: dv('ListRecords', { entityName: o.sets.result, $select: 'owatch_round', $orderby: 'owatch_round desc', $top: 1, $filter: `owatch_round lt '@{addMinutes(utcNow(),-${ROUND_SETTLE_MINUTES},'${FMT}')}'` }, { Save_last_test: DONE }),
            List_round: dv('ListRecords', { entityName: o.sets.result, $select: 'owatch_name,owatch_httpstatus,owatch_elapsedms,owatch_errorkind,owatch_errormessage,owatch_failed', $filter: `owatch_round eq '@{coalesce(${round},'-')}'`, $orderby: 'owatch_name asc', $top: 1000 }, ok('Latest_round')),
            FailRows: query("@body('List_round')?['value']", "@equals(item()?['owatch_failed'],true)", ok('List_round')),
            FailNames: select("@body('FailRows')", "@item()?['owatch_name']", ok('FailRows')),
            Lines: select("@body('FailRows')", line, ok('FailNames')),
            List_targets: dv('ListRecords', { entityName: o.sets.target, $select: 'owatch_name,owatch_family,owatch_alertopen', $filter: 'statecode eq 0', $orderby: 'owatch_family asc,owatch_name asc', $top: 500 }, ok('Lines')),
            OpenNow: query("@body('List_targets')?['value']", "@equals(item()?['owatch_alertopen'],true)", ok('List_targets')),
            FailTargets: query("@body('List_targets')?['value']", `@contains(${failNames},item()?['owatch_name'])`, ok('OpenNow')),
            FailFamilies: select("@body('FailTargets')", `@${cap("if(empty(coalesce(item()?['owatch_family'],'')),'Other',item()?['owatch_family'])", CAPS.family)}`, ok('FailTargets')),
            Message: compose(message, ok('FailFamilies')),
            ...branches,
            // whatever happened above (even a failed query), the command row gets a final state: the button never hangs on "sending"
            Finish: dv('UpdateRecord', {
              entityName: o.sets.command, recordId: `@${ctx('id')}`,
              'item/owatch_status': `@if(${anyOk},if(${allOk},'done','partial'),'failed')`,
              'item/owatch_result': `@take(concat(${resultParts}),${lim.owatch_result.maxLength})`,
              'item/owatch_completedat': `@${ctx('now')}`,
            }, { [after]: ALWAYS }),
          },
          else: {
            actions: {
              Reject: dv('UpdateRecord', { entityName: o.sets.command, recordId: `@${ctx('id')}`, 'item/owatch_status': 'rejected', 'item/owatch_result': `rate limit: one test every ${RATE_LIMIT_SECONDS / 60} minutes`, 'item/owatch_completedat': `@${ctx('now')}` }, {}),
            },
          },
        },
      },
      else: { actions: {} },
    },
    // housekeeping: command rows older than 7 days
    Old_commands: dv('ListRecords', { entityName: o.sets.command, $select: 'owatch_commandid', $filter: `createdon lt @{addDays(utcNow(),-7)}`, $top: 50 }, { If_mine: ALWAYS }),
    Prune_commands: {
      runAfter: ok('Old_commands'), type: 'Foreach', foreach: "@body('Old_commands')?['value']", runtimeConfiguration: { concurrency: { repetitions: 5 } },
      actions: { Delete_command: dv('DeleteRecord', { entityName: o.sets.command, recordId: "@items('Prune_commands')?['owatch_commandid']" }, {}) },
    },
  }
  const connectionReferences = { [CONNREF.api]: { runtimeSource: 'embedded', connection: { connectionReferenceLogicalName: CONNREF.logicalName }, api: { name: CONNREF.api } } }
  if (ch.teams) connectionReferences[TEAMS_CONNREF.api] = { runtimeSource: 'embedded', connection: { connectionReferenceLogicalName: TEAMS_CONNREF.logicalName }, api: { name: TEAMS_CONNREF.api } }
  return {
    properties: {
      connectionReferences,
      definition: {
        $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
        contentVersion: '1.0.0.0',
        parameters: { $connections: { defaultValue: {}, type: 'Object' }, $authentication: { defaultValue: {}, type: 'SecureObject' } },
        triggers: {
          When_a_command_is_added: {
            type: 'OpenApiConnectionWebhook',
            inputs: {
              host: { apiId: CONNREF.connectorId, connectionName: CONNREF.api, operationId: 'SubscribeWebhookTrigger' },
              parameters: { 'subscriptionRequest/message': 1, 'subscriptionRequest/entityname': 'owatch_command', 'subscriptionRequest/scope': 4 },     // 1 = added, 4 = organization
              authentication: kit.AUTH,
            },
            runtimeConfiguration: { concurrency: { runs: 1 } },       // one test at a time: the rate-limit check cannot race
          },
        },
        actions,
      },
    },
    schemaVersion: '1.0.0.0',
  }
}

/** Requests of ONE accepted test, as counted by executing the definition (trigger + actions; 3 per configured channel). */
export function estimateTestRequests(channels = 4) {
  const perTest = 23 + 3 * channels
  return { perTest, rejected: 11, worstCasePerDay: Math.floor(86400 / RATE_LIMIT_SECONDS) * perTest }
}
