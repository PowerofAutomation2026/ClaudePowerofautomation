import { useCallback, useEffect, useState } from 'react'
import type { Backend, PermInfo, PermTarget, Principal, RoleAssign, RoleDef, SourceConfig } from '../types'
import { Icon, Modal, hashColor, initials, useToast } from './ui'

const ROLE_HINT: Record<string, string> = { 'Full Control': 'Manage everything, including permissions', Design: 'View, add, update, delete, approve, customise', Edit: 'Add, edit and delete lists/items', Contribute: 'View, add, update and delete items', Read: 'View pages and items' }

/** People & groups picker: searches the tenant directory + SharePoint groups through the site's people picker. */
export function PrincipalPicker({ backend, src, onPick }: { backend: Backend; src: SourceConfig; onPick: (p: Principal) => void }) {
  const [q, setQ] = useState('')
  const [res, setRes] = useState<Principal[]>([])
  const [busy, setBusy] = useState(false)
  const [act, setAct] = useState(0)
  useEffect(() => {
    if (q.trim().length < 2) { setRes([]); return }
    const ctl = new AbortController(); setBusy(true)
    const h = setTimeout(() => backend.searchPrincipals(src, q.trim(), ctl.signal).then((r) => { if (!ctl.signal.aborted) { setRes(r); setAct(0) } }).catch(() => {}).finally(() => setBusy(false)), 280)
    return () => { clearTimeout(h); ctl.abort() }
  }, [q]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div style={{ position: 'relative', flex: '1 1 260px' }}>
      <label className="field">Add a person or group
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a name or e-mail…" role="combobox" aria-expanded={res.length > 0} aria-controls="pp-list" aria-autocomplete="list"
          onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setAct((a) => Math.min(res.length - 1, a + 1)) } if (e.key === 'ArrowUp') { e.preventDefault(); setAct((a) => Math.max(0, a - 1)) } if (e.key === 'Enter' && res[act]) { e.preventDefault(); onPick(res[act]); setQ(''); setRes([]) } }} />
      </label>
      {(res.length > 0 || busy) && (
        <ul id="pp-list" role="listbox" className="sugg" style={{ top: '100%' }}>
          {busy && !res.length && <li className="muted">Searching…</li>}
          {res.map((p, i) => (
            <li key={p.login + p.id} role="option" aria-selected={i === act} onMouseDown={(e) => { e.preventDefault(); onPick(p); setQ(''); setRes([]) }} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span className="av" style={{ ['--tc' as string]: hashColor(p.title), width: 28, height: 28 }} aria-hidden="true">{p.kind === 'group' ? '👥' : initials(p.title)}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}><b>{p.title}</b><br /><span className="muted small">{p.email ?? (p.kind === 'group' ? 'Group' : '')}</span></span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function PermissionsDialog({ backend, src, target, title, canManage, onClose }: { backend: Backend; src: SourceConfig; target: PermTarget; title: string; canManage: boolean; onClose: () => void }) {
  const toast = useToast()
  const [info, setInfo] = useState<PermInfo | null>(null)
  const [roles, setRoles] = useState<RoleDef[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [who, setWho] = useState<Principal | null>(null)
  const [role, setRole] = useState<number>(0)
  const [confirm, setConfirm] = useState(false)

  const load = useCallback(async () => {
    setErr('')
    try { const [i, r] = await Promise.all([backend.getPermissions(src, target), backend.listRoleDefs(src)]); setInfo(i); setRoles(r); setRole((cur) => cur || r.find((x) => x.name === 'Read')?.id || r[0]?.id || 0) }
    catch (e) { setErr((e as Error).message) }
  }, [backend, src, target])
  useEffect(() => { void load() }, [load])

  const act = async (fn: () => Promise<void>, ok: string) => { setBusy(true); try { await fn(); toast('good', ok); await load() } catch (e) { toast('bad', (e as Error).message) } finally { setBusy(false) } }
  const editable = canManage && !!info && !info.inherited
  const what = target.kind === 'list' ? (src.isLibrary ? 'library' : 'list') : 'item'

  return (
    <Modal title={`Manage access: ${title}`} onClose={onClose} className="wide">
      <h2 style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 4 }}><span style={{ color: 'var(--accent)' }}><Icon n="lock" size={22} /></span>Manage access</h2>
      <div className="muted" style={{ marginBottom: 12 }}>{title} <span className="pill">{what}</span></div>
      {err && <div className="banner bad" role="alert"><Icon n="info" /><div>{err}</div></div>}
      {!info && !err && <div className="skel" style={{ height: 120 }} aria-busy="true" />}
      {info && <>
        {target.kind === 'item' && (
          <div className={`banner ${info.inherited ? 'info' : ''}`}>
            <Icon n="info" />
            <div style={{ flex: 1 }}>{info.inherited
              ? <><b>Inheriting</b> permissions from the {src.isLibrary ? 'library or parent folder' : 'list'}. Stop inheriting to give this {what} its own access list.</>
              : <><b>Unique permissions</b> — this {what} has its own access list. Reset to follow the {src.isLibrary ? 'parent folder' : 'list'} again.</>}</div>
            {canManage && (info.inherited
              ? <button className="btn sm" disabled={busy} onClick={() => setConfirm(true)}>Stop inheriting</button>
              : <button className="btn sm" disabled={busy} onClick={() => void act(() => backend.setInheritance(src, target, true), 'Now inheriting permissions again')}>Reset to inherit</button>)}
          </div>
        )}
        <ul className="perm-list" aria-label="Who has access">
          {info.assignments.map((a: RoleAssign, i) => (
            <li key={`${a.principal.id}-${i}`}>
              <span className="av" style={{ ['--tc' as string]: hashColor(a.principal.title), width: 32, height: 32, fontSize: '.8rem' }} aria-hidden="true">{a.principal.kind === 'group' ? '👥' : initials(a.principal.title)}</span>
              <div style={{ flex: 1, minWidth: 0 }}><b>{a.principal.title}</b><div className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.principal.kind === 'group' ? 'Group' : a.principal.email ?? a.principal.login}</div></div>
              <div className="row" style={{ gap: 4 }}>{a.roles.map((r) => <span key={r} className={`pill ${r === 'Full Control' ? 'accent' : r === 'Read' ? '' : 'good'}`} title={ROLE_HINT[r]}>{r}</span>)}</div>
              {editable && <button className="btn icon sm ghost" aria-label={`Remove ${a.principal.title}`} disabled={busy} onClick={() => void act(() => backend.removePermission(src, target, a), `Removed ${a.principal.title}`)}><Icon n="trash" size={15} /></button>}
            </li>
          ))}
          {!info.assignments.length && <li className="muted">No one has been granted access directly.</li>}
        </ul>

        {canManage ? (
          <form className="row" style={{ alignItems: 'end', marginTop: 12, opacity: editable ? 1 : .55 }} onSubmit={(e) => { e.preventDefault(); if (!who || !role) return; void act(async () => { const id = await backend.resolvePrincipal(src, who); await backend.addPermission(src, target, id, role); setWho(null) }, `Granted access to ${who.title}`) }}>
            {who ? (
              <div style={{ flex: '1 1 260px' }}><div className="field" style={{ marginBottom: 4 }}>Selected</div><span className="chip">{who.title}<button type="button" aria-label="Clear selection" onClick={() => setWho(null)}><Icon n="x" size={12} /></button></span></div>
            ) : <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0, flex: '1 1 260px' }}><PrincipalPicker backend={backend} src={src} onPick={setWho} /></fieldset>}
            <label className="field">Permission level
              <select className="input" value={role} onChange={(e) => setRole(Number(e.target.value))} disabled={!editable}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}{ROLE_HINT[r.name] ? ` — ${ROLE_HINT[r.name]}` : ''}</option>)}</select>
            </label>
            <button className="btn primary" disabled={!editable || !who || busy}>Grant access</button>
          </form>
        ) : <p className="muted small">Only people with the <b>Manage permissions</b> right (site owners / full control) can change access. You can see who has access.</p>}
        {!editable && canManage && target.kind === 'item' && <p className="muted small">Stop inheriting first to add or remove people on this {what}.</p>}
        <p className="muted small" style={{ marginBottom: 0 }}>These are the real SharePoint permissions: changes apply everywhere the {what} is used, not only in this app.</p>
      </>}

      {confirm && (
        <Modal title="Stop inheriting" onClose={() => setConfirm(false)}>
          <h2 style={{ marginBottom: 8 }}>Stop inheriting permissions?</h2>
          <p className="muted">The {what} keeps its current access list but will no longer follow changes made to its parent. You can reset this later.</p>
          <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={() => setConfirm(false)}>Cancel</button><button className="btn primary" onClick={() => { setConfirm(false); void act(() => backend.setInheritance(src, target, false), 'Unique permissions created') }}>Stop inheriting</button></div>
        </Modal>
      )}
    </Modal>
  )
}
