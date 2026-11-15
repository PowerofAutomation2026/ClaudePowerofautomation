// SharePoint / OneDrive tenant name: discovery and verification.
//
// SharePoint Online hosts are named after the tenant's INITIAL domain: contoso.onmicrosoft.com ->
// https://contoso.sharepoint.com, https://contoso-my.sharepoint.com (OneDrive), https://contoso-admin.sharepoint.com.
// The deploy script collects candidate domains (Az.Accounts Get-AzTenant, optionally Microsoft Graph /organization);
// this module decides. Rules: never guess, never seed a host that was not seen answering.
//   * only plain-ASCII "<label>.onmicrosoft.com" domains are candidates (so "contoso.mail.onmicrosoft.com" is not);
//   * every candidate is probed: https://<label>.sharepoint.com/ must ANSWER like an existing tenant;
//   * if more than one candidate answers, the result is ambiguous and nothing is chosen;
//   * US Government (GCC High / DoD) and China clouds use other SharePoint domains: not supported, nothing is seeded.
import { InputError, assertTenantName } from './validate.mjs'

const INITIAL_RE = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.onmicrosoft\.com$/

/** Candidate tenant labels from a list of domain names. Hostile or odd entries are simply ignored. */
export function initialDomainLabels(domains) {
  const out = []
  for (const d of Array.isArray(domains) ? domains : []) {
    if (typeof d !== 'string' || d.length > 90 || !/^[\x21-\x7e]+$/.test(d)) continue      // ASCII only: no look-alike letters, no spaces, no control characters
    const m = INITIAL_RE.exec(d.toLowerCase())
    if (m && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

/** The initial domain according to Microsoft Graph /organization (verifiedDomains[].isInitial). */
export function initialFromGraphOrganization(json) {
  const names = []
  for (const org of Array.isArray(json?.value) ? json.value : []) for (const d of Array.isArray(org?.verifiedDomains) ? org.verifiedDomains : []) if (d?.isInitial === true && typeof d.name === 'string') names.push(d.name)
  return initialDomainLabels(names)
}

/** false for clouds whose SharePoint hosts are not *.sharepoint.com (GCC High, DoD, China). */
export function sharePointCloudSupported(orgUrl) {
  let host = ''
  try { host = new URL(orgUrl).hostname } catch { return false }
  return /\.dynamics\.com$/.test(host) || host === '127.0.0.1'
}

// What an EXISTING tenant answers to an anonymous request (observed live for microsoft.sharepoint.com: 401;
// microsoft-my.sharepoint.com: 302 to the sign-in page). 404 is deliberately NOT accepted: it is unconfirmed
// whether a non-existing tenant name fails in DNS or gets a generic "not found", and a wrong host must never be seeded.
const TENANT_ALIVE = new Set([200, 301, 302, 303, 307, 308, 401, 403])

/** Anonymous reachability probe. Never throws. */
export async function probeTenant(label, { fetchImpl = fetch, urlFor = (l) => `https://${l}.sharepoint.com/`, timeoutMs = 10000 } = {}) {
  try { assertTenantName(label) } catch { return { ok: false, reason: 'not a valid tenant name' } }
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(urlFor(label), { method: 'GET', redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': 'outage-watch-pp-deploy/1.0' } })
    return TENANT_ALIVE.has(res.status) ? { ok: true, status: res.status } : { ok: false, status: res.status, reason: `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, reason: 'no answer (' + String(e?.cause?.code ?? e?.name ?? 'error').slice(0, 40) + ')' }
  } finally { clearTimeout(timer) }
}

/**
 * Ordered discovery. sources: [{ via: 'Get-AzTenant', labels: [...] }, { via: 'Microsoft Graph /organization', labels: [...] }]
 * Returns { tenant, via, tried } - tenant is null when nothing could be VERIFIED.
 */
export async function detectTenant(sources, probeOptions = {}) {
  const tried = []
  for (const src of sources) {
    const alive = []
    for (const label of src.labels.slice(0, 6)) {
      const r = await probeTenant(label, probeOptions)
      tried.push({ via: src.via, label, ok: r.ok, detail: r.ok ? `HTTP ${r.status}` : r.reason })
      if (r.ok) alive.push(label)
    }
    if (alive.length === 1) return { tenant: alive[0], via: src.via, tried }
    if (alive.length > 1) tried.push({ via: src.via, label: alive.join(', '), ok: false, detail: 'ambiguous: more than one candidate answers; use -TenantName' })
  }
  return { tenant: null, via: null, tried }
}

/** For -TenantName / the interactive answer: must be a valid label; reachability is reported, the caller decides. */
export function assertTenantLabel(v) {
  if (typeof v !== 'string' || !/^[\x21-\x7e]+$/.test(v)) throw new InputError('tenant name must be lowercase letters, digits and dashes (e.g. contoso)')
  return assertTenantName(v)
}
