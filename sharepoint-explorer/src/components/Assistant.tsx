import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AGENT_INSTRUCTIONS, buildContext, withContext } from '../assistantContext'
import type { Engine } from '../engine'
import type { AgentReply, Assistant, AssistantConfig, BotInfo, Row } from '../types'
import { uid } from '../util'
import { copyText } from '../mail'
import { Icon, Modal, useToast } from './ui'

const LINK_HOSTS = /(^|\.)((copilotstudio|powerva)\.microsoft\.com|m365\.cloud\.microsoft|copilot\.cloud\.microsoft|copilot\.microsoft\.com|microsoft365\.com|office\.com|sharepoint\.com|copilotstudio\.preview\.microsoft\.com|outlook\.cloud\.microsoft|teams\.microsoft\.com|teams\.cloud\.microsoft|powerplatform\.com|directline\.botframework\.com)$/i
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
export function AssistantPanel({ visible, engine, cfg, who, selected, canSetup, onSetup, onClose }: { visible?: string[]; engine: Engine; cfg: AssistantConfig | null; who: { name: string; upn: string }; selected: Row[]; canSetup: boolean; onSetup: () => void; onClose: () => void }) {
  const toast = useToast()
  const list = (cfg?.assistants ?? []).filter((a) => inScope(a, engine.src.id))
  const [aid, setAid] = useState(list[0]?.id)
  const a = list.find((x) => x.id === aid) ?? list[0]
  const key = `${a?.id}:${engine.src.id}`
  const [, force] = useState(0)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [withCtx, setWithCtx] = useState(true)
  const [manual, setManual] = useState('')
  const log = useRef<HTMLDivElement>(null)
  const chat = chats.get(key) ?? { msgs: [] }
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }) }, [chat.msgs.length, busy])

  const ctxJson = () => buildContext(engine, who, selected, { sendRows: !!a?.sendRows && withCtx, instructions: a?.instructions, columns: visible })
  const send = async (q: string) => {
    const question = q.trim(); if (!question || !a || busy) return
    const c = chats.get(key) ?? { msgs: [] }; chats.set(key, c)
    c.msgs.push({ role: 'user', text: question, at: Date.now() }); setText(''); setBusy(true); force((n) => n + 1)
    try {
      const hist = !c.conv && c.msgs.length > 2 ? `Earlier in this chat:\n${c.msgs.slice(-7, -1).filter((m) => m.role !== 'error').map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text.slice(0, 400)}`).join('\n')}\n\n` : ''   // carried by the app only when the agent returned no conversation id
      const msg = withCtx ? withContext(ctxJson(), hist + question) : hist + question
      let r: AgentReply
      try { r = await engine.backend.askAgent(a.agent ?? '', msg, c.conv, { kind: a.kind, environmentId: a.environmentId }) }
      catch (e) { if (!c.conv) throw e; c.conv = undefined; r = await engine.backend.askAgent(a.agent ?? '', msg, undefined, { kind: a.kind, environmentId: a.environmentId }) }   // an expired conversation: start a fresh one once
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
            {manual && <textarea className="input" readOnly rows={5} value={manual} aria-label="Prompt to copy" onFocus={(e) => e.currentTarget.select()} />}
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button className="btn" onClick={async () => { const t = withContext(ctxJson(), text || 'Help me with this.'); if (await copyText(t)) toast('good', 'Prompt with context copied — paste it into the agent chat.'); else { setManual(t); toast('warn', 'Could not copy automatically — select the text below and press Ctrl+C.') } }}><Icon n="copy" size={14} />Copy prompt with context</button>
              {goodUrl(a.url) ? <a className="btn primary" href={goodUrl(a.url)!.href} target="_blank" rel="noopener noreferrer"><Icon n="ext" size={14} />Open {a.name}</a> : <button className="btn primary" disabled title="The saved link is not a valid https:// URL"><Icon n="ext" size={14} />Open {a.name}</button>}
            </div>
          </div>
        ) : (
          <>
            <div ref={log} className="chatlog" role="log" aria-live="polite" aria-label="Conversation" style={{ overflow: 'auto', display: 'grid', gap: 8, alignContent: 'start', maxHeight: '58vh' }}>
              {chat.msgs.length === 0 && <div className="muted small" style={{ padding: 6 }}>{a.description || `Ask ${a.name} about this ${engine.src.isLibrary ? 'library' : 'list'}.`}</div>}
              {chat.msgs.map((m, i) => (
                <div key={i} className={`bubble ${m.role}`}>
                  {m.role === 'agent' ? <Md text={m.text} /> : <span style={{ whiteSpace: 'pre-wrap' }}>{m.text}</span>}
                  {m.role === 'agent' && <button className="btn sm ghost" aria-label="Copy answer" onClick={() => void copyText(m.text).then((ok) => toast(ok ? 'good' : 'warn', ok ? 'Answer copied' : 'Could not copy — select the text and press Ctrl+C'))}><Icon n="copy" size={12} /></button>}
                </div>
              ))}
              {busy && <div className="bubble agent" role="status" aria-label="The agent is typing"><span className="typing"><i /><i /><i /></span></div>}
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{suggestions.map((s) => <button key={s} className="btn sm" disabled={busy} onClick={() => void send(s)}>{s}</button>)}</div>
              <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={withCtx} onChange={(e) => setWithCtx(e.target.checked)} />Tell the agent what I’m looking at ({engine.src.label}{sel ? `, ${sel} selected` : ''}{a.sendRows ? '' : ' — item data is not sent'})</label>
              <form className="row" style={{ gap: 6, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); void send(text) }}>
                <textarea className="input" style={{ flex: 1 }} rows={2} aria-label="Message to the assistant" value={text} placeholder="Ask anything…" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(text) } }} />
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
  const [envBase, setEnvBase] = useState('')
  useEffect(() => { void engine.backend.envId().then((e) => { const h = e.replace(/-/g, '').toLowerCase(); setEnvBase(`https://${h.slice(0, -2)}.${h.slice(-2)}.environment.api.powerplatform.com`) }).catch(() => {}) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const knowledge = engine.src.url ? new URL(engine.src.url, engine.src.siteUrl).href : engine.src.siteUrl.replace(/\/$/, '')
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
              <div style={{ flex: 1, minWidth: 180 }}><b>{x.name}</b> <span className="pill">{x.kind === 'entra-http' ? 'Copilot Studio · in-app chat (any agent)' : x.kind === 'studio' ? 'Classic agent · connector chat' : 'Link · opens agent'}</span>{!x.enabled && <span className="pill warn">off</span>}
                <div className="muted small">{x.kind === 'link' ? x.url : x.agent} · {x.scope === 'all' ? 'all lists & libraries' : `${x.scope.length} source(s)`}</div></div>
              <button className="btn sm" onClick={() => setEdit(x)}>Edit</button>
              <button className="btn sm ghost" aria-label={`Remove ${x.name}`} onClick={() => setItems(items.filter((y) => y.id !== x.id))}><Icon n="trash" size={13} /></button>
            </li>
          ))}
        </ul>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={() => setEdit({ id: uid(), name: '', kind: 'entra-http', agent: '', environmentId: '', prompts: [], scope: 'all', sendRows: true, enabled: true })}><Icon n="plus" size={14} />Add Copilot Studio agent (new or classic)</button>
          <button className="btn" onClick={() => setEdit({ id: uid(), name: '', kind: 'studio', agent: '', prompts: [], scope: 'all', sendRows: true, enabled: true })}><Icon n="plus" size={14} />Add classic agent (connector)</button>
          <button className="btn" onClick={() => setEdit({ id: uid(), name: '', kind: 'link', url: '', prompts: [], scope: 'all', sendRows: true, enabled: true })}><Icon n="plus" size={14} />Add Agent Builder / M365 Copilot link</button>
        </div>

        <details>
          <summary className="small"><b>Chat with a NEW-experience Copilot Studio agent</b> (Skills / Connected agents, no Topics)</summary>
          <ol className="small" style={{ margin: '6px 0 0', paddingLeft: 20, display: 'grid', gap: 4 }}>
            <li><b>Tenant admin, once:</b> run <code>scripts\Grant-CopilotStudioAccess.ps1</code> (PowerShell 7, Global Administrator). It lets Microsoft’s “HTTP with Microsoft Entra ID” connector call Copilot Studio. The <i>preauthorized</i> connector can never do this (Copilot Studio answers 403 InsufficientDelegatedPermissions).</li>
            <li>In Power Apps → <b>Connections → New connection</b> choose <b>HTTP with Microsoft Entra ID</b> (not “preauthorized”). Microsoft Entra ID Resource URI: <code>https://api.powerplatform.com</code> · Base Resource URL: <code style={{ overflowWrap: 'anywhere' }}>{envBase || 'https://<environment host>'}</code>.{envBase && <> <button type="button" className="btn sm" onClick={() => void copyText(envBase).then((ok) => toast(ok ? 'good' : 'warn', ok ? 'Base URL copied' : 'Could not copy'))}><Icon n="copy" size={12} />Copy</button></>}</li>
            <li>Run <code>Deploy.cmd -AddEntraHttp</code> (or <code>pac code add-data-source -a shared_webcontents -c &lt;connection id&gt;</code>) and republish. Each user approves the connection once.</li>
            <li>Click <b>Add Copilot Studio agent (new or classic)</b> above: Environment ID + schema name from Copilot Studio → Settings → Advanced → Metadata.</li>
            <li>The agent must be <b>published</b> with Authentication = <b>Authenticate with Microsoft</b>. Microsoft is rolling out support for new-experience agents through the end of October 2026, so a “not supported yet” message can appear until your region has it. If you get 403 InsufficientDelegatedPermissions, the admin step above has not been done (or the connection is older than the grant: create a new one).</li>
          </ol>
        </details>
        <details>
          <summary className="small"><b>Make your agent understand this app</b> (recommended)</summary>
          <p className="muted small">1) In Copilot Studio add this <b>knowledge source</b> so the agent can answer from the same data (users need access; agent must use “Authenticate with Microsoft”). 2) Paste the instructions into the agent so it reads the context the app sends.</p>
          <div className="row small" style={{ gap: 6, flexWrap: 'wrap' }}><code style={{ overflowWrap: 'anywhere' }}>{knowledge}</code><button className="btn sm" onClick={() => void copyText(knowledge).then((ok) => toast(ok ? 'good' : 'warn', ok ? 'Knowledge URL copied' : 'Could not copy — select the URL and press Ctrl+C'))}><Icon n="copy" size={12} />Copy URL</button></div>
          <textarea className="input" readOnly rows={8} style={{ width: '100%', marginTop: 6 }} value={AGENT_INSTRUCTIONS} aria-label="Agent instructions to paste" />
          <button className="btn sm" onClick={() => void copyText(AGENT_INSTRUCTIONS).then((ok) => toast(ok ? 'good' : 'warn', ok ? 'Instructions copied' : 'Could not copy — select the text and press Ctrl+C'))}><Icon n="copy" size={12} />Copy instructions</button>
          <p className="muted small">Tip: use a classic (Standard) Copilot Studio agent, published and shared with your users. Add the SharePoint connector as a tool if you want the agent to act, not just answer.</p>
        </details>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={saving} onClick={() => void save()}><Icon n="check" size={15} />{saving ? 'Saving…' : 'Save for everyone'}</button></div>
      </div>
      {edit && <AssistantEditor engine={engine} a={edit} onSave={upsert} onClose={() => setEdit(null)} />}
    </Modal>
  )
}

function AssistantEditor({ engine, a, onSave, onClose }: { engine: Engine; a: Assistant; onSave: (a: Assistant) => void; onClose: () => void }) {
  const [envBase, setEnvBase] = useState('')
  useEffect(() => { void engine.backend.envId().then((e) => { const h = e.replace(/-/g, '').toLowerCase(); setEnvBase(`https://${h.slice(0, -2)}.${h.slice(-2)}.environment.api.powerplatform.com`) }).catch(() => {}) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const [d, setD] = useState<Assistant>(a)
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const set = (p: Partial<Assistant>) => { setD((x) => ({ ...x, ...p })); setTest(null) }
  const url = goodUrl(d.url)
  const hostOk = !!url && LINK_HOSTS.test(url.hostname)
  const envOk = /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(d.environmentId?.trim() ?? '')
  const valid = !!d.name.trim() && (d.kind === 'studio' ? !!d.agent?.trim() : d.kind === 'entra-http' ? !!d.agent?.trim() && envOk : !!url)
  useEffect(() => { if (d.kind === 'entra-http' && !d.environmentId) void engine.backend.envId().then((e) => setD((x) => (x.environmentId ? x : { ...x, environmentId: e }))).catch(() => {}) }, []) // eslint-disable-line react-hooks/exhaustive-deps
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
    if (d.kind === 'entra-http') {
      try {
        const has = engine.backend.agentConnector('entra-http')
        push(has, has ? 'The “HTTP with Microsoft Entra ID” connector is attached to this app.' : 'The “HTTP with Microsoft Entra ID” connector is not attached to this app (see the setup steps above).')
        if (!has) return
        push(true, await engine.backend.probeAgent(d.environmentId!.trim(), name))
        const t0 = Date.now()
        const r = await Promise.race([engine.backend.askAgent(name, 'ping', undefined, { kind: 'entra-http', environmentId: d.environmentId!.trim() }), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('No answer after 150 s.')), 150_000))])
        push(true, `Agent answered in ${((Date.now() - t0) / 1000).toFixed(1)} s: “${r.text.slice(0, 120)}”`)
        setTest({ ok: true, text: 'Connection works.' })
      } catch (e) { push(false, (e as Error).message) } finally { setTesting(false) }
      return
    }
    try {
      push(engine.backend.agentConnector(), engine.backend.agentConnector() ? 'Copilot Studio connector is attached to this app.' : 'The Copilot Studio connector is not attached to this app.')
      if (!engine.backend.agentConnector()) return
      try {   // fast check first: proves connection, consent and gateway work, and shows the exact agent names
        const list = await engine.backend.listAgents()
        setFound(list)
        const hit = list.find((x) => x.schema === name)
        push(list.length ? !!hit : null, list.length ? (hit ? `Your Copilot Studio connection sees “${hit.name || hit.schema}”.` : `Your connection sees ${list.length} agent(s) but none named “${name}”. Pick one from the list below (names are case-sensitive).`) : 'Connection works, but it sees NO classic agents. If your agent was built in the new Copilot Studio experience (left menu shows Skills / Connected agents / Authoring canvas, no Topics) the Copilot Studio connector cannot call it — Microsoft confirms this limitation. Trying the name you typed anyway…')
        if (list.length && !hit) return
      } catch (e) { push(false, `Could not reach Copilot Studio through the connector: ${(e as Error).message}`); return }
      const t0 = Date.now()
      const r = await Promise.race([engine.backend.askAgent(name, 'ping'), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('No answer after 150 s. The agent may be waiting for sign-in or input (set it to “Authenticate with Microsoft”), or the player timed out.')), 150_000))])
      push(true, `Agent answered in ${((Date.now() - t0) / 1000).toFixed(1)} s: “${r.text.slice(0, 120)}”${r.conversationId ? ' · multi-turn chat works' : ' · no conversation id returned (the app will carry short history itself)'}`)
      setTest({ ok: true, text: 'Connection works.' })
    } catch (e) { const x = e as Error & { status?: number; requestId?: string }; if (/not found|404/i.test(x.message)) push(null, 'Most likely cause: this is a new-experience (GitHub Copilot harness) agent. Fix: create a classic (standard) agent in Copilot Studio, publish it, set Authentication to “Authenticate with Microsoft”, then press Find my agents. Or add this agent as a link instead.'); push(false, `${x.message}${x.status ? ` [HTTP ${x.status}${x.requestId ? `, request ${x.requestId}` : ''}]` : ''}`) } finally { setTesting(false) }
  }
  return (
    <Modal title={a.name ? 'Edit assistant' : d.kind === 'entra-http' ? 'Add Copilot Studio agent' : d.kind === 'studio' ? 'Add classic agent (connector)' : 'Add agent link'} onClose={onClose}>
      <form style={{ display: 'grid', gap: 12 }} onSubmit={(e) => { e.preventDefault(); if (valid) onSave({ ...d, name: d.name.trim(), agent: d.agent?.trim(), environmentId: d.environmentId?.trim(), url: d.url?.trim(), prompts: d.prompts.filter(Boolean) }) }}>
        <label className="small">Display name<input className="input" value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={60} placeholder="e.g. HR Policy Helper" /></label>
        {d.kind === 'entra-http' ? <>
          <div className="banner info small" role="note"><Icon n="info" /><div style={{ flex: 1 }}>Works with <b>new and classic</b> Copilot Studio agents. The agent must be <b>published</b> and set to <b>Authenticate with Microsoft</b>. Needs the “HTTP with Microsoft Entra ID” connector plus a one-time admin permission grant (see the notes in Setup). Each user approves that connection once.</div></div>
          <AgentPicker engine={engine} schema={d.agent} onPick={(b) => set({ agent: b.schema, name: d.name || b.name })} />
          <label className="small">Environment ID <span className="muted">(Copilot Studio → Settings → Advanced → Metadata → Environment ID; this app’s own environment is filled in)</span><input className="input" value={d.environmentId ?? ''} onChange={(e) => set({ environmentId: e.target.value })} placeholder="e4c5fd77-2cb4-e3d1-8488-75cd3bd8521b" autoComplete="off" /></label>
          {!engine.backend.agentConnector('entra-http') && <div className="banner warn small" role="note"><Icon n="info" /><div style={{ flex: 1 }}><b>One-time setup needed before this can work:</b> the “HTTP with Microsoft Entra ID” connection is not attached to this app yet.<ol style={{ margin: '4px 0 0', paddingLeft: 18 }}><li>Admin once: run <code>scripts\Grant-CopilotStudioAccess.ps1</code>. Then Power Apps → Connections → New connection → <b>HTTP with Microsoft Entra ID</b> (not preauthorized), Base Resource URL <code style={{ overflowWrap: 'anywhere' }}>{envBase || 'https://<environment host>'}</code>, Entra ID Resource URI <code>https://api.powerplatform.com</code>.</li><li>Run <code>Deploy.cmd</code> and answer <b>2</b> to the AI question (or <code>Deploy.cmd -AddEntraHttp</code>), then reopen the app.</li></ol></div></div>}
          {d.environmentId && !envOk && <div className="small" style={{ color: 'var(--bad)' }}>That is not a valid environment ID (a GUID).</div>}
          <label className="small">Agent schema name <span className="muted">(same Metadata page → Schema name; case-sensitive)</span><input className="input" value={d.agent ?? ''} onChange={(e) => set({ agent: e.target.value })} placeholder="cr56c_spocode" autoComplete="off" /></label>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn" disabled={testing || !d.agent?.trim() || !envOk} onClick={() => void runTest()}><Icon n="bolt" size={14} />{testing ? `Testing… ${clock}s` : 'Test connection'}</button>
          </div>
          {steps.length > 0 && <div role="status" aria-live="polite" style={{ display: 'grid', gap: 4 }}>{steps.map((x, i) => <div key={i} className="small" style={{ color: x.ok === false ? 'var(--bad)' : x.ok ? 'var(--good)' : 'var(--muted)' }}>{x.ok === false ? '✖ ' : x.ok ? '✔ ' : '• '}{x.text}</div>)}</div>}
        </> : d.kind === 'studio' ? <>
          <label className="small">Agent schema name <span className="muted">(Copilot Studio → Settings → Advanced → Metadata; case-sensitive)</span><input className="input" value={d.agent ?? ''} onChange={(e) => set({ agent: e.target.value })} placeholder="cr123_hrHelper" autoComplete="off" /></label>
          <AgentPicker engine={engine} schema={d.agent} onPick={(b) => set({ agent: b.schema, name: d.name || b.name })} />
          <div className="banner info small" role="note"><Icon n="info" /><div style={{ flex: 1 }}>Works with <b>classic (standard) Copilot Studio agents</b> that are published. Agents from the newer experience (Skills / Connected agents / Authoring canvas, no Topics) can’t be called by Microsoft’s connector yet — add those as a <b>link</b> instead. <a href="https://github.com/microsoft/PowerAppsCodeApps/discussions/434" target="_blank" rel="noreferrer noopener">Details</a></div></div>
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
          <select className="input" value={d.scope === 'all' ? 'all' : 'this'} onChange={(e) => set({ scope: e.target.value === 'all' ? 'all' : [engine.src.id] })}><option value="all">All connected lists &amp; libraries</option><option value="this">{d.scope !== 'all' && !d.scope.includes(engine.src.id) ? `Only ${d.scope.length} other source(s) (re-select to use “${engine.src.label}”)` : `Only “${engine.src.label}”`}</option></select></label>
        <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={d.sendRows} onChange={(e) => set({ sendRows: e.target.checked })} />Send the selected items’ data (titles and key columns) to the agent</label>
        <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} />Enabled</label>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn primary" disabled={!valid}>Save assistant</button></div>
      </form>
    </Modal>
  )
}

/** Drop-down of the agents that exist in this environment (Dataverse `bot` table). Falls back to a hint when the table is not attached. */
function AgentPicker({ engine, schema, onPick }: { engine: Engine; schema?: string; onPick: (b: BotInfo) => void }) {
  const has = engine.backend.botSource()
  const [bots, setBots] = useState<BotInfo[] | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { if (has) engine.backend.listBots().then(setBots).catch((e) => { setErr((e as Error).message); setBots([]) }) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  if (!has) return <div className="banner info small" role="note"><Icon n="info" /><div style={{ flex: 1 }}>Want a drop-down of the agents in your environment? Run <code>Deploy.cmd</code> and choose option 2 or 3 (it adds the Dataverse “bot” table), or <code>pac code add-data-source -a dataverse -t bot</code>. Until then type the schema name below.</div></div>
  return (
    <label className="small">Choose an agent from this environment
      <select className="input" value={bots?.some((b) => b.schema === schema) ? schema : ''} disabled={bots === null} onChange={(e) => { const b = bots?.find((x) => x.schema === e.target.value); if (b) onPick(b) }}>
        <option value="">{bots === null ? 'Loading agents…' : bots.length ? 'Select an agent…' : 'No agents found'}</option>
        {(bots ?? []).map((b) => <option key={b.id} value={b.schema}>{b.name} — {b.schema}{b.newExperience ? ' · new experience' : ''}{b.published ? '' : ' · not published yet'}</option>)}
      </select>
      {err && <span className="small" style={{ color: 'var(--bad)' }} role="alert">{err}</span>}
    </label>
  )
}
