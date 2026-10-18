import assert from 'node:assert/strict'
import {
  parseDelimited, detectDelimiter, parseNumber, parseDate, datasetFromText, fromObjects, series, kpiValue, applyFilters,
  autoDashboard, autoGrain, widgetIssue, compareDatasets, datasetToCsv, makeDemoOrders, formatNumber, defaultWidget, bucket, weekStart,
  datasetFromTextAsync, fromObjectsAsync, MAX_ROWS,
} from '../src/engine.ts'
import type { Widget } from '../src/engine.ts'

let passed = 0
const t = (name: string, fn: () => void) => { try { fn(); passed++ } catch (e) { console.error('FAIL', name, '\n ', (e as Error).message); process.exitCode = 1 } }

const SALES = `Date,Region,Product,Units,Revenue
2026-10-01,North,Widget,12,240
2026-10-02,South,Widget,8,160
2026-10-03,North,Gadget,5,250
2026-10-04,East,Gadget,9,450
2026-10-05,South,Widget,15,300
2026-10-06,East,Widget,7,140
2026-10-07,North,Gadget,11,550`

t('delimiter detection', () => {
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';')
  assert.equal(detectDelimiter('a\tb\n1\t2'), '\t')
  assert.equal(detectDelimiter('a,b\n1,2'), ',')
})
t('quoted fields, escaped quotes, newlines in cells', () => {
  const r = parseDelimited('a,b\n"x, y","he said ""hi"""\n"line1\nline2",3')
  assert.deepEqual(r, [['a', 'b'], ['x, y', 'he said "hi"'], ['line1\nline2', '3']])
})
t('numbers', () => {
  assert.equal(parseNumber('1,234.5'), 1234.5)
  assert.equal(parseNumber('$1,200'), 1200)
  assert.equal(parseNumber('(50)'), -50)
  assert.equal(parseNumber('12%'), 12)
  assert.equal(parseNumber('n/a'), null)
  assert.equal(parseNumber('eight'), null)
  assert.equal(parseNumber('1,23'), null)
  assert.equal(parseNumber(''), null)
})
t('dates', () => {
  assert.equal(parseDate('2026-10-01'), '2026-10-01')
  assert.equal(parseDate('2026-10-01T13:45:00Z'), '2026-10-01')
  assert.equal(parseDate('3/9/2026'), '2026-03-09')
  assert.equal(parseDate('25/12/2026'), '2026-12-25')
  assert.equal(parseDate('2026-02-30'), null)
  assert.equal(parseDate('2024'), null)
  assert.equal(parseDate(new Date(Date.UTC(2026, 0, 5))), '2026-01-05')
})
t('dataset types and totals', () => {
  const ds = datasetFromText('sales.csv', SALES)
  assert.deepEqual(ds.columns.map((c) => c.type), ['date', 'text', 'text', 'number', 'number'])
  assert.equal(ds.rows.length, 7)
  const w = { id: 'w', type: 'kpi', title: '', agg: 'sum', topN: 8, sort: 'value', span: 1 } as Widget
  assert.equal(kpiValue(ds.rows, { ...w, measure: 'Units' }), 67)
  assert.equal(kpiValue(ds.rows, { ...w, measure: 'Revenue' }), 2090)
  assert.equal(kpiValue(ds.rows, { ...w, agg: 'count' }), 7)
  assert.equal(kpiValue(ds.rows, { ...w, agg: 'distinct', measure: 'Region' }), 3)
})
t('bar series by region', () => {
  const ds = datasetFromText('sales.csv', SALES)
  const w = { id: 'w', type: 'bar', title: '', dim: 'Region', measure: 'Revenue', agg: 'sum', topN: 8, sort: 'value', span: 1 } as Widget
  const pts = series(ds, ds.rows, w)
  assert.deepEqual(pts.map((p) => [p.label, p.value]), [['North', 1040], ['East', 590], ['South', 460]])
})
t('topN folds the rest into Other for sums', () => {
  const ds = datasetFromText('sales.csv', SALES)
  const w = { id: 'w', type: 'bar', title: '', dim: 'Region', measure: 'Revenue', agg: 'sum', topN: 1, sort: 'value', span: 1 } as Widget
  const pts = series(ds, ds.rows, w)
  assert.deepEqual(pts.map((p) => [p.label, p.value]), [['North', 1040], ['Other', 1050]])
  assert.equal(pts.reduce((s, p) => s + p.value, 0), 2090)
  const avg = series(ds, ds.rows, { ...w, agg: 'avg' })
  assert.equal(avg.length, 1, 'averages are truncated, not folded')
})
t('line series by day, then by month', () => {
  const ds = datasetFromText('sales.csv', SALES)
  const w = { id: 'w', type: 'line', title: '', dim: 'Date', measure: 'Units', agg: 'sum', topN: 8, sort: 'value', span: 2 } as Widget
  assert.equal(autoGrain(ds, 'Date'), 'day')
  const d = series(ds, ds.rows, w)
  assert.equal(d.length, 7); assert.equal(d[0].label, '2026-10-01'); assert.equal(d[6].value, 11)
  const m = series(ds, ds.rows, { ...w, grain: 'month' })
  assert.deepEqual(m.map((p) => [p.label, p.value]), [['2026-10', 67]])
})
t('weeks start on Monday', () => { assert.equal(weekStart('2026-10-07'), '2026-10-05'); assert.equal(bucket('2026-10-07', 'week'), '2026-10-05') })
t('filters and date range', () => {
  const ds = datasetFromText('sales.csv', SALES)
  assert.equal(applyFilters(ds, [{ col: 'Region', values: ['North'] }]).length, 3)
  assert.equal(applyFilters(ds, [{ col: 'Region', values: ['North', 'East'] }, { col: 'Product', values: ['Gadget'] }]).length, 3)
  assert.equal(applyFilters(ds, [], { col: 'Date', days: 3 }).length, 3)
  assert.equal(applyFilters(ds, [], { col: 'Date', days: 0 }).length, 7)
})
t('bad data: text in number column, blanks', () => {
  const ds = datasetFromText('bad.csv', 'Date,Region,Units,Revenue\n2026-10-01,North,12,240\n2026-10-02,South,eight,160\n2026-10-03,,5,n/a\n2026-10-04,East,6,100\n2026-10-05,East,7,110\n2026-10-06,East,8,120\n2026-10-07,East,9,130\n2026-10-08,East,10,140\n2026-10-09,East,11,150\n2026-10-10,East,12,160\n2026-10-11,East,13,170\n2026-10-12,East,14,180\n2026-10-13,East,15,190\n2026-10-14,East,16,200\n2026-10-15,East,17,210\n2026-10-16,East,18,220\n2026-10-17,East,19,230\n2026-10-18,East,20,240\n2026-10-19,East,21,250\n2026-10-20,East,22,260')
  const units = ds.columns.find((c) => c.name === 'Units')!
  assert.equal(units.type, 'number', '95% numeric is a number column')
  assert.equal(ds.rows[1].Units, null, 'non-numeric cell becomes blank')
  assert.equal(ds.columns.find((c) => c.name === 'Region')!.blanks, 1)
  const pts = series(ds, ds.rows, { id: 'w', type: 'bar', title: '', dim: 'Region', agg: 'count', topN: 8, sort: 'value', span: 1 })
  assert.ok(pts.some((p) => p.label === '(blank)'))
})
t('id-like numeric columns are not measures', () => {
  const ds = fromObjects('o', makeDemoOrders(50, 1, new Date('2026-10-18')))
  assert.equal(ds.columns.find((c) => c.name === 'OrderId')!.type, 'text')
  assert.equal(ds.columns.find((c) => c.name === 'Revenue')!.type, 'number')
  assert.equal(ds.columns.find((c) => c.name === 'OrderDate')!.type, 'date')
})
t('auto dashboard picks sensible widgets', () => {
  const ds = datasetFromText('sales.csv', SALES)
  const ws = autoDashboard(ds)
  const kinds = ws.map((w) => w.type)
  assert.equal(kinds[0], 'kpi'); assert.ok(kinds.includes('line')); assert.ok(kinds.includes('bar')); assert.equal(kinds[kinds.length - 1], 'table')
  assert.ok(ws.every((w) => widgetIssue(ds, w) === null))
  assert.ok(ws.filter((w) => w.type === 'kpi').length >= 3)
})
t('auto dashboard with no numbers still works', () => {
  const ds = datasetFromText('x.csv', 'Name,City\nA,X\nB,Y\nC,X\nD,Y')
  const ws = autoDashboard(ds)
  assert.ok(ws.some((w) => w.type === 'bar' && w.agg === 'count'))
})
t('replacing data keeps widgets valid; removed columns are reported', () => {
  const a = datasetFromText('s.csv', SALES)
  const b = datasetFromText('s.csv', SALES.replace('Revenue', 'Sales') + '\n2026-10-08,West,Gadget,3,90')
  const c = compareDatasets(a, b)
  assert.equal(c.rowDelta, 1); assert.deepEqual(c.removed, ['Revenue']); assert.deepEqual(c.added, ['Sales'])
  const ws = autoDashboard(a)
  assert.ok(ws.some((w) => widgetIssue(b, w) !== null))
})
t('json input: array of objects, wrapped, array of arrays', () => {
  assert.equal(datasetFromText('a', '[{"x":1,"y":"a"},{"x":2,"y":"b"}]').rows.length, 2)
  assert.equal(datasetFromText('a', '{"value":[{"x":1},{"x":2},{"x":3}]}').rows.length, 3)
  assert.equal(datasetFromText('a', '[["x","y"],[1,"a"],[2,"b"]]').rows.length, 2)
})
t('empty and header-only input are errors', () => {
  assert.throws(() => datasetFromText('a', 'a,b'), /header/)
  assert.throws(() => datasetFromText('a', '[]'), /No rows/)
})
t('duplicate and blank headers are made unique', () => {
  const ds = datasetFromText('a', 'x,x,\n1,2,3\n4,5,6')
  assert.deepEqual(ds.columns.map((c) => c.name), ['x', 'x (2)', 'Column 3'])
})
t('csv export round trip', () => {
  const ds = datasetFromText('s.csv', SALES)
  const back = datasetFromText('s.csv', datasetToCsv(ds))
  assert.equal(back.rows.length, 7); assert.equal(kpiValue(back.rows, { measure: 'Revenue', agg: 'sum' }), 2090)
})
t('formatNumber', () => { assert.equal(formatNumber(2090), '2,090'); assert.equal(formatNumber(12345), '12.3K'); assert.equal(formatNumber(2090, false), '2,090'); assert.equal(formatNumber(1284000), '1.3M'); assert.equal(formatNumber(0.456), '0.46') })
t('default widgets', () => {
  const ds = datasetFromText('s.csv', SALES)
  assert.equal(defaultWidget('bar', ds).dim, 'Region'); assert.equal(defaultWidget('line', ds).dim, 'Date'); assert.equal(defaultWidget('kpi', ds).measure, 'Units')
})
t('large data performance (100k rows aggregate < 1.5 s)', () => {
  const ds = fromObjects('big', makeDemoOrders(100000, 3, new Date('2026-10-18')))
  const t0 = Date.now()
  const w = autoDashboard(ds)
  const rows = applyFilters(ds, [{ col: 'Region', values: ['North'] }])
  w.forEach((x) => { if (x.type !== 'table' && x.type !== 'kpi') series(ds, rows, x); if (x.type === 'kpi') kpiValue(rows, x) })
  assert.ok(Date.now() - t0 < 1500, 'took ' + (Date.now() - t0) + ' ms')
})

const ta = async (name: string, fn: () => Promise<void>) => { try { await fn(); passed++ } catch (e) { console.error('FAIL', name, '\n ', (e as Error).message); process.exitCode = 1 } }
await ta('async parse equals sync parse', async () => {
  const sync = datasetFromText('s.csv', SALES), asyn = await datasetFromTextAsync('s.csv', SALES)
  assert.deepEqual(asyn.columns, sync.columns); assert.deepEqual(asyn.rows, sync.rows)
})
await ta('async parse reports progress and yields', async () => {
  const big = datasetToCsv(fromObjects('b', makeDemoOrders(60000, 2, new Date('2026-10-18'))))
  const seen: number[] = []; let ticks = 0
  const timer = setInterval(() => ticks++, 1)
  const ds = await datasetFromTextAsync('b.csv', big, (f) => seen.push(f))
  clearInterval(timer)
  assert.equal(ds.rows.length, 60000); assert.ok(seen.length >= 4, 'progress callbacks: ' + seen.length)
  assert.ok(seen.every((v, i) => i === 0 || v >= seen[i - 1] - 1e-9), 'progress never goes backwards')
  assert.ok(ticks > 3, 'the event loop got to run during the parse (timer ticks: ' + ticks + ')')
})
await ta('more than the row cap is reported, never silently dropped', async () => {
  const lines = ['Id,Region,Amount']
  for (let i = 0; i < MAX_ROWS + 1234; i++) lines.push(`${i},${i % 2 ? 'N' : 'S'},1`)
  const ds = await datasetFromTextAsync('huge.csv', lines.join('\n'))
  assert.equal(ds.rows.length, MAX_ROWS); assert.equal(ds.truncatedFrom, MAX_ROWS + 1234)
  const ok = await fromObjectsAsync('o', makeDemoOrders(500, 1, new Date('2026-10-18')))
  assert.equal(ok.truncatedFrom, undefined, 'no flag when everything fits')
})

console.log(process.exitCode ? 'SOME TESTS FAILED' : `ALL ${passed} ENGINE TESTS PASSED`)
