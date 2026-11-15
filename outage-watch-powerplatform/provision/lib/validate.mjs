// Input validation shared by the CLI helper and the tests. Everything is anchored at both ends and
// applied BEFORE a value is used in a URL, a file path or a command line.

/** Same pattern as $GuidPattern in Deploy-OutageWatchPP.ps1 (\A...\z there; ^...$ without the m flag is equivalent in JS). */
export const GUID_RE = /^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/

export function isGuid(v) { return typeof v === 'string' && GUID_RE.test(v) }
export function assertGuid(v, what = 'value') {
  if (!isGuid(v)) throw new InputError(`${what} is not a GUID (expected xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)`)
  return v.toLowerCase()
}

export class InputError extends Error {}

// Dataverse organisation hosts (commercial, GCC, GCC High, DoD, China). A token is only ever sent to these.
const ORG_HOST_RE = /^[a-z0-9][a-z0-9-]{0,62}\.(?:crm(?:[0-9]{1,2})?\.dynamics\.com|crm(?:[0-9]{1,2})?\.microsoftdynamics\.us|crm\.appsplatform\.us|crm\.dynamics\.cn)$/

/** Returns the normalised origin ("https://org.crm.dynamics.com") or throws. */
export function assertOrgUrl(v, { allowLoopback = false } = {}) {
  if (typeof v !== 'string' || v.length > 200 || /[\s\\@]/.test(v)) throw new InputError('organisation URL is malformed')
  let u
  try { u = new URL(v) } catch { throw new InputError('organisation URL is malformed') }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw new InputError('organisation URL must be just https://<org>.<region>.dynamics.com/')
  if (allowLoopback && u.protocol === 'http:' && u.hostname === '127.0.0.1' && /^[0-9]{2,5}$/.test(u.port)) return u.origin
  if (u.protocol !== 'https:' || u.port || !ORG_HOST_RE.test(u.hostname)) throw new InputError('organisation URL is not a recognised Dataverse host (https://<org>.crm<N>.dynamics.com)')
  return u.origin
}

/** Tenant short name for the optional SharePoint/OneDrive probes (contoso -> contoso.sharepoint.com). */
export function assertTenantName(v) {
  if (typeof v !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v)) throw new InputError('tenant name must be lowercase letters, digits and dashes (e.g. contoso)')
  return v
}

/** Connection id as printed by `pac connection list`. */
export function assertConnectionId(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(v)) throw new InputError('connection id has an unexpected format')
  return v
}

/** Heartbeat ("dead man's switch") URL: https only, no credentials, no whitespace. Never echoed back in errors. */
export function assertHeartbeatUrl(v) {
  const bad = () => new InputError('heartbeat URL must be a plain https:// URL without credentials (value not shown)')
  if (typeof v !== 'string' || v.length < 12 || v.length > 500 || /[\s"'<>\\{}@`]/.test(v)) throw bad()
  let u
  try { u = new URL(v) } catch { throw bad() }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) throw bad()
  return u.href
}

export function assertInt(v, lo, hi, what) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^[0-9]{1,6}$/.test(v) ? Number(v) : NaN)
  if (!Number.isInteger(n) || n < lo || n > hi) throw new InputError(`${what} must be a whole number from ${lo} to ${hi}`)
  return n
}

/**
 * Parses the URL Teams gives for "Get link to channel":
 *   https://teams.microsoft.com/l/channel/19%3A<id>%40thread.tacv2/<channel name>?groupId=<team guid>&tenantId=<guid>
 * (also on teams.cloud.microsoft, and with the older "@thread.skype" channel ids). Nothing else is accepted:
 * the team id must be a GUID, the URL-decoded channel id must have the documented thread form.
 * Returns { groupId, channelId, channelName } - the name is display-only text taken from the link.
 */
export function parseTeamsChannelLink(v) {
  const bad = (why) => new InputError(`Teams channel link not recognised (${why}). In Teams: channel name > "..." > "Get link to channel", and paste that link.`)
  if (typeof v !== 'string' || v.length < 40 || v.length > 1200 || /[\s"'<>\\`{}]/.test(v)) throw bad('not a plain URL')
  let u
  try { u = new URL(v) } catch { throw bad('not a URL') }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !['teams.microsoft.com', 'teams.cloud.microsoft'].includes(u.hostname)) throw bad('not an https://teams.microsoft.com link')
  const m = /^\/l\/channel\/([^/]+)\/([^/]*)$/.exec(u.pathname)
  if (!m) throw bad('not a channel link: expected /l/channel/<id>/<name>')
  let channelId, channelName
  try { channelId = decodeURIComponent(m[1]); channelName = decodeURIComponent(m[2].replace(/\+/g, ' ')) } catch { throw bad('bad percent-encoding') }
  if (!/^19:[A-Za-z0-9_-]{1,200}@thread\.(?:tacv2|skype)$/.test(channelId)) throw bad('unexpected channel id')
  const groupId = u.searchParams.get('groupId') ?? ''
  if (!GUID_RE.test(groupId)) throw bad('no groupId=<team GUID> in the link')
  const tenantId = u.searchParams.get('tenantId')
  if (tenantId !== null && !GUID_RE.test(tenantId)) throw bad('tenantId is not a GUID')
  // display text only: printable characters, bounded
  channelName = channelName.replace(/[\u0000-\u001f\u007f<>"'`&\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
  return { groupId: groupId.toLowerCase(), channelId, channelName }
}

export const TEAMS_CHANNEL_ID_RE = /^19:[A-Za-z0-9_-]{1,200}@thread\.(?:tacv2|skype)$/

/** URL of the published dashboard, as printed by `pac code push` (or the maker-portal apps page). Stored as a setting, linked from alerts. */
export function assertDashboardUrl(v) {
  const bad = () => new InputError('dashboard URL must be an https://apps.powerapps.com/... or https://make.powerapps.com/... URL')
  if (typeof v !== 'string' || v.length > 380 || /[\s"'<>\\`{}]/.test(v)) throw bad()
  let u
  try { u = new URL(v) } catch { throw bad() }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !/^(apps|make)(\.[a-z0-9-]+)*\.powerapps\.(com|us|cn)$/.test(u.hostname)) throw bad()
  return u.href
}

/**
 * Incoming-webhook URL of an alert channel. The URL is a credential: it is never echoed in an error.
 *   slack   https://hooks.slack.com/services/...            (Slack "Incoming Webhooks")
 *   webex   https://webexapis.com/v1/webhooks/incoming/...  (Webex "Incoming Webhooks" integration)
 *   webhook any https endpoint that accepts POST {"text": "..."}
 */
export function assertWebhookUrl(kind, v) {
  const bad = (why) => new InputError(`${kind} webhook URL not accepted (${why}; value not shown)`)
  if (typeof v !== 'string' || v.length < 20 || v.length > 600 || /[\s"'<>\\`{}@]/.test(v)) throw bad('not a plain https URL')
  let u
  try { u = new URL(v) } catch { throw bad('not a URL') }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !u.hostname.includes('.')) throw bad('must be https without credentials or port')
  if (kind === 'slack' && !(/^hooks\.slack(-gov)?\.com$/.test(u.hostname) && u.pathname.startsWith('/services/'))) throw bad('expected https://hooks.slack.com/services/...')
  if (kind === 'webex' && !(u.hostname === 'webexapis.com' && u.pathname.startsWith('/v1/webhooks/incoming/'))) throw bad('expected https://webexapis.com/v1/webhooks/incoming/...')
  if (!['slack', 'webex', 'webhook'].includes(kind)) throw bad('unknown channel type')
  return u.href
}
