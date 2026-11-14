import { describe, expect, it } from 'vitest'
import catalog from '../shared/catalog.json'
import { buildFrames, dependencyEdges, type RawRow, type TargetSpec } from '../src/logic/classify'
import { derive, downstream, familySummary, groupFamilies, isProblem, layoutFamilies, roleStatus, topo } from '../src/logic/graph'

const targets: TargetSpec[] = [...catalog.targets, ...catalog.tenantTargets].map((t) => ({ name: t.name, alive: t.alive, dependsOnAuth: t.dependsOnAuth, copilotNeeds: t.copilotNeeds }))
const names = targets.map((t) => t.name)
const T = topo(names, dependencyEdges(targets))
const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, i * 5)).toISOString()
const round = (i: number, bad: Record<string, number | null> = {}): RawRow[] => names.map((n) => ({ name: n, httpStatus: n in bad ? bad[n] : 200, elapsedMs: 100, errorKind: n in bad && bad[n] == null ? 'ActionTimedOut' : '', at: at(i), round: at(i) }))
const frameWith = (bad: Record<string, number | null>, rounds = 2) => {
  const rows: RawRow[] = []
  for (let i = 0; i < rounds; i++) rows.push(...round(i, bad))
  const f = buildFrames(rows, targets)
  return f[f.length - 1]
}

describe('blast radius', () => {
  it('auth down puts every sign-in dependent service at risk, and nothing else', () => {
    const D = derive(frameWith({ auth: null }), T)
    expect(D.get('auth')!.kind).toBe('down')
    for (const t of targets) {
      if (t.name === 'auth') continue
      expect(D.get(t.name)!.kind, t.name).toBe(t.dependsOnAuth ? 'risk-down' : 'up')
    }
    expect(D.get('teams')!.via).toEqual(['auth'])
  })
  it('a data service failing puts Copilot at risk (Copilot-underneath)', () => {
    const D = derive(frameWith({ exchange: 503 }), T)
    expect(D.get('exchange')!.kind).toBe('down')
    expect(D.get('m365-copilot')!.kind).toBe('risk-down')
    expect(D.get('teams')!.kind).toBe('up')
  })
  it('a warning upstream is only "may be slow" downstream', () => {
    const D = derive(frameWith({ graph: 404 }), T)
    expect(D.get('graph')!.kind).toBe('warning')
    expect(D.get('m365-copilot')!.kind).toBe('risk-warn')
  })
  it('downstream is transitive and never includes the node itself', () => {
    const d = downstream('auth', T.out)
    expect(d.has('m365-copilot')).toBe(true); expect(d.has('auth')).toBe(false); expect(d.has('office-cdn')).toBe(false)
  })
})

describe('"Can I do my job?"', () => {
  it('all healthy', () => {
    const f = frameWith({}); const r = roleStatus(catalog.roles, f, derive(f, T))
    expect(r.every((x) => x.k === 'up')).toBe(true)
  })
  it('auth down: every role that needs sign-in is unlikely to work, with the cause named', () => {
    const f = frameWith({ auth: null }); const r = roleStatus(catalog.roles, f, derive(f, T))
    expect(r.every((x) => x.k === 'down')).toBe(true)
    expect(r).toHaveLength(11)
    expect(r[0].why).toContain('auth is not answering')
  })
  it('one failed probe (suspect) is "may be unreliable"; unmonitored services give "Not monitored"', () => {
    const f = frameWith({ teams: 503 }, 1); const D = derive(f, T)
    const r = Object.fromEntries(roleStatus({ ...catalog.roles, Printing: ['print-server'] }, f, D).map((x) => [x.name, x]))
    expect(r['Meetings'].k).toBe('warning'); expect(r['Meetings'].why).toContain('not yet confirmed')
    expect(r['Email & calendar'].k).toBe('up')
    expect(r['Printing'].k).toBe('none')
  })
  it('tenant targets not set up: "Cannot fully tell", named, never a failure', () => {
    const t2 = targets.map((t) => (t.name === 'sharepoint-online' || t.name === 'onedrive-business' ? { ...t, unconfigured: true } : t))
    const rows: RawRow[] = round(0).filter((r) => r.name !== 'sharepoint-online' && r.name !== 'onedrive-business')
    const f = buildFrames(rows, t2)[0]
    const r = Object.fromEntries(roleStatus(catalog.roles, f, derive(f, T)).map((x) => [x.name, x]))
    expect(f.level).toBe('ok')
    expect(r['Files & sharing'].k).toBe('blocked')
    expect(r['Files & sharing'].why).toContain('not set up (tenant name missing)')
    expect(derive(f, T).get('sharepoint-online')!.kind).toBe('unconfigured')
  })
})

const DEP = new Set(targets.filter((t) => t.dependsOnAuth).map((t) => t.name))
const COP = new Set(targets.filter((t) => t.copilotNeeds).map((t) => t.name))
const FAMS = groupFamilies(names, catalog.families as [string, string[]][])

describe('families', () => {
  it('36 services in the 9 Python families, in order; unknown services land in Independent', () => {
    expect(names).toHaveLength(36)
    expect(FAMS.map((f) => f.name)).toEqual(catalog.families.map((f) => f[0]))
    expect(FAMS.reduce((n, f) => n + f.nodes.length, 0)).toBe(36)
    const g = groupFamilies([...names, 'my-custom-app'], catalog.families as [string, string[]][])
    expect(g.find((f) => f.name === 'Independent')!.nodes).toContain('my-custom-app')
    expect(groupFamilies(['x'], catalog.families as [string, string[]][], () => 'Line of business')[0]).toEqual({ name: 'Line of business', nodes: ['x'] })
  })
  it('summary: worst state and counts; neutral states are not problems', () => {
    const D = derive(frameWith({ exchange: 503 }), T)
    const ex = familySummary(FAMS.find((f) => f.name === 'Exchange')!.nodes, D)
    expect(ex.worst).toBe('down'); expect(ex.problems).toBe(1); expect(ex.text).toBe('1 down')
    const cop = familySummary(FAMS.find((f) => f.name === 'Copilot')!.nodes, D)
    expect(cop.worst).toBe('risk-down'); expect(cop.text).toBe('1 at risk')
    expect(familySummary(FAMS.find((f) => f.name === 'Teams')!.nodes, D)).toMatchObject({ worst: 'up', problems: 0, text: 'all answering' })
    expect(isProblem('unconfigured')).toBe(false); expect(isProblem('blocked')).toBe(false); expect(isProblem('risk-warn')).toBe(true)
  })
})

describe('layout: family bands on two buses, 36 services', () => {
  for (const narrow of [false, true]) {
    it(`${narrow ? '360 px' : 'wide'}: every node placed, inside the canvas, no overlap, labels have room`, () => {
      const L = layoutFamilies(FAMS, DEP, COP, { narrow })
      expect(L.pos.size).toBe(36)
      expect(L.width).toBe(narrow ? 360 : 1000)
      const pts = [...L.pos.entries()]
      for (const [n, p] of pts) {
        expect(p.x - 50, n).toBeGreaterThanOrEqual(narrow ? 12 : 30)          // half a label (13 chars) fits left of the bus
        expect(p.x + 50, n).toBeLessThanOrEqual(L.width - (narrow ? 12 : 30))
        const band = L.bands.find((b) => b.nodes.includes(n))!
        expect(p.y - L.r - 12, n).toBeGreaterThanOrEqual(band.y + 22)           // below the family header, with room for the Copilot rail
        expect(p.y + L.r + 50, n).toBeLessThanOrEqual(band.y + band.h)          // two label lines + state line fit inside the band
      }
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
        const dx = Math.abs(pts[i][1].x - pts[j][1].x); const dy = Math.abs(pts[i][1].y - pts[j][1].y)
        expect(dx >= 104 || dy >= 88, `${pts[i][0]} vs ${pts[j][0]} (${dx}, ${dy})`).toBe(true)
      }
      for (let i = 1; i < L.bands.length; i++) expect(L.bands[i].y).toBeGreaterThanOrEqual(L.bands[i - 1].y + L.bands[i - 1].h)
      expect(L.height).toBeGreaterThanOrEqual(L.bands[L.bands.length - 1].y + L.bands[L.bands.length - 1].h)
    })
    it(`${narrow ? '360 px' : 'wide'}: the sign-in rail of a row never runs through a service that does not need sign-in`, () => {
      const L = layoutFamilies(FAMS, DEP, COP, { narrow })
      for (const rail of L.rails.filter((x) => x.kind === 'signin' && x.family !== '*')) {
        const m = /^M([\d.]+),([\d.]+)L([\d.]+),([\d.]+)$/.exec(rail.d)!
        const [x1, y, x2] = [Number(m[1]), Number(m[2]), Number(m[3])]
        for (const [n, p] of L.pos) if (Math.abs(p.y - y) < 1 && p.x > x1 && p.x <= x2) expect(DEP.has(n) || n === 'auth', `${n} sits on a sign-in rail`).toBe(true)
      }
      // every dependant is reached by a rail
      for (const n of DEP) { const p = L.pos.get(n)!; expect(L.rails.some((x) => x.kind === 'signin' && x.d.includes(`,${p.y.toFixed(1)}L`) && Number(/L([\d.]+),/.exec(x.d)![1]) >= p.x), n).toBe(true) }
      // every Copilot source and the sink have a tick
      for (const n of [...COP, 'm365-copilot']) { const p = L.pos.get(n)!; expect(L.rails.some((x) => x.kind === 'copilot' && x.d.includes(`M${p.x.toFixed(1)},`)), n).toBe(true) }
    })
  }
  it('collapsing families shrinks the map, keeps them on the buses, and is deterministic', () => {
    const open = layoutFamilies(FAMS, DEP, COP, { narrow: true })
    const some = layoutFamilies(FAMS, DEP, COP, { narrow: true, collapsed: new Set(['Office apps', 'Exchange']) })
    expect(some.height).toBeLessThan(open.height)
    expect(some.pos.has('forms')).toBe(false); expect(some.pos.has('teams')).toBe(true)
    expect(some.rails.some((r) => r.family === 'Exchange' && r.kind === 'signin')).toBe(true)
    expect(some.rails.some((r) => r.family === 'Exchange' && r.kind === 'copilot' && r.from.includes('exchange'))).toBe(true)
    const allShut = layoutFamilies(FAMS, DEP, COP, { narrow: false, collapsed: new Set(FAMS.map((f) => f.name)) })
    expect(allShut.pos.size).toBe(0); expect(allShut.bands).toHaveLength(9)
    expect(JSON.stringify([...open.pos])).toBe(JSON.stringify([...layoutFamilies(FAMS, DEP, COP, { narrow: true }).pos]))
  })
  it('works without a hub or sink, and with one service', () => {
    const L = layoutFamilies([{ name: 'Independent', nodes: ['copilot-web'] }], DEP, COP, { narrow: false })
    expect(L.pos.size).toBe(1); expect(L.rails).toEqual([]); expect(L.hub).toBeNull()
  })
})
