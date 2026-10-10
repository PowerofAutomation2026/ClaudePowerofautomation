/**
 * Agent Guard - live scan of Copilot Studio agents through Dataverse (this app's own environment natively, others via the Dataverse connector).
 * No app registration. Columns that may not exist in every tenant are requested with a safe fallback and the agent is then marked "unknown".
 */
import { log } from '../oplog'
import { internals as I } from '../services/live'
import type { Env } from '../types'
import type { AgentComp, AgentInfo } from './analyze'

/* eslint-disable @typescript-eslint/no-explicit-any */
const FULL = ['botid', 'name', 'authenticationmode', 'accesscontrolpolicy', '_ownerid_value', 'modifiedon']
const BASIC = ['botid', 'name', '_ownerid_value', 'modifiedon']
const fmt = (r: any, k: string): string | undefined => r?.[`${k}@OData.Community.Display.V1.FormattedValue`]
const MAX_COMP_AGENTS = 150

export async function liveAgents(envs: Env[], onProgress: (d: number, t: number, l: string) => void) {
  const notes: { env: string; level: 'info' | 'warn' | 'error'; text: string }[] = []
  const agents: AgentInfo[] = []
  let done = 0
  for (const env of envs) {
    onProgress(done++, envs.length, env.name)
    try {
      const dv = await I.dvFor(env.id)
      if (!dv) { notes.push({ env: env.name, level: 'warn', text: 'No Dataverse route (environment has no database, or the Microsoft Dataverse connector is missing) - agents here are unknown, not safe.' }); continue }
      let rows: any[]; let fieldsOk = true
      try { rows = await dv('bots', 'statecode eq 0', FULL, 500) }
      catch (e) { fieldsOk = false; log(`agents ${env.name}: security columns rejected (${(e as Error).message.slice(0, 120)}) - retrying with basic columns`); rows = await dv('bots', 'statecode eq 0', BASIC, 500) }
      const list: AgentInfo[] = rows.map((r) => ({
        key: `agent:${env.id}:${r.botid}`, id: r.botid, name: r.name ?? r.botid, envId: env.id, envName: env.name, ownerId: r._ownerid_value, modified: r.modifiedon,
        auth: fieldsOk && r.authenticationmode !== undefined ? { raw: r.authenticationmode, label: fmt(r, 'authenticationmode') } : undefined,
        access: fieldsOk && r.accesscontrolpolicy !== undefined ? { raw: r.accesscontrolpolicy, label: fmt(r, 'accesscontrolpolicy') } : undefined,
        fieldsOk: fieldsOk && r.authenticationmode !== undefined, comps: [], compsOk: false,
      }))
      let compOk = 0, compFail = 0
      await I.mapLimit(list.slice(0, MAX_COMP_AGENTS), 4, async (a) => {
        try {
          const comps = await dv('botcomponents', `_parentbotid_value eq ${a.id}`, ['name', 'componenttype', 'data'], 500)
          a.comps = comps.map((c): AgentComp => ({ name: c.name ?? '', data: String(c.data ?? '') })); a.compsOk = true; compOk++
        } catch (e) { compFail++; if (compFail === 1) log(`agent components ${env.name}: ${(e as Error).message.slice(0, 160)}`) }
      })
      agents.push(...list)
      notes.push({ env: env.name, level: !fieldsOk || compFail ? 'warn' : 'info', text: `${list.length} agent(s) · security settings ${fieldsOk ? 'read' : 'NOT readable (column names differ or no access)'} · topics/tools read for ${compOk}${list.length > MAX_COMP_AGENTS ? ` (first ${MAX_COMP_AGENTS} only)` : ''}${compFail ? ` · ${compFail} failed` : ''}` })
    } catch (e) { notes.push({ env: env.name, level: 'error', text: (e as Error).message }) }
  }
  onProgress(envs.length, envs.length, 'done')
  return { agents, notes }
}
