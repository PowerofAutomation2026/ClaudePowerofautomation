/**
 * Cross-check of the TypeScript port against golden cases produced by the REAL Python code
 * (tests/golden/gen_golden.py runs outagewatch.py: probe(), Monitor, Automation, impact, copilot_note,
 * diagnose, stress_score). Scenarios are copied from test_outagewatch.py plus a seeded random fuzz.
 */
import { describe, expect, it } from 'vitest'
import golden from './golden/golden.json'
import catalog from '../shared/catalog.json'
import {
  Automation, Monitor, copilotNote, dependencyEdges, diagnoseKind, impact, rawState, stressScore, targetLevel,
  type RawState, type State,
} from '../src/logic/classify'

/* eslint-disable @typescript-eslint/no-explicit-any */
const G = golden as any
const DEP = new Set<string>(G.catalog.depends_on_auth)
const COP = new Set<string>(G.catalog.copilot_needs)

describe('catalog matches the Python defaults', () => {
  it('has the same 15 targets, URLs and alive codes', () => {
    const py = G.catalog.targets as Record<string, [string, number[] | null]>
    expect(catalog.targets.map((t) => t.name).sort()).toEqual(Object.keys(py).sort())
    expect(catalog.targets).toHaveLength(15)
    for (const t of catalog.targets) {
      expect(t.url).toBe(py[t.name][0])
      expect(t.alive === null ? null : [...t.alive].sort()).toEqual(py[t.name][1])
    }
  })
  it('has the same dependency flags (incl. tenant targets) and edges', () => {
    const all = [...catalog.targets, ...catalog.tenantTargets]
    expect(all.filter((t) => t.dependsOnAuth).map((t) => t.name).sort()).toEqual(G.catalog.depends_on_auth)
    expect(all.filter((t) => t.copilotNeeds).map((t) => t.name).sort()).toEqual(G.catalog.copilot_needs)
    const spec = all.map((t) => ({ name: t.name, alive: t.alive, dependsOnAuth: t.dependsOnAuth, copilotNeeds: t.copilotNeeds }))
    // Python lists edges for every name in the sets; ours only for existing targets. With auth + copilot + tenant targets present they are identical.
    expect(dependencyEdges(spec)).toEqual(G.catalog.edges)
  })
  it('has the same tenant URL templates and roles', () => {
    for (const t of catalog.tenantTargets) expect(t.urlTemplate.replace('{tenant}', 'contoso')).toBe(G.catalog.tenant[t.name])
    expect(catalog.roles).toEqual(G.catalog.roles)
  })
})

describe('raw probe state == Python probe()', () => {
  it(`agrees on ${G.probe.length} (status, alive-codes) cases`, () => {
    for (const c of G.probe) {
      const got = rawState({ name: 't', httpStatus: c.code, elapsedMs: 5, errorKind: c.code == null ? 'ConnectionRefusedError' : '' }, c.alive)
      expect(got, JSON.stringify(c)).toBe(c.state)
    }
  })
})

describe('Monitor == Python Monitor (scenarios from test_outagewatch.py)', () => {
  for (const [name, sc] of Object.entries<any>(G.monitor)) {
    it(name, () => {
      const kw = sc.kw
      const m = new Monitor({ confirm: kw.confirm, window: kw.window, minHistory: kw.min_history, factor: kw.factor, floorMs: kw.floor_ms })
      for (const s of sc.steps) {
        const results = s.in.map(([name, state, ms]: [string, RawState, number]) => ({ name, state, ms }))
        expect(m.step(results)).toEqual(s.out)
        for (const [n, b] of Object.entries(s.baseline)) expect(m.baseline(n)).toBe(b)
      }
    })
  }
})

describe('seeded fuzz: Monitor + Automation + impact + copilot note + diagnose + stress == Python', () => {
  G.fuzz.forEach((c: any, i: number) => {
    it(`case ${i} (${c.steps.length} rounds, ${JSON.stringify(c.kw)})`, () => {
      const m = new Monitor({ confirm: c.kw.confirm, window: c.kw.window, minHistory: c.kw.min_history, factor: c.kw.factor, floorMs: c.kw.floor_ms })
      const a = new Automation(c.recover_after)
      const hist = new Map<string, [State, number][]>()
      for (const s of c.steps) {
        const results = s.in.map(([name, state, ms]: [string, RawState, number]) => ({ name, state, ms }))
        expect(diagnoseKind(results)).toBe(s.diagnose)
        const state = m.step(results)
        expect(state).toEqual(s.out)
        expect(targetLevel(state)).toBe(s.target_level)
        expect(a.step(state)).toBe(s.changed)
        expect(a.level).toBe(s.level)
        expect(impact(state, DEP)).toEqual(s.impact)
        expect(copilotNote(state, COP)).toBe(s.note)
        for (const [n, b] of Object.entries(s.baseline)) expect(m.baseline(n)).toBe(b)
        for (const r of results) {
          const h = hist.get(r.name) ?? []
          h.push([state[r.name], r.ms]); hist.set(r.name, h)
          expect(stressScore(h, m.baseline(r.name), m.warnMs(r.name)), `stress ${r.name}`).toBe(s.stress[r.name])
        }
      }
    })
  })
})

describe('Automation == Python Automation', () => {
  it('target levels', () => { for (const [s, want] of G.automation.levels) expect(targetLevel(s)).toBe(want) })
  for (const name of ['escalates_immediately_recovers_slowly', 'flap_resets_recovery', 'caution_then_freeze_then_caution']) {
    it(name, () => {
      const a = new Automation(3)
      for (const s of G.automation[name]) { expect(a.step(s.in)).toBe(s.changed); expect(a.level).toBe(s.level) }
    })
  }
  it('impact and copilot note', () => {
    for (const [s, want] of G.impact) expect(impact(s, DEP)).toEqual(want)
    for (const [s, want] of G.copilot_note) expect(copilotNote(s, COP)).toBe(want)
  })
})
