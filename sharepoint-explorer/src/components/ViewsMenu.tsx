import { useState } from 'react'
import type { Access, AppConfig, ViewDef } from '../types'
import { viewVisible } from '../access'
import { sameUser } from '../util'
import { Icon, Menu, Modal } from './ui'

const AUD = { me: 'Only me', everyone: 'Everyone', groups: 'Specific SharePoint groups', admins: 'Data admins only' } as const

export function ViewsMenu({ views, access, cfg, upn, onApply, onSave, onDelete }: {
  views: ViewDef[]; access: Access; cfg: AppConfig; upn: string
  onApply: (v: ViewDef) => void; onSave: (name: string, audience: ViewDef['audience'], groups: string[]) => Promise<void>; onDelete: (v: ViewDef) => void
}) {
  const [dlg, setDlg] = useState(false)
  const owner = cfg.owners.some((o) => sameUser(o, upn))
  const mayShare = owner || access.role === 'admin'
  const visible = views.filter((v) => viewVisible(v, access, cfg, upn))
  const mine = visible.filter((v) => v.audience === 'me'), shared = visible.filter((v) => v.audience !== 'me')
  const mayDelete = (v: ViewDef) => sameUser(v.owner, upn) || owner || (access.role === 'admin' && v.audience !== 'me')

  const row = (v: ViewDef, close: () => void) => (
    <div key={v.id} className="row" style={{ flexWrap: 'nowrap', gap: 0 }}>
      <button onClick={() => { close(); onApply(v) }} style={{ flex: 1 }}>
        {v.name}
        {v.audience !== 'me' && <span className="pill" style={{ marginLeft: 'auto' }}>{v.audience === 'groups' ? (v.groups ?? []).join(', ') || 'groups' : AUD[v.audience]}</span>}
      </button>
      {mayDelete(v) && <button className="btn icon sm ghost" style={{ width: 'auto' }} aria-label={`Delete view ${v.name}`} onClick={() => onDelete(v)}><Icon n="trash" size={14} /></button>}
    </div>
  )

  return (
    <>
      <Menu icon="star" label={<span className="lbl-t">Views</span>} wide>
        {(close) => (
          <div>
            <button onClick={() => { close(); setDlg(true) }}><Icon n="plus" />Save current view…</button>
            {mine.length > 0 && <><hr /><div className="hd">My views</div>{mine.map((v) => row(v, close))}</>}
            {shared.length > 0 && <><hr /><div className="hd">Shared views</div>{shared.map((v) => row(v, close))}</>}
            {!visible.length && <p className="muted small" style={{ padding: '4px 10px' }}>No saved views yet. A view remembers search, filters, sort, columns and layout.</p>}
          </div>
        )}
      </Menu>
      {dlg && <SaveDialog access={access} mayShare={mayShare} onClose={() => setDlg(false)} onSave={async (n, a, g) => { await onSave(n, a, g); setDlg(false) }} />}
    </>
  )
}

function SaveDialog({ access, mayShare, onClose, onSave }: { access: Access; mayShare: boolean; onClose: () => void; onSave: (n: string, a: ViewDef['audience'], g: string[]) => Promise<void> }) {
  const [name, setName] = useState('')
  const [aud, setAud] = useState<ViewDef['audience']>('me')
  const [groups, setGroups] = useState<string[]>([])
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const all = [...new Set([...access.groups, ...custom.split(',').map((x) => x.trim()).filter(Boolean)])]
  return (
    <Modal title="Save view" onClose={onClose}>
      <h2 style={{ marginBottom: 12 }}>Save this view</h2>
      <form style={{ display: 'grid', gap: 12 }} onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return; setBusy(true); try { await onSave(name.trim(), aud, aud === 'groups' ? groups : []) } finally { setBusy(false) } }}>
        <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. My open items" /></label>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="muted small" style={{ fontWeight: 700 }}>Who can see this view</legend>
          {(Object.keys(AUD) as (keyof typeof AUD)[]).map((k) => {
            const locked = k !== 'me' && !mayShare
            return <label key={k} style={{ display: 'flex', gap: 8, padding: 4, opacity: locked ? .5 : 1 }}><input type="radio" name="aud" checked={aud === k} disabled={locked} onChange={() => setAud(k)} />{AUD[k]}{locked && <span className="muted small">(data admins and app owners only)</span>}</label>
          })}
        </fieldset>
        {aud === 'groups' && (
          <div>
            <div className="muted small" style={{ marginBottom: 4 }}>Your SharePoint groups — pick the ones that may see the view:</div>
            <div className="row">{all.map((g) => <label key={g} className="pill"><input type="checkbox" checked={groups.includes(g)} onChange={(e) => setGroups(e.target.checked ? [...groups, g] : groups.filter((x) => x !== g))} />{g}</label>)}</div>
            <label className="field" style={{ marginTop: 8 }}>Other group names (comma separated)<input className="input" value={custom} onChange={(e) => setCustom(e.target.value)} /></label>
          </div>
        )}
        <p className="muted small" style={{ margin: 0 }}>A view only changes <b>what is shown</b>. What people can actually read or change is always decided by SharePoint permissions.</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim() || (aud === 'groups' && !groups.length)}>Save view</button>
        </div>
      </form>
    </Modal>
  )
}
