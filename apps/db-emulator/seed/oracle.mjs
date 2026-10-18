/** Oracle "ERPPROD": SALES.ORDERS / SALES.CUSTOMERS, HR.EMPLOYEES / HR.DEPARTMENTS, FIN.GL_ENTRIES. Upper-case names like a real Oracle schema. */
import { Rng, defineTable, addIndexes, bulkInsert, ts, dt, DAY, round } from './common.mjs'

const DEPTS = [[10, 'Executive'], [20, 'Finance'], [30, 'Human Resources'], [40, 'Sales - EMEA'], [41, 'Sales - Americas'], [42, 'Sales - APAC'], [50, 'Operations'], [60, 'Procurement'], [70, 'IT'], [80, 'Customer Support'], [90, 'Marketing'], [100, 'Legal']]
const FIRST = ['Anna', 'Ben', 'Carla', 'David', 'Elena', 'Farid', 'Grace', 'Hugo', 'Ines', 'Jon', 'Kai', 'Lena', 'Marco', 'Nora', 'Omar', 'Petra', 'Quinn', 'Rosa', 'Sven', 'Tara', 'Uma', 'Vera', 'Wes', 'Xena', 'Yusuf', 'Zoe']
const LAST = ['Andersson', 'Baker', 'Costa', 'Dubois', 'Evans', 'Fischer', 'Garcia', 'Hughes', 'Ito', 'Jensen', 'Kowalski', 'Lopez', 'Mueller', 'Nguyen', 'Olsen', 'Patel', 'Quinn', 'Rossi', 'Silva', 'Tanaka', 'Usman', 'Vargas', 'Weber', 'Xu', 'Yilmaz', 'Zhang']
const JOBS = [['SA_REP', 'Sales Representative', 55000], ['SA_MGR', 'Sales Manager', 90000], ['FI_ACC', 'Accountant', 62000], ['IT_PROG', 'Programmer', 78000], ['HR_REP', 'HR Representative', 58000], ['OP_SPEC', 'Operations Specialist', 52000], ['MK_REP', 'Marketing Representative', 60000], ['CS_AGT', 'Support Agent', 42000]]
const STATUS = [['SHIPPED', 30], ['DELIVERED', 46], ['PROCESSING', 7], ['PENDING', 4], ['CANCELLED', 5], ['RETURNED', 3], ['ON_HOLD', 1]]
const PAY = [['CREDIT_CARD', 42], ['INVOICE', 30], ['BANK_TRANSFER', 18], ['PAYPAL', 8], ['CASH', 2]]
const CURR = [['EUR', 45], ['USD', 35], ['GBP', 15], ['JPY', 5]]
const ACCOUNTS = [['4000', 'Revenue', 'C', 40], ['4100', 'Service Revenue', 'C', 8], ['5000', 'Cost of Goods Sold', 'D', 24], ['6100', 'Payroll', 'D', 10], ['6200', 'Rent', 'D', 3], ['6300', 'Marketing', 'D', 5], ['6400', 'IT & Software', 'D', 4], ['6500', 'Travel', 'D', 3], ['1100', 'Accounts Receivable', 'D', 2], ['2100', 'Accounts Payable', 'C', 1]]
export const ORDER_STATUSES = STATUS.map((s) => s[0])

export function makeOrder(r, id, whenMs, ctx, nowMs) {
  const ageD = (nowMs - whenMs) / DAY
  let status = r.weighted(STATUS.map((s) => s[0]), STATUS.map((s) => s[1]))
  if (ageD < 3) status = r.weighted(['PENDING', 'PROCESSING', 'SHIPPED', 'CANCELLED'], [40, 35, 20, 5])
  else if (ageD < 10 && (status === 'DELIVERED')) status = 'SHIPPED'
  const total = round(r.logn(Math.log(420), 1.0), 2)
  const ship = ['SHIPPED', 'DELIVERED', 'RETURNED'].includes(status) ? ts(whenMs + r.int(1, 6) * DAY) : null
  return [id, ts(whenMs), r.int(1, ctx.nCust), ctx.reps[r.zipf(ctx.reps.length)], status, total, r.weighted(CURR.map((c) => c[0]), CURR.map((c) => c[1])), r.weighted(PAY.map((c) => c[0]), PAY.map((c) => c[1])), r.int(1, 8), ship]
}
export const ORDER_COLS = [['ORDER_ID', 'INT'], ['ORDER_DATE', 'TS'], ['CUSTOMER_ID', 'INT'], ['SALES_REP_ID', 'INT'], ['STATUS', 'TEXT'], ['ORDER_TOTAL', 'REAL'], ['CURRENCY', 'TEXT'], ['PAYMENT_METHOD', 'TEXT'], ['WAREHOUSE_ID', 'INT'], ['SHIP_DATE', 'TS']]
export const GL_COLS = [['ENTRY_ID', 'INT'], ['POSTING_DATE', 'DATE'], ['PERIOD', 'TEXT'], ['ACCOUNT_CODE', 'TEXT'], ['ACCOUNT_NAME', 'TEXT'], ['COST_CENTER', 'TEXT'], ['DOC_TYPE', 'TEXT'], ['DEBIT_CREDIT', 'TEXT'], ['AMOUNT', 'REAL'], ['CURRENCY', 'TEXT'], ['CREATED_BY', 'INT']]
export function makeGl(r, id, whenMs, nEmp) {
  const [code, name, dc] = (() => { const a = r.weighted(ACCOUNTS, ACCOUNTS.map((x) => x[3])); return [a[0], a[1], a[2]] })()
  const amt = round(r.logn(Math.log(code === '6100' ? 9000 : code === '6200' ? 15000 : 1800), 1.0))
  return [id, dt(whenMs), dt(whenMs).slice(0, 7), code, name, `CC${r.int(10, 59)}`, code.startsWith('4') ? 'INV' : code === '6100' ? 'PAY' : r.weighted(['JNL', 'ADJ', 'INV'], [60, 10, 30]), dc, amt, 'EUR', r.int(1, nEmp)]
}

export function seedOracle(db, scale, seed, log = () => {}) {
  const r = new Rng(seed + 1)
  const now = Date.now(), start = now - 540 * DAY
  const N = (n) => Math.max(50, Math.round(n * scale))

  const tDep = defineTable(db, 'HR', 'DEPARTMENTS', [['DEPARTMENT_ID', 'INT'], ['DEPARTMENT_NAME', 'TEXT'], ['LOCATION_ID', 'INT']])
  bulkInsert(db, tDep, DEPTS.length, (i) => [DEPTS[i][0], DEPTS[i][1], 1000 + (i % 5) * 100])
  const nEmp = N(1500)
  const tEmp = defineTable(db, 'HR', 'EMPLOYEES', [['EMPLOYEE_ID', 'INT'], ['FIRST_NAME', 'TEXT'], ['LAST_NAME', 'TEXT'], ['EMAIL', 'TEXT'], ['DEPARTMENT_ID', 'INT'], ['JOB_ID', 'TEXT'], ['HIRE_DATE', 'DATE'], ['SALARY', 'REAL'], ['MANAGER_ID', 'INT']], ['DEPARTMENT_ID'])
  const reps = []
  bulkInsert(db, tEmp, nEmp, (i) => {
    const dep = r.weighted(DEPTS, [1, 5, 4, 14, 12, 8, 14, 6, 16, 14, 5, 2]); const isSales = dep[0] >= 40 && dep[0] <= 42
    const job = isSales ? (r.next() < .12 ? JOBS[1] : JOBS[0]) : dep[0] === 70 ? JOBS[3] : dep[0] === 20 ? JOBS[2] : dep[0] === 30 ? JOBS[4] : dep[0] === 80 ? JOBS[7] : dep[0] === 90 ? JOBS[6] : JOBS[5]
    const f = r.pick(FIRST), l = r.pick(LAST)
    if (isSales) reps.push(i + 1)
    return [i + 1, f, l, `${f}.${l}${i}@example.com`.toLowerCase(), dep[0], job[0], dt(now - r.int(30, 3800) * DAY), round(job[2] * (.8 + r.next() * .5), 0), i < 30 ? null : r.int(1, 30)]
  })
  if (!reps.length) reps.push(1)

  const nCust = N(20000)
  const tCust = defineTable(db, 'SALES', 'CUSTOMERS', [['CUSTOMER_ID', 'INT'], ['CUSTOMER_NAME', 'TEXT'], ['COUNTRY_CODE', 'TEXT'], ['CREDIT_LIMIT', 'REAL'], ['ACCOUNT_MGR_ID', 'INT'], ['SEGMENT', 'TEXT'], ['CREATED_DATE', 'DATE']])
  bulkInsert(db, tCust, nCust, (i) => [i + 1, `${r.pick(LAST)} ${r.pick(['GmbH', 'Ltd', 'Inc', 'SA', 'BV', 'AB', 'Group'])} ${i + 1}`, r.weighted(['DE', 'FR', 'GB', 'US', 'NL', 'SE', 'ES', 'IT', 'JP'], [18, 14, 14, 20, 8, 6, 8, 8, 4]), r.pick([5000, 10000, 25000, 50000, 100000]), reps[r.int(0, reps.length - 1)], r.weighted(['SMB', 'MID-MARKET', 'ENTERPRISE'], [60, 30, 10]), dt(now - r.int(30, 3000) * DAY)])
  log('Oracle: HR + customers done')

  const nOrd = N(200000)
  const ctx = { nCust, reps }
  const tOrd = defineTable(db, 'SALES', 'ORDERS', ORDER_COLS, ['ORDER_DATE', 'STATUS', 'CUSTOMER_ID', 'SALES_REP_ID'])
  const times = Array.from({ length: nOrd }, () => {
    for (;;) { const d = start + r.next() * (now - start); const dow = new Date(d).getUTCDay(); if ((dow === 0 || dow === 6) && r.next() > .3) continue; return Math.floor(d / DAY) * DAY + r.int(7, 20) * 3600000 + r.int(0, 3599) * 1000 }
  }).sort((a, b) => a - b)
  bulkInsert(db, tOrd, nOrd, (i) => makeOrder(r, 100000 + i, times[i], ctx, now), (n, t) => log(`Oracle ORDERS ${n.toLocaleString()} / ${t.toLocaleString()}`))
  addIndexes(db, tOrd)

  const nGl = N(300000)
  const tGl = defineTable(db, 'FIN', 'GL_ENTRIES', GL_COLS, ['POSTING_DATE', 'PERIOD', 'ACCOUNT_CODE', 'COST_CENTER'])
  bulkInsert(db, tGl, nGl, (i) => makeGl(r, 5000000 + i, start + r.next() * (now - start), nEmp), (n, t) => log(`Oracle GL_ENTRIES ${n.toLocaleString()} / ${t.toLocaleString()}`))
  for (const t of [tGl, tEmp, tCust]) addIndexes(db, t)
  return { ORDERS: nOrd, GL_ENTRIES: nGl, CUSTOMERS: nCust, EMPLOYEES: nEmp, DEPARTMENTS: DEPTS.length, _ctx: ctx }
}
