/**
 * Agent Guard - pure analysis of Copilot Studio agents (Dataverse `bot` + `botcomponent` rows).
 * Topics / tools are stored as YAML in botcomponent.data; we read them with plain-text scanning (no YAML library).
 * Field meanings (authenticationmode, accesscontrolpolicy) come from the Dataverse formatted value when present, otherwise from the numeric
 * code with the mapping noted in the README (UNVERIFIED against a live tenant) - the raw value is always shown next to the verdict.
 */
import { hostOf } from '../egress/analyze'
import type { Sev } from '../egress/analyze'

export interface AgentComp { name: string; data: string }
export interface AgentInfo {
  key: string; id: string; name: string; envId: string; envName: string; ownerId?: string; modified?: string
  auth?: { raw: unknown; label?: string }       // authenticationmode
  access?: { raw: unknown; label?: string }     // accesscontrolpolicy
  fieldsOk: boolean                             // false = the security columns could not be read
  comps: AgentComp[]; compsOk: boolean
}
export interface AFinding { id: string; rule: string; severity: Sev; agentKey: string; name: string; envName: string; host?: string; title: string; detail: string }
export interface AgentFacts { noAuth: boolean | null; openAccess: boolean | null; makerTools: number; publicSites: string[]; http: { host: string | null; dynamic: boolean; secret: boolean; insecure: boolean }[]; flowsInvoked: number; connectors: string[] }

const MS = /(^|\.)(microsoft\.com|microsoftonline\.com|office\.com|office365\.com|powerapps\.com|powerplatform\.com|powerautomate\.com|dynamics\.com|azure\.com|live\.com|sharepoint\.com)$/i
const EXFIL = /(^|\.)(webhook\.site|requestbin\.(com|net)|pipedream\.net|ngrok(-free)?\.(io|app|dev)|pastebin\.com|transfer\.sh|anonfiles\.com|file\.io|discord(app)?\.com|api\.telegram\.org|beeceptor\.com|oast\.(pro|live|site|online|fun|me)|trycloudflare\.com|loca\.lt)$/i
const IP = /^(\d{1,3}\.){3}\d{1,3}$/
const allowed = (h: string, allow: string[]) => allow.some((a) => { const x = a.trim().toLowerCase().replace(/^\*\./, ''); return !!x && (h === x || h.endsWith('.' + x)) })
const unq = (v: string) => v.trim().replace(/^["']|["']$/g, '')

const AUTH_NAMES: Record<string, string> = { '1': 'None', '2': 'Integrated (Microsoft)', '3': 'Custom Entra ID', '4': 'Generic OAuth2' }
const ACCESS_NAMES: Record<string, string> = { '0': 'Any', '1': 'Copilot readers', '2': 'Group membership', '3': 'Any (multitenant)' }
export const authLabel = (a?: AgentInfo['auth']) => (a ? (a.label ?? AUTH_NAMES[String(a.raw)] ?? `code ${a.raw}`) : 'unknown')
export const accessLabel = (a?: AgentInfo['access']) => (a ? (a.label ?? ACCESS_NAMES[String(a.raw)] ?? `code ${a.raw}`) : 'unknown')

export function facts(a: AgentInfo): AgentFacts {
  const f: AgentFacts = { noAuth: null, openAccess: null, makerTools: 0, publicSites: [], http: [], flowsInvoked: 0, connectors: [] }
  if (a.fieldsOk && a.auth) f.noAuth = /^none$|no authentication/i.test(authLabel(a.auth))
  if (a.fieldsOk && a.access) f.openAccess = /^any/i.test(accessLabel(a.access))
  for (const c of a.comps) {
    const t = c.data ?? ''
    const blocks = t.split(/\n(?=\s*-?\s*kind:\s)/)
    for (const b of blocks) {
      const kind = /kind:\s*([A-Za-z]+)/.exec(b)?.[1] ?? ''
      if (/^HttpRequestAction$/i.test(kind)) {
        const url = unq(/\n?\s*url:\s*(.+)/.exec(b)?.[1] ?? '')
        const h = hostOf(url.replace(/^=/, ''))
        f.http.push({ host: h.host, dynamic: h.dynamic || url.startsWith('=') || !h.host, insecure: h.scheme === 'http', secret: /(authorization|api[-_]?key|token|secret|subscription-key)["']?\s*:\s*["']?(?!=)[^\s"'=][^\n]*/i.test(b) })
      } else if (/^InvokeConnector(Task)?Action$|^InvokeFlow(Task)?Action$/i.test(kind) || /connectionProperties:/i.test(b)) {
        if (/^InvokeFlow/i.test(kind)) f.flowsInvoked++
        if (/mode:\s*Maker/i.test(b)) f.makerTools++
        const op = /(operationId|connectionReference|connectorName):\s*(\S+)/i.exec(b)?.[2]; if (op) f.connectors.push(unq(op))
      } else if (/PublicSiteSearchSource/i.test(kind) || /PublicSiteSearchSource/.test(b)) {
        const site = unq(/site:\s*(\S+)/.exec(b)?.[1] ?? ''); f.publicSites.push(site || '(site not readable)')
      }
    }
    if (!blocks.length && /mode:\s*Maker/i.test(t)) f.makerTools++
  }
  return f
}

export function analyzeAgents(agents: AgentInfo[], allow: string[]) {
  const out: AFinding[] = []
  const rows = agents.map((a) => ({ a, f: facts(a) }))
  for (const { a, f } of rows) {
    const add = (rule: string, severity: Sev, title: string, detail: string, host?: string) => out.push({ id: `${rule}:${a.key}:${host ?? out.length}`, rule, severity, agentKey: a.key, name: a.name, envName: a.envName, host, title, detail })
    if (f.noAuth && f.makerTools) add('ANON_AS_MAKER', 'High', 'Anyone with the link can act with the maker\'s credentials', `Authentication is "None" and ${f.makerTools} tool/action(s) run as the MAKER. An anonymous visitor can read or change whatever those connections can reach. (Raw authenticationmode: ${String(a.auth?.raw)}).`)
    else if (f.noAuth) add('NO_AUTH', 'High', 'Agent has no authentication', `Anyone who has the published link/channel can chat with it anonymously. Raw authenticationmode: ${String(a.auth?.raw)}. Microsoft's guidance: block the "Chat without Microsoft Entra ID authentication" connector in DLP.`)
    else if (f.makerTools) add('MAKER_CREDS', 'Medium', 'Tools run with the maker\'s credentials', `${f.makerTools} tool/action(s) use the maker's identity, so every user of the agent gets the maker's access, not their own.`)
    if (f.openAccess && !f.noAuth) add('OPEN_ACCESS', 'Low', 'Open to every signed-in user', `Access policy is "${accessLabel(a.access)}" (raw ${String(a.access?.raw)}): not limited to a group or readers.`)
    for (const s of f.publicSites) add('PUBLIC_SITE', 'Medium', 'Grounded on a public website', `Knowledge source: ${s}. Public pages are untrusted input (prompt injection) and the agent may quote them to users.`, s)
    const seen = new Set<string>()
    for (const h of f.http) {
      if (h.host && EXFIL.test(h.host) && !allowed(h.host, allow)) add('EXFIL_SERVICE', 'High', 'Agent sends data to a capture / paste / tunnel service', `HTTP request node → ${h.host}.`, h.host)
      else if (h.host && IP.test(h.host)) add('RAW_IP', 'High', 'Agent calls a raw IP address', `HTTP request node → ${h.host}.`, h.host)
      else if (h.host && !MS.test(h.host) && !allowed(h.host, allow) && !seen.has(h.host)) { seen.add(h.host); add('NEW_EXTERNAL', 'Medium', 'Agent calls a host that is not on the allow-list', `HTTP request node → ${h.host}. Review it once and click Allow if expected.`, h.host) }
      if (h.insecure) add('INSECURE', 'High', 'Agent calls a host over plain HTTP', `HTTP request node → ${h.host ?? 'unknown'}.`, h.host ?? undefined)
      if (h.secret) add('SECRET_IN_AGENT', 'High', 'Secret typed into an HTTP request node', `A literal key/token/Authorization header is stored in the topic definition (host ${h.host ?? 'unknown'}). Anyone who can edit or export the agent can read it.`, h.host ?? undefined)
      if (h.dynamic && !h.host) add('DYNAMIC_DEST', 'Medium', 'HTTP destination computed at run time', 'The URL comes from a Power Fx expression - where data goes cannot be reviewed statically.')
    }
    if (!a.fieldsOk) add('FIELDS_UNREADABLE', 'Info', 'Security settings could not be read', 'The authentication / access columns were not returned for this environment - this agent is UNKNOWN, not safe.')
    if (!a.compsOk) add('COMPS_UNREADABLE', 'Info', 'Topics and tools could not be read', 'Needs the Microsoft Dataverse connector for this environment. Tool credentials and HTTP calls of this agent are unknown, not safe.')
  }
  const order = { High: 0, Medium: 1, Low: 2, Info: 3 } as const
  out.sort((x, y) => order[x.severity] - order[y.severity] || x.name.localeCompare(y.name))
  return { findings: out, rows }
}
