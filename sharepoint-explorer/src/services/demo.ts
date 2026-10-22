/** Demo backend: a fake tenant with a 2,000,000-row list so the whole UI can be tried (and stress-tested) in a browser. */
import type { Access, AppConfig, Attachment, Backend, PermInfo, PermTarget, Principal, RoleAssign, RoleDef, VersionInfo, Page, Query, Role, Row, SourceConfig, SpField, SpList, ViewDef } from '../types'
import { accessFrom, PERM } from '../access'
import { emptyQuery, isFolderMode, matchRow, searchTokens } from '../query'
import { lsGet, lsSet, sleep } from '../util'

const DOCS_ROOT = '/sites/demo/Policies'
const SITE = 'https://contoso.sharepoint.com/sites/demo'
const STATUS = ['Not started', 'In progress', 'Blocked', 'In review', 'Done', 'Cancelled']
const PRIORITY = ['Low', 'Medium', 'High', 'Critical']
const REGION = ['EMEA', 'North America', 'APAC', 'LATAM']
const DEPT = ['Finance', 'HR', 'Legal', 'Engineering', 'Sales', 'Operations']
const PEOPLE = ['Ava Thompson', 'Liam Chen', 'Noor Hassan', 'Mateo García', 'Sofia Rossi', 'Kenji Tanaka', 'Priya Patel', 'Emma Larsson', 'Omar Haddad', 'Zoe Williams', 'Lucas Meyer', 'Aisha Bello']
const EXT = ['pdf', 'docx', 'xlsx', 'pptx', 'png', 'mp4', 'txt', 'zip']
const NOUN = ['Migration', 'Audit', 'Rollout', 'Review', 'Upgrade', 'Onboarding', 'Renewal', 'Forecast', 'Integration', 'Launch']

const LISTS: (SpList & { n: number; kind: 'tasks' | 'customers' | 'docs' | 'small' })[] = [
  { id: 'demo-tasks', title: 'Project Tasks', isLibrary: false, itemCount: 2_000_000, baseTemplate: 100, url: '/sites/demo/Lists/Tasks', description: 'Two million tasks across regions', n: 2_000_000, kind: 'tasks' },
  { id: 'demo-docs', title: 'Policy Documents', isLibrary: true, itemCount: 180_000, baseTemplate: 101, url: '/sites/demo/Policies', description: 'Document library', n: 180_000, kind: 'docs' },
  { id: 'demo-cust', title: 'Customers', isLibrary: false, itemCount: 18_000, baseTemplate: 100, url: '/sites/demo/Lists/Customers', description: 'Small enough to run fully in memory', n: 18_000, kind: 'customers' },
  { id: 'demo-small', title: 'Team Events', isLibrary: false, itemCount: 240, baseTemplate: 100, url: '/sites/demo/Lists/Events', description: 'Tiny list', n: 240, kind: 'small' },
]

const f = (internal: string, title: string, kind: SpField['kind'], extra: Partial<SpField> = {}): SpField =>
  ({ internal, title, kind, typeAsString: kind, sortable: true, filterable: true, ...extra })
const COMMON = (): SpField[] => [
  f('Created', 'Created', 'date', { system: true, indexed: true }), f('Modified', 'Modified', 'date', { system: true, indexed: true }),
  f('Author', 'Created By', 'user', { system: true, sortable: false }), f('Editor', 'Modified By', 'user', { system: true, sortable: false }),
]
const FIELDS: Record<string, SpField[]> = {
  tasks: [f('Title', 'Title', 'text', { required: true }), f('Status', 'Status', 'choice', { choices: STATUS }), f('Priority', 'Priority', 'choice', { choices: PRIORITY }), f('Region', 'Region', 'choice', { choices: REGION }),
    f('AssignedTo', 'Assigned To', 'user', { sortable: false }), f('Budget', 'Budget', 'currency'), f('PercentComplete', '% Complete', 'number'), f('DueDate', 'Due Date', 'date', { indexed: true }), f('Blocked', 'Blocked', 'boolean'), ...COMMON()],
  customers: [f('Title', 'Company', 'text'), f('Region', 'Region', 'choice', { choices: REGION }), f('Tier', 'Tier', 'choice', { choices: ['Bronze', 'Silver', 'Gold', 'Platinum'] }), f('AccountManager', 'Account Manager', 'user', { sortable: false }),
    f('Revenue', 'Annual Revenue', 'currency'), f('Employees', 'Employees', 'number'), f('Active', 'Active', 'boolean'), f('Website', 'Website', 'url', { filterable: false }), ...COMMON()],
  docs: [f('FileLeafRef', 'Name', 'text', { required: true, indexed: true }), f('FileDirRef', 'Folder', 'text', { system: true, filterable: false }), f('Department', 'Department', 'choice', { choices: DEPT }), f('File_x0020_Type', 'Type', 'text'), f('File_x0020_Size', 'Size', 'number'), f('Version', 'Version', 'number'), ...COMMON()],
  small: [f('Title', 'Event', 'text'), f('Location', 'Location', 'choice', { choices: ['Berlin', 'Lisbon', 'Remote', 'Austin'] }), f('EventDate', 'Date', 'date'), f('Attendees', 'Attendees', 'number'), ...COMMON()],
}

function rng(seed: number) { // mulberry32
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const pick = <T,>(r: () => number, a: T[]) => a[Math.floor(r() * a.length)]
const NOW = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()

function makeRow(kind: string, id: number): Row {
  const r = rng(id * 2654435761)
  const created = NOW - Math.floor(Math.pow(r(), 1.6) * 900) * 86_400_000 - Math.floor(r() * 86_400_000)
  const modified = Math.min(NOW - Math.floor(r() * 3_600_000), created + Math.floor(r() * 120) * 86_400_000)
  const base: Row = { __id: id, ID: id, Created: iso(created), Modified: iso(modified), Author: pick(r, PEOPLE), Editor: pick(r, PEOPLE) }
  if (kind === 'tasks') {
    return { ...base, Title: `${pick(r, NOUN)} ${pick(r, ['Atlas', 'Orion', 'Nova', 'Helix', 'Pulse', 'Vega', 'Aurora'])} #${id}`, Status: pick(r, STATUS), Priority: pick(r, PRIORITY), Region: pick(r, REGION),
      AssignedTo: pick(r, PEOPLE), Budget: Math.round(r() * 250_000) / 1, PercentComplete: Math.floor(r() * 101), DueDate: iso(created + Math.floor(r() * 200) * 86_400_000), Blocked: r() < 0.07 }
  }
  if (kind === 'customers') return { ...base, Title: `${pick(r, ['Northwind', 'Fabrikam', 'Tailspin', 'Adatum', 'Litware', 'Wingtip'])} ${pick(r, ['Ltd', 'GmbH', 'Inc', 'SA', 'Pty'])} ${id}`, Region: pick(r, REGION), Tier: pick(r, ['Bronze', 'Silver', 'Gold', 'Platinum']), AccountManager: pick(r, PEOPLE), Revenue: Math.round(r() * 5_000_000), Employees: Math.floor(r() * 9000), Active: r() > 0.12, Website: `https://example.com/${id}` }
  if (kind === 'docs') {
    const ext = pick(r, EXT), dept = pick(r, DEPT), name = `${pick(r, ['Policy', 'Handbook', 'Contract', 'Report', 'Minutes', 'Invoice'])}-${id}.${ext}`
    const dir = id % 40 === 0 ? DOCS_ROOT : `${DOCS_ROOT}/${dept}`
    return { ...base, FileLeafRef: name, FileDirRef: dir, FileRef: `${dir}/${name}`, FSObjType: 0, Department: dept, File_x0020_Type: ext, File_x0020_Size: Math.floor(Math.pow(r(), 3) * 40_000_000) + 2000, Version: Math.ceil(r() * 9) }
  }
  return { ...base, Title: `${pick(r, ['Offsite', 'Hackday', 'Demo day', 'Town hall'])} ${id}`, Location: pick(r, ['Berlin', 'Lisbon', 'Remote', 'Austin']), EventDate: iso(NOW + Math.floor(r() * 120 - 30) * 86_400_000), Attendees: Math.floor(r() * 120) }
}

/* in-memory edits layered on the generated rows so create / edit / delete can be tried in the demo */
const edits = new Map<string, Row>(), created = new Map<string, Row>(), deleted = new Set<string>()
const key = (kind: string, id: number) => `${kind}:${id}`
function getRow(kind: string, id: number): Row | null {
  if (id >= 2_000_000_000) { const f = folderById(id); return f ? folderRow(f) : null }
  const k = key(kind, id)
  if (deleted.has(k)) return null
  return created.get(k) ?? edits.get(k) ?? makeRow(kind, id)
}
/* ---- folders (DEPT folders exist from the start; users can create more) ---- */
interface DemoFolder { id: number; path: string; name: string; parent: string; created: string }
const folders = new Map<string, DemoFolder>(DEPT.map((d, i) => [`${DOCS_ROOT}/${d}`, { id: 2_000_000_000 + i, path: `${DOCS_ROOT}/${d}`, name: d, parent: DOCS_ROOT, created: new Date(NOW - 900 * 86_400_000).toISOString() }]))
let folderSeq = 2_000_000_100
const folderRow = (f: DemoFolder): Row => ({ __id: f.id, ID: f.id, FileLeafRef: f.name, FileRef: f.path, FileDirRef: f.parent, FSObjType: 1, Created: f.created, Modified: f.created, Author: 'Demo Owner', Editor: 'Demo Owner', Department: '', File_x0020_Type: '', File_x0020_Size: 0, Version: 0 })
const folderById = (id: number) => [...folders.values()].find((f) => f.id === id)
let demoRole: Role = lsGet<Role>('spx.demo.role', 'admin')

/** demo rows hold display strings: flatten form values (people -> names, urls -> {Url}) */
const flat = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Array.isArray(x) && x.length && typeof x[0] === 'object' ? (x as Principal[]).map((p) => p.title).join('; ') : x && typeof x === 'object' && !Array.isArray(x) && 'url' in (x as object) ? { Url: (x as { url: string }).url, Description: (x as { desc?: string }).desc } : x]))
const listOf = (id: string) => LISTS.find((l) => l.id === id) ?? LISTS[0]

const atts = new Map<string, Attachment[]>()
const ROLE_DEFS: RoleDef[] = [{ id: 1073741826, name: 'Read' }, { id: 1073741827, name: 'Contribute' }, { id: 1073741830, name: 'Edit' }, { id: 1073741828, name: 'Design' }, { id: 1073741829, name: 'Full Control' }]
const DIRECTORY: (Principal & { login: string })[] = [
  ...PEOPLE.map((n, i) => ({ id: 100 + i, title: n, login: `i:0#.f|membership|${n.toLowerCase().replace(/\s+/g, '.')}@contoso.com`, kind: 'user' as const, email: `${n.toLowerCase().replace(/\s+/g, '.')}@contoso.com` })),
  { id: 11, title: 'PNC Data Owners', login: 'PNC Data Owners', kind: 'group' }, { id: 12, title: 'PNC Data Editors', login: 'PNC Data Editors', kind: 'group' }, { id: 13, title: 'PNC Readers', login: 'PNC Readers', kind: 'group' },
  { id: 14, title: 'Everyone except external users', login: 'c:0-.f|rolemanager|spo-grid-all-users', kind: 'group' },
]
const perms = new Map<string, RoleAssign[]>()
const pkey = (src: SourceConfig, t: PermTarget) => `${src.listId}:${t.kind === 'item' ? t.id : 'list'}`
const defaultAssign = (): RoleAssign[] => [
  { principal: DIRECTORY[12], roles: ['Full Control'], roleIds: [1073741829] }, { principal: DIRECTORY[13], roles: ['Edit'], roleIds: [1073741830] }, { principal: DIRECTORY[14], roles: ['Read'], roleIds: [1073741826] },
]

export const demo: Backend = {
  mode: 'demo',
  async whoAmI() { return { upn: 'you@contoso.com', name: 'Demo Owner' } },
  async listSites() { return [{ url: SITE, title: 'Demo site' }, { url: 'https://contoso.sharepoint.com/sites/hr', title: 'HR portal' }] },
  async listLists() { await sleep(200); return LISTS.map(({ n: _n, kind: _k, ...l }) => l) },
  async getList(_s, id) { const { n: _n, kind: _k, ...l } = listOf(id); return l },
  async getFields(_s, id) { await sleep(100); return FIELDS[listOf(id).kind] },

  async query(src: SourceConfig, fields: SpField[], _select: string[], q: Query, top: number, cursor?: string, signal?: AbortSignal): Promise<Page> {
    const L = listOf(src.listId)
    await sleep(60 + Math.random() * 120)
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (L.kind === 'docs' && isFolderMode(q)) {
      const start = cursor?.startsWith('id:') ? Number(cursor.slice(3)) : 1
      const out: Row[] = cursor ? [] : [...folders.values()].filter((f) => f.parent === q.folder).map(folderRow)
      let id = start, n = 0
      const dept = q.folder!.startsWith(DOCS_ROOT + '/') ? q.folder!.slice(DOCS_ROOT.length + 1) : ''
      const maxId = L.n
      while (id <= maxId && n < 1000) {
        const row = getRow('docs', id)
        if (row && row.FileDirRef === q.folder) { out.push(row); n++ }
        id++
        if (dept && !DEPT.includes(dept.split('/')[0]) ) break
      }
      return { rows: out, scanned: id - start, cursor: id <= maxId && n >= 1000 ? `id:${id}` : undefined }
    }
    const asc = q.sort.field === 'ID' ? q.sort.dir === 'asc' : true
    const tokens = searchTokens(q.search)
    const plain = !tokens.length && !q.clauses.length
    let id = cursor?.startsWith('id:') ? Number(cursor.slice(3)) : asc ? 1 : L.n
    const rows: Row[] = []
    let scanned = 0
    const BUDGET = 400_000   // mimic SharePoint: a query can only walk so far in one request
    while (rows.length < top && id >= 1 && id <= L.n && scanned < BUDGET) {
      const row = getRow(L.kind, id)
      scanned++
      if (row && (plain || matchRow(row, q, fields, tokens))) rows.push(row)
      id += asc ? 1 : -1
    }
    const more = id >= 1 && id <= L.n
    return { rows, scanned, cursor: more ? `id:${id}` : undefined }
  },

  async getItem(src, _f, id) { return getRow(listOf(src.listId).kind, id) },

  async changes(src, _f, _s, afterId) {
    const L = listOf(src.listId)
    const added: Row[] = [], changed: Row[] = []
    if (Math.random() < 0.6) { // simulate a few new items trickling in
      const n = 1 + Math.floor(Math.random() * 3)
      for (let i = 1; i <= n; i++) { const r = makeRow(L.kind, Math.max(afterId, L.n) + i); r.Created = iso(Date.now()); r.Modified = r.Created; added.push(r) }
      L.n += n; L.itemCount += n
    }
    if (Math.random() < 0.5) { const r = makeRow(L.kind, 1 + Math.floor(Math.random() * L.n)); r.Modified = iso(Date.now()); changed.push(r) }
    return { added, changed, itemCount: L.itemCount, maxId: L.n }
  },

  async loadConfig(): Promise<AppConfig> {
    return lsGet<AppConfig>('spx.demo.config', {
      v: 1, owners: ['you@contoso.com'], updated: new Date().toISOString(), updatedBy: 'demo',
      sources: [],
    })
  },
  async saveConfig(cfg) { lsSet('spx.demo.config', cfg) },
  async indexColumn() { await sleep(400) },

  setRole(r: Role) { demoRole = r; lsSet('spx.demo.role', r) },
  async getAccess(_src, cfg, upn): Promise<Access> {
    const low = PERM.View | (demoRole !== 'reader' ? PERM.Add | PERM.Edit : 0) | (demoRole === 'admin' ? PERM.Delete | PERM.ManageLists | PERM.ManagePermissions : 0)
    return accessFrom(low, demoRole === 'admin' ? ['Demo Admins', 'Demo Contributors'] : demoRole === 'writer' ? ['Demo Contributors'] : [], false, { ...cfg, owners: [] }, upn)
  },
  async createItem(src, _f, values) {
    const L = listOf(src.listId); await sleep(150)
    L.n++; L.itemCount++
    const id = L.n; const now = new Date().toISOString()
    created.set(key(L.kind, id), { __id: id, ID: id, Created: now, Modified: now, Author: 'Demo Owner', Editor: 'Demo Owner', ...flat(values) } as Row)
    return id
  },
  async updateItem(src, _f, id, values) {
    const L = listOf(src.listId); await sleep(150)
    const cur = getRow(L.kind, id); if (!cur) throw new Error('Item not found')
    const next = { ...cur, ...flat(values), Modified: new Date().toISOString(), Editor: 'Demo Owner' } as Row
    ;(created.has(key(L.kind, id)) ? created : edits).set(key(L.kind, id), next)
  },
  async deleteItem(src, id) { const L = listOf(src.listId); await sleep(150); deleted.add(key(L.kind, id)); L.itemCount-- },
  async loadViews(upn) { return { shared: lsGet<ViewDef[]>('spx.demo.views.shared', []), mine: lsGet<ViewDef[]>('spx.demo.views.' + upn, []) } },
  async saveShared(v) { lsSet('spx.demo.views.shared', v) },
  async saveMine(upn, v) { lsSet('spx.demo.views.' + upn, v); return 'device' as const },

  /* ---- libraries ---- */
  async createFolder(_s, parent, name) {
    await sleep(120); const path = `${parent.replace(/\/$/, '')}/${name}`
    if (folders.has(path)) throw new Error('A folder with that name already exists.')
    folders.set(path, { id: folderSeq++, path, name, parent: parent.replace(/\/$/, ''), created: new Date().toISOString() })
  },
  async uploadFile(src, folder, file) {
    const L = listOf(src.listId); await sleep(150 + Math.min(1500, file.size / 20_000))
    L.n++; L.itemCount++; const id = L.n; const now = new Date().toISOString(); const dir = folder.replace(/\/$/, '')
    created.set(key(L.kind, id), { __id: id, ID: id, FileLeafRef: file.name, FileDirRef: dir, FileRef: `${dir}/${file.name}`, FSObjType: 0, Department: dir.split('/').pop() ?? '', File_x0020_Type: file.name.split('.').pop() ?? '', File_x0020_Size: file.size, Version: 1, Created: now, Modified: now, Author: 'Demo Owner', Editor: 'Demo Owner' } as Row)
  },
  async renameItem(src, _f, id, newName) {
    const L = listOf(src.listId); await sleep(120)
    const fo = folderById(id)
    if (fo) { const old = fo.path; folders.delete(old); fo.name = newName; fo.path = `${fo.parent}/${newName}`; folders.set(fo.path, fo); return }
    const cur = getRow(L.kind, id); if (!cur) throw new Error('Item not found')
    const ext = String(cur.File_x0020_Type ?? '')
    ;(created.has(key(L.kind, id)) ? created : edits).set(key(L.kind, id), { ...cur, FileLeafRef: newName, FileRef: `${cur.FileDirRef}/${newName}`, File_x0020_Type: newName.split('.').pop() ?? ext } as Row)
  },
  async moveItem(src, row, dest) {
    const L = listOf(src.listId); await sleep(150); const d = dest.replace(/\/$/, '')
    const fo = folderById(row.__id)
    if (fo) { folders.delete(fo.path); fo.parent = d; fo.path = `${d}/${fo.name}`; folders.set(fo.path, fo); return }
    const cur = getRow(L.kind, row.__id); if (!cur) throw new Error('Item not found')
    ;(created.has(key(L.kind, row.__id)) ? created : edits).set(key(L.kind, row.__id), { ...cur, FileDirRef: d, FileRef: `${d}/${cur.FileLeafRef}`, Department: d.split('/').pop() ?? '' } as Row)
  },
  async copyItem(src, row, dest) {
    const L = listOf(src.listId); await sleep(150); const d = dest.replace(/\/$/, '')
    L.n++; L.itemCount++; const id = L.n; const now = new Date().toISOString()
    created.set(key(L.kind, id), { ...row, __id: id, ID: id, FileDirRef: d, FileRef: `${d}/${row.FileLeafRef}`, Created: now, Modified: now } as Row)
  },
  async listFolders(_s, parent) { await sleep(80); return [...folders.values()].filter((f) => f.parent === parent.replace(/\/$/, '')).map((f) => ({ name: f.name, url: f.path })) },

  /* ---- attachments / history ---- */
  async listAttachments(src, id) { return atts.get(`${src.listId}:${id}`) ?? [] },
  async addAttachment(src, id, file) { await sleep(200); const k = `${src.listId}:${id}`; atts.set(k, [...(atts.get(k) ?? []), { name: file.name, url: '#' + encodeURIComponent(file.name) }]) },
  async deleteAttachment(src, id, name) { const k = `${src.listId}:${id}`; atts.set(k, (atts.get(k) ?? []).filter((a) => a.name !== name)) },
  async getVersions(_s, id): Promise<VersionInfo[]> {
    const r = rng(id); const n = 2 + Math.floor(r() * 3); const out: VersionInfo[] = []
    for (let i = n; i >= 1; i--) out.push({ label: `${i}.0`, modified: new Date(NOW - (n - i) * 6 * 86_400_000 * (1 + r())).toISOString(), by: pick(r, PEOPLE), comment: i === 1 ? 'Created' : i % 2 ? 'Updated metadata' : undefined, current: i === n })
    return out
  },

  /* ---- security ---- */
  async getPermissions(src, t): Promise<PermInfo> {
    await sleep(120); const k = pkey(src, t)
    if (t.kind === 'item' && !perms.has(k)) return { inherited: true, assignments: perms.get(pkey(src, { kind: 'list' })) ?? defaultAssign() }
    if (t.kind === 'list' && !perms.has(k)) perms.set(k, defaultAssign())
    return { inherited: false, assignments: perms.get(k)! }
  },
  async setInheritance(src, t, inherit) {
    await sleep(120); const k = pkey(src, t)
    if (inherit) perms.delete(k); else perms.set(k, JSON.parse(JSON.stringify(perms.get(pkey(src, { kind: 'list' })) ?? defaultAssign())))
  },
  async addPermission(src, t, pid, rid) {
    await sleep(100); const k = pkey(src, t); const cur = perms.get(k) ?? JSON.parse(JSON.stringify(perms.get(pkey(src, { kind: 'list' })) ?? defaultAssign())) as RoleAssign[]
    const p = DIRECTORY.find((x) => x.id === pid) ?? { id: pid, title: `Principal ${pid}`, login: '', kind: 'user' as const }
    const role = ROLE_DEFS.find((r) => r.id === rid)!
    const ex = cur.find((a) => a.principal.id === pid)
    if (ex) { if (!ex.roleIds.includes(rid)) { ex.roleIds.push(rid); ex.roles.push(role.name) } } else cur.push({ principal: p, roles: [role.name], roleIds: [rid] })
    perms.set(k, cur)
  },
  async removePermission(src, t, ra) { await sleep(100); const k = pkey(src, t); perms.set(k, (perms.get(k) ?? []).filter((a) => a.principal.id !== ra.principal.id)) },
  async listRoleDefs(): Promise<RoleDef[]> { return ROLE_DEFS },
  async searchPrincipals(_s, text) { await sleep(120); const t = text.toLowerCase(); return DIRECTORY.filter((p) => p.title.toLowerCase().includes(t) || p.email?.includes(t)).slice(0, 8).map((p) => ({ ...p })) },
  async resolvePrincipal(_s, p) { return p.id > 0 ? p.id : DIRECTORY.find((d) => d.login === p.login)?.id ?? 9999 },
  async suggest(src, _f, text) {
    const L = listOf(src.listId); const out: string[] = []; const t = text.toLowerCase(); const tf = L.kind === 'docs' ? 'FileLeafRef' : 'Title'
    for (let id = L.n; id >= 1 && out.length < 8 && id > L.n - 300_000; id--) { const r = getRow(L.kind, id); const v = String(r?.[tf] ?? ''); if (v.toLowerCase().startsWith(t)) out.push(v) }
    return [...new Set(out)]
  },
}
export { emptyQuery }
