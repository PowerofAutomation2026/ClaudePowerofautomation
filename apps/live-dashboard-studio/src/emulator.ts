/**
 * Client for the local DB emulator (apps/db-emulator): simulated SQL Server, Oracle and Teradata servers whose REST
 * endpoints are shaped like the Power Platform connectors. Inside Power Apps the same dashboards read through the real
 * connection (SDK); this client is for testing with big realistic data without a database.
 *
 *   GET  {url}/{engine}/datasets/{dataset}/tables                         list tables
 *   GET  {url}/{engine}/datasets/{dataset}/tables/{table}/items           OData: $filter $orderby $select $top $skiptoken
 *   POST {url}/{engine}/datasets/{dataset}/query/sql                      { query } -> { ResultSets: { Table1: [...] } }
 */
import type { DbQuery } from './sources'

export type EmuEngineId = 'sql' | 'oracle' | 'teradata'
export interface EmuRef { url: string; engine: EmuEngineId; dataset: string }
export interface EmuTable { name: string; rows: number; columns: number }
export interface EmuEngine { id: EmuEngineId; label: string; dialect: string; connector: string; dataset: string; tables: EmuTable[] }
export interface EmuHealth { engines: EmuEngine[]; live: { running: boolean; rate: number; ticks?: number; inserted?: number } | null; apiKeyRequired: boolean; size: string; pageSize: number }

export const DEFAULT_EMU_URL = 'http://127.0.0.1:3200'
const keys = new Map<string, string>()
const norm = (u: string) => u.trim().replace(/\/+$/, '')
export const setEmuKey = (url: string, key: string) => { if (key) keys.set(norm(url), key); else keys.delete(norm(url)) }

async function call(url: string, path: string, init: RequestInit = {}): Promise<any> {
  const base = norm(url)
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) }
  const k = keys.get(base)
  if (k) headers['x-api-key'] = k
  if (init.body) headers['content-type'] = 'application/json'
  let res: Response
  try { res = await fetch(path.startsWith('http') ? path : base + path, { ...init, headers }) }
  catch { throw new Error(`Cannot reach the emulator at ${base}. Start it (apps/db-emulator: npm start) and check the address.`) }
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  if (!res.ok) throw new Error(json?.error?.message ?? json?.message ?? `HTTP ${res.status} ${res.statusText}`)
  return json
}

export const emuHealth = (url: string): Promise<EmuHealth> => call(url, '/health')

const q = (obj: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== '') p.set(k, String(v))
  return p.toString()
}
const dsPath = (r: EmuRef) => `/${r.engine}/datasets/${encodeURIComponent(r.dataset)}`

/** One page of a table (same contract as the connector: rows + an opaque continuation token). */
export async function emuPage(ref: EmuRef, table: string, query: DbQuery, token: string | undefined, top: number): Promise<{ rows: Record<string, unknown>[]; token?: string }> {
  const qs = q({ $top: top, $filter: query.filter?.trim(), $orderby: query.orderBy?.trim(), $select: query.select?.trim(), $skiptoken: token })
  const j = await call(ref.url, `${dsPath(ref)}/tables/${encodeURIComponent(table)}/items?${qs}`)
  const next: string | undefined = j?.['@odata.nextLink'] ?? j?.nextLink
  const m = next ? /[?&](?:\$|%24)?skiptoken=([^&]+)/i.exec(next) : null
  return { rows: Array.isArray(j?.value) ? j.value : [], token: m ? decodeURIComponent(m[1]) : undefined }
}

export async function emuSql(ref: EmuRef, query: string): Promise<Record<string, unknown>[]> {
  const j = await call(ref.url, `${dsPath(ref)}/query/sql`, { method: 'POST', body: JSON.stringify({ query }) })
  const rows = j?.ResultSets?.Table1
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('The query returned no rows.')
  return rows
}

/** SQL examples in each engine's own dialect, for the dialog. */
export const EMU_SQL_EXAMPLES: Record<EmuEngineId, { dialect: string; sql: string }> = {
  sql: { dialect: 'T-SQL (SQL Server)', sql: "SELECT TOP 5000 AssignedTo, ClosedBy, State, Priority, Opened, ResolutionTimeHrs, MadeSLA\nFROM dbo.ServiceNowIncidents\nWHERE Opened >= DATEADD(day, -90, GETDATE())" },
  oracle: { dialect: 'Oracle SQL', sql: "SELECT TO_CHAR(ORDER_DATE, 'YYYY-MM-DD') AS DAY, STATUS, CURRENCY, COUNT(*) AS ORDERS, SUM(ORDER_TOTAL) AS TOTAL\nFROM SALES.ORDERS\nWHERE ORDER_DATE >= SYSDATE - 90\nGROUP BY TO_CHAR(ORDER_DATE, 'YYYY-MM-DD'), STATUS, CURRENCY" },
  teradata: { dialect: 'Teradata SQL', sql: "SEL TOP 5000 CAST(CALL_START_TS AS DATE) AS CALL_DAY, CALL_TYPE, NETWORK, COUNT(*) AS CALLS, SUM(REVENUE_AMT) AS REVENUE\nFROM EDW_PROD.CALL_DETAIL_FACT\nWHERE CALL_START_TS >= CURRENT_DATE - 30\nGROUP BY 1, 2, 3" },
}
