import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 3911, KEY = 'test-key';
const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT, API_KEY: KEY, DATA_FILE: `/tmp/dash-test-${process.pid}.json` }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
test.after(() => srv.kill());

const connect = async (key = KEY) => {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return c;
};
const call = async (c, name, args) => {
  const r = await c.callTool({ name, arguments: args });
  return { err: r.isError, data: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
};

test('rejects bad key', async () => { await assert.rejects(connect('nope')); });

test('build, live-update and view a dashboard', async () => {
  const c = await connect();
  assert.ok((await c.listTools()).tools.length >= 8);
  const { data: d } = await call(c, 'build_dashboard', { title: 'Sales', widgets: [
    { type: 'kpi', title: 'Revenue', value: '1200', unit: '$', delta: 4.2 },
    { type: 'line', title: 'Trend', labels: ['a', 'b'], values: [1, 2] },
    { type: 'table', title: 'Top', columns: ['n', 'v'], rows: [['x', '1']] },
  ] });
  assert.match(d.url, /^http:\/\/localhost:3911\/d\/\w+\?t=\w+$/);
  const line = d.widgets.find((w) => w.type === 'line');

  // open SSE, then push a point and expect it to arrive
  const sse = await fetch(d.url.replace('/d/', '/events/'));
  const reader = sse.body.getReader();
  await reader.read(); // initial snapshot
  await call(c, 'append_point', { dashboard_id: d.id, widget_id: line.id, label: 'c', values: { Value: 9 } });
  const { value } = await reader.read();
  const pushed = JSON.parse(new TextDecoder().decode(value).split('data: ')[1]);
  assert.deepEqual(pushed.widgets.find((w) => w.id === line.id).labels, ['a', 'b', 'c']);
  await reader.cancel();

  assert.equal((await fetch(d.url.replace('/d/', '/api/d/'))).status, 200);
  assert.equal((await fetch(`http://localhost:${PORT}/api/d/${d.id}?t=wrong`)).status, 403);
  assert.match(await (await fetch(d.url)).text(), /Live dashboard/);
});

test('validation errors are reported to the agent', async () => {
  const c = await connect();
  const r = await call(c, 'build_dashboard', { title: 'Bad', widgets: [{ type: 'bar', title: 'x', labels: ['a'], values: [1, 2] }] });
  assert.ok(r.err); assert.match(r.data, /must match/);
  assert.equal((await call(c, 'list_dashboards', {})).data.filter((x) => x.title === 'Bad').length, 0);
});
