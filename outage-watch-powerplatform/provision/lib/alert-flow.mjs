// Builds the SECOND cloud flow, "Outage Watch - alert": posts to a Teams channel when a service fails.
//
// Why a separate flow and not a last step of the probe flow:
//   * isolation - a Teams problem (connection expired, channel deleted, the action rejected) can never stop or
//     even slow the probe flow, which is already deployed and working; -NoAlerts simply leaves this flow off;
//   * a flow cannot be turned on while one of its connections is unbound - probing must not depend on Teams;
//   * the probe flow stays small and its definition almost unchanged by this feature.
// Cost of that choice: one more trigger and its own bookkeeping, about 22 requests per run when nothing is wrong.
//
// How it works (every run, same interval as the probe flow):
//   1. read the alert settings; find the newest COMPLETE probe round (started more than 2 minutes ago);
//   2. if that round was already evaluated (setting alert_last_round) stop - each round is judged at most once;
//   3. list the failed rows of the round (owatch_failed, written by the probe flow) and the targets with their
//      alert state; loop ONLY over targets that fail now or have a failure streak / open incident (normally none);
//   4. per such target: update its state (consecutive failures, failing since, incident open) and decide
//      open / reminder / recovered / nothing - the same decision table as provision/lib/alert-logic.mjs;
//   5. one message per round with everything that changed, grouped by family; post as Flow bot;
//   6. a failed post is written to the setting last_alert_error; a successful one to last_alert_at.
//
// Expression rules followed here (the workflow language evaluates BOTH branches of if()): every sub-expression
// is total - no int() of free text, no ticks() of free text, no property access on a possibly non-object value.
// The Teams operation (PostMessageToConversation and its parameter names) is NOT in Microsoft's reference
// documentation; it is what the designer writes. See DESIGN.md "Unconfirmed".
import { CONNREF, TEAMS_CONNREF, columnSpec } from './schema.mjs'

/** Limits that keep the message far below the Teams message size limit (about 28 KB) even with hostile input. */
export const CAPS = { detailed: 10, name: 100, nameEsc: 150, family: 100, familyEsc: 150, url: 200, urlEsc: 300, kind: 100, kindEsc: 150, error: 300, errorEsc: 450, atRisk: 12, notesEsc: 1500, lastErr: 300 }
export const SENTINEL = '2000-01-01T00:00:00Z'      // "never": datetime columns are always written with a real value, never null
export const ROUND_SETTLE_MINUTES = 2               // a round younger than this may still be writing rows
export const SAME_FATE = 'Same-fate warning: this alert is sent by Power Automate and Teams, which run in the same Microsoft cloud that is being watched. In a Microsoft 365 or Power Platform outage it may be late or never arrive. Rely on the external heartbeat and the independent monitor for that case.'
export const TITLES = { failure: '\u{1F534} SERVICE FAILURE - Outage Watch', recovered: '✅ RECOVERED - Outage Watch', test: '\u{1F9EA} TEST - Outage Watch alert test. No outage is implied; no action needed.' }
export const TAGS = { open: 'NEW FAILURE', reminder: 'STILL FAILING', recovered: 'RECOVERED' }
const FMT = 'yyyy-MM-ddTHH:mm:ssZ'

const ALWAYS = ['Succeeded', 'Failed', 'Skipped', 'TimedOut']
const AUTH = "@parameters('$authentication')"
const dv = (operationId, parameters, runAfter) => ({ runAfter, metadata: {}, type: 'OpenApiConnection', inputs: { host: { apiId: CONNREF.connectorId, connectionName: CONNREF.api, operationId }, parameters, authentication: AUTH } })
const query = (from, where, runAfter) => ({ runAfter, metadata: {}, type: 'Query', inputs: { from, where } })
const select = (from, sel, runAfter) => ({ runAfter, metadata: {}, type: 'Select', inputs: { from, select: sel } })
const compose = (inputs, runAfter) => ({ runAfter, metadata: {}, type: 'Compose', inputs })
const ok = (name) => ({ [name]: ['Succeeded'] })

/** HTML-escape inside the workflow language. Everything that comes from a probe or a target row goes through this. */
export const esc = (x) => `replace(replace(replace(replace(string(coalesce(${x},'')),'&','&amp;'),'<','&lt;'),'>','&gt;'),'"','&quot;')`
const capEsc = (x, raw, escaped) => `take(${esc(`take(string(coalesce(${x},'')),${raw})`)},${escaped})`
const setting = (q) => `first(body('${q}'))?['owatch_value']`
const settingId = (q) => `first(body('${q}'))?['owatch_settingid']`
const safeInt = (v, dflt, lo, hi) => `max(${lo},min(${hi},int(if(isInt(coalesce(${v},'')),coalesce(${v},''),'${dflt}'))))`

/**
 * @param {{intervalMinutes:number, groupId:string, channelId:string, sets:{target:string,result:string,setting:string}}} o
 */
export function buildAlertClientData(o) {
  const T = (c) => `items('For_each_interesting')?['${c}']`
  const ctx = (k) => `outputs('Ctx')?['${k}']`
  const c1 = (k) => `outputs('C1')?['${k}']`
  const c2 = (k) => `outputs('C2')?['${k}']`
  const row = (c) => `first(body('Row'))?['${c}']`
  const lim = columnSpec('owatch_target')

  const settingsQueries = {}
  let prev = 'List_settings'
  for (const [name, key] of [['S_enabled', 'alert_enabled'], ['S_confirm', 'alert_confirm'], ['S_reminder', 'alert_reminder_minutes'], ['S_snooze', 'alert_snooze_until'], ['S_test', 'alert_test'], ['S_lastround', 'alert_last_round']]) {
    settingsQueries[name] = query("@body('List_settings')?['value']", `@equals(item()?['owatch_name'],'${key}')`, ok(prev))
    prev = name
  }

  const reaches = `greaterOrEquals(add(${c1('prev')},1),${ctx('confirm')})`
  const isOpen = `and(${reaches},not(${c1('wasOpen')}))`
  const isReminder = `and(${c1('wasOpen')},greaterOrEquals(${c1('sinceLast')},${ctx('reminder')}))`
  const newStreak = `and(${c1('failNow')},equals(${c1('prev')},0))`

  const tag = `if(equals(${c2('event')},'open'),'${TAGS.open}',if(equals(${c2('event')},'reminder'),'${TAGS.reminder}','${TAGS.recovered}'))`
  const errText = `concat(${capEsc(row('owatch_errorkind'), CAPS.kind, CAPS.kindEsc)},' ',${capEsc(row('owatch_errormessage'), CAPS.error, CAPS.errorEsc)})`
  const failingDetails = `concat('Result: ',if(equals(coalesce(${row('owatch_httpstatus')},0),0),'no HTTP answer',concat('HTTP ',string(coalesce(${row('owatch_httpstatus')},0)))),' after ',string(coalesce(${row('owatch_elapsedms')},0)),' ms<br>Error: ',if(equals(length(${errText}),1),'none reported (see the HTTP status)',${errText}),'<br>Failing since: ',${esc(c2('since'))},' UTC | consecutive failures: ',string(${c2('count')}),' | last success (probe round): ',${esc(c2('lastok'))})`
  const recoveredDetails = `concat('Answering again. Was failing since ',${esc(`coalesce(${T('owatch_failingsince')},'unknown')`)},' UTC (about ',string(div(sub(ticks(${ctx('now')}),ticks(coalesce(${T('owatch_failingsince')},${ctx('now')}))),600000000)),' min, ',string(${c1('prev')}),' failed round(s)).')`
  const heading = `if(equals(variables('LastFamily'),coalesce(${T('owatch_family')},'')),'',concat('<p><b>',${capEsc(`if(empty(coalesce(${T('owatch_family')},'')),'Other',${T('owatch_family')})`, CAPS.family, CAPS.familyEsc)},'</b></p>'))`
  const itemHtml = `concat(${heading},'<p><b>[',${tag},'] ',${capEsc(T('owatch_name'), CAPS.name, CAPS.nameEsc)},'</b><br>URL: ',${capEsc(T('owatch_url'), CAPS.url, CAPS.urlEsc)},'<br>',if(${c1('failNow')},${failingDetails},${recoveredDetails}),'</p>')`

  const failNames = "body('FailNames')"
  const notes = `concat('<p>Failing in this probe round: ',string(length(${failNames})),' service(s).</p>',` +
    `if(contains(${failNames},'auth'),concat('<p><b>At risk downstream (sign-in is failing):</b> ',take(${esc(`join(take(body('AtRiskNames'),${CAPS.atRisk}),', ')`)},${CAPS.notesEsc}),if(greater(length(body('AtRiskNames')),${CAPS.atRisk}),concat(' and ',string(sub(length(body('AtRiskNames')),${CAPS.atRisk})),' more'),''),'</p>'),''),` +
    `if(and(contains(${failNames},'m365-copilot'),greater(length(body('CopNames')),0)),concat('<p>Copilot affected; underlying services also unhealthy: ',take(${esc(`join(take(body('CopNames'),${CAPS.atRisk}),', ')`)},${CAPS.notesEsc}),'</p>'),''))`

  const nOpen = "length(body('Ev_open'))"; const nStill = "length(body('Ev_still'))"; const nRec = "length(body('Ev_recovered'))"
  const title = `if(equals(length(variables('Events')),0),'${TITLES.test}',if(greater(add(${nOpen},${nStill}),0),'${TITLES.failure}','${TITLES.recovered}'))`
  const dash = `coalesce(${setting('S_dashboard')},'')`
  const message = `@concat('<p><b>',${title},'</b><br>Time: ',${ctx('now')},' UTC | probe round: ',${esc(`coalesce(${ctx('round')},'-')`)},'<br>New failures: ',string(${nOpen}),' | still failing (reminder): ',string(${nStill}),' | recovered: ',string(${nRec}),if(${ctx('test')},'<br>(TEST requested with the setting alert_test)',''),'</p>',` +
    `variables('Notes'),join(take(body('Items'),${CAPS.detailed}),''),` +
    `if(greater(length(body('Items')),${CAPS.detailed}),concat('<p>... and ',string(sub(length(body('Items')),${CAPS.detailed})),' more (see the dashboard).</p>'),''),` +
    `if(startsWith(${dash},'https://'),concat('<p><a href="',${esc(dash)},'">Open the Outage Watch dashboard</a></p>'),''),` +
    `'<p><i>${SAME_FATE}</i></p>')`

  const actions = {
    Init_Events: { runAfter: {}, type: 'InitializeVariable', inputs: { variables: [{ name: 'Events', type: 'array', value: [] }] } },
    Init_LastFamily: { runAfter: ok('Init_Events'), type: 'InitializeVariable', inputs: { variables: [{ name: 'LastFamily', type: 'string', value: '' }] } },
    Init_Notes: { runAfter: ok('Init_LastFamily'), type: 'InitializeVariable', inputs: { variables: [{ name: 'Notes', type: 'string', value: '' }] } },
    List_settings: dv('ListRecords', { entityName: o.sets.setting, $select: 'owatch_name,owatch_value,owatch_settingid', $top: 200 }, ok('Init_Notes')),
    ...settingsQueries,
    Latest_round: dv('ListRecords', {
      entityName: o.sets.result, $select: 'owatch_round', $orderby: 'owatch_round desc', $top: 1,
      $filter: `owatch_round lt '@{addMinutes(utcNow(),-${ROUND_SETTLE_MINUTES},'${FMT}')}'`,       // text compare works: the round id is a fixed-width UTC time
    }, ok(prev)),
    Ctx: compose({
      now: `@utcNow('${FMT}')`,
      round: "@first(body('Latest_round')?['value'])?['owatch_round']",
      prevRound: `@coalesce(${setting('S_lastround')},'')`,
      enabled: `@not(equals(toLower(coalesce(${setting('S_enabled')},'yes')),'no'))`,
      confirm: `@${safeInt(setting('S_confirm'), 2, 1, 10)}`,
      reminder: `@${safeInt(setting('S_reminder'), 60, 5, 10080)}`,
      // muted while the snooze text is "later than now"; both are fixed-width UTC times, so text comparison is enough and cannot fail on bad input
      muted: `@greater(coalesce(${setting('S_snooze')},''),utcNow('${FMT}'))`,
      test: `@equals(toLower(coalesce(${setting('S_test')},'')),'yes')`,
    }, ok('Latest_round')),
    If_new_round: {
      runAfter: ok('Ctx'), type: 'If',
      expression: { and: [{ not: { equals: [`@coalesce(${ctx('round')},'')`, ''] } }, { not: { equals: [`@coalesce(${ctx('round')},'')`, `@${ctx('prevRound')}`] } }] },
      actions: {
        // FIRST remember the round: a run that fails later must not make the next run count the same round twice
        Save_round: dv('UpdateRecord', { entityName: o.sets.setting, recordId: `@${settingId('S_lastround')}`, 'item/owatch_value': `@${ctx('round')}` }, {}),
        List_failing: dv('ListRecords', {
          entityName: o.sets.result, $select: 'owatch_name,owatch_httpstatus,owatch_elapsedms,owatch_errorkind,owatch_errormessage,owatch_probedat',
          $filter: `owatch_round eq '@{${ctx('round')}}' and owatch_failed eq true`, $top: 500,
        }, ok('Save_round')),
        FailNames: select("@body('List_failing')?['value']", "@item()?['owatch_name']", ok('List_failing')),
        List_targets: dv('ListRecords', {
          entityName: o.sets.target, $filter: 'statecode eq 0', $orderby: 'owatch_family asc,owatch_name asc', $top: 500,
          $select: 'owatch_targetid,owatch_name,owatch_url,owatch_family,owatch_enabled,owatch_dependsonauth,owatch_copilotneeds,owatch_failcount,owatch_failingsince,owatch_lastok,owatch_alertopen,owatch_lastalertat',
        }, ok('FailNames')),
        // normally EMPTY: only targets that fail now, are in a failure streak, or have an open incident are processed
        Interesting: query("@body('List_targets')?['value']", `@or(contains(${failNames},item()?['owatch_name']),greater(coalesce(item()?['owatch_failcount'],0),0),equals(item()?['owatch_alertopen'],true))`, ok('List_targets')),
        For_each_interesting: {
          runAfter: ok('Interesting'), type: 'Foreach', foreach: "@body('Interesting')",
          runtimeConfiguration: { concurrency: { repetitions: 1 } },        // in order: the message is grouped by family, and variables are shared
          actions: {
            Row: query("@body('List_failing')?['value']", `@equals(item()?['owatch_name'],${T('owatch_name')})`, {}),
            C1: compose({
              failNow: "@greater(length(body('Row')),0)",
              prev: `@coalesce(${T('owatch_failcount')},0)`,
              wasOpen: `@equals(${T('owatch_alertopen')},true)`,
              can: `@and(${ctx('enabled')},not(${ctx('muted')}))`,
              sinceLast: `@div(sub(ticks(${ctx('now')}),ticks(coalesce(${T('owatch_lastalertat')},'${SENTINEL}'))),600000000)`,
            }, ok('Row')),
            C2: compose({
              count: `@if(${c1('failNow')},min(add(${c1('prev')},1),${lim.owatch_failcount.max}),0)`,
              event: `@if(${c1('can')},if(${c1('failNow')},if(${isOpen},'open',if(${isReminder},'reminder','none')),if(${c1('wasOpen')},'recovered','none')),'none')`,
              open: `@if(${c1('failNow')},or(${c1('wasOpen')},and(${c1('can')},${reaches})),false)`,
              since: `@if(${newStreak},coalesce(${row('owatch_probedat')},${ctx('now')}),coalesce(${T('owatch_failingsince')},${ctx('now')}))`,
              lastok: `@take(string(if(${newStreak},if(empty(${ctx('prevRound')}),'unknown',${ctx('prevRound')}),coalesce(${T('owatch_lastok')},'unknown'))),${lim.owatch_lastok.maxLength})`,
              lastAlert: `@if(and(${c1('can')},${c1('failNow')},or(${isOpen},${isReminder})),${ctx('now')},coalesce(${T('owatch_lastalertat')},'${SENTINEL}'))`,
            }, ok('C1')),
            Update_target: dv('UpdateRecord', {
              entityName: o.sets.target, recordId: `@${T('owatch_targetid')}`,
              'item/owatch_failcount': `@${c2('count')}`, 'item/owatch_failingsince': `@${c2('since')}`, 'item/owatch_lastok': `@${c2('lastok')}`,
              'item/owatch_alertopen': `@${c2('open')}`, 'item/owatch_lastalertat': `@${c2('lastAlert')}`,
            }, ok('C2')),
            If_event: {
              runAfter: ok('Update_target'), type: 'If', expression: { not: { equals: [`@${c2('event')}`, 'none'] } },
              actions: {
                Append_event: { runAfter: {}, type: 'AppendToArrayVariable', inputs: { name: 'Events', value: { e: `@${c2('event')}`, n: `@${T('owatch_name')}`, html: `@${itemHtml}` } } },
                Set_family: { runAfter: ok('Append_event'), type: 'SetVariable', inputs: { name: 'LastFamily', value: `@coalesce(${T('owatch_family')},'')` } },
              },
              else: { actions: {} },
            },
          },
        },
        If_notes: {
          runAfter: ok('For_each_interesting'), type: 'If', expression: { greater: ["@length(variables('Events'))", 0] },
          actions: {
            AtRisk: query("@body('List_targets')?['value']", "@and(equals(item()?['owatch_dependsonauth'],true),equals(item()?['owatch_enabled'],true),not(empty(coalesce(item()?['owatch_url'],''))),not(equals(item()?['owatch_name'],'auth')))", {}),
            AtRiskNames: select("@body('AtRisk')", "@item()?['owatch_name']", ok('AtRisk')),
            CopUnder: query("@body('List_targets')?['value']", `@and(equals(item()?['owatch_copilotneeds'],true),contains(${failNames},item()?['owatch_name']),not(equals(item()?['owatch_name'],'m365-copilot')))`, ok('AtRiskNames')),
            CopNames: select("@body('CopUnder')", "@item()?['owatch_name']", ok('CopUnder')),
            Set_notes: { runAfter: ok('CopNames'), type: 'SetVariable', inputs: { name: 'Notes', value: `@${notes}` } },
          },
          else: { actions: {} },
        },
      },
      else: { actions: {} },
    },
    If_should_post: {
      runAfter: { If_new_round: ALWAYS }, type: 'If',     // also runs when the evaluation was skipped or failed: a TEST must still go out
      expression: { or: [{ equals: [`@${ctx('test')}`, true] }, { greater: ["@length(variables('Events'))", 0] }] },
      actions: {
        S_lastat: query("@body('List_settings')?['value']", "@equals(item()?['owatch_name'],'last_alert_at')", {}),
        S_lasterr: query("@body('List_settings')?['value']", "@equals(item()?['owatch_name'],'last_alert_error')", ok('S_lastat')),
        S_dashboard: query("@body('List_settings')?['value']", "@equals(item()?['owatch_name'],'dashboard_url')", ok('S_lasterr')),
        Ev_open: query("@variables('Events')", "@equals(item()?['e'],'open')", ok('S_dashboard')),
        Ev_still: query("@variables('Events')", "@equals(item()?['e'],'reminder')", ok('Ev_open')),
        Ev_recovered: query("@variables('Events')", "@equals(item()?['e'],'recovered')", ok('Ev_still')),
        Items: select("@variables('Events')", "@item()?['html']", ok('Ev_recovered')),
        Message: compose(message, ok('Items')),
        Post_to_Teams: {
          runAfter: ok('Message'), metadata: {}, type: 'OpenApiConnection',
          inputs: {
            host: { apiId: TEAMS_CONNREF.connectorId, connectionName: TEAMS_CONNREF.api, operationId: 'PostMessageToConversation' },
            parameters: { poster: 'Flow bot', location: 'Channel', 'body/recipient/groupId': o.groupId, 'body/recipient/channelId': o.channelId, 'body/messageBody': "@outputs('Message')" },
            authentication: AUTH,
          },
        },
        Mark_sent: dv('UpdateRecord', { entityName: o.sets.setting, recordId: `@${settingId('S_lastat')}`, 'item/owatch_value': `@${ctx('now')}` }, ok('Post_to_Teams')),
        // a post that fails is made visible (dashboard + settings table) instead of failing silently
        Note_error: dv('UpdateRecord', {
          entityName: o.sets.setting, recordId: `@${settingId('S_lasterr')}`,
          'item/owatch_value': `@take(concat(${ctx('now')},' ',string(coalesce(actions('Post_to_Teams')?['error']?['message'],actions('Post_to_Teams')?['code'],'post failed'))),${CAPS.lastErr})`,
        }, { Post_to_Teams: ['Failed', 'TimedOut'] }),
        If_test: {
          runAfter: ok('Mark_sent'), type: 'If', expression: { equals: [`@${ctx('test')}`, true] },
          actions: { Clear_test: dv('UpdateRecord', { entityName: o.sets.setting, recordId: `@${settingId('S_test')}`, 'item/owatch_value': 'no' }, {}) },
          else: { actions: {} },
        },
      },
      else: { actions: {} },
    },
  }

  return {
    properties: {
      connectionReferences: {
        [CONNREF.api]: { runtimeSource: 'embedded', connection: { connectionReferenceLogicalName: CONNREF.logicalName }, api: { name: CONNREF.api } },
        [TEAMS_CONNREF.api]: { runtimeSource: 'embedded', connection: { connectionReferenceLogicalName: TEAMS_CONNREF.logicalName }, api: { name: TEAMS_CONNREF.api } },
      },
      definition: {
        $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
        contentVersion: '1.0.0.0',
        parameters: { $connections: { defaultValue: {}, type: 'Object' }, $authentication: { defaultValue: {}, type: 'SecureObject' } },
        triggers: { Recurrence: { type: 'Recurrence', recurrence: { frequency: 'Minute', interval: o.intervalMinutes }, runtimeConfiguration: { concurrency: { runs: 1 } } } },
        actions,
      },
    },
    schemaVersion: '1.0.0.0',
  }
}

/** Channel of an existing alert flow, so a re-run without -TeamsChannelLink keeps it. */
export function existingChannel(clientdataText) {
  try {
    const p = JSON.parse(clientdataText)?.properties?.definition?.actions?.If_should_post?.actions?.Post_to_Teams?.inputs?.parameters
    const groupId = p?.['body/recipient/groupId']; const channelId = p?.['body/recipient/channelId']
    return typeof groupId === 'string' && typeof channelId === 'string' ? { groupId, channelId } : null
  } catch { return null }
}

/**
 * Requests per run of the alert flow. Quiet run: trigger + 3 variables + list settings + 6 setting lookups + latest
 * round + context + new-round check + (save round, failing rows, names, targets, interesting, loop, notes check)
 * + post check = 22. Each target that fails / recovers adds up to 7; a posted message adds about 12.
 */
export function estimateAlertRequests(intervalMinutes, failingTargets = 0, posts = 0) {
  const perQuietRun = 22
  const runsPerDay = Math.floor(1440 / intervalMinutes)
  return { perQuietRun, runsPerDay, perDay: perQuietRun * runsPerDay + failingTargets * 7 * runsPerDay + posts * 12 }
}
