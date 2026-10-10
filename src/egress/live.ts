/**
 * Egress Radar - live scan. No app registration: "Get Flow as Admin" with the flow definition, through the admin's own connection.
 * Bound by REST path (see 🩺 on the Exposure Auditor): GET .../scopes/admin/environments/{env}/flows/{flow}?include=...
 */
import { log } from '../oplog'
import { internals as I } from '../services/live'
import type { Env } from '../types'
import type { FlowDef } from './analyze'

/* eslint-disable @typescript-eslint/no-explicit-any */
const MAX_DEFS = 400 // per environment; started flows first
const flowGetOp = () => I.allOps().find((x) => /^(getflowasadmin|getadminflow)$/.test(x.op.toLowerCase().replace(/[^a-z0-9]/g, ''))) ?? I.allOps().find((x) => x.method === 'GET' && /admin\/environments\/\{[^}/]+\}\/flows\/\{[^}/]+\}$/i.test(I.bare(x.path))) ?? null
const stopOp = () => I.allOps().find((x) => x.method === 'POST' && /admin\/environments\/\{[^}/]+\}\/flows\/\{[^}/]+\}\/stop$/i.test(I.bare(x.path))) ?? I.allOps().find((x) => /^stopflowasadmin$/.test(x.op.toLowerCase().replace(/[^a-z0-9]/g, ''))) ?? null

/** Agent flows and solution cloud flows live in Dataverse (workflow, category 5): their definition is in clientdata. Also fills gaps where "Get Flow as Admin" returned no definition. */
async function dataverseFlows(env: Env, have: Set<string>): Promise<{ flows: FlowDef[]; note?: string }> {
  const dv = await I.dvFor(env.id)
  if (!dv) return { flows: [], note: 'no Dataverse route - agent flows / solution flows here are unknown, not safe' }
  let rows: any[]; let typed = true
  try { rows = await dv('workflows', 'category eq 5', ['workflowid', 'name', 'clientdata', 'statecode', 'modernflowtype', 'modifiedon', '_ownerid_value'], 500) }
  catch { typed = false; rows = await dv('workflows', 'category eq 5', ['workflowid', 'name', 'clientdata', 'statecode', 'modifiedon', '_ownerid_value'], 500) }
  const out: FlowDef[] = []
  let bad = 0
  for (const r of rows) {
    const id = String(r.workflowid ?? '')
    if (!id || have.has(id.toLowerCase())) continue
    try {
      const j = typeof r.clientdata === 'string' ? JSON.parse(r.clientdata) : r.clientdata
      const def = j?.properties?.definition ?? j?.definition
      if (!def) { bad++; continue }
      const agent = typed && Number(r.modernflowtype) === 1
      out.push({ key: `flow:${env.id}:${id}`, id, name: `${r.name ?? id}`, envId: env.id, envName: env.name, state: Number(r.statecode) === 1 ? 'Started' : 'Stopped', ownerId: r._ownerid_value, modified: r.modifiedon, definition: def, agentFlow: agent, via: 'dataverse' })
    } catch { bad++ }
  }
  return { flows: out, note: `${out.length} agent/solution flow(s) read from Dataverse${typed ? '' : ' (agent-flow type column not available)'}${bad ? ` · ${bad} had no readable definition` : ''}` }
}

export async function liveScan(envs: Env[], onProgress: (d: number, t: number, l: string) => void) {
  const notes: { env: string; level: 'info' | 'warn' | 'error'; text: string }[] = []
  const flows: FlowDef[] = []
  const list = I.flowLists()[0]; const get = flowGetOp()
  if (!list) notes.push({ env: '(all)', level: 'error', text: 'No "list flows" operation - add Power Automate Management.' })
  if (!get) notes.push({ env: '(all)', level: 'error', text: 'No "get flow as admin" operation - flow definitions cannot be read.' })
  // The definition is only returned when asked for: find the right query parameter name from the connector schema.
  const incl = get?.params.find((p) => p.in === 'query' && /includeflowdefinition/i.test(p.name))?.name
  const expand = get?.params.find((p) => p.in === 'query' && /^\$?(expand|include)$/i.test(p.name))?.name
  let done = 0
  for (const env of envs) {
    onProgress(done++, envs.length, env.name)
    try {
      const { items } = list && get ? await I.callAll(list, [env.id]) : { items: [] as any[] }
      const sorted = [...items].sort((a, b) => Number(b.properties?.state === 'Started') - Number(a.properties?.state === 'Started'))
      const todo = sorted.slice(0, MAX_DEFS)
      let ok = 0, noDef = 0, fail = 0
      if (get) await I.mapLimit(todo, 4, async (f) => {
        try {
          const q: Record<string, unknown> = incl ? { [incl]: true } : expand ? { [expand]: 'properties.definition' } : {}
          const full = await I.callRaw(get!, [env.id, f.name], undefined, q)
          const def = full?.properties?.definition
          if (!def) { noDef++; return }
          ok++
          flows.push({ key: `flow:${env.id}:${f.name}`, id: f.name, name: f.properties?.displayName ?? f.name, envId: env.id, envName: env.name, state: full.properties?.state ?? f.properties?.state, ownerId: f.properties?.creator?.userId, modified: f.properties?.lastModifiedTime, definition: def })
        } catch (e) { fail++; log(`flow definition ${f.name}: ${(e as Error).message.slice(0, 140)}`) }
      })
      try {
        const dvr = await dataverseFlows(env, new Set(flows.filter((f) => f.envId === env.id).map((f) => f.id.toLowerCase())))
        flows.push(...dvr.flows)
        if (dvr.note) notes.push({ env: env.name, level: /unknown/.test(dvr.note) ? 'warn' : 'info', text: dvr.note })
      } catch (e) { notes.push({ env: env.name, level: 'warn', text: `Dataverse flows: ${(e as Error).message.slice(0, 200)}` }) }
      notes.push({ env: env.name, level: fail || noDef ? 'warn' : 'info', text: `${items.length} flow(s) listed · ${ok} definition(s) read${items.length > todo.length ? ` (first ${MAX_DEFS} only - started flows first)` : ''}${noDef ? ` · ${noDef} returned NO definition (parameter not accepted or solution flow) - their egress is unknown, not safe` : ''}${fail ? ` · ${fail} read(s) FAILED` : ''}` })
    } catch (e) { notes.push({ env: env.name, level: 'error', text: (e as Error).message }) }
  }
  onProgress(envs.length, envs.length, 'done')
  return { flows, notes }
}

/** Stop a flow as admin (turns the trigger off; nothing is deleted). Throws if the operation is not bound. */
export async function stopFlow(f: { envId: string; id: string }): Promise<boolean | null> {
  const op = stopOp(); if (!op) throw new Error('No "stop flow as admin" operation bound in this build (see 🩺). Stop it in the Power Automate admin center instead.')
  await I.call(op, [f.envId, f.id], {})
  try { const g = flowGetOp(); if (!g) return null; const now = await I.callRaw(g, [f.envId, f.id]); return /^stopped$/i.test(now?.properties?.state ?? '') } catch { return null }
}
export const stopBound = () => !!stopOp()
