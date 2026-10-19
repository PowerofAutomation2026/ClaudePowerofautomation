import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/tools.js';

async function setup(generate) {
  const store = new Store(null);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(store, (d) => `http://x/d/${d.id}?t=${d.token}`, { generate }).connect(b);
  const c = new Client({ name: 't', version: '1' }); await c.connect(a);
  return { c, store };
}
const run = async (c, args) => { const r = await c.callTool({ name: 'generate_dashboard', arguments: args }); return { err: r.isError, out: r.content[0].text }; };

test('generate_dashboard builds from the model spec and passes data through', async () => {
  let seen;
  const { c, store } = await setup(async (i) => { seen = i; return { title: 'Sales', description: 'd', widgets: [
    { type: 'kpi', title: 'Total', value: '42' }, { type: 'bar', title: 'By region', labels: ['N', 'S'], values: [1, 2] }] }; });
  const { out } = await run(c, { prompt: 'sales', data: 'region,amt\nN,1' });
  assert.match(seen.data, /region,amt/);
  const d = JSON.parse(out);
  assert.equal(store.get(d.id).widgets.length, 2);
  assert.equal(store.get(d.id).widgets[1].span, 2);
});

test('regenerating keeps the same link; a bad spec rolls back', async () => {
  let spec = { title: 'v1', description: '', widgets: [{ type: 'kpi', title: 'A', value: '1' }] };
  const { c, store } = await setup(async () => spec);
  const first = JSON.parse((await run(c, { prompt: 'x' })).out);
  spec = { title: 'v2', description: '', widgets: [{ type: 'kpi', title: 'B', value: '2' }] };
  const second = JSON.parse((await run(c, { prompt: 'x', dashboard_id: first.id })).out);
  assert.equal(second.url, first.url);
  assert.equal(store.get(first.id).widgets[0].title, 'B');
  spec = { title: 'v3', description: '', widgets: [{ type: 'bar', title: 'bad', labels: ['a'], values: [1, 2] }] };
  const bad = await run(c, { prompt: 'x', dashboard_id: first.id });
  assert.ok(bad.err);
  assert.equal(store.get(first.id).widgets[0].title, 'B'); // untouched
});

test('model errors surface to the agent', async () => {
  const { c } = await setup(async () => { throw new Error('Anthropic authentication failed'); });
  const r = await run(c, { prompt: 'x' });
  assert.ok(r.err); assert.match(r.out, /authentication/);
});
