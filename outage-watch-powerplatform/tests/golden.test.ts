/**
 * Cross-check of the TypeScript port against golden cases produced by the REAL Python code
 * (tests/golden/gen_golden.py runs outagewatch.py: probe(), Monitor, Automation, impact, copilot_note,
 * diagnose, stress_score). Scenarios are copied from test_outagewatch.py plus a seeded random fuzz.
 */
import { describe, expect, it } from 'vitest'
import golden from './golden/golden.json'
import catalog from '../shared/catalog.json'
import {
  Automation, Monitor, NEUTRAL, PYTHON_TEXT, buildFrames, copilotNote, dependencyEdges, diagnose, impact, rawState, stressScore, targetLevel,
  type Frame, type RawState, type ServiceView, type State,
} from '../src/logic/classify'
import { derive, groupFamilies, roleStatus, topo, type RoleKind } from '../src/logic/graph'
// @ts-expect-error plain .mjs helper
import { assertTenantName } from '../provision/lib/validate.mjs'

/* eslint-disable @typescript-eslint/no-explicit-any */
const G = golden as any
/** Tenant targets shared with the Python monitor. The Power Platform edition adds its own (ppOnly) on top. */
const SHARED_TENANT = catalog.tenantTargets.filter((t) => !(t as any).ppOnly)
const DEP = new Set<string>(G.catalog.depends_on_auth)
const COP = new Set<string>(G.catalog.copilot_needs)

describe('catalog matches the Python defaults', () => {
  it('has the same 34 default targets, URLs and alive codes', () => {
    const py = G.catalog.targets as Record<string, [string, number[] | null]>
    expect(catalog.targets.map((t) => t.name).sort()).toEqual(Object.keys(py).sort())
    expect(catalog.targets).toHaveLength(34)
    expect(catalog.targets.length + SHARED_TENANT.length).toBe(36)
    expect(catalog.tenantTargets.filter((t) => (t as any).ppOnly).map((t) => t.name)).toEqual(['sharepoint-admin'])   // Power Platform edition only; not in the Python catalog
    for (const t of catalog.targets) {
      expect(t.url).toBe(py[t.name][0])
      expect(t.alive === null ? null : [...t.alive].sort()).toEqual(py[t.name][1])
    }
  })
  it('has the same dependency flags (incl. tenant targets) and edges', () => {
    const all = [...catalog.targets, ...SHARED_TENANT]
    expect(all.filter((t) => t.dependsOnAuth).map((t) => t.name).sort()).toEqual(G.catalog.depends_on_auth)
    expect(all.filter((t) => t.copilotNeeds).map((t) => t.name).sort()).toEqual(G.catalog.copilot_needs)
    const spec = all.map((t) => ({ name: t.name, alive: t.alive, dependsOnAuth: t.dependsOnAuth, copilotNeeds: t.copilotNeeds }))
    // Python lists edges for every name in the sets; ours only for existing targets. With auth + copilot + tenant targets present they are identical.
    expect(dependencyEdges(spec)).toEqual(G.catalog.edges)
  })
  it('has the same tenant URL templates and roles', () => {
    for (const t of SHARED_TENANT) expect(t.urlTemplate.replace('{tenant}', 'contoso')).toBe(G.catalog.tenant[t.name])
    expect(catalog.roles).toEqual(G.catalog.roles)
    expect(Object.keys(catalog.roles)).toEqual(expect.arrayContaining(['Dashboards & reporting', 'Forms & tasks', 'Security & compliance admin', 'Teams admin']))
    expect(catalog.roles['Files & sharing']).toEqual(['auth', 'sharepoint-online', 'onedrive-business', 'onedrive-sync'])
    expect(SHARED_TENANT.map((t) => t.name)).toEqual(G.catalog.tenant_services)
    expect([...NEUTRAL].sort()).toEqual([...G.catalog.neutral].sort())
  })
  it('has the same families, every service in exactly one, and the same family per target', () => {
    expect(catalog.families).toEqual(G.catalog.families)
    const all = [...catalog.targets, ...SHARED_TENANT]
    const inFam = catalog.families.flatMap((f) => f[1] as string[])
    expect([...inFam].sort()).toEqual(all.map((t) => t.name).sort())
    for (const t of all) expect((catalog.families.find((f) => (f[1] as string[]).includes(t.name)) ?? [])[0], t.name).toBe(t.family)
    const g = groupFamilies(all.map((t) => t.name), catalog.families as [string, string[]][])
    expect(g.map((f) => [f.name, f.nodes])).toEqual(G.catalog.families)
  })
  it('accepts and rejects the same tenant names as valid_tenant()', () => {
    for (const [t, ok] of G.catalog.tenant_valid as [string, boolean][]) {
      let mine = true
      try { assertTenantName(t) } catch { mine = false }
      expect(mine, JSON.stringify(t)).toBe(ok)
    }
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

const EDGES = G.catalog.edges as [string, string][]
const PY_ROLE: Record<RoleKind, string> = { up: 'ok', warning: 'shaky', down: 'down', blocked: 'unknown', none: 'unmonitored' }
/** Our roleStatus() on a plain state map, expressed in the status words of Python's role_view(). */
function roleKinds(state: Record<string, State>): [string, string][] {
  const services = new Map<string, ServiceView>(Object.entries(state).map(([n, st]) => [n, { state: st, raw: 'up', ms: 0, code: null, error: null, baseline: null, warnMs: null }]))
  const frame: Frame = { t: '', level: 'ok', levelChanged: null, verdict: '', early: [], services }
  const T = topo(Object.keys(state), EDGES)
  return roleStatus(G.catalog.roles, frame, derive(frame, T)).map((r) => [r.name, PY_ROLE[r.k]])
}

describe('verdict rules == Python diagnose() (unconfigured ignored, blocked never hides a failure, long lists capped)', () => {
  for (const [name, c] of Object.entries<any>(G.diagnose)) {
    it(name, () => { expect(diagnose(c.in.map(([n, st]: [string, RawState]) => ({ name: n, state: st })), PYTHON_TEXT)).toBe(c.out) })
  }
  it('the two rules the update asked for, spelled out', () => {
    expect(G.diagnose.blocked_does_not_hide_failure.out).toMatch(/^partial outage: b \| BLOCKED/)
    expect(G.diagnose.long_list_is_capped.out).toMatch(/ and 16 more/)
  })
})

describe('role view == Python role_view() statuses', () => {
  for (const [name, c] of Object.entries<any>(G.role_view)) it(name, () => { expect(Object.fromEntries(roleKinds(c.in))).toEqual(Object.fromEntries(c.out)) })
  it('covers the new rows', () => {
    const rows = Object.fromEntries(G.role_view.healthy_no_tenant.out)
    expect(rows['Files & sharing']).toBe('unknown')          // only partly monitored: tenant name not set
    expect(rows['Dashboards & reporting']).toBe('ok'); expect(rows['Teams admin']).toBe('ok')
    expect(Object.fromEntries(G.role_view.auth_down.out)['Security & compliance admin']).toBe('down')
  })
})

describe('buildFrames with an unconfigured target == Python run_cycle() semantics', () => {
  it('unconfigured is present, neutral, never at risk, never raises the level', () => {
    const targets = [{ name: 'auth', alive: [200], dependsOnAuth: false, copilotNeeds: false }, { name: 'sharepoint-online', alive: null, dependsOnAuth: true, copilotNeeds: true, unconfigured: true }, { name: 'teams', alive: null, dependsOnAuth: true, copilotNeeds: true }]
    const row = (i: number, name: string, httpStatus: number | null) => ({ name, httpStatus, elapsedMs: 100, errorKind: '', at: `2026-01-01T00:0${i}:00.000Z`, round: `r${i}` })
    const f = buildFrames([row(0, 'auth', 200), row(0, 'teams', 200), row(1, 'auth', null), row(1, 'teams', 200), row(1, 'sharepoint-online', 503)], targets)
    expect(f[0].services.get('sharepoint-online')!.state).toBe('unconfigured')
    expect(f[0].level).toBe('ok')
    expect(f[0].verdict).toMatch(/^all healthy \| 1 not set up \(needs your tenant name/)
    expect(f[1].verdict).toContain('at risk: teams')
    expect(f[1].verdict).not.toContain('at risk: sharepoint')
    expect(f[1].services.get('sharepoint-online')!.state).toBe('unconfigured')   // a stray row for an unconfigured target is ignored
  })
})

describe('seeded fuzz: Monitor + Automation + impact + copilot note + diagnose + stress == Python', () => {
  G.fuzz.forEach((c: any, i: number) => {
    it(`case ${i} (${c.steps.length} rounds, ${JSON.stringify(c.kw)})`, () => {
      const m = new Monitor({ confirm: c.kw.confirm, window: c.kw.window, minHistory: c.kw.min_history, factor: c.kw.factor, floorMs: c.kw.floor_ms })
      const a = new Automation(c.recover_after)
      const hist = new Map<string, [State, number][]>()
      for (const s of c.steps) {
        const results = s.in.map(([name, state, ms]: [string, RawState, number]) => ({ name, state, ms }))
        expect(diagnose(results, PYTHON_TEXT)).toBe(s.diagnose)
        const state = m.step(results)
        expect(state).toEqual(s.out)
        expect(targetLevel(state)).toBe(s.target_level)
        expect(a.step(state)).toBe(s.changed)
        expect(a.level).toBe(s.level)
        expect(impact(state, DEP)).toEqual(s.impact)
        expect(copilotNote(state, COP)).toBe(s.note)
        expect(Object.fromEntries(roleKinds(state)), 'role view').toEqual(Object.fromEntries(s.roles))
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
