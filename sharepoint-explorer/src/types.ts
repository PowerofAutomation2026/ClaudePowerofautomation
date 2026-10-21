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
  added: string
  addedBy: string
}

export interface AppConfig {
  v: 1
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
}
