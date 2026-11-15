/**
 * Provisioning request-sequence tests against a mock Dataverse over REAL local HTTP
 * (provision/lib/mock-dataverse.mjs). This verifies sequence, idempotency, payload shapes and failure handling.
 * It does NOT prove a real tenant accepts the payloads - nothing here has been run against a real environment.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error plain .mjs helpers without type declarations
import { createClient } from '../provision/lib/client.mjs'
// @ts-expect-error plain .mjs helpers without type declarations
// @ts-expect-error plain .mjs helper without type declarations
import { DataverseError } from '../provision/lib/client.mjs'
import { createMockDataverse } from '../provision/lib/mock-dataverse.mjs'
// @ts-expect-error plain .mjs helpers without type declarations
import { apply, smoke, uninstall, NeedsConnection, FlowNotOn, isTransientMetadata, isStaleSchema } from '../provision/lib/provision.mjs'

/* eslint-disable @typescript-eslint/no-explicit-any */
const OPTS = { intervalMinutes: 10, retentionDays: 7, timeoutSeconds: 10, tenant: null, connectionId: 'aaaaaaaabbbbccccddddeeeeeeeeeeee', heartbeatUrl: null as string | null }
const closers: (() => Promise<void>)[] = []
afterEach(async () => { while (closers.length) await closers.pop()!() })

async function env(mockOpts: any = {}) {
  const mock = createMockDataverse(mockOpts)
  const srv = await mock.listen()
  closers.push(srv.close)
  const client = createClient({ orgUrl: srv.url, token: mock.token, sleep: async () => {} })
  return { mock, srv, client }
}
const writes = (mock: any) => mock.log.filter((l: any) => l.method !== 'GET')

describe('apply (first deployment into an empty environment)', () => {
  it('creates publisher, solution, 4 tables, 36 targets (34 enabled), connection reference, flow, settings, and turns the flow on', async () => {
    const { mock, client } = await env()
    const r = await apply(client, OPTS)
    expect(mock.problems).toEqual([])
    expect(r.flowOn).toBe(true)
    expect(r.targets).toBe(37); expect(r.enabledTargets).toBe(34)
    expect(r.unconfigured).toEqual(['onedrive-business', 'sharepoint-admin', 'sharepoint-online'])
    expect(r.estimate).toMatchObject({ perRun: 108, runsPerDay: 144, perDay: 15552, pctOf40k: 39, high: false })
    expect(r.worstCaseRunSeconds).toBeLessThan(10 * 60 / 4)
    expect([...mock.entities.keys()].sort()).toEqual(['owatch_incident', 'owatch_result', 'owatch_setting', 'owatch_target'])
    expect(mock.db.owatch_targets).toHaveLength(37)
    expect(mock.db.workflows).toHaveLength(1)
    expect(mock.db.workflows[0].statecode).toBe(1)
    expect(mock.db.connectionreferences[0].connectionid).toBe(OPTS.connectionId)
    // order: access check first; tables before rows; connection reference before the flow; activation last
    const paths = mock.log.map((l: any) => `${l.method} ${l.path}`)
    expect(paths[0]).toBe('GET WhoAmI')
    const idx = (s: string) => paths.findIndex((p: string) => p.startsWith(s))
    expect(idx('POST publishers')).toBeLessThan(idx('POST solutions'))
    expect(idx('POST solutions')).toBeLessThan(idx('POST EntityDefinitions'))
    expect(idx('POST PublishXml')).toBeLessThan(idx('POST owatch_targets'))
    expect(idx('POST connectionreferences')).toBeLessThan(idx('POST workflows'))
    expect(paths.filter((p: string) => !p.includes('owatch_settings')).pop()).toMatch(/^(PATCH workflows\(|GET (workflows|connectionreferences))/)   // turning the probe flow on is the last change before the (unconfigured) alert step
    expect(r.alerts.status).toBe('not-configured')
    // every metadata / flow / connection-reference create is solution-aware
    for (const l of mock.log.filter((x: any) => x.method === 'POST' && /^(EntityDefinitions|workflows|connectionreferences)/.test(x.path))) expect(l.solution).toBe('OutageWatch')
  })

  it('seeds alive codes exactly like DEFAULT_TARGETS (empty = any answer below 500 except 429)', async () => {
    const { mock, client } = await env()
    await apply(client, OPTS)
    const by = Object.fromEntries(mock.db.owatch_targets.map((t: any) => [t.owatch_name, t]))
    expect(by.auth.owatch_alivecodes).toBe('200')
    expect(by.exchange.owatch_alivecodes).toBe('200,401,403')
    expect(by.graph.owatch_alivecodes).toBe('200,401,403')
    expect(by.teams.owatch_alivecodes).toBeNull()               // '' is stored as null: any answer below 500 except 429
    expect(by.auth.owatch_dependsonauth).toBe(false)
    expect(by.teams.owatch_dependsonauth).toBe(true)
    expect(by['copilot-web'].owatch_dependsonauth).toBe(false)
    expect(by['copilot-substrate'].owatch_copilotneeds).toBe(true)
    const tenant = mock.db.owatch_targets.filter((t: any) => ['sharepoint-online', 'onedrive-business', 'sharepoint-admin'].includes(t.owatch_name))
    const fixed = mock.db.owatch_targets.filter((t: any) => !tenant.includes(t))
    expect(fixed).toHaveLength(34)
    expect(fixed.every((t: any) => t.owatch_enabled === true && /^https:\/\//.test(t.owatch_url) && t.owatch_family)).toBe(true)
    // without a tenant name: seeded DISABLED with no URL = "needs tenant name"; the flow's filter can never pick them up
    expect(tenant).toHaveLength(3)
    expect(tenant.every((t: any) => t.owatch_enabled === false && t.owatch_url === null && t.owatch_dependsonauth === true)).toBe(true)
    expect(by['power-bi'].owatch_family).toBe('Power Platform & dashboards')
    expect(by['teams-cdn'].owatch_dependsonauth).toBe(false); expect(by['onedrive-sync'].owatch_dependsonauth).toBe(false)
    const filter = JSON.parse(mock.db.workflows[0].clientdata).properties.definition.actions.List_targets.inputs.parameters.$filter
    expect(filter).toContain('owatch_enabled eq true'); expect(filter).toContain('owatch_url ne null')
  })

  it('enables the two tenant targets when a tenant name is given - on a first deploy or later', async () => {
    const { mock, client } = await env()
    const r = await apply(client, { ...OPTS, tenant: 'contoso' })
    expect(r.targets).toBe(37); expect(r.enabledTargets).toBe(37); expect(r.unconfigured).toEqual([])
    const od = mock.db.owatch_targets.find((t: any) => t.owatch_name === 'onedrive-business')
    expect(od.owatch_url).toBe('https://contoso-my.sharepoint.com/'); expect(od.owatch_enabled).toBe(true)

    const b = await env()
    await apply(b.client, OPTS)                                   // first without a tenant name
    const r2 = await apply(b.client, { ...OPTS, tenant: 'fabrikam' })
    expect(r2.updated).toEqual(expect.arrayContaining(['target sharepoint-online configured for the tenant', 'target onedrive-business configured for the tenant']))
    expect(b.mock.db.owatch_targets).toHaveLength(37)
    const sp = b.mock.db.owatch_targets.find((t: any) => t.owatch_name === 'sharepoint-online')
    expect(sp.owatch_url).toBe('https://fabrikam.sharepoint.com/'); expect(sp.owatch_enabled).toBe(true)
    // a later run with another (or no) tenant name never overwrites a URL that is already there
    await apply(b.client, { ...OPTS, tenant: 'other' }); await apply(b.client, OPTS)
    expect(b.mock.db.owatch_targets.find((t: any) => t.owatch_name === 'sharepoint-online').owatch_url).toBe('https://fabrikam.sharepoint.com/')
    expect(b.mock.problems).toEqual([])
  })
})

describe('idempotency (re-run = upgrade, never a duplicate)', () => {
  it('a second identical run performs ZERO writes', async () => {
    const { mock, client } = await env()
    await apply(client, OPTS)
    mock.log.length = 0
    const r = await apply(client, OPTS)
    expect(writes(mock)).toEqual([])
    expect(r.created).toEqual([]); expect(r.updated).toEqual([])
    expect(mock.db.workflows).toHaveLength(1); expect(mock.db.owatch_targets).toHaveLength(37)
    expect(mock.problems).toEqual([])
  })

  it('does not overwrite targets or thresholds an admin edited, but does follow deployment settings', async () => {
    const { mock, client } = await env()
    await apply(client, OPTS)
    mock.db.owatch_targets.find((t: any) => t.owatch_name === 'teams').owatch_enabled = false
    mock.db.owatch_settings.find((s: any) => s.owatch_name === 'confirm').owatch_value = '3'
    mock.log.length = 0
    await apply(client, { ...OPTS, intervalMinutes: 15 })
    expect(mock.db.owatch_targets.find((t: any) => t.owatch_name === 'teams').owatch_enabled).toBe(false)
    expect(mock.db.owatch_settings.find((s: any) => s.owatch_name === 'confirm').owatch_value).toBe('3')
    expect(mock.db.owatch_settings.find((s: any) => s.owatch_name === 'interval_minutes').owatch_value).toBe('15')
    // definition changed: OFF -> patch definition -> ON, in that order, and still one flow
    const w = writes(mock).filter((l: any) => l.path.startsWith('workflows')).length
    expect(w).toBe(3)
    expect(mock.db.workflows).toHaveLength(1)
    expect(mock.db.workflows[0].statecode).toBe(1)
    expect(JSON.parse(mock.db.workflows[0].clientdata).properties.definition.triggers.Recurrence.recurrence.interval).toBe(15)
    expect(mock.problems).toEqual([])
  })

  it('resumes after a partial run (stopped after the tables) without duplicating anything', async () => {
    const { mock, client } = await env()
    await expect(apply(client, { ...OPTS, connectionId: null })).rejects.toBeInstanceOf(NeedsConnection)
    expect(mock.db.workflows).toHaveLength(0)
    expect(mock.db.owatch_targets).toHaveLength(37)
    const r = await apply(client, OPTS)
    expect(r.flowOn).toBe(true)
    expect(mock.db.owatch_targets).toHaveLength(37)
    expect(mock.db.publishers).toHaveLength(1); expect(mock.db.solutions).toHaveLength(1)
    expect(r.created.some((c: string) => c.startsWith('table'))).toBe(false)
    expect(mock.problems).toEqual([])
  })

  it('adds a column that is missing from an older deployment (schema upgrade)', async () => {
    const { mock, client } = await env()
    await apply(client, OPTS)
    mock.entities.get('owatch_target').attributes.delete('owatch_copilotneeds')
    const r = await apply(client, OPTS)
    expect(r.created).toEqual(['column owatch_target.owatch_copilotneeds'])
  })

  it('reads the entity set name back instead of assuming a plural', async () => {
    const { mock, client } = await env({ entitySetSuffix: 'es' })
    const r = await apply(client, OPTS)
    expect(r.entitySets.owatch_result).toBe('owatch_resultes')
    const cd = JSON.parse(mock.db.workflows[0].clientdata)
    expect(cd.properties.definition.actions.For_each_target.actions.Record.inputs.parameters.entityName).toBe('owatch_resultes')
    expect(mock.problems).toEqual([])
  })
})

describe('upgrade from the 15-target version (v1)', () => {
  const V1 = ['auth', 'exchange', 'outlook-web', 'teams', 'm365-portal', 'admin-center', 'graph', 'power-platform', 'intune', 'm365-copilot', 'copilot-substrate', 'copilot-studio', 'copilot-web', 'github-copilot', 'office-cdn']
  const V1_ROLES = { 'Email & calendar': ['auth', 'exchange', 'outlook-web'], Meetings: ['auth', 'teams'], 'Files & sharing': ['auth', 'sharepoint', 'onedrive'], 'Copilot assistance': ['auth', 'm365-copilot', 'copilot-substrate'], 'Admin tasks': ['auth', 'admin-center', 'graph'], 'Device management': ['auth', 'intune'], 'Low-code apps': ['auth', 'power-platform'] }
  /** Brings a fresh mock into the shape a v1 deployment left behind (no family column, 15 or 17 targets, old names, old roles). */
  async function v1(withTenant: boolean) {
    const e = await env()
    await apply(e.client, { ...OPTS, intervalMinutes: 5, tenant: withTenant ? 'contoso' : null })
    const db = e.mock.db
    e.mock.entities.get('owatch_target').attributes.delete('owatch_family')
    db.owatch_targets = db.owatch_targets.filter((t: any) => V1.includes(t.owatch_name) || (withTenant && ['sharepoint-online', 'onedrive-business'].includes(t.owatch_name)))
    for (const t of db.owatch_targets) { delete t.owatch_family; if (t.owatch_name === 'sharepoint-online') t.owatch_name = 'sharepoint'; if (t.owatch_name === 'onedrive-business') t.owatch_name = 'onedrive' }
    db.owatch_settings.push({ owatch_settingid: '55555555-5555-5555-5555-555555555555', owatch_name: 'roles_json', owatch_value: JSON.stringify(V1_ROLES) })   // 332 characters: it fitted in v1
    db.owatch_settings.find((s: any) => s.owatch_name === 'schema_version').owatch_value = '1'
    db.owatch_results.push({ owatch_resultid: '99999999-9999-9999-9999-999999999999', owatch_name: 'sharepoint', owatch_httpstatus: 200, owatch_elapsedms: 90, owatch_probedat: '2026-11-01T00:00:00.000Z', owatch_round: 'old' })
    e.mock.log.length = 0
    return e
  }

  it('v1 with tenant targets: renames the two rows in place (same id, URL, enabled), adds 19 new ones + the sharepoint-admin placeholder, no duplicates, history untouched', async () => {
    const { mock, client } = await v1(true)
    expect(mock.db.owatch_targets).toHaveLength(17)
    const spId = mock.db.owatch_targets.find((t: any) => t.owatch_name === 'sharepoint').owatch_targetid
    const r = await apply(client, OPTS)                                    // note: no -TenantName on the upgrade run
    const names = mock.db.owatch_targets.map((t: any) => t.owatch_name)
    expect(names).toHaveLength(37); expect(new Set(names).size).toBe(37)
    expect(names).not.toContain('sharepoint'); expect(names).not.toContain('onedrive')
    const sp = mock.db.owatch_targets.find((t: any) => t.owatch_name === 'sharepoint-online')
    expect(sp.owatch_targetid).toBe(spId); expect(sp.owatch_url).toBe('https://contoso.sharepoint.com/'); expect(sp.owatch_enabled).toBe(true)
    expect(r.updated).toEqual(expect.arrayContaining(['target sharepoint renamed to sharepoint-online', 'target onedrive renamed to onedrive-business']))
    expect(r.created.filter((c: string) => c.startsWith('target '))).toHaveLength(20)
    expect(r.created).toContain('column owatch_target.owatch_family')
    expect(r.enabledTargets).toBe(36); expect(r.unconfigured).toEqual(['sharepoint-admin'])   // new in this version: waits for a tenant name (the upgrade run had none)
    expect(mock.db.owatch_results.find((x: any) => x.owatch_round === 'old')).toMatchObject({ owatch_name: 'sharepoint', owatch_httpstatus: 200 })   // history is not rewritten or deleted
    expect(mock.log.some((l: any) => l.method !== 'GET' && l.path.startsWith('owatch_results'))).toBe(false)
    expect(mock.problems).toEqual([])
    mock.log.length = 0
    await apply(client, OPTS)
    expect(writes(mock)).toEqual([])                                        // and the upgrade itself is idempotent
  })

  it('v1 without tenant targets: adds 19 + the two disabled placeholders; admin edits to old rows survive', async () => {
    const { mock, client } = await v1(false)
    expect(mock.db.owatch_targets).toHaveLength(15)
    mock.db.owatch_targets.find((t: any) => t.owatch_name === 'teams').owatch_url = 'https://teams.example.test/custom'
    const r = await apply(client, OPTS)
    expect(mock.db.owatch_targets).toHaveLength(37)
    expect(r.enabledTargets).toBe(34); expect(r.unconfigured).toEqual(['onedrive-business', 'sharepoint-admin', 'sharepoint-online'])
    expect(mock.db.owatch_targets.find((t: any) => t.owatch_name === 'teams').owatch_url).toBe('https://teams.example.test/custom')
    expect(mock.problems).toEqual([])
  })

  it('roles: the shipped v1 default row is removed (the dashboard has the current list built in); an admin-edited list is left alone', async () => {
    const a = await v1(false)
    const r = await apply(a.client, OPTS)
    expect(a.mock.db.owatch_settings.find((s: any) => s.owatch_name === 'roles_json')).toBeUndefined()
    expect(r.updated.join(' ')).toContain('roles_json removed')
    const b = await v1(false)
    b.mock.db.owatch_settings.find((s: any) => s.owatch_name === 'roles_json').owatch_value = '{"Mine":["auth"]}'
    await apply(b.client, OPTS)
    expect(b.mock.db.owatch_settings.find((s: any) => s.owatch_name === 'roles_json').owatch_value).toBe('{"Mine":["auth"]}')
  })

  it('the interval follows the new default (5 -> 10 min) and the flow definition is updated in place', async () => {
    const { mock, client } = await v1(false)
    await apply(client, OPTS)
    expect(mock.db.workflows).toHaveLength(1)
    expect(JSON.parse(mock.db.workflows[0].clientdata).properties.definition.triggers.Recurrence.recurrence.interval).toBe(10)
    expect(mock.db.owatch_settings.find((s: any) => s.owatch_name === 'interval_minutes').owatch_value).toBe('10')
    expect(mock.db.owatch_settings.find((s: any) => s.owatch_name === 'schema_version').owatch_value).toBe('3')
  })

  it('both an old and a new row exist: the old one is disabled, not deleted, and a note is returned', async () => {
    const { mock, client } = await env()
    await apply(client, { ...OPTS, tenant: 'contoso' })
    const set = mock.db.owatch_targets
    set.push({ ...set.find((t: any) => t.owatch_name === 'sharepoint-online'), owatch_targetid: '77777777-7777-7777-7777-777777777777', owatch_name: 'sharepoint' })
    const r = await apply(client, OPTS)
    expect(set.find((t: any) => t.owatch_name === 'sharepoint').owatch_enabled).toBe(false)
    expect(r.warnings.join(' ')).toContain('sharepoint')
    expect(r.enabledTargets).toBe(37)
  })
})

describe('heartbeat (dead man\'s switch)', () => {
  const URL_ = 'https://hc-ping.example.com/3f2c-secret-uuid'
  it('is absent by default, added when supplied, kept across an upgrade without the flag, removed on request', async () => {
    const { mock, client } = await env()
    await apply(client, OPTS)
    const hb = () => JSON.parse(mock.db.workflows[0].clientdata).properties.definition.actions.Heartbeat
    expect(hb()).toBeUndefined()
    await apply(client, { ...OPTS, heartbeatUrl: URL_ })
    expect(hb().inputs.uri).toBe(URL_)
    expect(hb().runtimeConfiguration.secureData.properties).toEqual(['inputs', 'outputs'])
    mock.log.length = 0
    const r = await apply(client, OPTS)
    expect(hb().inputs.uri).toBe(URL_)
    expect(writes(mock)).toEqual([])
    expect(r.heartbeat).toBe(true)
    await apply(client, { ...OPTS, clearHeartbeat: true })
    expect(hb()).toBeUndefined()
    expect(mock.db.owatch_settings.find((s: any) => s.owatch_name === 'heartbeat_configured').owatch_value).toBe('no')
  })
  it('never appears in log output, results or settings', async () => {
    const { mock, client } = await env()
    const lines: string[] = []
    const r = await apply(client, { ...OPTS, heartbeatUrl: URL_ }, (t: string) => lines.push(t))
    expect(lines.join('\n')).not.toContain('secret-uuid')
    expect(JSON.stringify(r)).not.toContain('secret-uuid')
    expect(JSON.stringify(mock.db.owatch_settings)).not.toContain('secret-uuid')
  })
})

describe('transient Dataverse metadata errors (real first-run failure: HTTP 400 "An unexpected error occurred" on a new column)', () => {
  it('retries with backoff, logs it, and completes without duplicates', async () => {
    const { mock, client } = await env()
    mock.state.transientAttrFails = 3
    const lines: string[] = []
    const r = await apply(client, OPTS, (x: string) => lines.push(x))
    expect(r.flowOn).toBe(true)
    expect(lines.filter((l) => l.includes('unexpected error')).length).toBe(3)
    expect(mock.problems).toEqual([])
    expect(mock.entities.get('owatch_result').attributes.has('owatch_httpstatus')).toBe(true)
  })

  it('a column that WAS created although the reply was an error is not retried into a duplicate error', async () => {
    const { mock, client } = await env()
    mock.state.attrFailsAfterCreate = 2
    const lines: string[] = []
    const r = await apply(client, OPTS, (x: string) => lines.push(x))
    expect(r.flowOn).toBe(true)
    expect(lines.some((l) => l.includes('it was created after all'))).toBe(true)
  })

  it('a persistent failure stops after the retries with the column, Dataverse error code and no token', async () => {
    const { mock, client } = await env()
    mock.state.attrAlwaysFails = true
    const e: any = await apply(client, OPTS).catch((x: unknown) => x)
    expect(e.message).toMatch(/unexpected error/i)
    expect(e.message).toContain('0x80040216')
    expect(e.message).toMatch(/while creating column owatch_target\.owatch_url \(String\)/)
    expect(e.message).toContain('retried 5 times')
    expect(e.message).not.toContain(mock.token)
    expect(mock.log.filter((l: any) => l.method === 'POST' && l.path.endsWith('/Attributes')).length).toBe(6)   // 1 try + 5 retries
  })

  it('only the generic transient errors are retried: not permission, not validation, not not-found', () => {
    const E = (s: number, m: string, c?: string) => new DataverseError(`POST x: HTTP ${s} ${m}`, s, c)
    expect(isTransientMetadata(E(400, 'An unexpected error occurred.', '0x80040216'))).toBe(true)
    expect(isTransientMetadata(E(400, 'An unexpected error occurred.'))).toBe(true)
    expect(isTransientMetadata(E(500, 'Internal server error'))).toBe(true)
    expect(isTransientMetadata(E(400, 'Attribute owatch_x already exists', '0x80048403'))).toBe(false)
    expect(isTransientMetadata(E(403, 'Principal user is missing prvCreateEntity privilege'))).toBe(false)
    expect(isTransientMetadata(E(401, 'Unauthorized'))).toBe(false)
    expect(isTransientMetadata(E(404, 'Could not find an entity'))).toBe(false)
    expect(isTransientMetadata(new Error('boom'))).toBe(false)
  })
})

describe('stale Web API schema (real second-run failure: HTTP 400 0x80060888 Could not find a property named owatch_value)', () => {
  it('waits and retries until the Web API sees the new columns, then completes', async () => {
    const { mock, client } = await env()
    mock.state.staleSchemaReads = 4
    const lines: string[] = []
    const r = await apply(client, OPTS, (x: string) => lines.push(x))
    expect(r.flowOn).toBe(true)
    expect(lines.filter((l) => l.includes('has not refreshed its schema yet')).length).toBe(4)
    expect(mock.db.owatch_settings.length).toBeGreaterThan(0)
    // seeding must not start before the columns are readable
    const firstSeed = lines.findIndex((l) => l.startsWith('[4/8]')); const lastWait = lines.map((l, i) => (l.includes('schema yet') ? i : -1)).filter((i) => i >= 0).pop()!
    expect(lastWait).toBeLessThan(firstSeed)
  })

  it('a schema that never refreshes stops with a clear wait-and-re-run message, no token', async () => {
    const { mock, client } = await env()
    mock.state.staleSchemaReads = 1000
    const e: any = await apply(client, OPTS).catch((x: unknown) => x)
    expect(e.message).toContain('0x80060888')
    expect(e.message).toContain('re-run the same command')
    expect(e.message).not.toContain(mock.token)
  })

  it('a re-run after the failure completes without duplicates', async () => {
    const { mock, client } = await env()
    mock.state.staleSchemaReads = 1000
    await apply(client, OPTS).catch(() => {})
    mock.state.staleSchemaReads = 0
    const r = await apply(client, OPTS)
    expect(r.flowOn).toBe(true)
    expect(mock.db.owatch_targets).toHaveLength(37)
    expect(mock.db.workflows).toHaveLength(1)
  })

  it('only that error is treated as a cache delay', () => {
    const E = (s: number, m: string, c?: string) => new DataverseError(`GET x: HTTP ${s} ${m}`, s, c)
    expect(isStaleSchema(E(400, "Could not find a property named 'owatch_value' on type 'X'", '0x80060888'))).toBe(true)
    expect(isStaleSchema(E(400, "Could not find a property named 'a' on type 'X'"))).toBe(true)
    expect(isStaleSchema(E(403, 'forbidden'))).toBe(false)
    expect(isStaleSchema(E(404, 'Resource not found for the segment'))).toBe(false)
    expect(isStaleSchema(E(400, 'Invalid filter'))).toBe(false)
  })
})

describe('failure handling', () => {
  it('flow that cannot be turned on: reported as FlowNotOn with the service message; re-run recovers', async () => {
    const { mock, client } = await env({ failActivation: 'The flow uses a premium connector; the owner needs a Power Automate Premium licence.' })
    const e: any = await apply(client, OPTS).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(FlowNotOn)
    expect(e.message).toContain('Premium licence')
    expect(e.flowId).toMatch(/^[0-9a-f-]{36}$/)
    expect(mock.db.workflows[0].statecode).toBe(0)
    mock.state.failActivation = null
    const r = await apply(client, OPTS)
    expect(r.flowOn).toBe(true)
    expect(mock.db.workflows).toHaveLength(1)
  })

  it('wrong token: fails on the very first request, nothing created, token not in the error', async () => {
    const mock = createMockDataverse(); const srv = await mock.listen(); closers.push(srv.close)
    const client = createClient({ orgUrl: srv.url, token: 'eyJhbGciOiJSUzI1NiJ9.c2VjcmV0c2VjcmV0.c2lnbmF0dXJl' })
    const e: any = await apply(client, OPTS).catch((x: unknown) => x)
    expect(e.status).toBe(401)
    expect(e.message).not.toContain('eyJ')
    expect(mock.log).toHaveLength(0)
    expect(mock.db.publishers).toHaveLength(0)
  })

  it('refuses to reuse a foreign publisher with another prefix', async () => {
    const { mock, client } = await env()
    mock.db.publishers.push({ publisherid: '22222222-2222-2222-2222-222222222222', uniquename: 'outagewatch', customizationprefix: 'zz' })
    await expect(apply(client, OPTS)).rejects.toThrow(/different prefix/)
    expect(writes(mock)).toEqual([])
  })

  it('retries 429 with Retry-After, then succeeds', async () => {
    const mock = createMockDataverse(); let n = 0
    const fetchImpl = async (url: string, init: any) => (++n === 1 ? new Response('{"error":{"message":"Rate limit"}}', { status: 429, headers: { 'Retry-After': '1' } }) : mock.mockFetch(url, init))
    const waits: number[] = []
    const client = createClient({ orgUrl: 'https://x.invalid', token: mock.token, fetchImpl, sleep: async (ms: number) => { waits.push(ms) } })
    expect((await client.get('WhoAmI')).json.UserId).toBeTruthy()
    expect(waits).toEqual([1000])
  })

  it('never follows a redirect with the bearer token', async () => {
    let seen: any = null
    const client = createClient({ orgUrl: 'https://x.invalid', token: 't', fetchImpl: async (_u: string, init: any) => { seen = init; return new Response('{}', { status: 200 }) } })
    await client.get('WhoAmI')
    expect(seen.redirect).toBe('error')
  })
})

describe('smoke test', () => {
  it('passes when the flow has written fresh rows', async () => {
    const { client } = await env()
    await apply(client, OPTS)
    const r = await smoke(client, { waitSeconds: 5, sleep: async () => {} })
    expect(r.ok).toBe(true); expect(r.targets).toBe(34); expect(r.rows).toBe(34)
  })
  it('times out with ok=false (clear, non-throwing) when no row appears', async () => {
    const { client } = await env({ autoRun: false })
    await apply(client, OPTS)
    let t = 1_000_000
    const lines: string[] = []
    const r = await smoke(client, { waitSeconds: 30, pollSeconds: 10, sleep: async (ms: number) => { t += ms }, now: () => t }, (x: string) => lines.push(x))
    expect(r.ok).toBe(false)
    expect(lines.filter((l) => l.includes('waiting')).length).toBe(3)
  })
  it('fails clearly when the tables do not exist', async () => {
    const { client } = await env()
    await expect(smoke(client, { waitSeconds: 0 })).rejects.toThrow(/does not exist/)
  })
})

describe('uninstall', () => {
  it('default: turns the flow off and deletes it, keeps the data', async () => {
    const { mock, client } = await env()
    await apply(client, OPTS)
    const r = await uninstall(client, { purge: false })
    expect(mock.db.workflows).toHaveLength(0)
    expect(mock.entities.size).toBe(4)
    expect(r.kept.length).toBeGreaterThan(0)
    expect(mock.problems).toEqual([])           // includes "flow deleted while still ON"
    expect((await uninstall(client, { purge: false })).removed).toEqual([])   // idempotent
  })
  it('-Purge: removes flow, connection reference, tables, solution and publisher; then a fresh deploy works', async () => {
    const { mock, client } = await env()
    await apply(client, OPTS)
    await uninstall(client, { purge: true })
    expect(mock.db.workflows).toHaveLength(0); expect(mock.entities.size).toBe(0)
    expect(mock.db.connectionreferences).toHaveLength(0); expect(mock.db.solutions).toHaveLength(0); expect(mock.db.publishers).toHaveLength(0)
    expect((await uninstall(client, { purge: true })).removed).toEqual([])
    expect((await apply(client, OPTS)).flowOn).toBe(true)
    expect(mock.problems).toEqual([])
  })
})

describe('CLI helper (the process Deploy-OutageWatchPP.ps1 calls)', () => {
  const run = (args: string[], extraEnv: Record<string, string> = {}) => new Promise<{ code: number; out: string }>((resolve) => {
    const envv = { ...process.env, ...extraEnv } as Record<string, string>
    execFile(process.execPath, ['provision/owpp.mjs', ...args], { env: envv }, (err, stdout, stderr) => resolve({ code: err ? Number((err as any).code) : 0, out: stdout + stderr }))
  })

  it('apply -> exit 0 + result file; missing connection -> exit 3; activation failure -> exit 4; smoke timeout -> exit 5', async () => {
    const { mock, srv } = await env()
    const dir = mkdtempSync(join(tmpdir(), 'owpp-'))
    const base = { OWPP_TOKEN: mock.token, OWPP_TEST_MODE: '1', OWPP_HEARTBEAT_URL: 'https://hc-ping.example.com/zz-secret-zz' }
    let r = await run(['apply', '--org-url', srv.url, '--out', join(dir, 'a.json')], base)
    expect(r.code).toBe(3)
    expect(JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8')).reason).toBe('needs-connection')
    mock.state.failActivation = 'licence required'
    r = await run(['apply', '--org-url', srv.url, '--connection-id', OPTS.connectionId, '--out', join(dir, 'b.json')], base)
    expect(r.code).toBe(4)
    mock.state.failActivation = null; mock.state.autoRun = false
    r = await run(['apply', '--org-url', srv.url, '--connection-id', OPTS.connectionId, '--out', join(dir, 'c.json')], base)
    expect(r.code).toBe(0)
    const res = JSON.parse(readFileSync(join(dir, 'c.json'), 'utf8'))
    expect(res.ok).toBe(true); expect(res.flowOn).toBe(true); expect(res.heartbeat).toBe(true)
    expect(r.out + JSON.stringify(res)).not.toContain('zz-secret-zz')
    expect(r.out + JSON.stringify(res)).not.toContain(mock.token)
    r = await run(['smoke', '--org-url', srv.url, '--no-wait'], base)
    expect(r.code).toBe(5)
    r = await run(['uninstall', '--org-url', srv.url, '--purge'], base)
    expect(r.code).toBe(0)
    expect(mock.entities.size).toBe(0)
  }, 30000)

  it('rejects bad input with exit 2 before any network use', async () => {
    expect((await run(['validate', '--environment-id', '00000000-0000-0000-0000-000000000000'])).code).toBe(0)
    expect((await run(['validate', '--environment-id', '00000000-0000-0000-0000-000000000000\n'])).code).toBe(2)
    expect((await run(['validate', '--environment-id', '00000000-0000-0000-0000-000000000000', '--interval', '0'])).code).toBe(2)
    expect((await run(['validate', '--environment-id', '00000000-0000-0000-0000-000000000000', '--tenant', 'Contoso.evil'])).code).toBe(2)
    expect((await run(['apply', '--org-url', 'https://evil.example.com/'], { OWPP_TOKEN: 'x' })).code).toBe(2)
    expect((await run(['apply', '--org-url', 'http://127.0.0.1:9/'], { OWPP_TOKEN: 'x', OWPP_TEST_MODE: '0' })).code).toBe(2)   // loopback only in test mode
    const hb = await run(['estimate'], { OWPP_HEARTBEAT_URL: 'http://insecure.example.com/secret-path' })
    expect(hb.code).toBe(2); expect(hb.out).not.toContain('secret-path')
    expect((await run(['apply', '--org-url', 'https://contoso.crm4.dynamics.com/'], { OWPP_TOKEN: '' })).code).toBe(1)   // no token: fails before any request
  }, 30000)

  it('plan (-DryRun) is offline and lists the request sequence and the usage estimate', async () => {
    const r = await run(['plan'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('DRY RUN')
    expect(r.out).toContain('POST   workflows')
    expect(r.out).toMatch(/34 enabled targets every 10 min/)
    expect(r.out).toMatch(/15,552 Power Platform requests\/day/)
    expect(r.out).toContain('Alerts: not configured')
    expect(r.out).toContain('onedrive-business, sharepoint-admin, sharepoint-online')
    expect(r.out).not.toContain('WARNING')
    const five = await run(['estimate', '--interval', '5'])
    expect(five.out).toMatch(/WARNING: this uses 96% of the 40,000/)                                  // probe 31,104 + alert flow 7,200
    expect((await run(['estimate', '--interval', '5', '--no-alerts'])).out).toMatch(/WARNING: this uses 78% of the 40,000/)
    expect((await run(['estimate', '--interval', '3'])).out).toMatch(/WARNING: this needs MORE than the 40,000/)
    const dflt = await run(['estimate'])
    expect(dflt.out).toMatch(/TOTAL: ~19,152 requests\/day = about 48% of the 40,000/)                 // default interval, alerts on: under 60%, no warning
    expect(dflt.out).not.toContain('WARNING')
  }, 30000)
})
