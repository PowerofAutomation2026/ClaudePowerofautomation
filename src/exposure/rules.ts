import type { Finding, Principal, Resource, RuleId, Severity, Share, Thresholds } from './types'
import { DEFAULT_THRESHOLDS } from './types'

export const SEV_ORDER: Record<Severity, number> = { High: 0, Medium: 1, Low: 2, Info: 3 }

export const RULE_TITLE: Record<RuleId, string> = {
  EVERYONE: 'Shared with everyone in the organisation',
  GUEST: 'Shared with an external / guest account',
  CONN_SHARED: 'Connection credentials shared with other people',
  CONN_DEAD_OWNER: 'Connection belongs to a disabled or deleted account',
  EDITOR_SPRAWL: 'Too many editors',
  FLOW_OWNER_SPRAWL: 'Too many flow co-owners',
  CONN_ERROR: 'Connection is broken',
  UNREADABLE: 'Sharing could not be read',
}

const EDIT_ROLE = /edit|owner|share/i // CanEdit, CanViewWithShare, CanUseAndShare, Owner ...

/** Classify a raw principal returned by the admin APIs. Everything unverified is documented in the README. */
export function classifyPrincipal(p: { id?: string; type?: string; email?: string; displayName?: string; upn?: string } | undefined, tenantId?: string): Principal {
  const id = String(p?.id ?? '')
  const email = p?.email ?? p?.upn
  const t = String(p?.type ?? '').toLowerCase()
  const name = p?.displayName ?? email ?? id
  if (t === 'tenant' || /^tenant-/i.test(id) || (tenantId && id.toLowerCase() === tenantId.toLowerCase() && t !== 'user'))
    return { id, type: 'Tenant', name: 'Everyone in the organisation' }
  if (t === 'group') return { id, type: 'Group', name, email }
  if (/#ext#/i.test(email ?? '') || /#ext#/i.test(id) || t === 'guest') return { id, type: 'Guest', name, email }
  if (t === 'user' || email || id) return { id, type: 'User', name, email }
  return { id, type: 'Unknown', name }
}

const who = (p: Principal) => (p.type === 'Tenant' ? 'EVERYONE in the organisation' : `${p.name ?? p.email ?? p.id}${p.email && p.name !== p.email ? ` <${p.email}>` : ''}`)

/** Compute all findings from the collected resources. Pure: no network, safe to unit test and to run in Demo mode. */
export function evaluate(resources: Resource[], th: Thresholds = DEFAULT_THRESHOLDS): Finding[] {
  const out: Finding[] = []
  const add = (r: Resource, rule: RuleId, severity: Severity, detail: string, share?: Share, suffix = '') =>
    out.push({ id: `${rule}:${r.key}:${suffix || share?.principal.id || ''}`, rule, severity, resourceKey: r.key, kind: r.kind, name: r.name, envId: r.envId, envName: r.envName, title: RULE_TITLE[rule], detail, share })

  for (const r of resources) {
    if (r.kind !== 'connection') {
      for (const s of r.shares) {
        if (s.principal.type === 'Tenant')
          add(r, 'EVERYONE', 'High', `${r.kind === 'app' ? 'App' : 'Flow'} is shared with everyone (${s.role}). Any employee${r.kind === 'app' ? ' and guest' : ''} can reach it.`, s)
        else if (s.principal.type === 'Guest')
          add(r, 'GUEST', 'High', `${who(s.principal)} is an external/guest account with ${s.role}.`, s)
      }
      if (r.kind === 'app') {
        const editors = r.shares.filter((s) => /^canedit$/i.test(s.role) && s.principal.type !== 'Tenant')
        const groups = editors.filter((s) => s.principal.type === 'Group')
        if (editors.length > th.maxEditors || groups.length)
          add(r, 'EDITOR_SPRAWL', 'Medium', `${editors.length} principal(s) can EDIT this app${groups.length ? ` (${groups.length} group(s): ${groups.map((g) => g.principal.name).join(', ')})` : ''}. Editors can change what the app does with the owner's data connections.`, undefined, 'editors')
      } else {
        const owners = r.shares.filter((s) => /^(owner|canedit)$/i.test(s.role))
        if (owners.length > th.maxFlowOwners)
          add(r, 'FLOW_OWNER_SPRAWL', 'Medium', `${owners.length} co-owners besides the creator (${owners.slice(0, 4).map((o) => o.principal.email ?? o.principal.name).join(', ')}${owners.length > 4 ? '…' : ''}). Co-owners can read run history and re-use the flow's connections.`, undefined, 'owners')
      }
      if (r.sharedCount && r.sharedCount > r.shares.length)
        add(r, 'UNREADABLE', 'Info', `The list says ${r.sharedCount} principal(s) have access but only ${r.shares.length} could be read - this resource may be more exposed than shown.`, undefined, 'unreadable')
    } else {
      const others = r.shares.filter((s) => s.principal.id !== r.owner?.id)
      for (const s of others) {
        const high = EDIT_ROLE.test(s.role) || s.principal.type === 'Tenant' || s.principal.type === 'Guest'
        add(r, 'CONN_SHARED', high ? 'High' : 'Medium', `${who(s.principal)} can use this ${r.connector ?? ''} connection (${s.role}) - actions run as ${r.owner?.name ?? r.owner?.email ?? 'its creator'}.`, s)
      }
      if (r.owner && r.owner.enabled === false)
        add(r, 'CONN_DEAD_OWNER', 'High', `Created by ${who(r.owner)}, whose account is disabled or deleted, yet the connection still exists.`, undefined, 'owner')
      if (r.status && !/^connected$/i.test(r.status))
        add(r, 'CONN_ERROR', 'Low', `Status is "${r.status}". Anything using it is failing or about to.`, undefined, 'status')
    }
  }
  return out.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.envName.localeCompare(b.envName) || a.name.localeCompare(b.name))
}

/** 0-100 posture score: 100 = nothing found. High findings weigh most; capped so one noisy tenant does not flatline. */
export function score(findings: Finding[]): number {
  const w: Record<Severity, number> = { High: 8, Medium: 3, Low: 1, Info: 0 }
  return Math.max(0, 100 - Math.min(100, findings.reduce((n, f) => n + w[f.severity], 0)))
}

/** PowerShell equivalent of the fixes (Microsoft.PowerApps.Administration.PowerShell) for change tickets. */
export function powershellFix(items: { r: Resource; s: Share }[]): string {
  const L = ['# Generated by Exposure Auditor', 'Install-Module Microsoft.PowerApps.Administration.PowerShell -Scope CurrentUser', 'Add-PowerAppsAccount', '']
  for (const { r, s } of items) {
    if (r.kind === 'app') L.push(`Remove-AdminPowerAppRoleAssignment -AppName '${r.id}' -EnvironmentName '${r.envId}' -RoleId '${s.rowId}'  # ${r.name}: ${s.principal.name} (${s.role})`)
    else if (r.kind === 'flow') L.push(`Remove-AdminFlowOwnerRole -EnvironmentName '${r.envId}' -FlowName '${r.id}' -RoleId '${s.rowId}'  # ${r.name}: ${s.principal.name} (${s.role})`)
    else L.push(`# Connection '${r.name}' (${r.envName}): review manually - Remove-AdminPowerAppConnectionRoleAssignment -EnvironmentName '${r.envId}' -ConnectorName '${r.connector}' -ConnectionName '${r.id}' -RoleId '${s.rowId}'`)
  }
  return L.join('\n')
}

export const findingRows = (f: Finding[]) =>
  f.map((x) => ({ Severity: x.severity, Rule: x.rule, Type: x.kind, Name: x.name, Environment: x.envName, EnvironmentId: x.envId, Finding: x.title, Detail: x.detail, Principal: x.share?.principal.email ?? x.share?.principal.name ?? '', Role: x.share?.role ?? '' }))
