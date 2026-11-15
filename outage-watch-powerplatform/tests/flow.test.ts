import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs helper
import { PROBE_CONCURRENCY, buildClientData, canonical, estimateRequests, existingHeartbeatUrl, worstCaseRunSeconds } from '../provision/lib/flow.mjs'
// @ts-expect-error plain .mjs helper
import { TABLES, seedTargets, catalog } from '../provision/lib/schema.mjs'

/* eslint-disable @typescript-eslint/no-explicit-any */
const O = { intervalMinutes: 10, retentionDays: 7, timeoutSeconds: 10, heartbeatUrl: null, sets: { target: 'owatch_targets', result: 'owatch_results' } }
const cd = buildClientData(O)
const A = cd.properties.definition.actions

describe('flow definition (clientdata) structure', () => {
  it('has the documented envelope', () => {
    expect(Object.keys(cd).sort()).toEqual(['properties', 'schemaVersion'])
    expect(cd.schemaVersion).toBe('1.0.0.0')
    expect(cd.properties.definition.$schema).toBe('https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#')
    expect(cd.properties.definition.contentVersion).toBe('1.0.0.0')
    expect(cd.properties.definition.parameters).toEqual({ $connections: { defaultValue: {}, type: 'Object' }, $authentication: { defaultValue: {}, type: 'SecureObject' } })
    expect(cd.properties.connectionReferences).toEqual({ shared_commondataserviceforapps: { runtimeSource: 'embedded', connection: { connectionReferenceLogicalName: 'owatch_dataverse' }, api: { name: 'shared_commondataserviceforapps' } } })
    expect(JSON.parse(JSON.stringify(cd))).toEqual(cd)       // plain JSON, round-trips
  })
  it('is scheduled, never overlaps itself', () => {
    const t = cd.properties.definition.triggers.Recurrence
    expect(t.type).toBe('Recurrence'); expect(t.recurrence).toEqual({ frequency: 'Minute', interval: 10 })
    expect(t.runtimeConfiguration.concurrency.runs).toBe(1)
  })
  it('probe: GET, no retries, explicit timeout, async polling off, URL only from the targets row', () => {
    const p = A.For_each_target.actions.Probe
    expect(p.type).toBe('Http'); expect(p.inputs.method).toBe('GET')
    expect(p.inputs.retryPolicy).toEqual({ type: 'none' })
    expect(p.limit.timeout).toBe('PT10S')
    expect(p.operationOptions).toBe('DisableAsyncPattern')
    expect(p.inputs.uri).toBe("@items('For_each_target')?['owatch_url']")
    expect(p.inputs.authentication).toBeUndefined()           // probes are unauthenticated: no credential can leak
    expect(p.inputs.body).toBeUndefined()
  })
  it('one failing probe never stops the others: Record runs after EVERY outcome of Probe', () => {
    const r = A.For_each_target.actions.Record
    expect([...r.runAfter.Probe].sort()).toEqual(['Failed', 'Skipped', 'Succeeded', 'TimedOut'])
    expect(A.For_each_target.runtimeConfiguration.concurrency.repetitions).toBe(50)      // all 36 probes in one parallel wave
    expect(A.For_each_target.operationOptions).toBeUndefined()                            // never 'Sequential'
    expect([...A.Prune_list.runAfter.For_each_target].sort()).toEqual(['Failed', 'Skipped', 'Succeeded', 'TimedOut'])
  })
  it('the probe flow stays dumb: raw facts plus ONE raw failure flag for the alert flow; no state, level or verdict is stored in results', () => {
    const p = A.For_each_target.actions.Record.inputs.parameters
    const cols = Object.keys(p).filter((k) => k.startsWith('item/')).map((k) => k.slice(5)).sort()
    expect(cols).toEqual(['owatch_elapsedms', 'owatch_errorkind', 'owatch_errormessage', 'owatch_failed', 'owatch_httpstatus', 'owatch_name', 'owatch_probedat', 'owatch_round'])
    const result = TABLES.find((t: any) => t.logical === 'owatch_result')
    const have = new Set(['owatch_name', ...result.columns.map((c: any) => c.SchemaName)])
    for (const c of cols) expect(have.has(c), c).toBe(true)
    expect([...have].some((c) => /state|level|verdict|health/.test(c))).toBe(false)
    expect(JSON.stringify(cd)).not.toMatch(/"(up|down|warning|suspect|degraded)"/)
    expect(p['item/owatch_httpstatus']).toBe("@outputs('Probe')?['statusCode']")
    expect(p['item/owatch_elapsedms']).toContain("ticks(")
  })
  it('prunes by the retention setting', () => {
    expect(A.Prune_list.inputs.parameters.$filter).toBe('owatch_probedat lt @{addDays(utcNow(), -7)}')
    expect(buildClientData({ ...O, retentionDays: 30 }).properties.definition.actions.Prune_list.inputs.parameters.$filter).toContain('-30')
    expect(A.Prune_each.actions.Delete_old.inputs.host.operationId).toBe('DeleteRecord')
  })
  it('expressions have balanced parentheses and quotes', () => {
    const walk = (v: any): string[] => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(walk) : [])
    for (const s of walk(cd).filter((x) => x.includes('@'))) {
      let depth = 0; let inStr = false
      for (const ch of s) { if (ch === "'") inStr = !inStr; else if (!inStr && ch === '(') depth++; else if (!inStr && ch === ')') depth-- ; expect(depth).toBeGreaterThanOrEqual(0) }
      expect(depth, s).toBe(0); expect(inStr, s).toBe(false)
    }
  })
  it('heartbeat: only when a URL is supplied, only after a fully written round, secured in run history', () => {
    expect(A.Heartbeat).toBeUndefined()
    const h = buildClientData({ ...O, heartbeatUrl: 'https://hc.example.com/x' }).properties.definition.actions.Heartbeat
    expect(h.runAfter).toEqual({ For_each_target: ['Succeeded'] })
    expect(h.runtimeConfiguration.secureData.properties).toEqual(['inputs', 'outputs'])
    expect(existingHeartbeatUrl(JSON.stringify(buildClientData({ ...O, heartbeatUrl: 'https://hc.example.com/x' })))).toBe('https://hc.example.com/x')
    expect(existingHeartbeatUrl(JSON.stringify(cd))).toBeNull()
    expect(existingHeartbeatUrl('not json')).toBeNull()
  })
  it('canonical() ignores key order', () => { expect(canonical({ a: 1, b: [{ d: 1, c: 2 }] })).toBe(canonical({ b: [{ c: 2, d: 1 }], a: 1 })) })
})

describe('usage estimate and run duration (36 services)', () => {
  it('default: 34 enabled targets every 10 minutes stays under 60% of a Premium licence', () => {
    expect(catalog.defaults.intervalMinutes).toBe(10)
    expect(estimateRequests(34, 10, false)).toMatchObject({ perRun: 108, runsPerDay: 144, perDay: 15552, pctOf40k: 39, rowsPerDay: 4896, high: false, over: false })
    expect(estimateRequests(36, 10, true)).toMatchObject({ perRun: 115, perDay: 16560, pctOf40k: 41, high: false })
  })
  it('the old 5-minute default would use 78% (flagged high); 3 minutes exceeds the licence (flagged over)', () => {
    expect(estimateRequests(34, 5, false)).toMatchObject({ perDay: 31104, pctOf40k: 78, high: true, over: false })
    expect(estimateRequests(36, 5, false)).toMatchObject({ perDay: 32832, pctOf40k: 82, high: true })
    expect(estimateRequests(34, 3, false)).toMatchObject({ over: true })
    expect(estimateRequests(15, 5, false).perDay).toBe(14688)          // the previous 15-target figure, for reference
  })
  it('one run fits well inside the interval because probes run in parallel, not one after another', () => {
    expect(PROBE_CONCURRENCY).toBe(50)
    expect(worstCaseRunSeconds(36, 10)).toBe(70)                        // one wave: one timeout + allowance
    expect(worstCaseRunSeconds(36, 10)).toBeLessThan((10 * 60) / 4)
    expect(36 * 10).toBeGreaterThan(5 * 60)                             // sequentially, 36 timeouts would NOT fit in 5 minutes
    expect(worstCaseRunSeconds(51, 10)).toBe(80)                        // more than 50 targets: a second wave
  })
})

describe('table metadata payloads', () => {
  it('every table: one primary name, publisher prefix, labels; every column typed', () => {
    for (const t of TABLES) {
      expect(t.create['@odata.type']).toBe('Microsoft.Dynamics.CRM.EntityMetadata')
      expect(t.create.SchemaName).toMatch(/^owatch_[a-z]+$/)
      expect(t.create.Attributes.filter((a: any) => a.IsPrimaryName)).toHaveLength(1)
      for (const c of t.columns) { expect(c.SchemaName).toMatch(/^owatch_[a-z]+$/); expect(c['@odata.type']).toMatch(/AttributeMetadata$/); expect(c.DisplayName.LocalizedLabels[0].LanguageCode).toBe(1033) }
    }
  })
  it('seed rows only use columns that exist and fit their max length', () => {
    const t = TABLES.find((x: any) => x.logical === 'owatch_target')
    const max: Record<string, number> = { owatch_name: 100 }
    for (const c of t.columns) if (c.MaxLength) max[c.SchemaName] = c.MaxLength
    const cols = new Set(['owatch_name', ...t.columns.map((c: any) => c.SchemaName)])
    for (const r of seedTargets('contoso')) for (const [k, v] of Object.entries(r)) { expect(cols.has(k)).toBe(true); if (typeof v === 'string') expect(v.length).toBeLessThanOrEqual(max[k]) }
    expect(seedTargets(null)).toHaveLength(36); expect(seedTargets('contoso')).toHaveLength(36)
    expect(seedTargets(null).filter((r: any) => r.owatch_enabled)).toHaveLength(catalog.targets.length)
  })
})
