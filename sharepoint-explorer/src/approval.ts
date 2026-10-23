/** Multi-layer approval rules. Pure functions: every decision returns a NEW request, nothing here touches SharePoint. */
import type { ApprovalDecision, ApprovalFlow, ApprovalReq, ApprovalStep, Approver } from './types'

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
  if (!(flow?.allowSelfApprove ?? false) && low(r.by.upn) === low(me.upn)) return false
  if (inRound(r, r.step).some((d) => low(d.upn) === low(me.upn))) return false
  return !!stepNow(r)?.approvers.some((a) => isApprover(a, me, groups))
}
export const dueFrom = (st: ApprovalStep | undefined, from = Date.now()) => (st?.dueDays ? new Date(from + st.dueDays * 86_400_000).toISOString() : undefined)
export const isOverdue = (r: ApprovalReq) => r.status === 'pending' && !!r.dueAt && Date.parse(r.dueAt) < Date.now()
export const canSubmitNow = (existing: ApprovalReq | undefined) => !existing || existing.status !== 'pending'

export function submit(flow: ApprovalFlow, item: { id: number; title: string; link: string }, me: Me, comment: string, prev?: ApprovalReq): ApprovalReq {
  const now = new Date().toISOString(), round = (prev?.round ?? 0) + 1
  return {
    v: 1, itemId: item.id, title: item.title, link: item.link, flowName: flow.name, steps: flow.steps, step: 0, status: 'pending', round,
    by: { name: me.name, upn: me.upn }, at: now, dueAt: dueFrom(flow.steps[0]),
    decisions: prev?.decisions ?? [],
    history: [...(prev?.history ?? []), { at: now, by: me.name, upn: me.upn, action: round > 1 ? 'resubmit' : 'submit', step: 0, stepName: flow.steps[0]?.name, comment: comment || undefined }],
  }
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
