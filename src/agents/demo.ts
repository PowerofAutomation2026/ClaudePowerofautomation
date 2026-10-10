import type { Env } from '../types'
import type { AgentInfo } from './analyze'

const mk = (id: string, name: string, env: string, envName: string, auth: number, access: number, ...data: string[]): AgentInfo => ({ key: `agent:${env}:${id}`, id, name, envId: env, envName, auth: { raw: auth }, access: { raw: access }, fieldsOk: true, compsOk: true, comps: data.map((d, i) => ({ name: `Topic ${i + 1}`, data: d })) })
const connector = (mode: string, op = 'SendEmailV2') => `kind: AdaptiveDialog\nbeginDialog:\n  actions:\n    - kind: InvokeConnectorAction\n      operationId: ${op}\n      connectionProperties:\n        mode: ${mode}\n`
const http = (url: string, extra = '') => `kind: AdaptiveDialog\nbeginDialog:\n  actions:\n    - kind: HttpRequestAction\n      method: Post\n      url: ${url}\n${extra}`
const site = (u: string) => `kind: KnowledgeSourceConfiguration\nsource:\n  kind: PublicSiteSearchSource\n  site: ${u}\n`

export const DEMO_AGENTS: AgentInfo[] = [
  mk('a1', 'HR Helpdesk Agent', 'env-prod', 'Production', 2, 1, connector('Invoker')),
  mk('a2', 'Public Product Q&A', 'env-prod', 'Production', 1, 0, connector('Maker', 'SendEmailV2'), site('https://www.contoso.com/products')),
  mk('a3', 'IT Support Copilot', 'env-prod', 'Production', 2, 0, http('https://api.contoso-itsm.com/tickets', '      headers:\n        x-api-key: "k-93ab12"\n'), connector('Maker', 'GetRows')),
  mk('a4', 'Sales Assistant', 'env-uat', 'UAT', 1, 3, http('https://webhook.site/5f1-demo'), site('https://news.example.org')),
  mk('a5', 'Policy Q&A Bot', 'env-dev', 'Development', 2, 2, site('https://learn.microsoft.com')),
  { ...mk('a6', 'Legacy bot', 'env-dev', 'Development', 0, 0), fieldsOk: false, compsOk: false, auth: undefined, access: undefined },
]
export async function demoAgents(envs: Env[], onProgress: (d: number, t: number, l: string) => void) {
  let i = 0
  for (const e of envs) { await new Promise((r) => setTimeout(r, 250)); onProgress(++i, envs.length, e.name) }
  const ids = new Set(envs.map((e) => e.id))
  return { agents: DEMO_AGENTS.filter((a) => ids.has(a.envId)), notes: [{ env: '(demo)', level: 'info' as const, text: `Read ${DEMO_AGENTS.length} sample agents` }] }
}
