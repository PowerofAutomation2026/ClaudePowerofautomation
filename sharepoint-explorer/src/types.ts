export type FieldKind =
  | 'text' | 'note' | 'number' | 'currency' | 'boolean' | 'date' | 'choice' | 'multichoice'
  | 'user' | 'lookup' | 'url' | 'counter' | 'other'

export interface SpField {
  internal: string
  title: string
  kind: FieldKind
  typeAsString: string
  choices?: string[]
  multi?: boolean
  required?: boolean
  indexed?: boolean
  sortable: boolean
  filterable: boolean
  /** hidden from the default grid but available */
  system?: boolean
}

export interface SpList {
  id: string
  title: string
  isLibrary: boolean
  itemCount: number
  baseTemplate: number
  url: string
  description?: string
  modified?: string
}

export interface SpSite { url: string; title: string }

/** A list or library the app owner has published to all users. */
export interface SourceConfig {
  id: string
  siteUrl: string
  listId: string
  title: string
  label: string
  isLibrary: boolean
  itemCount: number
  /** server-relative URL of the list (used by the SharePoint Search path) */
  url?: string
  added: string
  addedBy: string
}

export type Role = 'reader' | 'writer' | 'admin'

/** What the signed-in user may do with the connected list. Derived from SharePoint's own permissions, so it cannot be faked in the UI. */
export interface Access {
  role: Role
  canAdd: boolean
  canEdit: boolean
  canDelete: boolean
  groups: string[]
  isSiteAdmin: boolean
  /** why the role was chosen (shown to the user) */
  reason: string
}

export interface ViewDef {
  id: string
  name: string
  sourceId: string
  q: Query
  cols: string[]
  layout: 'table' | 'cards'
  owner: string
  /** me = personal; everyone; groups = members of the named SharePoint groups; admins = data admins and app owners only */
  audience: 'me' | 'everyone' | 'groups' | 'admins'
  groups?: string[]
  created: string
}

export interface AppConfig {
  v: 1
  /** optional extra app-level limits (can only restrict SharePoint permissions, never widen them) */
  writerGroups?: string[]
  adminGroups?: string[]
  owners: string[]
  sources: SourceConfig[]
  activeId?: string
  updated: string
  updatedBy: string
}

/** Values are already normalised for display: users/lookups become strings, dates stay ISO strings. */
export type Row = { __id: number; __new?: boolean } & Record<string, any>

export type Op =
  | 'contains' | 'eq' | 'neq' | 'startswith' | 'gt' | 'lt' | 'ge' | 'le' | 'in' | 'empty' | 'notempty' | 'lastdays'

export interface Clause { field: string; op: Op; value: string; values?: string[] }

export interface Query {
  search: string
  clauses: Clause[]
  sort: { field: string; dir: 'asc' | 'desc' }
  /** library: include folders as rows */
  folders: boolean
}

export interface Page {
  rows: Row[]
  /** opaque; undefined when there is nothing more */
  cursor?: string
  scanned?: number
}

export interface Backend {
  mode: 'live' | 'demo'
  whoAmI(): Promise<{ upn: string; name: string }>
  listSites(): Promise<SpSite[]>
  listLists(siteUrl: string): Promise<SpList[]>
  getList(siteUrl: string, listId: string): Promise<SpList>
  getFields(siteUrl: string, listId: string): Promise<SpField[]>
  /** `select` = internal names of the columns to load */
  query(src: SourceConfig, fields: SpField[], select: string[], q: Query, top: number, cursor?: string, signal?: AbortSignal): Promise<Page>
  getItem(src: SourceConfig, fields: SpField[], id: number): Promise<Row | null>
  /** ids greater than `afterId` and rows modified after `since` */
  changes(src: SourceConfig, fields: SpField[], select: string[], afterId: number, since: string): Promise<{ added: Row[]; changed: Row[]; itemCount: number; maxId: number }>
  loadConfig(): Promise<AppConfig>
  saveConfig(cfg: AppConfig): Promise<void>
  indexColumn(src: SourceConfig, field: string): Promise<void>
  getAccess(src: SourceConfig, cfg: AppConfig, upn: string): Promise<Access>
  createItem(src: SourceConfig, fields: SpField[], values: Record<string, unknown>): Promise<void>
  updateItem(src: SourceConfig, fields: SpField[], id: number, values: Record<string, unknown>): Promise<void>
  deleteItem(src: SourceConfig, id: number): Promise<void>
  loadViews(upn: string): Promise<{ shared: ViewDef[]; mine: ViewDef[] }>
  saveShared(views: ViewDef[]): Promise<void>
  saveMine(upn: string, views: ViewDef[]): Promise<void>
  /** fast typeahead: titles/names that start with or contain `text` */
  suggest(src: SourceConfig, fields: SpField[], text: string, signal?: AbortSignal): Promise<string[]>
  setRole?(r: Role): void
}
