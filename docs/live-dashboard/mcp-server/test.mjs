// Self-test: starts the server on a free port, exercises MCP + REST + dashboard routes.
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import assert from 'node:assert/strict';
const port = 3900 + Math.floor(Math.random() * 90), key = 'test-key-' + Math.random().toString(36).slice(2);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-'));
const srv = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, API_KEY: key, PORT: port, DATA_DIR: dir }, stdio: 'inherit' });
const base = 'http://127.0.0.1:' + port;
const rpc = (method, params, id = 1, k = key) => fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': k }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
const csv = fs.readFileSync(new URL('../../copilot-dashboard-agent/sample-sales.csv', import.meta.url), 'utf8');
try {
  for (let i = 0; i < 30; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  assert.equal((await rpc('tools/list', {}, 1, 'wrong')).status, 401, 'wrong key rejected');
  const init = await (await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } })).json();
  assert.equal(init.result.serverInfo.name, 'live-dashboard');
  const list = await (await rpc('tools/list', {})).json();
  assert.deepEqual(list.result.tools.map(t => t.name), ['create_dashboard', 'update_dashboard', 'list_dashboards']);
  const notif = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(notif.status, 202);
  const r1 = (await (await rpc('tools/call', { name: 'create_dashboard', arguments: { name: 'sales.csv', csv_text: csv } })).json()).result;
  const c1 = JSON.parse(r1.content[0].text); assert.equal(c1.rows, 7); assert.equal(c1.created, true);
  const r2 = JSON.parse((await (await rpc('tools/call', { name: 'create_dashboard', arguments: { name: 'sales.csv', rows: [{ Date: '2026-10-08', Region: 'West', Units: 3, Revenue: 90 }, { Date: '2026-10-09', Region: 'West', Units: 4, Revenue: 120 }] } })).json()).result.content[0].text);
  assert.equal(r2.id, c1.id, 'same name keeps same link'); assert.equal(r2.created, false); assert.equal(r2.rows, 2);
  const data = await (await fetch(base + '/d/' + c1.id + '/data.csv')).text(); assert.ok(data.startsWith('Date,Region,Units,Revenue'));
  const page = await fetch(base + '/dashboard.html'); assert.match(await page.text(), /<title>File Dashboard<\/title>/, 'dashboard page served as HTML');
  const redir = await fetch(base + '/d/' + c1.id, { redirect: 'manual' }); assert.equal(redir.status, 302);
  const up = await (await fetch(base + '/api/upload', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ name: 'bad.csv', csv_text: csv }) })).json();
  assert.equal(up.rows, 7);
  const empty = (await (await rpc('tools/call', { name: 'create_dashboard', arguments: { name: 'e.csv', csv_text: 'a,b' } })).json()).result;
  assert.equal(empty.isError, true); assert.match(empty.content[0].text, /header row/);
  const bad = await (await rpc('tools/call', { name: 'update_dashboard', arguments: { id: 'zz', csv_text: csv } })).json(); assert.equal(bad.result.isError, true);
  const ls = JSON.parse((await (await rpc('tools/call', { name: 'list_dashboards', arguments: {} })).json()).result.content[0].text); assert.equal(ls.length, 2);
  assert.equal((await fetch(base + '/d/' + '0'.repeat(32))).status, 404);
  console.log('ALL TESTS PASSED'); console.log('dashboard url:', c1.url);
  fs.writeFileSync(path.join(dir, 'ID'), c1.id);
} catch (e) { console.error('TEST FAILED:', e.message); process.exitCode = 1; }
finally { if (!process.env.KEEP) srv.kill(); else console.log('kept running', port, key, dir); }
