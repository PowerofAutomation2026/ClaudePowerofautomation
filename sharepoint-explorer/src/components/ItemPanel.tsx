import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Engine } from '../engine'
import { isEditable } from '../editable'
import type { Attachment, Principal, Row, SpField } from '../types'
import { bytes } from '../util'
import { FileGlyph } from './FileGlyph'
import { PrincipalPicker } from './Permissions'
import { Icon, Modal, hashColor, initials, useToast } from './ui'

type Val = string | boolean | string[] | Principal[] | { url: string; desc: string }

const iso = (d: Date) => d.toISOString().slice(0, 10)
function initial(f: SpField, row: Row | null): Val {
  const v = row?.[f.internal]
  switch (f.kind) {
    case 'boolean': return v == null ? '' : v === true || v === 'true' || v === 'Yes' ? 'true' : 'false'
    case 'date': return v ? String(v).slice(0, 10) : ''
    case 'multichoice': return Array.isArray(v) ? v.map(String) : v ? String(v).split('; ').filter(Boolean) : []
    case 'user': { const names = Array.isArray(v) ? v.map(String) : v ? String(v).split('; ').filter(Boolean) : []; const ids: number[] = row?.[f.internal + '__ids'] ?? []; return names.map((title, i) => ({ id: ids[i] ?? 0, title, login: '', kind: 'user' as const })) }
    case 'url': return { url: v?.Url ?? '', desc: v?.Description ?? '' }
    default: return v == null ? '' : String(v)
  }
}
const same = (a: Val, b: Val) => JSON.stringify(a) === JSON.stringify(b)

function Section({ title, icon, children }: { title: string; icon: string; children: ReactNode }) {
  return <section className="ip-sec"><h3><span aria-hidden="true">{icon}</span>{title}</h3><div className="ip-grid">{children}</div></section>
}

export function ItemPanel({ engine, row, onSave, onClose }: { engine: Engine; row: Row | null; onSave: (values: Record<string, unknown>, files: File[], again: boolean) => Promise<void>; onClose: () => void }) {
  const toast = useToast()
  const fields = useMemo(() => engine.fields.filter((f) => engine.select.includes(f.internal) && isEditable(f)), [engine])
  const [vals, setVals] = useState<Record<string, Val>>(() => Object.fromEntries(fields.map((f) => [f.internal, initial(f, row)])))
  const [base, setBase] = useState(vals)
  const [err, setErr] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const [atts, setAtts] = useState<Attachment[] | null>(null)
  const [attOk, setAttOk] = useState(!engine.src.isLibrary)
  const [leave, setLeave] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const set = (k: string, v: Val) => { setVals((c) => ({ ...c, [k]: v })); setErr((c) => ({ ...c, [k]: '' })) }
  const dirty = fields.some((f) => !same(vals[f.internal], base[f.internal])) || files.length > 0
  const req = fields.filter((f) => f.required)
  const filled = req.filter((f) => { const v = vals[f.internal]; return Array.isArray(v) ? v.length : typeof v === 'object' ? (v as { url: string }).url : v !== '' }).length

  useEffect(() => { // existing attachments
    if (!row || engine.src.isLibrary) return
    engine.backend.listAttachments(engine.src, row.__id).then(setAtts).catch(() => setAttOk(false))
  }, [row?.__id]) // eslint-disable-line react-hooks/exhaustive-deps

  const validate = () => {
    const e: Record<string, string> = {}
    for (const f of fields) {
      const v = vals[f.internal]
      const empty = Array.isArray(v) ? !v.length : typeof v === 'object' ? !(v as { url: string }).url : v === ''
      if (f.required && empty) e[f.internal] = 'This field is required'
      if ((f.kind === 'number' || f.kind === 'currency') && typeof v === 'string' && v !== '' && isNaN(Number(v))) e[f.internal] = 'Enter a number'
      if (f.kind === 'url' && !empty && !/^https?:\/\//i.test((v as { url: string }).url)) e[f.internal] = 'Enter a full web address starting with https://'
    }
    setErr(e)
    if (Object.keys(e).length) { setTimeout(() => body.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 30); return false }
    return true
  }
  const submit = async (again = false) => {
    if (!validate()) return
    const out: Record<string, unknown> = {}
    for (const f of fields) {
      const v = vals[f.internal]
      if (row ? same(v, base[f.internal]) : (Array.isArray(v) ? !v.length : typeof v === 'object' ? !(v as { url: string }).url : v === '')) continue
      out[f.internal] = f.kind === 'boolean' ? (v === '' ? null : v === 'true') : v
    }
    if (row && !Object.keys(out).length && !files.length) { onClose(); return }
    setBusy(true)
    try {
      await onSave(out, files, again)
      if (again) { const fresh = Object.fromEntries(fields.map((f) => [f.internal, initial(f, null)])); setVals(fresh); setBase(fresh); setFiles([]); toast('good', 'Created — add another') }
    } catch (e) { toast('bad', (e as Error).message); setBusy(false); return }
    setBusy(false)
  }
  const tryClose = () => (dirty ? setLeave(true) : onClose())
  const title = row ? String(row[engine.src.isLibrary ? 'FileLeafRef' : 'Title'] ?? `Item ${row.__id}`) : 'New item'

  const addFiles = (fl: FileList | File[] | null) => { if (!fl) return; const arr = Array.from(fl); setFiles((c) => [...c, ...arr]) }   // copy NOW: an <input>'s FileList empties when its value is reset
  const groups: [string, string, SpField[]][] = [
    ['Essentials', '✦', fields.filter((f) => f.internal === 'Title' || f.internal === 'FileLeafRef' || f.required)],
    ['Status & details', '◈', fields.filter((f) => !f.required && f.internal !== 'Title' && f.internal !== 'FileLeafRef' && ['choice', 'multichoice', 'boolean', 'number', 'currency', 'text'].includes(f.kind))],
    ['People & dates', '◷', fields.filter((f) => !f.required && ['user', 'date'].includes(f.kind))],
    ['Notes & links', '✎', fields.filter((f) => !f.required && ['note', 'url'].includes(f.kind))],
  ]
  const seen = new Set<string>()
  const shown = groups.map(([t, i, fs]) => [t, i, fs.filter((f) => !seen.has(f.internal) && (seen.add(f.internal), true))] as [string, string, SpField[]]).filter(([, , fs]) => fs.length)

  return (
    <Modal title={row ? `Edit ${title}` : 'New item'} onClose={tryClose} side className="ipanel">
      <div className="ip-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="ip-kicker">{row ? 'Edit' : 'Create'} · {engine.src.label}</div>
          <h2 style={{ display: 'flex', gap: 10, alignItems: 'center' }}>{engine.src.isLibrary && row && <FileGlyph name={title} folder={row.FSObjType === 1} size={28} />}<span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span></h2>
          {req.length > 0 && <div className="ip-prog" aria-label={`${filled} of ${req.length} required fields complete`}><i style={{ width: `${(filled / req.length) * 100}%` }} /></div>}
        </div>
        <button className="btn icon" onClick={tryClose} aria-label="Close"><Icon n="x" /></button>
      </div>

      <div className="ip-body" ref={body} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void submit() } }}>
        {shown.map(([t, ic, fs]) => (
          <Section key={t} title={t} icon={ic}>
            {fs.map((f) => <Field key={f.internal} f={f} v={vals[f.internal]} set={(v) => set(f.internal, v)} err={err[f.internal]} engine={engine} />)}
          </Section>
        ))}
        {!shown.length && <p className="muted">This {engine.src.isLibrary ? 'file' : 'list'} has no columns the app can edit.</p>}

        {attOk && !engine.src.isLibrary && (
          <Section title="Attachments" icon="📎">
            <div className="ip-full">
              <div className="ip-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files) }}>
                <label className="btn"><Icon n="plus" size={15} />Add files<input type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} /></label>
                <span className="muted small">or drop files here{row ? '' : ' — they upload right after the item is created'}</span>
              </div>
              <ul className="upl" style={{ marginTop: 8 }}>
                {(atts ?? []).map((a) => (
                  <li key={a.name}><FileGlyph name={a.name} size={22} /><a className="nm" href={a.url} target="_blank" rel="noreferrer noopener">{a.name}</a><span />
                    <button type="button" className="btn icon sm ghost" aria-label={`Remove attachment ${a.name}`} onClick={async () => { try { await engine.backend.deleteAttachment(engine.src, row!.__id, a.name); setAtts((c) => c!.filter((x) => x.name !== a.name)) } catch (e) { toast('bad', (e as Error).message) } }}><Icon n="trash" size={14} /></button></li>
                ))}
                {files.map((f, i) => <li key={i}><FileGlyph name={f.name} size={22} /><span className="nm">{f.name}</span><span className="muted small">{bytes(f.size)}</span><button type="button" className="btn icon sm ghost" aria-label={`Remove ${f.name}`} onClick={() => setFiles((c) => c.filter((_, j) => j !== i))}><Icon n="x" size={14} /></button></li>)}
              </ul>
            </div>
          </Section>
        )}
      </div>

      <div className="ip-foot">
        <span className="muted small" aria-live="polite">{dirty ? '● Unsaved changes' : 'No changes'} · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> to save</span>
        <span className="grow" />
        <button className="btn" onClick={tryClose} disabled={busy}>Cancel</button>
        {!row && <button className="btn" onClick={() => void submit(true)} disabled={busy}>Save &amp; add another</button>}
        <button className="btn primary" onClick={() => void submit()} disabled={busy || (!!row && !dirty)}>{busy ? 'Saving…' : row ? 'Save changes' : 'Create item'}</button>
      </div>

      {leave && (
        <Modal title="Discard changes" onClose={() => setLeave(false)}>
          <h2 style={{ marginBottom: 8 }}>Discard your changes?</h2><p className="muted">Everything you typed will be lost.</p>
          <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={() => setLeave(false)}>Keep editing</button><button className="btn primary" style={{ background: 'var(--bad)' }} onClick={onClose}>Discard</button></div>
        </Modal>
      )}
    </Modal>
  )
}

function Field({ f, v, set, err, engine }: { f: SpField; v: Val; set: (v: Val) => void; err?: string; engine: Engine }) {
  const id = `f-${f.internal}`
  const common = { id, 'aria-invalid': !!err, 'aria-describedby': err ? `${id}-e` : undefined }
  const wide = f.kind === 'note' || f.kind === 'user' || f.kind === 'multichoice' || f.kind === 'url' || f.internal === 'Title' || f.internal === 'FileLeafRef' || (f.kind === 'choice' && (f.choices?.length ?? 0) <= 6)
  let control: ReactNode
  switch (f.kind) {
    case 'note': control = <><textarea {...common} className="input" rows={5} value={v as string} onChange={(e) => set(e.target.value)} style={{ resize: 'vertical' }} /><span className="muted small" style={{ textAlign: 'right' }}>{(v as string).length.toLocaleString()} characters</span></>; break
    case 'choice': {
      const ch = f.choices ?? []
      control = ch.length && ch.length <= 6
        ? <div role="radiogroup" aria-label={f.title} className="chipset">{ch.map((c) => <button type="button" key={c} role="radio" aria-checked={v === c} className="chipbtn" style={{ ['--tc' as string]: hashColor(c) }} onClick={() => set(v === c ? '' : c)}><i aria-hidden="true" />{c}</button>)}</div>
        : <select {...common} className="input" value={v as string} onChange={(e) => set(e.target.value)}><option value="">—</option>{ch.map((c) => <option key={c}>{c}</option>)}</select>
      break
    }
    case 'multichoice': control = <div role="group" aria-label={f.title} className="chipset">{(f.choices ?? []).map((c) => { const on = (v as string[]).includes(c); return <button type="button" key={c} role="checkbox" aria-checked={on} className="chipbtn" style={{ ['--tc' as string]: hashColor(c) }} onClick={() => set(on ? (v as string[]).filter((x) => x !== c) : [...(v as string[]), c])}><i aria-hidden="true" />{c}</button> })}</div>; break
    case 'boolean': control = <button type="button" role="switch" aria-checked={v === 'true'} aria-label={f.title} className="switch" onClick={() => set(v === 'true' ? 'false' : 'true')}><span /><b>{v === 'true' ? 'Yes' : v === 'false' ? 'No' : 'Not set'}</b></button>; break
    case 'date': control = <div className="row" style={{ gap: 6 }}><input {...common} className="input" type="date" value={v as string} onChange={(e) => set(e.target.value)} />{[['Today', 0], ['Tomorrow', 1], ['+1 wk', 7]].map(([l, d]) => <button type="button" key={String(l)} className="btn sm" onClick={() => set(iso(new Date(Date.now() + Number(d) * 86_400_000)))}>{l}</button>)}{v && <button type="button" className="btn sm ghost" onClick={() => set('')}>Clear</button>}</div>; break
    case 'number': case 'currency': control = <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>{f.kind === 'currency' && <span className="muted">$</span>}<input {...common} className="input" inputMode="decimal" value={v as string} onChange={(e) => set(e.target.value)} style={{ flex: 1 }} />
      <button type="button" className="btn sm" aria-label={`Decrease ${f.title}`} onClick={() => set(String((Number(v) || 0) - 1))}>−</button><button type="button" className="btn sm" aria-label={`Increase ${f.title}`} onClick={() => set(String((Number(v) || 0) + 1))}>+</button></div>; break
    case 'user': {
      const list = v as Principal[]
      control = <div><div className="row" style={{ gap: 6, marginBottom: list.length ? 6 : 0 }}>{list.map((p, i) => <span key={p.title + i} className="chip"><span className="av" style={{ ['--tc' as string]: hashColor(p.title) }} aria-hidden="true">{initials(p.title)}</span>{p.title}<button type="button" aria-label={`Remove ${p.title}`} onClick={() => set(list.filter((_, j) => j !== i))}><Icon n="x" size={12} /></button></span>)}</div>
        {(f.multi || !list.length) && <PrincipalPicker backend={engine.backend} src={engine.src} onPick={(p) => set(f.multi ? [...list, p] : [p])} />}</div>
      break
    }
    case 'url': { const u = v as { url: string; desc: string }; control = <div className="row" style={{ gap: 6 }}><input {...common} className="input" placeholder="https://…" value={u.url} onChange={(e) => set({ ...u, url: e.target.value })} style={{ flex: 2, minWidth: 160 }} /><input className="input" aria-label={`${f.title} description`} placeholder="Display text" value={u.desc} onChange={(e) => set({ ...u, desc: e.target.value })} style={{ flex: 1, minWidth: 100 }} /></div>; break }
    default: control = <input {...common} className="input" value={v as string} onChange={(e) => set(e.target.value)} autoFocus={f.internal === 'Title' && false} />
  }
  return (
    <div className={`ip-field${wide ? ' wide' : ''}`}>
      <label className="ip-label" htmlFor={f.kind === 'choice' || f.kind === 'multichoice' || f.kind === 'boolean' || f.kind === 'user' ? undefined : id}>{f.title}{f.required && <span aria-hidden="true" style={{ color: 'var(--bad)' }}> *</span>}</label>
      {control}
      {err && <span id={`${id}-e`} role="alert" className="ip-err">⚠ {err}</span>}
    </div>
  )
}
