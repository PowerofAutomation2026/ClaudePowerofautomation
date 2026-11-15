/**
 * Insights: deterministic, explainable analysis computed IN THE BROWSER from rows the dashboard already loaded.
 * No model, no prediction, no extra flow runs. Every result carries the numbers it was derived from, so a reader
 * can check it. "Probable" is used on purpose: the probes see symptoms, never causes.
 *
 * Pure functions only (no DOM, no clock, no network); tests/insights.test.ts covers hostile, empty and tiny input.
 */
import type { Frame, State } from './classify'
import type { Derived } from './graph'
import type { IncidentRow } from '../data/types'

const BAD = (s: State) => s === 'down' || s === 'suspect'
const NEUTRAL = (s: State) => s === 'blocked' || s === 'unconfigured'
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0 }
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]
}
const clean = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max)

// ---------------------------------------------------------------------------------------------
// I1. Probable common cause
// ---------------------------------------------------------------------------------------------
export interface CommonCause {
  kind: 'sign-in' | 'everything' | 'family' | 'copilot-underneath'
  title: string
  /** The facts the statement rests on. */
  evidence: string[]
  /** What this kind of probe cannot tell. Always shown with the statement. */
  cannotKnow: string
}
export interface CauseTarget { name: string; family: string; dependsOnAuth: boolean; copilotNeeds: boolean }
const CANNOT = 'The probes are anonymous HTTP checks from Microsoft’s cloud: they cannot know the real root cause, or whether your tenant and signed-in users are affected.'

/**
 * Looks at ONE frame and names the most likely shared reason, in this order: (1) sign-in failing, (2) nearly
 * everything failing (points at the probe path, not at 30 services), (3) Copilot failing with a service it reads
 * from, (4) failures concentrated in one family. Returns null when nothing is failing or nothing is shared.
 */
export function commonCause(frame: Frame, D: Map<string, Derived>, targets: CauseTarget[]): CommonCause | null {
  const spec = new Map(targets.map((t) => [t.name, t]))
  const probed = [...frame.services.entries()].filter(([, v]) => !NEUTRAL(v.state))
  const failing = probed.filter(([, v]) => BAD(v.state)).map(([n]) => n).sort()
  if (!failing.length) return null
  const say = (n: string) => { const v = frame.services.get(n)!; return `${clean(n, 60)}: ${v.state}, ${v.code == null ? 'no HTTP answer' : 'HTTP ' + v.code}${v.error ? ' (' + clean(v.error, 60) + ')' : ''}` }
  const auth = frame.services.get('auth')
  if (probed.length >= 5 && failing.length / probed.length >= 0.8) {
    return { kind: 'everything', title: 'Probable common cause: the probe path itself (flow, connector or network), not ' + failing.length + ' separate outages',
      evidence: [`${failing.length} of ${probed.length} probed services failed in the same round`, 'independent services (for example ' + failing.filter((n) => !spec.get(n)?.dependsOnAuth).slice(0, 3).map((n) => clean(n, 40)).join(', ') + ') failed together with the others'].filter((e) => !e.endsWith('example ) failed together with the others')),
      cannotKnow: CANNOT + ' Check the flow run history and the independent monitor before concluding that Microsoft 365 is down.' }
  }
  if (auth && BAD(auth.state)) {
    const others = failing.filter((n) => n !== 'auth')
    const dep = others.filter((n) => spec.get(n)?.dependsOnAuth)
    const atRisk = [...D.entries()].filter(([, d]) => d.kind === 'risk-down' || d.kind === 'risk-warn').length
    return { kind: 'sign-in', title: 'Probable common cause: sign-in (auth) is not answering',
      evidence: [say('auth'), others.length ? `${dep.length} of the ${others.length} other failing services need sign-in` : 'no other service is failing its own probe yet', `${atRisk} more services answer their own probe but depend on sign-in (shown as "at risk")`],
      cannotKnow: CANNOT }
  }
  const cop = frame.services.get('m365-copilot')
  if (cop && BAD(cop.state)) {
    const under = failing.filter((n) => n !== 'm365-copilot' && spec.get(n)?.copilotNeeds)
    if (under.length) return { kind: 'copilot-underneath', title: 'Probable cause of the Copilot failure: a service it reads from is failing', evidence: [say('m365-copilot'), ...under.slice(0, 4).map(say)], cannotKnow: CANNOT }
  }
  if (failing.length >= 3) {
    const by = new Map<string, string[]>()
    for (const n of failing) { const f = spec.get(n)?.family || 'Independent'; by.set(f, [...(by.get(f) ?? []), n]) }
    const [fam, list] = [...by.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))[0]
    if (list.length / failing.length >= 0.6) return { kind: 'family', title: `Failures are concentrated in one family: ${clean(fam, 60)}`, evidence: [`${list.length} of ${failing.length} failing services belong to it: ${list.slice(0, 6).map((n) => clean(n, 40)).join(', ')}`], cannotKnow: CANNOT }
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// I3. Drift (slow degradation before the 3x warning rule)   I4. Flapping
// ---------------------------------------------------------------------------------------------
export interface DriftOptions { window: number; percent: number; minMs: number }
export const DEFAULT_DRIFT: DriftOptions = { window: 6, percent: 50, minMs: 150 }
export interface Drift { name: string; recentMedian: number; baseline: number; percentUp: number; samples: number }

/**
 * A service is "drifting" when the median of its last `window` answered probes is at least `percent` % AND
 * `minMs` above its baseline, while it is still classified "up". It is an advisory: it never changes the level.
 * The baseline is the median of the answered probes BEFORE the recent window (at least `window` of them).
 */
export function drifting(frames: Frame[], o: DriftOptions = DEFAULT_DRIFT): Drift[] {
  const last = frames[frames.length - 1]
  if (!last) return []
  const out: Drift[] = []
  for (const [name, cur] of last.services) {
    if (cur.state !== 'up') continue                               // warning / failing is already shown as such
    const ms: number[] = []
    for (const f of frames) { const v = f.services.get(name); if (v && f.t && (v.state === 'up' || v.state === 'warning')) ms.push(v.ms) }
    // one sample per frame in which the service was actually probed (frames repeat the last view of an absent service)
    if (ms.length < o.window * 2) continue
    const recent = median(ms.slice(-o.window)); const base = median(ms.slice(0, -o.window).slice(-Math.max(o.window * 4, 20)))
    if (base <= 0) continue
    const pct = Math.round(((recent - base) / base) * 100)
    if (pct >= o.percent && recent - base >= o.minMs) out.push({ name, recentMedian: recent, baseline: base, percentUp: pct, samples: ms.length })
  }
  return out.sort((a, b) => b.percentUp - a.percentUp || (a.name < b.name ? -1 : 1))
}

export interface Flap { name: string; changes: number; rounds: number }
/** Changes between "answering" and "failing" over the last `rounds` frames; `minChanges` or more = flapping. */
export function flapping(frames: Frame[], rounds = 12, minChanges = 4): Flap[] {
  const win = frames.slice(-rounds)
  const names = new Set(win.flatMap((f) => [...f.services.keys()]))
  const out: Flap[] = []
  for (const name of names) {
    let prev: boolean | null = null; let changes = 0
    for (const f of win) { const v = f.services.get(name); if (!v || NEUTRAL(v.state)) continue; const bad = BAD(v.state); if (prev !== null && bad !== prev) changes++; prev = bad }
    if (changes >= minChanges) out.push({ name, changes, rounds: win.length })
  }
  return out.sort((a, b) => b.changes - a.changes || (a.name < b.name ? -1 : 1))
}

// ---------------------------------------------------------------------------------------------
// I7. Reliability scorecard (for the loaded window only: that is what the browser has)
// ---------------------------------------------------------------------------------------------
export interface Score { name: string; rounds: number; answeredPct: number | null; p50: number | null; p95: number | null }
export interface Scorecard { from: string | null; to: string | null; rounds: number; services: Score[]; families: Score[] }

export function scorecard(frames: Frame[], familyOf: (n: string) => string): Scorecard {
  const per = new Map<string, { n: number; ok: number; ms: number[] }>()
  for (const f of frames) for (const [name, v] of f.services) {
    if (NEUTRAL(v.state)) continue
    const s = per.get(name) ?? { n: 0, ok: 0, ms: [] }
    s.n++; if (!BAD(v.state)) { s.ok++; s.ms.push(v.ms) }
    per.set(name, s)
  }
  const score = (name: string, s: { n: number; ok: number; ms: number[] }): Score => ({ name, rounds: s.n, answeredPct: s.n ? Math.round((s.ok / s.n) * 1000) / 10 : null, p50: percentile(s.ms, 50), p95: percentile(s.ms, 95) })
  const services = [...per.entries()].map(([n, s]) => score(n, s)).sort((a, b) => (a.answeredPct ?? 101) - (b.answeredPct ?? 101) || (a.name < b.name ? -1 : 1))
  const fam = new Map<string, { n: number; ok: number; ms: number[] }>()
  for (const [name, s] of per) { const k = familyOf(name) || 'Independent'; const a = fam.get(k) ?? { n: 0, ok: 0, ms: [] }; a.n += s.n; a.ok += s.ok; a.ms.push(...s.ms); fam.set(k, a) }
  const families = [...fam.entries()].map(([n, s]) => score(n, s)).sort((a, b) => (a.answeredPct ?? 101) - (b.answeredPct ?? 101) || (a.name < b.name ? -1 : 1))
  return { from: frames[0]?.t ?? null, to: frames[frames.length - 1]?.t ?? null, rounds: frames.length, services, families }
}

// ---------------------------------------------------------------------------------------------
// I4/I7. Incident statistics: MTTR, chronic offenders, alert noise
// ---------------------------------------------------------------------------------------------
export interface IncidentStats {
  days: number; total: number; open: number
  /** Mean minutes from failing-since to recovery, closed incidents only; null when there is none. */
  mttrMinutes: number | null
  chronic: { name: string; incidents: number; minutes: number }[]
  /** Messages the alert flow sent for these incidents: one "new failure" each, plus reminders, plus one recovery per closed one. */
  alerts: number; reminderPct: number | null; alertsPerWeek: number | null
  hint: string | null
}
export function incidentStats(incidents: IncidentRow[], nowMs: number, days = 30): IncidentStats {
  const since = nowMs - days * 86_400_000
  const rows = incidents.filter((x) => { const t = Date.parse(x.openedAt); return Number.isFinite(t) && t >= since && t <= nowMs + 3_600_000 })
  const closed = rows.filter((x) => !x.open)
  const by = new Map<string, { incidents: number; minutes: number }>()
  for (const x of rows) { const a = by.get(x.name) ?? { incidents: 0, minutes: 0 }; a.incidents++; a.minutes += Math.max(0, x.minutes || 0); by.set(x.name, a) }
  const reminders = rows.reduce((n, x) => n + Math.max(0, x.reminders || 0), 0)
  const alerts = rows.length + reminders + closed.length
  const oldest = rows.reduce((m, x) => Math.min(m, Date.parse(x.openedAt)), nowMs)
  const weeks = Math.max(1, (nowMs - oldest) / (7 * 86_400_000))
  const reminderPct = alerts ? Math.round((reminders / alerts) * 100) : null
  const chronic = [...by.entries()].filter(([, a]) => a.incidents >= 2).map(([name, a]) => ({ name, ...a })).sort((a, b) => b.incidents - a.incidents || b.minutes - a.minutes || (a.name < b.name ? -1 : 1)).slice(0, 5)
  let hint: string | null = null
  if (alerts >= 10 && reminderPct !== null && reminderPct >= 60) hint = `${reminderPct}% of the messages were reminders: a longer alert_reminder_minutes would cut the noise without hiding any new failure.`
  else if (chronic.length && chronic[0].incidents >= 5) hint = `${clean(chronic[0].name, 60)} opened ${chronic[0].incidents} incidents: if it keeps failing briefly, raising alert_confirm by one would turn short blips into no alert.`
  return { days, total: rows.length, open: rows.filter((x) => x.open).length, mttrMinutes: closed.length ? Math.round(closed.reduce((n, x) => n + Math.max(0, x.minutes || 0), 0) / closed.length) : null,
    chronic, alerts, reminderPct, alertsPerWeek: rows.length ? Math.round((alerts / weeks) * 10) / 10 : null, hint }
}

// ---------------------------------------------------------------------------------------------
// I5. Incident narrative / post-incident report
// ---------------------------------------------------------------------------------------------
/** Normalises an error text so equal problems group together: ids, numbers, times and hosts' details are removed. */
export function errorTheme(text: string): string {
  return clean(text, 600)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?/g, '<time>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<id>')
    .replace(/<[^<>]{0,200}>/g, (m) => (m === '<id>' || m === '<time>' ? m : ' '))      // markup from an error page
    .replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 120) || '(no error text)'
}

const utc = (t: string | null) => { const ms = Date.parse(t ?? ''); return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'unknown' }
const dur = (m: number) => (m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`)
/** Text that is safe inside a Markdown table cell / inline code: no backticks, pipes or line breaks. */
const md = (v: unknown, max: number) => clean(v, max).replace(/[`|\\]/g, ' ').replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim()

/** Incidents whose time ranges overlap `seed` (within `slackMinutes`): what happened together. */
export function relatedIncidents(seed: IncidentRow, all: IncidentRow[], nowMs: number, slackMinutes = 15): IncidentRow[] {
  const range = (x: IncidentRow): [number, number] => { const a = Date.parse(x.openedAt); const b = x.open ? nowMs : Date.parse(x.closedAt ?? ''); return [a, Number.isFinite(b) ? b : a] }
  const [s0, s1] = range(seed)
  if (!Number.isFinite(s0)) return [seed]
  const slack = slackMinutes * 60_000
  return all.filter((x) => { const [a, b] = range(x); return Number.isFinite(a) && a <= s1 + slack && b >= s0 - slack }).sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt) || (a.name < b.name ? -1 : 1))
}

/**
 * Post-incident report as Markdown, built only from recorded facts. Deterministic: same input, same text.
 * Everything that came from a probe or a table is stripped of Markdown / HTML control characters.
 */
export function incidentReport(seed: IncidentRow, all: IncidentRow[], nowMs: number, opts: { intervalMinutes: number; headcount?: Record<string, number>; roles?: Record<string, string[]> } = { intervalMinutes: 10 }): string {
  const rows = relatedIncidents(seed, all, nowMs)
  const first = rows[0]
  const openCount = rows.filter((x) => x.open).length
  const ends = rows.filter((x) => !x.open).map((x) => Date.parse(x.closedAt ?? '')).filter(Number.isFinite)
  const end = openCount ? null : Math.max(...ends)
  const start = Date.parse(first.openedAt)
  const total = Number.isFinite(start) ? Math.max(0, Math.round(((end ?? nowMs) - start) / 60_000)) : 0
  const fam = new Map<string, string[]>()
  for (const x of rows) fam.set(x.family || 'Independent', [...(fam.get(x.family || 'Independent') ?? []), x.name])
  const themes = new Map<string, string[]>()
  for (const x of rows) { const t = errorTheme(x.error); themes.set(t, [...(themes.get(t) ?? []), x.name]) }
  const names = new Set(rows.map((x) => x.name))
  const L: string[] = []
  L.push(`# Post-incident report: ${md(first.name, 80)}${rows.length > 1 ? ` and ${rows.length - 1} more service(s)` : ''}`)
  L.push('')
  L.push(`_Generated by Outage Watch from recorded probe facts. No cause is asserted: this is what the probes saw._`)
  L.push('')
  L.push('## Summary')
  L.push(`- Status: **${openCount ? `ONGOING (${openCount} of ${rows.length} still failing)` : 'resolved'}**`)
  L.push(`- First failed probe: ${utc(first.openedAt)} (${md(first.name, 80)})`)
  L.push(`- ${openCount ? 'Duration so far' : 'Duration'}: ${dur(total)}${end ? `, last recovery ${utc(new Date(end).toISOString())}` : ''}`)
  L.push(`- Scope: ${rows.length} service(s) in ${fam.size} famil${fam.size === 1 ? 'y' : 'ies'}: ${[...fam.entries()].map(([f, n]) => `${md(f, 60)} (${n.length})`).join(', ')}`)
  if (names.has('auth')) L.push('- Sign-in (auth) was among the failing services: services that need sign-in were probably affected for signed-in users even where their own probe answered.')
  if (opts.headcount && opts.roles) {
    const hit = Object.entries(opts.roles).filter(([role, svc]) => opts.headcount![role] && svc.some((s) => names.has(s)))
    if (hit.length) L.push(`- People who rely on the affected tasks (admin-supplied figures, not measured): ${hit.map(([r]) => `${md(r, 60)} about ${opts.headcount![r]}`).join('; ')}`)
  }
  L.push('')
  L.push('## Timeline (UTC)')
  const ev: [number, string][] = []
  for (const x of rows) {
    const a = Date.parse(x.openedAt)
    if (Number.isFinite(a)) ev.push([a, `${utc(x.openedAt)} - ${md(x.name, 80)} first failed probe (${md(x.error, 160) || 'no error text'})`])
    if (x.reminders > 0) ev.push([a + 1, `  ... ${x.reminders} reminder(s) sent while ${md(x.name, 80)} kept failing (${x.rounds} failed rounds)`])
    const b = Date.parse(x.closedAt ?? '')
    if (!x.open && Number.isFinite(b)) ev.push([b, `${utc(x.closedAt)} - ${md(x.name, 80)} answered again after ${dur(Math.max(0, x.minutes))}`])
  }
  for (const [, t] of ev.sort((p, q) => p[0] - q[0] || (p[1] < q[1] ? -1 : 1)).slice(0, 80)) L.push(`- ${t}`)
  L.push('')
  L.push('## Services')
  L.push('| Service | Family | Failing since | Recovered | Duration | Failed rounds |')
  L.push('|---|---|---|---|---|---|')
  for (const x of rows.slice(0, 60)) L.push(`| ${md(x.name, 80)} | ${md(x.family, 60)} | ${utc(x.openedAt)} | ${x.open ? 'still failing' : utc(x.closedAt)} | ${dur(Math.max(0, x.minutes))} | ${x.rounds} |`)
  L.push('')
  L.push('## Error themes (ids, numbers and times removed so equal errors group)')
  for (const [t, n] of [...themes.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1)).slice(0, 10)) L.push(`- \`${md(t, 120)}\` - ${n.length} service(s): ${n.slice(0, 8).map((x) => md(x, 60)).join(', ')}`)
  L.push('')
  L.push('## What these facts can and cannot say')
  L.push(`- The probes are anonymous HTTP requests made every ${opts.intervalMinutes} minutes by a Power Automate flow in Microsoft’s cloud. Times are accurate to one probe interval.`)
  L.push('- They show that an endpoint did not answer normally. They cannot show the root cause, how many of your users were affected, or problems that only exist after sign-in or for one tenant.')
  L.push('- The monitor shares fate with Power Platform: gaps in the record during a Power Platform outage mean "not measured", not "healthy".')
  L.push('- Compare with Microsoft’s final post-incident review before drawing conclusions.')
  return L.join('\n') + '\n'
}

/** Short paragraph for a staff update, from the same facts. */
export function staffUpdate(seed: IncidentRow, all: IncidentRow[], nowMs: number): string {
  const rows = relatedIncidents(seed, all, nowMs)
  const open = rows.filter((x) => x.open)
  const list = (a: IncidentRow[]) => a.slice(0, 6).map((x) => clean(x.name, 60)).join(', ') + (a.length > 6 ? ` and ${a.length - 6} more` : '')
  if (open.length) return `We are seeing problems with ${list(open)} since ${utc(rows[0].openedAt)}. Our monitoring shows these services are not answering normally. We do not yet know the cause. We will update when they answer again.`
  const mins = Math.max(...rows.map((x) => x.minutes || 0))
  return `The problems with ${list(rows)} that started ${utc(rows[0].openedAt)} are over: the services have answered normally again for at least one check. Longest interruption: ${dur(Math.max(0, mins))}. The cause is not known to us yet.`
}

// ---------------------------------------------------------------------------------------------
// I6. Impact estimate from ADMIN-SUPPLIED headcounts (never invented)
// ---------------------------------------------------------------------------------------------
/** Setting impact_headcount: "Email & calendar=240; Meetings=300". Anything unreadable is ignored. */
export function parseHeadcount(text: string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const part of String(text ?? '').slice(0, 400).split(';')) {
    const i = part.lastIndexOf('=')
    if (i <= 0) continue
    const name = part.slice(0, i).trim(); const num = part.slice(i + 1).trim()
    if (!name || name.length > 80 || !/^[0-9]{1,8}$/.test(num) || Number(num) < 1 || Object.keys(out).length >= 30) continue
    out[name] = Number(num)
  }
  return out
}
