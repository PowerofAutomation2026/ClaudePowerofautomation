/**
 * Live data: the three Outage Watch tables in the Dataverse of the environment this code app runs in.
 * Same access pattern as the repository's existing code app (Ownership Command Center): the tables are added with
 * `pac code add-data-source -a dataverse -t <table>`, which generates `.power/schemas/appschemas/dataSourcesInfo.ts`;
 * rows are read with the code-apps SDK (`getClient(...).retrieveMultipleRecordsAsync`). The dashboard writes exactly
 * one thing: a row in owatch_command when an admin presses "Send test notification now" (createRecordAsync).
 */
import { getClient } from '@microsoft/power-apps/data'
import { getContext } from '@microsoft/power-apps/app'
import { COMMAND_NAME, cleanNote } from '../logic/notify'
import catalog from '../../shared/catalog.json'
import { parseAliveCodes, type RawRow } from '../logic/classify'
import type { DataSource, IncidentRow, Notifier, Snapshot, TargetRow } from './types'

/* eslint-disable @typescript-eslint/no-explicit-any */
const infoModules = import.meta.glob('../../.power/schemas/appschemas/dataSourcesInfo.ts', { eager: true }) as Record<string, any>

function loadInfo(): Record<string, any> {
  const mod = Object.values(infoModules)[0]
  if (!mod) return {}
  if (mod.dataSourcesInfo) return mod.dataSourcesInfo
  if (mod.default && typeof mod.default === 'object') return mod.default.dataSourcesInfo ?? mod.default
  const firstObj = Object.values(mod).find((v) => v && typeof v === 'object')
  return (firstObj as any) ?? {}
}
const dataSourcesInfo = loadInfo()

/** True once the deploy script has added the Dataverse tables (i.e. this is a deployed build). */
export const hasDataverse = Object.keys(dataSourcesInfo).length > 0

/** pac names data sources by display name, so find each table by what it IS (primary key / logical name). */
function tableKey(logical: string): string {
  const entries = Object.entries<any>(dataSourcesInfo)
  const hit =
    entries.find(([, i]) => i?.primaryKey === logical + 'id') ??
    entries.find(([, i]) => i?.logicalName === logical || String(i?.entitySetName ?? '').startsWith(logical)) ??
    entries.find(([k]) => k.toLowerCase().replace(/[^a-z]/g, '').includes(logical.replace(/[^a-z]/g, '')))
  if (!hit) throw new Error(`The table ${logical} is not part of this build. Re-run Deploy-OutageWatchPP.`)
  return hit[0]
}

let cached: ReturnType<typeof getClient> | null = null
const sdk = () => (cached ??= getClient(dataSourcesInfo as any))

async function readAll(logical: string, options: { select: string[]; filter?: string; orderBy?: string[]; top?: number }): Promise<any[]> {
  const r: any = await sdk().retrieveMultipleRecordsAsync<any>(tableKey(logical), options)
  if (!r?.success) throw new Error(String(r?.error?.message ?? `Dataverse query failed (${logical})`).slice(0, 300))
  return Array.isArray(r.data) ? r.data : []
}

const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : v == null || v === '' ? NaN : Number(v); return Number.isFinite(n) ? n : null }
const text = (v: unknown, max: number): string => (v == null ? '' : String(v).slice(0, max))
const bool = (v: unknown): boolean => v === true || v === 1 || v === 'true'
const FAMILY_OF = new Map<string, string>([...catalog.targets, ...catalog.tenantTargets].map((t) => [t.name, t.family]))
/** Targets renamed since the 15-target version. Old result rows keep the old name; they are shown under the new one. */
const RENAMED: Record<string, string> = catalog.renamed
const current = (name: string) => (Object.prototype.hasOwnProperty.call(RENAMED, name) ? RENAMED[name] : name)

/**
 * A target row becomes one of three things:
 *   URL + enabled   -> probed by the flow
 *   no URL          -> "unconfigured" (tenant name not given): shown, neutral, never a failure
 *   URL + disabled  -> switched off by an admin: not shown at all
 */
export function toTargets(rows: any[]): TargetRow[] {
  const out: TargetRow[] = []
  const seen = new Set<string>()
  for (const x of rows) {
    if (!x?.owatch_name) continue
    const name = text(x.owatch_name, 100)
    const url = text(x.owatch_url, 500).trim()
    const enabled = x.owatch_enabled === undefined || x.owatch_enabled === null ? true : bool(x.owatch_enabled)
    if (seen.has(name) || (url && !enabled)) continue
    seen.add(name)
    out.push({
      name, url, alive: parseAliveCodes(x.owatch_alivecodes), dependsOnAuth: bool(x.owatch_dependsonauth), copilotNeeds: bool(x.owatch_copilotneeds),
      family: text(x.owatch_family, 100).trim() || FAMILY_OF.get(name) || 'Independent', enabled: !!url && enabled, unconfigured: !url,
    })
  }
  return out
}

const TARGET_COLS = ['owatch_name', 'owatch_url', 'owatch_alivecodes', 'owatch_dependsonauth', 'owatch_copilotneeds', 'owatch_enabled']
/** The family column was added in schema version 2; a dashboard deployed before its tables were upgraded still works. */
async function readTargets(): Promise<any[]> {
  try { return await readAll('owatch_target', { select: [...TARGET_COLS, 'owatch_family'], top: 200 }) }
  catch { return readAll('owatch_target', { select: TARGET_COLS, top: 200 }) }
}

/** Incident history. The table arrived with the alert feature: a dashboard on older tables simply shows none. */
async function readIncidents(): Promise<IncidentRow[]> {
  try {
    const rows = await readAll('owatch_incident', { select: ['owatch_name', 'owatch_family', 'owatch_isopen', 'owatch_openedat', 'owatch_closedat', 'owatch_durationminutes', 'owatch_failedrounds', 'owatch_reminders', 'owatch_firsterror'], orderBy: ['owatch_openedat desc'], top: 200 })
    return rows.filter((x) => x?.owatch_name).map((x) => ({
      name: text(x.owatch_name, 100), family: text(x.owatch_family, 100), open: bool(x.owatch_isopen), openedAt: text(x.owatch_openedat, 40),
      closedAt: bool(x.owatch_isopen) ? null : text(x.owatch_closedat, 40), minutes: num(x.owatch_durationminutes) ?? 0, rounds: num(x.owatch_failedrounds) ?? 0,
      reminders: num(x.owatch_reminders) ?? 0, error: text(x.owatch_firsterror, 500),
    }))
  } catch { return [] }
}

const hasTable = (logical: string) => { try { tableKey(logical); return true } catch { return false } }

/** The button's write path. Errors keep the Dataverse wording (bounded) so a 403 can be recognised and explained. */
function liveNotifier(): Notifier {
  const table = () => tableKey('owatch_command')
  const fail = (r: any, what: string) => new Error(String(r?.error?.message ?? r?.error ?? what).slice(0, 300))
  return {
    async request(channels, note) {
      let by = ''
      try { const c: any = await getContext(); by = text(c?.user?.fullName || c?.user?.userPrincipalName, 100) } catch { by = '' }
      const stamp = new Date().toISOString()
      const r: any = await sdk().createRecordAsync<any, any>(table(), { owatch_name: COMMAND_NAME, owatch_channels: text(channels, 100), owatch_note: cleanNote(note), owatch_requestedby: by || 'dashboard user', owatch_status: 'queued' })
      if (!r?.success) throw fail(r, 'The request could not be created')
      const id = text(r?.data?.owatch_commandid, 40)
      if (/^[0-9a-f-]{36}$/i.test(id)) return id
      // the create did not return the row: find the one just written
      const rows = await readAll('owatch_command', { select: ['owatch_commandid'], filter: `owatch_name eq '${COMMAND_NAME}' and createdon ge ${stamp}`, orderBy: ['createdon desc'], top: 1 })
      const found = text(rows[0]?.owatch_commandid, 40)
      if (!/^[0-9a-f-]{36}$/i.test(found)) throw new Error('The request was created but could not be read back')
      return found
    },
    async poll(id) {
      const r: any = await sdk().retrieveRecordAsync<any>(table(), id, { select: ['owatch_status', 'owatch_result'] })
      if (!r?.success) throw fail(r, 'The request could not be read')
      return { status: text(r.data?.owatch_status, 40), result: text(r.data?.owatch_result, 400) }
    },
  }
}

export function liveSource(hoursBack = 12): DataSource {
  return {
    kind: 'live',
    notifier: hasTable('owatch_command') ? liveNotifier() : undefined,
    async load(): Promise<Snapshot> {
      const since = new Date(Date.now() - hoursBack * 3_600_000).toISOString()
      const [t, s, r] = await Promise.all([
        readTargets(),
        readAll('owatch_setting', { select: ['owatch_name', 'owatch_value'], top: 100 }),
        readAll('owatch_result', { select: ['owatch_name', 'owatch_httpstatus', 'owatch_elapsedms', 'owatch_errorkind', 'owatch_probedat', 'owatch_round'], filter: `owatch_probedat ge ${since}`, orderBy: ['owatch_probedat desc'], top: 5000 }),
      ])
      const targets = toTargets(t)
      const settings: Record<string, string> = {}
      for (const x of s) if (x?.owatch_name) settings[text(x.owatch_name, 100)] = text(x.owatch_value, 4000)
      const rows: RawRow[] = []
      for (const x of r) {
        const ms = Date.parse(String(x?.owatch_probedat ?? ''))
        if (!x?.owatch_name || !Number.isFinite(ms)) continue          // a row without a name or a readable time is ignored
        rows.push({
          name: current(text(x.owatch_name, 100)), httpStatus: num(x.owatch_httpstatus), elapsedMs: num(x.owatch_elapsedms) ?? 0,
          errorKind: text(x.owatch_errorkind, 100), at: new Date(ms).toISOString(), round: text(x.owatch_round, 40),
        })
      }
      return { targets, settings, rows, incidents: await readIncidents() }
    },
  }
}
