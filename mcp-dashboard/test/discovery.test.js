import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/tools.js';
import { Registry } from '../src/sources/index.js';
import { Engine } from '../src/engine.js';
import { planBinding } from '../src/sources/sqlbuilder.js';

const ordersInfo = { schema: 'dbo', name: 'Orders', columns: [
  { name: 'OrderDate', type: 'date' }, { name: 'Region', type: 'nvarchar' }, { name: 'Total', type: 'decimal' }, { name: 'Qty', type: 'int' }] };

test('SQL Server plans: bound params, quoted identifiers, TOP, pushdown aggregation', () => {
  const kpi = planBinding('sqlserver', 'kpi', { column: 'total', agg: 'sum', filters: [{ column: 'region', op: 'eq', value: 'North' }, { column: 'qty', op: 'gte', value: '5' }] }, ordersInfo);
  assert.equal(kpi.sql, 'SELECT SUM([Total]) AS [value] FROM [dbo].[Orders] WHERE [Region] = @p1 AND [Qty] >= @p2');
  assert.deepEqual(kpi.params, { p1: 'North', p2: 5 });
  const line = planBinding('sqlserver', 'line', { label: 'orderdate', values: ['total'], limit: 12 }, ordersInfo);
  assert.equal(line.sql, 'SELECT TOP (12) [OrderDate], SUM([Total]) AS [Total] FROM [dbo].[Orders] GROUP BY [OrderDate] ORDER BY [OrderDate] DESC');
  assert.deepEqual(line.resultBinding, { label: 'OrderDate', values: ['Total'], group: false, sort: 'label', limit: 12 });
  const pie = planBinding('sqlserver', 'pie', { label: 'Region' }, ordersInfo);
  assert.match(pie.sql, /^SELECT TOP \(8\) \[Region\], COUNT\(\*\) AS \[Count\] FROM \[dbo\]\.\[Orders\] GROUP BY \[Region\] ORDER BY \[Count\] DESC$/);
  const tbl = planBinding('sqlserver', 'table', { columns: ['Region', 'Total'], order_by: 'Total', desc: true, limit: 10, filters: [{ column: 'Region', op: 'in', value: 'N, S' }, { column: 'Total', op: 'not_null' }] }, ordersInfo);
  assert.equal(tbl.sql, 'SELECT TOP (10) [Region], [Total] FROM [dbo].[Orders] WHERE [Region] IN (@p1, @p2) AND [Total] IS NOT NULL ORDER BY [Total] DESC');
});

test('Oracle plans: named binds, FETCH FIRST, date literals', () => {
  const p = planBinding('oracle', 'bar', { label: 'Region', values: ['Total'], agg: 'avg', filters: [{ column: 'OrderDate', op: 'gte', value: '2026-01-01' }, { column: 'Region', op: 'contains', value: 'or' }] }, ordersInfo);
  assert.equal(p.sql, `SELECT "Region", AVG("Total") AS "Total" FROM "dbo"."Orders" WHERE "OrderDate" >= TO_DATE(SUBSTR(:p1,1,10),'YYYY-MM-DD') AND "Region" LIKE :p2 GROUP BY "Region" ORDER BY "Region" ASC FETCH FIRST 30 ROWS ONLY`);
  assert.deepEqual(p.params, { p1: '2026-01-01', p2: '%or%' });
});

test('injection attempts never reach the SQL text', () => {
  const evil = "x'; DROP TABLE Orders;--";
  const p = planBinding('sqlserver', 'kpi', { column: 'Total', filters: [{ column: 'Region', op: 'eq', value: evil }] }, ordersInfo);
  assert.ok(!p.sql.includes('DROP')); assert.equal(p.params.p1, evil);
  assert.throws(() => planBinding('sqlserver', 'kpi', { column: 'Total; DROP TABLE x' }, ordersInfo), /not found/);
  assert.throws(() => planBinding('sqlserver', 'kpi', { column: 'Total', filters: [{ column: 'Qty', op: 'eq', value: '1 OR 1=1' }] }, ordersInfo), /not a number/);
  assert.throws(() => planBinding('sqlserver', 'kpi', { column: 'Total', agg: 'last' }, ordersInfo), /not supported for tables/);
  assert.throws(() => planBinding('sqlserver', 'kpi', { column: 'Total', filters: [{ column: 'Region', op: 'sleep', value: '1' }] }, ordersInfo), /op must be/);
});

async function setup(rowsFor, discover = { include: ['dbo.*'], exclude: ['dbo.Secret*'] }) {
  const log = [];
  const fake = { fetch: async (cfg, sql, _n, params) => {
    log.push({ sql, params });
    if (sql.includes('INFORMATION_SCHEMA.TABLES')) return [{ schema_name: 'dbo', table_name: 'Orders', kind: 'BASE TABLE' }, { schema_name: 'dbo', table_name: 'SecretPay', kind: 'BASE TABLE' }, { schema_name: 'sys', table_name: 'objects', kind: 'VIEW' }];
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return ordersInfo.columns.map((c) => ({ column_name: c.name, data_type: c.type }));
    return rowsFor(sql);
  } };
  const store = new Store(null);
  const sources = new Registry({ sources: { erp: { type: 'sqlserver', connection: 'x', discover, ...(discover ? {} : { queries: { q: 'SELECT 1' } }) } } }, { sqlserver: fake });
  const engine = new Engine(store, sources);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(store, (d) => `http://x/${d.id}`, { sources, engine }).connect(b);
  const c = new Client({ name: 't', version: '1' }); await c.connect(a);
  const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }); return { err: r.isError, out: r.content[0].text, json: () => JSON.parse(r.content[0].text) }; };
  return { store, sources, engine, call, log, dash: (await call('create_dashboard', { title: 'T' })).json() };
}

test('agent discovers tables, sees only the allow-list, describes and binds without writing SQL', async () => {
  const { call, dash, store, log } = await setup((sql) => (sql.includes('GROUP BY') ? [{ OrderDate: '2026-01-02', Total: 5 }, { OrderDate: '2026-01-01', Total: 3 }] : [{ value: 1234.5 }]));
  const list = (await call('list_tables', { source: 'erp' })).json();
  assert.deepEqual(list.tables, ['dbo.Orders'], 'sys.objects and dbo.SecretPay are hidden');
  assert.deepEqual((await call('list_tables', { source: 'erp', search: 'ord' })).json().tables, ['dbo.Orders']);
  const d = (await call('describe_table', { source: 'erp', table: 'orders' })).json();
  assert.deepEqual(d.columns.map((c) => c.name), ['OrderDate', 'Region', 'Total', 'Qty']);
  assert.ok((await call('describe_table', { source: 'erp', table: 'dbo.SecretPay' })).err);
  assert.ok((await call('describe_table', { source: 'erp', table: 'sys.objects' })).err);

  const first = await call('bind_widget', { dashboard_id: dash.id, type: 'kpi', title: 'Revenue', source: 'erp', table: 'dbo.Orders', column: 'Total', filters: [{ column: 'Region', op: 'eq', value: 'North' }] });
  await call('bind_widget', { dashboard_id: dash.id, type: 'line', title: 'Trend', source: 'erp', table: 'dbo.Orders', label: 'OrderDate', values: ['Total'] });
  assert.ok(!first.err, first.out);
  const [kpi, line] = store.get(dash.id).widgets;
  assert.equal(kpi.value, 1234.5);
  assert.deepEqual(line.labels, ['2026-01-01', '2026-01-02']);
  const issued = log.filter((l) => /^SELECT (TOP|SUM)/.test(l.sql));
  assert.ok(issued.every((l) => !/North/.test(l.sql)), 'values are parameters, never in the SQL text');
});

test('table discovery is off unless the admin enables it', async () => {
  const { call } = await setup(() => [], null);
  const r = await call('list_tables', { source: 'erp' });
  assert.ok(r.err); assert.match(r.out, /not enabled/);
});

test('engine refreshes table-bound widgets through the planner', async () => {
  let total = 10;
  const { engine, call, dash, store } = await setup(() => [{ value: total }]);
  const w = (await call('bind_widget', { dashboard_id: dash.id, type: 'kpi', title: 'T', source: 'erp', table: 'Orders', column: 'Total', warn_at: 15, critical_at: 30 })).json();
  assert.equal(store.get(dash.id).widgets[0].status, 'ok');
  total = 40; await engine.refreshWidget(dash.id, w.widget_id);
  assert.equal(store.get(dash.id).widgets[0].value, 40); assert.equal(store.get(dash.id).widgets[0].status, 'crit');
  engine.stop();
});
