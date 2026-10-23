import { useSyncExternalStore } from 'react'
import type { ApprovalReq } from './types'

/** Tiny shared store so the grid, cards and details panel can show an approval badge without re-rendering the whole app. */
let src = ''
let map = new Map<number, ApprovalReq>()
let ver = 0
const subs = new Set<() => void>()
const emit = () => { ver++; subs.forEach((f) => f()) }

export const setApprovals = (sourceId: string, list: ApprovalReq[]) => { src = sourceId; map = new Map(list.map((r) => [r.itemId, r])); emit() }
export const putApproval = (sourceId: string, r: ApprovalReq) => { if (sourceId !== src) return; map = new Map(map).set(r.itemId, r); emit() }
export const clearApprovals = () => { src = ''; map = new Map(); emit() }
export const approvalFor = (id: number) => map.get(id)
export function useApprovalOf(id: number): ApprovalReq | undefined {
  useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb) } }, () => ver, () => ver)
  return map.get(id)
}
