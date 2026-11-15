// REFERENCE for the test-notification flow (provision/lib/test-flow.mjs): what the message must say and how a
// command row moves through its states. tests/test-notification.test.ts runs the generated flow with the
// interpreter and requires the same result.
import { CAPS, CHANNELS, COMMON, SAME_FATE } from './alert-flow.mjs'
import { RATE_LIMIT_SECONDS, TEST_TITLE, COMMAND_NAME } from './test-flow.mjs'
import { fmt } from './alert-logic.mjs'

const cap = (v, n) => String(v ?? '').replace(/\n/g, ' ').replace(/\r/g, ' ').slice(0, n)

/** queued -> sending -> done | partial | failed;  or rejected (rate limit);  anything else is ignored. */
export function commandDecision(command, settings, nowMs) {
  if (!command || String(command.owatch_name ?? '').toLowerCase() !== COMMAND_NAME || String(command.owatch_status ?? '').toLowerCase() !== 'queued') return 'ignore'
  return String(settings.last_test_at ?? '') > fmt(nowMs - RATE_LIMIT_SECONDS * 1000) ? 'reject' : 'send'
}

export function selectedChannels(command, configured) {
  const sel = ',' + String(command.owatch_channels ?? 'all').slice(0, 100).toLowerCase().replace(/ /g, '') + ','
  return CHANNELS.filter((c) => configured.includes(c) && (sel.includes(',all,') || sel.includes(`,${c},`)))
}

/** The live-status text. targets: active rows; roundRows: all rows of the newest complete round (may be empty). */
export function testText({ command, targets, roundRows, settings, nowMs, round }) {
  const now = fmt(nowMs)
  const rows = [...roundRows].sort((a, b) => (a.owatch_name < b.owatch_name ? -1 : a.owatch_name > b.owatch_name ? 1 : 0))
  const failing = rows.filter((r) => r.owatch_failed === true)
  const failNames = failing.map((r) => r.owatch_name)
  const openNow = targets.filter((t) => t.owatch_alertopen === true).length
  const level = (round ?? '') === '' ? 'unknown (no probe round yet)' : failNames.includes('auth') || openNow > 0 ? 'freeze' : failNames.length ? 'caution' : 'ok'
  const age = Math.trunc((Date.parse(now) - Date.parse(round ?? now)) / 60000)
  const by = (command.owatch_requestedby ?? '') === '' ? '(not stated)' : cap(command.owatch_requestedby, 100)
  const note = cap(command.owatch_note, 200)
  const lines = failing.map((r) => { const e = cap(r.owatch_errorkind, CAPS.kind) + ' ' + cap(r.owatch_errormessage, CAPS.error); return '- ' + cap(r.owatch_name, CAPS.name) + ': ' + ((r.owatch_httpstatus ?? 0) === 0 ? 'no HTTP answer' : 'HTTP ' + r.owatch_httpstatus) + ' after ' + (r.owatch_elapsedms ?? 0) + ' ms - ' + (e.length === 1 ? 'no error text' : e) })
  const ordered = [...targets].sort((a, b) => ((a.owatch_family ?? '') < (b.owatch_family ?? '') ? -1 : (a.owatch_family ?? '') > (b.owatch_family ?? '') ? 1 : a.owatch_name < b.owatch_name ? -1 : 1))
  const fams = [...new Set(ordered.filter((t) => failNames.includes(t.owatch_name)).map((t) => cap((t.owatch_family ?? '') === '' ? 'Other' : t.owatch_family, CAPS.family)))].slice(0, 20)
  const dash = settings.dashboard_url ?? ''
  return TEST_TITLE + '\nRequested by: ' + by + ' at ' + now + ' UTC\n' + (note === '' ? '' : 'Note: ' + note + '\n') +
    'Level: ' + level + ' | probe round: ' + cap(round ?? '-', 40) + ' (' + age + ' min ago)\n' +
    (failing.length === 0 ? 'All ' + rows.length + ' probed services answered in that round.\n'
      : failing.length + ' of ' + rows.length + ' probed services are failing:\n' + lines.slice(0, CAPS.detailed).join('\n') + '\n' + (failing.length > CAPS.detailed ? '... and ' + (failing.length - CAPS.detailed) + ' more (see the dashboard).\n' : '') + 'Families with failures: ' + fams.join(', ') + '\n') +
    (failNames.includes('auth') ? COMMON.authLead + '\n' : '') + (dash.startsWith('https://') ? 'Dashboard: ' + cap(dash, 400) + '\n' : '') + '\n' + SAME_FATE
}

/** "teams=delivered; slack=FAILED HTTP 404; webex=not selected; webhook=not configured" and the final status. */
export function commandResult(configured, selected, outcome) {
  const parts = CHANNELS.map((c) => c + '=' + (!configured.includes(c) ? 'not configured' : !selected.includes(c) ? 'not selected' : outcome[c] ?? 'delivered'))
  const delivered = selected.filter((c) => (outcome[c] ?? 'delivered') === 'delivered').length
  const result = parts.join('; ').slice(0, 400)
  return { result, status: delivered === 0 ? 'failed' : result.includes('FAILED') ? 'partial' : 'done' }
}
