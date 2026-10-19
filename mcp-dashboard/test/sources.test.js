import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFileSync, mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import ExcelJS from 'exceljs';
import { Store } from '../src/store.js';
import { createServer } from '../src/tools.js';
import { Registry } from '../src/sources/index.js';
import { Engine } from '../src/engine.js';
import { parseCsv } from '../src/sources/rows.js';
import { assertReadOnly } from '../src/sources/sql.js';

const dir = mkdtempSync(join(tmpdir(), 'dash-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bump = 1;
const writeCsv = (f, body) => { writeFileSync(f, body); utimesSync(f, new Date(), new Date(Date.now() + 1000 * bump++)); };

async function setup(config, providers) {
  const store = new Store(null);
  const sources = new Registry(config, providers);
  const engine = new Engine(store, sources);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(store, (d) => `http://x/d/${d.id}`, { sources, engine }).connect(b);
  const c = new Client({ name: 't', version: '1' }); await c.connect(a);
  const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }); return { err: r.isError, out: r.content[0].text, json: () => JSON.parse(r.content[0].text) }; };
  const dash = (await call('create_dashboard', { title: 'T' })).json();
  return { store, sources, engine, call, dash };
}

test('csv parser handles quotes, delimiters, BOM and blanks', () => {
  const rows = parseCsv('﻿name;amt\r\n"Smith; J";"1,200"\r\n\r\n"He said ""hi""";5\r\n');
  assert.deepEqual(rows, [{ name: 'Smith; J', amt: '1,200' }, { name: 'He said "hi"', amt: '5' }]);
});

test('sql guard allows only a single SELECT/WITH', () => {
  assert.equal(assertReadOnly('SELECT 1;'), 'SELECT 1');
  assert.ok(assertReadOnly('with a as (select 1) select * from a'));
  for (const bad of ['DELETE FROM t', 'select 1; drop table t', 'exec sp_x', 'update t set a=1']) assert.throws(() => assertReadOnly(bad));
});

test('CSV file: bind kpi/bar/table, agent never supplies a path, file edits flow through', async () => {
  const f = join(dir, 'sales.csv');
  writeCsv(f, 'Region,Amount\nNorth,"1,000"\nSouth,500\nNorth,250\n');
  const { store, call, dash } = await setup({ sources: { sales: { type: 'csv', location: f, refreshSeconds: 5 } } });
  assert.equal(JSON.stringify((await call('list_datasources', {})).json()).includes(dir), false);
  const d = (await call('describe_datasource', { source: 'sales' })).json();
  assert.deepEqual(d.columns, ['Region', 'Amount']);

  const k = (await call('bind_widget', { dashboard_id: dash.id, type: 'kpi', title: 'Total', source: 'sales', column: 'amount' })).json();
  const bar = (await call('bind_widget', { dashboard_id: dash.id, type: 'bar', title: 'By region', source: 'sales', label: 'Region', values: ['Amount'] })).json();
  await call('bind_widget', { dashboard_id: dash.id, type: 'table', title: 'Rows', source: 'sales', order_by: 'Amount', desc: true });
  const ws = store.get(dash.id).widgets;
  assert.equal(ws[0].value, 1750);
  assert.deepEqual(bar.preview.labels, ['North', 'South']);
  assert.deepEqual(ws[1].series[0].values, [1250, 500]);
  assert.equal(ws[2].rows[0][1], '1,000');

  writeCsv(f, 'Region,Amount\nNorth,"1,000"\nSouth,500\nNorth,250\nEast,50\n');
  await call('refresh_now', { dashboard_id: dash.id });
  assert.equal(store.get(dash.id).widgets[0].value, 1800);
  assert.deepEqual(store.get(dash.id).widgets[1].labels, ['North', 'South', 'East']);
  assert.ok(k.widget_id);
});

test('bad column gives a readable error and creates nothing', async () => {
  const f = join(dir, 'a.csv'); writeCsv(f, 'a,b\n1,2\n');
  const { call, dash, store } = await setup({ sources: { s: { type: 'csv', location: f } } });
  const r = await call('bind_widget', { dashboard_id: dash.id, type: 'kpi', title: 'x', source: 's', column: 'zzz' });
  assert.ok(r.err); assert.match(r.out, /Columns: a, b/);
  assert.equal(store.get(dash.id).widgets.length, 0);
  const u = await call('describe_datasource', { source: 'nope' });
  assert.match(u.out, /Unknown data source/);
});

test('Excel (.xlsx) sheet is read, formulas resolved', async () => {
  const f = join(dir, 'b.xlsx');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Other').addRow(['x']);
  const ws = wb.addWorksheet('Budget');
  ws.addRow(['Dept', 'Spend']); ws.addRow(['IT', 10]); ws.addRow(['HR', { formula: 'A1', result: 32 }]);
  await wb.xlsx.writeFile(f);
  const { call, dash, store } = await setup({ sources: { b: { type: 'excel', location: f, sheet: 'Budget' } } });
  await call('bind_widget', { dashboard_id: dash.id, type: 'kpi', title: 'Spend', source: 'b', column: 'Spend' });
  assert.equal(store.get(dash.id).widgets[0].value, 42);
});

test('HTTP file uses ETag and skips re-download; Power Automate flow returns rows', async () => {
  let hits = 0, conditional = 0, flowBody;
  const srv = http.createServer((req, res) => {
    if (req.url === '/f.csv') {
      hits++;
      if (req.headers['if-none-match'] === '"v1"') { conditional++; res.writeHead(304); return res.end(); }
      res.writeHead(200, { etag: '"v1"', 'content-type': 'text/csv' }); return res.end('k,v\na,1\nb,2\n');
    }
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => { flowBody = JSON.parse(body); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ value: [{ Team: 'A', Open: 3 }, { Team: 'B', Open: 4 }] })); });
  }).listen(0);
  const port = srv.address().port;
  process.env.TEST_FLOW_URL = `http://localhost:${port}/flow`;
  const { call, dash, store, sources } = await setup({ sources: {
    web: { type: 'csv', location: `http://localhost:${port}/f.csv` },
    flow: { type: 'powerautomate', url: 'env:TEST_FLOW_URL', queries: { open_cases: 'ignored by us, handled by the flow' } },
  } });
  await sources.fetchRows('web'); await sources.fetchRows('web');
  assert.equal(hits, 2); assert.equal(conditional, 1);
  await call('bind_widget', { dashboard_id: dash.id, type: 'pie', title: 'Open', source: 'flow', label: 'Team', values: ['Open'] });
  assert.equal(flowBody.query, 'open_cases');
  assert.deepEqual(store.get(dash.id).widgets[0].series[0].values, [4, 3]);
  srv.close();
});

test('SQL Server and Oracle sources use named admin queries only (fake drivers)', async () => {
  const seen = [];
  const fake = (rows) => ({ fetch: async (cfg, q) => { seen.push([cfg.__name, q]); return rows; } });
  const { call, dash, store } = await setup({ sources: {
    erp: { type: 'sqlserver', connection: 'x', queries: { daily: 'SELECT day, total FROM v_daily', top: 'SELECT 1' } },
    hr: { type: 'oracle', connection: {}, queries: { heads: 'SELECT dept, n FROM heads' } },
  } }, { sqlserver: fake([{ day: '2026-01-02', total: 5 }, { day: '2026-01-01', total: 3 }]), oracle: fake([{ DEPT: 'IT', N: 7 }]) });
  assert.match((await call('describe_datasource', { source: 'erp' })).out, /must be one of: daily, top/);
  await call('bind_widget', { dashboard_id: dash.id, type: 'line', title: 'Daily', source: 'erp', query: 'daily', label: 'day', values: ['total'] });
  await call('bind_widget', { dashboard_id: dash.id, type: 'kpi', title: 'IT', source: 'hr', column: 'n' }); // single query: no "query" needed, oracle upper-case cols
  const [line, kpi] = store.get(dash.id).widgets;
  assert.deepEqual(line.labels, ['2026-01-01', '2026-01-02']); // line charts sort chronologically
  assert.equal(kpi.value, 7);
  assert.deepEqual(seen.map((s) => s[1]), ['SELECT day, total FROM v_daily', 'SELECT dept, n FROM heads']);
});

test('auto refresh polls only while the dashboard is being viewed; failures keep last data', async () => {
  const f = join(dir, 'live.csv'); writeCsv(f, 'v\n1\n');
  const { call, dash, store, sources, engine } = await setup({ sources: { s: { type: 'csv', location: f } } });
  sources.refreshSeconds = () => 0.05;
  await call('bind_widget', { dashboard_id: dash.id, type: 'kpi', title: 'V', source: 's', column: 'v' });
  const w = () => store.get(dash.id).widgets[0];
  writeCsv(f, 'v\n2\n'); await sleep(200);
  assert.equal(w().value, 1, 'no viewers -> no polling (protects the database)');
  store.viewerJoin(dash.id); await sleep(150);
  assert.equal(w().value, 2, 'viewer joined -> immediate refresh');
  writeCsv(f, 'v\n3\n'); await sleep(200);
  assert.equal(w().value, 3, 'timer keeps it live');
  writeCsv(f, 'no_such_column\n1\n'); await sleep(200);
  assert.equal(w().value, 3); assert.match(w().error, /not found/);
  writeCsv(f, 'v\n4\n'); await sleep(200);
  assert.equal(w().value, 4); assert.equal(w().error, undefined);
  store.viewerLeave(dash.id); engine.stop();
});

test('config with a write query is rejected at load time', () => {
  assert.throws(() => new Registry({ sources: { x: { type: 'oracle', connection: {}, queries: { bad: 'DELETE FROM t' } } } }), /query "bad".*only SELECT/);
});
