#!/usr/bin/env node
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Store } from './store.js';
import { createServer } from './tools.js';
import { Registry } from './sources/index.js';
import { Engine } from './engine.js';
import { OAuth } from './oauth.js';
import { Alerts } from './alerts.js';
import { setupPage, connectorSwagger, connectorProperties, agentInstructions } from './setup.js';
import { VIEWER_HTML } from './ui.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATA_FILE = process.env.DATA_FILE ?? './data/dashboards.json';
const PUBLIC_URL = process.env.PUBLIC_URL?.replace(/\/$/, '');
const MAX_BODY = 1_000_000;
const stdio = process.argv.includes('--stdio');

let API_KEY = process.env.API_KEY;
if (!API_KEY && !stdio) {
  API_KEY = randomBytes(18).toString('base64url');
  console.error(`API_KEY not set - generated one for this run: ${API_KEY}\nSet API_KEY in the environment to keep it stable.`);
}

const safeEq = (a = '', b = '') => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const store = new Store(DATA_FILE);
const sources = Registry.fromFile(process.env.DATASOURCES_FILE ?? './datasources.json');
const engine = new Engine(store, sources);
new Alerts(store, { url: process.env.ALERT_WEBHOOK_URL, linkFor: (d) => linkFor(d) });
engine.start();
const toolOpts = { sources, engine };
const oauth = API_KEY ? new OAuth({ apiKey: API_KEY }) : null;

/** Base url used for the links returned to agents. */
function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const h = req?.headers;
  if (h?.host) return `${h['x-forwarded-proto'] ?? 'http'}://${h['x-forwarded-host'] ?? h.host}`;
  return `http://localhost:${PORT}`;
}
const linkFor = (d, req) => `${baseUrl(req)}/d/${d.id}?t=${d.token}`;

if (stdio) {
  // For Claude Desktop / Claude Code: `node src/server.js --stdio`. Viewer links need the web server too.
  http.createServer(handle).listen(PORT, HOST, () => console.error(`viewer on :${PORT}`));
  await createServer(store, (d) => linkFor(d), toolOpts).connect(new StdioServerTransport());
} else {
  http.createServer(handle).listen(PORT, HOST, () => {
    console.error(`Live Dashboard MCP listening on ${HOST}:${PORT}\n  MCP endpoint: ${PUBLIC_URL ?? `http://localhost:${PORT}`}/mcp`);
  });
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const readBody = (req) => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(new Error('Body too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined); } catch { reject(Object.assign(new Error('Invalid JSON'), { code: 400 })); } });
  req.on('error', reject);
});

const readForm = async (req) => {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 100_000) throw Object.assign(new Error('Body too large'), { code: 413 }); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString();
  if ((req.headers['content-type'] ?? '').includes('json')) { try { return JSON.parse(raw || '{}'); } catch { throw Object.assign(new Error('Invalid JSON'), { code: 400 }); } }
  return Object.fromEntries(new URLSearchParams(raw));
};
const clientIp = (req) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();

function authed(req, url) {
  if (!API_KEY) return true;
  const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
  if (bearer && oauth?.verifyAccess(bearer)) return true; // OAuth (dynamic discovery) access token
  return safeEq(bearer ?? req.headers['x-api-key'] ?? url.searchParams.get('key') ?? '', API_KEY);
}
const canView = (d, url) => safeEq(url.searchParams.get('t') ?? '', d.token);

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  try {
    if (path === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (path === '/healthz') return send(res, 200, { ok: true });

    if (path === '/mcp') {
      if (!authed(req, url)) { res.setHeader('www-authenticate', oauth ? oauth.challenge(baseUrl(req)) : 'Bearer'); return send(res, 401, { error: 'unauthorized' }); }
      if (req.method !== 'POST') return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server, use POST)' }, id: null });
      // Stateless: a fresh server + transport per request, so it scales out and survives restarts.
      const body = await readBody(req);
      const server = createServer(store, (d) => linkFor(d, req), toolOpts);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      return transport.handleRequest(req, res, body);
    }

    if (oauth) {
      const base = baseUrl(req);
      if (path.startsWith('/.well-known/oauth-protected-resource')) return send(res, 200, oauth.protectedResource(base));
      if (path === '/.well-known/oauth-authorization-server') return send(res, 200, oauth.serverMetadata(base));
      if (path === '/register' && req.method === 'POST') { const r = oauth.register(await readForm(req)); return send(res, r.status, r.body); }
      if (path === '/authorize') {
        if (req.method === 'GET') {
          const q = Object.fromEntries(url.searchParams);
          const chk = oauth.checkAuthorize(q);
          return chk.error ? send(res, 400, `<!doctype html><meta charset="utf-8"><p>${chk.error}</p>`, 'text/html; charset=utf-8') : send(res, 200, oauth.consentPage(q, chk.client), 'text/html; charset=utf-8');
        }
        if (req.method === 'POST') {
          const r = oauth.authorize(await readForm(req), clientIp(req));
          if (r.redirect) { res.writeHead(302, { location: r.redirect, 'cache-control': 'no-store' }); return res.end(); }
          return send(res, r.status, r.html, 'text/html; charset=utf-8');
        }
      }
      if (path === '/token' && req.method === 'POST') { const r = oauth.token(await readForm(req), req.headers.authorization); return send(res, r.status, r.body); }
    }

    if (path === '/') return send(res, 200, setupPage(baseUrl(req), { oauth: !!oauth }), 'text/html; charset=utf-8');
    if (path === '/copilot-studio/connector.swagger.json') return send(res, 200, connectorSwagger(baseUrl(req)));
    if (path === '/copilot-studio/connector.properties.json') return send(res, 200, connectorProperties());
    if (path === '/copilot-studio/agent-instructions.md') return send(res, 200, agentInstructions(), 'text/markdown; charset=utf-8');

    if (path === '/dashboards') {
      if (!authed(req, url)) return send(res, 401, 'Add ?key=<API_KEY> to list dashboards.', 'text/plain');
      const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const items = store.list().map((d) => `<li><a href="${esc(linkFor(d, req))}">${esc(d.title)}</a> <small>${d.widgets.length} widgets</small></li>`).join('') || '<li>No dashboards yet.</li>';
      return send(res, 200, `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>Dashboards</title><body style="font:15px system-ui;max-width:640px;margin:40px auto;padding:0 16px"><h1>Dashboards</h1><ul>${items}</ul>`, 'text/html; charset=utf-8');
    }

    const view = /^\/d\/([\w-]+)$/.exec(path);
    if (view) return send(res, 200, VIEWER_HTML, 'text/html; charset=utf-8');

    const api = /^\/api\/d\/([\w-]+)$/.exec(path) ?? /^\/events\/([\w-]+)$/.exec(path);
    if (api) {
      const d = store.dashboards.get(api[1]);
      if (!d) return send(res, 404, { error: 'not found' });
      if (!canView(d, url)) return send(res, 403, { error: 'forbidden' });
      if (path.startsWith('/api/')) return send(res, 200, d);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(`retry: 3000\ndata: ${JSON.stringify(d)}\n\n`);
      const onChange = (changedId, change) => {
        if (changedId !== d.id) return;
        res.write(`data: ${JSON.stringify(change.kind === 'deleted' ? { deleted: true } : store.dashboards.get(d.id))}\n\n`);
      };
      store.on('change', onChange);
      store.viewerJoin(d.id);
      const beat = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(beat); store.off('change', onChange); store.viewerLeave(d.id); });
      return;
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) send(res, e.code === 413 || e.code === 400 ? e.code : 500, { error: e.message });
    else res.end();
  }
}

export { store, handle };
