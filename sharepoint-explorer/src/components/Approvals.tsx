import { useEffect, useRef, useState } from 'react'
import { auditCsv, canDecide, isOverdue, STATUS_LABEL, validateFlow, waitingOn } from '../approval'
import { useApprovalOf } from '../approvalStore'
import type { Engine } from '../engine'
import { opsFor } from '../query'
import type { ApprovalAuto, ApprovalFlow, ApprovalReq, ApprovalStep, Approver, Clause, Op, Principal, SpField } from '../types'
import type { ApprovalApi } from '../useApproval'
import { download, fmtDate, relTime, uid } from '../util'
import { copyMessage, openOutlookWeb } from '../mail'
import { Icon, Modal, useToast } from './ui'

const PILL: Record<ApprovalReq['status'], string> = { pending: 'warn', approved: 'good', rejected: 'bad', changes: 'accent', cancelled: '' }

export function StatusPill({ r }: { r: ApprovalReq }) {
  const late = isOverdue(r)
  return <span className={`pill ${late ? 'bad' : PILL[r.status]}`}>{STATUS_LABEL[r.status]}{r.status === 'pending' ? ` · step ${r.step + 1}/${r.steps.length}` : ''}{late ? ' · overdue' : ''}</span>
}

/** Small status tag shown next to a file / item name in the grid, cards and tiles. */
export function ApprovalBadge({ id }: { id: number }) {
  const r = useApprovalOf(id)
  if (!r || r.status === 'cancelled') return null
  const icon = r.status === 'approved' ? '✔' : r.status === 'rejected' ? '✖' : r.status === 'changes' ? '↩' : '⏳'
  return <span className={`pill apbadge ${isOverdue(r) ? 'bad' : PILL[r.status]}`} title={`Approval: ${STATUS_LABEL[r.status]}${r.status === 'pending' ? ` — waiting on ${waitingOn(r)}` : ''}`}><span aria-hidden="true">{icon}</span> {STATUS_LABEL[r.status]}{r.status === 'pending' ? ` ${r.step + 1}/${r.steps.length}` : ''}</span>
}

/** Steps with state, who is being waited on, and the full history. Also hosts the Approve / Reject / Submit controls. */
export function ApprovalPanel({ api, req, onSubmit, onChanged }: { api: ApprovalApi; req?: ApprovalReq; onSubmit?: (comment: string) => Promise<void>; onChanged?: (r: ApprovalReq) => void }) {
  const toast = useToast()
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [deleg, setDeleg] = useState(false)
  useEffect(() => setComment(''), [req?.itemId, req?.status, req?.step])
  const run = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); try { const r = await fn(); toast('good', ok); if (r && onChanged) onChanged(r as ApprovalReq) } catch (e) { toast('bad', (e as Error).message) } finally { setBusy(false) } }
  const need = api.flow?.requireCommentOnReject
  const mayDecide = !!req && canDecide(req, api.me, api.groups, api.flow)
  const mine = !!req && req.by.upn.toLowerCase() === api.me.upn.toLowerCase()

  if (!api.active) return <p className="muted">No approval workflow is set up for this {'list or library'} yet.{api.mayDesign ? ' Use “Design workflow” on the Approvals screen to create one.' : ' Ask an admin to set one up.'}</p>
  return (
    <div className="aprv">
      {!req || req.status === 'cancelled' ? (
        <div className="card" style={{ padding: 12 }}>
          <b>Not submitted</b>
          <p className="muted small" style={{ margin: '4px 0 8px' }}>{api.flow!.name}: {api.flow!.steps.map((s) => s.name).join(' → ')}</p>
          {api.maySubmit && onSubmit ? <>
            <label className="small">Note for the approvers (optional)<textarea className="input" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} /></label>
            <button className="btn primary" style={{ marginTop: 8 }} disabled={busy} onClick={() => run(() => onSubmit(comment), 'Submitted for approval.')}><Icon n="check" size={15} />Submit for approval</button>
          </> : <p className="muted small">You do not have permission to submit items for approval.</p>}
        </div>
      ) : <>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
          <StatusPill r={req} />
          <span className="muted small">Submitted by {req.by.name} {relTime(req.at)}{req.round > 1 ? ` · round ${req.round}` : ''}</span>
        </div>
        <ol className="asteps" aria-label="Approval steps">
          {req.steps.map((s, i) => {
            const state = req.status === 'approved' || i < req.step ? 'done' : i === req.step ? (req.status === 'pending' ? 'current' : req.status === 'rejected' ? 'rejected' : 'changes') : 'todo'
            const ds = req.decisions.filter((d) => d.step === i && d.round === req.round)
            return (
              <li key={s.id} className={`astep ${state}`} aria-current={state === 'current' ? 'step' : undefined}>
                <span className="dot" aria-hidden="true">{state === 'done' ? '✔' : state === 'rejected' ? '✖' : i + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{s.name}</b> <span className="muted small">{s.mode === 'all' ? 'everyone must approve' : 'any one approver'}{s.dueDays ? ` · ${s.dueDays} day${s.dueDays > 1 ? 's' : ''}` : ''}</span>
                  <div className="small muted">{s.approvers.map((a) => a.name).join(', ')}</div>
                  {ds.map((d, j) => <div key={j} className="small">{d.decision === 'approve' ? '✔' : d.decision === 'reject' ? '✖' : '↩'} {d.name} · {fmtDate(d.at, true)}{d.comment ? ` — “${d.comment}”` : ''}</div>)}
                  {state === 'current' && req.dueAt && <div className={`small ${isOverdue(req) ? '' : 'muted'}`} style={isOverdue(req) ? { color: 'var(--bad)' } : undefined}>Due {fmtDate(req.dueAt, true)}</div>}
                </div>
              </li>
            )
          })}
        </ol>
        {(mayDecide || (req.status === 'pending' && (mine || api.mayDesign)) || ((req.status === 'rejected' || req.status === 'changes') && mine && onSubmit)) && (
          <div className="card" style={{ padding: 12, marginTop: 8 }}>
            <label className="small">Comment{mayDecide && need ? ' (required to reject)' : ' (optional)'}<textarea className="input" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} /></label>
            <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              {mayDecide && <>
                <button className="btn primary" disabled={busy} onClick={() => run(() => api.decide(req, 'approve', comment), 'Approved.')}><Icon n="check" size={15} />Approve</button>
                <button className="btn danger" disabled={busy || (!!need && !comment.trim())} onClick={() => run(() => api.decide(req, 'reject', comment), 'Rejected.')}><Icon n="x" size={15} />Reject</button>
                <button className="btn ghost" disabled={busy} onClick={() => setDeleg(true)}>Delegate…</button>
                <button className="btn" disabled={busy || !comment.trim()} title={!comment.trim() ? 'Say what should change' : undefined} onClick={() => run(() => api.decide(req, 'changes', comment), 'Changes requested.')}>Request changes</button>
              </>}
              {req.status === 'pending' && (mine || api.mayDesign) && <button className="btn ghost" disabled={busy} onClick={() => run(() => api.cancel(req, comment), 'Request cancelled.')}>Cancel request</button>}
              {(req.status === 'rejected' || req.status === 'changes') && mine && onSubmit && <button className="btn primary" disabled={busy} onClick={() => run(() => onSubmit(comment), 'Resubmitted for approval.')}>Resubmit</button>}
            </div>
          </div>
        )}
        {deleg && req && <DelegateDialog engine={api.engine} onPick={(a) => { setDeleg(false); void run(() => api.delegate(req, a, comment), `Delegated to ${a.name}.`) }} onClose={() => setDeleg(false)} />}
        {req.status === 'pending' && !mayDecide && <p className="muted small" style={{ marginTop: 6 }}>Waiting on: {waitingOn(req)}</p>}
        <div className="row" style={{ marginTop: 6 }}>
          <button className="btn sm" onClick={() => {
            const pending = req.status === 'pending'
            const to = pending ? req.steps[req.step].approvers.map((a) => a.email).filter((e): e is string => !!e) : [req.by.upn].filter(Boolean)
            const m = { to, subject: pending ? `Approval needed: ${req.title}` : `${req.title}: ${STATUS_LABEL[req.status]}`, text: pending ? `Please review and approve (${req.flowName}, step ${req.step + 1} of ${req.steps.length}).\n\n${req.title}\n${req.link}` : `Your request “${req.title}” is ${STATUS_LABEL[req.status].toLowerCase()}.\n\n${req.link}` }
            const r = openOutlookWeb(m); if (r !== 'opened') { void copyMessage(m); toast('info', 'Message copied — paste it into a new email.') }
          }}><Icon n="share" size={14} />{req.status === 'pending' ? 'Notify approvers' : 'Notify submitter'}</button>
        </div>
        <div role="heading" aria-level={3} style={{ margin: '14px 0 6px', fontWeight: 700 }}>History</div>
        <ol className="vlist">
          {[...req.history].reverse().map((h, i) => (
            <li key={i}><span className={`pill ${h.action === 'approve' || h.action === 'advance' ? 'good' : h.action === 'reject' ? 'bad' : 'accent'}`}>{ACTION[h.action]}</span>
              <div style={{ flex: 1 }}><b>{h.by}</b>{h.stepName ? <span className="muted small"> · {h.stepName}</span> : null}{h.comment && <div className="small">“{h.comment}”</div>}<div className="muted small">{fmtDate(h.at, true)}</div></div></li>
          ))}
        </ol>
      </>}
    </div>
  )
}
const ACTION = { escalate: 'Escalated', delegate: 'Delegated', submit: 'Submitted', resubmit: 'Resubmitted', approve: 'Approved', reject: 'Rejected', changes: 'Changes requested', advance: 'Next step', cancel: 'Cancelled' } as const

/** Inbox: waiting for me / submitted by me / everything (admins). Select a request to see its steps and act on it. */
export function ApprovalsDialog({ engine, api, onOpen, onClose }: { engine: Engine; api: ApprovalApi; onOpen: (id: number) => void; onClose: () => void }) {
  const [tab, setTab] = useState<'me' | 'mine' | 'all' | 'design'>(api.waitingForMe.length ? 'me' : api.mayDesign && !api.active ? 'design' : 'mine')
  const [sel, setSel] = useState<number | null>(null)
  const [status, setStatus] = useState<'all' | ApprovalReq['status']>('all')
  const mine = api.reqs.filter((r) => r.by.upn.toLowerCase() === api.me.upn.toLowerCase())
  const list = (tab === 'me' ? api.waitingForMe : tab === 'mine' ? mine : api.reqs).filter((r) => status === 'all' || r.status === status).sort((a, b) => b.at.localeCompare(a.at))
  const cur = api.reqs.find((r) => r.itemId === sel)
  const toast = useToast()
  const [ticked, setTicked] = useState<Set<number>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const bulk = async (d: 'approve' | 'reject') => {
    const c = d === 'reject' ? prompt('Reason for rejecting these requests:') : ''
    if (d === 'reject' && !c) return
    setBulkBusy(true); let ok = 0, bad = 0
    for (const r of api.waitingForMe.filter((x) => ticked.has(x.itemId))) { try { await api.decide(r, d, c ?? ''); ok++ } catch { bad++ } }
    setBulkBusy(false); setTicked(new Set()); toast(bad ? 'warn' : 'good', `${ok} ${d === 'approve' ? 'approved' : 'rejected'}${bad ? `, ${bad} could not be processed (already moved on)` : ''}.`)
  }
  const exportAudit = () => { download(new Blob([auditCsv(list)], { type: 'text/csv;charset=utf-8' }), `approvals-${engine.src.label.replace(/[^\w-]+/g, '_')}.csv`); toast('info', 'Audit file prepared. If nothing downloaded, downloads are blocked for this app.') }
  const count = (s: ApprovalReq['status']) => api.reqs.filter((r) => r.status === s).length
  return (
    <Modal title={`Approvals — ${engine.src.label}`} onClose={onClose} className="wide">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <div role="tablist" className="tabs">
          <button role="tab" className="tab" aria-selected={tab === 'me'} onClick={() => setTab('me')}>Waiting for me <span className="pill">{api.waitingForMe.length}</span></button>
          <button role="tab" className="tab" aria-selected={tab === 'mine'} onClick={() => setTab('mine')}>Submitted by me <span className="pill">{mine.length}</span></button>
          {api.mayDesign && <button role="tab" className="tab" aria-selected={tab === 'all'} onClick={() => setTab('all')}>Everything <span className="pill">{api.reqs.length}</span></button>}
          {api.mayDesign && <button role="tab" className="tab" aria-selected={tab === 'design'} onClick={() => setTab('design')}><Icon n="edit" size={14} />Design workflow</button>}
        </div>
        <span className="grow" />
        {tab !== 'design' && <label className="small row" style={{ gap: 6 }}>Status<select className="input" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}><option value="all">All</option>{(['pending', 'approved', 'rejected', 'changes', 'cancelled'] as const).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]} ({count(s)})</option>)}</select></label>}
        {tab !== 'design' && list.length > 0 && <button className="btn sm" onClick={exportAudit}><Icon n="download" size={14} />Export history (CSV)</button>}
        <button className="btn sm" onClick={() => void api.reload()} disabled={api.loading}><Icon n="refresh" size={14} />{api.loading ? 'Loading…' : 'Refresh'}</button>
      </div>
      {tab === 'design' ? <FlowDesigner engine={engine} api={api} onDone={() => setTab('all')} /> : !api.active ? <p className="muted">No approval workflow yet.{api.mayDesign ? ' Open “Design workflow” to create one.' : ' Ask an admin to set one up.'}</p> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) minmax(280px, 1.4fr)', gap: 14 }} className="aprv-split">
          <div>
          {tab === 'me' && list.length > 1 && <div className="row" style={{ gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
            <button className="btn sm" onClick={() => setTicked(new Set(ticked.size === list.length ? [] : list.map((r) => r.itemId)))}>{ticked.size === list.length ? 'Clear' : 'Select all'}</button>
            <button className="btn sm primary" disabled={!ticked.size || bulkBusy} onClick={() => void bulk('approve')}>Approve {ticked.size || ''}</button>
            <button className="btn sm danger" disabled={!ticked.size || bulkBusy} onClick={() => void bulk('reject')}>Reject {ticked.size || ''}</button>
          </div>}
          <ul className="feed" style={{ margin: 0, padding: 0, listStyle: 'none', maxHeight: '60vh', overflow: 'auto' }} aria-label="Requests">
            {list.length === 0 && <li className="muted">Nothing here.</li>}
            {list.map((r) => (
              <li key={r.itemId} className="row" style={{ gap: 4 }}>{tab === 'me' && list.length > 1 && <input type="checkbox" aria-label={`Select ${r.title}`} checked={ticked.has(r.itemId)} onChange={(e) => setTicked((t) => { const n = new Set(t); e.target.checked ? n.add(r.itemId) : n.delete(r.itemId); return n })} />}<button className="btn ghost" style={{ flex: 1, minWidth: 0, textAlign: 'left', display: 'grid', gap: 2, background: sel === r.itemId ? 'var(--bg2)' : undefined }} aria-pressed={sel === r.itemId} onClick={() => setSel(r.itemId)}>
                <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</b><span><StatusPill r={r} /></span><span className="muted small">by {r.by.name} · {relTime(r.at)}</span></button></li>
            ))}
          </ul></div>
          <div>{cur ? <>
            <div className="row" style={{ gap: 8, marginBottom: 8 }}><div role="heading" aria-level={2} style={{ margin: 0, flex: 1, overflowWrap: 'anywhere', fontWeight: 700, fontSize: '1.05rem' }}>{cur.title}</div><button className="btn sm" onClick={() => { onOpen(cur.itemId); onClose() }}>Open item</button><a className="btn sm" href={cur.link} target="_blank" rel="noreferrer noopener"><Icon n="ext" size={14} />SharePoint</a></div>
            <ApprovalPanel api={api} req={cur} onSubmit={async (c) => { const row = engine.rows.find((x) => x.__id === cur.itemId); if (row) await api.submit([row], c); else throw new Error('Open the item in the list first to resubmit it.') }} />
          </> : <p className="muted">Select a request to see its steps, history and actions.</p>}</div>
        </div>
      )}
    </Modal>
  )
}

/** Admin designer: any number of steps, each with its own approvers, "any one" / "everyone" rule and due days. */
export function FlowDesigner({ engine, api, onDone }: { engine: Engine; api: ApprovalApi; onDone: () => void }) {
  const toast = useToast()
  const blank = (): ApprovalFlow => ({ v: 1, enabled: true, name: `${engine.src.label} approval`, steps: [{ id: uid(), name: 'Manager review', approvers: [], mode: 'any' }], requireCommentOnReject: true, allowSelfApprove: false, submitters: 'editors', updated: '', updatedBy: '' })
  const [f, setF] = useState<ApprovalFlow>(() => api.flow ?? blank())
  const [saving, setSaving] = useState(false)
  const fields = engine.fields.filter((x) => (engine.select.includes(x.internal) || ['Created', 'Modified', 'Author', 'Editor'].includes(x.internal)) && ['text', 'choice', 'multichoice', 'number', 'currency', 'date', 'boolean', 'user', 'lookup'].includes(x.kind))
  const setAuto = (p: Partial<ApprovalAuto>) => setF((x) => ({ ...x, auto: { ...x.auto!, ...p } }))
  const setStep = (i: number, p: Partial<ApprovalStep>) => setF((x) => ({ ...x, steps: x.steps.map((s, j) => (j === i ? { ...s, ...p } : s)) }))
  const move = (i: number, d: -1 | 1) => setF((x) => { const a = [...x.steps], j = i + d; if (j < 0 || j >= a.length) return x; [a[i], a[j]] = [a[j], a[i]]; return { ...x, steps: a } })
  const save = async () => {
    const err = validateFlow(f); if (err) return toast('warn', err)
    setSaving(true)
    const now = new Date().toISOString()
    try { await api.saveFlow({ ...f, auto: f.auto && f.auto.on.length ? { ...f.auto, since: api.flow?.auto?.since && api.flow.auto.on.join() === f.auto.on.join() ? api.flow.auto.since : now } : undefined, updated: now, updatedBy: api.me.name }); toast('good', f.enabled ? 'Approval workflow saved and active.' : 'Approval workflow saved (turned off).'); onDone() }
    catch (e) { toast('bad', `Could not save the workflow: ${(e as Error).message}`) } finally { setSaving(false) }
  }
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <label className="small" style={{ flex: 1, minWidth: 200 }}>Workflow name<input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} /></label>
        <label className="small">Who can submit
          <select className="input" value={f.submitters} onChange={(e) => setF({ ...f, submitters: e.target.value as ApprovalFlow['submitters'] })}><option value="editors">People who can edit</option><option value="everyone">Everyone with access</option><option value="admins">Admins only</option></select></label>
      </div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
        {f.steps.map((s, i) => (
          <li key={s.id} className="card" style={{ padding: 12 }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <span className="pill accent">Step {i + 1}</span>
              <input className="input" style={{ flex: 1, minWidth: 160 }} aria-label={`Step ${i + 1} name`} value={s.name} onChange={(e) => setStep(i, { name: e.target.value })} placeholder="e.g. Legal review" maxLength={60} />
              <select className="input" aria-label={`Step ${i + 1} rule`} value={s.mode} onChange={(e) => setStep(i, { mode: e.target.value as ApprovalStep['mode'] })}><option value="any">Any one approver</option><option value="all">Everyone must approve</option></select>
              <label className="small row" style={{ gap: 4 }}>Due in<input className="input" style={{ width: 64 }} type="number" min={0} max={365} value={s.dueDays ?? ''} onChange={(e) => setStep(i, { dueDays: Number(e.target.value) || undefined })} aria-label={`Step ${i + 1} due days`} />days</label>
              <button className="btn sm ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move step ${i + 1} earlier`}><Icon n="up" size={13} /></button>
              <button className="btn sm ghost" onClick={() => move(i, 1)} disabled={i === f.steps.length - 1} aria-label={`Move step ${i + 1} later`}><Icon n="down" size={13} /></button>
              <button className="btn sm ghost" onClick={() => setF({ ...f, steps: f.steps.filter((_, j) => j !== i) })} disabled={f.steps.length === 1} aria-label={`Remove step ${i + 1}`}><Icon n="trash" size={13} /></button>
            </div>
            <ApproverPicker engine={engine} value={s.approvers} onChange={(a) => setStep(i, { approvers: a })} label={`Step ${i + 1} approvers`} />
            <details style={{ marginTop: 8 }} open={!!s.when?.length}>
              <summary className="small">{s.when?.length ? `Only needed when… (${s.when.length} condition${s.when.length > 1 ? 's' : ''})` : 'Make this layer conditional (optional)'}</summary>
              <ClauseEditor fields={fields} value={s.when ?? []} onChange={(w) => setStep(i, { when: w.length ? w : undefined })} label={`Step ${i + 1} condition`} />
              <p className="muted small" style={{ margin: '4px 0 0' }}>Example: “Amount ≥ 10000” makes this layer apply only to large items; otherwise it is skipped.</p>
            </details>
            <details style={{ marginTop: 6 }} open={!!s.escalateTo?.length}>
              <summary className="small">{s.escalateTo?.length ? `If overdue, also ask: ${s.escalateTo.map((a) => a.name).join(', ')}` : 'Escalate when overdue (optional, needs “Due in” days)'}</summary>
              <ApproverPicker engine={engine} value={s.escalateTo ?? []} onChange={(a) => setStep(i, { escalateTo: a.length ? a : undefined })} label={`Step ${i + 1} escalation`} />
            </details>
          </li>
        ))}
      </ol>
      <div><button className="btn sm" onClick={() => setF({ ...f, steps: [...f.steps, { id: uid(), name: `Step ${f.steps.length + 1}`, approvers: [], mode: 'any' }] })}><Icon n="plus" size={14} />Add another approval layer</button></div>
      <fieldset className="card" style={{ padding: 12, display: 'grid', gap: 8 }}>
        <legend className="small muted" style={{ padding: '0 6px' }}>When does approval start?</legend>
        <div role="radiogroup" aria-label="Approval start" className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button type="button" role="radio" aria-checked={!f.auto} className={`btn sm ${!f.auto ? 'primary' : ''}`} onClick={() => setF({ ...f, auto: undefined })}>Manually (people press Submit)</button>
          <button type="button" role="radio" aria-checked={!!f.auto} className={`btn sm ${f.auto ? 'primary' : ''}`} onClick={() => setF({ ...f, auto: f.auto ?? { on: ['created'], match: 'all', criteria: [], watch: [], restartPending: true, since: '' } })}><Icon n="bolt" size={14} />Automatically</button>
        </div>
        {f.auto && <>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
            {(['created', 'modified'] as const).map((k) => <label key={k} className="row small" style={{ gap: 6 }}><input type="checkbox" checked={f.auto!.on.includes(k)} onChange={(e) => setAuto({ on: e.target.checked ? [...f.auto!.on, k] : f.auto!.on.filter((x) => x !== k) })} />{k === 'created' ? `When a new ${engine.src.isLibrary ? 'file is uploaded' : 'item is submitted'}` : `When ${engine.src.isLibrary ? 'a file' : 'an item'} is modified`}</label>)}
          </div>
          <div className="small">Only when <select className="input" aria-label="Match all or any" value={f.auto.match} onChange={(e) => setAuto({ match: e.target.value as 'all' | 'any' })}><option value="all">ALL</option><option value="any">ANY</option></select> of these criteria match (leave empty to include everything):</div>
          <ClauseEditor fields={fields} value={f.auto.criteria} onChange={(criteria) => setAuto({ criteria })} label="Approval criteria" />
          {f.auto.on.includes('modified') && <>
            <details><summary className="small">{f.auto.watch.length ? `Re-approve only when these columns change (${f.auto.watch.length})` : 'Re-approve on any change (or choose the columns to watch)'}</summary>
              <div className="row" style={{ gap: 10, flexWrap: 'wrap', marginTop: 6 }}>{fields.filter((x) => !['Modified', 'Editor', 'ID', 'Created', 'Author'].includes(x.internal)).map((x) => <label key={x.internal} className="row small" style={{ gap: 4 }}><input type="checkbox" checked={f.auto!.watch.includes(x.internal)} onChange={(e) => setAuto({ watch: e.target.checked ? [...f.auto!.watch, x.internal] : f.auto!.watch.filter((w) => w !== x.internal) })} />{x.title}</label>)}</div></details>
            <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={f.auto.restartPending} onChange={(e) => setAuto({ restartPending: e.target.checked })} />If it is changed while still waiting for approval, start the approval again</label>
          </>}
          <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={!!f.auto.paused} onChange={(e) => setAuto({ paused: e.target.checked })} />Pause automatic submissions (keeps everything else running)</label>
          <p className="muted small" style={{ margin: 0 }}>Items created or changed <b>before you save</b> are never submitted, so turning this on does not flood old data. The check runs whenever anyone has this app open (about every 45 seconds and after each save). For guaranteed, always-on triggering even when nobody is in the app, pair it with a Power Automate flow.{api.flow?.auto?.since ? ` Active since ${fmtDate(api.flow.auto.since, true)}.` : ''}</p>
          {api.flow?.auto && <div><button type="button" className="btn sm" onClick={async () => { const n = await api.sweep(); toast(n ? 'good' : 'info', n ? `${n} item${n > 1 ? 's' : ''} submitted automatically.` : 'Nothing new needs approval right now.') }}><Icon n="refresh" size={14} />Check now</button></div>}
        </>}
      </fieldset>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 6 }}>
        <legend className="small muted">Rules</legend>
        <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={f.requireCommentOnReject} onChange={(e) => setF({ ...f, requireCommentOnReject: e.target.checked })} />Approvers must give a comment when rejecting</label>
        <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={f.allowSelfApprove} onChange={(e) => setF({ ...f, allowSelfApprove: e.target.checked })} />Allow the person who submitted to approve their own request</label>
        <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />Workflow is turned on for this {engine.src.isLibrary ? 'library' : 'list'}</label>
      </fieldset>
      <p className="muted small" style={{ margin: 0 }}>Each submitted item keeps a snapshot of the steps, so changing the workflow later never alters requests already in progress. Requests and history are stored in the app’s SPX_Config list and shown in the grid as an approval tag. Use “Notify approvers” on a request to open a prefilled email.</p>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={saving} onClick={() => void save()}><Icon n="check" size={15} />{saving ? 'Saving…' : 'Save workflow'}</button></div>
    </div>
  )
}

function ApproverPicker({ engine, value, onChange, label }: { engine: Engine; value: Approver[]; onChange: (a: Approver[]) => void; label: string }) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<(Principal & { login: string })[]>([])
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return }
    const my = ++seq.current, t = setTimeout(async () => {
      setBusy(true)
      try { const r = await engine.backend.searchPrincipals(engine.src, q.trim()); if (my === seq.current) setHits(r) } catch { if (my === seq.current) setHits([]) } finally { if (my === seq.current) setBusy(false) }
    }, 250)
    return () => clearTimeout(t)
  }, [q]) // eslint-disable-line react-hooks/exhaustive-deps
  const add = (p: Principal & { login: string }) => { if (!value.some((v) => v.login === p.login)) onChange([...value, { kind: p.kind, name: p.title, login: p.login, email: p.email }]); setQ(''); setHits([]) }
  return (
    <div style={{ marginTop: 8 }}>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {value.map((a) => <span key={a.login} className="pill accent">{a.kind === 'group' ? '👥 ' : ''}{a.name}<button className="btn sm ghost" style={{ padding: '0 4px' }} aria-label={`Remove ${a.name}`} onClick={() => onChange(value.filter((v) => v.login !== a.login))}>×</button></span>)}
        {!value.length && <span className="muted small">No approvers yet — search below.</span>}
      </div>
      <input className="input" style={{ marginTop: 6, width: '100%' }} type="search" role="combobox" aria-expanded={hits.length > 0} aria-label={label} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people or SharePoint groups…" />
      {busy && <div className="muted small">Searching…</div>}
      {hits.length > 0 && <ul className="feed" style={{ margin: '4px 0 0', padding: 0, listStyle: 'none', maxHeight: 160, overflow: 'auto' }} role="listbox" aria-label={`${label} results`}>
        {hits.map((h) => <li key={h.login}><button className="btn ghost" style={{ width: '100%', textAlign: 'left' }} role="option" aria-selected={false} onClick={() => add(h)}>{h.kind === 'group' ? '👥' : '👤'} {h.title}{h.email ? <span className="muted small"> · {h.email}</span> : null}</button></li>)}
      </ul>}
    </div>
  )
}

/** A compact "column / condition / value" list (AND semantics are decided by the caller). */
function ClauseEditor({ fields, value, onChange, label }: { fields: SpField[]; value: Clause[]; onChange: (c: Clause[]) => void; label: string }) {
  const set = (i: number, p: Partial<Clause>) => onChange(value.map((c, j) => (j === i ? { ...c, ...p } : c)))
  return (
    <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
      {value.map((c, i) => {
        const f = fields.find((x) => x.internal === c.field)
        const ops = f ? opsFor(f) : []
        return (
          <div key={i} className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <select className="input" aria-label={`${label} ${i + 1} column`} value={c.field} onChange={(e) => { const nf = fields.find((x) => x.internal === e.target.value); onChange(value.map((x, j) => (j === i ? { field: e.target.value, op: nf ? opsFor(nf)[0].op : 'eq', value: '' } : x))) }}>{fields.map((x) => <option key={x.internal} value={x.internal}>{x.title}</option>)}</select>
            <select className="input" aria-label={`${label} ${i + 1} condition`} value={c.op} onChange={(e) => set(i, { op: e.target.value as Op })}>{ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}</select>
            {!['empty', 'notempty'].includes(c.op) && (c.op === 'in'
              ? <input className="input" aria-label={`${label} ${i + 1} values`} value={(c.values ?? []).join(', ')} onChange={(e) => set(i, { values: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} placeholder="a, b, c" />
              : <input className="input" aria-label={`${label} ${i + 1} value`} value={c.value} onChange={(e) => set(i, { value: e.target.value })} placeholder={f?.kind === 'date' ? 'e.g. today-30' : 'value'} />)}
            <button type="button" className="btn sm ghost" aria-label={`Remove ${label} ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}><Icon n="trash" size={13} /></button>
          </div>
        )
      })}
      <div><button type="button" className="btn sm" disabled={!fields.length} onClick={() => onChange([...value, { field: fields[0].internal, op: opsFor(fields[0])[0].op, value: '' }])}><Icon n="plus" size={13} />Add condition</button></div>
    </div>
  )
}

function DelegateDialog({ engine, onPick, onClose }: { engine: Engine; onPick: (a: Approver) => void; onClose: () => void }) {
  const [pick, setPick] = useState<Approver[]>([])
  return (
    <Modal title="Delegate this approval" onClose={onClose}>
      <p className="muted small" style={{ marginTop: 0 }}>Choose the person who should approve instead of you. They get this step; you are removed from it.</p>
      <ApproverPicker engine={engine} value={pick} onChange={(a) => setPick(a.slice(-1))} label="Delegate to" />
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!pick.length} onClick={() => onPick(pick[0])}>Delegate</button></div>
    </Modal>
  )
}
