/** Saves dashboard definitions (localStorage) and file data (IndexedDB) in this browser. Every call is wrapped: storage can be blocked. */
import { MAX_SAVED_ROWS } from './engine'
import type { DateRange, Dataset, Filter, Widget } from './engine'
import type { FileLoc } from './files'
import type { Permission, ShareConfig } from './share'

export interface SourceDef {
  kind: 'file' | 'paste' | 'db' | 'sql' | 'demo'
  fileName?: string
  sheet?: string
  dbKey?: string
  dbKind?: string
  top?: number
  filter?: string
  orderBy?: string
  select?: string
  sqlServer?: string
  sqlDatabase?: string
  sqlQuery?: string
  loc?: FileLoc                       // file on a server / SharePoint / OneDrive: checked every watchSec seconds and reloaded when it changes
  watchSec?: number
  via?: 'sdk' | 'emulator'            // database sources: Power Apps connection (default) or the local emulator
  emuUrl?: string
  engine?: 'sql' | 'oracle' | 'teradata'
  dataset?: string
  refreshSec: number       // 0 = manual
}
/** A dashboard that also exists in the shared store. `syncedJson` is what the shared copy looked like at the last sync (to detect local edits). */
export interface SharedLink { id: string; owner: string; permission: Permission; version: number; syncedJson: string; updatedBy?: string }
export interface DashboardDef {
  id: string
  name: string
  source: SourceDef
  widgets: Widget[]
  filters: Filter[]
  range: DateRange | null
  shared?: SharedLink
  created: number
  updated: number
}

const KEY = 'lds.dashboards.v1'
const PREF = 'lds.prefs.v1'
let memory: DashboardDef[] = []

export function loadDashboards(): DashboardDef[] {
  try { const j = JSON.parse(localStorage.getItem(KEY) ?? 'null'); if (Array.isArray(j)) { memory = j; return j } } catch { /* blocked or corrupt */ }
  return memory
}
export function saveDashboards(list: DashboardDef[]): boolean {
  memory = list
  try { localStorage.setItem(KEY, JSON.stringify(list)); return true } catch { return false }
}
export interface Prefs { theme?: 'light' | 'dark'; share?: ShareConfig }
export function loadPrefs(): Prefs {
  try { return JSON.parse(localStorage.getItem(PREF) ?? '{}') } catch { return {} }
}
export function savePrefs(p: Prefs) { try { localStorage.setItem(PREF, JSON.stringify({ ...loadPrefs(), ...p })) } catch { /* ignore */ } }

/* IndexedDB for datasets of file sources (can be large) */
const DB = 'lds', STORE = 'datasets'
function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    if (typeof indexedDB === 'undefined') return rej(new Error('no indexedDB'))
    const r = indexedDB.open(DB, 1)
    r.onupgradeneeded = () => r.result.createObjectStore(STORE)
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}
/** Returns false when the dataset is too big to save (saving 100k+ rows would freeze the page). */
export async function putDataset(id: string, ds: Dataset): Promise<boolean> {
  if (ds.rows.length > MAX_SAVED_ROWS) { await delDataset(id); return false }
  try { const db = await open(); await new Promise<void>((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(ds, id); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error) }); return true } catch { return false }
}
export async function getDataset(id: string): Promise<Dataset | null> {
  try { const db = await open(); return await new Promise((res, rej) => { const q = db.transaction(STORE).objectStore(STORE).get(id); q.onsuccess = () => res((q.result as Dataset) ?? null); q.onerror = () => rej(q.error) }) } catch { return null }
}
export async function delDataset(id: string): Promise<void> {
  try { const db = await open(); await new Promise<void>((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(id); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error) }) } catch { /* ignore */ }
}
