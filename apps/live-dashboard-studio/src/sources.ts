/**
 * Data sources: local files (CSV / TSV / JSON / XLSX), pasted text, database tables through the Power Apps
 * data SDK (SQL Server, Oracle, Dataverse ... added with `pac code add-data-source`), and a simulated live source.
 * No Azure app registration: database calls run on the signed-in user's own connector connection.
 */
import { datasetFromText, datasetFromTextAsync, fromMatrixAsync, fromObjects, fromObjectsAsync, makeDemoOrders } from './engine'
import type { Dataset, Progress } from './engine'

export const MAX_FILE_BYTES = 60 * 1024 * 1024

/* -------------------------------------------------------------------- files */

export interface FileRead { dataset: Dataset; sheets?: string[]; sheet?: string }

export async function readFile(file: File, sheet?: string, onProgress?: Progress): Promise<FileRead> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is larger than 60 MB.`)
  const name = file.name
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'pdf') throw new Error('PDF files cannot be read directly. Export the table from the PDF to CSV or Excel, or paste the text.')
  if (ext === 'xls') throw new Error('Old .xls files are not supported. Save the file as .xlsx or .csv and add it again.')
  if (ext === 'xlsx') {
    onProgress?.(0.05, `Reading Excel file… ${(file.size / 1e6).toFixed(1)} MB (large workbooks can take a while)`)
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const mod: any = await import('read-excel-file')
    const sheets: string[] = await mod.readSheetNames(file)
    const chosen = sheet && sheets.includes(sheet) ? sheet : sheets[0]
    const rows: unknown[][] = await mod.default(file, { sheet: chosen })
    const trimmed = rows.filter((r) => r.some((c) => c !== null && c !== undefined && String(c).trim() !== ''))
    onProgress?.(0.4, 'Building the dashboard data…')
    return { dataset: await fromMatrixAsync(sheets.length > 1 ? `${name} · ${chosen}` : name, trimmed, onProgress), sheets, sheet: chosen }
  }
  onProgress?.(0.02, `Reading ${(file.size / 1e6).toFixed(1)} MB…`)
  const text = await file.text()
  return { dataset: await datasetFromTextAsync(name, text, onProgress) }
}

export const readPasted = (text: string, name = 'Pasted data') => datasetFromText(name, text)

/** File System Access API (Chromium): lets the app re-read the same local file whenever it changes. */
export interface WatchHandle { getFile(): Promise<File> }
export const canWatchFiles = () => typeof (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker === 'function'
export async function pickWatchableFile(): Promise<WatchHandle | null> {
  try {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const [h] = await (window as any).showOpenFilePicker({
      multiple: false,
      types: [{ description: 'Data files', accept: { 'text/csv': ['.csv', '.tsv', '.txt'], 'application/json': ['.json'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }],
    })
    return h as WatchHandle
  } catch { return null }   // user cancelled or the browser blocked it inside the app frame
}

/* ---------------------------------------------------------------- databases */

/* eslint-disable @typescript-eslint/no-explicit-any */
const infoModules = import.meta.glob('../.power/schemas/appschemas/dataSourcesInfo.ts', { eager: true }) as Record<string, any>
function loadInfo(): Record<string, any> {
  const mod = Object.values(infoModules)[0]
  if (!mod) return {}
  if (mod.dataSourcesInfo) return mod.dataSourcesInfo
  if (mod.default && typeof mod.default === 'object') return mod.default.dataSourcesInfo ?? mod.default
  return (Object.values(mod).find((v) => v && typeof v === 'object') as any) ?? {}
}
const dataSourcesInfo = loadInfo()

export type DbKind = 'sql' | 'oracle' | 'dataverse' | 'table' | 'demo'
export interface DbSource { key: string; label: string; kind: DbKind; tableId?: string }

function kindOf(key: string, info: any): DbKind {
  const s = `${info?.dataSourceType ?? ''} ${info?.tableId ?? ''} ${key}`.toLowerCase()
  if (/oracle/.test(s)) return 'oracle'
  if (/dataverse|commondataservice|cds/.test(s)) return 'dataverse'
  if (/\bsql\b|sqlserver|shared_sql|\[dbo\]|\bdbo\b/.test(s)) return 'sql'
  return 'table'
}

export const DEMO_KEY = 'demo:orders'

export function listDbSources(): DbSource[] {
  const real: DbSource[] = Object.entries<any>(dataSourcesInfo)
    .filter(([, info]) => info && info.tableId)
    .map(([key, info]) => ({ key, label: key, kind: kindOf(key, info), tableId: String(info.tableId) }))
  return [...real, { key: DEMO_KEY, label: 'Demo orders (simulated, changes every refresh)', kind: 'demo' }]
}

export function describeConnectors() {
  const entries = Object.entries<any>(dataSourcesInfo)
  return {
    inPowerApps: entries.length > 0,
    tables: entries.filter(([, i]) => i?.tableId).map(([k, i]) => ({ key: k, kind: kindOf(k, i), tableId: String(i.tableId) })),
    connectors: entries.filter(([, i]) => !i?.tableId).map(([k, i]) => ({ key: k, operations: Object.keys(i?.apis ?? {}).length })),
  }
}

let cachedClient: any = null
async function client() {
  if (cachedClient) return cachedClient
  const sdk = await import('@microsoft/power-apps/data')
  cachedClient = sdk.getClient(dataSourcesInfo as any)
  return cachedClient
}

export interface DbQuery { top: number; filter?: string; orderBy?: string; select?: string }

const dropMeta = (r: Record<string, unknown>) => {
  const o: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(r)) if (!k.startsWith('@') && !k.includes('@OData') && k !== '__metadata') o[k] = v
  return o
}

function errText(e: any): string {
  const raw = String(e?.message ?? e ?? 'Unknown error')
  try {
    const a = raw.indexOf('{'), b = raw.lastIndexOf('}')
    if (a >= 0 && b > a) { const j = JSON.parse(raw.slice(a, b + 1)); const er = j?.error ?? j; return [er?.message, typeof er?.innerError === 'string' ? er.innerError : er?.innerError?.message].filter(Boolean).join(' - ') || raw }
  } catch { /* not JSON */ }
  return raw
}

/** Read rows of a table-like data source (SQL Server, Oracle, Dataverse ...), paging until `top` rows. */
export async function fetchTable(key: string, q: DbQuery): Promise<Record<string, unknown>[]> {
  if (key === DEMO_KEY) return fetchSimulated()
  const c = await client()
  const out: Record<string, unknown>[] = []
  let token: string | undefined
  for (let page = 0; page < 200 && out.length < q.top; page++) {
    const left = q.top - out.length
    const res: any = await c.retrieveMultipleRecordsAsync(key, {
      top: Math.min(left, 5000), maxPageSize: Math.min(left, 5000),
      filter: q.filter?.trim() || undefined,
      orderBy: q.orderBy?.trim() ? q.orderBy.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      select: q.select?.trim() ? q.select.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      skipToken: token,
    })
    if (!res?.success) throw new Error(errText(res?.error))
    const data: any[] = Array.isArray(res.data) ? res.data : (res.data?.value ?? [])
    out.push(...data.map(dropMeta))
    token = res.skipToken
    if (!token || data.length === 0) break
  }
  if (out.length === 0) throw new Error('The query returned no rows.')
  return out
}

/* Raw SQL (SQL Server "Execute a SQL query"): only if that operation was added to the app. Experimental. */
export interface SqlQuery { server: string; database: string; query: string }
export async function runSqlQuery(q: SqlQuery): Promise<Record<string, unknown>[]> {
  if (!/^\s*(select|with)\b/i.test(q.query)) throw new Error('Only SELECT (or WITH ... SELECT) statements are allowed.')
  if (/;\s*\S/.test(q.query.trim().replace(/;$/, ''))) throw new Error('Use a single statement.')
  const ops: { ds: string; op: string; def: any }[] = []
  for (const [ds, info] of Object.entries<any>(dataSourcesInfo)) for (const [op, def] of Object.entries<any>(info?.apis ?? {})) ops.push({ ds, op, def })
  const hit = ops.find((o) => /^executesqlquery(v2)?$/i.test(o.op.replace(/[^a-z0-9]/gi, ''))) ?? ops.find((o) => /\/query\/sql$/i.test(String(o.def.path).split('?')[0]))
  if (!hit) throw new Error('This app has no "Execute a SQL query" operation. Add the SQL Server connection again with that operation, or read a table instead (see README, Database sources).')
  const params: Record<string, unknown> = {}
  for (const p of hit.def.parameters ?? []) {
    const n = String(p.name).toLowerCase()
    if (p.in === 'body') params[p.name] = { query: q.query }
    else if (n === 'server') params[p.name] = q.server
    else if (n === 'database' || n === 'db') params[p.name] = q.database
    else if (n === 'dataset') params[p.name] = `${q.server},${q.database}`
    else if (p.in === 'header' && /content-?type/i.test(p.name)) params[p.name] = 'application/json'
  }
  const c = await client()
  const res: any = await c.executeAsync({ connectorOperation: { tableName: hit.ds, operationName: hit.op, parameters: params } })
  if (!res?.success) throw new Error(errText(res?.error))
  const d = res.data
  const rows = d?.ResultSets?.Table1 ?? d?.resultsets?.Table1 ?? d?.value ?? (Array.isArray(d) ? d : null)
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('The query returned no rows.')
  return rows.map(dropMeta)
}

/* ---------------------------------------------------------------- simulated */

let sim: Record<string, unknown>[] | null = null
let simSeed = 11
const R = ['North', 'South', 'East', 'West', 'Central'], P = ['Widget', 'Gadget', 'Gizmo', 'Doohickey'], C = ['Online', 'Retail', 'Partner']
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)]
export async function fetchSimulated(): Promise<Record<string, unknown>[]> {
  await new Promise((r) => setTimeout(r, 150))
  if (!sim) sim = makeDemoOrders(400, simSeed)
  else {
    const n = 3 + Math.floor(Math.random() * 7)
    const today = new Date().toISOString().slice(0, 10)
    let id = 1000 + sim.length
    for (let i = 0; i < n; i++) {
      const units = 1 + Math.floor(Math.random() * 12), price = 10 + Math.floor(Math.random() * 4) * 15
      sim.push({ OrderId: id++, OrderDate: today, Region: pick(R), Product: pick(P), Channel: pick(C), Units: units, UnitPrice: price, Revenue: units * price })
    }
  }
  return sim.map((r) => ({ ...r }))
}
export const resetSimulated = () => { sim = null; simSeed++ }
export { fromObjects, fromObjectsAsync, datasetFromText }
