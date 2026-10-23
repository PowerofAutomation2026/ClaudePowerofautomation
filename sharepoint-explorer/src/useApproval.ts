import { useCallback, useEffect, useMemo, useState } from 'react'
import { canDecide, canSubmitNow, cancel as cancelReq, decide as decideReq, submit as submitReq, type Me } from './approval'
import { clearApprovals, putApproval, setApprovals } from './approvalStore'
import type { Engine } from './engine'
import type { Access, ApprovalFlow, ApprovalReq, Row } from './types'

export interface ApprovalApi {
  flow: ApprovalFlow | null
  active: boolean
  reqs: ApprovalReq[]
  loading: boolean
  me: Me
  groups: string[]
  mayDesign: boolean
  maySubmit: boolean
  waitingForMe: ApprovalReq[]
  reload(): Promise<void>
  saveFlow(f: ApprovalFlow): Promise<void>
  submit(rows: Row[], comment: string): Promise<number>
  decide(r: ApprovalReq, d: 'approve' | 'reject' | 'changes', comment: string): Promise<ApprovalReq>
  cancel(r: ApprovalReq, comment: string): Promise<ApprovalReq>
}

const nameOf = (r: Row) => String(r.FileLeafRef ?? r.Title ?? `#${r.__id}`)

export function useApproval(engine: Engine | null, me: Me, access: Access, mayDesign: boolean, linkOf: (r: Row) => string): ApprovalApi {
  const id = engine?.src.id
  const [flow, setFlow] = useState<ApprovalFlow | null>(null)
  const [reqs, setReqs] = useState<ApprovalReq[]>([])
  const [loading, setLoading] = useState(false)
  const backend = engine?.backend

  const reload = useCallback(async () => {
    if (!backend || !id) return
    setLoading(true)
    try {
      const f = await backend.loadApprovalFlow(id); setFlow(f)
      const l = f?.enabled ? await backend.listApprovals(id) : []
      setReqs(l); setApprovals(id, l)
    } catch { /* approvals are optional: a settings-list problem must never break the data view */ } finally { setLoading(false) }
  }, [backend, id])
  useEffect(() => { setFlow(null); setReqs([]); clearApprovals(); void reload(); return () => clearApprovals() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const active = !!flow?.enabled && flow.steps.length > 0
  const maySubmit = active && (flow!.submitters === 'everyone' || (flow!.submitters === 'editors' && access.canEdit) || mayDesign || access.role === 'admin')
  const waitingForMe = useMemo(() => reqs.filter((r) => canDecide(r, me, access.groups, flow)), [reqs, me, access.groups, flow])

  const persist = useCallback(async (r: ApprovalReq) => { await backend!.saveApproval(id!, r); putApproval(id!, r); setReqs((l) => [...l.filter((x) => x.itemId !== r.itemId), r]) }, [backend, id])
  const latest = async (itemId: number) => (await backend!.listApprovals(id!)).find((x) => x.itemId === itemId)

  return {
    flow, active, reqs, loading, me, groups: access.groups, mayDesign, maySubmit, waitingForMe, reload,
    async saveFlow(f) { await backend!.saveApprovalFlow(id!, f); setFlow(f); if (f.enabled) await reload(); else { setReqs([]); setApprovals(id!, []) } },
    async submit(rows, comment) {
      let n = 0
      for (const row of rows) {
        const prev = await latest(row.__id)
        if (!canSubmitNow(prev)) continue
        const r = submitReq(flow!, { id: row.__id, title: nameOf(row), link: linkOf(row) }, me, comment, prev)
        await persist(r); n++
      }
      return n
    },
    async decide(r, d, comment) {
      const cur = (await latest(r.itemId)) ?? r
      if (!canDecide(cur, me, access.groups, flow)) throw new Error('This request has already moved on — refresh to see its current state.')
      const next = decideReq(cur, me, d, comment); await persist(next)
      return next
    },
    async cancel(r, comment) { const next = cancelReq((await latest(r.itemId)) ?? r, me, comment); await persist(next); return next },
  }
}
