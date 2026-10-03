export type AssetKind = 'app' | 'flow' | 'agent'

export interface Env {
  id: string
  name: string
  isDefault?: boolean
  region?: string
  orgUrl?: string // Dataverse org URL (needed for Copilot Studio agents)
}

export interface Person {
  id: string // Entra object id
  name: string
  email: string
}

export interface Asset {
  key: string // kind:env:id
  id: string
  kind: AssetKind
  name: string
  envId: string
  envName: string
  ownerId: string
  ownerName: string
  ownerEmail: string
  state: 'Started' | 'Stopped' | 'Suspended' | 'Published' | 'Unknown'
  createdTime?: string
  modifiedTime?: string
  inSolution?: boolean
  connections?: number
  orgHost?: string // Dataverse host, for agents
}

export type TransferMode = 'replace' | 'coowner'

export interface TransferOptions {
  mode: TransferMode
  removeOldOwner: boolean
}

export type ItemStatus = 'pending' | 'running' | 'done' | 'failed' | 'dry'

export interface AuditEntry {
  at: string
  assetKey: string
  name: string
  kind: AssetKind
  envName: string
  from: Person
  to: Person
  mode: TransferMode
  status: ItemStatus
  error?: string
  dryRun: boolean
  batch: string
}

export interface ScanNote {
  env: string
  kind: AssetKind | 'env' | 'user'
  level: 'info' | 'warn' | 'error'
  text: string
}

export interface ScanResult {
  assets: Asset[]
  notes: ScanNote[]
}

export interface Backend {
  readonly label: 'Demo' | 'Live'
  listEnvironments(): Promise<Env[]>
  resolveUser(emailOrId: string): Promise<Person>
  listAssets(
    user: Person,
    envs: Env[],
    onProgress: (done: number, total: number, env: string) => void,
  ): Promise<ScanResult>
  transfer(asset: Asset, to: Person, opts: TransferOptions): Promise<void>
  diagnostics(): Promise<{ name: string; ok: boolean; detail: string }[]>
}
