/** Teradata "EDW_PROD": telecom call-detail records (CDR) star schema. */
import { Rng, defineTable, addIndexes, bulkInsert, ts, dt, DAY, round } from './common.mjs'

const REGIONS = ['LONDON', 'SOUTH EAST', 'MIDLANDS', 'NORTH WEST', 'SCOTLAND', 'WALES', 'NORTH EAST', 'EAST ANGLIA']
const PLANS = [[1, 'PAYG-5', 5], [2, 'SIM-ONLY-10', 10], [3, 'SIM-ONLY-20', 20], [4, 'UNLIMITED-30', 30], [5, 'UNLIMITED-45', 45], [6, 'FAMILY-60', 60], [7, 'BUSINESS-35', 35], [8, 'BUSINESS-80', 80], [9, 'DATA-ONLY-15', 15], [10, 'ROAM-PLUS-55', 55]]
const DEVICES = ['IPHONE 15', 'IPHONE 14', 'GALAXY S24', 'GALAXY A54', 'PIXEL 8', 'XIAOMI 13', 'ONEPLUS 12', 'OTHER']
export const CALL_COLS = [['CALL_ID', 'INT'], ['CALL_START_TS', 'TS'], ['CUST_ID', 'INT'], ['TOWER_ID', 'INT'], ['CALL_TYPE', 'TEXT'], ['NETWORK', 'TEXT'], ['DURATION_SEC', 'INT'], ['DATA_MB', 'REAL'], ['ROAMING_FLAG', 'TEXT'], ['DROP_FLAG', 'TEXT'], ['REVENUE_AMT', 'REAL']]

export function makeCall(r, id, whenMs, ctx) {
  const type = r.weighted(['DATA', 'VOICE', 'SMS', 'VIDEO'], [52, 26, 18, 4])
  const net = r.weighted(['5G', '4G', '3G'], [34, 58, 8])
  const roam = r.next() < .035 ? 'Y' : 'N'
  const dur = type === 'SMS' ? 1 : type === 'VOICE' ? Math.max(5, Math.round(r.logn(Math.log(140), .9))) : type === 'VIDEO' ? Math.round(r.logn(Math.log(420), .7)) : Math.round(r.logn(Math.log(600), 1.0))
  const mb = type === 'DATA' ? round(r.logn(Math.log(net === '5G' ? 90 : 40), 1.1)) : type === 'VIDEO' ? round(dur * .75) : 0
  const rev = round((type === 'VOICE' ? dur / 60 * .02 : type === 'SMS' ? .05 : mb * .004) * (roam === 'Y' ? 6 : 1), 3)
  const drop = (type === 'VOICE' || type === 'VIDEO') && r.next() < (net === '3G' ? .06 : .015) ? 'Y' : 'N'
  return [id, ts(whenMs), r.zipf(ctx.nCust) + 1, r.zipf(ctx.nTower) + 1, type, net, dur, mb, roam, drop, rev]
}

export function seedTeradata(db, scale, seed, log = () => {}) {
  const r = new Rng(seed + 2)
  const now = Date.now(), start = now - 180 * DAY
  const N = (n) => Math.max(50, Math.round(n * scale))

  const tPlan = defineTable(db, 'EDW_PROD', 'PLAN_DIM', [['PLAN_ID', 'INT'], ['PLAN_CODE', 'TEXT'], ['MONTHLY_FEE', 'REAL']])
  bulkInsert(db, tPlan, PLANS.length, (i) => PLANS[i])
  const nTower = N(500)
  const tTower = defineTable(db, 'EDW_PROD', 'TOWER_DIM', [['TOWER_ID', 'INT'], ['REGION', 'TEXT'], ['TOWER_TYPE', 'TEXT'], ['CAPACITY_USERS', 'INT'], ['INSTALL_DT', 'DATE']])
  bulkInsert(db, tTower, nTower, (i) => [i + 1, REGIONS[i % REGIONS.length], r.weighted(['MACRO', 'SMALL CELL', 'INDOOR'], [60, 30, 10]), r.pick([800, 1500, 3000, 6000]), dt(now - r.int(200, 3500) * DAY)])
  const nCust = N(40000)
  const tCust = defineTable(db, 'EDW_PROD', 'CUSTOMER_DIM', [['CUST_ID', 'INT'], ['SEGMENT', 'TEXT'], ['REGION', 'TEXT'], ['PLAN_ID', 'INT'], ['ACTIVATION_DT', 'DATE'], ['CHURN_FLAG', 'TEXT'], ['ARPU', 'REAL'], ['AGE_BAND', 'TEXT'], ['DEVICE_TYPE', 'TEXT']], ['REGION', 'PLAN_ID'])
  bulkInsert(db, tCust, nCust, (i) => {
    const plan = r.weighted(PLANS, [6, 10, 12, 14, 10, 8, 10, 4, 4, 2])
    return [i + 1, plan[1].startsWith('BUSINESS') ? 'BUSINESS' : plan[1].startsWith('FAMILY') ? 'FAMILY' : 'CONSUMER', r.pick(REGIONS), plan[0], dt(now - r.int(20, 3000) * DAY), r.next() < .07 ? 'Y' : 'N', round(plan[2] * (.7 + r.next() * .7)), r.weighted(['18-24', '25-34', '35-44', '45-54', '55+'], [14, 28, 24, 18, 16]), r.weighted(DEVICES, [22, 12, 14, 12, 8, 8, 6, 18])]
  })
  log('Teradata: dimensions done')

  const nCall = N(400000)
  const ctx = { nCust, nTower }
  const tCall = defineTable(db, 'EDW_PROD', 'CALL_DETAIL_FACT', CALL_COLS, ['CALL_START_TS', 'CUST_ID', 'TOWER_ID', 'CALL_TYPE'])
  bulkInsert(db, tCall, nCall, (i) => {
    let d
    for (;;) { d = start + r.next() * (now - start); const h = new Date(d).getUTCHours(); if (r.next() < [.15, .1, .08, .08, .1, .2, .4, .7, .9, .9, .85, .85, .9, .85, .85, .9, 1, 1, .95, .85, .7, .55, .4, .25][h]) break }
    return makeCall(r, 9000000 + i, d, ctx)
  }, (n, t) => log(`Teradata CALL_DETAIL_FACT ${n.toLocaleString()} / ${t.toLocaleString()}`))
  addIndexes(db, tCall)
  for (const t of [tCust, tTower]) addIndexes(db, t)
  return { CALL_DETAIL_FACT: nCall, CUSTOMER_DIM: nCust, TOWER_DIM: nTower, PLAN_DIM: PLANS.length, _ctx: ctx }
}
