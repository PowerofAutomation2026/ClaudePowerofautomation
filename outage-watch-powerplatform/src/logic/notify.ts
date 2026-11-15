/**
 * "Send test notification now": the pure part. The dashboard creates ONE row in the table owatch_command; the flow
 * "Outage Watch - test notification" does the sending and writes the outcome back. Nothing here talks to a channel,
 * and no webhook URL ever reaches the browser.
 */
export const TEST_CHANNELS = ['teams', 'slack', 'webex', 'webhook'] as const
export type Channel = (typeof TEST_CHANNELS)[number]
export const CHANNEL_NAME: Record<string, string> = { teams: 'Teams', slack: 'Slack', webex: 'Webex', webhook: 'Webhook' }
export const COMMAND_NAME = 'test_notification'
export const NOTE_MAX = 200
export const RATE_LIMIT_SECONDS = 300
/** How long the dashboard waits for the flow before it says "timed out" (the message may still arrive later). */
export const WAIT_MS = 180_000
export const POLL_MS = 3_000

export type Phase = 'idle' | 'confirm' | 'queued' | 'sending' | 'done' | 'partial' | 'failed' | 'rejected' | 'timeout' | 'denied' | 'error'
export const PENDING: Phase[] = ['queued', 'sending']

export interface ChannelOutcome { channel: Channel; state: 'delivered' | 'failed' | 'not selected' | 'not configured'; detail: string }

/** Parses "teams=delivered; slack=FAILED HTTP 404; webex=not selected; webhook=not configured". Anything unexpected is dropped, never shown. */
export function parseResult(result: string | null | undefined): ChannelOutcome[] {
  const out: ChannelOutcome[] = []
  for (const part of String(result ?? '').slice(0, 400).split(';')) {
    const m = /^\s*(teams|slack|webex|webhook)=(delivered|not selected|not configured|FAILED (?:HTTP [0-9]{1,3}|[A-Za-z0-9]{1,40}))\s*$/.exec(part)
    if (!m || out.some((o) => o.channel === m[1])) continue
    const v = m[2]
    out.push({ channel: m[1] as Channel, state: v.startsWith('FAILED') ? 'failed' : (v as ChannelOutcome['state']), detail: v.startsWith('FAILED') ? v.slice(7) : '' })
  }
  return out
}

/** Status column of the command row -> what the panel shows. Unknown values keep waiting (the flow writes only these). */
export function phaseOf(status: string | null | undefined): Phase {
  const s = String(status ?? '').toLowerCase()
  return s === 'sending' || s === 'done' || s === 'partial' || s === 'failed' || s === 'rejected' ? s : 'queued'
}

/** A Dataverse refusal for lack of privilege (HTTP 403 / "prvCreate..." / "missing privilege"). */
export function isDenied(message: string | null | undefined): boolean {
  return /\b403\b|prvCreate|prvRead|privilege|permission|access is denied|not authorized|unauthorized/i.test(String(message ?? ''))
}

/** Plain, single-line, bounded: the flow escapes it again per channel. */
export function cleanNote(v: string): string {
  // eslint-disable-next-line no-control-regex
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, NOTE_MAX)
}

export interface Availability {
  usable: boolean
  /** ok | no-channel (nothing to send to) | flow-off (channels exist, the test flow is not on) | wait (rate limit) */
  reason: 'ok' | 'no-channel' | 'flow-off' | 'wait'
  channels: Channel[]
  waitSeconds: number
}

export function availability(settings: Record<string, string>, nowMs: number): Availability {
  const channels = TEST_CHANNELS.filter((c) => (settings.alert_channels ?? '').toLowerCase().split(',').includes(c))
  if (settings.alert_configured !== 'yes' || channels.length === 0) return { usable: false, reason: 'no-channel', channels: [], waitSeconds: 0 }
  if (settings.test_button !== 'yes') return { usable: false, reason: 'flow-off', channels, waitSeconds: 0 }
  const last = Date.parse(settings.last_test_at ?? '')
  const wait = Number.isFinite(last) ? Math.ceil((last + RATE_LIMIT_SECONDS * 1000 - nowMs) / 1000) : 0
  if (wait > 0 && wait <= RATE_LIMIT_SECONDS) return { usable: false, reason: 'wait', channels, waitSeconds: wait }
  return { usable: true, reason: 'ok', channels, waitSeconds: 0 }
}

/** The value of the channels column for a choice of the chooser. */
export function channelsValue(choice: string, configured: Channel[]): string {
  return choice !== 'all' && (configured as string[]).includes(choice) ? choice : 'all'
}

export function timedOut(startedMs: number, nowMs: number): boolean { return nowMs - startedMs >= WAIT_MS }
