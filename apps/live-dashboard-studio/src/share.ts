/**
 * Sharing dashboards with other people.
 *
 * What is shared: the dashboard's layout, filters and where its data comes from (database table / query, file location),
 * and optionally a snapshot of the data for files and pasted data. Data access stays personal: people who open a shared
 * database dashboard read it through THEIR OWN connection, so they need access to that database.
 *
 * Backends (where shared dashboards are stored):
 *   emulator    apps/db-emulator /shares (per-user permissions enforced by the server: for testing)
 *   sharepoint  one small JSON file per dashboard in a SharePoint library folder; real access control is the folder's
 *               SharePoint permissions (the people list in the file only drives what this app shows). EXPERIMENTAL.
 * Also: share link (a self-contained link holding the layout) and layout export / import.
 */
import { emuCall } from './emulator'
import { normOp, sdkExecute, sdkOps } from './sources'
import type { Column, DateRange, Filter, Row, Widget } from './engine'
import type { SourceDef } from './store'

export type Permission = 'owner' | 'edit' | 'view'
export interface ShareEntry { user: string; permission: 'view' | 'edit' }
export interface SharedDefinition { name: string; source: SourceDef; widgets: Widget[]; filters: Filter[]; range: DateRange | null }
export interface Snapshot { columns: Column[]; rows: Row[] }
export interface SharedSummary {
  id: string; name: string; owner: string; permission: Permission; updated: string; updatedBy: string; version: number
  everyone: 'none' | 'view' | 'edit'; hasSnapshot: boolean; sourceKind: string | null; sharedWith?: ShareEntry[]
}
export interface SharedFull extends SharedSummary { definition: SharedDefinition; snapshot: Snapshot | null }
export interface PublishInput { name: string; definition: SharedDefinition; sharedWith: ShareEntry[]; everyone: 'none' | 'view' | 'edit'; snapshot?: Snapshot | null }
export interface UpdateInput { name?: string; definition?: SharedDefinition; snapshot?: Snapshot | null; sharedWith?: ShareEntry[]; everyone?: 'none' | 'view' | 'edit'; baseVersion?: number }

export interface ShareBackend {
  label: string
  list(): Promise<SharedSummary[]>
  get(id: string): Promise<SharedFull>
  create(input: PublishInput): Promise<SharedFull>
  update(id: string, input: UpdateInput): Promise<SharedFull>
  remove(id: string): Promise<void>
}
export type ShareConfig = { kind: 'emulator'; url: string } | { kind: 'sharepoint'; site: string; folder: string }

/* ------------------------------------------------------------------ identity */
export interface Me { email: string; name: string; source: 'powerapps' | 'dev' }
const DEV_KEY = 'lds.devUser'
export const getDevUser = (): string => { try { return localStorage.getItem(DEV_KEY) || 'you@example.com' } catch { return 'you@example.com' } }
export const setDevUser = (e: string) => { try { localStorage.setItem(DEV_KEY, e.trim().toLowerCase()) } catch { /* ignore */ } }
export async function getMe(): Promise<Me> {
  try {
    const { getContext } = await import('@microsoft/power-apps/app')
    const u = (await getContext())?.user
    const email = (u?.userPrincipalName ?? '').toLowerCase()
    if (email) return { email, name: u?.fullName || email, source: 'powerapps' }
  } catch { /* not inside Power Apps */ }
  const e = getDevUser()
  return { email: e, name: e, source: 'dev' }
}

/* --------------------------------------------------------------- permissions */
export interface StoredShare { id: string; name: string; owner: string; definition: SharedDefinition; snapshot: Snapshot | null; sharedWith: ShareEntry[]; everyone: 'none' | 'view' | 'edit'; version: number; created: string; updated: string; updatedBy: string }
export function permissionOf(rec: Pick<StoredShare, 'owner' | 'sharedWith' | 'everyone'>, email: string): Permission | null {
  if (rec.owner === email) return 'owner'
  const p = rec.sharedWith.find((s) => s.user === email)?.permission
  if (p) return p
  return rec.everyone === 'view' || rec.everyone === 'edit' ? rec.everyone : null
}

export const parsePeople = (text: string): { ok: string[]; bad: string[] } => {
  const parts = text.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean)
  const ok = [...new Set(parts.filter((p) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p)))]
  return { ok, bad: parts.filter((p) => !ok.includes(p)) }
}

/* ------------------------------------------------------------ emulator backend */
export class EmulatorShareBackend implements ShareBackend {
  label: string
  constructor(private url: string, private me: () => string) { this.label = `Emulator (${url})` }
  private call(path: string, init: RequestInit = {}) { return emuCall(this.url, path, init, { 'x-user': this.me() }) }
  async list() { return (await this.call('/shares')).value as SharedSummary[] }
  get(id: string) { return this.call(`/shares/${id}`) as Promise<SharedFull> }
  create(input: PublishInput) { return this.call('/shares', { method: 'POST', body: JSON.stringify(input) }) as Promise<SharedFull> }
  update(id: string, input: UpdateInput) { return this.call(`/shares/${id}`, { method: 'PUT', body: JSON.stringify(input) }) as Promise<SharedFull> }
  async remove(id: string) { await this.call(`/shares/${id}`, { method: 'DELETE' }) }
}

/* ---------------------------------------------------------- SharePoint backend */
const fileOpsFor = () => {
  const ops = sdkOps().filter((o) => /sharepoint/i.test(o.ds))
  const find = (...n: string[]) => ops.find((o) => n.includes(normOp(o.op)))
  const need = { list: find('listfolder', 'getfolderchildren', 'getfolderchildrenv2'), read: find('getfilecontentbypath', 'getfilecontent'), create: find('createfile'), update: find('updatefile'), del: find('deletefile') }
  const missing = Object.entries(need).filter(([, v]) => !v).map(([k]) => ({ list: 'List folder', read: 'Get file content using path', create: 'Create file', update: 'Update file', del: 'Delete file' } as Record<string, string>)[k])
  if (missing.length) throw new Error(`The SharePoint connection of this app lacks these operations: ${missing.join(', ')}. Re-run the deploy script with -SharePoint (README, "Sharing").`)
  return need as Record<'list' | 'read' | 'create' | 'update' | 'del', ReturnType<typeof sdkOps>[number]>
}
const textFrom = (data: any): string => {
  if (typeof data === 'string') { try { return decodeURIComponent(escape(atob(data))) } catch { return data } }
  const b64 = data?.$content ?? data?.content
  if (typeof b64 === 'string') { try { return decodeURIComponent(escape(atob(b64))) } catch { return b64 } }
  if (data && typeof data === 'object') return JSON.stringify(data)
  throw new Error('Unexpected file content from SharePoint')
}

export class SharePointShareBackend implements ShareBackend {
  label: string
  constructor(private site: string, private folder: string, private me: () => string) { this.label = `SharePoint ${folder}` }
  private async files(): Promise<{ id: string; name: string; path: string }[]> {
    const ops = fileOpsFor()
    const res = await sdkExecute(ops.list, { dataset: this.site, id: this.folder, folderPath: this.folder })
    const items: any[] = Array.isArray(res) ? res : res?.value ?? []
    return items.filter((x) => /\.lds\.json$/i.test(x.Name ?? x.name ?? '')).map((x) => ({ id: x.Id ?? x.id ?? x.ItemId, name: x.Name ?? x.name, path: x.Path ?? x.path ?? `${this.folder}/${x.Name ?? x.name}` }))
  }
  private async read(path: string): Promise<StoredShare> {
    return JSON.parse(textFrom(await sdkExecute(fileOpsFor().read, { dataset: this.site, path, inferContentType: false })))
  }
  private summary(r: StoredShare): SharedSummary {
    const permission = permissionOf(r, this.me())!
    return { id: r.id, name: r.name, owner: r.owner, permission, updated: r.updated, updatedBy: r.updatedBy, version: r.version, everyone: r.everyone, hasSnapshot: !!r.snapshot, sourceKind: r.definition?.source?.kind ?? null, sharedWith: permission === 'owner' ? r.sharedWith : undefined }
  }
  private async find(id: string) {
    const f = (await this.files()).find((x) => x.name.startsWith(id + '.'))
    if (!f) throw new Error('Dashboard not found')
    return { file: f, rec: await this.read(f.path) }
  }
  async list() {
    const out: SharedSummary[] = []
    for (const f of await this.files()) { try { const r = await this.read(f.path); if (permissionOf(r, this.me())) out.push(this.summary(r)) } catch { /* unreadable file: skip */ } }
    return out.sort((a, b) => b.updated.localeCompare(a.updated))
  }
  async get(id: string) { const { rec } = await this.find(id); if (!permissionOf(rec, this.me())) throw new Error('Dashboard not found'); return { ...this.summary(rec), definition: rec.definition, snapshot: rec.snapshot } }
  async create(input: PublishInput) {
    const me = this.me(), now = new Date().toISOString()
    const rec: StoredShare = { id: crypto.randomUUID().replace(/-/g, '').slice(0, 16), name: input.name, owner: me, definition: input.definition, snapshot: input.snapshot ?? null, sharedWith: input.sharedWith.filter((s) => s.user !== me), everyone: input.everyone, version: 1, created: now, updated: now, updatedBy: me }
    await sdkExecute(fileOpsFor().create, { dataset: this.site, folderPath: this.folder, name: `${rec.id}.lds.json`, body: JSON.stringify(rec) })
    return { ...this.summary(rec), definition: rec.definition, snapshot: rec.snapshot }
  }
  async update(id: string, input: UpdateInput) {
    const me = this.me(), { file, rec } = await this.find(id), perm = permissionOf(rec, me)
    if (!perm) throw new Error('Dashboard not found')
    if (perm === 'view') throw new Error('You can view this dashboard but not change it')
    if ((input.sharedWith !== undefined || input.everyone !== undefined) && perm !== 'owner') throw new Error('Only the owner can change who it is shared with')
    if ((input.definition !== undefined || input.snapshot !== undefined || input.name !== undefined) && input.baseVersion !== rec.version) throw new Error(`Version conflict: someone else saved version ${rec.version} first. Reload and try again.`)
    const next: StoredShare = { ...rec, name: input.name ?? rec.name, definition: input.definition ?? rec.definition, snapshot: input.snapshot !== undefined ? input.snapshot : rec.snapshot, sharedWith: input.sharedWith ? input.sharedWith.filter((s) => s.user !== rec.owner) : rec.sharedWith, everyone: input.everyone ?? rec.everyone, version: rec.version + 1, updated: new Date().toISOString(), updatedBy: me }
    await sdkExecute(fileOpsFor().update, { dataset: this.site, id: file.id, body: JSON.stringify(next) })
    return { ...this.summary(next), definition: next.definition, snapshot: next.snapshot }
  }
  async remove(id: string) {
    const { file, rec } = await this.find(id)
    if (rec.owner !== this.me()) throw new Error('Only the owner can stop sharing and delete it')
    await sdkExecute(fileOpsFor().del, { dataset: this.site, id: file.id })
  }
}

export function makeBackend(cfg: ShareConfig, me: () => string): ShareBackend {
  return cfg.kind === 'emulator' ? new EmulatorShareBackend(cfg.url, me) : new SharePointShareBackend(cfg.site, cfg.folder, me)
}

/* ------------------------------------------------------------------ share link */
const b64url = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64url = (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))))
export const encodeLayout = (d: SharedDefinition) => b64url(JSON.stringify({ lds: 1, ...d }))
export function decodeLayout(text: string): SharedDefinition {
  const j = JSON.parse(unb64url(text.trim()))
  if (j?.lds !== 1 || !Array.isArray(j.widgets) || !j.source) throw new Error('That is not a Live Dashboard Studio share link.')
  return { name: String(j.name ?? 'Shared dashboard'), source: j.source, widgets: j.widgets, filters: j.filters ?? [], range: j.range ?? null }
}
