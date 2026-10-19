import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

const PORT = 3912, BASE = `http://localhost:${PORT}`, KEY = 'server-key-123';
const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT, API_KEY: KEY, DATA_FILE: `/tmp/dash-oauth-${process.pid}.json` }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
test.after(() => srv.kill());

const post = (path, body, headers = {}) => fetch(BASE + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const REDIRECT = 'https://global.consent.azure-apim.net/redirect';
const pkce = () => { const v = 'v'.repeat(50) + Math.random().toString(36).slice(2); return { v, c: createHash('sha256').update(v).digest('base64url') }; };

async function authorize(client_id, challenge, key = KEY, extra = {}) {
  const form = new URLSearchParams({ client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', key, ...extra });
  return fetch(BASE + '/authorize', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
}
const token = (f, headers = {}) => fetch(BASE + '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(f) });

test('401 advertises discovery, and metadata documents are served', async () => {
  const r = await post('/mcp', {});
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /resource_metadata="http:\/\/localhost:3912\/\.well-known\/oauth-protected-resource"/);
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json();
  assert.equal(prm.resource, `${BASE}/mcp`);
  const asm = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(asm.code_challenge_methods_supported, ['S256']);
  assert.ok(asm.registration_endpoint.endsWith('/register'));
});

test('full flow with the MCP SDK client: discovery, DCR, PKCE, consent, token, tool call, refresh', async () => {
  let saved = {}, tokens, verifier, authUrl;
  const provider = {
    get redirectUrl() { return REDIRECT; },
    get clientMetadata() { return { client_name: 'Copilot Studio', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; },
    clientInformation: () => saved.client, saveClientInformation: (c) => { saved.client = c; },
    tokens: () => tokens, saveTokens: (t) => { tokens = t; },
    redirectToAuthorization: (u) => { authUrl = u; }, saveCodeVerifier: (v) => { verifier = v; }, codeVerifier: () => verifier,
  };
  const mk = () => ({ client: new Client({ name: 't', version: '1' }), transport: new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { authProvider: provider }) });
  let { client, transport } = mk();
  await assert.rejects(client.connect(transport), UnauthorizedError);
  assert.ok(authUrl && saved.client?.client_id, 'client registered itself and produced an authorization url');

  const bad = await authorize(saved.client.client_id, authUrl.searchParams.get('code_challenge'), 'wrong-key');
  assert.equal(bad.status, 401);
  const ok = await authorize(saved.client.client_id, authUrl.searchParams.get('code_challenge'));
  assert.equal(ok.status, 302);
  const loc = new URL(ok.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, REDIRECT); assert.equal(loc.searchParams.get('state'), 'xyz');

  await transport.finishAuth(loc.searchParams.get('code'));
  assert.ok(tokens.access_token && tokens.refresh_token);
  ({ client, transport } = mk());
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.length > 10);

  const refreshed = await (await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: saved.client.client_id })).json();
  assert.ok(refreshed.access_token);
});

test('code is single use, PKCE verifier and redirect_uri are enforced', async () => {
  const reg = await (await post('/register', { client_name: 'x', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' })).json();
  const { v, c } = pkce();
  const code = new URL((await authorize(reg.client_id, c)).headers.get('location')).searchParams.get('code');
  const base = { grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: REDIRECT };
  assert.equal((await token({ ...base, code_verifier: 'wrong' + v })).status, 400);
  assert.equal((await token({ ...base, code_verifier: v, redirect_uri: 'https://evil.example/cb' })).status, 400);
  assert.equal((await token({ ...base, code_verifier: v })).status, 200);
  const replay = await token({ ...base, code_verifier: v });
  assert.equal(replay.status, 400); assert.equal((await replay.json()).error, 'invalid_grant');
});

test('registration rejects unsafe redirect uris; authorize rejects unregistered ones', async () => {
  assert.equal((await post('/register', { redirect_uris: ['http://evil.example/cb'] })).status, 400);
  assert.equal((await post('/register', { redirect_uris: ['javascript:alert(1)'] })).status, 400);
  assert.equal((await post('/register', { redirect_uris: ['http://localhost:8080/cb'] })).status, 201);
  const reg = await (await post('/register', { client_name: 'x', redirect_uris: [REDIRECT] })).json();
  const r = await fetch(`${BASE}/authorize?` + new URLSearchParams({ client_id: reg.client_id, redirect_uri: 'https://evil.example/cb', response_type: 'code', code_challenge: 'abc' }));
  assert.equal(r.status, 400);
  const noPkce = await fetch(`${BASE}/authorize?` + new URLSearchParams({ client_id: reg.client_id, redirect_uri: REDIRECT, response_type: 'code' }));
  assert.equal(noPkce.status, 400);
});

test('confidential clients need their secret; API key and forged tokens', async () => {
  const reg = await (await post('/register', { client_name: 'c', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post' })).json();
  assert.ok(reg.client_secret);
  const { v, c } = pkce();
  const code = new URL((await authorize(reg.client_id, c)).headers.get('location')).searchParams.get('code');
  const f = { grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: REDIRECT, code_verifier: v };
  assert.equal((await token(f)).status, 401);
  assert.equal((await token({ ...f, client_secret: reg.client_secret })).status, 200);

  const call = (auth) => fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...auth }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal((await call({ authorization: `Bearer ${KEY}` })).status, 200, 'raw API key as bearer');
  assert.equal((await call({ 'x-api-key': KEY })).status, 200, 'x-api-key header');
  assert.equal((await call({ authorization: 'Bearer abc.def' })).status, 401);
  assert.equal((await call({})).status, 401);
});

test('setup page, connector files and agent instructions are served without secrets', async () => {
  const page = await (await fetch(BASE + '/')).text();
  assert.match(page, /Dynamic discovery/); assert.ok(!page.includes(KEY));
  const sw = await (await fetch(BASE + '/copilot-studio/connector.swagger.json')).json();
  assert.equal(sw.swagger, '2.0'); assert.equal(sw.host, `localhost:${PORT}`);
  assert.equal(sw.paths['/mcp'].post['x-ms-agentic-protocol'], 'mcp-streamable-1.0');
  assert.equal(sw.securityDefinitions.api_key.name, 'x-api-key');
  const props = await (await fetch(BASE + '/copilot-studio/connector.properties.json')).json();
  assert.equal(props.properties.connectionParameters.api_key.type, 'securestring');
  assert.match(await (await fetch(BASE + '/copilot-studio/agent-instructions.md')).text(), /list_datasources/);
  assert.equal((await fetch(BASE + '/dashboards')).status, 401);
  assert.equal((await fetch(BASE + '/dashboards?key=' + KEY)).status, 200);
});
