// Builds the SECOND cloud flow, "Outage Watch - alert": tells people (Teams, Slack, Webex, any webhook), keeps
// incident records, and maintains a machine-readable status for CI pipelines and agents.
//
// Why a separate flow and not a last step of the probe flow:
//   * isolation - a channel problem (connection expired, webhook revoked, action rejected) can never stop or even
//     slow the probe flow, which is already deployed and working; -NoAlerts simply leaves this flow off;
//   * a flow cannot be turned on while one of its connections is unbound - probing must not depend on Teams;
//   * the probe flow stays small and its definition almost unchanged by this feature.
// Cost of that choice: one more trigger and its own bookkeeping, about 25 requests per run when nothing is wrong.
//
// How it works (every run, same interval as the probe flow):
//   1. read the settings; find the newest COMPLETE probe round (started more than 2 minutes ago);
//   2. if that round was already evaluated (setting alert_last_round) stop - each round is judged at most once;
//   3. list the failed rows of the round (owatch_failed, written by the probe flow) and the targets with their
//      alert state; loop ONLY over targets that fail now or have a failure streak / open incident (normally none);
//   4. per such target: update its state and decide open / reminder / recovered / nothing (the same decision table
//      as provision/lib/alert-logic.mjs); open and close an incident record;
//   5. write the CI / agent status row (ok | caution | freeze);
//   6. ONE message per round with everything that changed, grouped by family, sent to every configured channel;
//      each channel is independent: its result goes to its own last_delivery_<channel> setting.
//
// Channels and secrets:
//   teams   - Teams connector, "Post message in a chat or channel" as Flow bot (standard connector, no secret);
//   slack   - Slack incoming webhook  (POST {"text": ...});      webex - Webex incoming webhook (POST {"text": ...});
//   webhook - any endpoint that accepts POST {"text": ...}.
// A webhook URL IS the credential. It is written ONLY into this flow definition, on an action with secure inputs
// and outputs (kept out of the run history) - never into a table, a setting, a log or the dashboard. Trade-off:
// flow owners / co-owners and system administrators can read it in the definition. Dataverse "secret" environment
// variables (Azure Key Vault) would be stronger but need a Key Vault and could not be verified here.
//
// Expression rules followed here (the workflow language evaluates BOTH branches of if()): every sub-expression
// is total - no int() of free text, no ticks() of free text, no property access on a possibly non-object value.
// The Teams operation (PostMessageToConversation and its parameter names) is NOT in Microsoft's reference
// documentation; it is what the designer writes. See DESIGN.md "Unconfirmed".
import { CONNREF, TEAMS_CONNREF, columnSpec } from './schema.mjs'

export const CHANNELS = ['teams', 'slack', 'webex', 'webhook']
/** Limits that keep every message far below the channel size limits even with hostile input. */
export const CAPS = { detailed: 10, name: 100, family: 100, url: 200, kind: 100, error: 300, atRisk: 12, firstError: 500, delivery: 300, ciServices: 200,
  // Channel size limits are in BYTES (Teams about 28 KB, Webex 7,439 bytes). take() counts UTF-16 units and one unit is at most
  // 3 bytes in UTF-8, so a cap of N units can never exceed 3 x N bytes whatever the text contains (emoji, CJK, RTL...).
  teamsEscaped: 8000, slackEscaped: 12000, webexText: 2400, webhookText: 12000 }
export const SENTINEL = '2000-01-01T00:00:00Z'      // "never": datetime columns are always written with a real value, never null
export const ROUND_SETTLE_MINUTES = 2               // a round younger than this may still be writing rows
export const SAME_FATE = 'Same-fate warning: this alert is produced by Power Automate, which runs in the same Microsoft cloud that is being watched (and Teams does too). In a Microsoft 365 or Power Platform outage it may be late or never arrive. Rely on the external heartbeat and the independent monitor for that case.'
export const TITLES = { failure: '\u{1F534} SERVICE FAILURE - Outage Watch', recovered: '✅ RECOVERED - Outage Watch', test: '\u{1F9EA} TEST - Outage Watch alert test. No outage is implied; no action needed.' }
export const TAGS = { open: 'NEW FAILURE', reminder: 'STILL FAILING', recovered: 'RECOVERED', closed: 'CLOSED' }
export const SHORTENED = '... (message shortened to fit this channel; see the dashboard for everything)'
export const STALE_TITLE = '\u26A0\uFE0F PROBING STOPPED - Outage Watch has no new probe round'
/** Common-cause wording (no apostrophes: these sit inside workflow-language string literals). */
export const COMMON = {
  authLead: 'PROBABLE COMMON CAUSE: sign-in (auth) is failing its probe. Services that need sign-in will fail for signed-in users even if their own probe still answers.',
  evidence: 'Evidence: ',
  atRisk: 'At risk downstream: ',
  cannotKnow: 'What the probes cannot know: the actual root cause, or whether your tenant is affected. They only saw that the sign-in endpoint did not answer normally.',
  copilot: 'Probable cause of the Copilot failure: services it reads from are failing too: ',
}
const FMT = 'yyyy-MM-ddTHH:mm:ssZ'
const NL = "decodeUriComponent('%0A')"
const CR = "decodeUriComponent('%0D')"

const ALWAYS = ['Succeeded', 'Failed', 'Skipped', 'TimedOut']
const DONE = ['Succeeded', 'Failed', 'TimedOut']
const AUTH = "@parameters('$authentication')"
const dv = (operationId, parameters, runAfter) => ({ runAfter, metadata: {}, type: 'OpenApiConnection', inputs: { host: { apiId: CONNREF.connectorId, connectionName: CONNREF.api, operationId }, parameters, authentication: AUTH } })
const query = (from, where, runAfter) => ({ runAfter, metadata: {}, type: 'Query', inputs: { from, where } })
const select = (from, sel, runAfter) => ({ runAfter, metadata: {}, type: 'Select', inputs: { from, select: sel } })
const compose = (inputs, runAfter) => ({ runAfter, metadata: {}, type: 'Compose', inputs })
const ok = (name) => ({ [name]: ['Succeeded'] })

/** HTML-escape inside the workflow language (Teams). */
export const esc = (x) => `replace(replace(replace(replace(${x},'&','&amp;'),'<','&lt;'),'>','&gt;'),'"','&quot;')`
/** Slack needs exactly &, < and > escaped; that also disarms <!channel> style mentions and links. */
const slackEsc = (x) => `replace(replace(replace(${x},'&','&amp;'),'<','&lt;'),'>','&gt;')`
/** Bounded one-line text from a probe / target value. */
const cap = (x, n) => `take(replace(replace(string(coalesce(${x},'')),${NL},' '),${CR},' '),${n})`
const setting = (q) => `first(body('${q}'))?['owatch_value']`
const settingId = (q) => `first(body('${q}'))?['owatch_settingid']`
const settingQuery = (key, runAfter) => query("@body('List_settings')?['value']", `@equals(item()?['owatch_name'],'${key}')`, runAfter)
const safeInt = (v, dflt, lo, hi) => `max(${lo},min(${hi},int(if(isInt(coalesce(${v},'')),coalesce(${v},''),'${dflt}'))))`
/** Cuts a message to `n` UTF-16 units and SAYS so, instead of silently dropping the end. */
export const shorten = (x, n) => `if(greater(length(${x}),${n}),concat(take(${x},${n - 100}),${NL},'${SHORTENED}'),${x})`
const odataText = (x) => `replace(string(coalesce(${x},'')),'''','''''')`       // apostrophes doubled for an OData string literal

/**
 * The post action of every configured channel for the plain-text message in `text` (a workflow expression).
 * Shared by the alert flow and the test-notification flow, so a test uses exactly the encodings of a real alert.
 */
export function buildPosts(ch, text) {
  const hook = (uri, body) => ({
    metadata: {}, type: 'Http', inputs: { method: 'POST', uri, headers: { 'Content-Type': 'application/json' }, body, retryPolicy: { type: 'none' } },
    limit: { timeout: 'PT20S' }, operationOptions: 'DisableAsyncPattern',
    runtimeConfiguration: { secureData: { properties: ['inputs', 'outputs'] } },          // the URL is the credential: keep it out of the run history
  })
  return {
    teams: ch.teams && {
      metadata: {}, type: 'OpenApiConnection',
      inputs: {
        host: { apiId: TEAMS_CONNREF.connectorId, connectionName: TEAMS_CONNREF.api, operationId: 'PostMessageToConversation' },
        parameters: { poster: 'Flow bot', location: 'Channel', 'body/recipient/groupId': ch.teams.groupId, 'body/recipient/channelId': ch.teams.channelId,
          'body/messageBody': `@concat('<p>',replace(${shorten(esc(text), CAPS.teamsEscaped)},${NL},'<br>'),'</p>')` },
        authentication: AUTH,
      },
    },
    slack: ch.slack && hook(ch.slack, { text: `@${shorten(slackEsc(text), CAPS.slackEscaped)}` }),
    webex: ch.webex && hook(ch.webex, { text: `@${shorten(text, CAPS.webexText)}` }),          // "text", not "markdown": nothing in it is interpreted
    webhook: ch.webhook && hook(ch.webhook, { text: `@${shorten(text, CAPS.webhookText)}` }),
  }
}
/** Building blocks reused by provision/lib/test-flow.mjs. */
export const kit = { NL, FMT, ALWAYS, DONE, AUTH, dv, query, select, compose, ok, cap, setting, settingId, settingQuery }

/**
 * @param {{intervalMinutes:number, sets:{target:string,result:string,setting:string,incident:string},
 *          channels:{teams?:{groupId:string,channelId:string}|null, slack?:string|null, webex?:string|null, webhook?:string|null}}} o
 */
export function buildAlertClientData(o) {
  const ch = o.channels ?? {}
  const T = (c) => `items('For_each_interesting')?['${c}']`
  const ctx = (k) => `outputs('Ctx')?['${k}']`
  const c1 = (k) => `outputs('C1')?['${k}']`
  const c2 = (k) => `outputs('C2')?['${k}']`
  const row = (c) => `first(body('Row'))?['${c}']`
  const lim = columnSpec('owatch_target')
  const inc = columnSpec('owatch_incident')

  const settingsQueries = {}
  let prev = 'List_settings'
  for (const [name, key] of [['S_enabled', 'alert_enabled'], ['S_confirm', 'alert_confirm'], ['S_reminder', 'alert_reminder_minutes'], ['S_snooze', 'alert_snooze_until'], ['S_test', 'alert_test'], ['S_lastround', 'alert_last_round'], ['S_stale', 'alert_stale_notified']]) {
    settingsQueries[name] = settingQuery(key, ok(prev)); prev = name
  }

  const reaches = `greaterOrEquals(add(${c1('prev')},1),${ctx('confirm')})`
  const isOpen = `and(${reaches},not(${c1('wasOpen')}))`
  const isReminder = `and(${c1('wasOpen')},greaterOrEquals(${c1('sinceLast')},${ctx('reminder')}))`
  const hold = `and(${c1('active')},not(${c1('probed')}))`
  const newStreak = `and(${c1('failNow')},equals(${c1('prev')},0))`

  // ---- the message is built ONCE as plain text; each channel gets it in its own safe encoding ----
  const tag = `if(equals(${c2('event')},'open'),'${TAGS.open}',if(equals(${c2('event')},'reminder'),'${TAGS.reminder}',if(${c1('active')},'${TAGS.recovered}','${TAGS.closed}')))`
  const errText = `concat(${cap(row('owatch_errorkind'), CAPS.kind)},' ',${cap(row('owatch_errormessage'), CAPS.error)})`
  const errShown = `if(equals(length(${errText}),1),'none reported (see the HTTP status)',${errText})`
  const failingDetails = `concat('Result: ',if(equals(coalesce(${row('owatch_httpstatus')},0),0),'no HTTP answer',concat('HTTP ',string(coalesce(${row('owatch_httpstatus')},0)))),' after ',string(coalesce(${row('owatch_elapsedms')},0)),' ms',${NL},'  Error: ',${errShown},${NL},'  Failing since: ',${cap(c2('since'), 40)},' UTC | consecutive failures: ',string(${c2('count')}),' | last success (probe round): ',${cap(c2('lastok'), 40)})`
  const closedDetails = `'No longer monitored (the target was disabled or its URL removed). The incident is closed WITHOUT a recovery having been observed.'`
  const recoveredDetails0 = `concat('Answering again. Was failing since ',${cap(`coalesce(${T('owatch_failingsince')},'unknown')`, 40)},' UTC (about ',string(${c1('downMinutes')}),' min, ',string(${c1('prev')}),' failed round(s)).')`
  const recoveredDetails = `if(${c1('active')},${recoveredDetails0},${closedDetails})`
  const famName = `if(empty(coalesce(${T('owatch_family')},'')),'Other',${T('owatch_family')})`
  const heading = `if(equals(variables('LastFamily'),coalesce(${T('owatch_family')},'')),'',concat('== ',${cap(famName, CAPS.family)},' ==',${NL}))`
  const itemText = `concat(${heading},'[',${tag},'] ',${cap(T('owatch_name'), CAPS.name)},${NL},'  URL: ',${cap(T('owatch_url'), CAPS.url)},${NL},'  ',if(${c1('failNow')},${failingDetails},${recoveredDetails}),${NL})`

  const failNames = "body('FailNames')"
  // Root cause first: when sign-in fails, say so ONCE with the evidence, instead of leaving the reader to infer it from a
  // list of equal-looking failures. Always "probable": the probes see symptoms, never causes.
  const notes = `concat('Failing in this probe round: ',string(length(${failNames})),' service(s).',${NL},` +
    `if(contains(${failNames},'auth'),concat('${COMMON.authLead}',${NL},'${COMMON.evidence}',string(length(body('DepFailing'))),' of the other ',string(sub(length(${failNames}),1)),' failing service(s) need sign-in; ',string(length(body('AtRiskNames'))),' monitored services need sign-in in total.',${NL},` +
    `'${COMMON.atRisk}',join(take(body('AtRiskNames'),${CAPS.atRisk}),', '),if(greater(length(body('AtRiskNames')),${CAPS.atRisk}),concat(' and ',string(sub(length(body('AtRiskNames')),${CAPS.atRisk})),' more'),''),${NL},'${COMMON.cannotKnow}',${NL}),''),` +
    `if(and(contains(${failNames},'m365-copilot'),greater(length(body('CopNames')),0)),concat('${COMMON.copilot}',join(take(body('CopNames'),${CAPS.atRisk}),', '),${NL}),''))`

  const nOpen = "length(body('Ev_open'))"; const nStill = "length(body('Ev_still'))"; const nRec = "length(body('Ev_recovered'))"
  const title = `if(greater(length(variables('Events')),0),if(greater(add(${nOpen},${nStill}),0),'${TITLES.failure}','${TITLES.recovered}'),if(${ctx('staleNow')},'${STALE_TITLE}','${TITLES.test}'))`
  const staleLine = `if(${ctx('staleNow')},concat('No new probe round for ',string(${ctx('staleMinutes')}),' minutes (last round: ',${cap(`coalesce(${ctx('round')},'-')`, 40)},', expected every ${o.intervalMinutes} minutes). The probe flow may be off, throttled or failing. Service status is UNKNOWN until probing resumes.',${NL}),'')`
  const dash = `coalesce(${setting('S_dashboard')},'')`
  const messageText = `@concat(${title},${NL},'Time: ',${ctx('now')},' UTC | probe round: ',${cap(`coalesce(${ctx('round')},'-')`, 40)},${NL},'New failures: ',string(${nOpen}),' | still failing (reminder): ',string(${nStill}),' | recovered: ',string(${nRec}),${NL},` +
    `if(${ctx('test')},concat('(TEST requested with the setting alert_test)',${NL}),''),${staleLine},variables('Notes'),${NL},join(take(body('Items'),${CAPS.detailed}),${NL}),` +
    `if(greater(length(body('Items')),${CAPS.detailed}),concat(${NL},'... and ',string(sub(length(body('Items')),${CAPS.detailed})),' more (see the dashboard).',${NL}),''),` +
    `if(startsWith(${dash},'https://'),concat(${NL},'Dashboard: ',${cap(dash, 400)},${NL}),''),${NL},'${SAME_FATE}')`
  const text = "outputs('Message')"

  // ---- CI / agent status: one small JSON text, rewritten every judged round (so its age shows if judging stopped) ----
  const level = `if(or(greater(length(body('Confirmed')),0),contains(${failNames},'auth')),'freeze',if(greater(length(${failNames}),0),'caution','ok'))`
  const prevCi = `coalesce(${setting('S_ci')},'')`
  const since = `if(and(startsWith(${prevCi},concat('{"level":"',${level},'"')),contains(${prevCi},'"since":"')),take(first(split(last(split(${prevCi},'"since":"')),'"')),20),${ctx('now')})`
  const services = `take(replace(replace(join(take(${failNames},40),','),'"',''),'\\',''),${CAPS.ciServices})`
  const ciValue = `@concat('{"level":"',${level},'","since":"',${since},'","updated":"',${ctx('now')},'","round":"',${ctx('round')},'","failing":',string(length(${failNames})),',"confirmed":',string(length(body('Confirmed'))),',"services":"',${services},'"}')`

  // ---- delivery: one independent branch per configured channel ----
  const posts = buildPosts(ch, text)
  const configured = CHANNELS.filter((c) => posts[c])
  const deliver = {}
  let after = 'S_off'
  const branches = []
  for (const c of CHANNELS) {
    if (!posts[c]) continue
    const P = `Post_${c}`
    // Teams reports a readable error. For webhooks ONLY the status code is kept: an error text could repeat the URL.
    const detail = c === 'teams' ? `string(coalesce(actions('${P}')?['error']?['message'],actions('${P}')?['code'],'failed'))` : `concat('HTTP ',string(coalesce(outputs('${P}')?['statusCode'],0)),' ',string(coalesce(actions('${P}')?['code'],'')))`
    deliver[`S_del_${c}`] = settingQuery(`last_delivery_${c}`, ok(after))
    deliver[`If_${c}`] = {
      runAfter: ok(`S_del_${c}`), type: 'If',
      expression: { not: { contains: [`@concat(',',replace(toLower(coalesce(${setting('S_off')},'')),' ',''),',')`, `,${c},`] } },       // setting alert_channels_off = "slack,webex" switches channels off
      actions: {
        [P]: { runAfter: {}, ...posts[c] },
        [`Status_${c}`]: dv('UpdateRecord', {
          entityName: o.sets.setting, recordId: `@${settingId(`S_del_${c}`)}`,
          'item/owatch_value': `@take(if(equals(actions('${P}')?['status'],'Succeeded'),concat('ok ',${ctx('now')}),concat('FAILED ',${ctx('now')},' ',${detail})),${CAPS.delivery})`,
        }, { [P]: DONE }),
      },
      else: { actions: {} },
    }
    // one failing channel never blocks the next: each branch starts whatever happened before
    deliver[`S_del_${c}`].runAfter = after === 'S_off' ? ok('S_off') : { [after]: ALWAYS }
    after = `If_${c}`; branches.push(after)
  }

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
      // probing stopped? (the newest complete round is older than 3 intervals + 5 minutes). Announced ONCE per stale round.
      staleMinutes: `@div(sub(ticks(utcNow('${FMT}')),ticks(coalesce(first(body('Latest_round')?['value'])?['owatch_round'],utcNow('${FMT}')))),600000000)`,
      staleNow: `@and(not(equals(toLower(coalesce(${setting('S_enabled')},'yes')),'no')),not(greater(coalesce(${setting('S_snooze')},''),utcNow('${FMT}'))),greater(div(sub(ticks(utcNow('${FMT}')),ticks(coalesce(first(body('Latest_round')?['value'])?['owatch_round'],utcNow('${FMT}')))),600000000),${3 * o.intervalMinutes + 5}),not(equals(coalesce(${setting('S_stale')},''),coalesce(first(body('Latest_round')?['value'])?['owatch_round'],'-'))))`,
    }, ok('Latest_round')),
    If_new_round: {
      runAfter: ok('Ctx'), type: 'If',
      expression: { and: [{ not: { equals: [`@coalesce(${ctx('round')},'')`, ''] } }, { not: { equals: [`@coalesce(${ctx('round')},'')`, `@${ctx('prevRound')}`] } }] },
      actions: {
        // FIRST remember the round: a run that fails later must not make the next run count the same round twice
        Save_round: dv('UpdateRecord', { entityName: o.sets.setting, recordId: `@${settingId('S_lastround')}`, 'item/owatch_value': `@${ctx('round')}` }, {}),
        // ALL rows of the round, not only the failed ones: a target WITHOUT a row was not probed (its write failed, or it
        // is new) and must be treated as "unknown", never as "answered" - otherwise a lost row would announce a recovery.
        List_round: dv('ListRecords', {
          entityName: o.sets.result, $select: 'owatch_name,owatch_httpstatus,owatch_elapsedms,owatch_errorkind,owatch_errormessage,owatch_probedat,owatch_failed',
          $filter: `owatch_round eq '@{${ctx('round')}}'`, $top: 1000,
        }, ok('Save_round')),
        FailRows: query("@body('List_round')?['value']", "@equals(item()?['owatch_failed'],true)", ok('List_round')),
        FailNames: select("@body('FailRows')", "@item()?['owatch_name']", ok('FailRows')),
        RoundNames: select("@body('List_round')?['value']", "@item()?['owatch_name']", ok('FailNames')),
        List_targets: dv('ListRecords', {
          entityName: o.sets.target, $filter: 'statecode eq 0', $orderby: 'owatch_family asc,owatch_name asc', $top: 500,
          $select: 'owatch_targetid,owatch_name,owatch_url,owatch_family,owatch_enabled,owatch_dependsonauth,owatch_copilotneeds,owatch_failcount,owatch_failingsince,owatch_lastok,owatch_alertopen,owatch_lastalertat',
        }, ok('RoundNames')),
        // normally EMPTY: only targets that fail now, are in a failure streak, or have an open incident are processed
        Interesting: query("@body('List_targets')?['value']", `@or(contains(${failNames},item()?['owatch_name']),greater(coalesce(item()?['owatch_failcount'],0),0),equals(item()?['owatch_alertopen'],true))`, ok('List_targets')),
        // CI / agent status (uses the state BEFORE this round's updates: "would be confirmed by this round")
        Confirmed: query("@body('List_targets')?['value']", `@and(contains(${failNames},item()?['owatch_name']),greaterOrEquals(add(coalesce(item()?['owatch_failcount'],0),1),${ctx('confirm')}))`, ok('Interesting')),
        S_ci: settingQuery('ci_status', ok('Confirmed')),
        Save_ci: dv('UpdateRecord', { entityName: o.sets.setting, recordId: `@${settingId('S_ci')}`, 'item/owatch_value': ciValue }, ok('S_ci')),
        For_each_interesting: {
          runAfter: { Save_ci: DONE }, type: 'Foreach', foreach: "@body('Interesting')",        // a missing status row must not stop alerting
          runtimeConfiguration: { concurrency: { repetitions: 1 } },        // in order: the message is grouped by family, and variables are shared
          actions: {
            Row: query("@body('FailRows')", `@equals(item()?['owatch_name'],${T('owatch_name')})`, {}),
            C1: compose({
              failNow: "@greater(length(body('Row')),0)",
              prev: `@coalesce(${T('owatch_failcount')},0)`,
              wasOpen: `@equals(${T('owatch_alertopen')},true)`,
              can: `@and(${ctx('enabled')},not(${ctx('muted')}))`,
              probed: `@contains(body('RoundNames'),${T('owatch_name')})`,
              active: `@and(equals(${T('owatch_enabled')},true),not(empty(coalesce(${T('owatch_url')},''))))`,
              sinceLast: `@div(sub(ticks(${ctx('now')}),ticks(coalesce(${T('owatch_lastalertat')},'${SENTINEL}'))),600000000)`,
              downMinutes: `@max(0,min(${inc.owatch_durationminutes.max},div(sub(ticks(${ctx('now')}),ticks(coalesce(${T('owatch_failingsince')},${ctx('now')}))),600000000)))`,
            }, ok('Row')),
            C2: compose({
              // hold = still monitored but NOT in this round: nothing is concluded, nothing changes
              count: `@if(${hold},${c1('prev')},if(${c1('failNow')},min(add(${c1('prev')},1),${lim.owatch_failcount.max}),0))`,
              event: `@if(or(${hold},not(${c1('can')})),'none',if(${c1('failNow')},if(${isOpen},'open',if(${isReminder},'reminder','none')),if(${c1('wasOpen')},'recovered','none')))`,
              open: `@if(${hold},${c1('wasOpen')},if(${c1('failNow')},or(${c1('wasOpen')},and(${c1('can')},${reaches})),false))`,
              since: `@if(${newStreak},coalesce(${row('owatch_probedat')},${ctx('now')}),coalesce(${T('owatch_failingsince')},${ctx('now')}))`,
              lastok: `@take(string(if(${newStreak},if(empty(${ctx('prevRound')}),'unknown',${ctx('prevRound')}),coalesce(${T('owatch_lastok')},'unknown'))),${lim.owatch_lastok.maxLength})`,
              lastAlert: `@if(and(not(${hold}),${c1('can')},${c1('failNow')},or(${isOpen},${isReminder})),${ctx('now')},coalesce(${T('owatch_lastalertat')},'${SENTINEL}'))`,
            }, ok('C1')),
            Update_target: dv('UpdateRecord', {
              entityName: o.sets.target, recordId: `@${T('owatch_targetid')}`,
              'item/owatch_failcount': `@${c2('count')}`, 'item/owatch_failingsince': `@${c2('since')}`, 'item/owatch_lastok': `@${c2('lastok')}`,
              'item/owatch_alertopen': `@${c2('open')}`, 'item/owatch_lastalertat': `@${c2('lastAlert')}`,
            }, ok('C2')),
            If_event: {
              runAfter: ok('Update_target'), type: 'If', expression: { not: { equals: [`@${c2('event')}`, 'none'] } },
              actions: {
                Append_event: { runAfter: {}, type: 'AppendToArrayVariable', inputs: { name: 'Events', value: { e: `@${c2('event')}`, n: `@${T('owatch_name')}`, text: `@${itemText}`,
                  // kept so the state can be put back if NO channel accepts the message (then the next round tries again)
                  id: `@${T('owatch_targetid')}`, wasOpen: `@${c1('wasOpen')}`, prevAlert: `@coalesce(${T('owatch_lastalertat')},'${SENTINEL}')` } } },
                Set_family: { runAfter: ok('Append_event'), type: 'SetVariable', inputs: { name: 'LastFamily', value: `@coalesce(${T('owatch_family')},'')` } },
                // incident record: opened with the first announcement, updated by reminders, closed by the recovery.
                // Find first: a repeated "open" (after a delivery that failed everywhere) must not create a second record.
                Find_incident: dv('ListRecords', { entityName: o.sets.incident, $select: 'owatch_incidentid,owatch_reminders', $filter: `owatch_name eq '@{${odataText(T('owatch_name'))}}' and owatch_isopen eq true`, $orderby: 'owatch_openedat desc', $top: 1 }, ok('Set_family')),
                If_opened: {
                  runAfter: ok('Find_incident'), type: 'If', expression: { equals: [`@${c2('event')}`, 'open'] },
                  actions: {
                    If_none: {
                      runAfter: {}, type: 'If', expression: { equals: ["@length(body('Find_incident')?['value'])", 0] },
                      actions: {
                        Create_incident: dv('CreateRecord', {
                          entityName: o.sets.incident,
                          'item/owatch_name': `@${cap(T('owatch_name'), inc.owatch_name.maxLength)}`, 'item/owatch_family': `@${cap(famName, inc.owatch_family.maxLength)}`,
                          'item/owatch_openedat': `@${c2('since')}`, 'item/owatch_closedat': SENTINEL, 'item/owatch_isopen': true,
                          'item/owatch_firsterror': `@take(concat(if(equals(coalesce(${row('owatch_httpstatus')},0),0),'no HTTP answer',concat('HTTP ',string(coalesce(${row('owatch_httpstatus')},0)))),' - ',${errShown}),${CAPS.firstError})`,
                          'item/owatch_reminders': 0, 'item/owatch_durationminutes': 0, 'item/owatch_failedrounds': `@min(${c2('count')},${inc.owatch_failedrounds.max})`,
                        }, {}),
                      },
                      else: { actions: {} },
                    },
                  },
                  else: {
                    actions: {
                      If_found: {
                        runAfter: {}, type: 'If', expression: { greater: ["@length(body('Find_incident')?['value'])", 0] },
                        actions: {
                          Update_incident: dv('UpdateRecord', {
                            entityName: o.sets.incident, recordId: "@first(body('Find_incident')?['value'])?['owatch_incidentid']",
                            'item/owatch_isopen': `@not(equals(${c2('event')},'recovered'))`,
                            'item/owatch_closedat': `@if(equals(${c2('event')},'recovered'),${ctx('now')},'${SENTINEL}')`,
                            'item/owatch_reminders': `@min(add(coalesce(first(body('Find_incident')?['value'])?['owatch_reminders'],0),if(equals(${c2('event')},'reminder'),1,0)),${inc.owatch_reminders.max})`,
                            'item/owatch_durationminutes': `@${c1('downMinutes')}`,
                            'item/owatch_failedrounds': `@min(if(${c1('failNow')},${c2('count')},${c1('prev')}),${inc.owatch_failedrounds.max})`,
                          }, {}),
                        },
                        else: { actions: {} },
                      },
                    },
                  },
                },
              },
              else: { actions: {} },
            },
          },
        },
        If_notes: {
          runAfter: ok('For_each_interesting'), type: 'If', expression: { greater: ["@length(variables('Events'))", 0] },
          actions: {
            AtRisk: query("@body('List_targets')?['value']", "@and(equals(item()?['owatch_dependsonauth'],true),equals(item()?['owatch_enabled'],true),not(empty(coalesce(item()?['owatch_url'],''))),not(equals(item()?['owatch_name'],'auth')))", {}),
            AtRiskNames: select("@body('AtRisk')", `@${cap("item()?['owatch_name']", CAPS.name)}`, ok('AtRisk')),
            DepFailing: query("@body('List_targets')?['value']", `@and(equals(item()?['owatch_dependsonauth'],true),contains(${failNames},item()?['owatch_name']),not(equals(item()?['owatch_name'],'auth')))`, ok('AtRiskNames')),
            CopUnder: query("@body('List_targets')?['value']", `@and(equals(item()?['owatch_copilotneeds'],true),contains(${failNames},item()?['owatch_name']),not(equals(item()?['owatch_name'],'m365-copilot')))`, ok('DepFailing')),
            CopNames: select("@body('CopUnder')", `@${cap("item()?['owatch_name']", CAPS.name)}`, ok('CopUnder')),
            Set_notes: { runAfter: ok('CopNames'), type: 'SetVariable', inputs: { name: 'Notes', value: `@${notes}` } },
          },
          else: { actions: {} },
        },
      },
      else: { actions: {} },
    },
    If_should_post: {
      runAfter: { If_new_round: ALWAYS }, type: 'If',     // also runs when the evaluation was skipped or failed: a TEST must still go out
      expression: { or: [{ equals: [`@${ctx('test')}`, true] }, { greater: ["@length(variables('Events'))", 0] }, { equals: [`@${ctx('staleNow')}`, true] }] },
      actions: {
        S_lastat: settingQuery('last_alert_at', {}),
        S_dashboard: settingQuery('dashboard_url', ok('S_lastat')),
        Ev_open: query("@variables('Events')", "@equals(item()?['e'],'open')", ok('S_dashboard')),
        Ev_still: query("@variables('Events')", "@equals(item()?['e'],'reminder')", ok('Ev_open')),
        Ev_recovered: query("@variables('Events')", "@equals(item()?['e'],'recovered')", ok('Ev_still')),
        Items: select("@variables('Events')", "@item()?['text']", ok('Ev_recovered')),
        Message: compose(messageText, ok('Items')),
        S_off: settingQuery('alert_channels_off', ok('Message')),
        ...deliver,
        // Did ANY channel accept the message? Only then is it "sent". (actions() of a branch that did not run is null -> false.)
        AnyOk: compose(configured.length ? `@or(${configured.map((c) => `equals(actions('Post_${c}')?['status'],'Succeeded')`).join(',')}${configured.length === 1 ? ',false' : ''})` : false, { [after]: after === 'S_off' ? ['Succeeded'] : ALWAYS }),
        If_delivered: {
          runAfter: ok('AnyOk'), type: 'If', expression: { equals: ["@outputs('AnyOk')", true] },
          actions: {
            Mark_sent: dv('UpdateRecord', { entityName: o.sets.setting, recordId: `@${settingId('S_lastat')}`, 'item/owatch_value': `@${ctx('now')}` }, {}),
            If_test: {
              runAfter: { Mark_sent: DONE }, type: 'If', expression: { equals: [`@${ctx('test')}`, true] },
              actions: { Clear_test: dv('UpdateRecord', { entityName: o.sets.setting, recordId: `@${settingId('S_test')}`, 'item/owatch_value': 'no' }, {}) },
              else: { actions: {} },
            },
            If_stale: {
              runAfter: { If_test: DONE }, type: 'If', expression: { equals: [`@${ctx('staleNow')}`, true] },
              actions: { Save_stale: dv('UpdateRecord', { entityName: o.sets.setting, recordId: `@${settingId('S_stale')}`, 'item/owatch_value': `@coalesce(${ctx('round')},'-')` }, {}) },
              else: { actions: {} },
            },
          },
          // NOTHING was delivered: put the alert state of this round's events back, so the next round announces them again.
          // Never dropped silently (each channel's failure is in its last_delivery_* setting), never repeated once delivered.
          else: {
            actions: {
              Roll_back: {
                runAfter: {}, type: 'Foreach', foreach: "@variables('Events')", runtimeConfiguration: { concurrency: { repetitions: 1 } },
                actions: {
                  Undo_alert_state: dv('UpdateRecord', { entityName: o.sets.target, recordId: "@items('Roll_back')?['id']", 'item/owatch_alertopen': "@items('Roll_back')?['wasOpen']", 'item/owatch_lastalertat': "@items('Roll_back')?['prevAlert']" }, {}),
                },
              },
            },
          },
        },
      },
      else: { actions: {} },
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
        triggers: { Recurrence: { type: 'Recurrence', recurrence: { frequency: 'Minute', interval: o.intervalMinutes }, runtimeConfiguration: { concurrency: { runs: 1 } } } },
        actions,
      },
    },
    schemaVersion: '1.0.0.0',
  }
}

/** Channels of an existing alert flow, so a re-run without the channel options keeps them. NEVER log the result: webhook URLs are secrets. */
export function existingChannels(clientdataText) {
  const out = { teams: null, slack: null, webex: null, webhook: null }
  try {
    const a = JSON.parse(clientdataText)?.properties?.definition?.actions?.If_should_post?.actions ?? {}
    const p = a.If_teams?.actions?.Post_teams?.inputs?.parameters
    if (typeof p?.['body/recipient/groupId'] === 'string' && typeof p?.['body/recipient/channelId'] === 'string') out.teams = { groupId: p['body/recipient/groupId'], channelId: p['body/recipient/channelId'] }
    for (const c of ['slack', 'webex', 'webhook']) { const u = a[`If_${c}`]?.actions?.[`Post_${c}`]?.inputs?.uri; if (typeof u === 'string' && u.startsWith('https://')) out[c] = u }
  } catch { /* unreadable definition: nothing to keep */ }
  return out
}

/**
 * Requests per run of the alert flow. Quiet run: trigger + 3 variables + list settings + 6 setting lookups + latest
 * round + context + new-round check + (save round, failing rows, names, targets, interesting, confirmed, status row
 * lookup, status write, loop, notes check) + post check = 28 (incl. the stale-notice lookup and the round's name lists). Each target that fails / recovers adds about 7-10
 * (incl. its incident record); a posted message adds about 10 plus 3 per channel.
 */
export function estimateAlertRequests(intervalMinutes, failingTargets = 0, posts = 0, channels = 1) {
  const perQuietRun = 28
  const runsPerDay = Math.floor(1440 / intervalMinutes)
  return { perQuietRun, runsPerDay, perDay: perQuietRun * runsPerDay + failingTargets * 10 * runsPerDay + posts * (10 + 3 * channels) }
}
