#!/usr/bin/env node
/**
 * DB emulator: simulated SQL Server, Oracle and Teradata servers with big datasets, exposed through REST endpoints
 * shaped like the Power Platform connectors (tables, OData items with $filter/$orderby/$select/$top/$skiptoken,
 * and "execute SQL"). For testing dashboards; not a real database engine.
 *
 *   node src/server.mjs [--port 3200] [--size small|standard|big|<n>] [--no-live] [--live-rate 1] [--reseed]
 *                       [--data ./data] [--host 127.0.0.1] [--page-size 1000] [--timeout 20000] [--api-key KEY]
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Engine, ENGINE_DEFS } from './engines.mjs'
import { translate, engineError, SqlError } from './dialect.mjs'
import { filterToSql, orderToSql, selectToSql, ODataError } from './odata.mjs'
import { QueryPool } from './pool.mjs'
import { LiveWriter } from './live.mjs'
import { freshDb, SIZES } from '../seed/common.mjs'
import { seedSqlServer } from '../seed/sqlserver.mjs'
import { seedOracle } from '../seed/oracle.mjs'
import { seedTeradata } from '../seed/teradata.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

export function parseArgs(argv) {
  const o = { port: 3200, host: '127.0.0.1', data: path.join(here, '..', 'data'), size: 'standard', live: true, liveRate: 1, reseed: false, seedOnly: false, pageSize: 1000, timeout: 20000, apiKey: '', quiet: false, seed: 20261018 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i]
    if (a === '--port') o.port = Number(v()); else if (a === '--host') o.host = v(); else if (a === '--data') o.data = path.resolve(v())
    else if (a === '--size') o.size = v(); else if (a === '--no-live') o.live = false; else if (a === '--live-rate') o.liveRate = Number(v())
    else if (a === '--reseed') o.reseed = true; else if (a === '--seed-only') o.seedOnly = true; else if (a === '--page-size') o.pageSize = Number(v())
    else if (a === '--timeout') o.timeout = Number(v()); else if (a === '--api-key') o.apiKey = v(); else if (a === '--quiet') o.quiet = true; else if (a === '--seed') o.seed = Number(v())
  }
  return o
}
const scaleOf = (size) => (SIZES[size] ?? (Number.isFinite(Number(size)) && Number(size) > 0 ? Number(size) : 1))

export async function startEmulator(opts) {
  const log = opts.quiet ? () => {} : (m) => console.log(m)
  fs.mkdirSync(opts.data, { recursive: true })
  const engines = {}
  for (const def of Object.values(ENGINE_DEFS)) engines[def.id] = new Engine(def, opts.data)
  const scale = scaleOf(opts.size)
  const seeders = { sql: seedSqlServer, oracle: seedOracle, teradata: seedTeradata }
  for (const e of Object.values(engines)) {
    if (e.exists() && !opts.reseed) continue
    const t0 = Date.now()
    log(`Seeding ${e.label} (${opts.size}, scale ${scale})...`)
    const db = freshDb(e.path)
    let lastLine = 0
    const counts = seeders[e.id](db, scale, opts.seed, (m) => { if (Date.now() - lastLine > 1500) { lastLine = Date.now(); log('  ' + m) } })
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close()
    log(`  ${e.label} ready in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${Object.entries(counts).filter(([k]) => !k.startsWith('_')).map(([k, v]) => `${k} ${v.toLocaleString()}`).join(', ')}`)
  }
  if (opts.seedOnly) return { engines, close() {} }
  for (const e of Object.values(engines)) e.open()
  const pool = new QueryPool(2, opts.timeout)
  const live = opts.live ? new LiveWriter(engines, { rate: opts.liveRate, seed: opts.seed + 7 }).init() : null
  live?.start()

  const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-private-network': 'true', 'access-control-expose-headers': '*' }
  const send = (res, code, body, extra = {}) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS, ...extra }); res.end(JSON.stringify(body)) }
  const fail = (res, e, status, number, message) => send(res, status, { status, message, error: { message, code: number }, source: `emulator-${e?.id ?? 'server'}` })
  const readBody = (req) => new Promise((resolve, reject) => { const c = []; let n = 0; req.on('data', (b) => { n += b.length; if (n > 1e6) { reject(new Error('body too large')); req.destroy() } else c.push(b) }); req.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); req.on('error', reject) })

  const shapeValue = (e, v) => {
    if (typeof v === 'string' && e.dateT && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) return v.replace(' ', 'T')
    return v
  }
  const shapeRow = (e, row, cols) => {
    const o = {}
    let i = 0
    for (const [k, v] of Object.entries(row)) {
      const type = cols?.get(k)
      let val = shapeValue(e, v)
      if (type === 'BIT' && val !== null) val = !!val
      if (type === 'DATE' && e.oracleDates && typeof val === 'string' && val.length === 10) val += 'T00:00:00'
      let key = k
      if (/^(count|sum|avg|min|max|total|round|ifnull|iif|cast|coalesce|strftime|date|datetime|length|lower|upper|substr|case|\()/i.test(k) || /[()* ]/.test(k)) key = e.id === 'oracle' ? k.toUpperCase() : `Column${++i}`
      o[key] = val
    }
    return o
  }
  const upperKeys = (e, row) => (e.id === 'oracle' ? Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toUpperCase(), v])) : row)

  const run = async (e, sql, params, cap) => {
    try { return await pool.run(e.path, sql, params, cap) }
    catch (err) {
      if (err.timeout) { const m = e.id === 'sql' ? 'Execution Timeout Expired. The timeout period elapsed prior to completion of the operation.' : e.id === 'oracle' ? 'ORA-01013: user requested cancel of current operation (timeout)' : '[Teradata Database] [2631] Transaction ABORTed due to a time limit.'; const x = new Error(m); x.engineMessage = { status: 408, number: 0, message: m }; throw x }
      throw err
    }
  }
  const handleErr = (res, e, err) => {
    const m = err.engineMessage ?? (err instanceof ODataError ? { status: 400, number: 0, message: err.message } : engineError(e, err))
    fail(res, e, m.status, m.number, m.message)
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      const p = url.pathname.replace(/\/+$/, '') || '/'
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end() }
      if (p === '/health') {
        return send(res, 200, {
          ok: true, name: 'db-emulator', version: '1.0.0', size: opts.size, pageSize: opts.pageSize, apiKeyRequired: !!opts.apiKey,
          live: live ? { running: live.running, rate: live.rate, ...live.stats } : null,
          engines: Object.values(engines).map((e) => ({ id: e.id, label: e.label, dialect: e.dialect, connector: e.connector, dataset: e.dataset, tables: [...e.tables.values()].map((t) => ({ name: e.display(t.schema, t.name), rows: e.count(t), columns: t.cols.length })) })),
        })
      }
      if (p === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...CORS }); return res.end(statusPage(engines, opts)) }
      if (opts.apiKey && (p.startsWith('/sql') || p.startsWith('/oracle') || p.startsWith('/teradata') || p.startsWith('/admin'))) {
        const k = req.headers['x-api-key'] ?? String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
        if (k !== opts.apiKey) return fail(res, null, 401, 0, 'Missing or wrong API key (x-api-key header).')
      }
      if (p === '/admin/live') {
        if (!live) return send(res, 200, { running: false, enabled: false })
        if (req.method === 'POST') { const b = JSON.parse((await readBody(req)) || '{}'); if (b.action === 'pause') live.stop(); if (b.action === 'resume') live.start(); if (typeof b.rate === 'number' && b.rate >= 0 && b.rate <= 50) live.rate = b.rate }
        return send(res, 200, { running: live.running, rate: live.rate, ...live.stats })
      }
      const m = /^\/(sql|oracle|teradata)(?:\/(.*))?$/.exec(p)
      if (!m) return fail(res, null, 404, 0, 'Not found')
      const e = engines[m[1]]
      const rest = (m[2] ?? '').split('/').filter(Boolean)
      // /{engine}/datasets
      if (rest[0] === 'datasets' && rest.length === 1) return send(res, 200, { value: [{ Name: e.dataset, DisplayName: e.dataset }] })
      if (rest[0] !== 'datasets' || rest.length < 3) return fail(res, e, 404, 0, 'Not found')
      const dataset = decodeURIComponent(rest[1])
      if (dataset.toLowerCase() !== e.dataset.toLowerCase()) return fail(res, e, 404, 0, e.id === 'sql' ? `Cannot open database "${dataset}" requested by the login.` : `Unknown dataset '${dataset}'. Use '${e.dataset}'.`)
      // tables list
      if (rest[2] === 'tables' && rest.length === 3) return send(res, 200, { value: e.listTables() })
      // table metadata + items
      if (rest[2] === 'tables' && rest.length >= 4) {
        const t = e.tableFromPath(rest[3])
        if (!t) { const m2 = engineError(e, new SqlError(e.id, 'no-table', decodeURIComponent(rest[3]))); return fail(res, e, 404, m2.number, m2.message) }
        if (rest.length === 4) return send(res, 200, { Name: e.display(t.schema, t.name), Columns: t.cols.map(([n, ty]) => ({ name: n, type: ty })), RowCount: e.count(t) })
        if (rest[4] === 'items' && rest.length === 5 && req.method === 'GET') {
          const colNames = t.cols.map((c) => c[0])
          const q = url.searchParams
          const select = q.get('$select') ? selectToSql(q.get('$select'), colNames) : '*'
          const where = q.get('$filter') ? filterToSql(q.get('$filter'), colNames) : { sql: '', params: [] }
          const order = q.get('$orderby') ? orderToSql(q.get('$orderby'), colNames) : 'rowid'
          const cap = Math.min(5000, opts.pageSize, Number(req.headers['x-page-size'] ?? 1e9) || 1e9)
          const top = q.get('$top') !== null ? Math.max(0, Math.min(Number(q.get('$top')) || 0, 1e7)) : cap
          const skip = q.get('$skiptoken') !== null ? Math.max(0, parseInt(q.get('$skiptoken'), 10) || 0) : Math.max(0, parseInt(q.get('$skip') ?? '0', 10) || 0)
          const page = Math.min(top, cap)
          const sql = `SELECT ${select} FROM "${t.internal}"${where.sql ? ' WHERE ' + where.sql : ''} ORDER BY ${order} LIMIT ${page + 1} OFFSET ${skip}`
          const r = await run(e, sql, where.params, page + 1)
          const more = r.rows.length > page && top > page
          const colTypes = new Map(t.cols)
          const value = r.rows.slice(0, page).map((row) => shapeRow(e, row, colTypes))
          const body = { value }
          if (more) {
            const next = [...q.entries()].filter(([k]) => k !== '$skiptoken' && k !== '$skip')
            next.push(['$skiptoken', String(skip + page)])
            body['@odata.nextLink'] = `http://${req.headers.host}${url.pathname}?${next.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`   // plain $ like the real connectors
          }
          return send(res, 200, body)
        }
        return fail(res, e, 404, 0, 'Not found')
      }
      // execute SQL
      if (rest[2] === 'query' && rest[3] === 'sql' && req.method === 'POST') {
        let body; try { body = JSON.parse((await readBody(req)) || '{}') } catch { return fail(res, e, 400, 0, 'Invalid JSON body') }
        let sql
        try { sql = translate(body.query ?? body.sql ?? body.statement, e) } catch (err) { return handleErr(res, e, err) }
        const t0 = Date.now()
        const CAP = 100000
        const r = await run(e, sql, [], CAP)
        const rows = r.rows.map((row) => upperKeys(e, shapeRow(e, row, null)))
        return send(res, 200, { ResultSets: { Table1: rows }, OutputParameters: {}, ReturnCode: 0, Truncated: r.truncated, ElapsedMs: Date.now() - t0 }, r.truncated ? { 'x-emulator-truncated': 'true' } : {})
      }
      return fail(res, e, 404, 0, 'Not found')
    } catch (err) {
      const eng = /^\/(sql|oracle|teradata)/.exec(req.url ?? '')?.[1]
      handleErr(res, engines[eng] ?? { id: 'sql' }, err)
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(opts.port, opts.host, resolve) })
  const port = server.address().port
  log(`\nDB emulator listening on http://${opts.host === '0.0.0.0' ? 'localhost' : opts.host}:${port}   (live data: ${live ? 'on' : 'off'})`)
  log('  /sql/datasets/emulator,SalesDW/tables   /oracle/datasets/EMULATOR%2FERPPROD/tables   /teradata/datasets/emulator%2FEDW_PROD/tables')
  return { port, server, engines, live, pool, close() { live?.stop(); pool.close(); server.close(); for (const e of Object.values(engines)) try { e.ro?.close() } catch { /* ignore */ } for (const db of Object.values(live?.rw ?? {})) try { db.close() } catch { /* ignore */ } } }
}

function statusPage(engines, opts) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
  const ex = { sql: 'SELECT TOP 10 AssignedTo, COUNT(*) AS n FROM dbo.ServiceNowIncidents WHERE State = \'Closed\' GROUP BY AssignedTo ORDER BY n DESC', oracle: 'SELECT STATUS, COUNT(*) AS N, SUM(ORDER_TOTAL) AS TOTAL FROM SALES.ORDERS GROUP BY STATUS FETCH FIRST 10 ROWS ONLY', teradata: 'SEL TOP 10 CALL_TYPE, COUNT(*) AS N, SUM(REVENUE_AMT) AS REV FROM EDW_PROD.CALL_DETAIL_FACT GROUP BY 1 ORDER BY 3 DESC' }
  return `<!doctype html><meta charset="utf-8"><title>DB emulator</title><style>body{font:15px system-ui;max-width:860px;margin:30px auto;padding:0 16px;color:#1d2330}code,pre{background:#f1f0ec;padding:2px 6px;border-radius:5px}pre{padding:10px;overflow:auto}h2{margin-top:26px}</style>
<h1>DB emulator</h1><p>Simulated SQL Server, Oracle and Teradata for testing dashboards (not real engines). Live data: ${opts.live ? 'on' : 'off'}. <a href="/health">/health</a></p>
${Object.values(engines).map((e) => `<h2>${esc(e.label)}</h2><p>Dataset: <code>${esc(e.dataset)}</code> · dialect: ${esc(e.dialect)}<br>Tables: ${[...e.tables.values()].map((t) => `<code>${esc(e.display(t.schema, t.name))}</code>`).join(' ')}</p><pre>POST /${e.id}/datasets/${encodeURIComponent(e.dataset)}/query/sql\n{"query": "${esc(ex[e.id]).replace(/"/g, '\\"')}"}</pre>`).join('')}</html>`
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.mjs')) {
  const opts = parseArgs(process.argv.slice(2))
  startEmulator(opts).then((h) => { if (opts.seedOnly) { console.log('Seeding done.'); process.exit(0) } }).catch((e) => { console.error('Failed to start:', e.message); process.exit(1) })
}
