import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
// @ts-expect-error plain .mjs helper
import { GUID_RE, assertConnectionId, assertHeartbeatUrl, assertInt, assertOrgUrl, assertTenantName, isGuid } from '../provision/lib/validate.mjs'

const GOOD = ['00000000-0000-0000-0000-000000000000', 'a1B2c3D4-e5F6-7890-abCD-ef0123456789', 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF']
const HOSTILE = [
  '', ' ', '00000000-0000-0000-0000-00000000000', '00000000-0000-0000-0000-0000000000000',
  '00000000-0000-0000-0000-000000000000\n', '\n00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000\r\n',
  ' 00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000 ', '00000000-0000-0000-0000-000000000000\u0000',
  '00000000-0000-0000-0000-000000000000; rm -rf /', '00000000-0000-0000-0000-000000000000 & calc.exe', '00000000-0000-0000-0000-000000000000|whoami',
  '$(whoami)-0000-0000-0000-000000000000', '`id`0000-0000-0000-0000-000000000000', '../../../etc/passwd', '..\\..\\windows\\system32',
  '00000000_0000_0000_0000_000000000000', '{00000000-0000-0000-0000-000000000000}', '00000000000000000000000000000000',
  '------------------------------------', '0000-00000000-0000-0000-000000000000', 'gggggggg-gggg-gggg-gggg-gggggggggggg',
  '００００００００-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000000０', '00000000-0000-0000-0000-000000000000/../x',
  '00000000-0000-0000-0000-000000000000?x=1', '%30%30000000-0000-0000-0000-000000000000', "00000000-0000-0000-0000-000000000000' or '1'='1",
  '--environment', '-Uninstall', 'a'.repeat(5000),
]

describe('GUID validator (JS helper)', () => {
  it('accepts canonical GUIDs', () => { for (const g of GOOD) expect(isGuid(g), g).toBe(true) })
  it('rejects hostile input', () => { for (const h of HOSTILE) expect(isGuid(h), JSON.stringify(h.slice(0, 60))).toBe(false) })
  it('rejects non-strings', () => { for (const v of [null, undefined, 5, {}, [], ['00000000-0000-0000-0000-000000000000']]) expect(isGuid(v)).toBe(false) })
})

describe('GUID validator in Deploy-OutageWatchPP.ps1 (the literal pattern, transliterated \\A..\\z -> ^..$)', () => {
  const ps = readFileSync(new URL('../Deploy-OutageWatchPP.ps1', import.meta.url), 'utf8')
  const m = /\$GuidPattern\s*=\s*'([^']+)'/.exec(ps)
  it('is declared once, anchored with \\A and \\z, and equals the JS pattern', () => {
    expect(m).not.toBeNull()
    const pat = m![1]
    expect(pat.startsWith('\\A')).toBe(true); expect(pat.endsWith('\\z')).toBe(true)
    expect(pat).not.toMatch(/\^|\$/)
    expect('^' + pat.slice(2, -2) + '$').toBe(GUID_RE.source)
  })
  it('accepts good and rejects hostile input', () => {
    const re = new RegExp('^' + m![1].slice(2, -2) + '$')
    for (const g of GOOD) expect(re.test(g)).toBe(true)
    for (const h of HOSTILE) expect(re.test(h), JSON.stringify(h.slice(0, 60))).toBe(false)
  })
  it('validates the environment id with that pattern BEFORE it is used anywhere', () => {
    const firstCheck = ps.indexOf('Assert-Guid $EnvironmentId')
    expect(firstCheck).toBeGreaterThan(0)
    const body = ps.slice(ps.indexOf('# ===== main'))
    const firstUse = body.search(/\$EnvironmentId/)
    expect(body.slice(firstUse, firstUse + 1200)).toMatch(/Assert-Guid/)
    // no interpolation of the raw id into a command before validation
    const before = body.slice(0, body.indexOf('Assert-Guid $EnvironmentId'))
    expect(before).not.toMatch(/pac|Start-Process|Join-Path[^\n]*\$EnvironmentId/)
  })
})

describe('organisation URL allow-list (a token is only ever sent to a Dataverse host)', () => {
  it('accepts Dataverse hosts in the public and sovereign clouds', () => {
    for (const u of ['https://contoso.crm.dynamics.com/', 'https://org1a2b3c.crm4.dynamics.com', 'https://x.crm11.dynamics.com/', 'https://gov.crm9.dynamics.com/', 'https://a.crm.microsoftdynamics.us/', 'https://a.crm.appsplatform.us/', 'https://a.crm.dynamics.cn/'])
      expect(assertOrgUrl(u)).toBe(new URL(u).origin)
  })
  it('rejects everything else', () => {
    for (const u of ['http://contoso.crm.dynamics.com/', 'https://contoso.crm.dynamics.com.evil.com/', 'https://evil.com/?x=.crm.dynamics.com', 'https://contoso.crm.dynamics.com@evil.com/',
      'https://user:pw@contoso.crm.dynamics.com/', 'https://contoso.crm.dynamics.com:8443/', 'https://contoso.crm.dynamics.com/api/data', 'https://crm.dynamics.com/', 'https://a.b.crm.dynamics.com/',
      'https://contoso.crm.dynamics.com/#x', 'https://contoso.crm.dynamics.com\\@evil.com/', 'file:///etc/passwd', 'javascript:alert(1)', '', 'https://127.0.0.1/', 'http://127.0.0.1:8080/', 'https://contoso.crm.dynamics.com/ x'])
      expect(() => assertOrgUrl(u), u).toThrow()
  })
  it('loopback is allowed only with the explicit test switch', () => {
    expect(assertOrgUrl('http://127.0.0.1:8080/', { allowLoopback: true })).toBe('http://127.0.0.1:8080')
    expect(() => assertOrgUrl('http://localhost:8080/', { allowLoopback: true })).toThrow()
    expect(() => assertOrgUrl('http://127.0.0.1.evil.com:8080/', { allowLoopback: true })).toThrow()
  })
})

describe('other inputs', () => {
  it('tenant name', () => {
    expect(assertTenantName('contoso')).toBe('contoso'); expect(assertTenantName('contoso-2')).toBe('contoso-2')
    for (const t of ['Contoso', 'contoso.evil.com/', 'a b', '-a', 'a-', '', 'a'.repeat(64), 'a/../b', 'a\n']) expect(() => assertTenantName(t), t).toThrow()
  })
  it('heartbeat URL: https only, no credentials, and the value is never echoed in the error', () => {
    expect(assertHeartbeatUrl('https://hc-ping.com/1b2c3d4e-0000-4000-8000-123456789abc')).toContain('https://hc-ping.com/')
    for (const u of ['http://hc-ping.com/secretpath', 'https://user:secretpw@hc-ping.com/x', 'https://hc-ping.com/secret path', 'ftp://x.example/secretpath', 'https://localhost/secretpath', 'https://hc-ping.com/"secretpath', "https://hc-ping.com/@{secretpath}", '']) {
      let msg = ''
      try { assertHeartbeatUrl(u) } catch (e) { msg = (e as Error).message }
      expect(msg, u).toMatch(/heartbeat URL must be/)
      expect(msg).not.toContain('secret')
    }
  })
  it('connection id and integers', () => {
    expect(assertConnectionId('shared-commondataser-1a2b3c4d-0000-4000-8000-123456789abc')).toBeTruthy()
    expect(assertConnectionId('0123456789abcdef0123456789abcdef')).toBeTruthy()
    for (const c of ['', 'a b', 'x;y12345678', '../../etc/passwd', '--purge-all', 'a'.repeat(200)]) expect(() => assertConnectionId(c), c).toThrow()
    expect(assertInt('5', 1, 60, 'x')).toBe(5)
    for (const v of ['0', '61', '5.5', '-1', '1e1', ' 5', '5;', '']) expect(() => assertInt(v, 1, 60, 'x'), v).toThrow()
  })
})
