// REFERENCE implementation of the alert decision logic, in plain JavaScript.
//
// The real alerting runs inside a Power Automate flow (provision/lib/alert-flow.mjs), written in workflow
// expressions that cannot be unit-tested directly. This file states the intended behaviour in a form that can be
// tested thoroughly; tests/alert-flow.test.ts then executes the GENERATED flow definition with a small
// interpreter (tests/helpers/wdl.mjs) against the mock Dataverse and requires both to agree, round after round.
// (The interpreter is this project's reading of the workflow language - it is not Microsoft's engine.)
import { CAPS, ROUND_SETTLE_MINUTES, SAME_FATE, SENTINEL, TAGS, TITLES } from './alert-flow.mjs'

/** Same rule the probe flow writes into owatch_failed. `aliveText` is the target's alive-codes text ('' = any). */
export function isFailure(httpStatus, aliveText) {
  const s = httpStatus == null ? 0 : httpStatus
  const alive = String(aliveText ?? '').replace(/ /g, '')
  return s === 0 || s >= 500 || s === 429 || (alive !== '' && !(',' + alive + ',').includes(',' + s + ','))
}

const isIntText = (v) => /^[+-]?[0-9]+$/.test(v)
const clampInt = (v, dflt, lo, hi) => Math.max(lo, Math.min(hi, parseInt(isIntText(v ?? '') ? v : String(dflt), 10)))
export const fmt = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')

/** Settings (name -> text) + clock -> the values every decision uses. Bad input never throws: defaults apply. */
export function context(settings, nowMs, latestRound) {
  const now = fmt(nowMs)
  return {
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
export function decide(state, failRow, ctx) {
  const failNow = !!failRow
  const prev = state.failcount ?? 0
  const wasOpen = state.alertopen === true
  const can = ctx.enabled && !ctx.muted
  const sinceLast = Math.floor((Date.parse(ctx.now) - Date.parse(state.lastalertat ?? SENTINEL)) / 60_000)
  const reaches = prev + 1 >= ctx.confirm
  const isOpen = reaches && !wasOpen
  const isReminder = wasOpen && sinceLast >= ctx.reminder
  const newStreak = failNow && prev === 0
  let event = 'none'
  if (can) event = failNow ? (isOpen ? 'open' : isReminder ? 'reminder' : 'none') : (wasOpen ? 'recovered' : 'none')
  return {
    failNow, prev, event,
    count: failNow ? Math.min(prev + 1, 1000000) : 0,
    open: failNow ? (wasOpen || (can && reaches)) : false,
    since: newStreak ? (failRow.owatch_probedat ?? ctx.now) : (state.failingsince ?? ctx.now),
    lastok: String(newStreak ? (ctx.prevRound === '' ? 'unknown' : ctx.prevRound) : (state.lastok ?? 'unknown')).slice(0, 40),
    lastAlert: can && failNow && (isOpen || isReminder) ? ctx.now : (state.lastalertat ?? SENTINEL),
  }
}

export function escapeHtml(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
const capEsc = (v, raw, escaped) => escapeHtml(String(v ?? '').slice(0, raw)).slice(0, escaped)

export function itemHtml(target, failRow, d, lastFamily, ctx) {
  const fam = target.owatch_family ?? ''
  const heading = lastFamily === fam ? '' : '<p><b>' + capEsc(fam === '' ? 'Other' : fam, CAPS.family, CAPS.familyEsc) + '</b></p>'
  const tag = d.event === 'open' ? TAGS.open : d.event === 'reminder' ? TAGS.reminder : TAGS.recovered
  let details
  if (d.failNow) {
    const status = failRow.owatch_httpstatus ?? 0
    const err = capEsc(failRow.owatch_errorkind, CAPS.kind, CAPS.kindEsc) + ' ' + capEsc(failRow.owatch_errormessage, CAPS.error, CAPS.errorEsc)
    details = 'Result: ' + (status === 0 ? 'no HTTP answer' : 'HTTP ' + status) + ' after ' + (failRow.owatch_elapsedms ?? 0) + ' ms<br>Error: ' +
      (err.length === 1 ? 'none reported (see the HTTP status)' : err) + '<br>Failing since: ' + escapeHtml(d.since) + ' UTC | consecutive failures: ' + d.count +
      ' | last success (probe round): ' + escapeHtml(d.lastok)
  } else {
    const since = target.owatch_failingsince
    const minutes = Math.floor((Date.parse(ctx.now) - Date.parse(since ?? ctx.now)) / 60_000)
    details = 'Answering again. Was failing since ' + escapeHtml(since ?? 'unknown') + ' UTC (about ' + minutes + ' min, ' + d.prev + ' failed round(s)).'
  }
  return heading + '<p><b>[' + tag + '] ' + capEsc(target.owatch_name, CAPS.name, CAPS.nameEsc) + '</b><br>URL: ' + capEsc(target.owatch_url, CAPS.url, CAPS.urlEsc) + '<br>' + details + '</p>'
}

export function notesHtml(targets, failNames) {
  let out = '<p>Failing in this probe round: ' + failNames.length + ' service(s).</p>'
  if (failNames.includes('auth')) {
    const atRisk = targets.filter((t) => t.owatch_dependsonauth === true && t.owatch_enabled === true && (t.owatch_url ?? '') !== '' && t.owatch_name !== 'auth').map((t) => t.owatch_name)
    out += '<p><b>At risk downstream (sign-in is failing):</b> ' + escapeHtml(atRisk.slice(0, CAPS.atRisk).join(', ')).slice(0, CAPS.notesEsc) +
      (atRisk.length > CAPS.atRisk ? ' and ' + (atRisk.length - CAPS.atRisk) + ' more' : '') + '</p>'
  }
  const under = targets.filter((t) => t.owatch_copilotneeds === true && failNames.includes(t.owatch_name) && t.owatch_name !== 'm365-copilot').map((t) => t.owatch_name)
  if (failNames.includes('m365-copilot') && under.length) out += '<p>Copilot affected; underlying services also unhealthy: ' + escapeHtml(under.slice(0, CAPS.atRisk).join(', ')).slice(0, CAPS.notesEsc) + '</p>'
  return out
}

export function messageHtml(ctx, events, notes, dashboardUrl) {
  const n = (e) => events.filter((x) => x.e === e).length
  const title = events.length === 0 ? TITLES.test : n('open') + n('reminder') > 0 ? TITLES.failure : TITLES.recovered
  const items = events.map((e) => e.html)
  const dash = dashboardUrl ?? ''
  return '<p><b>' + title + '</b><br>Time: ' + ctx.now + ' UTC | probe round: ' + escapeHtml(ctx.round ?? '-') + '<br>New failures: ' + n('open') + ' | still failing (reminder): ' + n('reminder') +
    ' | recovered: ' + n('recovered') + (ctx.test ? '<br>(TEST requested with the setting alert_test)' : '') + '</p>' + notes + items.slice(0, CAPS.detailed).join('') +
    (items.length > CAPS.detailed ? '<p>... and ' + (items.length - CAPS.detailed) + ' more (see the dashboard).</p>' : '') +
    (dash.startsWith('https://') ? '<p><a href="' + escapeHtml(dash) + '">Open the Outage Watch dashboard</a></p>' : '') + '<p><i>' + SAME_FATE + '</i></p>'
}

/**
 * One run of the alert flow, as data in / data out.
 *   targets: target rows (active ones), any order;  failingRows: rows of `round` with owatch_failed = true
 * Returns the target updates, the message to post (or null) and the new alert_last_round.
 */
export function evaluateRun({ targets, failingRows, settings, nowMs, round }) {
  const ctx = context(settings, nowMs, round)
  const out = { ctx, updates: [], events: [], message: null, saveRound: null, clearTest: false }
  let notes = ''
  if ((ctx.round ?? '') !== '' && ctx.round !== ctx.prevRound) {
    out.saveRound = ctx.round
    const failNames = failingRows.map((r) => r.owatch_name)
    const ordered = [...targets].sort((a, b) => cmp(a.owatch_family ?? '', b.owatch_family ?? '') || cmp(a.owatch_name, b.owatch_name))
    let lastFamily = ''
    for (const t of ordered) {
      if (!(failNames.includes(t.owatch_name) || (t.owatch_failcount ?? 0) > 0 || t.owatch_alertopen === true)) continue
      const failRow = failingRows.find((r) => r.owatch_name === t.owatch_name) ?? null
      const d = decide({ failcount: t.owatch_failcount, failingsince: t.owatch_failingsince, lastok: t.owatch_lastok, alertopen: t.owatch_alertopen, lastalertat: t.owatch_lastalertat }, failRow, ctx)
      out.updates.push({ name: t.owatch_name, owatch_failcount: d.count, owatch_failingsince: d.since, owatch_lastok: d.lastok, owatch_alertopen: d.open, owatch_lastalertat: d.lastAlert })
      if (d.event !== 'none') { out.events.push({ e: d.event, n: t.owatch_name, html: itemHtml(t, failRow, d, lastFamily, ctx) }); lastFamily = t.owatch_family ?? '' }
    }
    if (out.events.length) notes = notesHtml(targets, failNames)
  }
  if (ctx.test || out.events.length) { out.message = messageHtml(ctx, out.events, notes, settings.dashboard_url); out.clearTest = ctx.test }
  return out
}
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** Upper bound of the message size in characters, for ANY input (used by a test to prove the cap holds). */
export function worstCaseMessageChars() {
  const item = 7 + CAPS.familyEsc + 8 + 30 + CAPS.nameEsc + 14 + CAPS.urlEsc + 4 + 60 + CAPS.kindEsc + 1 + CAPS.errorEsc + 120 + 60 + 20
  return 400 + (120 + 2 * (CAPS.notesEsc + 120)) + CAPS.detailed * item + 80 + 500 + SAME_FATE.length + 20
}
