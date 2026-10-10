import type { Env } from '../types'
import type { ExposureBackend, Principal, Resource, Share } from './types'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const u = (n: string, d = 'contoso.com'): Principal => ({ id: `u-${n}`, type: 'User', name: n[0].toUpperCase() + n.slice(1), email: `${n}@${d}` })
const guest: Principal = { id: 'g-1', type: 'Guest', name: 'Dana (Fabrikam)', email: 'dana_fabrikam.com#EXT#@contoso.onmicrosoft.com' }
const everyone: Principal = { id: 'tenant-0000', type: 'Tenant', name: 'Everyone in the organisation' }
const group: Principal = { id: 'grp-1', type: 'Group', name: 'All Sales' }
let n = 0
const sh = (principal: Principal, role: string): Share => ({ rowId: principal.id + '-' + ++n, role, principal })

const store: Resource[] = [
  { key: 'app:env-prod:a1', kind: 'app', id: 'a1', name: 'Expense Tracker', envId: 'env-prod', envName: 'Production', owner: u('alex'), shares: [sh(everyone, 'CanView'), sh(u('priya'), 'CanEdit')] },
  { key: 'app:env-prod:a2', kind: 'app', id: 'a2', name: 'Visitor Check-in', envId: 'env-prod', envName: 'Production', owner: u('sam'), shares: [sh(guest, 'CanViewWithShare')] },
  { key: 'app:env-dev:a3', kind: 'app', id: 'a3', name: 'Field Survey', envId: 'env-dev', envName: 'Development', owner: u('jordan'), shares: ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => sh(u('maker' + x), 'CanEdit')).concat(sh(group, 'CanEdit')) },
  { key: 'app:env-dev:a4', kind: 'app', id: 'a4', name: 'Leave Requests', envId: 'env-dev', envName: 'Development', owner: u('priya'), shares: [sh(u('alex'), 'CanView')] },
  { key: 'flow:env-prod:f1', kind: 'flow', id: 'f1', name: 'Approve invoices', envId: 'env-prod', envName: 'Production', owner: u('alex'), state: 'Started', shares: [sh(u('priya'), 'CanEdit'), sh(guest, 'CanEdit'), sh(u('sam'), 'CanEdit'), sh(u('jordan'), 'CanEdit')] },
  { key: 'flow:env-uat:f2', kind: 'flow', id: 'f2', name: 'Weekly digest email', envId: 'env-uat', envName: 'UAT', owner: u('sam'), state: 'Started', shares: [] },
  { key: 'connection:env-prod:c1', kind: 'connection', id: 'c1', name: 'Outlook (alex)', connector: 'shared_office365', envId: 'env-prod', envName: 'Production', owner: u('alex'), status: 'Connected', shares: [sh(u('priya'), 'CanUseAndShare'), sh(everyone, 'CanUse')] },
  { key: 'connection:env-prod:c2', kind: 'connection', id: 'c2', name: 'SQL Server (svc)', connector: 'shared_sql', envId: 'env-prod', envName: 'Production', owner: { ...u('leaver'), enabled: false }, status: 'Error', shares: [] },
  { key: 'connection:env-uat:c3', kind: 'connection', id: 'c3', name: 'SharePoint (sam)', connector: 'shared_sharepointonline', envId: 'env-uat', envName: 'UAT', owner: u('sam'), status: 'Connected', shares: [sh(u('jordan'), 'CanUse')] },
]

export const demoExposure: ExposureBackend = {
  label: 'Demo',
  async scan(envs: Env[], onProgress) {
    let i = 0
    for (const e of envs) { await sleep(250); onProgress(++i, envs.length, e.name) }
    const ids = new Set(envs.map((e) => e.id))
    return { resources: store.filter((r) => ids.has(r.envId)).map((r) => ({ ...r, shares: [...r.shares] })), notes: [{ env: '(demo)', level: 'info', text: `Scanned ${envs.length} sample environment(s)` }] }
  },
  async removeShare(r, s) {
    await sleep(350)
    if (s.principal.id === 'g-1' && r.id === 'f1') throw new Error('HTTP 400: Simulated failure - the flow is in a managed solution')
    const real = store.find((x) => x.key === r.key)
    if (!real) throw new Error('Not found')
    real.shares = real.shares.filter((x) => x.rowId !== s.rowId)
  },
  async verifyGone(r, s) { return !store.find((x) => x.key === r.key)?.shares.some((x) => x.rowId === s.rowId) },
  async diagnostics() { return [{ name: 'Demo mode', ok: true, detail: 'Built-in sample tenant. Nothing in Power Platform is read or changed.' }] },
}
