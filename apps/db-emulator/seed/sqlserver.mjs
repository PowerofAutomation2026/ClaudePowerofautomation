/** SQL Server "SalesDW": retail star schema + ServiceNow incident table. */
import { Rng, defineTable, addIndexes, bulkInsert, ts, dt, DAY, round } from './common.mjs'

const REGIONS = ['North', 'South', 'East', 'West', 'Central', 'Online']
const CITIES = { North: ['Leeds', 'Newcastle', 'York'], South: ['Brighton', 'Southampton', 'Bristol'], East: ['Norwich', 'Cambridge', 'Ipswich'], West: ['Cardiff', 'Swansea', 'Exeter'], Central: ['Birmingham', 'Nottingham', 'Leicester'], Online: ['Online'] }
const CATS = {
  Electronics: [['Phones', 400], ['Laptops', 900], ['Audio', 120], ['TV & Video', 500], ['Accessories', 25]],
  Home: [['Kitchen', 60], ['Furniture', 300], ['Bedding', 70], ['Lighting', 40]],
  Grocery: [['Fresh', 4], ['Pantry', 3], ['Beverages', 5], ['Frozen', 4]],
  Apparel: [['Menswear', 45], ['Womenswear', 55], ['Kids', 30], ['Footwear', 70]],
  Sports: [['Fitness', 80], ['Outdoor', 110], ['Team Sports', 50]],
  Toys: [['Games', 35], ['Building', 45], ['Dolls', 25]],
  Beauty: [['Skincare', 30], ['Makeup', 22], ['Fragrance', 65]],
}
const BRANDS = ['Acme', 'Zenith', 'Nova', 'Orbit', 'Pioneer', 'Vertex', 'Summit', 'Harbor', 'Atlas', 'Lumen']
const SEG = ['Consumer', 'Corporate', 'Home Office']
const TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum']
const COUNTRIES = [['United Kingdom', 70], ['Ireland', 8], ['Germany', 6], ['France', 6], ['Netherlands', 5], ['Spain', 5]]

const GROUPS = {
  'Service Desk': [['Maria Lopez', .82, 1.5], ['James Carter', .95, 1.4], ['Aisha Khan', .88, 1.3], ['Tom Becker', 1.12, 1.1], ['Nina Petrova', 1.0, .7, 150]],
  'Network Operations': [['Luis Fernandez', .9, 1.2], ['Grace Okafor', .85, 1.1], ['Wei Chen', 1.0, 1.0], ['Oliver Smith', 1.25, .9]],
  'Application Support': [['Priya Nair', .8, 1.4], ['Daniel Wright', .98, 1.3], ['Sofia Rossi', 1.05, 1.2], ['Kevin Brown', 1.18, 1.0], ['Hana Sato', .92, .6, 100]],
  'Database Admin': [['Ahmed Hassan', .86, 1.0], ['Laura Meyer', .95, 1.0], ['Victor Ivanov', 1.15, .8]],
  Infrastructure: [['Chloe Martin', .9, 1.1], ['Ryan Murphy', 1.02, 1.0], ['Zoe Adams', 1.1, .9]],
  'Security Operations': [['Ethan Cole', .84, 1.0], ['Fatima Ali', .93, .9]],
}
const GW = { 'Service Desk': 38, 'Network Operations': 14, 'Application Support': 26, 'Database Admin': 7, Infrastructure: 10, 'Security Operations': 5 }
const GS = { 'Service Desk': .75, 'Network Operations': 1.0, 'Application Support': 1.1, 'Database Admin': 1.3, Infrastructure: 1.2, 'Security Operations': 1.0 }
const GCAT = {
  'Service Desk': [['Access / Identity', ['Password reset', 'Account locked', 'New access request', 'MFA issue']], ['Hardware', ['Laptop', 'Monitor', 'Printer', 'Peripheral']], ['Software', ['Office suite', 'Browser', 'VPN client', 'Install request']]],
  'Network Operations': [['Network', ['Wi-Fi', 'LAN', 'VPN', 'DNS', 'Firewall']]],
  'Application Support': [['Software', ['ERP', 'CRM', 'HR portal', 'Intranet', 'Line-of-business app']], ['Email', ['Mailbox', 'Calendar', 'Distribution list']]],
  'Database Admin': [['Database', ['Performance', 'Backup / restore', 'Access', 'Replication']]],
  Infrastructure: [['Hardware', ['Server', 'Storage', 'Virtual machine']], ['Network', ['Data centre link', 'Load balancer']]],
  'Security Operations': [['Security', ['Phishing report', 'Malware', 'Suspicious login', 'Data loss']]],
}
export const INCIDENT_CONST = {
  SERVICES: ['Email & Calendar', 'ERP Finance', 'CRM Sales', 'HR Portal', 'Corporate VPN', 'Office Wi-Fi', 'Service Desk Portal', 'Data Warehouse', 'Payroll', 'File Shares', 'Video Conferencing', 'Endpoint Management', 'Identity Platform', 'Customer Website', 'Print Services'],
  LOCATIONS: ['London', 'Manchester', 'Dublin', 'Berlin', 'Paris', 'Madrid', 'New York', 'Chicago', 'Austin', 'Singapore'],
  CONTACT: [['Self-service', 34], ['Phone', 26], ['Email', 20], ['Chat', 16], ['Walk-in', 4]],
  CLOSE: [['Solved (Permanently)', 62], ['Solved (Work Around)', 14], ['Closed/Resolved by Caller', 11], ['Duplicate', 6], ['Not Solved (Not Reproducible)', 5], ['Not Solved (Too Costly)', 2]],
  PRIORITY: [['1 - Critical', 3], ['2 - High', 12], ['3 - Moderate', 45], ['4 - Low', 40]],
  SLA: { '1 - Critical': 4, '2 - High': 8, '3 - Moderate': 24, '4 - Low': 72 },
  MEAN: { '1 - Critical': 3.2, '2 - High': 6.5, '3 - Moderate': 17, '4 - Low': 48 },
  IU: { '1 - Critical': ['1 - High', '1 - High'], '2 - High': ['2 - Medium', '1 - High'], '3 - Moderate': ['2 - Medium', '2 - Medium'], '4 - Low': ['3 - Low', '3 - Low'] },
  TEMPLATES: ['Cannot log in to {s}', '{s} is very slow', '{s} unavailable for several users', 'Error message when opening {s}', 'Request access to {s}', 'Intermittent disconnects on {s}', '{s}: data looks wrong, please check', 'Unable to print from {s}', 'Need help configuring {s}', '{s} outage, multiple sites affected'],
  HOUR_W: [1, 1, 1, 1, 1, 2, 4, 8, 14, 16, 15, 12, 10, 13, 15, 14, 11, 8, 5, 3, 2, 2, 1, 1],
}

export const INCIDENT_COLS = [['Number', 'TEXT'], ['Opened', 'TS'], ['Resolved', 'TS'], ['Closed', 'TS'], ['Priority', 'TEXT'], ['State', 'TEXT'], ['AssignmentGroup', 'TEXT'], ['AssignedTo', 'TEXT'], ['ClosedBy', 'TEXT'], ['Category', 'TEXT'], ['Subcategory', 'TEXT'], ['BusinessService', 'TEXT'], ['Location', 'TEXT'], ['ContactType', 'TEXT'], ['Impact', 'TEXT'], ['Urgency', 'TEXT'], ['CloseCode', 'TEXT'], ['MadeSLA', 'BIT'], ['Escalated', 'BIT'], ['ResolutionTimeHrs', 'REAL'], ['SLATargetHrs', 'INT'], ['SLAElapsedPct', 'REAL'], ['ReassignmentCount', 'INT'], ['ReopenCount', 'INT'], ['ClosedCount', 'INT'], ['ShortDescription', 'TEXT']]

/** Make one incident row opened at `openMs`; `nowMs` decides whether it can already be finished. */
export function makeIncident(r, seq, openMs, nowMs) {
  const C = INCIDENT_CONST
  const group = r.weighted(Object.keys(GW), Object.values(GW))
  const [category, subs] = r.pick(GCAT[group])
  let prio = r.weighted(C.PRIORITY.map((p) => p[0]), C.PRIORITY.map((p) => p[1]))
  if (group === 'Security Operations' && r.next() < .12) prio = '2 - High'
  const ageDays = (nowMs - openMs) / DAY            // new joiners (4th value) only work tickets opened in their first N days
  const pool = GROUPS[group].filter((m) => m[3] === undefined || ageDays < m[3])
  const members = pool.length ? pool : GROUPS[group]
  const [member, skill] = (() => { const m = r.weighted(members, members.map((x) => x[2])); return [m[0], m[1]] })()
  const target = C.SLA[prio]
  const hours = Math.max(.1, round(r.logn(Math.log(C.MEAN[prio] * GS[group] * skill), .65)))
  const ageH = (nowMs - openMs) / 3600000
  let state = 'Closed'
  if (hours > ageH) state = r.weighted(['In Progress', 'On Hold', 'New'], [60, 25, 15])
  else if (ageH - hours < 72 && r.next() < .5) state = 'Resolved'
  else if (r.next() < .004) state = 'Cancelled'
  const finished = state === 'Closed' || state === 'Resolved'
  const resolvedMs = finished ? openMs + hours * 3600000 : null
  let closedMs = state === 'Closed' ? resolvedMs + (24 + r.next() * 72) * 3600000 : null
  if (closedMs && closedMs > nowMs) closedMs = nowMs - r.int(60, 36000) * 1000
  const closer = state === 'Closed' ? (r.next() < .93 ? member : r.pick(Object.values(GROUPS).flat())[0]) : null
  let made = null, elapsed = null
  if (finished) { const eff = hours * (r.next() < .08 ? .55 : 1); made = eff <= target ? 1 : 0; elapsed = round(eff / target * 100, 1) }
  const [imp, urg] = C.IU[prio]
  const service = r.pick(C.SERVICES)
  let short = r.pick(C.TEMPLATES).replace('{s}', service)
  if (r.next() < .08) short += ', please advise, thanks'
  return [
    `INC${String(1000001 + seq).padStart(7, '0')}`, ts(openMs), resolvedMs ? ts(resolvedMs) : null, closedMs ? ts(closedMs) : null, prio, state, group, member, closer, category, r.pick(subs),
    service, r.pick(C.LOCATIONS), r.weighted(C.CONTACT.map((c) => c[0]), C.CONTACT.map((c) => c[1])), imp, urg,
    finished ? r.weighted(C.CLOSE.map((c) => c[0]), C.CLOSE.map((c) => c[1])) : null, made, (['1 - Critical', '2 - High'].includes(prio) && r.next() < .35) ? 1 : 0,
    finished ? hours : null, target, elapsed, Math.min(4, Math.floor(-Math.log(1 - r.next()) / 1.6)), state === 'Closed' && r.next() < .035 ? 1 : 0, state === 'Closed' ? 1 : 0, short,
  ]
}

export function seedSqlServer(db, scale, seed, log = () => {}) {
  const r = new Rng(seed)
  const now = Date.now(), start = now - 540 * DAY
  const N = (n) => Math.max(50, Math.round(n * scale))

  // dims
  const tStore = defineTable(db, 'dbo', 'DimStore', [['StoreKey', 'INT'], ['StoreName', 'TEXT'], ['Region', 'TEXT'], ['City', 'TEXT'], ['Format', 'TEXT'], ['OpenDate', 'DATE'], ['SquareFeet', 'INT']])
  const stores = []
  const nStore = Math.max(12, Math.min(60, N(60)))
  bulkInsert(db, tStore, nStore, (i) => {
    const region = i < 4 ? 'Online' : REGIONS[i % 5]
    const city = r.pick(CITIES[region]); const fmt = region === 'Online' ? 'Online' : r.weighted(['Hypermarket', 'Superstore', 'Express'], [20, 45, 35])
    stores.push({ key: i + 1, region, w: fmt === 'Hypermarket' ? 3 : fmt === 'Superstore' ? 2 : fmt === 'Online' ? 3 : 1 })
    return [i + 1, `${city} ${fmt} ${i + 1}`, region, city, fmt, dt(now - r.int(400, 4000) * DAY), fmt === 'Hypermarket' ? r.int(60000, 120000) : fmt === 'Superstore' ? r.int(25000, 60000) : fmt === 'Online' ? 0 : r.int(2000, 6000)]
  })
  const tProd = defineTable(db, 'dbo', 'DimProduct', [['ProductKey', 'INT'], ['SKU', 'TEXT'], ['ProductName', 'TEXT'], ['Category', 'TEXT'], ['Subcategory', 'TEXT'], ['Brand', 'TEXT'], ['UnitCost', 'REAL'], ['ListPrice', 'REAL']])
  const prods = []
  const nProd = N(2000)
  bulkInsert(db, tProd, nProd, (i) => {
    const cat = r.pick(Object.keys(CATS)); const [sub, base] = r.pick(CATS[cat]); const price = round(base * (.6 + r.next() * 1.2) + .99)
    prods.push({ price, cost: round(price * (.45 + r.next() * .3)) })
    return [i + 1, `SKU-${String(100000 + i)}`, `${r.pick(BRANDS)} ${sub} ${r.int(1, 999)}`, cat, sub, r.pick(BRANDS), prods[i].cost, price]
  })
  const nCust = N(50000)
  const tCust = defineTable(db, 'dbo', 'DimCustomer', [['CustomerKey', 'INT'], ['Segment', 'TEXT'], ['Country', 'TEXT'], ['City', 'TEXT'], ['JoinDate', 'DATE'], ['LoyaltyTier', 'TEXT']])
  bulkInsert(db, tCust, nCust, (i) => [i + 1, r.weighted(SEG, [70, 20, 10]), r.weighted(COUNTRIES.map((c) => c[0]), COUNTRIES.map((c) => c[1])), r.pick(Object.values(CITIES).flat()), dt(now - r.int(10, 2500) * DAY), r.weighted(TIERS, [55, 28, 13, 4])])
  log('SQL Server: dimensions done')

  // fact
  const nFact = N(300000)
  const tFact = defineTable(db, 'dbo', 'FactSales', [['SalesKey', 'INT'], ['OrderDate', 'TS'], ['StoreKey', 'INT'], ['ProductKey', 'INT'], ['CustomerKey', 'INT'], ['Channel', 'TEXT'], ['Quantity', 'INT'], ['UnitPrice', 'REAL'], ['DiscountPct', 'REAL'], ['SalesAmount', 'REAL'], ['CostAmount', 'REAL']], ['OrderDate', 'StoreKey', 'ProductKey'])
  const storeW = stores.map((s) => s.w)
  bulkInsert(db, tFact, nFact, (i) => {
    let d
    for (;;) {                     // seasonality: weekends, Nov-Dec peak
      d = start + r.next() * (now - start); const day = new Date(d); const dow = day.getUTCDay(); const m = day.getUTCMonth()
      const w = (dow === 0 || dow === 6 ? 1.3 : 1) * (m >= 10 ? 1.5 : m === 0 ? .8 : 1)
      if (r.next() < w / 2) break
    }
    const hour = r.weighted([...Array(24).keys()], [1, 1, 1, 1, 1, 1, 2, 4, 7, 9, 10, 11, 12, 11, 10, 10, 11, 12, 11, 8, 5, 3, 2, 1])
    d = Math.floor(d / DAY) * DAY + hour * 3600000 + r.int(0, 3599) * 1000
    const st = r.weighted(stores, storeW); const pi = r.zipf(nProd); const p = prods[pi]
    const qty = r.weighted([1, 2, 3, 4, 5, 6], [50, 25, 12, 7, 4, 2]); const disc = r.weighted([0, 5, 10, 15, 20, 30], [60, 12, 12, 8, 6, 2])
    const channel = st.region === 'Online' ? r.weighted(['Web', 'Mobile App'], [65, 35]) : 'In-Store'
    const unit = round(p.price * (st.region === 'Online' ? .97 : 1))
    return [i + 1, ts(d), st.key, pi + 1, r.int(1, nCust), channel, qty, unit, disc, round(qty * unit * (1 - disc / 100)), round(qty * p.cost)]
  }, (n, t) => log(`SQL Server FactSales ${n.toLocaleString()} / ${t.toLocaleString()}`))
  addIndexes(db, tFact)

  // incidents
  const nInc = N(120000)
  const tInc = defineTable(db, 'dbo', 'ServiceNowIncidents', INCIDENT_COLS, ['Opened', 'State', 'AssignmentGroup', 'ClosedBy'])
  const opens = Array.from({ length: nInc }, () => {
    for (;;) {
      const d = start + 40 * DAY + r.next() * (now - start - 40 * DAY); const day = new Date(d); const wd = day.getUTCDay()
      if ((wd === 0 || wd === 6) && r.next() > .22) continue
      if (r.next() > .8 * (day.getUTCMonth() === 0 || day.getUTCMonth() === 8 ? 1.25 : 1)) continue
      return Math.floor(d / DAY) * DAY + r.weighted([...Array(24).keys()], INCIDENT_CONST.HOUR_W) * 3600000 + r.int(0, 3599) * 1000
    }
  }).sort((a, b) => a - b)
  bulkInsert(db, tInc, nInc, (i) => makeIncident(r, i, opens[i], now))
  addIndexes(db, tInc)
  for (const t of [tStore, tProd, tCust]) addIndexes(db, t)
  return { FactSales: nFact, ServiceNowIncidents: nInc, DimCustomer: nCust, DimProduct: nProd, DimStore: nStore }
}
