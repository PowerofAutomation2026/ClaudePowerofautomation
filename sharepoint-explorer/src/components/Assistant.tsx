import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AGENT_INSTRUCTIONS, buildContext, withContext } from '../assistantContext'
import type { Engine } from '../engine'
import type { Assistant, AssistantConfig, Row } from '../types'
import { uid } from '../util'
import { Icon, Modal, useToast } from './ui'

const LINK_HOSTS = /(^|\.)((copilotstudio|powerva)\.microsoft\.com|m365\.cloud\.microsoft|copilot\.cloud\.microsoft|copilot\.microsoft\.com|microsoft365\.com|office\.com|teams\.microsoft\.com|teams\.cloud\.microsoft|powerplatform\.com|directline\.botframework\.com)$/i
export const inScope = (a: Assistant, sourceId: string) => a.enabled && (a.scope === 'all' || a.scope.includes(sourceId))
export const goodUrl = (u?: string) => { try { const x = new URL(u ?? ''); return x.protocol === 'https:' ? x : null } catch { return null } }

/** Tiny safe markdown: **bold**, `code`, [text](https://link), "- " lists. Rendered as React nodes (never as raw HTML). */
function inline(t: string): ReactNode[] {
  const out: ReactNode[] = []; const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https:\/\/[^)\s]+\)|https:\/\/[^\s)]+)/g
  let last = 0, m: RegExpExecArray | null, i = 0
  while ((m = re.exec(t))) {
    if (m.index > last) out.push(t.slice(last, m.index))
    const x = m[0]
    if (x.startsWith('**')) out.push(<b key={i++}>{x.slice(2, -2)}</b>)
    else if (x.startsWith('`')) out.push(<code key={i++}>{x.slice(1, -1)}</code>)
    else if (x.startsWith('[')) { const mm = /\[([^\]]+)\]\((.+)\)/.exec(x)!; out.push(<a key={i++} href={mm[2]} target="_blank" rel="noreferrer noopener">{mm[1]}</a>) }
    else out.push(<a key={i++} href={x} target="_blank" rel="noreferrer noopener">{x}</a>)
    last = m.index + x.length
  }
  if (last < t.length) out.push(t.slice(last))
  return out
}
export function Md({ text }: { text: string }) {
  const blocks: ReactNode[] = []; let list: string[] = []
  const flush = () => { if (list.length) { blocks.push(<ul key={blocks.length} style={{ margin: '4px 0', paddingLeft: 20 }}>{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>); list = [] } }
  for (const line of text.split(/\r?\n/)) {
    const li = /^\s*[-*•]\s+(.*)/.exec(line) ?? /^\s*\d+[.)]\s+(.*)/.exec(line)
    if (li) list.push(li[1]); else { flush(); if (line.trim()) blocks.push(<p key={blocks.length} style={{ margin: '4px 0' }}>{inline(line)}</p>) }
  }
  flush()
  return <>{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</>
}

interface Msg { role: 'user' | 'agent' | 'error'; text: string; at: number }
const chats = new Map<string, { msgs: Msg[]; conv?: string }>()   // survives closing the panel, per agent + source

/** The assistant side panel: chat with a Copilot Studio agent, or open an Agent Builder / M365 Copilot agent with context. */
export function AssistantPanel({ engine, cfg, who, selected, canSetup, onSetup, onClose }: { engine: Engine; cfg: AssistantConfig | null; who: { name: string; upn: string }; selected: Row[]; canSetup: boolean; onSetup: () => void; onClose: () => void }) {
  const toast = useToast()
  const list = (cfg?.assistants ?? []).filter((a) => inScope(a, engine.src.id))
  const [aid, setAid] = useState(list[0]?.id)
  const a = list.find((x) => x.id === aid) ?? list[0]
  const key = `${a?.id}:${engine.src.id}`
  const [, force] = useState(0)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [withCtx, setWithCtx] = useState(true)
  const log = useRef<HTMLDivElement>(null)
  const chat = chats.get(key) ?? { msgs: [] }
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }) }, [chat.msgs.length, busy])

  const ctxJson = () => buildContext(engine, who, selected, { sendRows: !!a?.sendRows && withCtx, instructions: a?.instructions })
  const send = async (q: string) => {
    const question = q.trim(); if (!question || !a || busy) return
    const c = chats.get(key) ?? { msgs: [] }; chats.set(key, c)
    c.msgs.push({ role: 'user', text: question, at: Date.now() }); setText(''); setBusy(true); force((n) => n + 1)
    try {
      let msg = question
      if (withCtx) msg = withContext(ctxJson(), question)
      if (!c.conv && c.msgs.length > 2) msg = `Earlier in this chat:\n${c.msgs.slice(-7, -1).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text.slice(0, 400)}`).join('\n')}\n\n${msg}`   // agent did not give us a conversation id: carry a short history ourselves
      const r = await engine.backend.askAgent(a.agent ?? '', msg, c.conv)
      if (r.conversationId) c.conv = r.conversationId
      c.msgs.push({ role: 'agent', text: r.text || '(The agent returned an empty answer. Check its instructions and that it is published.)', at: Date.now() })
    } catch (e) { c.msgs.push({ role: 'error', text: (e as Error).message, at: Date.now() }) }
    setBusy(false); force((n) => n + 1)
  }
  const sel = selected.length
  const suggestions = useMemo(() => [
    ...(a?.prompts ?? []),
    ...(sel ? [`Summarize the ${sel} selected ${engine.src.isLibrary ? 'file' : 'item'}${sel > 1 ? 's' : ''}`, `Draft a short email about the selected ${engine.src.isLibrary ? 'file' : 'item'}${sel > 1 ? 's' : ''}`] : [`Summarize this ${engine.src.isLibrary ? 'library' : 'list'}`, 'What needs attention right now?']),
  ].slice(0, 6), [a, sel, engine.src.isLibrary])

  return (
    <Modal title="Assistant" onClose={onClose} side>
      <div className="body" style={{ display: 'grid', gridTemplateRows: 'auto 1fr auto', gap: 10, minHeight: '70vh' }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {list.length > 1 && <select className="input" aria-label="Choose assistant" value={a?.id} onChange={(e) => setAid(e.target.value)}>{list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}
          {list.length === 1 && <b><Icon n="sparkle" size={15} /> {a!.name}</b>}
          <span className="grow" />
          {a?.kind === 'studio' && chat.msgs.length > 0 && <button className="btn sm" onClick={() => { chats.delete(key); force((n) => n + 1) }}>New chat</button>}
          {canSetup && <button className="btn sm" onClick={onSetup}><Icon n="gear" size={14} />Setup</button>}
        </div>

        {!a ? (
          <div className="card empty"><Icon n="sparkle" size={36} /><h3>No assistant yet</h3><p className="muted">{canSetup ? 'Connect a Copilot Studio agent or an Agent Builder / Microsoft 365 Copilot agent in a few clicks.' : 'An admin has not connected an assistant for this list yet.'}</p>{canSetup && <button className="btn primary" onClick={onSetup}>Set up an assistant</button>}</div>
        ) : a.kind === 'link' ? (
          <div className="card" style={{ padding: 14, display: 'grid', gap: 10, alignContent: 'start' }}>
            <div><b>{a.name}</b><p className="muted small" style={{ margin: '4px 0 0' }}>{a.description || 'This agent opens in its own window.'}</p></div>
            <p className="small" style={{ margin: 0 }}>Microsoft 365 Copilot agents (Agent Builder) can’t be embedded or called from an app, so this opens the agent’s chat. Copy the context first and paste it into the chat so the agent knows what you are looking at.</p>
            <label className="small">Your question (optional)<textarea className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)} /></label>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button className="btn" onClick={async () => { try { await navigator.clipboard.writeText(withContext(ctxJson(), text || 'Help me with this.')); toast('good', 'Prompt with context copied — paste it into the agent chat.') } catch { toast('warn', 'Could not copy automatically.') } }}><Icon n="copy" size={14} />Copy prompt with context</button>
              <button className="btn primary" onClick={() => { const u = goodUrl(a.url); if (!u || !window.open(u.href, '_blank', 'noopener')) toast('warn', 'Could not open the agent — pop-up blocked or the link is invalid.') }}><Icon n="ext" size={14} />Open {a.name}</button>
            </div>
          </div>
        ) : (
          <>
            <div ref={log} className="chatlog" role="log" aria-live="polite" aria-label="Conversation" style={{ overflow: 'auto', display: 'grid', gap: 8, alignContent: 'start', maxHeight: '58vh' }}>
              {chat.msgs.length === 0 && <div className="muted small" style={{ padding: 6 }}>{a.description || `Ask ${a.name} about this ${engine.src.isLibrary ? 'library' : 'list'}.`}</div>}
              {chat.msgs.map((m, i) => (
                <div key={i} className={`bubble ${m.role}`}>
                  {m.role === 'agent' ? <Md text={m.text} /> : <span style={{ whiteSpace: 'pre-wrap' }}>{m.text}</span>}
                  {m.role === 'agent' && <button className="btn sm ghost" aria-label="Copy answer" onClick={() => navigator.clipboard?.writeText(m.text).then(() => toast('good', 'Answer copied'))}><Icon n="copy" size={12} /></button>}
                </div>
              ))}
              {busy && <div className="bubble agent" role="status" aria-label="The agent is typing"><span className="typing"><i /><i /><i /></span></div>}
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{suggestions.map((s) => <button key={s} className="btn sm" disabled={busy} onClick={() => void send(s)}>{s}</button>)}</div>
              <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={withCtx} onChange={(e) => setWithCtx(e.target.checked)} />Tell the agent what I’m looking at ({engine.src.label}{sel ? `, ${sel} selected` : ''}{a.sendRows ? '' : ' — item data is not sent'})</label>
              <form className="row" style={{ gap: 6, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); void send(text) }}>
                <textarea className="input" style={{ flex: 1 }} rows={2} aria-label="Message to the assistant" value={text} placeholder="Ask anything…" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(text) } }} />
                <button className="btn primary" type="submit" disabled={busy || !text.trim()}>Send</button>
              </form>
              <div className="muted small">AI can be wrong — check important answers. The agent runs with your own permissions.</div>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

/** Admin: add / test / scope agents. Everything is stored in SPX_Config and applies to all users. */
export function AssistantSetup({ engine, cfg, who, onSave, onClose }: { engine: Engine; cfg: AssistantConfig | null; who: string; onSave: (c: AssistantConfig) => Promise<void>; onClose: () => void }) {
  const toast = useToast()
  const [items, setItems] = useState<Assistant[]>(cfg?.assistants ?? [])
  const [edit, setEdit] = useState<Assistant | null>(null)
  const [saving, setSaving] = useState(false)
  const connector = engine.backend.agentConnector()
  const knowledge = `${engine.src.siteUrl.replace(/\/$/, '')}${engine.src.url ? new URL(engine.src.url, engine.src.siteUrl).pathname.replace(/^\/?/, '/') : ''}`
  const upsert = (x: Assistant) => { setItems((l) => (l.some((y) => y.id === x.id) ? l.map((y) => (y.id === x.id ? x : y)) : [...l, x])); setEdit(null) }
  const save = async () => { setSaving(true); try { await onSave({ v: 1, assistants: items, updated: new Date().toISOString(), updatedBy: who }); toast('good', 'Assistants saved for everyone.'); onClose() } catch (e) { toast('bad', `Could not save: ${(e as Error).message}`) } finally { setSaving(false) } }
  return (
    <Modal title="Assistant setup" onClose={onClose}>
      <div style={{ display: 'grid', gap: 12 }}>
        <div className={`banner ${connector ? 'info' : 'warn'}`} role="status"><Icon n={connector ? 'check' : 'info'} /><div style={{ flex: 1 }}>
          {connector ? <><b>Copilot Studio connector is attached.</b> Agents added as “Copilot Studio agent” chat right inside the app.</> : <><b>The Copilot Studio connector is not attached to this app.</b> To chat inside the app, re-run <code>Deploy.cmd</code> (it adds the connection) or run <code>pac code add-data-source -a shared_microsoftcopilotstudio -c &lt;connection id&gt;</code>, then republish. You can still add agents as <b>links</b> (Agent Builder / Microsoft 365 Copilot) now.</>}</div></div>

        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }} aria-label="Configured assistants">
          {items.length === 0 && <li className="muted">No assistants yet.</li>}
          {items.map((x) => (
            <li key={x.id} className="card row" style={{ padding: 10, gap: 10, flexWrap: 'wrap' }}>
              <Icon n="sparkle" size={18} />
              <div style={{ flex: 1, minWidth: 180 }}><b>{x.name}</b> <span className="pill">{x.kind === 'studio' ? 'Copilot Studio · in-app chat' : 'Link · opens agent'}</span>{!x.enabled && <span className="pill warn">off</span>}
                <div className="muted small">{x.kind === 'studio' ? x.agent : x.url} · {x.scope === 'all' ? 'all lists & libraries' : `${x.scope.length} source(s)`}</div></div>
              <button className="btn sm" onClick={() => setEdit(x)}>Edit</button>
              <button className="btn sm ghost" aria-label={`Remove ${x.name}`} onClick={() => setItems(items.filter((y) => y.id !== x.id))}><Icon n="trash" size={13} /></button>
            </li>
          ))}
        </ul>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={() => setEdit({ id: uid(), name: '', kind: 'studio', agent: '', prompts: [], scope: 'all', sendRows: true, enabled: true })}><Icon n="plus" size={14} />Add Copilot Studio agent</button>
          <button className="btn" onClick={() => setEdit({ id: uid(), name: '', kind: 'link', url: '', prompts: [], scope: 'all', sendRows: true, enabled: true })}><Icon n="plus" size={14} />Add Agent Builder / M365 Copilot link</button>
        </div>

        <details>
          <summary className="small"><b>Make your agent understand this app</b> (recommended)</summary>
          <p className="muted small">1) In Copilot Studio add this <b>knowledge source</b> so the agent can answer from the same data (users need access; agent must use “Authenticate with Microsoft”). 2) Paste the instructions into the agent so it reads the context the app sends.</p>
          <div className="row small" style={{ gap: 6, flexWrap: 'wrap' }}><code style={{ overflowWrap: 'anywhere' }}>{knowledge}</code><button className="btn sm" onClick={() => navigator.clipboard?.writeText(knowledge).then(() => toast('good', 'Knowledge URL copied'))}><Icon n="copy" size={12} />Copy URL</button></div>
          <textarea className="input" readOnly rows={8} style={{ width: '100%', marginTop: 6 }} value={AGENT_INSTRUCTIONS} aria-label="Agent instructions to paste" />
          <button className="btn sm" onClick={() => navigator.clipboard?.writeText(AGENT_INSTRUCTIONS).then(() => toast('good', 'Instructions copied'))}><Icon n="copy" size={12} />Copy instructions</button>
          <p className="muted small">Tip: use a classic (Standard) Copilot Studio agent, published and shared with your users. Add the SharePoint connector as a tool if you want the agent to act, not just answer.</p>
        </details>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={saving} onClick={() => void save()}><Icon n="check" size={15} />{saving ? 'Saving…' : 'Save for everyone'}</button></div>
      </div>
      {edit && <AssistantEditor engine={engine} a={edit} onSave={upsert} onClose={() => setEdit(null)} />}
    </Modal>
  )
}

function AssistantEditor({ engine, a, onSave, onClose }: { engine: Engine; a: Assistant; onSave: (a: Assistant) => void; onClose: () => void }) {
  const [d, setD] = useState<Assistant>(a)
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const set = (p: Partial<Assistant>) => { setD((x) => ({ ...x, ...p })); setTest(null) }
  const url = goodUrl(d.url)
  const hostOk = !!url && LINK_HOSTS.test(url.hostname)
  const valid = !!d.name.trim() && (d.kind === 'studio' ? !!d.agent?.trim() : !!url)
  const [steps, setSteps] = useState<{ ok: boolean | null; text: string }[]>([])
  const [found, setFound] = useState<{ name: string; schema: string }[] | null>(null)
  const [finding, setFinding] = useState(false)
  const [clock, setClock] = useState(0)
  useEffect(() => { if (!testing) return; const t0 = Date.now(), t = setInterval(() => setClock(Math.round((Date.now() - t0) / 1000)), 1000); return () => clearInterval(t) }, [testing])
  const findAgents = async () => {
    setFinding(true); setFound(null)
    try { setFound(await engine.backend.listAgents()); setTest(null) }
    catch (e) { setTest({ ok: false, text: `Could not list agents: ${(e as Error).message}` }) } finally { setFinding(false) }
  }
  const runTest = async () => {
    const name = d.agent!.trim(); setTesting(true); setClock(0); setTest(null)
    const out: { ok: boolean | null; text: string }[] = []; const push = (ok: boolean | null, text: string) => { out.push({ ok, text }); setSteps([...out]) }
    setSteps([])
    try {
      push(engine.backend.agentConnector(), engine.backend.agentConnector() ? 'Copilot Studio connector is attached to this app.' : 'The Copilot Studio connector is not attached to this app.')
      if (!engine.backend.agentConnector()) return
      try {   // fast check first: proves connection, consent and gateway work, and shows the exact agent names
        const list = await engine.backend.listAgents()
        setFound(list)
        const hit = list.find((x) => x.schema === name)
        push(list.length ? !!hit : null, list.length ? (hit ? `Your Copilot Studio connection sees “${hit.name || hit.schema}”.` : `Your connection sees ${list.length} agent(s) but none named “${name}”. Pick one from the list below (names are case-sensitive).`) : 'Connection works (the agent list was empty — the agent may not be published or shared with this connection).')
        if (list.length && !hit) return
      } catch (e) { push(false, `Could not reach Copilot Studio through the connector: ${(e as Error).message}`); return }
      const t0 = Date.now()
      const r = await Promise.race([engine.backend.askAgent(name, 'ping'), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('No answer after 150 s. The agent may be waiting for sign-in or input (set it to “Authenticate with Microsoft”), or the player timed out.')), 150_000))])
      push(true, `Agent answered in ${((Date.now() - t0) / 1000).toFixed(1)} s: “${r.text.slice(0, 120)}”${r.conversationId ? ' · multi-turn chat works' : ' · no conversation id returned (the app will carry short history itself)'}`)
      setTest({ ok: true, text: 'Connection works.' })
    } catch (e) { const x = e as Error & { status?: number; requestId?: string }; push(false, `${x.message}${x.status ? ` [HTTP ${x.status}${x.requestId ? `, request ${x.requestId}` : ''}]` : ''}`) } finally { setTesting(false) }
  }
  return (
    <Modal title={a.name ? 'Edit assistant' : d.kind === 'studio' ? 'Add Copilot Studio agent' : 'Add agent link'} onClose={onClose}>
      <form style={{ display: 'grid', gap: 12 }} onSubmit={(e) => { e.preventDefault(); if (valid) onSave({ ...d, name: d.name.trim(), agent: d.agent?.trim(), url: d.url?.trim(), prompts: d.prompts.filter(Boolean) }) }}>
        <label className="small">Display name<input className="input" value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={60} placeholder="e.g. HR Policy Helper" /></label>
        {d.kind === 'studio' ? <>
          <label className="small">Agent schema name <span className="muted">(Copilot Studio → Settings → Advanced → Metadata; case-sensitive)</span><input className="input" value={d.agent ?? ''} onChange={(e) => set({ agent: e.target.value })} placeholder="cr123_hrHelper" autoComplete="off" /></label>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn" disabled={finding} onClick={() => void findAgents()}><Icon n="search" size={14} />{finding ? 'Looking…' : 'Find my agents'}</button>
            <button type="button" className="btn" disabled={testing || !d.agent?.trim()} onClick={() => void runTest()}><Icon n="bolt" size={14} />{testing ? `Testing… ${clock}s` : 'Test connection'}</button>
          </div>
          {found && <ul className="feed" style={{ margin: 0, padding: 0, listStyle: 'none', maxHeight: 150, overflow: 'auto' }} aria-label="Agents your connection can see">{found.length === 0 ? <li className="muted">No agents found for this connection.</li> : found.map((f) => <li key={f.schema}><button type="button" className="btn ghost" style={{ width: '100%', textAlign: 'left' }} onClick={() => set({ agent: f.schema, name: d.name || f.name })}>{f.name || f.schema} <span className="muted small">· {f.schema}</span></button></li>)}</ul>}
          {steps.length > 0 && <div role="status" aria-live="polite" style={{ display: 'grid', gap: 4 }}>{steps.map((x, i) => <div key={i} className="small" style={{ color: x.ok === false ? 'var(--bad)' : x.ok ? 'var(--good)' : 'var(--muted)' }}>{x.ok === false ? '✖ ' : x.ok ? '✔ ' : '• '}{x.text}</div>)}</div>}
          {test && !test.ok && <div className="small" style={{ color: 'var(--bad)' }} role="alert">{test.text}</div>}
        </> : <>
          <label className="small">Agent chat link <span className="muted">(Agent Builder: hover the agent → More → Share → copy the link; or a Copilot Studio web-chat / Teams link)</span><input className="input" type="url" value={d.url ?? ''} onChange={(e) => set({ url: e.target.value })} placeholder="https://m365.cloud.microsoft/chat/…" /></label>
          {d.url && !url && <div className="small" style={{ color: 'var(--bad)' }}>Enter a full https:// link.</div>}
          {url && !hostOk && <div className="small" style={{ color: 'var(--warn)' }}>This host isn’t a known Microsoft Copilot address ({url.hostname}). Make sure it is the link you meant to share.</div>}
          {hostOk && <div className="small" style={{ color: 'var(--good)' }}>✔ Looks like a valid Microsoft Copilot link.</div>}
        </>}
        <label className="small">What is it good for? (shown to users)<input className="input" value={d.description ?? ''} onChange={(e) => set({ description: e.target.value })} maxLength={200} /></label>
        <label className="small">Suggested prompts (one per line)<textarea className="input" rows={3} value={d.prompts.join('\n')} onChange={(e) => set({ prompts: e.target.value.split('\n').slice(0, 6) })} /></label>
        <label className="small">Extra instructions sent with every question <span className="muted">(optional)</span><textarea className="input" rows={2} value={d.instructions ?? ''} onChange={(e) => set({ instructions: e.target.value })} maxLength={600} /></label>
        <label className="small">Available for
          <select className="input" value={d.scope === 'all' ? 'all' : 'this'} onChange={(e) => set({ scope: e.target.value === 'all' ? 'all' : [engine.src.id] })}><option value="all">All connected lists &amp; libraries</option><option value="this">Only “{engine.src.label}”</option></select></label>
        <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={d.sendRows} onChange={(e) => set({ sendRows: e.target.checked })} />Send the selected items’ data (titles and key columns) to the agent</label>
        <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} />Enabled</label>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn primary" disabled={!valid}>Save assistant</button></div>
      </form>
    </Modal>
  )
}
