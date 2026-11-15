/**
 * STATIC checks of the PowerShell deploy script. PowerShell is not available in the build sandbox, so the
 * script has NOT been executed here; these checks catch the mistakes that can be caught without running it:
 * unbalanced blocks, PowerShell-7-only syntax (the script must also run on Windows PowerShell 5.1),
 * non-ASCII characters (5.1 reads BOM-less files as ANSI), undefined helper functions, and secret handling.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (f: string) => readFileSync(new URL('../' + f, import.meta.url), 'utf8')
const ps = read('Deploy-OutageWatchPP.ps1')

/** Replace comments and string contents by spaces (keeps offsets/line numbers). */
function strip(src: string): string {
  let out = ''
  let i = 0
  const blank = (s: string) => s.replace(/[^\n]/g, ' ')
  while (i < src.length) {
    const c = src[i]; const two = src.slice(i, i + 2)
    if (two === '<#') { const e = src.indexOf('#>', i + 2); const end = e < 0 ? src.length : e + 2; out += blank(src.slice(i, end)); i = end; continue }
    if (c === '#') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; out += blank(src.slice(i, end)); i = end; continue }
    if (two === "@'" || two === '@"') throw new Error('here-strings are not used in this script; the static checker does not support them')
    if (c === "'") {
      let j = i + 1
      for (;;) { const e = src.indexOf("'", j); if (e < 0) throw new Error('unterminated single-quoted string at ' + i); if (src[e + 1] === "'") { j = e + 2; continue } j = e; break }
      out += "'" + blank(src.slice(i + 1, j)) + "'"; i = j + 1; continue
    }
    if (c === '"') {
      let j = i + 1
      for (;;) { if (j >= src.length) throw new Error('unterminated double-quoted string at ' + i); if (src[j] === '`') { j += 2; continue } if (src[j] === '"') { if (src[j + 1] === '"') { j += 2; continue } break } j++ }
      out += '"' + blank(src.slice(i + 1, j)) + '"'; i = j + 1; continue
    }
    if (c === '`') { out += '  '; i += 2; continue }
    out += c; i++
  }
  return out
}
const code = strip(ps)

describe('Deploy-OutageWatchPP.ps1 static checks (NOT an execution test)', () => {
  it('is pure ASCII without a BOM and without tabs', () => {
    expect(ps.charCodeAt(0)).not.toBe(0xfeff)
    const bad = [...ps].findIndex((ch) => ch.charCodeAt(0) > 126 || (ch.charCodeAt(0) < 32 && ch !== '\n' && ch !== '\r'))
    expect(bad, bad >= 0 ? `non-ASCII/control char near: ${JSON.stringify(ps.slice(Math.max(0, bad - 30), bad + 10))}` : '').toBe(-1)
  })

  it('has balanced braces, parentheses and brackets (strings and comments removed)', () => {
    const stack: { ch: string; line: number }[] = []
    const pair: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
    let line = 1
    for (const ch of code) {
      if (ch === '\n') line++
      if ('([{'.includes(ch)) stack.push({ ch, line })
      else if (')]}'.includes(ch)) { const top = stack.pop(); expect(top?.ch, `line ${line}: unexpected ${ch}`).toBe(pair[ch]) }
    }
    expect(stack.map((s) => `${s.ch}@${s.line}`)).toEqual([])
  })

  it('uses no PowerShell 7-only syntax (must run on Windows PowerShell 5.1)', () => {
    expect(code).not.toMatch(/\?\?/)            // null-coalescing
    expect(code).not.toMatch(/\?\./)            // null-conditional
    expect(code).not.toMatch(/&&|\|\|/)         // pipeline chain operators
    expect(code.includes('?'), 'no bare ? at all outside strings: rules out the ternary operator and the ? alias').toBe(false)
    expect(code).not.toMatch(/-AsPlainText/)    // ConvertFrom-SecureString -AsPlainText is 7+
    expect(code).not.toMatch(/-Parallel|\$PSStyle|-SkipCertificateCheck|\bclean\s*\{/)
    expect(code).not.toMatch(/ConvertFrom-Json[^\n|]*-(AsHashtable|Depth)/)
    expect(code).not.toMatch(/Join-Path[ \t]+(\$\w+|'[^']*')[ \t]+(\$\w+|'[^']*')[ \t]+(\$\w+|'[^']*')/)   // 3 positional path segments is 7+
  })

  it('declares the required parameters', () => {
    const header = ps.slice(ps.indexOf('param('), ps.indexOf("$ErrorActionPreference = 'Stop'"))
    for (const p of ['[string]$EnvironmentId', '[switch]$Yes', '[switch]$DryRun', '[switch]$Uninstall', '[switch]$Purge', '[switch]$SkipTests']) expect(header).toContain(p)
    expect(header).toMatch(/\[Parameter\(Position = 0\)\]\[string\]\$EnvironmentId/)
    expect(header).not.toMatch(/Mandatory/)          // nothing but the ID is required, and the ID is prompted
    expect(header).not.toMatch(/Heartbeat(Url|Uri)|Token|Secret|Password/i)   // secrets are never command-line parameters
  })

  it('every helper function that is called is defined, and every defined one is used', () => {
    const defined = [...code.matchAll(/^\s*function\s+([A-Za-z][A-Za-z-]*)/gm)].map((m) => m[1])
    expect(new Set(defined).size).toBe(defined.length)
    const known = new Set(['Set-Location', 'Split-Path', 'Join-Path', 'New-Object', 'Write-Host', 'Get-Command', 'ForEach-Object', 'Read-Host', 'Test-Path', 'ConvertFrom-Json', 'Remove-Item',
      'Get-Module', 'Get-PackageProvider', 'Install-PackageProvider', 'Install-Module', 'Import-Module', 'Get-AzContext', 'Connect-AzAccount', 'Get-AzAccessToken', 'Where-Object', 'Select-Object',
      'Start-Process', 'Get-Date', 'Start-Sleep', 'New-Item', 'Copy-Item', 'Out-Host', 'Out-Null'])
    const called = new Set([...code.matchAll(/(?<![\w$.:-])([A-Z][a-z]+-[A-Z][A-Za-z]+)\b/g)].map((m) => m[1]))
    for (const c of called) expect(defined.includes(c) || known.has(c), `unknown command ${c}`).toBe(true)
    for (const d of defined) expect((code.match(new RegExp('(?<![\\w-])' + d + '(?![\\w-])', 'g')) ?? []).length, `${d} is never called`).toBeGreaterThan(1)
  })

  it('never prints or stores secrets', () => {
    for (const line of ps.split('\n')) {
      if (/Write-Host|Write-Output|Warn |Info |Ok |Out-File|Set-Content|WriteAllText|Start-Transcript|throw /.test(line)) {
        expect(line, line).not.toMatch(/\$env:OWPP_TOKEN|\$env:OWPP_HEARTBEAT_URL|\$env:OUTAGEWATCH_HEARTBEAT_URL\b(?!\))|\$plain\b|\$tok\b|\$sec\b/)
      }
    }
    expect(ps).not.toMatch(/Start-Transcript/)
    expect(ps).toMatch(/finally\s*\{\s*Clear-Secrets\s*\}/)
    expect(ps).toMatch(/Read-Host[^\n]*-AsSecureString/)
    // the token and heartbeat URL reach the helper through the environment, never on a command line
    expect(ps).not.toMatch(/--token|--heartbeat-url/)
  })

  it('validates every value that reaches a command line or a URL', () => {
    for (const v of ['$GuidPattern', '$OrgUrlPattern', '$TenantPattern', '$ConnIdPattern', '$DisplayNamePattern', '$TeamsLinkPattern', '$ChannelListPattern', '$DashboardUrlPattern']) {
      const m = new RegExp('\\' + v + " = '([^']+)'").exec(ps)
      expect(m, v).not.toBeNull()
      expect(m![1].startsWith('\\A') && m![1].endsWith('\\z'), `${v} must be anchored with \\A and \\z`).toBe(true)
      expect((ps.match(new RegExp('-c(not)?match \\' + v, 'g')) ?? []).length, `${v} is used case-sensitively`).toBeGreaterThan(0)
    }
    // browser pages are only opened with the validated environment id / flow id
    for (const m of ps.matchAll(/Start-Process\s+("[^"]*"|\$\w+)/g)) expect(m[1]).toMatch(/^"https:\/\/(make\.powerapps\.com|make\.powerautomate\.com|admin\.powerplatform\.microsoft\.com)\/[^"]*"$|^\$flowUrl$/)
  })

  it('org URL pattern agrees with the JS allow-list on a sample', async () => {
    // @ts-expect-error plain .mjs helper
    const { assertOrgUrl } = await import('../provision/lib/validate.mjs')
    const m = /\$OrgUrlPattern = '([^']+)'/.exec(ps)!
    const re = new RegExp('^' + m[1].slice(2, -2) + '$')
    for (const u of ['https://contoso.crm.dynamics.com', 'https://contoso.crm4.dynamics.com/', 'https://a.crm.microsoftdynamics.us', 'https://evil.com', 'http://contoso.crm.dynamics.com', 'https://contoso.crm.dynamics.com.evil.com', 'https://contoso.crm.dynamics.com/x', 'https://contoso.crm.dynamics.com\n']) {
      let js = true
      try { assertOrgUrl(u) } catch { js = false }
      expect(re.test(u), u).toBe(js)
    }
  })

  it('alert channels: webhook URLs come only from a hidden prompt or the environment, are cleared afterwards, and are never a parameter or an argument', () => {
    const header = ps.slice(ps.indexOf('param('), ps.indexOf("$ErrorActionPreference = 'Stop'"))
    for (const p of ['[string]$TeamsChannelLink', '[switch]$SetSlackWebhook', '[switch]$SetWebexWebhook', '[switch]$SetAlertWebhook', '[switch]$NoAlerts', '[switch]$SendTestAlert', '[string]$RemoveChannels']) expect(header).toContain(p)
    expect(header).not.toMatch(/\[string\]\$\w*(Webhook|Slack|Webex)\w*/)                 // no webhook value on the command line
    expect(ps).toMatch(/function Read-WebhookSecret[\s\S]{0,200}-AsSecureString/)
    for (const v of ['OWPP_SLACK_WEBHOOK', 'OWPP_WEBEX_WEBHOOK', 'OWPP_ALERT_WEBHOOK']) {
      expect(ps).toContain('Remove-Item Env:\\' + v)
      for (const line of ps.split('\n')) if (/Write-Host|Warn |Info |Ok |throw |Invoke-Helper/.test(line)) expect(line, line).not.toContain('$env:' + v)
    }
    expect(ps).not.toMatch(/--(slack|webex|alert)-webhook/)
    // Teams: connection found or created by polling; a missing connection never fails the deployment
    expect(ps).toMatch(/connections\/available\?apiName=shared_teams/); expect(ps).toMatch(/\$code -eq 6/); expect(ps).toMatch(/continuing WITHOUT Teams alerts/)
    expect(ps).toMatch(/'owatch_target', 'owatch_result', 'owatch_setting', 'owatch_incident'/)
    expect(ps).toMatch(/Alerts      : NOT configured/); expect(ps).toMatch(/alert_snooze_until/); expect(ps).toMatch(/-SendTestAlert/)
  })

  it('states the same-fate warning and the manual steps in the summary', () => {
    expect(ps).toMatch(/in a Microsoft outage an alert/)
    expect(ps).toMatch(/SAME-FATE WARNING/)
    expect(ps).toMatch(/outage-watch-package/)
    expect(ps).toMatch(/Still manual/)
  })
})

describe('.cmd wrappers', () => {
  for (const f of ['Deploy-OutageWatchPP.cmd', 'Uninstall-OutageWatchPP.cmd']) {
    it(`${f}: CRLF, ASCII, runs the .ps1 with -File and forwards the arguments and the exit code`, () => {
      const t = read(f)
      expect(t.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
      expect([...t].every((c) => c.charCodeAt(0) < 127)).toBe(true)
      expect(t).toMatch(/-File "%~dp0Deploy-OutageWatchPP\.ps1"( -Uninstall)? %\*/)
      expect(t).toMatch(/exit \/b %OWPP_EXIT%/)
    })
  }
  it('uninstall wrapper passes -Uninstall', () => { expect(read('Uninstall-OutageWatchPP.cmd')).toContain('-Uninstall %*') })
})
