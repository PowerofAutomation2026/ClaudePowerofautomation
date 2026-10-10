/**
 * Egress Radar - pure analysis of Power Automate flow definitions: WHERE does each flow send data, and what is exposed in the definition?
 * No network. The definition is the Logic Apps workflow JSON returned by "Get Flow as Admin" (includeFlowDefinition).
 */
export type Sev = 'High' | 'Medium' | 'Low' | 'Info'
export interface FlowDef { key: string; id: string; name: string; envId: string; envName: string; state?: string; ownerId?: string; modified?: string; definition: any; agentFlow?: boolean; via?: 'admin' | 'dataverse' }
export interface HttpCall { flowKey: string; action: string; method: string; uri: string; host: string | null; scheme: string | null; dynamic: boolean; secrets: string[]; kind: 'http' | 'webhook' }
export interface MailCall { flowKey: string; action: string; recipients: string[] }
export interface Extract { http: HttpCall[]; mail: MailCall[]; triggerHttp: boolean; actions: number }
export interface EFinding { id: string; rule: string; severity: Sev; flowKey: string; name: string; envId: string; envName: string; host?: string; title: string; detail: string }

/** Microsoft-owned service domains. azurewebsites.net / blob.core.windows.net are NOT listed: anyone can host there. sharepoint.com IS listed although another tenant's SharePoint would also match (cannot be told apart by name). */
const MS_HOST = /(^|\.)(microsoft\.com|microsoftonline\.com|office\.com|office365\.com|powerapps\.com|powerplatform\.com|powerautomate\.com|dynamics\.com|azure\.com|live\.com|sharepoint\.com)$/i
/** Capture / paste / tunnel / anonymous-upload services: legitimate for developers, classic exfiltration channels for data. */
const EXFIL = /(^|\.)(webhook\.site|requestbin\.(com|net)|pipedream\.net|ngrok(-free)?\.(io|app|dev)|pastebin\.com|paste\.ee|hastebin\.com|transfer\.sh|anonfiles\.com|file\.io|0x0\.st|discord(app)?\.com|api\.telegram\.org|beeceptor\.com|mockbin\.org|interact\.sh|oast\.(pro|live|site|online|fun|me)|burpcollaborator\.net|trycloudflare\.com|loca\.lt|serveo\.net)$/i
const SECRET_HEADER = /authorization|api[-_]?key|apikey|token|secret|password|x-functions-key|subscription-key/i
const SECRET_QUERY = /[?&](sig|code|key|apikey|api_key|token|access_token|client_secret|password|pwd)=[^&\s@]+/i
const IP = /^(\d{1,3}\.){3}\d{1,3}$|^\[?[0-9a-f:]+:[0-9a-f:]+\]?$/i
const isExpr = (v: unknown) => typeof v === 'string' && v.trim().startsWith('@')
const literal = (v: unknown) => typeof v === 'string' && v.length > 0 && !isExpr(v) && !/@\{/.test(v)

export const hostOf = (uri: string): { host: string | null; scheme: string | null; dynamic: boolean } => {
  const dynamic = isExpr(uri) || /@\{/.test(uri)
  const m = /^\s*(https?):\/\/([^/?#:@\s]+)(?::\d+)?/i.exec(uri) ?? /(https?):\/\/([a-z0-9.-]+\.[a-z]{2,})/i.exec(uri)
  if (m && !/[@{]/.test(m[2])) return { host: m[2].toLowerCase(), scheme: m[1].toLowerCase(), dynamic }
  const ip = /(https?):\/\/(\d{1,3}(?:\.\d{1,3}){3})/i.exec(uri)
  return ip ? { host: ip[2], scheme: ip[1].toLowerCase(), dynamic } : { host: null, scheme: null, dynamic }
}

export function extract(flowKey: string, def: any): Extract {
  const out: Extract = { http: [], mail: [], triggerHttp: false, actions: 0 }
  for (const t of Object.values<any>(def?.triggers ?? {})) if (/^request$/i.test(t?.type ?? '') && /^http$/i.test(t?.kind ?? '')) out.triggerHttp = true
  const walk = (acts: any) => {
    for (const [name, a] of Object.entries<any>(acts ?? {})) {
      out.actions++
      const type = String(a?.type ?? '')
      const inp = a?.inputs ?? {}
      if (/^http$/i.test(type) || /^httpwebhook$/i.test(type)) {
        const uri = String(inp.uri ?? inp.subscribe?.uri ?? '')
        const h = hostOf(uri)
        const secrets: string[] = []
        for (const [k, v] of Object.entries<any>(inp.headers ?? {})) if (SECRET_HEADER.test(k) && literal(v)) secrets.push(`literal "${k}" header`)
        const au = inp.authentication
        if (au && /basic/i.test(au.type ?? '') && literal(au.password)) secrets.push('literal Basic-auth password')
        if (au && /^(raw)$/i.test(au.type ?? '') && literal(au.value)) secrets.push('literal Authorization value')
        if (au && /activedirectoryoauth/i.test(au.type ?? '') && literal(au.secret)) secrets.push('literal OAuth client secret')
        if (SECRET_QUERY.test(uri)) secrets.push('credential/token in the URL')
        out.http.push({ flowKey, action: name, method: String(inp.method ?? 'GET').toUpperCase(), uri, host: h.host, scheme: h.scheme, dynamic: h.dynamic || !h.host, secrets, kind: /webhook/i.test(type) ? 'webhook' : 'http' })
      } else if (/openapiconnection|apiconnection/i.test(type) && /sendemail|sendmail/i.test(String(inp.host?.operationId ?? inp.path ?? ''))) {
        const p = inp.parameters ?? {}
        const raw = [p['emailMessage/To'], p['emailMessage/Cc'], p['emailMessage/Bcc'], p.To, p.Cc, p.Bcc].filter(literal).join(';')
        const rec = raw.split(/[;,]/).map((s: string) => s.trim().toLowerCase()).filter((s: string) => /@/.test(s))
        if (rec.length) out.mail.push({ flowKey, action: name, recipients: rec })
      }
      walk(a?.actions); walk(a?.else?.actions)
      for (const c of Object.values<any>(a?.cases ?? {})) walk(c?.actions)
      walk(a?.default?.actions)
    }
  }
  walk(def?.actions)
  return out
}

export interface Options { allow: string[]; internalDomains: string[] }
const allowed = (host: string, allow: string[]) => allow.some((a) => { const x = a.trim().toLowerCase().replace(/^\*\./, ''); return !!x && (host === x || host.endsWith('.' + x)) })

export function analyze(flows: FlowDef[], opt: Options) {
  const findings: EFinding[] = []
  const dests = new Map<string, { host: string; first: boolean; exfil: boolean; flows: Set<string>; envs: Set<string>; calls: number; allowed: boolean }>()
  const byFlow = new Map<string, Extract>()
  let withHttp = 0
  for (const f of flows) {
    const ex = extract(f.key, f.definition); byFlow.set(f.key, ex)
    if (ex.http.length) withHttp++
    const add = (rule: string, severity: Sev, title: string, detail: string, host?: string) => findings.push({ id: `${rule}:${f.key}:${host ?? ''}:${findings.length}`, rule, severity, flowKey: f.key, name: f.name, envId: f.envId, envName: f.envName, host, title, detail })
    const seen = new Set<string>()
    for (const c of ex.http) {
      if (c.host) {
        const d = dests.get(c.host) ?? { host: c.host, first: MS_HOST.test(c.host), exfil: EXFIL.test(c.host), flows: new Set(), envs: new Set(), calls: 0, allowed: allowed(c.host, opt.allow) }
        d.flows.add(f.key); d.envs.add(f.envName); d.calls++; dests.set(c.host, d)
      }
      const where = `${c.method} ${c.host ?? 'unknown host'} (action “${c.action}”)`
      if (c.host && EXFIL.test(c.host) && !allowed(c.host, opt.allow)) add('EXFIL_SERVICE', 'High', 'Sends data to a capture / paste / tunnel service', `${where}. These endpoints receive and store whatever is posted and are a classic exfiltration channel.`, c.host)
      if (c.host && IP.test(c.host)) add('RAW_IP', 'High', 'Calls a raw IP address', `${where}. Legitimate services use names; an IP bypasses name-based review.`, c.host)
      if (c.scheme === 'http') add('INSECURE', 'High', 'Sends data over plain HTTP', `${where}. Content and credentials travel unencrypted.`, c.host ?? undefined)
      for (const s of c.secrets) add('SECRET_IN_FLOW', 'High', 'Secret stored in the flow definition', `Action “${c.action}” → ${c.host ?? 'unknown host'}: ${s}. Anyone who can edit or export the flow can read it; move it to an environment variable / Key Vault.`, c.host ?? undefined)
      if (c.dynamic && !c.host) add('DYNAMIC_DEST', 'Medium', 'Destination is computed at run time', `${where}. The target comes from an expression, so no static review can say where data goes.`)
      if (c.host && !MS_HOST.test(c.host) && !EXFIL.test(c.host) && !IP.test(c.host) && !allowed(c.host, opt.allow) && !seen.has(c.host)) { seen.add(c.host); add('NEW_EXTERNAL', 'Medium', 'Calls a host that is not on the allow-list', `${where}. Review it once and click “Allow” if expected.`, c.host) }
    }
    for (const m of ex.mail) {
      const ext = opt.internalDomains.length ? m.recipients.filter((r) => !opt.internalDomains.some((d) => r.endsWith('@' + d.toLowerCase().replace(/^@/, '')))) : []
      if (ext.length) add('MAIL_EXTERNAL', 'Medium', 'Emails fixed external recipients', `Action “${m.action}” always sends to ${ext.slice(0, 3).join(', ')}${ext.length > 3 ? '…' : ''}. Data in that email leaves the organisation on every run.`)
    }
    if (ex.triggerHttp) add('HTTP_TRIGGER', 'Info', 'Flow can be started by an HTTP request', 'Anyone holding the flow URL may be able to trigger it. Check the trigger\'s “Who can trigger” setting (Anyone / tenant / specific users).')
  }
  const order = { High: 0, Medium: 1, Low: 2, Info: 3 } as const
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.name.localeCompare(b.name))
  return { findings, dests: [...dests.values()].sort((a, b) => Number(b.exfil) - Number(a.exfil) || b.flows.size - a.flows.size), byFlow, withHttp }
}
