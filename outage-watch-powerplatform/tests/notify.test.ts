/** The dashboard side of "Send test notification now": pure helpers (src/logic/notify.ts) and the demo notifier. */
import { describe, expect, it } from 'vitest'
import { COMMAND_NAME, NOTE_MAX, RATE_LIMIT_SECONDS, WAIT_MS, availability, channelsValue, cleanNote, isDenied, parseResult, phaseOf, timedOut } from '../src/logic/notify'
import { demoNotifier } from '../src/data/demo'
// @ts-expect-error plain .mjs helpers
import * as flow from '../provision/lib/test-flow.mjs'
// @ts-expect-error plain .mjs helpers
import { commandResult } from '../provision/lib/test-logic.mjs'
// @ts-expect-error plain .mjs helpers
import { columnSpec } from '../provision/lib/schema.mjs'

const NOW = Date.parse('2026-11-15T08:00:00Z')
const ON = { alert_configured: 'yes', alert_channels: 'teams,slack,webex', test_button: 'yes' }

describe('test-notification button: pure logic', () => {
  it('the dashboard and the flow agree on the command name, the rate limit and the column limits', () => {
    expect(COMMAND_NAME).toBe(flow.COMMAND_NAME)
    expect(RATE_LIMIT_SECONDS).toBe(flow.RATE_LIMIT_SECONDS)
    expect(NOTE_MAX).toBe(columnSpec('owatch_command').owatch_note.maxLength)
  })
  it('availability: no channel / flow off / rate limit / usable - each with its reason', () => {
    expect(availability({}, NOW)).toMatchObject({ usable: false, reason: 'no-channel' })
    expect(availability({ alert_configured: 'no', alert_channels: 'teams' }, NOW)).toMatchObject({ usable: false, reason: 'no-channel' })
    expect(availability({ alert_configured: 'yes', alert_channels: '' }, NOW)).toMatchObject({ usable: false, reason: 'no-channel' })
    expect(availability({ alert_configured: 'yes', alert_channels: 'teams' }, NOW)).toMatchObject({ usable: false, reason: 'flow-off', channels: ['teams'] })
    expect(availability(ON, NOW)).toEqual({ usable: true, reason: 'ok', channels: ['teams', 'slack', 'webex'], waitSeconds: 0 })
    expect(availability({ ...ON, last_test_at: '2026-11-15T07:58:00Z' }, NOW)).toMatchObject({ usable: false, reason: 'wait', waitSeconds: 180 })
    expect(availability({ ...ON, last_test_at: '2026-11-15T07:55:00Z' }, NOW).usable).toBe(true)
    expect(availability({ ...ON, last_test_at: 'not a date' }, NOW).usable).toBe(true)
    expect(availability({ ...ON, last_test_at: '2099-01-01T00:00:00Z' }, NOW).usable).toBe(true)      // a clock far off never locks the button
    expect(availability({ ...ON, alert_channels: 'teams,pagerduty,<script>' }, NOW).channels).toEqual(['teams'])
  })
  it('parseResult reads exactly what the flow writes and drops everything else', () => {
    const r = commandResult(['teams', 'slack', 'webex'], ['teams', 'slack'], { slack: 'FAILED HTTP 404' }).result
    expect(parseResult(r)).toEqual([
      { channel: 'teams', state: 'delivered', detail: '' }, { channel: 'slack', state: 'failed', detail: 'HTTP 404' },
      { channel: 'webex', state: 'not selected', detail: '' }, { channel: 'webhook', state: 'not configured', detail: '' },
    ])
    expect(parseResult('teams=FAILED Forbidden')).toEqual([{ channel: 'teams', state: 'failed', detail: 'Forbidden' }])
    expect(parseResult('slack=FAILED https://hooks.slack.com/services/T/B/secret; teams=<b>x</b>; pagerduty=delivered; teams=delivered; teams=delivered')).toEqual([{ channel: 'teams', state: 'delivered', detail: '' }])
    expect(parseResult('rate limit: one test every 5 minutes')).toEqual([])
    expect(parseResult(null)).toEqual([]); expect(parseResult(undefined)).toEqual([])
  })
  it('phaseOf, isDenied, cleanNote, channelsValue, timedOut', () => {
    expect(['queued', 'sending', 'done', 'partial', 'failed', 'rejected', 'DONE', '', null, 'weird'].map((s) => phaseOf(s))).toEqual(['queued', 'sending', 'done', 'partial', 'failed', 'rejected', 'done', 'queued', 'queued', 'queued'])
    expect(isDenied("Principal user is missing prvCreateowatch_command privilege")).toBe(true)
    expect(isDenied('HTTP 403 Forbidden')).toBe(true)
    expect(isDenied('Network request failed')).toBe(false)
    expect(cleanNote('  a\nb\tc\u0000d  ')).toBe('a b c d')
    expect(cleanNote('x'.repeat(500))).toHaveLength(NOTE_MAX)
    expect(channelsValue('slack', ['teams', 'slack'])).toBe('slack')
    expect(channelsValue('webex', ['teams', 'slack'])).toBe('all')
    expect(channelsValue('teams,slack;drop', ['teams'])).toBe('all')
    expect(timedOut(NOW, NOW + WAIT_MS - 1)).toBe(false); expect(timedOut(NOW, NOW + WAIT_MS)).toBe(true)
  })
  it('demo notifier walks queued -> sending -> outcome; denied rejects like a 403; timeout never answers', async () => {
    const d = demoNotifier('partial', 20)
    const id = await d.request('all', '')
    expect((await d.poll(id)).status).toBe('queued')
    await new Promise((r) => setTimeout(r, 25)); expect((await d.poll(id)).status).toBe('sending')
    await new Promise((r) => setTimeout(r, 25)); const fin = await d.poll(id)
    expect(fin.status).toBe('partial'); expect(parseResult(fin.result).filter((o) => o.state === 'failed')).toHaveLength(1)
    await expect(demoNotifier('denied').request('all', '')).rejects.toThrow(/403/)
    const t = demoNotifier('timeout', 1); await t.request('all', ''); await new Promise((r) => setTimeout(r, 10)); expect((await t.poll('x')).status).toBe('queued')
  })
})
