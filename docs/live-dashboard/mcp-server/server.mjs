// Live Dashboard MCP server. No dependencies, Node 18+.
//   MCP (Streamable HTTP):  POST /mcp          tools: create_dashboard, update_dashboard, list_dashboards
//   REST for flows:         POST /api/upload   JSON { name, csv_text | rows }
//   Dashboard page:         GET  /d/<id>       (live: page re-reads /d/<id>/data.csv every minute)
// Auth for /mcp and /api/*: header  x-api-key: <API_KEY>
// Env: API_KEY (required), PORT (default 3000), PUBLIC_URL (optional, e.g. https://my-host.example.com), DATA_DIR (default ./data)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.API_KEY || '';
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(here, 'data');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const MAX_BYTES = 5 * 1024 * 1024;
fs.mkdirSync(DATA_DIR, { recursive: true });
const indexFile = path.join(DATA_DIR, 'index.json');

const readIndex = () => { try { return JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { return {}; } };
const writeIndex = i => fs.writeFileSync(indexFile, JSON.stringify(i, null, 2));
const fileFor = id => path.join(DATA_DIR, id + '.json');

function toCsv(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('rows must be a non-empty array');
  const cols = Array.isArray(rows[0]) ? null : [...new Set(rows.flatMap(r => Object.keys(r)))];
  const cell = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = cols ? [cols.map(cell).join(',')].concat(rows.map(r => cols.map(c => cell(r[c])).join(','))) : rows.map(r => r.map(cell).join(','));
  return lines.join('\n');
}

function validateCsv(csv) {
  if (typeof csv !== 'string' || csv.trim() === '') throw new Error('csv_text is empty');
  if (Buffer.byteLength(csv) > MAX_BYTES) throw new Error('file is larger than 5 MB');
  const lines = csv.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length < 2) throw new Error('file has only a header row or no rows');
  return lines.length - 1;
}

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return proto + '://' + req.headers.host;
}

function upsert(req, name, csv, id) {
  const rowCount = validateCsv(csv);
  const index = readIndex();
  const clean = String(name || '').trim().slice(0, 120);
  if (!clean && !id) throw new Error('name is required');
  if (!id) id = index[clean];
  if (id && !fs.existsSync(fileFor(id))) id = undefined;
  const created = !id;
  if (created) id = crypto.randomBytes(16).toString('hex');
  const prev = created ? {} : JSON.parse(fs.readFileSync(fileFor(id), 'utf8'));
  const rec = { id, name: clean || prev.name, csv, rows: rowCount, updated: new Date().toISOString() };
  fs.writeFileSync(fileFor(id), JSON.stringify(rec));
  index[rec.name] = id;
  writeIndex(index);
  return { id, name: rec.name, rows: rowCount, created, url: baseUrl(req) + '/d/' + id, updated: rec.updated };
}

// ---------- MCP ----------
const TOOLS = [
  { name: 'create_dashboard',
    description: 'Create or replace a live dashboard from CSV text or rows. Same name updates the existing dashboard and keeps its link. Returns the dashboard URL.',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string', description: 'File or dashboard name, for example sales.csv' },
      csv_text: { type: 'string', description: 'The whole file as CSV text, header row first' },
      rows: { type: 'array', description: 'Alternative to csv_text: array of objects (one per row)', items: { type: 'object' } } },
      required: ['name'] } },
  { name: 'update_dashboard',
    description: 'Replace the data of an existing dashboard by its id. The open dashboard refreshes by itself.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string', description: 'Dashboard id returned by create_dashboard' },
      csv_text: { type: 'string', description: 'The whole file as CSV text, header row first' },
      rows: { type: 'array', items: { type: 'object' } } }, required: ['id'] } },
  { name: 'list_dashboards',
    description: 'List all dashboards with name, rows, last update and link.',
    inputSchema: { type: 'object', properties: {} } },
];

function callTool(req, name, args) {
  args = args || {};
  const csv = args.csv_text !== undefined && args.csv_text !== '' ? args.csv_text : (args.rows ? toCsv(args.rows) : undefined);
  if (name === 'create_dashboard') return upsert(req, args.name, csv);
  if (name === 'update_dashboard') {
    if (!/^[0-9a-f]{32}$/.test(args.id || '') || !fs.existsSync(fileFor(args.id))) throw new Error('unknown dashboard id');
    return upsert(req, undefined, csv, args.id);
  }
  if (name === 'list_dashboards') {
    return Object.entries(readIndex()).map(([n, id]) => {
      try { const r = JSON.parse(fs.readFileSync(fileFor(id), 'utf8')); return { name: n, id, rows: r.rows, updated: r.updated, url: baseUrl(req) + '/d/' + id }; }
      catch { return null; }
    }).filter(Boolean);
  }
  throw new Error('unknown tool ' + name);
}

function handleRpc(req, msg) {
  const reply = result => ({ jsonrpc: '2.0', id: msg.id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: msg.params?.protocolVersion || '2025-03-26', capabilities: { tools: { listChanged: false } },
                     serverInfo: { name: 'live-dashboard', version: '1.0.0' } });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call':
      try {
        const out = callTool(req, msg.params?.name, msg.params?.arguments);
        return reply({ content: [{ type: 'text', text: JSON.stringify(out) }] });
      } catch (e) {
        return reply({ isError: true, content: [{ type: 'text', text: 'ERROR: ' + e.message }] });
      }
    default:
      if (msg.method && msg.method.startsWith('notifications/')) return null;
      return error(-32601, 'Method not found: ' + msg.method);
  }
}

// ---------- HTTP ----------
function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > MAX_BYTES + 100000) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const send = (res, code, data, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
};
const authed = req => {
  const k = req.headers['x-api-key'] || '';
  if (!API_KEY || k.length !== API_KEY.length) return false;
  return crypto.timingSafeEqual(Buffer.from(k), Buffer.from(API_KEY));
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && p === '/dashboard.html') return send(res, 200, fs.readFileSync(path.join(here, 'public', 'dashboard.html'), 'utf8'), 'text/html');
    let m;
    if (req.method === 'GET' && (m = /^\/d\/([0-9a-f]{32})(\/data\.csv)?$/.exec(p))) {
      if (!fs.existsSync(fileFor(m[1]))) return send(res, 404, { error: 'not found' });
      if (m[2]) return send(res, 200, JSON.parse(fs.readFileSync(fileFor(m[1]), 'utf8')).csv, 'text/csv');
      res.writeHead(302, { location: '/dashboard.html?csv=' + encodeURIComponent('/d/' + m[1] + '/data.csv') }); return res.end();
    }
    if (p === '/mcp' || p === '/api/upload') {
      if (!authed(req)) return send(res, 401, { error: 'missing or wrong x-api-key' });
      if (req.method === 'GET' && p === '/mcp') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST' });
      let json; try { json = JSON.parse(await body(req)); } catch { return send(res, 400, { error: 'invalid JSON' }); }
      if (p === '/api/upload') {
        try { const csv = json.csv_text || (json.rows ? toCsv(json.rows) : undefined); return send(res, 200, upsert(req, json.name, csv)); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (Array.isArray(json)) { const out = json.map(x => handleRpc(req, x)).filter(Boolean); return out.length ? send(res, 200, out) : (res.writeHead(202), res.end()); }
      const out = handleRpc(req, json);
      if (!out) { res.writeHead(202); return res.end(); }
      return send(res, 200, out);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: e.message }); }
});

if (!API_KEY) { console.error('Set API_KEY (a long random string) before starting.'); process.exit(1); }
server.listen(PORT, () => console.log('Live Dashboard MCP listening on :' + PORT));
