/**
 * Column limits. Written after the third real-tenant run failed with
 *   0x80044331 "The length of the 'owatch_value' attribute of the 'owatch_setting' entity exceeded the maximum allowed length of '400'"
 * (the seeded roles_json setting was 618 characters). These tests check EVERY value the provisioner or the flow
 * can write against the column definitions in provision/lib/schema.mjs, and the mock Dataverse now enforces the
 * limits the way the real service does, so this class of mistake fails here instead of on a tenant.
 */
import { afterEach, describe, expect, it } from 'vitest'
import catalog from '../shared/catalog.json'
// @ts-expect-error plain .mjs helpers
import { createClient } from '../provision/lib/client.mjs'
// @ts-expect-error plain .mjs helpers
import { createMockDataverse } from '../provision/lib/mock-dataverse.mjs'
// @ts-expect-error plain .mjs helpers
import { apply } from '../provision/lib/provision.mjs'
// @ts-expect-error plain .mjs helpers
import { ROUND_FORMAT, buildClientData } from '../provision/lib/flow.mjs'
// @ts-expect-error plain .mjs helpers
import { RETIRED_SETTINGS, TABLES, assertRowFits, columnSpec, rowViolations, seedSettings, seedTargets } from '../provision/lib/schema.mjs'

/* eslint-disable @typescript-eslint/no-explicit-any */
const OPTS = { intervalMinutes: 10, retentionDays: 7, timeoutSeconds: 10, tenant: null as string | null, connectionId: 'aaaaaaaabbbbccccddddeeeeeeeeeeee', heartbeatUrl: null }
const closers: (() => Promise<void>)[] = []
afterEach(async () => { while (closers.length) await closers.pop()!() })
async function env(o: any = {}) {
  const mock = createMockDataverse(o); const srv = await mock.listen(); closers.push(srv.close)
  return { mock, client: createClient({ orgUrl: srv.url, token: mock.token, sleep: async () => {} }) }
}
const LONGEST_TENANT = 'a' + 'b'.repeat(61) + 'c'          // 63 characters: the longest name valid_tenant() accepts

describe('column definitions', () => {
  it('are exactly the limits the tables are created with', () => {
    expect(columnSpec('owatch_target')).toMatchObject({ owatch_name: { type: 'String', maxLength: 100, required: true }, owatch_url: { maxLength: 500 }, owatch_alivecodes: { maxLength: 200 }, owatch_family: { maxLength: 100 }, owatch_enabled: { type: 'Boolean' } })
    expect(columnSpec('owatch_setting')).toMatchObject({ owatch_name: { maxLength: 100, required: true }, owatch_value: { type: 'String', maxLength: 400 } })
    expect(columnSpec('owatch_result')).toMatchObject({ owatch_name: { maxLength: 100 }, owatch_errorkind: { maxLength: 100 }, owatch_round: { maxLength: 40 }, owatch_httpstatus: { type: 'Integer', min: 0, max: 999 }, owatch_elapsedms: { type: 'Integer', min: 0, max: 2147483647 }, owatch_probedat: { type: 'DateTime' } })
  })
  it('existing String columns are never widened or changed: the fix must work on tables that already exist', () => {
    // these numbers are what the user's environment already has; changing one here would NOT change the live column
    const max = (t: string, c: string) => columnSpec(t)[c].maxLength
    expect([max('owatch_setting', 'owatch_value'), max('owatch_target', 'owatch_url'), max('owatch_result', 'owatch_errorkind'), max('owatch_result', 'owatch_round')]).toEqual([400, 500, 100, 40])
    expect(TABLES.flatMap((t: any) => t.columns).some((c: any) => c.AttributeType === 'Memo')).toBe(false)   // no new column type was needed
  })
})

describe('root cause, pinned', () => {
  it('the roles list is 618 characters as JSON: it can never fit a 400-character setting, so it is no longer seeded', () => {
    const json = JSON.stringify(catalog.roles)
    expect(json.length).toBe(618)
    expect(rowViolations('owatch_setting', { owatch_name: 'roles_json', owatch_value: json })).toEqual(['owatch_setting.owatch_value: 618 characters, maximum 400'])
    expect(seedSettings({ ...OPTS, heartbeat: false }).map((s: any) => s.name)).not.toContain('roles_json')
    expect(RETIRED_SETTINGS[0].name).toBe('roles_json')
    expect(JSON.stringify(catalog.previousRoles[0]).length).toBeLessThanOrEqual(400)      // the 7-role v1 default did fit: that is why v1 never hit this
  })
  it('the mock Dataverse now rejects it exactly like the tenant did (0x80044331), and writes nothing', async () => {
    const { mock, client } = await env()
    await apply(client, OPTS)
    const before = mock.db.owatch_settings.length
    const e: any = await client.post('owatch_settings', { owatch_name: 'roles_json', owatch_value: JSON.stringify(catalog.roles) }).catch((x: unknown) => x)
    expect(e.status).toBe(400)
    expect(e.message).toContain("The length of the 'owatch_value' attribute of the 'owatch_setting' entity exceeded the maximum allowed length of '400'")
    expect(e.message).toContain('0x80044331')
    expect(mock.db.owatch_settings.length).toBe(before)
  })
})

describe('EVERY value the provisioner can write fits its column', () => {
  it('all 36 target rows, for no tenant, a normal tenant and the longest valid tenant name', () => {
    for (const tenant of [null, 'contoso', LONGEST_TENANT]) {
      const rows = seedTargets(tenant)
      expect(rows).toHaveLength(36)
      for (const r of rows) expect(rowViolations('owatch_target', r), `${r.owatch_name} (${tenant})`).toEqual([])
    }
    const longestUrl = Math.max(...seedTargets(LONGEST_TENANT).map((r: any) => r.owatch_url.length))
    expect(longestUrl).toBeLessThanOrEqual(500)
    expect(Math.max(...catalog.families.map((f) => (f[0] as string).length))).toBeLessThanOrEqual(100)
  })
  it('all settings, at both extremes of every option, plus the flow id', () => {
    for (const o of [{ intervalMinutes: 1, retentionDays: 1, timeoutSeconds: 2, heartbeat: false }, { intervalMinutes: 60, retentionDays: 90, timeoutSeconds: 60, heartbeat: true }]) {
      const all = [...seedSettings(o), { name: 'flow_workflowid', value: '00000000-0000-0000-0000-000000000000' }]
      for (const s of all) expect(rowViolations('owatch_setting', { owatch_name: s.name, owatch_value: s.value }), s.name).toEqual([])
      expect(Math.max(...all.map((s: any) => s.value.length))).toBeLessThanOrEqual(36)          // nothing is even close to 400 any more
    }
  })
  it('renames written during the upgrade fit', () => {
    for (const n of Object.values(catalog.renamed)) expect(rowViolations('owatch_target', { owatch_name: n }, { partial: true })).toEqual([])
  })
  it('a row that would not fit is refused locally, with the column named, before anything is sent', () => {
    expect(() => assertRowFits('owatch_setting', { owatch_name: 'x', owatch_value: 'y'.repeat(401) })).toThrow(/owatch_setting\.owatch_value: 401 characters, maximum 400/)
    expect(() => assertRowFits('owatch_target', { owatch_url: 'https://a.example/' })).toThrow(/owatch_name: required/)
    expect(() => assertRowFits('owatch_target', { owatch_name: 'a', owatch_nope: 1 })).toThrow(/no such column/)
    expect(rowViolations('owatch_result', { owatch_name: 'a', owatch_httpstatus: 1000 })).toEqual(['owatch_result.owatch_httpstatus: 1000 is outside 0..999'])
    expect(rowViolations('owatch_result', { owatch_name: 'a', owatch_httpstatus: null, owatch_errorkind: '' })).toEqual([])
  })
  it('a complete deployment passes with the limits enforced (first run, re-run, with a tenant, with the longest tenant)', async () => {
    for (const tenant of [null, LONGEST_TENANT]) {
      const { mock, client } = await env()
      const r = await apply(client, { ...OPTS, tenant })
      expect(r.flowOn).toBe(true)
      await apply(client, { ...OPTS, tenant })
      expect(mock.problems).toEqual([])                      // includes: every row the simulated flow run wrote fits its columns
      expect(mock.db.owatch_settings.every((s: any) => (s.owatch_value ?? '').length <= 400)).toBe(true)
    }
  })
})

describe('re-running on top of the failed run (the user\'s environment)', () => {
  it('tables, 36 targets, connection reference and the flow exist; 10 settings exist; flow is OFF: the re-run only finishes the job', async () => {
    const { mock, client } = await env()
    await apply(client, OPTS)
    // rewind to exactly where the real run stopped: the 10 settings before roles_json were created, nothing after; flow created but never turned on
    const kept = ['interval_minutes', 'retention_days', 'probe_timeout_seconds', 'schema_version', 'heartbeat_configured', 'confirm', 'factor', 'floor_ms', 'slow_ms', 'recover_after']
    mock.db.owatch_settings = mock.db.owatch_settings.filter((s: any) => kept.includes(s.owatch_name))
    expect(mock.db.owatch_settings).toHaveLength(10)
    mock.db.workflows[0].statecode = 0
    mock.db.owatch_results.length = 0
    const flowId = mock.db.workflows[0].workflowid
    mock.log.length = 0

    const r = await apply(client, OPTS)
    const writes = mock.log.filter((l: any) => l.method !== 'GET').map((l: any) => `${l.method} ${l.path.replace(/\(.*/, '')}`)
    expect([...new Set(writes)].sort()).toEqual(['PATCH workflows', 'POST owatch_settings'])   // settings completed (flow id + the newer alert_* rows), flow turned on. No table, target or flow is created.
    expect(writes.filter((w: string) => w === 'PATCH workflows')).toHaveLength(1)
    expect(mock.db.workflows).toHaveLength(1); expect(mock.db.workflows[0].workflowid).toBe(flowId); expect(mock.db.workflows[0].statecode).toBe(1)
    expect(mock.db.owatch_targets).toHaveLength(36); expect(mock.entities.size).toBe(4)
    expect(mock.db.owatch_settings.find((s: any) => s.owatch_name === 'flow_workflowid').owatch_value).toBe(flowId)
    expect(mock.db.owatch_settings.find((s: any) => s.owatch_name === 'roles_json')).toBeUndefined()
    expect(r.flowOn).toBe(true); expect(r.created.every((c: string) => c.startsWith('setting '))).toBe(true); expect(r.created).toContain('setting flow_workflowid')
    expect(mock.db.owatch_results).toHaveLength(34)                                     // the (simulated) first run wrote one row per enabled target
    expect(mock.problems).toEqual([])
  })
})

describe('the FLOW can never write a value that does not fit (checked on the generated definition)', () => {
  const cd = buildClientData({ ...OPTS, heartbeatUrl: null, sets: { target: 'owatch_targets', result: 'owatch_results' } })
  const rec = cd.properties.definition.actions.For_each_target.actions.Record.inputs.parameters as Record<string, string>
  const lim = columnSpec('owatch_result')
  const cols = Object.keys(rec).filter((k) => k.startsWith('item/')).map((k) => k.slice(5))

  it('writes only columns that exist in the result table, and every column it writes is accounted for below', () => {
    for (const c of cols) expect(lim[c], c).toBeDefined()
    expect(cols.sort()).toEqual(['owatch_elapsedms', 'owatch_errorkind', 'owatch_errormessage', 'owatch_failed', 'owatch_httpstatus', 'owatch_name', 'owatch_probedat', 'owatch_round'])
  })
  it('unbounded text (target name, error code of a failed HTTP action) is cut with take(string(..), N), N = the column length', () => {
    for (const c of ['owatch_name', 'owatch_errorkind', 'owatch_errormessage']) {
      const m = /^@take\(string\((.+)\),(\d+)\)$/.exec(rec['item/' + c])
      expect(m, `${c}: ${rec['item/' + c]}`).not.toBeNull()
      expect(Number(m![2])).toBe(lim[c].maxLength)
    }
    expect(rec['item/owatch_errorkind']).toContain("actions('Probe')?['code']")
  })
  it('the round id has a fixed width that fits', () => {
    expect(cd.properties.definition.actions.Round.inputs).toBe(`@utcNow('${ROUND_FORMAT}')`)
    expect(rec['item/owatch_round']).toBe("@outputs('Round')")
    expect(ROUND_FORMAT.length).toBe(20)
    expect(new Date(0).toISOString().replace(/\.\d+Z$/, 'Z').length).toBe(ROUND_FORMAT.length)    // 1970-01-01T00:00:00Z
    expect(ROUND_FORMAT.length).toBeLessThanOrEqual(lim.owatch_round.maxLength)
  })
  it('elapsed time is clamped to the integer column; the HTTP status is a protocol-bounded integer inside the column range', () => {
    expect(rec['item/owatch_elapsedms'].startsWith(`@max(${lim.owatch_elapsedms.min},min(${lim.owatch_elapsedms.max},div(`)).toBe(true)
    expect(rec['item/owatch_httpstatus']).toBe("@outputs('Probe')?['statusCode']")
    expect(lim.owatch_httpstatus.min).toBeLessThanOrEqual(100); expect(lim.owatch_httpstatus.max).toBeGreaterThanOrEqual(599)   // HTTP status codes are 100..599
    expect(rec['item/owatch_probedat']).toBe('@utcNow()')
  })
  it('what those expressions produce at their worst still fits (take / clamp replayed in JS, then written to the mock)', async () => {
    const { mock, client } = await env({ autoRun: false })
    await apply(client, OPTS)
    const take = (v: unknown, n: number) => String(v).slice(0, n)
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
    const worst = {
      owatch_name: take('n'.repeat(5000), lim.owatch_name.maxLength), owatch_errorkind: take('E'.repeat(5000), lim.owatch_errorkind.maxLength),
      owatch_httpstatus: 599, owatch_elapsedms: clamp(9e15, lim.owatch_elapsedms.min, lim.owatch_elapsedms.max), owatch_probedat: new Date().toISOString(), owatch_round: '2026-11-15T08:30:00Z',
    }
    expect(rowViolations('owatch_result', worst)).toEqual([])
    await client.post('owatch_results', worst)
    await client.post('owatch_results', { ...worst, owatch_httpstatus: null, owatch_errorkind: '', owatch_elapsedms: 0 })      // no HTTP answer at all
    // ...and the mock really would have caught the unbounded versions
    await expect(client.post('owatch_results', { ...worst, owatch_errorkind: 'E'.repeat(101) })).rejects.toThrow(/0x80044331/)
    await expect(client.post('owatch_results', { ...worst, owatch_elapsedms: 2147483648 })).rejects.toThrow(/outside the valid range/)
    await expect(client.post('owatch_results', { owatch_httpstatus: 200 })).rejects.toThrow(/Required field 'owatch_name'/)
    await expect(client.patch(`owatch_targets(${mock.db.owatch_targets[0].owatch_targetid})`, { owatch_url: 'https://' + 'x'.repeat(500) })).rejects.toThrow(/0x80044331/)
    expect(mock.db.owatch_results).toHaveLength(2)
  })
  it('every Dataverse action of the flow names an existing entity set and only existing columns', () => {
    const walk = (a: any): any[] => Object.values(a ?? {}).flatMap((x: any) => [x, ...walk(x.actions)])
    const dv = walk(cd.properties.definition.actions).filter((x: any) => x.type === 'OpenApiConnection')
    expect(dv.map((x: any) => x.inputs.host.operationId).sort()).toEqual(['CreateRecord', 'DeleteRecord', 'ListRecords', 'ListRecords'])
    const tcols = Object.keys(columnSpec('owatch_target')); const rcols = [...Object.keys(lim), 'owatch_resultid']
    for (const x of dv) {
      const p = x.inputs.parameters
      expect(['owatch_targets', 'owatch_results']).toContain(p.entityName)
      const known = p.entityName === 'owatch_targets' ? [...tcols, 'statecode'] : rcols
      for (const c of String(p.$select ?? '').split(',').filter(Boolean)) expect(known, `${p.entityName} $select ${c}`).toContain(c)
      for (const c of String(p.$filter ?? '').match(/\bowatch_[a-z]+\b/g) ?? []) expect(known, `${p.entityName} $filter ${c}`).toContain(c)
    }
  })
})
