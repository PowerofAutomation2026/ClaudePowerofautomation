// Minimal Dataverse Web API client (documented OData v4 endpoint, /api/data/v9.2). Zero dependencies.
// The bearer token lives only in this closure: it is never logged, never put in an error and never written to disk.

export class DataverseError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code }
}

const scrub = (s) => String(s ?? '').replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]').replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '[redacted-token]').slice(0, 600)

export function createClient({ orgUrl, token, fetchImpl = fetch, onRequest = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxRetries = 3 }) {
  if (!token || typeof token !== 'string') throw new DataverseError('no access token supplied (OWPP_TOKEN is empty)', 0, 'NoToken')
  const base = orgUrl.replace(/\/+$/, '') + '/api/data/v9.2/'

  async function request(method, path, { body, headers = {}, okStatuses = [] } = {}) {
    const url = base + path
    const h = { Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', Authorization: 'Bearer ' + token, ...headers }
    let payload
    if (body !== undefined) { h['Content-Type'] = 'application/json; charset=utf-8'; payload = JSON.stringify(body) }
    for (let attempt = 0; ; attempt++) {
      onRequest({ method, path, headers: Object.fromEntries(Object.entries(headers)), hasBody: body !== undefined, attempt })
      let res
      try {
        res = await fetchImpl(url, { method, headers: h, body: payload, redirect: 'error' })   // a token must never follow a redirect
      } catch (e) {
        throw new DataverseError(`${method} ${path}: network error (${scrub(e?.cause?.code ?? e?.name ?? 'unknown')})`, 0, 'Network')
      }
      if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {    // service protection limits: honour Retry-After
        const ra = Number(res.headers.get('retry-after'))
        await sleep(Math.min(60, Number.isFinite(ra) && ra > 0 ? ra : 2 ** attempt) * 1000)
        continue
      }
      const text = await res.text()
      let json = null
      if (text) { try { json = JSON.parse(text) } catch { json = null } }
      if (res.status >= 200 && res.status < 300 || okStatuses.includes(res.status)) {
        return { status: res.status, json, entityId: idFromHeader(res.headers.get('odata-entityid')) }
      }
      const msg = json?.error?.message ?? text
      throw new DataverseError(`${method} ${path.split('?')[0]}: HTTP ${res.status} ${scrub(msg)}`, res.status, json?.error?.code)
    }
  }
  return {
    get: (path, o) => request('GET', path, o),
    /** GET that maps 404 to null. */
    find: async (path) => { const r = await request('GET', path, { okStatuses: [404] }); return r.status === 404 ? null : r.json },
    post: (path, body, headers) => request('POST', path, { body, headers }),
    patch: (path, body, headers) => request('PATCH', path, { body, headers: { 'If-Match': '*', ...headers } }),
    del: (path) => request('DELETE', path, { okStatuses: [404] }),
  }
}

export function idFromHeader(v) {
  const m = /\(([0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12})\)\s*$/.exec(v ?? '')
  return m ? m[1].toLowerCase() : null
}

/** OData string literal. */
export const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"
