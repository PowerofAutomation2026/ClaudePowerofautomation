import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const b64 = (b) => Buffer.from(b).toString('base64url');
const safeEq = (a = '', b = '') => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ACCESS_TTL = 3600, REFRESH_TTL = 30 * 86400, CODE_TTL = 120;

/**
 * Minimal OAuth 2.1 authorization server for MCP "dynamic discovery" (RFC 9728 + 8414 + 7591 + PKCE).
 * Fully stateless: client ids, codes and tokens are HMAC-signed, so there is no database, no Entra app registration,
 * and rotating API_KEY revokes every token and client at once. The "login" is the server key (API_KEY).
 */
export class OAuth {
  constructor({ apiKey }) {
    this.apiKey = apiKey;
    this.secret = createHash('sha256').update(`live-dashboard-oauth:${apiKey}`).digest();
    this.usedCodes = new Map();
    this.failures = new Map();
  }

  sign(obj) { const body = b64(JSON.stringify(obj)); return `${body}.${b64(createHmac('sha256', this.secret).update(body).digest())}`; }

  verify(token, type) {
    const [body, sig] = String(token ?? '').split('.');
    if (!body || !sig || !safeEq(sig, b64(createHmac('sha256', this.secret).update(body).digest()))) return null;
    try {
      const o = JSON.parse(Buffer.from(body, 'base64url').toString());
      return o.t === type && o.exp > Date.now() / 1000 ? o : null;
    } catch { return null; }
  }

  clientSecret(clientId) { return createHmac('sha256', this.secret).update(`cs:${clientId}`).digest('hex'); }

  verifyAccess(token) { return !!this.verify(token, 'at'); }

  challenge(base) { return `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`; }

  protectedResource(base) {
    return { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'], scopes_supported: ['mcp'], resource_name: 'Live Dashboard MCP' };
  }

  serverMetadata(base) {
    return {
      issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: ['mcp'],
    };
  }

  /** RFC 7591 dynamic client registration. */
  register(body) {
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10) return { status: 400, body: { error: 'invalid_redirect_uri', error_description: 'redirect_uris (1-10) required' } };
    for (const u of uris) {
      let p; try { p = new URL(u); } catch { p = null; }
      const loopback = p && p.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(p.hostname);
      if (!p || (p.protocol !== 'https:' && !loopback) || p.hash) return { status: 400, body: { error: 'invalid_redirect_uri', error_description: `unacceptable redirect uri: ${String(u).slice(0, 80)}` } };
    }
    const method = body.token_endpoint_auth_method === 'none' ? 'none' : body.token_endpoint_auth_method === 'client_secret_basic' ? 'client_secret_basic' : body.token_endpoint_auth_method ? 'client_secret_post' : 'none';
    const name = String(body.client_name ?? 'MCP client').slice(0, 80);
    const client_id = this.sign({ t: 'client', ru: uris, n: name, m: method, exp: Date.now() / 1000 + 10 * 365 * 86400 });
    const out = { client_id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: method };
    if (method !== 'none') { out.client_secret = this.clientSecret(client_id); out.client_secret_expires_at = 0; }
    return { status: 201, body: out };
  }

  client(id) { return this.verify(id, 'client'); }

  /** Validate an /authorize request. Returns {error} (render, don't redirect) or {client, params}. */
  checkAuthorize(q) {
    const c = this.client(q.client_id);
    if (!c) return { error: 'Unknown or expired client. Remove and re-add the connection.' };
    if (!c.ru.includes(q.redirect_uri)) return { error: 'redirect_uri is not registered for this client.' };
    if (q.response_type !== 'code') return { error: 'Only response_type=code is supported.' };
    if (!q.code_challenge || (q.code_challenge_method ?? 'S256') !== 'S256') return { error: 'PKCE with code_challenge_method=S256 is required.' };
    return { client: c };
  }

  consentPage(q, client, message = '') {
    const hidden = ['client_id', 'redirect_uri', 'response_type', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource']
      .map((k) => (q[k] === undefined ? '' : `<input type="hidden" name="${k}" value="${esc(q[k])}">`)).join('');
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to Live Dashboard MCP</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;max-width:420px;margin:12vh auto;padding:0 20px}h1{font-size:20px}input[type=password]{width:100%;padding:10px;font:inherit;margin:8px 0 14px;box-sizing:border-box}button{padding:10px 18px;font:inherit;cursor:pointer}.err{color:#c42b1c}.m{color:#667085;font-size:13px}</style>
<h1>Connect “${esc(client.n)}”</h1><p>This app is asking to build and update dashboards on this server. Enter the server key to allow it.</p>
${message ? `<p class="err">${esc(message)}</p>` : ''}
<form method="post" action="/authorize">${hidden}<label>Server key<input type="password" name="key" autofocus autocomplete="current-password" required></label><button type="submit">Allow</button></form>
<p class="m">Redirects to ${esc(new URL(q.redirect_uri).host)}. The key is the API_KEY set when the server was deployed.</p></html>`;
  }

  tooManyFailures(ip) {
    const now = Date.now();
    const f = (this.failures.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
    this.failures.set(ip, f);
    return f.length >= 10;
  }

  /** Handle the consent form post. Returns {redirect} on success or {status, html}. */
  authorize(form, ip) {
    const chk = this.checkAuthorize(form);
    if (chk.error) return { status: 400, html: `<!doctype html><meta charset="utf-8"><p>${esc(chk.error)}</p>` };
    if (this.tooManyFailures(ip)) return { status: 429, html: this.consentPage(form, chk.client, 'Too many attempts. Try again in 15 minutes.') };
    if (!safeEq(form.key ?? '', this.apiKey)) {
      this.failures.get(ip).push(Date.now());
      return { status: 401, html: this.consentPage(form, chk.client, 'That key is not correct.') };
    }
    const code = this.sign({ t: 'code', cid: form.client_id, ru: form.redirect_uri, cc: form.code_challenge, jti: randomBytes(8).toString('hex'), exp: Date.now() / 1000 + CODE_TTL });
    const u = new URL(form.redirect_uri);
    u.searchParams.set('code', code);
    if (form.state !== undefined) u.searchParams.set('state', form.state);
    return { redirect: u.toString() };
  }

  /** POST /token. `auth` is the Authorization header value (for client_secret_basic). */
  token(f, auth) {
    const err = (error, d, status = 400) => ({ status, body: { error, error_description: d } });
    let clientId = f.client_id, secret = f.client_secret;
    const basic = /^Basic (.+)$/i.exec(auth ?? '')?.[1];
    if (basic) { const [i, s] = Buffer.from(basic, 'base64').toString().split(':'); clientId = decodeURIComponent(i); secret = decodeURIComponent(s ?? ''); }
    const c = this.client(clientId);
    if (!c) return err('invalid_client', 'unknown client', 401);
    if (c.m !== 'none' && !safeEq(secret ?? '', this.clientSecret(clientId))) return err('invalid_client', 'bad client credentials', 401);

    const issue = () => ({
      status: 200,
      body: {
        access_token: this.sign({ t: 'at', cid: clientId, exp: Date.now() / 1000 + ACCESS_TTL }), token_type: 'Bearer', expires_in: ACCESS_TTL, scope: 'mcp',
        refresh_token: this.sign({ t: 'rt', cid: clientId, exp: Date.now() / 1000 + REFRESH_TTL }),
      },
    });

    if (f.grant_type === 'refresh_token') {
      const r = this.verify(f.refresh_token, 'rt');
      return r && r.cid === clientId ? issue() : err('invalid_grant', 'refresh token invalid or expired');
    }
    if (f.grant_type !== 'authorization_code') return err('unsupported_grant_type', 'use authorization_code or refresh_token');
    const code = this.verify(f.code, 'code');
    if (!code || code.cid !== clientId || code.ru !== f.redirect_uri) return err('invalid_grant', 'code invalid, expired or for a different client');
    if (this.usedCodes.has(code.jti)) return err('invalid_grant', 'code already used');
    const expected = createHash('sha256').update(f.code_verifier ?? '').digest('base64url');
    if (!f.code_verifier || !safeEq(expected, code.cc)) return err('invalid_grant', 'PKCE verification failed');
    const now = Date.now() / 1000;
    for (const [k, exp] of this.usedCodes) if (exp < now) this.usedCodes.delete(k);
    this.usedCodes.set(code.jti, code.exp);
    return issue();
  }
}
