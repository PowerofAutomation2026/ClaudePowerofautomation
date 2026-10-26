import { useSyncExternalStore } from 'react'
import type { ApprovalReq } from './types'

/** Tiny shared store so the grid, cards and details panel can show an approval badge without re-rendering the whole app. */
let src = ''
let map = new Map<number, ApprovalReq>()
let ver = 0
const subs = new Set<() => void>()
const emit = () => { ver++; subs.forEach((f) => f()) }

/** records come from a shared list and may be damaged or from another version: anything that does not look right is ignored instead of crashing a render */
export const validApproval = (r: unknown): r is ApprovalReq => { const x = r as ApprovalReq; return !!x && typeof x.itemId === 'number' && Array.isArray(x.steps) && x.steps.length > 0 && Array.isArray(x.decisions) && Array.isArray(x.history) && !!x.by && typeof x.step === 'number' }
export const setApprovals = (sourceId: string, list: ApprovalReq[]) => { src = sourceId; map = new Map(list.filter(validApproval).map((r) => [r.itemId, r])); emit() }
export const putApproval = (sourceId: string, r: ApprovalReq) => { if (sourceId !== src || !validApproval(r)) return; map = new Map(map).set(r.itemId, r); emit() }
export const clearApprovals = () => { src = ''; map = new Map(); emit() }
export const approvalFor = (id: number) => map.get(id)
export function useApprovalOf(id: number): ApprovalReq | undefined {
  useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb) } }, () => ver, () => ver)
  return map.get(id)
}
export function useApprovalList(): ApprovalReq[] {
  useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb) } }, () => ver, () => ver)
  return [...map.values()]
}
