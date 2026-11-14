import { describe, expect, it } from 'vitest'
import catalog from '../shared/catalog.json'
import { buildFrames, dependencyEdges, type RawRow, type TargetSpec } from '../src/logic/classify'
import { derive, downstream, layout, roleStatus, topo } from '../src/logic/graph'

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
    expect(r[0].why).toContain('auth is not answering')
  })
  it('one failed probe (suspect) is "may be unreliable"; unmonitored services give "Not monitored"', () => {
    const f = frameWith({ teams: 503 }, 1); const D = derive(f, T)
    const r = Object.fromEntries(roleStatus({ ...catalog.roles, Printing: ['print-server'] }, f, D).map((x) => [x.name, x]))
    expect(r['Meetings'].k).toBe('warning'); expect(r['Meetings'].why).toContain('not yet confirmed')
    expect(r['Email & calendar'].k).toBe('up')
    expect(r['Printing'].k).toBe('none')
  })
})

describe('layout', () => {
  for (const narrow of [false, true]) {
    for (const set of [names, catalog.targets.map((t) => t.name)]) {
      it(`${narrow ? '360 px' : 'wide'}, ${set.length} services: every node placed, inside the canvas, no overlap`, () => {
        const TT = topo(set, dependencyEdges(targets.filter((t) => set.includes(t.name))))
        const L = layout(set, TT, narrow)
        expect(L.pos.size).toBe(set.length)
        if (narrow) expect(L.width).toBe(360)
        const pts = [...L.pos.entries()]
        const pad = narrow ? 44 : 60
        for (const [n, p] of pts) {
          expect(p.x, n).toBeGreaterThanOrEqual(pad); expect(p.x, n).toBeLessThanOrEqual(L.width - pad)
          expect(p.y, n).toBeGreaterThanOrEqual(L.r + 4); expect(p.y, n).toBeLessThanOrEqual(L.height - 40)
        }
        for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
          const dx = Math.abs(pts[i][1].x - pts[j][1].x); const dy = Math.abs(pts[i][1].y - pts[j][1].y)
          // labels sit under the node: need horizontal room for the text or vertical room for node + 2 text lines
          expect(dx >= (narrow ? 84 : 104) || dy >= (narrow ? 84 : 78), `${pts[i][0]} vs ${pts[j][0]} (${dx.toFixed(0)}, ${dy.toFixed(0)})`).toBe(true)
        }
      })
    }
  }
  it('is deterministic', () => {
    expect([...layout(names, T, false).pos]).toEqual([...layout([...names].reverse(), topo([...names].reverse(), dependencyEdges(targets)), false).pos])
  })
})
