import type { Asset, Backend, Env, Person } from '../types'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const ENVS: Env[] = [
  { id: 'Default-0000', name: 'Contoso (default)', isDefault: true },
  { id: 'env-prod', name: 'Production' },
  { id: 'env-uat', name: 'UAT' },
  { id: 'env-dev', name: 'Development' },
  { id: 'env-sandbox', name: 'Sandbox - Finance' },
]

const APP_NAMES = ['Expense Tracker', 'Asset Inspector', 'Visitor Check-in', 'Leave Requests', 'Field Survey', 'Inventory Scanner', 'Onboarding Hub', 'Safety Walkthrough']
const AGENT_NAMES = ['HR Helpdesk Agent', 'IT Support Copilot', 'Sales Assistant', 'Policy Q&A Bot', 'Weather MCP Server', 'Expense Lookup Tool', 'Meeting Notes (Agent Builder)']
const FLOW_NAMES = ['Approve invoices', 'Notify on new lead', 'Sync SharePoint to SQL', 'Weekly digest email', 'Teams alert on failure', 'Archive old files', 'New hire provisioning', 'Daily backup', 'Form to Planner task']

let seed = 7
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]
const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString()

const store: Asset[] = []
const people: Person[] = [
  { id: 'u-1', name: 'Alex Morgan', email: 'alex.morgan@contoso.com' },
  { id: 'u-2', name: 'Priya Shah', email: 'priya.shah@contoso.com' },
  { id: 'u-3', name: 'Sam Ortega', email: 'sam.ortega@contoso.com' },
  { id: 'u-4', name: 'Jordan Lee', email: 'jordan.lee@contoso.com' },
]

ENVS.forEach((env) => {
  const n = 2 + Math.floor(rnd() * 5)
  for (let i = 0; i < n; i++) {
    const r = rnd()
    const kind = r > 0.55 ? 'app' : r > 0.15 ? 'flow' : 'agent'
    const isApp = kind === 'app'
    const owner = rnd() > 0.35 ? people[0] : pick(people)
    const name = kind === 'app' ? pick(APP_NAMES) : kind === 'flow' ? pick(FLOW_NAMES) : pick(AGENT_NAMES)
    const id = `${env.id}-${kind[0]}${i}`
    store.push({
      key: `${kind}:${env.id}:${id}`,
      id,
      kind,
      name,
      envId: env.id,
      envName: env.name,
      ownerId: owner.id,
      ownerName: owner.name,
      ownerEmail: owner.email,
      state: isApp ? 'Published' : kind === 'agent' ? pick(['Started', 'Stopped']) : pick(['Started', 'Started', 'Stopped', 'Suspended']),
      createdTime: daysAgo(100 + Math.floor(rnd() * 600)),
      modifiedTime: daysAgo(Math.floor(rnd() * 200)),
      inSolution: rnd() > 0.7,
      connections: Math.floor(rnd() * 6),
      category: kind === 'agent' ? (/MCP/.test(name) ? 'mcp' : /Tool/.test(name) ? 'tool' : /Agent Builder/.test(name) ? 'agentbuilder' : 'agent') : undefined,
    })
  }
})

export const demoBackend: Backend = {
  label: 'Demo',
  async listEnvironments() {
    await sleep(300)
    return ENVS
  },
  async resolveUser(q) {
    await sleep(350)
    const hit = people.find((p) => p.email.toLowerCase() === q.toLowerCase() || p.id === q)
    if (hit) return hit
    if (!q.includes('@')) throw new Error('No user found')
    return { id: 'u-' + q.length + q.charCodeAt(0), name: q.split('@')[0].replace(/[._]/g, ' '), email: q }
  },
  async listAssets(user, envs, onProgress) {
    let i = 0
    for (const e of envs) {
      await sleep(250)
      onProgress(++i, envs.length, e.name)
    }
    const assets = store.filter((a) => a.ownerId === user.id && envs.some((e) => e.id === a.envId)).map((a) => ({ ...a }))
    return { assets, notes: [{ env: '(demo)', kind: 'env' as const, level: 'info' as const, text: `Scanned ${envs.length} sample environments` }] }
  },
  async prepareOwner(envId, to) {
    await sleep(400)
    return `added ${to.email} as a member of ${envId} (demo)`
  },
  async verifyOwner() {
    return true
  },
  async transfer(asset, to, opts) {
    await sleep(300 + rnd() * 600)
    if (asset.kind === 'agent' && /Policy|IT Support/.test(asset.name)) throw new Error('HTTP 502: The response is not in a JSON format. — "Failed to reassign agent. The new owner was only partially updated, and the agent may not function correctly until another reassignment is performed." (simulated demo error)')
    if (asset.name === 'Daily backup') throw new Error('Simulated failure: flow is locked by a solution (managed)')
    const real = store.find((a) => a.key === asset.key)
    if (!real) throw new Error('Not found')
    real.ownerId = to.id
    real.ownerName = to.name
    real.ownerEmail = to.email
    void opts
  },
  async diagnostics() {
    return [{ name: 'Demo mode', ok: true, detail: 'Using built-in sample tenant. Nothing is changed in Power Platform.' }]
  },
}
