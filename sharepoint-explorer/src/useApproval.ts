import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { autoReason, settling, escalate as escalateReq, needsEscalation, canDecide, canSubmitNow, delegate as delegateReq, cancel as cancelReq, decide as decideReq, submit as submitReq, type Me } from './approval'
import { backgroundAllowed } from './guard'
import { validApproval, clearApprovals, putApproval, setApprovals } from './approvalStore'
import type { Engine } from './engine'
import { emptyQuery } from './query'
import type { Access, Approver, ApprovalFlow, ApprovalReq, Row } from './types'

export interface ApprovalApi {
  flow: ApprovalFlow | null
  active: boolean
  reqs: ApprovalReq[]
  loading: boolean
  me: Me
  engine: Engine
  groups: string[]
  mayDesign: boolean
  maySubmit: boolean
  waitingForMe: ApprovalReq[]
  reload(): Promise<void>
  /** look for new / changed items that need an automatic approval; returns how many were submitted */
  sweep(): Promise<number>
  saveFlow(f: ApprovalFlow): Promise<void>
  submit(rows: Row[], comment: string): Promise<number>
  decide(r: ApprovalReq, d: 'approve' | 'reject' | 'changes', comment: string): Promise<ApprovalReq>
  cancel(r: ApprovalReq, comment: string): Promise<ApprovalReq>
  delegate(r: ApprovalReq, to: Approver, comment: string): Promise<ApprovalReq>
}

const nameOf = (r: Row) => String(r.FileLeafRef ?? r.Title ?? `#${r.__id}`)

export function useApproval(engine: Engine | null, me: Me, access: Access, mayDesign: boolean, linkOf: (r: Row) => string, ver = 0): ApprovalApi {
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
      const l = f?.enabled ? (await backend.listApprovals(id)).filter(validApproval) : []
      setReqs(l); setApprovals(id, l)
    } catch { /* approvals are optional: a settings-list problem must never break the data view */ } finally { setLoading(false) }
  }, [backend, id])
  useEffect(() => { setFlow(null); setReqs([]); clearApprovals(); void reload(); return () => clearApprovals() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const active = !!flow?.enabled && flow.steps.length > 0
  const maySubmit = active && (flow!.submitters === 'everyone' || (flow!.submitters === 'editors' && access.canEdit) || mayDesign || access.role === 'admin')
  const waitingForMe = useMemo(() => reqs.filter((r) => canDecide(r, me, access.groups, flow)), [reqs, me, access.groups, flow])

  /** write a request; refused when someone else changed it since `base` was read (two people acting at the same moment) */
  const persist = useCallback(async (r: ApprovalReq, base?: ApprovalReq | null) => {
    if (base !== undefined) { const now = await backend!.loadApproval(id!, r.itemId); if ((now?.rev ?? 0) !== (base?.rev ?? 0)) throw new Error('This request was just changed by someone else — refreshed; please check and try again.') }
    const w = { ...r, rev: (r.rev ?? 0) + 1 }
    await backend!.saveApproval(id!, w); putApproval(id!, w); setReqs((l) => [...l.filter((x) => x.itemId !== w.itemId), w])
    return w
  }, [backend, id])
  const latest = async (itemId: number) => (await backend!.loadApproval(id!, itemId)) ?? undefined

  /* ---- automatic approvals: runs for whoever has the app open (new / changed items in-app or in SharePoint) ---- */
  const reqsRef = useRef(reqs); reqsRef.current = reqs
  const lastRun = useRef(0)
  const busy = useRef(false), denied = useRef(false), handled = useRef(new Set<string>()), lastSweep = useRef('')
  const sweep = useCallback(async (): Promise<number> => {
    const a = flow?.auto
    if (!engine || !backend || !id || !flow?.enabled || !a || !a.on.length || busy.current || denied.current || !backgroundAllowed()) return 0
    busy.current = true
    let n = 0
    try {
      const need = new Set<string>([...engine.select, 'Created', 'Modified', 'Author', 'Editor', ...a.criteria.map((c) => c.field), ...a.watch, ...flow.steps.flatMap((s) => (s.when ?? []).map((c) => c.field))])
      const select = [...need].filter((f) => engine.fields.some((x) => x.internal === f))
      const since = lastSweep.current || a.since
      const newest = await backend.query(engine.src, engine.fields, select, { ...emptyQuery(), folders: false, sort: { field: 'ID', dir: 'desc' } }, 100, undefined)
      const maxId = Math.max(0, ...newest.rows.map((r) => r.__id))
      const ch = await backend.changes(engine.src, engine.fields, select, maxId, new Date(Math.max(Date.parse(a.since), Date.parse(since) - 120_000)).toISOString()).catch(() => ({ added: [] as Row[], changed: [] as Row[] }))
      const seen = new Map<number, Row>(); for (const r of [...newest.rows, ...ch.added, ...ch.changed]) seen.set(r.__id, { ...seen.get(r.__id), ...r })
      lastSweep.current = new Date().toISOString()
      for (const r of reqsRef.current.filter(needsEscalation)) { const fresh = await latest(r.itemId); if (fresh && needsEscalation(fresh)) await persist(escalateReq(fresh), fresh) }
      for (const row of seen.values()) {
        const key = `${row.__id}:${row.Modified}`
        if (handled.current.has(key) || settling(row)) continue
        if (!autoReason(flow, row, engine.fields, reqsRef.current.find((x) => x.itemId === row.__id))) { handled.current.add(key); continue }
        await new Promise((r) => setTimeout(r, Math.random() * 1200))           // two open apps rarely act at the very same moment
        const fresh = await latest(row.__id)
        const why = autoReason(flow, row, engine.fields, fresh); handled.current.add(key)
        if (handled.current.size > 5000) handled.current = new Set([...handled.current].slice(-2500))
        if (!why) continue
        await persist(submitReq(flow, { id: row.__id, title: nameOf(row), link: linkOf(row), row, fields: engine.fields, by: { name: String(row.Editor || row.Author || me.name), upn: '' }, auto: why }, me, '', fresh), fresh ?? null); n++
        if (n >= 25) break                                                       // a mass edit never floods: the rest follows on the next sweeps
      }
    } catch (e) { if (/40[13]|denied|access/i.test((e as Error).message)) denied.current = true } finally { busy.current = false }
    return n
  }, [flow, engine, backend, id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { handled.current.clear(); lastSweep.current = ''; denied.current = false }, [id, flow?.updated])
  // an early sweep only when the live pulse actually saw a change, and never more than once per 45 s
  useEffect(() => { if (!active || !flow?.auto || !engine || (engine.pendingNew === 0 && !engine.pulse.length)) return; const wait = Math.max(1800, 45_000 - (Date.now() - lastRun.current)); const t = setTimeout(() => { lastRun.current = Date.now(); void sweep() }, wait); return () => clearTimeout(t) }, [engine?.pulse.length, active, flow?.updated])   // never more often than every 15 s, however busy the live pulse is // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!active || !flow?.auto) return; const t = setInterval(() => { if (!document.hidden) void sweep() }, 45_000); return () => clearInterval(t) }, [sweep, active, flow?.auto])

  return {
    flow, active, reqs, loading, me, engine: engine!, groups: access.groups, mayDesign, maySubmit, waitingForMe, reload, sweep,
    async saveFlow(f) { await backend!.saveApprovalFlow(id!, f); setFlow(f); if (f.enabled) await reload(); else { setReqs([]); setApprovals(id!, []) } },
    async submit(rows, comment) {
      let n = 0
      for (const row of rows) {
        const prev = await latest(row.__id)
        if (!canSubmitNow(prev)) continue
        const r = submitReq(flow!, { id: row.__id, title: nameOf(row), link: linkOf(row), row, fields: engine!.fields }, me, comment, prev)
        await persist(r, prev ?? null); n++
      }
      return n
    },
    async decide(r, d, comment) {
      const cur = (await latest(r.itemId)) ?? r
      if (!canDecide(cur, me, access.groups, flow)) throw new Error('This request has already moved on — refresh to see its current state.')
      return persist(decideReq(cur, me, d, comment), cur)
    },
    async delegate(r, to, comment) {
      const cur = (await latest(r.itemId)) ?? r
      if (!canDecide(cur, me, access.groups, flow)) throw new Error('This request has already moved on — refresh to see its current state.')
      return persist(delegateReq(cur, me, access.groups, to, comment), cur)
    },
    async cancel(r, comment) { const cur = (await latest(r.itemId)) ?? r; return persist(cancelReq(cur, me, comment), cur) },
  }
}
