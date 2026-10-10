import type { Finding, Resource } from '../exposure/types'
import type { EFinding } from '../egress/analyze'
import type { AFinding } from '../agents/analyze'
import { blast, blastFindings, type Graph } from '../blast/graph'
import type { FindingRow } from './persist'

export const fromExposure = (fs: Finding[], byKey: Map<string, Resource>): FindingRow[] =>
  fs.map((f) => ({ module: 'exposure', rule: f.rule, severity: f.severity, kind: f.kind, resource: f.name, envName: f.envName, envId: f.envId,
    principal: f.share?.principal.email ?? f.share?.principal.name, title: f.title, detail: f.detail,
    fixPayload: f.share && f.kind !== 'connection' ? JSON.stringify({ action: 'removeShare', kind: f.kind, envId: f.envId, resourceId: byKey.get(f.resourceKey)?.id, rowId: f.share.rowId, role: f.share.role }) : undefined }))

export const fromEgress = (fs: EFinding[]): FindingRow[] =>
  fs.map((f) => ({ module: 'egress', rule: f.rule, severity: f.severity, kind: 'flow', resource: f.name, envName: f.envName, envId: f.envId, host: f.host, title: f.title, detail: f.detail }))

export const fromAgents = (fs: AFinding[]): FindingRow[] =>
  fs.map((f) => ({ module: 'agents', rule: f.rule, severity: f.severity, kind: 'agent', resource: f.name, envName: f.envName, host: f.host, title: f.title, detail: f.detail }))

/** Blast-radius findings + one precomputed REACH row per account ("what can Priya reach if compromised?") so the agent never has to walk a graph. */
export function fromBlast(g: Graph, maxUsers = 300): FindingRow[] {
  const out: FindingRow[] = blastFindings(g).map((f) => ({ module: 'blast' as const, rule: f.rule, severity: f.severity, kind: 'connection', resource: g.nodes.get(f.nodeId)?.label ?? f.nodeId, envName: g.nodes.get(f.nodeId)?.sub ?? '', title: f.title, detail: f.detail }))
  const users = [...g.nodes.values()].filter((n) => n.kind === 'user' && n.ptype !== 'Tenant').map((u) => ({ u, b: blast(g, u.id) })).filter((x) => x.b.conns.length).sort((a, b) => b.b.score - a.b.score).slice(0, maxUsers)
  for (const { u, b } of users) {
    const top = b.conns.slice(0, 12).map((c) => `${c.node.label} [${c.node.connector ?? ''}, sens ${c.node.sens}] via ${c.path.map((i) => g.nodes.get(i)?.label).join(' → ')}`).join('\n')
    out.push({ module: 'blast', rule: 'REACH', severity: b.score >= 15 ? 'High' : b.score >= 6 ? 'Medium' : 'Low', kind: 'user', resource: u.label, envName: '(all)', principal: u.sub ?? u.label,
      title: `${u.label} can act through ${b.conns.length} credential(s) (blast radius ${b.score})`, detail: top })
  }
  return out
}
