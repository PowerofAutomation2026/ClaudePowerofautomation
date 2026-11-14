import { describe, expect, it } from 'vitest'
import { toTargets } from '../src/data/live'
import { demoTargetList, probed } from '../src/data/demo'

describe('target rows -> dashboard targets', () => {
  const row = (name: string, url: string | null, enabled: boolean | null, extra: Record<string, unknown> = {}) => ({ owatch_name: name, owatch_url: url, owatch_enabled: enabled, owatch_alivecodes: null, owatch_dependsonauth: true, owatch_copilotneeds: false, ...extra })
  it('URL + enabled = probed; no URL = unconfigured (shown, neutral); URL + disabled = hidden', () => {
    const t = toTargets([row('teams', 'https://teams.microsoft.com/', true), row('sharepoint-online', null, false), row('onedrive-business', '', false), row('intune', 'https://x.example/', false)])
    expect(t.map((x) => x.name)).toEqual(['teams', 'sharepoint-online', 'onedrive-business'])
    expect(t[0]).toMatchObject({ enabled: true, unconfigured: false, family: 'Teams' })
    expect(t[1]).toMatchObject({ enabled: false, unconfigured: true, family: 'SharePoint / OneDrive' })
    expect(t[2].unconfigured).toBe(true)
  })
  it('family: the column wins, then the catalog by name, then Independent (tables from before the family column still work)', () => {
    const t = toTargets([row('power-bi', 'https://app.powerbi.com/', true), row('my-app', 'https://my.example/', true), row('erp', 'https://erp.example/', true, { owatch_family: 'Line of business' })])
    expect(t.map((x) => x.family)).toEqual(['Power Platform & dashboards', 'Independent', 'Line of business'])
  })
  it('ignores nameless rows and duplicates; hostile text is kept as inert, length-limited text', () => {
    const t = toTargets([row('', 'https://a.example/', true), row('teams', 'https://a.example/', true), row('teams', 'https://b.example/', true), row('<script>alert(1)</script>' + 'x'.repeat(300), 'https://c.example/', true), null, undefined, 5] as never[])
    expect(t).toHaveLength(2)
    expect(t[0].url).toBe('https://a.example/')
    expect(t[1].name.length).toBe(100)
  })
})

describe('demo data', () => {
  it('36 services; without a tenant name two are unconfigured and never get sample rows', () => {
    const t = demoTargetList(null)
    expect(t).toHaveLength(36)
    expect(t.filter((x) => x.unconfigured).map((x) => x.name)).toEqual(['sharepoint-online', 'onedrive-business'])
    expect(probed(t)).toHaveLength(34)
    expect(probed(demoTargetList('contoso'))).toHaveLength(36)
  })
})
