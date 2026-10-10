/**
 * Credential Blast-Radius Map - pure graph engine (no network; unit-testable; works on Exposure Auditor scan output).
 *
 * Model (defensive): who can ACT THROUGH whose stored connector credentials?
 *   user --edits/views--> flow|app --uses--> connection --reaches--> data surface
 *   user --canUse-------> connection                          (creator / people the connection is shared with)
 *   connection --actsAs--> creator user   ONLY for control-plane connectors (Power Platform / Power Automate admin, Entra ...):
 *                                          those credentials can grant themselves more access, so the chain continues.
 * Every other connector is a leaf: using Outlook as Alex reaches Alex's mailbox, not Alex's other permissions.
 * Groups are opaque (membership needs a Graph app registration) and are reported, never treated as safe.
 */
import type { Principal, Resource, Severity } from '../exposure/types'

export type NodeKind = 'user' | 'flow' | 'app' | 'connection' | 'surface'
export type EdgeType = 'edits' | 'views' | 'uses' | 'canUse' | 'actsAs' | 'reaches'
export interface GNode { id: string; kind: NodeKind; label: string; sub?: string; ptype?: Principal['type']; disabled?: boolean; sens?: number; connector?: string; res?: Resource }
export interface GEdge { from: string; to: string; type: EdgeType; w: number }
export interface Graph { nodes: Map<string, GNode>; out: Map<string, GEdge[]>; inn: Map<string, GEdge[]> }

/** Connectors whose credentials can change who has access (so a chain can continue through them). */
const CONTROL = /^shared_(powerappsforadmins|powerplatformforadmins|powerplatformadminv2|flowmanagement|microsoftflowforadmins|powerappsforappmakers|powerplatformforappmakers|azuread|office365groups|commondataserviceforapps|webcontents|http|httpwithazuread)$/i
const SENS5 = /^shared_(sql|sqlserver|commondataserviceforapps|azuread|http|httpwithazuread|webcontents|azurekeyvault|powerappsforadmins|powerplatformforadmins|powerplatformadminv2|flowmanagement|microsoftflowforadmins|azureblob|azuretables)$/i
const SENS4 = /^shared_(office365|office365users|sharepointonline|onedriveforbusiness|onedrive|outlook|gmail|excelonlinebusiness|office365groups)$/i
const SENS2 = /^shared_(teams|planner|todo|approvals|microsoftforms|wunderlist)$/i
export const sensitivity = (c = '') => (SENS5.test(c) ? 5 : SENS4.test(c) ? 4 : SENS2.test(c) ? 2 : 1)
export const isControlPlane = (c = '') => CONTROL.test(c)
const SURFACE: Record<string, string> = { shared_office365: 'mailbox & calendar', shared_sharepointonline: 'SharePoint sites', shared_onedriveforbusiness: 'OneDrive files', shared_sql: 'SQL databases', shared_commondataserviceforapps: 'Dataverse data', shared_teams: 'Teams chats & channels', shared_office365users: 'directory profiles', shared_azuread: 'Entra directory' }
export const surfaceName = (c = '') => SURFACE[c.toLowerCase()] ?? `${c.replace(/^shared_/, '')} data`

const uid = (p: Principal) => (p.type === 'Tenant' ? 'u:tenant' : `u:${p.id.toLowerCase()}`)

export function buildGraph(resources: Resource[]): Graph {
  const g: Graph = { nodes: new Map(), out: new Map(), inn: new Map() }
  const edge = (from: string, to: string, type: EdgeType, w: number) => {
    if (from === to) return
    const e = { from, to, type, w }
    if ((g.out.get(from) ?? []).some((x) => x.to === to && x.type === type)) return
    g.out.set(from, [...(g.out.get(from) ?? []), e]); g.inn.set(to, [...(g.inn.get(to) ?? []), e])
  }
  const names = new Map<string, Principal>()
  const seen = (p?: Principal) => { if (p?.id) { const k = uid(p); const old = names.get(k); if (!old || (old.name === old.id && p.name && p.name !== p.id) || (old.enabled == null && p.enabled != null)) names.set(k, { ...old, ...p }) } }
  resources.forEach((r) => { seen(r.owner); r.shares.forEach((s) => seen(s.principal)) })
  const user = (p: Principal): string => {
    const id = uid(p); const k = names.get(id) ?? p
    if (!g.nodes.has(id)) g.nodes.set(id, { id, kind: 'user', label: k.type === 'Tenant' ? 'Everyone in the organisation' : (k.name && k.name !== k.id ? k.name : k.email ?? k.id), sub: k.email, ptype: k.type, disabled: k.enabled === false })
    return id
  }
  for (const r of resources) {
    const rid = r.key
    g.nodes.set(rid, { id: rid, kind: r.kind === 'connection' ? 'connection' : r.kind, label: r.name, sub: r.envName, connector: r.connector, sens: r.kind === 'connection' ? sensitivity(r.connector) : undefined, res: r })
    if (r.kind === 'connection') {
      const sid = `s:${rid}`
      g.nodes.set(sid, { id: sid, kind: 'surface', label: surfaceName(r.connector), sub: r.owner?.name ?? r.owner?.email, sens: sensitivity(r.connector) })
      edge(rid, sid, 'reaches', 1)
      if (r.owner) { const o = user(r.owner); edge(o, rid, 'canUse', 1); if (isControlPlane(r.connector)) edge(rid, o, 'actsAs', 1) }
      r.shares.forEach((s) => edge(user(s.principal), rid, 'canUse', 0.9))
    } else {
      if (r.owner) edge(user(r.owner), rid, 'edits', 1)
      for (const s of r.shares) {
        const strong = /edit|owner/i.test(s.role)
        edge(user(s.principal), rid, strong ? 'edits' : 'views', strong ? 1 : r.kind === 'flow' ? 0.4 : 0.3)
      }
      for (const cid of r.uses ?? []) { const ck = `connection:${r.envId}:${cid}`; if (resources.some((x) => x.key === ck)) edge(rid, ck, 'uses', 1) }
    }
  }
  return g
}

export interface Reach { depth: number; strength: number; prev?: GEdge }
/** Breadth-first reachability. forward = what the seed can act through; reverse = who can reach the seed. */
export function traverse(g: Graph, seed: string, reverse = false, maxDepth = 8): Map<string, Reach> {
  const res = new Map<string, Reach>([[seed, { depth: 0, strength: 1 }]])
  let frontier = [seed]
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const next: string[] = []
    for (const n of frontier) for (const e of (reverse ? g.inn : g.out).get(n) ?? []) {
      const to = reverse ? e.from : e.to
      if (res.has(to)) continue
      res.set(to, { depth: d, strength: Math.min(res.get(n)!.strength, e.w), prev: e }); next.push(to)
    }
    frontier = next
  }
  return res
}
export function pathTo(g: Graph, reach: Map<string, Reach>, id: string, reverse = false): string[] {
  const p = [id]
  for (let r = reach.get(id); r?.prev; r = reach.get(p[p.length - 1])) p.push(reverse ? r.prev.to : r.prev.from)
  return reverse ? p : p.reverse() // reverse mode reads: reacher -> ... -> seed
}
const hops = (g: Graph, path: string[]) => path.filter((id) => g.nodes.get(id)?.kind === 'user').length - 1

/** Blast radius of a user: sum over the connections reachable through their access of sensitivity x path strength (x1.5 when the credential's owner is disabled = unmonitored). */
export function blast(g: Graph, userId: string) {
  const reach = traverse(g, userId)
  let score = 0
  const conns: { node: GNode; r: Reach; path: string[] }[] = []
  for (const [id, r] of reach) {
    const n = g.nodes.get(id)!
    if (n.kind !== 'connection') continue
    const owner = n.res?.owner; const dead = owner?.enabled === false
    score += (n.sens ?? 1) * r.strength * (dead ? 1.5 : 1)
    conns.push({ node: n, r, path: pathTo(g, reach, id) })
  }
  return { reach, score: Math.round(score * 10) / 10, conns: conns.sort((a, b) => (b.node.sens ?? 0) - (a.node.sens ?? 0)) }
}
export const topUsers = (g: Graph, n = 10) =>
  [...g.nodes.values()].filter((x) => x.kind === 'user' && x.ptype !== 'Tenant').map((u) => ({ user: u, ...blast(g, u.id) })).sort((a, b) => b.score - a.score).slice(0, n)

export interface BFinding { id: string; rule: string; severity: Severity; title: string; detail: string; nodeId: string; path?: string[] }

/** Global findings, computed by walking BACKWARDS from each sensitive connection to everyone who can reach it. */
export function blastFindings(g: Graph, fanoutMax = 5): BFinding[] {
  const out: BFinding[] = []
  const label = (id: string) => g.nodes.get(id)?.label ?? id
  for (const n of g.nodes.values()) {
    if (n.kind !== 'connection') continue
    const owner = n.res?.owner
    const back = traverse(g, n.id, true)
    const creatorId = owner ? uid(owner) : ''
    const reachers = [...back].filter(([id]) => g.nodes.get(id)?.kind === 'user' && id !== creatorId)
    const via = (id: string) => pathTo(g, back, id, true)
    const chained = reachers.filter(([id]) => via(id).some((p) => g.nodes.get(p)?.kind === 'connection' && p !== n.id))
    const ref = n.id
    const users = reachers.filter(([id]) => g.nodes.get(id)?.ptype !== 'Tenant')
    if ((n.sens ?? 1) >= 5 && reachers.length)
      out.push({ id: `PRIV_REACH:${ref}`, rule: 'PRIV_REACH', severity: 'High', nodeId: n.id, title: `${reachers.length} other account(s) can act through a privileged ${n.connector?.replace(/^shared_/, '')} credential`,
        detail: `${n.label} (${n.sub}) runs as ${owner?.name ?? owner?.email ?? 'its creator'}; reachable by ${users.slice(0, 4).map(([id]) => label(id)).join(', ')}${users.length > 4 ? '…' : ''}${reachers.some(([id]) => g.nodes.get(id)?.ptype === 'Tenant') ? ' and EVERYONE' : ''}.`, path: via(reachers[0][0]) })
    for (const [id] of chained.slice(0, 3)) {
      const p = via(id)
      out.push({ id: `CHAIN:${ref}:${id}`, rule: 'CHAIN', severity: 'High', nodeId: n.id, title: 'Escalation chain through a control-plane credential',
        detail: `${p.map(label).join(' → ')}. A credential that can change permissions hands over everything its owner can reach.`, path: p })
    }
    const g1 = reachers.find(([id]) => g.nodes.get(id)?.ptype === 'Guest')
    if (g1) out.push({ id: `GUEST_REACH:${ref}`, rule: 'GUEST_REACH', severity: 'High', nodeId: n.id, title: 'An external guest can act through this credential', detail: `${label(g1[0])} reaches ${n.label} (${n.sub}) via ${via(g1[0]).slice(1, -1).map(label).join(' → ') || 'direct share'}.`, path: via(g1[0]) })
    const used = (g.inn.get(n.id) ?? []).filter((e) => e.type === 'uses')
    if (owner?.enabled === false && used.length)
      out.push({ id: `DEAD_OWNER:${ref}`, rule: 'DEAD_OWNER_IN_USE', severity: 'High', nodeId: n.id, title: 'Disabled account\'s credential still powers live automation', detail: `${n.label} belongs to ${owner.name ?? owner.email} (disabled/deleted) and is used by ${used.map((e) => label(e.from)).slice(0, 3).join(', ')}${used.length > 3 ? '…' : ''}. Nobody is watching this identity.` })
    if (used.length >= fanoutMax)
      out.push({ id: `FANOUT:${ref}`, rule: 'CRED_FANOUT', severity: 'Medium', nodeId: n.id, title: `One credential powers ${used.length} flows/apps`, detail: `${n.label} (${n.sub}) - compromising or revoking it affects all of them.` })
    if (reachers.some(([id]) => g.nodes.get(id)?.kind === 'user' && g.nodes.get(id)?.ptype === 'Group'))
      out.push({ id: `GROUP:${ref}`, rule: 'UNRESOLVED_GROUP', severity: 'Info', nodeId: n.id, title: 'Reachable through a group (membership unknown)', detail: `Group membership needs a Graph app registration, so the real reach of ${n.label} may be wider than shown.` })
  }
  const order = { High: 0, Medium: 1, Low: 2, Info: 3 } as const
  return out.sort((a, b) => order[a.severity] - order[b.severity])
}

/** What happens if `userId` is disabled today. */
export function offboarding(g: Graph, userId: string) {
  const mine = [...g.nodes.values()].filter((n) => n.kind === 'connection' && n.res?.owner && uid(n.res.owner) === userId)
  const breaks = new Map<string, GNode>()
  mine.forEach((c) => (g.inn.get(c.id) ?? []).filter((e) => e.type === 'uses').forEach((e) => breaks.set(e.from, g.nodes.get(e.from)!)))
  const stillUsable = mine.flatMap((c) => (g.inn.get(c.id) ?? []).filter((e) => e.type === 'canUse' && e.from !== userId).map((e) => ({ conn: c, who: g.nodes.get(e.from)! })))
  const ownedOnly = [...g.nodes.values()].filter((n) => (n.kind === 'flow' || n.kind === 'app') && (g.inn.get(n.id) ?? []).filter((e) => e.type === 'edits').every((e) => e.from === userId) && (g.inn.get(n.id) ?? []).some((e) => e.from === userId))
  return { connections: mine, breaks: [...breaks.values()], stillUsable, orphaned: ownedOnly }
}
