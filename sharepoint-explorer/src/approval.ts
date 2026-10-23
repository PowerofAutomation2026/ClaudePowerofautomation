/** Multi-layer approval rules. Pure functions: every decision returns a NEW request, nothing here touches SharePoint. */
import { clauseMatches } from './query'
import type { ApprovalDecision, ApprovalFlow, ApprovalReq, ApprovalStep, Approver, Clause, Row, SpField } from './types'

export interface Me { name: string; upn: string }
const low = (s?: string) => (s ?? '').toLowerCase()
export const STATUS_LABEL: Record<ApprovalReq['status'], string> = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', changes: 'Changes requested', cancelled: 'Cancelled' }

export function isApprover(a: Approver, me: Me, groups: string[]): boolean {
  if (a.kind === 'group') return groups.some((g) => low(g) === low(a.name))
  const u = low(me.upn)
  return !!u && (low(a.email) === u || low(a.login).endsWith(`|${u}`) || low(a.login) === u)
}
const stepNow = (r: ApprovalReq) => r.steps[r.step]
const inRound = (r: ApprovalReq, step: number) => r.decisions.filter((d) => d.step === step && d.round === r.round)

export function stepSatisfied(r: ApprovalReq, step = r.step): boolean {
  const st = r.steps[step]; if (!st) return true
  const ok = new Set(inRound(r, step).filter((d) => d.decision === 'approve').map((d) => low(d.upn)))
  return st.mode === 'all' ? ok.size >= st.approvers.length : ok.size >= 1
}
export function canDecide(r: ApprovalReq, me: Me, groups: string[], flow: ApprovalFlow | null): boolean {
  if (r.status !== 'pending') return false
  if (!(flow?.allowSelfApprove ?? false) && (r.by.upn ? low(r.by.upn) === low(me.upn) : low(r.by.name) === low(me.name))) return false
  if (inRound(r, r.step).some((d) => low(d.upn) === low(me.upn))) return false
  return !!stepNow(r)?.approvers.some((a) => isApprover(a, me, groups))
}
export const dueFrom = (st: ApprovalStep | undefined, from = Date.now()) => (st?.dueDays ? new Date(from + st.dueDays * 86_400_000).toISOString() : undefined)
export const isOverdue = (r: ApprovalReq) => r.status === 'pending' && !!r.dueAt && Date.parse(r.dueAt) < Date.now()
export const canSubmitNow = (existing: ApprovalReq | undefined) => !existing || existing.status !== 'pending'

export const matches = (cs: Clause[] | undefined, row: Row, fields: SpField[], mode: 'all' | 'any' = 'all') => {
  const list = (cs ?? []).filter((c) => fields.some((f) => f.internal === c.field))
  if (!list.length) return true
  const test = (c: Clause) => clauseMatches(c, row, fields.find((f) => f.internal === c.field)!)
  return mode === 'any' ? list.some(test) : list.every(test)
}
/** layers that apply to this particular item (conditional layers are skipped when their condition is not met) */
export const applicableSteps = (flow: ApprovalFlow, row: Row, fields: SpField[]) => flow.steps.filter((s) => matches(s.when, row, fields))
export const snapOf = (watch: string[] | undefined, row: Record<string, unknown>) => (watch?.length ? JSON.stringify(watch.map((w) => row[w] ?? null)) : undefined)
export const lastEventAt = (r: ApprovalReq) => r.history[r.history.length - 1]?.at ?? r.at

export function submit(flow: ApprovalFlow, item: { id: number; title: string; link: string; row?: Row; fields?: SpField[]; by?: Me; auto?: 'created' | 'modified' }, me: Me, comment: string, prev?: ApprovalReq): ApprovalReq {
  const now = new Date().toISOString(), round = (prev?.round ?? 0) + 1
  const steps = item.row && item.fields ? applicableSteps(flow, item.row, item.fields) : flow.steps
  const by = prev?.auto && prev.status === 'pending' && item.auto ? prev.by : item.by ?? me
  const base = {
    v: 1 as const, itemId: item.id, title: item.title, link: item.link, flowName: flow.name, steps: steps.length ? steps : flow.steps, step: 0, round,
    by: { name: by.name, upn: by.upn }, at: now, auto: item.auto, itemModified: item.row ? String(item.row.Modified ?? '') : undefined, snap: snapOf(flow.auto?.watch, item.row ?? {}),
    decisions: prev?.decisions ?? [],
  }
  const ev = { at: now, by: item.auto ? `${by.name} (automatic)` : by.name, upn: by.upn, action: (round > 1 ? 'resubmit' : 'submit') as 'submit' | 'resubmit', step: 0, comment: (comment || (item.auto ? `Started automatically: item ${item.auto}` : '')) || undefined }
  if (!steps.length) return { ...base, status: 'approved', history: [...(prev?.history ?? []), ev, { at: now, by: 'Workflow', upn: '', action: 'advance', comment: 'No approval layer applies to this item — approved automatically.' }] }
  return { ...base, status: 'pending', dueAt: dueFrom(steps[0]), history: [...(prev?.history ?? []), { ...ev, stepName: steps[0].name }] }
}

/** Should this row be (re)submitted automatically? Returns why, or null. Pure: the caller does the writing. */
export const settling = (row: Row) => Date.now() - Date.parse(String(row.Modified ?? '')) < 90_000
export function autoReason(flow: ApprovalFlow, row: Row, fields: SpField[], prev?: ApprovalReq): 'created' | 'modified' | null {
  const a = flow.auto; if (!flow.enabled || !a || !a.on.length || a.paused || row.FSObjType === 1) return null
  if (!matches(a.criteria, row, fields, a.match)) return null
  const since = Date.parse(a.since), created = Date.parse(String(row.Created ?? '')), modified = Date.parse(String(row.Modified ?? ''))
  if (isNaN(modified) || modified < since) return null
  if (settling(row)) return null                                                // still being saved / checked in: the next sweep picks it up
  if (!prev) {
    if (a.on.includes('created') && created >= since) return 'created'
    if (a.on.includes('modified') && created < since) return 'modified'
    return null
  }
  if (prev.itemModified === String(row.Modified ?? '')) return null            // already handled this exact change
  if (!a.on.includes('modified')) return null
  if (prev.status === 'pending' && !a.restartPending) return null
  if (prev.status === 'pending' && prev.steps[prev.step]?.approvers.some((x) => low(x.name) === low(String(row.Editor ?? '')))) return null   // an approver's own fix must not restart their review
  if (a.watch.length && prev.snap === snapOf(a.watch, row)) return null         // none of the watched columns changed
  return 'modified'
}

export function decide(r: ApprovalReq, me: Me, decision: ApprovalDecision['decision'], comment: string): ApprovalReq {
  const now = new Date().toISOString(), st = stepNow(r)
  const d: ApprovalDecision = { step: r.step, round: r.round, upn: me.upn, name: me.name, decision, at: now, comment: comment || undefined }
  const next: ApprovalReq = { ...r, decisions: [...r.decisions, d], history: [...r.history, { at: now, by: me.name, upn: me.upn, action: decision, step: r.step, stepName: st?.name, comment: comment || undefined }] }
  if (decision === 'reject') return { ...next, status: 'rejected', dueAt: undefined }
  if (decision === 'changes') return { ...next, status: 'changes', dueAt: undefined }
  if (!stepSatisfied(next)) return next
  if (r.step >= r.steps.length - 1) return { ...next, status: 'approved', dueAt: undefined }
  const step = r.step + 1
  return { ...next, step, dueAt: dueFrom(r.steps[step]), history: [...next.history, { at: now, by: 'Workflow', upn: '', action: 'advance', step, stepName: r.steps[step]?.name }] }
}
export function cancel(r: ApprovalReq, me: Me, comment: string): ApprovalReq {
  const now = new Date().toISOString()
  return { ...r, status: 'cancelled', dueAt: undefined, history: [...r.history, { at: now, by: me.name, upn: me.upn, action: 'cancel', comment: comment || undefined }] }
}
export const waitingOn = (r: ApprovalReq) => (r.status === 'pending' ? stepNow(r)?.approvers.map((a) => a.name).join(', ') : '')

export function validateFlow(f: ApprovalFlow): string | null {
  if (!f.name.trim()) return 'Give the workflow a name.'
  if (!f.steps.length) return 'Add at least one approval step.'
  for (const [i, s] of f.steps.entries()) if (!s.approvers.length) return `Step ${i + 1} (“${s.name || 'unnamed'}”) needs at least one approver.`
  return null
}

/** Hand my part of the current step to someone else (out of office, wrong person…). */
export function delegate(r: ApprovalReq, me: Me, groups: string[], to: Approver, comment: string): ApprovalReq {
  const now = new Date().toISOString()
  const steps = r.steps.map((st, i) => {
    if (i !== r.step) return st
    const kept = st.approvers.filter((a) => !(a.kind === 'user' && isApprover(a, me, groups)))
    return { ...st, approvers: kept.some((a) => a.login === to.login) ? kept : [...kept, to] }
  })
  return { ...r, steps, history: [...r.history, { at: now, by: me.name, upn: me.upn, action: 'delegate', step: r.step, stepName: r.steps[r.step]?.name, comment: `Delegated to ${to.name}${comment ? ` — ${comment}` : ''}` }] }
}

export function auditCsv(reqs: ApprovalReq[]): string {
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const head = ['Item', 'Workflow', 'Round', 'Status now', 'When', 'Who', 'Action', 'Step', 'Comment', 'Link']
  const lines = reqs.flatMap((r) => r.history.map((h) => [r.title, r.flowName, r.round, r.status, h.at, h.by, h.action, h.stepName ?? '', h.comment ?? '', r.link]))
  return '\ufeff' + [head, ...lines].map((l) => l.map(q).join(',')).join('\r\n')
}

export const needsEscalation = (r: ApprovalReq) => r.status === 'pending' && isOverdue(r) && !!r.steps[r.step]?.escalateTo?.length && !r.history.some((h) => h.action === 'escalate' && h.step === r.step && (h.comment ?? '').endsWith(`#${r.round}`))
export function escalate(r: ApprovalReq): ApprovalReq {
  const st = r.steps[r.step], to = st.escalateTo ?? [], now = new Date().toISOString()
  const steps = r.steps.map((x, i) => (i === r.step ? { ...x, approvers: [...x.approvers, ...to.filter((t) => !x.approvers.some((a) => a.login === t.login))] } : x))
  return { ...r, steps, history: [...r.history, { at: now, by: 'Workflow', upn: '', action: 'escalate', step: r.step, stepName: st.name, comment: `Overdue — escalated to ${to.map((t) => t.name).join(', ')} #${r.round}` }] }
}
export function stats(reqs: ApprovalReq[]) {
  const done = reqs.filter((r) => r.status === 'approved')
  const days = done.map((r) => (Date.parse(r.history[r.history.length - 1]?.at ?? r.at) - Date.parse(r.at)) / 86_400_000)
  return { pending: reqs.filter((r) => r.status === 'pending').length, overdue: reqs.filter(isOverdue).length, approved: done.length, rejected: reqs.filter((r) => r.status === 'rejected').length, changes: reqs.filter((r) => r.status === 'changes').length, avgDays: days.length ? days.reduce((a, b) => a + b, 0) / days.length : 0 }
}
