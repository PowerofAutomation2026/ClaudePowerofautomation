import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startEmulator, parseArgs } from '../src/server.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emu-'))
const base = parseArgs([]); Object.assign(base, { data: dir, size: 'small', live: false, feed: false, quiet: true, port: 0 })
let passed = 0, failed = 0
const t = async (name, fn) => { try { await fn(); passed++ } catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message.split('\n').slice(0, 4).join('\n   ')) } }

const emu = await startEmulator({ ...base })
const U = `http://127.0.0.1:${emu.port}`
const call = async (method, p, body, headers = {}) => {
  const r = await fetch(U + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text(); let json; try { json = JSON.parse(text) } catch { json = null }
  return { status: r.status, json, headers: r.headers }
}
const DS = { sql: 'emulator,SalesDW', oracle: 'EMULATOR/ERPPROD', teradata: 'emulator/EDW_PROD' }
const ds = (e) => `/${e}/datasets/${encodeURIComponent(DS[e])}`
const q = async (e, query) => call('POST', `${ds(e)}/query/sql`, { query })
const rows = async (e, query) => { const r = await q(e, query); assert.equal(r.status, 200, `${e}: ${query}\n${JSON.stringify(r.json)}`); return r.json.ResultSets.Table1 }
const items = async (e, table, qs = '') => call('GET', `${ds(e)}/tables/${encodeURIComponent(table)}/items${qs}`)

await t('health: three engines with big-ish tables', async () => {
  const h = (await call('GET', '/health')).json
  assert.deepEqual(h.engines.map((x) => x.id), ['sql', 'oracle', 'teradata'])
  const total = h.engines.flatMap((x) => x.tables).reduce((s, x) => s + x.rows, 0)
  assert.ok(total > 20000, 'rows seeded: ' + total)
  assert.ok(h.engines[0].tables.some((x) => x.name === '[dbo].[FactSales]'))
  assert.ok(h.engines[1].tables.some((x) => x.name === 'SALES.ORDERS'))
  assert.ok(h.engines[2].tables.some((x) => x.name === 'EDW_PROD.CALL_DETAIL_FACT'))
})
await t('connector shape: datasets, tables, metadata', async () => {
  assert.deepEqual((await call('GET', `/sql/datasets`)).json.value[0].Name, 'emulator,SalesDW')
  const tbl = (await call('GET', `${ds('sql')}/tables`)).json.value
  assert.ok(tbl.every((x) => x.Name && x.DisplayName))
  const meta = (await call('GET', `${ds('oracle')}/tables/${encodeURIComponent('SALES.ORDERS')}`)).json
  assert.ok(meta.Columns.some((c) => c.name === 'ORDER_TOTAL') && meta.RowCount > 1000)
  assert.equal((await call('GET', `/sql/datasets/nope,nope/tables`)).status, 404)
})
await t('items: $top, $select, $orderby, $filter', async () => {
  const r = await items('sql', '[dbo].[ServiceNowIncidents]', '?$top=5&$select=Number,State,MadeSLA,Opened&$orderby=Number desc')
  assert.equal(r.status, 200); assert.equal(r.json.value.length, 5)
  assert.deepEqual(Object.keys(r.json.value[0]), ['Number', 'State', 'MadeSLA', 'Opened'])
  assert.ok(r.json.value[0].Number > r.json.value[1].Number)
  assert.ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(r.json.value[0].Opened), 'SQL Server datetimes are ISO: ' + r.json.value[0].Opened)
  const withSla = (await items('sql', 'dbo.ServiceNowIncidents', "?$top=50&$filter=State eq 'Closed' and MadeSLA eq true")).json.value
  assert.ok(withSla.length > 0 && withSla.every((x) => x.State === 'Closed' && x.MadeSLA === true), 'BIT columns come back as booleans')
  const f = (await items('oracle', 'SALES.ORDERS', "?$filter=(STATUS eq 'SHIPPED' or STATUS eq 'DELIVERED') and ORDER_TOTAL gt 500 and ORDER_DATE ge 2026-01-01T00:00:00Z&$top=100")).json.value
  assert.ok(f.length > 0 && f.every((x) => ['SHIPPED', 'DELIVERED'].includes(x.STATUS) && x.ORDER_TOTAL > 500 && x.ORDER_DATE >= '2026-01-01'))
  assert.ok(Object.keys(f[0]).every((k) => k === k.toUpperCase()), 'Oracle column names are upper case')
  const c = (await items('teradata', 'EDW_PROD.CALL_DETAIL_FACT', "?$top=20&$filter=contains(CALL_TYPE,'DA') and ROAMING_FLAG eq 'N'")).json.value
  assert.ok(c.length > 0 && c.every((x) => x.CALL_TYPE === 'DATA'))
  assert.ok(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(c[0].CALL_START_TS), 'Teradata timestamps use a space')
})
await t('items: server-driven paging via @odata.nextLink / $skiptoken covers every row exactly once', async () => {
  for (const [e, table, key] of [['sql', 'dbo.FactSales', 'SalesKey'], ['oracle', 'FIN.GL_ENTRIES', 'ENTRY_ID'], ['teradata', 'EDW_PROD.CALL_DETAIL_FACT', 'CALL_ID']]) {
    const total = (await rows(e, `SELECT COUNT(*) AS n FROM ${table}`))[0].n ?? (await rows(e, `SELECT COUNT(*) AS N FROM ${table}`))[0].N
    let url = `${ds(e)}/tables/${encodeURIComponent(table)}/items?$top=100000&$select=${key}`, seen = new Set(), pages = 0
    while (url) {
      const r = await call('GET', url.replace(U, '')); assert.equal(r.status, 200)
      r.json.value.forEach((x) => seen.add(x[key])); pages++
      url = r.json['@odata.nextLink'] ?? null
      assert.ok(pages < 200)
    }
    assert.equal(seen.size, total, `${e}: paged ${seen.size} of ${total} rows in ${pages} pages`)
    assert.ok(pages > 1, `${e}: more than one page`)
  }
})
await t('nextLink uses a plain $skiptoken like the real connectors', async () => {
  const r = await items('sql', 'dbo.FactSales', '?$top=5000&$select=SalesKey')
  const link = r.json['@odata.nextLink']; assert.ok(link && /[?&]\$skiptoken=1000(&|$)/.test(link) && !/%24/.test(link), link)
})
await t('items: errors use the engine style', async () => {
  const a = await items('sql', 'dbo.NoSuchTable'); assert.equal(a.status, 404); assert.match(a.json.message, /Invalid object name 'dbo.NoSuchTable'/)
  const b = await items('oracle', 'SALES.ORDERS', '?$filter=NOPE eq 1'); assert.equal(b.status, 400); assert.match(b.json.message, /Could not find a property named 'NOPE'/)
  const c = await items('teradata', 'EDW_PROD.NOPE'); assert.match(c.json.message, /\[3807\]/)
  const d = await items('sql', 'dbo.FactSales', '?$filter=SalesKey gt'); assert.equal(d.status, 400)
  assert.equal(b.json.error.message, b.json.message); assert.ok(b.json.source)
})
await t('T-SQL dialect', async () => {
  const top = await rows('sql', "SELECT TOP 3 AssignedTo, COUNT(*) AS n FROM dbo.ServiceNowIncidents WHERE State = 'Closed' GROUP BY AssignedTo ORDER BY n DESC;")
  assert.equal(top.length, 3); assert.ok(top[0].n >= top[1].n && top[1].n >= top[2].n)
  assert.equal((await rows('sql', 'SELECT TOP (2) * FROM [dbo].[DimStore] WITH (NOLOCK)')).length, 2)
  assert.equal((await rows('sql', 'SELECT ProductKey FROM dbo.DimProduct ORDER BY ProductKey OFFSET 5 ROWS FETCH NEXT 3 ROWS ONLY')).map((r) => r.ProductKey).join(), '6,7,8')
  const y = await rows('sql', 'SELECT YEAR(OrderDate) AS y, MONTH(OrderDate) AS m, SUM(SalesAmount) AS rev FROM dbo.FactSales GROUP BY YEAR(OrderDate), MONTH(OrderDate) ORDER BY y, m')
  assert.ok(y.length >= 10 && y.every((r) => r.rev > 0 && r.y >= 2025))
  const x = await rows('sql', "SELECT ISNULL(ClosedBy, 'n/a') AS who, DATEDIFF(day, Opened, GETDATE()) AS age, LEN(Number) AS L, CAST(ResolutionTimeHrs AS int) AS h, DATEADD(day, -7, GETDATE()) AS wk FROM dbo.ServiceNowIncidents WHERE Opened >= DATEADD(day, -400, GETDATE())")
  assert.ok(x.length > 100 && x.every((r) => r.who && r.age >= 0 && r.L === 10))
  assert.ok((await rows('sql', "SELECT CONVERT(varchar(10), OrderDate, 23) AS d, COUNT(*) AS c FROM dbo.FactSales GROUP BY CONVERT(varchar(10), OrderDate, 23)")).every((r) => /^\d{4}-\d\d-\d\d$/.test(r.d)))
  const j = await rows('sql', 'SELECT TOP 5 s.Region, p.Category, SUM(f.SalesAmount) AS Sales FROM dbo.FactSales f JOIN dbo.DimStore s ON s.StoreKey = f.StoreKey JOIN dbo.DimProduct p ON p.ProductKey = f.ProductKey GROUP BY s.Region, p.Category ORDER BY Sales DESC')
  assert.equal(j.length, 5)
  const c = await rows('sql', "SELECT /* block comment */ COUNT(*) AS n -- line comment\n FROM dbo.FactSales WHERE Channel = 'In-Store'")
  assert.ok(c[0].n > 0)
  assert.equal((await rows('sql', "SELECT 'it''s [not] an \"ident\"' AS s"))[0].s, "it's [not] an \"ident\"")
  const dm = await rows('sql', "SELECT DATEADD(month, 1, '2026-01-31 10:30:00') AS a, DATEADD(year, 1, '2024-02-29') AS b, DATEADD(hour, 5, '2026-10-18 10:00:00') AS c")
  assert.equal(dm[0].a, '2026-02-28T10:30:00'); assert.match(dm[0].b, /^2025-02-28/); assert.equal(dm[0].c, '2026-10-18T15:00:00')
  const un = await rows('sql', 'SELECT COUNT(*), 1 + 1 FROM dbo.DimStore'); assert.deepEqual(Object.keys(un[0]), ['Column1', 'Column2'])
})
await t('Oracle dialect', async () => {
  assert.equal((await rows('oracle', 'SELECT * FROM HR.DEPARTMENTS FETCH FIRST 4 ROWS ONLY')).length, 4)
  assert.equal((await rows('oracle', 'SELECT * FROM HR.DEPARTMENTS WHERE ROWNUM <= 3')).length, 3)
  assert.equal((await rows('oracle', "SELECT * FROM HR.DEPARTMENTS WHERE DEPARTMENT_ID > 10 AND ROWNUM <= 2 ORDER BY DEPARTMENT_ID")).length, 2)
  const m = await rows('oracle', "SELECT TO_CHAR(ORDER_DATE, 'YYYY-MM') AS PERIOD, COUNT(*) AS N, SUM(ORDER_TOTAL) AS TOTAL FROM SALES.ORDERS GROUP BY TO_CHAR(ORDER_DATE, 'YYYY-MM') ORDER BY 1")
  assert.ok(m.length >= 10 && /^\d{4}-\d\d$/.test(m[0].PERIOD) && Object.keys(m[0]).join() === 'PERIOD,N,TOTAL')
  const d = await rows('oracle', "SELECT DECODE(STATUS, 'SHIPPED', 'S', 'DELIVERED', 'D', 'other') AS CODE, NVL(SHIP_DATE, TRUNC(SYSDATE)) AS SD, COUNT(*) AS N FROM SALES.ORDERS WHERE ORDER_DATE >= SYSDATE - 400 GROUP BY DECODE(STATUS, 'SHIPPED', 'S', 'DELIVERED', 'D', 'other'), NVL(SHIP_DATE, TRUNC(SYSDATE))")
  assert.ok(d.length > 3)
  const e = await rows('oracle', 'SELECT COUNT(*) AS N FROM DUAL, HR.DEPARTMENTS'); assert.ok(e[0].N >= 1)
  assert.equal((await rows('oracle', "SELECT 1 AS ONE FROM DUAL"))[0].ONE, 1)
  const q = await rows('oracle', 'SELECT "DEPARTMENT_NAME" FROM "HR"."DEPARTMENTS" WHERE DEPARTMENT_ID = 70'); assert.equal(q[0].DEPARTMENT_NAME, 'IT')
  const mn = await rows('oracle', 'SELECT DEPARTMENT_ID FROM HR.DEPARTMENTS MINUS SELECT DEPARTMENT_ID FROM HR.DEPARTMENTS WHERE DEPARTMENT_ID > 20'); assert.equal(mn.length, 2)
  const am = await rows('oracle', "SELECT ADD_MONTHS(TO_DATE('2026-01-31','YYYY-MM-DD'), 1) AS X, ADD_MONTHS(TO_DATE('2026-03-15','YYYY-MM-DD'), -2) AS Y FROM DUAL"); assert.equal(am[0].X, '2026-02-28'); assert.equal(am[0].Y, '2026-01-15')
  const ex = await rows('oracle', "SELECT EXTRACT(YEAR FROM ORDER_DATE) AS Y, COUNT(*) AS N FROM SALES.ORDERS GROUP BY EXTRACT(YEAR FROM ORDER_DATE)"); assert.ok(ex.length >= 2)
  assert.equal((await rows('oracle', 'SELECT EMPLOYEE_ID FROM HR.EMPLOYEES ORDER BY EMPLOYEE_ID OFFSET 2 ROWS FETCH NEXT 2 ROWS ONLY')).map((r) => r.EMPLOYEE_ID).join(), '3,4')
})
await t('Teradata dialect', async () => {
  const s = await rows('teradata', 'SEL TOP 3 CALL_TYPE, COUNT(*) AS N, SUM(REVENUE_AMT) AS REV FROM EDW_PROD.CALL_DETAIL_FACT GROUP BY 1 ORDER BY 3 DESC')
  assert.equal(s.length, 3); assert.ok(s[0].REV >= s[1].REV)
  assert.equal((await rows('teradata', 'SELECT * FROM EDW_PROD.PLAN_DIM SAMPLE 4')).length, 4)
  const qz = await rows('teradata', 'SELECT * FROM EDW_PROD.CALL_DETAIL_FACT QUALIFY ROW_NUMBER() OVER (PARTITION BY CUST_ID ORDER BY CALL_START_TS DESC) = 1')
  assert.ok(qz.length > 100 && new Set(qz.map((r) => r.CUST_ID)).size === qz.length, 'one row per customer')
  const z = await rows('teradata', "SELECT ZEROIFNULL(NULLIFZERO(0)) AS A, 7 MOD 4 AS B, CAST(CURRENT_DATE AS DATE) AS C, DATE '2026-10-01' AS D, CHAR_LENGTH('abc') AS E")
  assert.equal(z[0].A, 0); assert.equal(z[0].B, 3); assert.match(z[0].C, /^\d{4}-\d\d-\d\d$/); assert.equal(z[0].D, '2026-10-01'); assert.equal(z[0].E, 3)
  const cd = await rows('teradata', 'SELECT COUNT(*) AS N FROM EDW_PROD.CALL_DETAIL_FACT WHERE CALL_START_TS >= CURRENT_DATE - 30'); assert.ok(cd[0].N > 0)
  const j = await rows('teradata', "SELECT c.REGION, p.PLAN_CODE, COUNT(*) AS N, AVG(c.ARPU) AS ARPU FROM EDW_PROD.CUSTOMER_DIM c JOIN EDW_PROD.PLAN_DIM p ON p.PLAN_ID = c.PLAN_ID WHERE c.CHURN_FLAG = 'Y' GROUP BY c.REGION, p.PLAN_CODE ORDER BY 3 DESC")
  assert.ok(j.length > 5)
  const ext = await rows('teradata', 'SELECT EXTRACT(HOUR FROM CALL_START_TS) AS H, COUNT(*) AS N FROM EDW_PROD.CALL_DETAIL_FACT GROUP BY 1 ORDER BY 1'); assert.ok(ext.length >= 12)
})
await t('read-only and safety', async () => {
  for (const [e, sql] of [['sql', 'INSERT INTO dbo.DimStore VALUES (1,2,3,4,5,6,7)'], ['oracle', 'DELETE FROM SALES.ORDERS'], ['teradata', 'DROP TABLE EDW_PROD.PLAN_DIM'], ['sql', 'SELECT 1; DROP TABLE dbo.DimStore'], ['sql', "SELECT * FROM dbo.DimStore; UPDATE dbo.DimStore SET StoreName='x'"], ['sql', 'PRAGMA table_info(x)'], ['oracle', 'SELECT * FROM sqlite_master'], ['sql', 'WITH x AS (SELECT 1) INSERT INTO dbo.DimStore SELECT 1'], ['sql', "SELECT load_extension('x')"], ['sql', 'EXEC sp_who']]) {
    const r = await q(e, sql); assert.ok([400, 403].includes(r.status), `${e}: ${sql} -> ${r.status}`)
  }
  const still = await rows('sql', 'SELECT COUNT(*) AS n FROM dbo.DimStore'); assert.ok(still[0].n >= 12)
  assert.equal((await items('sql', 'dbo.DimStore', "?$filter=Region eq 'x'; DROP TABLE dbo.DimStore")).status, 400)
  assert.equal((await items('sql', 'dbo.DimStore', '?$orderby=Region; DROP TABLE x')).status, 400)
  assert.equal((await items('sql', 'dbo.DimStore; DROP TABLE x')).status, 404)
  const inj = await items('sql', 'dbo.DimStore', "?$filter=Region eq ''' OR 1=1 --"); assert.ok([200, 400].includes(inj.status)); if (inj.status === 200) assert.equal(inj.json.value.length, 0)
  assert.ok((await call('POST', `${ds('sql')}/query/sql`, { query: '' })).status === 400)
})
await t('engine-style error messages', async () => {
  const cases = [
    ['sql', 'SELECT * FROM dbo.Nope', /Invalid object name 'dbo\.Nope'/], ['oracle', 'SELECT * FROM NOPE.NOPE', /ORA-00942/], ['teradata', 'SELECT * FROM EDW_PROD.NOPE', /\[3807\]/],
    ['sql', 'SELECT Nope FROM dbo.DimStore', /Invalid column name 'Nope'/], ['oracle', 'SELECT NOPE FROM HR.DEPARTMENTS', /ORA-00904/], ['teradata', 'SELECT NOPE FROM EDW_PROD.PLAN_DIM', /\[5628\]/],
    ['sql', 'SELECT FROM dbo.DimStore', /Msg 102/], ['oracle', 'SELECT FROM HR.DEPARTMENTS', /ORA-00933/], ['teradata', 'SEL FROM EDW_PROD.PLAN_DIM', /\[3706\]/],
    ['sql', 'SELECT NOFUNC(1)', /not a recognized built-in function/], ['sql', 'INSERT INTO dbo.DimStore VALUES (1)', /permission was denied/], ['oracle', 'UPDATE HR.EMPLOYEES SET SALARY=1', /ORA-01031/],
  ]
  for (const [e, sql, re] of cases) { const r = await q(e, sql); assert.match(r.json?.message ?? '', re, `${e}: ${sql} -> ${r.status} ${r.json?.message}`); assert.ok(r.status >= 400) }
})
await t('CORS and metadata', async () => {
  const o = await fetch(U + `${ds('sql')}/tables`, { method: 'OPTIONS' }); assert.equal(o.status, 204); assert.equal(o.headers.get('access-control-allow-origin'), '*')
  const g = await call('GET', `${ds('sql')}/tables`); assert.equal(g.headers.get('access-control-allow-origin'), '*')
  assert.match(await (await fetch(U + '/')).text(), /DB emulator/)
})

const as = (user) => ({ 'x-user': user })
const raw = async (method, p, body, headers = {}) => { const r = await fetch(U + p, { method, headers, body }); return { status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) } }
await t('files: folder, metadata, content, ETag / 304, write, delete', async () => {
  const list = (await call('GET', '/files/folder?path=/')).json.value
  assert.ok(list.some((f) => f.Name === 'sample-sales.csv') && list.some((f) => f.Name === 'sample-sales.xlsx'), 'seed files: ' + list.map((f) => f.Name))
  const meta = (await call('GET', '/files/metadata?path=sample-sales.csv')).json
  assert.ok(meta.ETag && meta.Size > 100 && /^\d{4}-\d\d-\d\dT/.test(meta.LastModified) && meta.Path === '/sample-sales.csv')
  const got = await raw('GET', '/files/content?path=sample-sales.csv')
  assert.equal(got.status, 200); assert.equal(got.headers.get('etag'), meta.ETag); assert.match(got.buf.toString(), /^Date,Region,Product,Units,Revenue/)
  assert.equal((await raw('GET', '/files/content?path=sample-sales.csv', undefined, { 'if-none-match': meta.ETag })).status, 304)
  const put = await raw('PUT', '/files/content?path=reports/q4.csv', 'a,b\n1,2\n3,4\n'); assert.equal(put.status, 200)
  const m2 = (await call('GET', '/files/metadata?path=reports/q4.csv')).json; assert.equal(m2.Size, 12)
  await new Promise((r) => setTimeout(r, 20))
  await raw('PUT', '/files/content?path=reports/q4.csv', 'a,b\n1,2\n3,4\n5,6\n')
  const m3 = (await call('GET', '/files/metadata?path=reports/q4.csv')).json; assert.notEqual(m3.ETag, m2.ETag, 'ETag changes when the file changes')
  assert.equal((await raw('GET', '/files/content?path=reports/q4.csv', undefined, { 'if-none-match': m2.ETag })).status, 200, 'old ETag no longer matches')
  assert.ok((await call('GET', '/files/folder?path=reports')).json.value.some((f) => f.Name === 'q4.csv'))
  assert.equal((await raw('DELETE', '/files/content?path=reports/q4.csv')).status, 200)
  assert.equal((await call('GET', '/files/metadata?path=reports/q4.csv')).status, 404)
})
await t('files: traversal, bad type and oversize are refused', async () => {
  for (const p of ['../package.json', '..%2Fpackage.json', '%2e%2e/%2e%2e/etc/passwd', 'a/../../x', '/etc/passwd', 'x%00.csv']) {
    const r = await call('GET', `/files/content?path=${p}`); assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`)
    if (r.status === 200) assert.fail(p)
  }
  assert.equal((await raw('PUT', '/files/content?path=evil.exe', 'x')).status, 400)
  assert.equal((await raw('PUT', '/files/content?path=../escape.csv', 'x')).status, 400)
  assert.equal((await raw('PUT', '/files/content?path=big.csv', Buffer.alloc(26 * 1024 * 1024, 97))).status, 413)
  assert.ok(!fs.existsSync(path.join(dir, 'escape.csv')))
})
await t('shares: create, visibility, permissions, versions, everyone, delete', async () => {
  const body = { name: 'Team SLA', definition: { widgets: [1, 2], source: { kind: 'db' } }, sharedWith: [{ user: 'Bob@Example.com', permission: 'view' }, { user: 'carol@example.com', permission: 'edit' }, { user: 'alice@example.com', permission: 'edit' }], everyone: 'none' }
  const c = await call('POST', '/shares', body, as('alice@example.com')); assert.equal(c.status, 201)
  const id = c.json.id; assert.equal(c.json.owner, 'alice@example.com'); assert.equal(c.json.version, 1); assert.equal(c.json.permission, 'owner')
  assert.deepEqual(c.json.sharedWith.map((x) => x.user), ['bob@example.com', 'carol@example.com'], 'emails normalised, owner not listed')
  const lst = async (u) => (await call('GET', '/shares', undefined, as(u))).json.value
  assert.equal((await lst('alice@example.com'))[0].sharedWith.length, 2)
  const bob = (await lst('bob@example.com')).find((x) => x.id === id); assert.equal(bob.permission, 'view'); assert.equal(bob.sharedWith, undefined, 'only the owner sees who else has access')
  assert.equal((await lst('carol@example.com')).find((x) => x.id === id).permission, 'edit')
  assert.equal((await lst('dave@example.com')).length, 0); assert.equal((await call('GET', `/shares/${id}`, undefined, as('dave@example.com'))).status, 404)
  assert.deepEqual((await call('GET', `/shares/${id}`, undefined, as('bob@example.com'))).json.definition.widgets, [1, 2])
  assert.equal((await call('PUT', `/shares/${id}`, { definition: { widgets: [] }, baseVersion: 1 }, as('bob@example.com'))).status, 403, 'viewer cannot change')
  const e1 = await call('PUT', `/shares/${id}`, { definition: { widgets: [1, 2, 3], source: { kind: 'db' } }, baseVersion: 1 }, as('carol@example.com')); assert.equal(e1.status, 200); assert.equal(e1.json.version, 2); assert.equal(e1.json.updatedBy, 'carol@example.com')
  const stale = await call('PUT', `/shares/${id}`, { definition: { widgets: [9] }, baseVersion: 1 }, as('alice@example.com')); assert.equal(stale.status, 409); assert.match(stale.json.message, /Version conflict/)
  assert.equal((await call('PUT', `/shares/${id}`, { everyone: 'view' }, as('carol@example.com'))).status, 403, 'editor cannot change sharing')
  assert.equal((await call('PUT', `/shares/${id}`, { everyone: 'view' }, as('alice@example.com'))).status, 200)
  const dave = (await lst('dave@example.com')).find((x) => x.id === id); assert.equal(dave.permission, 'view', '"everyone" gives view')
  assert.equal((await call('PUT', `/shares/${id}`, { sharedWith: [{ user: 'bob@example.com', permission: 'edit' }] }, as('alice@example.com'))).json.sharedWith[0].permission, 'edit')
  assert.equal((await call('DELETE', `/shares/${id}`, undefined, as('bob@example.com'))).status, 403)
  assert.equal((await call('DELETE', `/shares/${id}`, undefined, as('alice@example.com'))).status, 200)
  assert.equal((await lst('bob@example.com')).length, 0); assert.equal((await lst('dave@example.com')).length, 0)
})
await t('shares: validation, identity and snapshot limits', async () => {
  assert.equal((await call('GET', '/shares')).status, 401); assert.equal((await call('GET', '/shares', undefined, as('not-an-email'))).status, 401)
  const a = as('alice@example.com')
  assert.equal((await call('POST', '/shares', { name: '', definition: {} }, a)).status, 400)
  assert.equal((await call('POST', '/shares', { name: 'x'.repeat(121), definition: {} }, a)).status, 400)
  assert.equal((await call('POST', '/shares', { name: 'x', definition: {}, sharedWith: [{ user: 'nope', permission: 'view' }] }, a)).status, 400)
  assert.equal((await call('POST', '/shares', { name: 'x', definition: {}, sharedWith: [{ user: 'a@b.co', permission: 'admin' }] }, a)).status, 400)
  assert.equal((await call('POST', '/shares', { name: 'x', definition: {}, everyone: 'all' }, a)).status, 400)
  const snap = await call('POST', '/shares', { name: 'snap', definition: { source: { kind: 'file' } }, snapshot: { columns: [{ name: 'a' }], rows: [{ a: 1 }, { a: 2 }] } }, a); assert.equal(snap.status, 201); assert.equal(snap.json.hasSnapshot, true)
  assert.equal((await call('GET', `/shares/${snap.json.id}`, undefined, a)).json.snapshot.rows.length, 2)
  const big = await call('POST', '/shares', { name: 'big', definition: {}, snapshot: { s: 'x'.repeat(13 * 1024 * 1024) } }, a); assert.equal(big.status, 413)
  await call('DELETE', `/shares/${snap.json.id}`, undefined, a)
  assert.equal((await call('POST', '/shares', '{bad', a)).status, 400)
})
emu.close()

// ---- separate instances: timeout, api key, live writer ----
await t('runaway query is stopped by the timeout and the server stays usable', async () => {
  const e2 = await startEmulator({ ...base, timeout: 400 })
  const u = `http://127.0.0.1:${e2.port}`
  const r = await fetch(u + `/sql/datasets/${encodeURIComponent(DS.sql)}/query/sql`, { method: 'POST', body: JSON.stringify({ query: 'SELECT COUNT(*) AS n FROM dbo.FactSales a, dbo.FactSales b, dbo.FactSales c' }) })
  assert.equal(r.status, 408); assert.match((await r.json()).message, /Timeout Expired/)
  const ok = await fetch(u + `/sql/datasets/${encodeURIComponent(DS.sql)}/query/sql`, { method: 'POST', body: JSON.stringify({ query: 'SELECT COUNT(*) AS n FROM dbo.DimStore' }) }); assert.equal(ok.status, 200)
  const o = await fetch(u + `/oracle/datasets/${encodeURIComponent(DS.oracle)}/query/sql`, { method: 'POST', body: JSON.stringify({ query: 'SELECT COUNT(*) FROM SALES.ORDERS a, SALES.ORDERS b, SALES.ORDERS c' }) }); assert.match((await o.json()).message, /ORA-01013/)
  e2.close()
})
await t('feed: sales-feed.csv keeps growing like an upstream export', async () => {
  const e2 = await startEmulator({ ...base, feed: true, feedSec: 0.4 })
  const u = `http://127.0.0.1:${e2.port}`
  const meta = async () => (await (await fetch(u + '/files/metadata?path=sales-feed.csv')).json())
  const m1 = await meta(); await new Promise((r) => setTimeout(r, 1700)); const m2 = await meta()
  assert.ok(m2.Size > m1.Size && m2.ETag !== m1.ETag, `${m1.Size} -> ${m2.Size}`)
  const text = await (await fetch(u + '/files/content?path=sales-feed.csv')).text(); assert.ok(text.split('\n').length > 500)
  assert.ok((await (await fetch(u + '/health')).json()).files.feed.appended >= 5)
  e2.close()
})
await t('optional API key', async () => {
  const e2 = await startEmulator({ ...base, apiKey: 'secret' })
  const u = `http://127.0.0.1:${e2.port}`
  assert.equal((await fetch(u + '/sql/datasets')).status, 401)
  assert.equal((await fetch(u + '/sql/datasets', { headers: { 'x-api-key': 'secret' } })).status, 200)
  assert.equal((await fetch(u + '/sql/datasets', { headers: { authorization: 'Bearer secret' } })).status, 200)
  assert.equal((await fetch(u + '/files/folder?path=/')).status, 401); assert.equal((await fetch(u + '/shares', { headers: { 'x-user': 'a@b.co' } })).status, 401)
  assert.equal((await fetch(u + '/shares', { headers: { 'x-user': 'a@b.co', 'x-api-key': 'secret' } })).status, 200)
  assert.equal((await fetch(u + '/health')).status, 200)
  e2.close()
})
await t('live writer: rows keep arriving and incidents progress', async () => {
  const e2 = await startEmulator({ ...base, live: true, liveRate: 6 })
  const u = `http://127.0.0.1:${e2.port}`
  const count = async (e, sql) => (await (await fetch(u + `/${e}/datasets/${encodeURIComponent(DS[e])}/query/sql`, { method: 'POST', body: JSON.stringify({ query: sql }) })).json()).ResultSets.Table1[0]
  const b = { s: (await count('sql', 'SELECT COUNT(*) AS n FROM dbo.FactSales')).n, o: (await count('oracle', 'SELECT COUNT(*) AS N FROM SALES.ORDERS')).N, c: (await count('teradata', 'SELECT COUNT(*) AS N FROM EDW_PROD.CALL_DETAIL_FACT')).N, closed: (await count('sql', "SELECT COUNT(*) AS n FROM dbo.ServiceNowIncidents WHERE State='Closed'")).n }
  await new Promise((r) => setTimeout(r, 3500))
  const a = { s: (await count('sql', 'SELECT COUNT(*) AS n FROM dbo.FactSales')).n, o: (await count('oracle', 'SELECT COUNT(*) AS N FROM SALES.ORDERS')).N, c: (await count('teradata', 'SELECT COUNT(*) AS N FROM EDW_PROD.CALL_DETAIL_FACT')).N, closed: (await count('sql', "SELECT COUNT(*) AS n FROM dbo.ServiceNowIncidents WHERE State='Closed'")).n }
  assert.ok(a.s > b.s && a.o > b.o && a.c > b.c, JSON.stringify({ b, a }))
  assert.ok(a.closed >= b.closed)
  const h = await (await fetch(u + '/admin/live')).json(); assert.ok(h.running && h.ticks >= 2 && !h.error, JSON.stringify(h))
  await fetch(u + '/admin/live', { method: 'POST', body: JSON.stringify({ action: 'pause' }) })
  const p1 = (await count('sql', 'SELECT COUNT(*) AS n FROM dbo.FactSales')).n; await new Promise((r) => setTimeout(r, 2200)); assert.equal((await count('sql', 'SELECT COUNT(*) AS n FROM dbo.FactSales')).n, p1, 'paused')
  e2.close()
})
console.log(failed ? `${failed} FAILED, ${passed} passed` : `ALL ${passed} EMULATOR TESTS PASSED`)
fs.rmSync(dir, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
