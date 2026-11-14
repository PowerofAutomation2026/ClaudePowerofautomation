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
