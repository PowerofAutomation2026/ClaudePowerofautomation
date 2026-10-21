/** Demo backend: a fake tenant with a 2,000,000-row list so the whole UI can be tried (and stress-tested) in a browser. */
import type { AppConfig, Backend, Page, Query, Row, SourceConfig, SpField, SpList } from '../types'
import { emptyQuery, matchRow, searchTokens } from '../query'
import { lsGet, lsSet, sleep } from '../util'

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
  docs: [f('FileLeafRef', 'Name', 'text', { required: true, indexed: true }), f('Department', 'Department', 'choice', { choices: DEPT }), f('File_x0020_Type', 'Type', 'text'), f('File_x0020_Size', 'Size', 'number'), f('Version', 'Version', 'number'), ...COMMON()],
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
  if (kind === 'docs') { const ext = pick(r, EXT); return { ...base, FileLeafRef: `${pick(r, ['Policy', 'Handbook', 'Contract', 'Report', 'Minutes', 'Invoice'])}-${id}.${ext}`, FileRef: `/sites/demo/Policies/${id}.${ext}`, Department: pick(r, DEPT), File_x0020_Type: ext, File_x0020_Size: Math.floor(Math.pow(r(), 3) * 40_000_000) + 2000, Version: Math.ceil(r() * 9) } }
  return { ...base, Title: `${pick(r, ['Offsite', 'Hackday', 'Demo day', 'Town hall'])} ${id}`, Location: pick(r, ['Berlin', 'Lisbon', 'Remote', 'Austin']), EventDate: iso(NOW + Math.floor(r() * 120 - 30) * 86_400_000), Attendees: Math.floor(r() * 120) }
}

const listOf = (id: string) => LISTS.find((l) => l.id === id) ?? LISTS[0]

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
    const asc = q.sort.field === 'ID' ? q.sort.dir === 'asc' : true
    const tokens = searchTokens(q.search)
    const plain = !tokens.length && !q.clauses.length
    let id = cursor?.startsWith('id:') ? Number(cursor.slice(3)) : asc ? 1 : L.n
    const rows: Row[] = []
    let scanned = 0
    const BUDGET = 400_000   // mimic SharePoint: a query can only walk so far in one request
    while (rows.length < top && id >= 1 && id <= L.n && scanned < BUDGET) {
      const row = makeRow(L.kind, id)
      scanned++
      if (plain || matchRow(row, q, fields, tokens)) rows.push(row)
      id += asc ? 1 : -1
    }
    const more = id >= 1 && id <= L.n
    return { rows, scanned, cursor: more ? `id:${id}` : undefined }
  },

  async getItem(src, _f, id) { return makeRow(listOf(src.listId).kind, id) },

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
}
export { emptyQuery }
