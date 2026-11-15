/**
 * SharePoint / OneDrive tenant name: extraction, validation, reachability probe, the CLI the deploy script calls,
 * and the unconfigured -> configured upgrade from the deployed state (commit bcadc4c) on the mock.
 * The Get-AzTenant / Graph calls themselves happen in PowerShell and were NOT run; what they return is simulated here.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error plain .mjs helpers
import { assertTenantLabel, detectTenant, initialDomainLabels, initialFromGraphOrganization, probeTenant, sharePointCloudSupported } from '../provision/lib/tenant.mjs'
// @ts-expect-error plain .mjs helpers
import { createClient } from '../provision/lib/client.mjs'
// @ts-expect-error plain .mjs helpers
import { createMockDataverse } from '../provision/lib/mock-dataverse.mjs'
// @ts-expect-error plain .mjs helpers
import { apply } from '../provision/lib/provision.mjs'
// @ts-expect-error plain .mjs helpers
import { rowViolations } from '../provision/lib/schema.mjs'

/* eslint-disable @typescript-eslint/no-explicit-any */
const closers: (() => Promise<void>)[] = []
afterEach(async () => { while (closers.length) await closers.pop()!() })

/** A stand-in for *.sharepoint.com: /<label>/ answers with the status configured for that label; unknown labels drop the connection (like a DNS failure). */
async function spo(statusByLabel: Record<string, number>) {
  const hits: string[] = []
  const server = createServer((req, res) => {
    const label = (req.url ?? '').split('/')[1]
    hits.push(label)
    if (!(label in statusByLabel)) { req.socket.destroy(); return }
    res.writeHead(statusByLabel[label], statusByLabel[label] === 302 ? { Location: 'https://login.example/authenticate' } : {}); res.end('x')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  closers.push(() => new Promise((r) => { server.close(() => r()); (server as any).closeAllConnections?.() }))
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  return { base, hits, urlFor: (l: string) => `${base}/${l}/` }
}

describe('tenant name extraction from domain lists', () => {
  it('takes the label of <label>.onmicrosoft.com and nothing else', () => {
    expect(initialDomainLabels(['contoso.com', 'contoso.onmicrosoft.com', 'mail.contoso.com'])).toEqual(['contoso'])
    expect(initialDomainLabels(['Contoso.OnMicrosoft.com'])).toEqual(['contoso'])                 // case-insensitive, ASCII only
    expect(initialDomainLabels(['contoso.mail.onmicrosoft.com'])).toEqual([])                     // the mail routing domain is not the tenant
    expect(initialDomainLabels(['a.onmicrosoft.com', 'b-2.onmicrosoft.com', 'a.onmicrosoft.com'])).toEqual(['a', 'b-2'])
  })
  it('ignores hostile and odd input', () => {
    const bad = ['', ' contoso.onmicrosoft.com', 'contoso.onmicrosoft.com.', 'contoso.onmicrosoft.com/evil', 'https://contoso.onmicrosoft.com', 'contoso.onmicrosoft.com.evil.example', 'evil.example/contoso.onmicrosoft.com',
      '-contoso.onmicrosoft.com', 'contoso-.onmicrosoft.com', 'con_toso.onmicrosoft.com', 'con toso.onmicrosoft.com', 'contoso.onmicrosoft.us', 'contoso.onmicrosoft.cn', 'contoso.onmicrosoft.de', 'contoso.partner.onmschina.cn',
      'cоntoso.onmicrosoft.com' /* Cyrillic o */, 'Kontoso.onmicrosoft.com' /* Kelvin sign: lower-cases to k */, 'conto​so.onmicrosoft.com', 'contoso.onmicrosoft.com\n', 'a'.repeat(64) + '.onmicrosoft.com', 'x'.repeat(5000), '../../etc/passwd', '.onmicrosoft.com']
    expect(initialDomainLabels(bad)).toEqual([])
    expect(initialDomainLabels([null, 5, {}, ['contoso.onmicrosoft.com']] as any)).toEqual([])
    expect(initialDomainLabels('contoso.onmicrosoft.com' as any)).toEqual([]); expect(initialDomainLabels(undefined as any)).toEqual([])
    expect(initialDomainLabels(['a'.repeat(63) + '.onmicrosoft.com'])).toEqual(['a'.repeat(63)])
  })
  it('Graph /organization: only verifiedDomains with isInitial = true', () => {
    const org = { value: [{ verifiedDomains: [{ name: 'contoso.com', isInitial: false, isDefault: true }, { name: 'contoso.onmicrosoft.com', isInitial: true }, { name: 'contoso2.onmicrosoft.com', isInitial: false }] }] }
    expect(initialFromGraphOrganization(org)).toEqual(['contoso'])
    for (const junk of [null, {}, { value: 'x' }, { value: [{}] }, { value: [{ verifiedDomains: [{ name: 5, isInitial: true }, { name: 'evil.example', isInitial: true }] }] }]) expect(initialFromGraphOrganization(junk)).toEqual([])
  })
  it('explicit names (-TenantName / the interactive answer) are validated the same way', () => {
    expect(assertTenantLabel('contoso')).toBe('contoso')
    for (const b of ['Contoso', 'contoso.sharepoint.com', 'contoso/', 'cоntoso', '', '-a', 'a b', 'contoso\n']) expect(() => assertTenantLabel(b), b).toThrow()
  })
  it('sovereign clouds are recognised from the environment URL and not supported', () => {
    for (const u of ['https://contoso.crm.dynamics.com', 'https://contoso.crm4.dynamics.com/', 'https://contoso.crm9.dynamics.com']) expect(sharePointCloudSupported(u), u).toBe(true)
    for (const u of ['https://contoso.crm.microsoftdynamics.us', 'https://contoso.crm.appsplatform.us', 'https://contoso.crm.dynamics.cn', 'garbage', '']) expect(sharePointCloudSupported(u), u).toBe(false)
  })
})

describe('reachability probe: a name is only used when https://<name>.sharepoint.com answers like an existing tenant', () => {
  it('accepts 200 / 302 / 401 / 403 (what existing tenants answer anonymously); rejects 404, 5xx and no answer', async () => {
    const s = await spo({ ok200: 200, redir: 302, unauth: 401, forbid: 403, missing: 404, broken: 503, gone: 410, throttled: 429 })
    for (const l of ['ok200', 'redir', 'unauth', 'forbid']) expect(await probeTenant(l, { urlFor: s.urlFor }), l).toMatchObject({ ok: true })
    expect(await probeTenant('missing', { urlFor: s.urlFor })).toEqual({ ok: false, status: 404, reason: 'HTTP 404' })
    for (const l of ['broken', 'gone', 'throttled']) expect((await probeTenant(l, { urlFor: s.urlFor })).ok, l).toBe(false)
    const dns = await probeTenant('nosuchtenant', { urlFor: s.urlFor })
    expect(dns.ok).toBe(false); expect(dns.reason).toMatch(/^no answer/)
  })
  it('never follows the redirect, never throws, never probes an invalid name, and gives up after the timeout', async () => {
    const s = await spo({ redir: 302 })
    let followed = false
    await probeTenant('redir', { urlFor: s.urlFor, fetchImpl: async (u: string, init: any) => { expect(init.redirect).toBe('manual'); followed = u.includes('login.example'); return fetch(u, init) } })
    expect(followed).toBe(false)
    expect(await probeTenant('evil.example/x', { urlFor: s.urlFor })).toEqual({ ok: false, reason: 'not a valid tenant name' })
    expect(s.hits).toEqual(['redir'])
    const slow = await probeTenant('contoso', { timeoutMs: 30, fetchImpl: (_u: string, init: any) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))) })
    expect(slow).toEqual({ ok: false, reason: 'no answer (AbortError)' })
  })
  it('ordered discovery: first source with exactly ONE answering candidate wins; ambiguity is never guessed', async () => {
    const s = await spo({ contoso: 401, fabrikam: 302 })
    const o = { urlFor: s.urlFor }
    expect(await detectTenant([{ via: 'Get-AzTenant', labels: ['contoso'] }], o)).toMatchObject({ tenant: 'contoso', via: 'Get-AzTenant' })
    expect(await detectTenant([{ via: 'Get-AzTenant', labels: ['oldname', 'contoso'] }], o)).toMatchObject({ tenant: 'contoso' })               // a renamed tenant: only the live name answers
    const amb = await detectTenant([{ via: 'Get-AzTenant', labels: ['contoso', 'fabrikam'] }, { via: 'Microsoft Graph /organization', labels: ['fabrikam'] }], o)
    expect(amb).toMatchObject({ tenant: 'fabrikam', via: 'Microsoft Graph /organization' })                                                       // Az was ambiguous; Graph names the initial domain
    expect(amb.tried.some((t: any) => /ambiguous/.test(t.detail))).toBe(true)
    expect(await detectTenant([{ via: 'Get-AzTenant', labels: ['contoso', 'fabrikam'] }], o)).toMatchObject({ tenant: null })
    expect(await detectTenant([{ via: 'Get-AzTenant', labels: ['nosuch'] }], o)).toMatchObject({ tenant: null, via: null })
    expect(await detectTenant([], o)).toEqual({ tenant: null, via: null, tried: [] })
  })
})

const BASE = { intervalMinutes: 10, retentionDays: 7, timeoutSeconds: 10, tenant: null as string | null, connectionId: 'aaaaaaaabbbbccccddddeeeeeeeeeeee', heartbeatUrl: null }
const TENANT3 = ['sharepoint-online', 'onedrive-business', 'sharepoint-admin']

/** Mock environment as commit bcadc4c left it: 36 targets, the two SharePoint ones DISABLED with no URL, no sharepoint-admin row. */
async function deployedBcadc4c() {
  const mock = createMockDataverse({ autoRun: false }); const srv = await mock.listen(); closers.push(srv.close)
  const client = createClient({ orgUrl: srv.url, token: mock.token, sleep: async () => {} })
  await apply(client, BASE)
  mock.db.owatch_targets = mock.db.owatch_targets.filter((t: any) => t.owatch_name !== 'sharepoint-admin')
  expect(mock.db.owatch_targets).toHaveLength(36)
  mock.db.owatch_results = [{ owatch_resultid: '00000000-0000-4000-8000-000000000001', owatch_name: 'teams', owatch_httpstatus: 200, owatch_elapsedms: 90, owatch_probedat: '2026-11-15T08:00:00Z', owatch_round: '2026-11-15T08:00:00Z', owatch_failed: false }]
  mock.log.length = 0
  const row = (n: string) => mock.db.owatch_targets.find((t: any) => t.owatch_name === n)
  return { mock, srv, client, row }
}

describe('upgrade from the deployed state (bcadc4c): SharePoint / OneDrive become covered', () => {
  it('with a detected tenant: the two waiting rows are filled and enabled, sharepoint-admin is added, nothing else changes, idempotent', async () => {
    const e = await deployedBcadc4c()
    const ids = TENANT3.slice(0, 2).map((n) => e.row(n).owatch_targetid)
    const others = JSON.stringify(e.mock.db.owatch_targets.filter((t: any) => !TENANT3.includes(t.owatch_name)))
    const results = JSON.stringify(e.mock.db.owatch_results)
    const r = await apply(e.client, { ...BASE, tenant: 'contoso' })
    expect(e.mock.problems).toEqual([])
    expect(e.mock.db.owatch_targets).toHaveLength(37)
    expect(TENANT3.map((n) => [e.row(n).owatch_url, e.row(n).owatch_enabled])).toEqual([['https://contoso.sharepoint.com/', true], ['https://contoso-my.sharepoint.com/', true], ['https://contoso-admin.sharepoint.com/', true]])
    expect(TENANT3.slice(0, 2).map((n) => e.row(n).owatch_targetid)).toEqual(ids)                           // same rows, updated in place
    expect(e.row('sharepoint-admin')).toMatchObject({ owatch_family: 'SharePoint / OneDrive', owatch_dependsonauth: true, owatch_copilotneeds: false })
    expect(JSON.stringify(e.mock.db.owatch_targets.filter((t: any) => !TENANT3.includes(t.owatch_name)))).toBe(others)
    expect(JSON.stringify(e.mock.db.owatch_results)).toBe(results)                                           // history untouched
    expect(r.created.filter((c: string) => c.startsWith('target '))).toEqual(['target sharepoint-admin'])
    expect(r.updated.filter((c: string) => c.startsWith('target '))).toEqual(['target sharepoint-online configured for the tenant', 'target onedrive-business configured for the tenant'])
    expect(r).toMatchObject({ targets: 37, enabledTargets: 37, unconfigured: [] })
    expect(r.estimate).toMatchObject({ perRun: 117, probePerDay: 16848, pctOf40k: 42, high: false })        // 37 probed targets, no alert channel in this test
    for (const t of e.mock.db.owatch_targets) { const { owatch_targetid, ...cols } = t; expect(rowViolations('owatch_target', cols), t.owatch_name).toEqual([]) }
    e.mock.log.length = 0
    await apply(e.client, { ...BASE, tenant: 'contoso' }); await apply(e.client, BASE); await apply(e.client, { ...BASE, tenant: 'othername' })
    expect(e.mock.log.filter((l: any) => l.method !== 'GET')).toEqual([])                                    // no rewrite, no duplicate, a different name later changes nothing
  })
  it('auto-detect failed (no tenant): still neutral "unconfigured", sharepoint-admin added as a waiting row too', async () => {
    const e = await deployedBcadc4c()
    const r = await apply(e.client, BASE)
    expect(r).toMatchObject({ targets: 37, enabledTargets: 34 }); expect(r.unconfigured).toEqual(['onedrive-business', 'sharepoint-admin', 'sharepoint-online'])
    expect(TENANT3.every((n) => e.row(n).owatch_enabled === false && (e.row(n).owatch_url ?? '') === '')).toBe(true)
  })
  it('never overwrites what an admin did: a URL typed by hand, or a row enabled by hand', async () => {
    const e = await deployedBcadc4c()
    Object.assign(e.row('sharepoint-online'), { owatch_url: 'https://intranet.contoso.example/', owatch_enabled: false })     // admin pointed it elsewhere and keeps it off
    Object.assign(e.row('onedrive-business'), { owatch_enabled: true })                                                        // admin enabled it without a URL (odd, but theirs)
    const r = await apply(e.client, { ...BASE, tenant: 'contoso' })
    expect(e.row('sharepoint-online')).toMatchObject({ owatch_url: 'https://intranet.contoso.example/', owatch_enabled: false })
    expect(e.row('onedrive-business').owatch_url ?? '').toBe('')
    expect(r.updated.filter((c: string) => c.startsWith('target '))).toEqual([])
    expect(e.row('sharepoint-admin').owatch_url).toBe('https://contoso-admin.sharepoint.com/')                                  // the new row is created configured
  })
})

describe('CLI detect-tenant (what Deploy-OutageWatchPP.ps1 calls)', () => {
  const run = (args: string[], extraEnv: Record<string, string> = {}) => new Promise<{ code: number; out: string }>((resolve) => {
    execFile(process.execPath, ['provision/owpp.mjs', ...args], { env: { ...process.env, OWPP_TEST_MODE: '1', ...extraEnv } as Record<string, string> }, (err, stdout, stderr) => resolve({ code: err ? Number((err as any).code) : 0, out: stdout + stderr }))
  })
  it('detects from the Get-AzTenant domain list, verifies, and writes the result file; says how it was found', async () => {
    const s = await spo({ contoso: 401 })
    const e = await deployedBcadc4c()
    const f = join(mkdtempSync(join(tmpdir(), 'owpp-')), 't.json')
    const r = await run(['detect-tenant', '--org-url', e.srv.url, '--domains', 'contoso.com,contoso.onmicrosoft.com,contoso.mail.onmicrosoft.com', '--out', f], { OWPP_TEST_SPO_BASE: s.base, OWPP_TOKEN: e.mock.token })
    expect(r.code).toBe(0); expect(r.out).toContain('SharePoint tenant detected via Get-AzTenant: contoso')
    expect(JSON.parse(readFileSync(f, 'utf8'))).toMatchObject({ tenant: 'contoso', via: 'Get-AzTenant', already: false, unsupported: false })
  }, 30000)
  it('nothing verifiable -> exit 0 with tenant null (the deployment goes on); hostile domain text cannot reach a URL', async () => {
    const s = await spo({})
    const e = await deployedBcadc4c()
    const f = join(mkdtempSync(join(tmpdir(), 'owpp-')), 't.json')
    const r = await run(['detect-tenant', '--org-url', e.srv.url, '--domains', 'evil.example/x.onmicrosoft.com,renamed.onmicrosoft.com,..%2F.onmicrosoft.com', '--out', f], { OWPP_TEST_SPO_BASE: s.base })
    expect(r.code).toBe(0); expect(JSON.parse(readFileSync(f, 'utf8')).tenant).toBeNull()
    expect(r.out).toContain('could not be detected and verified'); expect(s.hits).toEqual(['renamed'])
    expect((await run(['detect-tenant', '--org-url', e.srv.url], { OWPP_TEST_SPO_BASE: s.base })).out).toContain('no candidate domain was available')
  }, 30000)
  it('already configured on an earlier run -> says so and asks nothing; explicit name -> validated and probed', async () => {
    const s = await spo({ contoso: 302 })
    const e = await deployedBcadc4c()
    await apply(e.client, { ...BASE, tenant: 'contoso' })
    const f = join(mkdtempSync(join(tmpdir(), 'owpp-')), 't.json')
    const r = await run(['detect-tenant', '--org-url', e.srv.url, '--domains', 'contoso.onmicrosoft.com', '--out', f], { OWPP_TEST_SPO_BASE: s.base, OWPP_TOKEN: e.mock.token })
    expect(JSON.parse(readFileSync(f, 'utf8'))).toMatchObject({ already: true, tenant: null }); expect(r.out).toContain('already configured')
    const given = await run(['detect-tenant', '--org-url', e.srv.url, '--candidate', 'contoso', '--out', f], { OWPP_TEST_SPO_BASE: s.base })
    expect(JSON.parse(readFileSync(f, 'utf8'))).toMatchObject({ tenant: 'contoso', via: 'given', reachable: true })
    const typo = await run(['detect-tenant', '--org-url', e.srv.url, '--candidate', 'contsoo', '--out', f], { OWPP_TEST_SPO_BASE: s.base })
    expect(typo.out).toContain('WARNING'); expect(JSON.parse(readFileSync(f, 'utf8'))).toMatchObject({ tenant: 'contsoo', reachable: false })
    expect((await run(['detect-tenant', '--org-url', e.srv.url, '--candidate', 'Contoso.sharepoint.com'], { OWPP_TEST_SPO_BASE: s.base })).code).toBe(2)
    expect(given.code).toBe(0)
  }, 30000)
  it('sovereign cloud: not supported, nothing probed, nothing seeded', async () => {
    const r = await run(['detect-tenant', '--org-url', 'https://contoso.crm.microsoftdynamics.us', '--domains', 'contoso.onmicrosoft.com'])
    expect(r.code).toBe(0); expect(r.out).toContain('Not supported yet')
  }, 30000)
})
