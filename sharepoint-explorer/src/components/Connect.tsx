import { useEffect, useMemo, useState } from 'react'
import type { Engine } from '../engine'
import type { AppConfig, Backend, SourceConfig, SpList, SpSite } from '../types'
import { fmt, lsGet, lsSet, relTime, uid } from '../util'
import { Icon, useToast } from './ui'

interface Props {
  backend: Backend
  config: AppConfig
  isOwner: boolean
  who: { upn: string; name: string }
  engine: Engine | null
  onSaved: (cfg: AppConfig, open?: SourceConfig) => void
}

export function Connect({ backend, config, isOwner, who, engine, onSaved }: Props) {
  const toast = useToast()
  const [site, setSite] = useState(lsGet<string>('spx.lastSite', backend.mode === 'demo' ? 'https://contoso.sharepoint.com/sites/demo' : ''))
  const [sites, setSites] = useState<SpSite[]>([])
  const [lists, setLists] = useState<SpList[] | null>(null)
  const [sel, setSel] = useState<SpList | null>(null)
  const [label, setLabel] = useState('')
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<'all' | 'list' | 'lib'>('all')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const step = !lists ? 1 : !sel ? 2 : 3

  useEffect(() => { if (isOwner) backend.listSites().then(setSites).catch(() => {}) }, [backend, isOwner])

  const load = async () => {
    setErr(''); setBusy(true); setSel(null)
    try {
      const url = site.trim().replace(/\/+$/, '')
      if (!/^https:\/\/[^/]+\.sharepoint\.(com|us|de|cn)\//i.test(url + '/') && backend.mode === 'live') throw new Error('Enter a SharePoint site address, e.g. https://contoso.sharepoint.com/sites/Finance')
      setLists(await backend.listLists(url)); lsSet('spx.lastSite', url); setSite(url)
    } catch (e) { setErr((e as Error).message); setLists(null) } finally { setBusy(false) }
  }

  const shown = useMemo(() => (lists ?? []).filter((l) => (kind === 'all' || (kind === 'lib') === l.isLibrary) && l.title.toLowerCase().includes(q.toLowerCase())), [lists, kind, q])

  const connect = async () => {
    if (!sel) return
    setBusy(true); setErr('')
    try {
      const src: SourceConfig = {
        id: `${sel.id}`.slice(0, 40), siteUrl: site, listId: sel.id, title: sel.title, label: label.trim() || sel.title, isLibrary: sel.isLibrary,
        itemCount: sel.itemCount, added: new Date().toISOString(), addedBy: who.upn,
      }
      const next: AppConfig = { ...config, sources: [...config.sources.filter((s) => !(s.listId === src.listId && s.siteUrl === src.siteUrl)), src], activeId: src.id, updated: new Date().toISOString(), updatedBy: who.upn }
      await backend.saveConfig(next)
      toast('good', `Connected to “${src.label}”. All users now see it.`)
      onSaved(next, src); setSel(null); setLabel('')
    } catch (e) { setErr(`Could not save the connection: ${(e as Error).message}`) } finally { setBusy(false) }
  }

  const update = async (next: AppConfig, open?: SourceConfig) => {
    try { await backend.saveConfig(next); onSaved(next, open) } catch (e) { toast('bad', (e as Error).message) }
  }
  const stamp = (c: AppConfig): AppConfig => ({ ...c, updated: new Date().toISOString(), updatedBy: who.upn })

  return (
    <div>
      <div className="hero">
        <h1>{isOwner ? 'Connect a SharePoint list or library' : 'Data source'}</h1>
        <span>{isOwner ? 'Pick any site, list or library, press Connect — the whole app (grid, dashboard, search, export) rebuilds itself around its columns.' : 'Only the app owner can choose which list or library this app shows.'}</span>
      </div>

      {!isOwner && (
        <div className="card">
          <h2><Icon n="lock" /> Managed by the app owner</h2>
          <p className="muted">You are signed in as <b>{who.upn || who.name}</b>. {config.owners.length ? <>App owner{config.owners.length > 1 ? 's' : ''}: <b>{config.owners.join(', ')}</b>.</> : 'No owner is configured for this deployment — re-run the deploy script with -OwnerUpn.'}</p>
          <Published config={config} owner={false} onOpen={(s) => onSaved({ ...config, activeId: s.id }, s)} onRemove={() => {}} onRename={() => {}} />
        </div>
      )}

      {isOwner && <>
        <ol className="steps" aria-label="Steps">
          <li className={step === 1 ? 'on' : 'done'}><b>1</b>Site</li>
          <li className={step === 2 ? 'on' : step > 2 ? 'done' : ''}><b>2</b>List or library</li>
          <li className={step === 3 ? 'on' : ''}><b>3</b>Connect</li>
        </ol>

        <div className="card" style={{ marginBottom: 14 }}>
          <h2>1 · SharePoint site</h2>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void load() }}>
            <label className="field" style={{ flex: '1 1 420px' }}>Site address
              <input className="input" value={site} onChange={(e) => setSite(e.target.value)} list="site-suggestions" placeholder="https://contoso.sharepoint.com/sites/Finance" autoComplete="off" spellCheck={false} />
            </label>
            <datalist id="site-suggestions">{sites.map((s) => <option key={s.url} value={s.url}>{s.title}</option>)}</datalist>
            <button className="btn primary" type="submit" disabled={busy || !site.trim()} style={{ alignSelf: 'end' }}>{busy && !lists ? 'Loading…' : 'Load lists & libraries'}</button>
          </form>
          {sites.length > 0 && <p className="small muted" style={{ marginBottom: 0 }}>Recently used sites: {sites.slice(0, 5).map((s) => <button key={s.url} className="btn sm ghost" onClick={() => setSite(s.url)}>{s.title}</button>)}</p>}
          {err && <div className="banner bad" role="alert" style={{ marginTop: 10 }}><Icon n="info" />{err}</div>}
        </div>

        {lists && (
          <div className="card" style={{ marginBottom: 14 }}>
            <h2>2 · Choose what to connect <span className="pill">{shown.length} of {lists.length}</span></h2>
            <div className="bar">
              <div className="search"><span className="lead"><Icon n="search" /></span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name" aria-label="Filter lists and libraries" /></div>
              {(['all', 'list', 'lib'] as const).map((k) => <button key={k} className="btn" aria-pressed={kind === k} onClick={() => setKind(k)}>{k === 'all' ? 'All' : k === 'list' ? 'Lists' : 'Libraries'}</button>)}
            </div>
            <div className="listgrid" role="list">
              {shown.map((l) => (
                <button key={l.id} role="listitem" className={`lcard${l.isLibrary ? ' lib' : ''}`} aria-pressed={sel?.id === l.id} onClick={() => { setSel(l); setLabel(l.title) }}>
                  <span className="ico"><Icon n={l.isLibrary ? 'lib' : 'list'} size={22} /></span>
                  <b>{l.title}</b>
                  <span className="muted small">{l.isLibrary ? 'Document library' : 'List'} · {fmt(l.itemCount)} items{l.modified ? ` · ${relTime(l.modified)}` : ''}</span>
                  {l.description && <span className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.description}</span>}
                </button>
              ))}
              {!shown.length && <p className="muted">Nothing matches.</p>}
            </div>
          </div>
        )}

        {sel && (
          <div className="card" style={{ marginBottom: 14, borderColor: 'var(--accent)' }}>
            <h2>3 · Connect “{sel.title}”</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              {sel.isLibrary ? 'Document library' : 'List'} with <b>{fmt(sel.itemCount)}</b> items →
              {sel.itemCount <= 25_000 ? ' runs fully in memory: instant search, filter and sort.' : ' runs in heavy-duty mode: server-side search and filters, paged loading, streamed exports — safe for millions of rows.'}
            </p>
            {sel.itemCount > 5000 && <div className="banner info"><Icon n="info" /><span>List has more than 5,000 items. Index the columns people filter by (Title, Created, Modified, Status…) after connecting — see <b>Performance</b> below.</span></div>}
            <div className="row">
              <label className="field" style={{ flex: '1 1 280px' }}>Display name for users<input className="input" value={label} onChange={(e) => setLabel(e.target.value)} /></label>
              <button className="btn primary big" onClick={connect} disabled={busy} style={{ alignSelf: 'end' }}><Icon n="plug" />{busy ? 'Connecting…' : 'Connect'}</button>
            </div>
          </div>
        )}

        <div className="card" style={{ marginBottom: 14 }}>
          <h2><Icon n="star" /> Published to all users <span className="pill">{config.sources.length}</span></h2>
          <Published config={config} owner onOpen={(s) => onSaved({ ...config, activeId: s.id }, s)}
            onRemove={(s) => void update(stamp({ ...config, sources: config.sources.filter((x) => x.id !== s.id), activeId: config.activeId === s.id ? config.sources.find((x) => x.id !== s.id)?.id : config.activeId }))}
            onRename={(s, name) => void update(stamp({ ...config, sources: config.sources.map((x) => (x.id === s.id ? { ...x, label: name } : x)) }))}
            onDefault={(s) => void update(stamp({ ...config, activeId: s.id }))} />
          <p className="small muted">Saved in {backend.mode === 'demo' ? 'this browser (demo)' : 'a small SharePoint list on the config site'} so every user opens the same data. Owners are fixed at deploy time: {config.owners.join(', ') || '(none)'}.</p>
        </div>

        {engine && engine.mode === 'server' && <Performance engine={engine} />}
      </>}
    </div>
  )
}

function Published({ config, owner, onOpen, onRemove, onRename, onDefault }: { config: AppConfig; owner: boolean; onOpen: (s: SourceConfig) => void; onRemove: (s: SourceConfig) => void; onRename: (s: SourceConfig, n: string) => void; onDefault?: (s: SourceConfig) => void }) {
  if (!config.sources.length) return <p className="muted">Nothing connected yet.</p>
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
      {config.sources.map((s) => (
        <li key={s.id} className="row" style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 12 }}>
          <span className="lcard lib" style={{ border: 0, padding: 0, cursor: 'default', background: 'none' }}><span className="ico"><Icon n={s.isLibrary ? 'lib' : 'list'} /></span></span>
          <div style={{ flex: 1, minWidth: 180 }}>
            {owner ? <input className="input" defaultValue={s.label} aria-label={`Display name for ${s.title}`} onBlur={(e) => e.target.value !== s.label && onRename(s, e.target.value)} /> : <b>{s.label}</b>}
            <div className="muted small">{s.title} · {fmt(s.itemCount)} items · {s.siteUrl.replace(/^https:\/\//, '')} {config.activeId === s.id && <span className="pill good">default</span>}</div>
          </div>
          <button className="btn" onClick={() => onOpen(s)}>Open</button>
          {owner && config.activeId !== s.id && <button className="btn" onClick={() => onDefault?.(s)}>Make default</button>}
          {owner && <button className="btn danger" onClick={() => onRemove(s)} aria-label={`Remove ${s.label}`}><Icon n="trash" size={16} /></button>}
        </li>
      ))}
    </ul>
  )
}

function Performance({ engine }: { engine: Engine }) {
  const toast = useToast()
  const [done, setDone] = useState<string[]>([])
  const [busy, setBusy] = useState('')
  const cand = engine.fields.filter((f) => !f.indexed && f.filterable && ['text', 'date', 'choice', 'number', 'currency', 'boolean', 'user', 'lookup'].includes(f.kind) && !done.includes(f.internal)).slice(0, 14)
  const index = async (f: string) => {
    setBusy(f)
    try { await engine.backend.indexColumn(engine.src, f); setDone((d) => [...d, f]); toast('good', `Indexed “${f}”. Filters on it are now fast at any size.`) }
    catch (e) { toast('bad', `Could not index: ${(e as Error).message}`) } finally { setBusy('') }
  }
  return (
    <div className="card">
      <h2><Icon n="bolt" /> Performance — index columns (large list: {fmt(engine.total)} items)</h2>
      <p className="muted small">SharePoint can only search/filter/sort a list above 5,000 items on <b>indexed</b> columns. Index the ones users filter by. (Max 20 per list; SharePoint builds the index in the background.)</p>
      <div className="row">
        {cand.map((f) => <button key={f.internal} className="btn sm" disabled={busy === f.internal} onClick={() => void index(f.internal)}><Icon n="plus" size={13} />{f.title}</button>)}
        {!cand.length && <span className="pill good">All filterable columns already indexed</span>}
      </div>
    </div>
  )
}

export { uid }
