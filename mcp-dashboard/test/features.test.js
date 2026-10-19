import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/tools.js';
import { Alerts } from '../src/alerts.js';

async function setup() {
  const store = new Store(null);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(store, (d) => `http://x/d/${d.id}?t=${d.token}`).connect(b);
  const c = new Client({ name: 't', version: '1' }); await c.connect(a);
  const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }); return { err: r.isError, out: r.content[0].text, json: () => JSON.parse(r.content[0].text) }; };
  return { store, c, call, dash: (await call('create_dashboard', { title: 'T' })).json() };
}

test('every tool schema avoids $ref / anyOf / type arrays (Copilot Studio friendly)', async () => {
  const { c } = await setup();
  for (const t of (await c.listTools()).tools) {
    const j = JSON.stringify(t.inputSchema);
    assert.ok(!/\$ref|anyOf|oneOf|"type":\[/.test(j), `${t.name} uses an unsupported schema construct`);
  }
});

test('kpi keeps history, computes change vs previous and threshold status', async () => {
  const { store, call, dash } = await setup();
  const w = (await call('upsert_widget', { dashboard_id: dash.id, type: 'kpi', title: 'Errors', value: '10', warn_at: 20, critical_at: 50 })).json();
  const get = () => store.get(dash.id).widgets[0];
  assert.equal(get().status, 'ok');
  await call('upsert_widget', { dashboard_id: dash.id, widget_id: w.widget_id, value: '25' });
  assert.equal(get().status, 'warn'); assert.deepEqual(get().history, [10, 25]); assert.equal(get().trend.pct, 150);
  await call('upsert_widget', { dashboard_id: dash.id, widget_id: w.widget_id, value: '60' });
  assert.equal(get().status, 'crit');
  await call('upsert_widget', { dashboard_id: dash.id, widget_id: w.widget_id, value: '60' });
  assert.deepEqual(get().history, [10, 25, 60], 'unchanged readings are not re-added');
});

test('"below is bad" thresholds work', async () => {
  const { store, call, dash } = await setup();
  await call('upsert_widget', { dashboard_id: dash.id, type: 'kpi', title: 'CSAT', value: '95', warn_at: 90, critical_at: 80, bad_when: 'below' });
  assert.equal(store.get(dash.id).widgets[0].status, 'ok');
  await call('upsert_widget', { dashboard_id: dash.id, widget_id: store.get(dash.id).widgets[0].id, value: '85' });
  assert.equal(store.get(dash.id).widgets[0].status, 'warn');
});

test('alerts post on transitions only, not on the first ok reading or repeats', async () => {
  const { store, call, dash } = await setup();
  const sent = [];
  new Alerts(store, { url: 'http://hook', linkFor: (d) => `http://x/d/${d.id}`, fetchImpl: async (u, o) => { sent.push(JSON.parse(o.body)); return { ok: true }; } });
  const w = (await call('upsert_widget', { dashboard_id: dash.id, type: 'kpi', title: 'Err', value: '1', critical_at: 5 })).json();
  const set = (v) => call('upsert_widget', { dashboard_id: dash.id, widget_id: w.widget_id, value: v });
  await set('9'); await set('10'); await set('2');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent.map((s) => s.status), ['crit', 'ok']);
  assert.match(sent[0].text, /CRITICAL: "Err" is 9/);
});

test('rotate_link invalidates the old token', async () => {
  const { store, call, dash } = await setup();
  const old = store.get(dash.id).token;
  const r = (await call('rotate_link', { dashboard_id: dash.id })).json();
  assert.notEqual(store.get(dash.id).token, old);
  assert.ok(r.url.includes(store.get(dash.id).token));
});
