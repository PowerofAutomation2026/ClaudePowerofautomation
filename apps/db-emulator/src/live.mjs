/** Live "OLTP" writer: keeps inserting / updating rows so dashboards with auto-refresh have something to show. */
import { Rng, ts, dt, DAY, round } from '../seed/common.mjs'
import { makeIncident } from '../seed/sqlserver.mjs'
import { makeOrder, makeGl, ORDER_STATUSES } from '../seed/oracle.mjs'
import { makeCall } from '../seed/teradata.mjs'
import { openWritable } from '../seed/common.mjs'

export class LiveWriter {
  constructor(engines, { rate = 1, seed = 99 } = {}) {
    this.engines = engines; this.rate = rate; this.r = new Rng(seed); this.running = false; this.timer = null
    this.stats = { ticks: 0, inserted: 0, updated: 0, lastTick: null }
    this.rw = {}
    this.next = {}
  }
  init() {
    for (const e of Object.values(this.engines)) {
      const db = openWritable(e.path)
      this.rw[e.id] = db
    }
    const mx = (id, table, col) => this.rw[id].prepare(`SELECT COALESCE(MAX("${col}"),0) m FROM "${table}"`).get().m
    this.next = {
      sales: mx('sql', 'dbo__FactSales', 'SalesKey') + 1,
      inc: this.rw.sql.prepare('SELECT COUNT(*) c FROM "dbo__ServiceNowIncidents"').get().c,
      order: mx('oracle', 'SALES__ORDERS', 'ORDER_ID') + 1,
      gl: mx('oracle', 'FIN__GL_ENTRIES', 'ENTRY_ID') + 1,
      call: mx('teradata', 'EDW_PROD__CALL_DETAIL_FACT', 'CALL_ID') + 1,
    }
    const one = (id, sql) => this.rw[id].prepare(sql).get()
    this.ctx = {
      sql: { nCust: one('sql', 'SELECT COUNT(*) c FROM dbo__DimCustomer').c, nProd: one('sql', 'SELECT COUNT(*) c FROM dbo__DimProduct').c, nStore: one('sql', 'SELECT COUNT(*) c FROM dbo__DimStore').c },
      oracle: { nCust: one('oracle', 'SELECT COUNT(*) c FROM SALES__CUSTOMERS').c, nEmp: one('oracle', 'SELECT COUNT(*) c FROM HR__EMPLOYEES').c, reps: this.rw.oracle.prepare("SELECT EMPLOYEE_ID id FROM HR__EMPLOYEES WHERE DEPARTMENT_ID BETWEEN 40 AND 42").all().map((x) => x.id) },
      teradata: { nCust: one('teradata', 'SELECT COUNT(*) c FROM EDW_PROD__CUSTOMER_DIM').c, nTower: one('teradata', 'SELECT COUNT(*) c FROM EDW_PROD__TOWER_DIM').c },
    }
    if (!this.ctx.oracle.reps.length) this.ctx.oracle.reps = [1]
    return this
  }
  start() { if (this.running) return; this.running = true; this.timer = setInterval(() => this.tick(), 1000); this.timer.unref?.() }
  stop() { this.running = false; clearInterval(this.timer) }
  poisson(mean) { const L = Math.exp(-mean); let k = 0, p = 1; do { k++; p *= this.r.next() } while (p > L); return k - 1 }

  tick() {
    const now = Date.now(), r = this.r, k = this.rate
    try {
      // SQL Server: sales + incident flow
      { const db = this.rw.sql, c = this.ctx.sql
        db.exec('BEGIN')
        const sale = db.prepare('INSERT INTO dbo__FactSales VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        for (let i = this.poisson(5 * k); i > 0; i--) {
          const pi = r.zipf(c.nProd) + 1, st = r.int(1, c.nStore), qty = r.weighted([1, 2, 3, 4], [55, 25, 12, 8]), disc = r.weighted([0, 5, 10, 20], [65, 15, 12, 8])
          const unit = round(20 + r.zipf(300) * 1.3), online = st <= 4
          sale.run(this.next.sales++, ts(now), st, pi, r.int(1, c.nCust), online ? 'Web' : 'In-Store', qty, unit, disc, round(qty * unit * (1 - disc / 100)), round(qty * unit * .6))
          this.stats.inserted++
        }
        const inc = db.prepare(`INSERT INTO dbo__ServiceNowIncidents VALUES (${'?,'.repeat(25)}?)`)
        for (let i = this.poisson(0.8 * k); i > 0; i--) { inc.run(...makeIncident(r, this.next.inc++, now, now)); this.stats.inserted++ }
        // progress open incidents: In Progress/New/On Hold -> Resolved ; Resolved -> Closed
        const open = db.prepare("SELECT rowid rid, Opened, AssignedTo, SLATargetHrs t FROM dbo__ServiceNowIncidents WHERE State IN ('New','In Progress','On Hold') ORDER BY Opened LIMIT 40").all()
        for (const o of open.filter(() => r.next() < .22 * k)) {
          const hrs = Math.max(.1, round((now - Date.parse(o.Opened.replace(' ', 'T') + 'Z')) / 3600000))
          db.prepare("UPDATE dbo__ServiceNowIncidents SET State='Resolved', Resolved=?, ResolutionTimeHrs=?, MadeSLA=?, SLAElapsedPct=?, CloseCode='Solved (Permanently)' WHERE rowid=?").run(ts(now), hrs, hrs <= o.t ? 1 : 0, round(hrs / o.t * 100, 1), o.rid)
          this.stats.updated++
        }
        const res = db.prepare("SELECT rowid rid, AssignedTo FROM dbo__ServiceNowIncidents WHERE State='Resolved' ORDER BY Resolved LIMIT 30").all()
        for (const o of res.filter(() => r.next() < .3 * k)) { db.prepare("UPDATE dbo__ServiceNowIncidents SET State='Closed', Closed=?, ClosedBy=?, ClosedCount=1 WHERE rowid=?").run(ts(now), o.AssignedTo, o.rid); this.stats.updated++ }
        db.exec('COMMIT') }

      // Oracle: orders + GL
      { const db = this.rw.oracle, c = this.ctx.oracle
        db.exec('BEGIN')
        const ord = db.prepare('INSERT INTO SALES__ORDERS VALUES (?,?,?,?,?,?,?,?,?,?)')
        for (let i = this.poisson(3 * k); i > 0; i--) { ord.run(...makeOrder(r, this.next.order++, now, c, now)); this.stats.inserted++ }
        const gl = db.prepare('INSERT INTO FIN__GL_ENTRIES VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        for (let i = this.poisson(5 * k); i > 0; i--) { gl.run(...makeGl(r, this.next.gl++, now, c.nEmp)); this.stats.inserted++ }
        const flow = { PENDING: 'PROCESSING', PROCESSING: 'SHIPPED', SHIPPED: 'DELIVERED' }
        for (const [from, to] of Object.entries(flow)) {
          const rows = db.prepare('SELECT rowid rid FROM SALES__ORDERS WHERE STATUS=? ORDER BY ORDER_DATE LIMIT 20').all(from)
          for (const o of rows.filter(() => r.next() < .25 * k)) { db.prepare('UPDATE SALES__ORDERS SET STATUS=?, SHIP_DATE=COALESCE(SHIP_DATE, ?) WHERE rowid=?').run(to, to === 'SHIPPED' ? ts(now) : null, o.rid); this.stats.updated++ }
        }
        db.exec('COMMIT') }

      // Teradata: call detail records
      { const db = this.rw.teradata, c = this.ctx.teradata
        db.exec('BEGIN')
        const call = db.prepare(`INSERT INTO EDW_PROD__CALL_DETAIL_FACT VALUES (${'?,'.repeat(10)}?)`)
        for (let i = this.poisson(15 * k); i > 0; i--) { call.run(...makeCall(r, this.next.call++, now - r.int(0, 900) * 1000, c)); this.stats.inserted++ }
        db.exec('COMMIT') }
      this.stats.ticks++; this.stats.lastTick = new Date().toISOString()
    } catch (e) { this.stats.error = String(e.message ?? e); for (const db of Object.values(this.rw)) { try { db.exec('ROLLBACK') } catch { /* no open transaction */ } } }
  }
}
