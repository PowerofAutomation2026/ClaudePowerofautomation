// REFERENCE implementation of the alert / incident / CI-status logic, in plain JavaScript.
//
// The real logic runs inside a Power Automate flow (provision/lib/alert-flow.mjs), written in workflow
// expressions that cannot be unit-tested directly. This file states the intended behaviour in a form that can be
// tested thoroughly; tests/alert-flow.test.ts then executes the GENERATED flow definition with a small
// interpreter (tests/helpers/wdl.mjs) against the mock Dataverse and requires both to agree, round after round.
// (The interpreter is this project's reading of the workflow language - it is not Microsoft's engine.)
import { CAPS, COMMON, ROUND_SETTLE_MINUTES, SAME_FATE, SENTINEL, SHORTENED, STALE_TITLE, TAGS, TITLES } from './alert-flow.mjs'

/** Same rule the probe flow writes into owatch_failed. `aliveText` is the target's alive-codes text ('' = any). */
export function isFailure(httpStatus, aliveText) {
  const s = httpStatus == null ? 0 : httpStatus
  const alive = String(aliveText ?? '').replace(/ /g, '')
  return s === 0 || s >= 500 || s === 429 || (alive !== '' && !(',' + alive + ',').includes(',' + s + ','))
}

const isIntText = (v) => /^[+-]?[0-9]+$/.test(v)
const clampInt = (v, dflt, lo, hi) => Math.max(lo, Math.min(hi, parseInt(isIntText(v ?? '') ? v : String(dflt), 10)))
export const fmt = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')
const minutesBetween = (a, b) => Math.trunc((Date.parse(b) - Date.parse(a)) / 60_000)
/** One bounded line of text from a probe / target value. */
const cap = (v, n) => String(v ?? '').replace(/\n/g, ' ').replace(/\r/g, ' ').slice(0, n)

/** Settings (name -> text) + clock -> the values every decision uses. Bad input never throws: defaults apply. */
export function context(settings, nowMs, latestRound, intervalMinutes = 10) {
  const now = fmt(nowMs)
  const enabled = String(settings.alert_enabled ?? 'yes').toLowerCase() !== 'no'
  const muted = String(settings.alert_snooze_until ?? '') > now
  const staleMinutes = Math.trunc((Date.parse(now) - Date.parse(latestRound ?? now)) / 60_000)
  return {
    staleMinutes,
    // probing stopped: the newest complete round is older than 3 intervals + 5 minutes; announced once per stale round
    staleNow: enabled && !muted && staleMinutes > 3 * intervalMinutes + 5 && (settings.alert_stale_notified ?? '') !== (latestRound ?? '-'),
    now, round: latestRound ?? null, prevRound: settings.alert_last_round ?? '',
    enabled: String(settings.alert_enabled ?? 'yes').toLowerCase() !== 'no',
    confirm: clampInt(settings.alert_confirm, 2, 1, 10),
    reminder: clampInt(settings.alert_reminder_minutes, 60, 5, 10080),
    muted: String(settings.alert_snooze_until ?? '') > now,
    test: String(settings.alert_test ?? '').toLowerCase() === 'yes',
  }
}

/** Newest round that is certainly complete: started more than ROUND_SETTLE_MINUTES ago. */
export function latestCompleteRound(roundIds, nowMs) {
  const limit = fmt(nowMs - ROUND_SETTLE_MINUTES * 60_000)
  return roundIds.filter((r) => r && r < limit).sort().pop() ?? null
}

/**
 * The decision table for ONE target and ONE round.
 *   state: { failcount, failingsince, lastok, alertopen, lastalertat }  (nulls allowed: a target never seen before)
 *   failRow: the failed result row of this round, or null when the target answered / was not probed
 */
export function decide(state, failRow, ctx, { probed = true, active = true } = {}) {
  // probed: the target has a row in this round. active: it is enabled and has a URL.
  // hold: still monitored but absent from the round (its row was lost, or it is new): conclude nothing, change nothing.
  const hold = active && !probed
  const failNow = !!failRow
  const prev = state.failcount ?? 0
  const wasOpen = state.alertopen === true
  const can = ctx.enabled && !ctx.muted
  const sinceLast = minutesBetween(state.lastalertat ?? SENTINEL, ctx.now)
  const reaches = prev + 1 >= ctx.confirm
  const isOpen = reaches && !wasOpen
  const isReminder = wasOpen && sinceLast >= ctx.reminder
  const newStreak = failNow && prev === 0
  let event = 'none'
  if (can && !hold) event = failNow ? (isOpen ? 'open' : isReminder ? 'reminder' : 'none') : (wasOpen ? 'recovered' : 'none')
  return {
    failNow, prev, event, active, wasOpen,
    downMinutes: Math.max(0, Math.min(10000000, minutesBetween(state.failingsince ?? ctx.now, ctx.now))),
    count: hold ? prev : failNow ? Math.min(prev + 1, 1000000) : 0,
    open: hold ? wasOpen : failNow ? (wasOpen || (can && reaches)) : false,
    since: newStreak ? (failRow.owatch_probedat ?? ctx.now) : (state.failingsince ?? ctx.now),
    lastok: String(newStreak ? (ctx.prevRound === '' ? 'unknown' : ctx.prevRound) : (state.lastok ?? 'unknown')).slice(0, 40),
    lastAlert: !hold && can && failNow && (isOpen || isReminder) ? ctx.now : (state.lastalertat ?? SENTINEL),
  }
}

const errorShown = (failRow) => { const e = cap(failRow.owatch_errorkind, CAPS.kind) + ' ' + cap(failRow.owatch_errormessage, CAPS.error); return e.length === 1 ? 'none reported (see the HTTP status)' : e }
const resultShown = (failRow) => ((failRow.owatch_httpstatus ?? 0) === 0 ? 'no HTTP answer' : 'HTTP ' + failRow.owatch_httpstatus)
const familyShown = (t) => ((t.owatch_family ?? '') === '' ? 'Other' : t.owatch_family)

/** Plain-text block for one service. The SAME text goes to every channel (each channel encodes it safely). */
export function itemText(target, failRow, d, lastFamily) {
  const heading = lastFamily === (target.owatch_family ?? '') ? '' : '== ' + cap(familyShown(target), CAPS.family) + ' ==\n'
  const tag = d.event === 'open' ? TAGS.open : d.event === 'reminder' ? TAGS.reminder : d.active ? TAGS.recovered : TAGS.closed
  const details = d.failNow
    ? 'Result: ' + resultShown(failRow) + ' after ' + (failRow.owatch_elapsedms ?? 0) + ' ms\n  Error: ' + errorShown(failRow) + '\n  Failing since: ' + cap(d.since, 40) + ' UTC | consecutive failures: ' + d.count + ' | last success (probe round): ' + cap(d.lastok, 40)
    : !d.active ? 'No longer monitored (the target was disabled or its URL removed). The incident is closed WITHOUT a recovery having been observed.'
    : 'Answering again. Was failing since ' + cap(target.owatch_failingsince ?? 'unknown', 40) + ' UTC (about ' + d.downMinutes + ' min, ' + d.prev + ' failed round(s)).'
  return heading + '[' + tag + '] ' + cap(target.owatch_name, CAPS.name) + '\n  URL: ' + cap(target.owatch_url, CAPS.url) + '\n  ' + details + '\n'
}

/** Header notes. When sign-in fails: the probable common cause first, with the evidence and what cannot be known. */
export function notesText(targets, failNames) {
  let out = 'Failing in this probe round: ' + failNames.length + ' service(s).\n'
  if (failNames.includes('auth')) {
    const atRisk = targets.filter((t) => t.owatch_dependsonauth === true && t.owatch_enabled === true && (t.owatch_url ?? '') !== '' && t.owatch_name !== 'auth').map((t) => cap(t.owatch_name, CAPS.name))
    const depFailing = targets.filter((t) => t.owatch_dependsonauth === true && failNames.includes(t.owatch_name) && t.owatch_name !== 'auth').length
    out += COMMON.authLead + '\n' + COMMON.evidence + depFailing + ' of the other ' + (failNames.length - 1) + ' failing service(s) need sign-in; ' + atRisk.length + ' monitored services need sign-in in total.\n' +
      COMMON.atRisk + atRisk.slice(0, CAPS.atRisk).join(', ') + (atRisk.length > CAPS.atRisk ? ' and ' + (atRisk.length - CAPS.atRisk) + ' more' : '') + '\n' + COMMON.cannotKnow + '\n'
  }
  const under = targets.filter((t) => t.owatch_copilotneeds === true && failNames.includes(t.owatch_name) && t.owatch_name !== 'm365-copilot').map((t) => cap(t.owatch_name, CAPS.name))
  if (failNames.includes('m365-copilot') && under.length) out += COMMON.copilot + under.slice(0, CAPS.atRisk).join(', ') + '\n'
  return out
}

export function messageText(ctx, events, notes, dashboardUrl) {
  const n = (e) => events.filter((x) => x.e === e).length
  const title = events.length > 0 ? (n('open') + n('reminder') > 0 ? TITLES.failure : TITLES.recovered) : ctx.staleNow ? STALE_TITLE : TITLES.test
  const stale = ctx.staleNow ? 'No new probe round for ' + ctx.staleMinutes + ' minutes (last round: ' + cap(ctx.round ?? '-', 40) + ', expected every ' + ctx.intervalMinutes + ' minutes). The probe flow may be off, throttled or failing. Service status is UNKNOWN until probing resumes.\n' : ''
  const items = events.map((e) => e.text)
  const dash = dashboardUrl ?? ''
  return title + '\nTime: ' + ctx.now + ' UTC | probe round: ' + cap(ctx.round ?? '-', 40) + '\nNew failures: ' + n('open') + ' | still failing (reminder): ' + n('reminder') + ' | recovered: ' + n('recovered') + '\n' +
    (ctx.test ? '(TEST requested with the setting alert_test)\n' : '') + stale + notes + '\n' + items.slice(0, CAPS.detailed).join('\n') +
    (items.length > CAPS.detailed ? '\n... and ' + (items.length - CAPS.detailed) + ' more (see the dashboard).\n' : '') +
    (dash.startsWith('https://') ? '\nDashboard: ' + cap(dash, 400) + '\n' : '') + '\n' + SAME_FATE
}

// ---- per-channel encodings of the one text ----
export const escapeHtml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** Same as shorten() in the flow: cut to n UTF-16 units and say so. */
export const shortened = (text, n) => (text.length > n ? text.slice(0, n - 100) + '\n' + SHORTENED : text)
export const teamsHtml = (text) => '<p>' + shortened(escapeHtml(text), CAPS.teamsEscaped).replace(/\n/g, '<br>') + '</p>'
export const slackText = (text) => shortened(text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), CAPS.slackEscaped)
export const webexText = (text) => shortened(text, CAPS.webexText)
export const webhookText = (text) => shortened(text, CAPS.webhookText)
/** UTF-8 size of what is sent, for the byte limits of the channels. */
export const utf8Bytes = (text) => Buffer.byteLength(text, 'utf8')

/** The CI / agent status text (JSON) written every judged round. `targets` carry the state BEFORE this round. */
export function ciStatus(targets, failNames, ctx, previousValue) {
  const confirmed = targets.filter((t) => failNames.includes(t.owatch_name) && (t.owatch_failcount ?? 0) + 1 >= ctx.confirm).length
  const level = confirmed > 0 || failNames.includes('auth') ? 'freeze' : failNames.length > 0 ? 'caution' : 'ok'
  const prev = previousValue ?? ''
  const since = prev.startsWith('{"level":"' + level + '"') && prev.includes('"since":"') ? prev.split('"since":"').pop().split('"')[0].slice(0, 20) : ctx.now
  const services = failNames.slice(0, 40).join(',').replace(/"/g, '').replace(/\\/g, '').slice(0, CAPS.ciServices)
  return '{"level":"' + level + '","since":"' + since + '","updated":"' + ctx.now + '","round":"' + ctx.round + '","failing":' + failNames.length + ',"confirmed":' + confirmed + ',"services":"' + services + '"}'
}

/**
 * One run of the alert flow, as data in / data out.
 *   targets: target rows (active ones), any order;  roundRows: ALL result rows of `round` (failed or not)
 * Returns the target updates, the incident operations, the status text, the message text (or null), and what to
 * undo if NO channel accepts the message (`rollback`: the alert state of this round's events goes back, so the
 * next round announces them again).
 */
export function evaluateRun({ targets, roundRows, settings, nowMs, round, intervalMinutes = 10 }) {
  const ctx = { ...context(settings, nowMs, round, intervalMinutes), intervalMinutes }
  const out = { ctx, updates: [], events: [], incidents: [], rollback: [], text: null, ci: null, saveRound: null, clearTest: false }
  let notes = ''
  if ((ctx.round ?? '') !== '' && ctx.round !== ctx.prevRound) {
    out.saveRound = ctx.round
    const failingRows = roundRows.filter((r) => r.owatch_failed === true)
    const failNames = failingRows.map((r) => r.owatch_name)
    const roundNames = roundRows.map((r) => r.owatch_name)
    const ordered = [...targets].sort((a, b) => cmp(a.owatch_family ?? '', b.owatch_family ?? '') || cmp(a.owatch_name, b.owatch_name))
    out.ci = ciStatus(ordered, failNames, ctx, settings.ci_status)
    let lastFamily = ''
    for (const t of ordered) {
      if (!(failNames.includes(t.owatch_name) || (t.owatch_failcount ?? 0) > 0 || t.owatch_alertopen === true)) continue
      const failRow = failingRows.find((r) => r.owatch_name === t.owatch_name) ?? null
      const active = t.owatch_enabled === true && (t.owatch_url ?? '') !== ''
      const d = decide({ failcount: t.owatch_failcount, failingsince: t.owatch_failingsince, lastok: t.owatch_lastok, alertopen: t.owatch_alertopen, lastalertat: t.owatch_lastalertat }, failRow, ctx, { probed: roundNames.includes(t.owatch_name), active })
      out.updates.push({ name: t.owatch_name, owatch_failcount: d.count, owatch_failingsince: d.since, owatch_lastok: d.lastok, owatch_alertopen: d.open, owatch_lastalertat: d.lastAlert })
      if (d.event === 'none') continue
      out.events.push({ e: d.event, n: t.owatch_name, text: itemText(t, failRow, d, lastFamily) }); lastFamily = t.owatch_family ?? ''
      out.rollback.push({ name: t.owatch_name, owatch_alertopen: d.wasOpen, owatch_lastalertat: t.owatch_lastalertat ?? SENTINEL })
      if (d.event === 'open') {
        out.incidents.push({ op: 'open', name: cap(t.owatch_name, 100), row: { owatch_family: cap(familyShown(t), 100), owatch_openedat: d.since, owatch_isopen: true, owatch_firsterror: (resultShown(failRow) + ' - ' + errorShown(failRow)).slice(0, CAPS.firstError), owatch_reminders: 0, owatch_durationminutes: 0, owatch_failedrounds: d.count } })
      } else {
        out.incidents.push({ op: d.event === 'recovered' ? 'close' : 'remind', name: t.owatch_name, row: { owatch_isopen: d.event !== 'recovered', owatch_durationminutes: d.downMinutes, owatch_failedrounds: d.failNow ? d.count : d.prev, ...(d.event === 'recovered' ? { owatch_closedat: ctx.now } : {}) } })
      }
    }
    if (out.events.length) notes = notesText(ordered, failNames)
  }
  if (ctx.test || out.events.length || ctx.staleNow) { out.text = messageText(ctx, out.events, notes, settings.dashboard_url); out.clearTest = ctx.test }
  return out
}
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** Upper bound of the message TEXT in characters for ANY input (a test proves the caps hold). */
export function worstCaseTextChars() {
  const item = 6 + CAPS.family + 20 + CAPS.name + 10 + CAPS.url + 60 + CAPS.kind + 1 + CAPS.error + 130 + 80
  return 250 + 420 + (60 + 900 + 2 * (60 + CAPS.atRisk * (CAPS.name + 2) + 20)) + CAPS.detailed * (item + 1) + 60 + 420 + SAME_FATE.length + 10
}
