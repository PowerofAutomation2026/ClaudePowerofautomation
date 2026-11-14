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
import { createMockDataverse } from '../provision/lib/mock-dataverse.mjs'
// @ts-expect-error plain .mjs helpers without type declarations
import { apply, smoke, uninstall, NeedsConnection, FlowNotOn } from '../provision/lib/provision.mjs'

/* eslint-disable @typescript-eslint/no-explicit-any */
const OPTS = { intervalMinutes: 5, retentionDays: 7, timeoutSeconds: 10, tenant: null, connectionId: 'aaaaaaaabbbbccccddddeeeeeeeeeeee', heartbeatUrl: null as string | null }
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
  it('creates publisher, solution, 3 tables, 15 targets, connection reference, flow, settings, and turns the flow on', async () => {
    const { mock, client } = await env()
    const r = await apply(client, OPTS)
    expect(mock.problems).toEqual([])
    expect(r.flowOn).toBe(true)
    expect(r.targets).toBe(15)
    expect([...mock.entities.keys()].sort()).toEqual(['owatch_result', 'owatch_setting', 'owatch_target'])
    expect(mock.db.owatch_targets).toHaveLength(15)
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
    expect(paths[paths.length - 1]).toMatch(/^PATCH workflows\(/)
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
    expect(by.teams.owatch_alivecodes).toBe('')
    expect(by.auth.owatch_dependsonauth).toBe(false)
    expect(by.teams.owatch_dependsonauth).toBe(true)
    expect(by['copilot-web'].owatch_dependsonauth).toBe(false)
    expect(by['copilot-substrate'].owatch_copilotneeds).toBe(true)
    expect(mock.db.owatch_targets.every((t: any) => t.owatch_enabled === true && /^https:\/\//.test(t.owatch_url))).toBe(true)
  })

  it('adds the two tenant targets only when a tenant name is given', async () => {
    const { mock, client } = await env()
    const r = await apply(client, { ...OPTS, tenant: 'contoso' })
    expect(r.targets).toBe(17)
    const sp = mock.db.owatch_targets.find((t: any) => t.owatch_name === 'onedrive')
    expect(sp.owatch_url).toBe('https://contoso-my.sharepoint.com/')
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
    expect(mock.db.workflows).toHaveLength(1); expect(mock.db.owatch_targets).toHaveLength(15)
    expect(mock.problems).toEqual([])
  })

  it('does not overwrite targets or thresholds an admin edited, but does follow deployment settings', async () => {
    const { mock, client } = await env()
    await apply(client, OPTS)
    mock.db.owatch_targets.find((t: any) => t.owatch_name === 'teams').owatch_enabled = false
    mock.db.owatch_settings.find((s: any) => s.owatch_name === 'confirm').owatch_value = '3'
    mock.log.length = 0
    await apply(client, { ...OPTS, intervalMinutes: 10 })
    expect(mock.db.owatch_targets.find((t: any) => t.owatch_name === 'teams').owatch_enabled).toBe(false)
    expect(mock.db.owatch_settings.find((s: any) => s.owatch_name === 'confirm').owatch_value).toBe('3')
    expect(mock.db.owatch_settings.find((s: any) => s.owatch_name === 'interval_minutes').owatch_value).toBe('10')
    // definition changed: OFF -> patch definition -> ON, in that order, and still one flow
    const w = writes(mock).filter((l: any) => l.path.startsWith('workflows')).length
    expect(w).toBe(3)
    expect(mock.db.workflows).toHaveLength(1)
    expect(mock.db.workflows[0].statecode).toBe(1)
    expect(JSON.parse(mock.db.workflows[0].clientdata).properties.definition.triggers.Recurrence.recurrence.interval).toBe(10)
    expect(mock.problems).toEqual([])
  })

  it('resumes after a partial run (stopped after the tables) without duplicating anything', async () => {
    const { mock, client } = await env()
    await expect(apply(client, { ...OPTS, connectionId: null })).rejects.toBeInstanceOf(NeedsConnection)
    expect(mock.db.workflows).toHaveLength(0)
    expect(mock.db.owatch_targets).toHaveLength(15)
    const r = await apply(client, OPTS)
    expect(r.flowOn).toBe(true)
    expect(mock.db.owatch_targets).toHaveLength(15)
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
    expect(r.ok).toBe(true); expect(r.targets).toBe(15); expect(r.rows).toBe(15)
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
    expect(mock.entities.size).toBe(3)
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
    expect(r.out).toMatch(/14,688 Power Platform requests\/day/)
  }, 30000)
})
