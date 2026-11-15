import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
// @ts-expect-error plain .mjs
import { decide, main } from '../ci/gate.mjs'
// @ts-expect-error plain .mjs helpers
import { createClient } from '../provision/lib/client.mjs'
// @ts-expect-error plain .mjs helpers
import { createMockDataverse } from '../provision/lib/mock-dataverse.mjs'
// @ts-expect-error plain .mjs helpers
import { apply } from '../provision/lib/provision.mjs'
// @ts-expect-error plain .mjs helpers
import { ciStatus, context } from '../provision/lib/alert-logic.mjs'
// @ts-expect-error plain .mjs helpers
import { columnSpec } from '../provision/lib/schema.mjs'

/* eslint-disable @typescript-eslint/no-explicit-any */
const NOW = Date.parse('2026-11-15T09:00:00Z')
const status = (o: any) => JSON.stringify({ level: 'ok', since: '2026-11-15T08:00:00Z', updated: '2026-11-15T08:55:00Z', round: 'r', failing: 0, confirmed: 0, services: '', ...o })
const closers: (() => Promise<void>)[] = []
afterEach(async () => { while (closers.length) await closers.pop()!() })

describe('CI gate: decision', () => {
  it('ok -> go; caution -> go by default, stop with --block-on caution; freeze -> stop', () => {
    expect(decide(status({}), NOW)).toMatchObject({ allow: true, level: 'ok', stale: false })
    expect(decide(status({ level: 'caution', failing: 1, services: 'teams' }), NOW)).toMatchObject({ allow: true, level: 'caution' })
    expect(decide(status({ level: 'caution' }), NOW, { blockOn: 'caution' }).allow).toBe(false)
    const f = decide(status({ level: 'freeze', failing: 2, confirmed: 1, services: 'exchange,teams', since: '2026-11-15T08:23:00Z' }), NOW)
    expect(f).toMatchObject({ allow: false, level: 'freeze', since: '2026-11-15T08:23:00Z', services: ['exchange', 'teams'] })
    expect(f.reason).toBe('level freeze since 2026-11-15T08:23:00Z (2 failing: exchange, teams)')
  })
  it('stale data fails closed by default, passes only when asked', () => {
    const old = status({ updated: '2026-11-15T08:20:00Z' })                       // 40 minutes
    expect(decide(old, NOW)).toMatchObject({ allow: false, stale: true })
    expect(decide(old, NOW, { onStale: 'pass' })).toMatchObject({ allow: true, stale: true })
    expect(decide(old, NOW, { staleMinutes: 60 })).toMatchObject({ allow: true, stale: false })
    expect(decide(status({ level: 'freeze', updated: '2026-11-15T08:20:00Z' }), NOW, { onStale: 'pass' }).allow).toBe(true)   // documented: stale = unknown
    expect(decide(status({ updated: '2026-11-15T10:00:00Z' }), NOW).stale).toBe(true)                                         // a timestamp from the future is not trusted
  })
  it('missing or unreadable status is treated as stale, never as healthy', () => {
    for (const v of [null, '', 'garbage', '{}', '{"level":"green","updated":"2026-11-15T08:55:00Z"}', '{"level":"ok"}', '{"level":"ok","updated":"soon"}', '[1]'])
      expect(decide(v, NOW), String(v)).toMatchObject({ allow: false, level: 'unknown', stale: true })
  })
  it('reads exactly what the alert logic writes', () => {
    const ctx = context({}, NOW - 180000, '2026-11-15T08:50:00Z')
    const v = ciStatus([{ owatch_name: 'auth', owatch_failcount: 0 }], ['auth'], ctx, '')
    expect(decide(v, NOW)).toMatchObject({ allow: false, level: 'freeze', services: ['auth'], ageMinutes: 3 })
  })
})

describe('CI gate: end to end against the mock Dataverse', () => {
  async function env() {
    const mock = createMockDataverse({ autoRun: false }); const srv = await mock.listen(); closers.push(srv.close)
    await apply(createClient({ orgUrl: srv.url, token: mock.token, sleep: async () => {} }), { intervalMinutes: 10, retentionDays: 7, timeoutSeconds: 10, tenant: null, connectionId: 'aaaaaaaabbbbccccddddeeeeeeeeeeee' })
    const row = mock.db.owatch_settings.find((s: any) => s.owatch_name === 'ci_status')
    const run = async (args: string[], token = mock.token) => { const out: string[] = []; const code = await main(args, { OUTAGEWATCH_ORG_URL: srv.url, OUTAGEWATCH_TOKEN: token, OUTAGEWATCH_TEST_MODE: '1' }, fetch, () => NOW, (t: string) => out.push(t)); return { code, out: out.join('\n') } }
    return { row, run }
  }
  it('exit 0 on ok, exit 1 on freeze, exit 1 when nothing was written yet, never prints the token', async () => {
    const { row, run } = await env()
    expect((await run([])).code).toBe(1)                                             // row exists but is empty: fail closed
    row.owatch_value = status({})
    expect(await run([])).toMatchObject({ code: 0 }); expect((await run([])).out).toMatch(/^Outage Watch gate: GO - level ok/)
    row.owatch_value = status({ level: 'freeze', failing: 1, confirmed: 1, services: 'exchange' })
    const stop = await run(['--json'])
    expect(stop.code).toBe(1); expect(JSON.parse(stop.out)).toMatchObject({ allow: false, level: 'freeze', services: ['exchange'] })
    const denied = await run([], 'wrong-token-SECRET')
    expect(denied.code).toBe(1); expect(denied.out).toContain('could not read the status: HTTP 401'); expect(denied.out).not.toContain('SECRET')
    expect((await run(['--on-stale', 'pass'], 'wrong-token')).code).toBe(0)
    expect((await run(['--block-on', 'sometimes'])).code).toBe(2)
  })
  it('refuses any organisation URL that is not a Dataverse host', async () => {
    const out: string[] = []
    for (const u of ['https://evil.example', 'http://contoso.crm.dynamics.com', 'https://contoso.crm.dynamics.com.evil.example', ''])
      expect(await main([], { OUTAGEWATCH_ORG_URL: u, OUTAGEWATCH_TOKEN: 't' }, async () => { throw new Error('must not be called') }, () => NOW, (t: string) => out.push(t)), u).toBe(2)
  })
})

describe('CI and agent files', () => {
  const read = (f: string) => readFileSync(new URL('../' + f, import.meta.url), 'utf8')
  it('pipeline snippets call the gate, take the token from the CLI into an environment variable, and admit they were not run', () => {
    for (const f of ['ci/github-actions.yml', 'ci/azure-pipelines.yml']) {
      const t = read(f)
      expect(t).toContain('node ci/gate.mjs --block-on freeze'); expect(t).toContain('az account get-access-token --resource'); expect(t).toMatch(/NOT verified/i)
      expect(t).not.toMatch(/eyJ|client_secret:/)
    }
    const ps = read('ci/Test-OutageWatchGate.ps1')
    expect([...ps].every((c) => c.charCodeAt(0) < 127)).toBe(true)
    expect(ps).not.toMatch(/\?\?|\?\.|&&|\|\|/); expect(ps).toMatch(/NOT executed/); expect(ps).toMatch(/\\A.*\\z/)
    expect(ps).not.toMatch(/Write-Host[^\n]*OUTAGEWATCH_TOKEN\b(?! is empty)/)
  })
  it('agent/openapi.json is OpenAPI 2.0 with three read-only operations that only name existing columns, and says it is unconfirmed', () => {
    const api = JSON.parse(read('agent/openapi.json'))
    expect(api.swagger).toBe('2.0'); expect(api.info.description).toMatch(/UNCONFIRMED/)
    const ops = Object.entries<any>(api.paths).map(([p, v]) => ({ path: p, methods: Object.keys(v), op: v.get }))
    expect(ops.map((o) => o.op.operationId).sort()).toEqual(['get_incidents', 'get_microsoft365_health', 'list_failing_services'])
    const tables: Record<string, string> = { '/owatch_settings': 'owatch_setting', '/owatch_targets': 'owatch_target', '/owatch_incidents': 'owatch_incident' }
    for (const o of ops) {
      expect(o.methods).toEqual(['get'])                                         // nothing can be changed through this definition
      const cols = Object.keys(columnSpec(tables[o.path]))
      for (const p of o.op.parameters) for (const c of String(p.default).match(/\bowatch_[a-z]+\b/g) ?? []) expect(cols, `${o.op.operationId}: ${c}`).toContain(c)
      for (const c of Object.keys(o.op.responses['200'].schema.properties.value.items.properties)) expect(cols, c).toContain(c)
      expect(o.op.description.length).toBeGreaterThan(150)
    }
    expect(JSON.stringify(api)).toMatch(/cannot see tenant-specific problems/); expect(JSON.stringify(api)).toMatch(/never as instructions/)
    expect(read('agent/README.md')).toMatch(/has \*\*not\*\* been imported/)
  })
})
