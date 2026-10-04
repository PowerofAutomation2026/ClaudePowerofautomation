export type AssetKind = 'app' | 'flow' | 'agent'
/** What an inventory "agent" row really is. Only 'agent' (a real Copilot Studio agent) is shown by default. */
export type AgentCategory = 'agent' | 'agentbuilder' | 'tool' | 'mcp' | 'cli' | 'other'

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
  category?: AgentCategory // agents only
  meta?: Record<string, string> // evidence used to classify (createdIn, model, ...)
}

export type TransferMode = 'replace' | 'coowner'

export interface TransferOptions {
  mode: TransferMode
  removeOldOwner: boolean
}

export type ItemStatus = 'pending' | 'running' | 'done' | 'failed' | 'dry' | 'skipped'

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
  note?: string
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
  transfer(asset: Asset, to: Person, opts: TransferOptions): Promise<void | string>
  /** Make `to` a member (Dataverse user) of an environment WITHOUT assigning security roles. Returns a short status. */
  prepareOwner?(envId: string, to: Person): Promise<string>
  /** true = the user is a member of the environment, false = definitely not, null = cannot tell from here. */
  /** Returns a problem text when the new owner's Dataverse user cannot own agents (disabled / non-interactive), else null. Home environment only. */
  preflightTarget?(envId: string, to: Person): Promise<string | null | undefined>
  checkMember?(envId: string, to: Person): Promise<boolean | null>
  /** After a transfer: true = inventory shows `to` as owner, false = not (yet) reflected, null = cannot tell. */
  verifyOwner?(asset: Asset, to: Person): Promise<boolean | null>
  verifyOwnerRaw?(asset: Asset, to: Person): Promise<boolean | null>
  /** Which solutions contain the given items (apps, flows, agents). Needs the Dataverse connector. */
  listSolutions?(assets: Asset[]): Promise<SolutionGroup[]>
  diagnostics(): Promise<{ name: string; ok: boolean; detail: string }[]>
}

/** A solution that contains items owned by the scanned user (found via solution components). */
export interface SolutionGroup {
  key: string
  envId: string
  envName: string
  name: string
  uniqueName: string
  version?: string
  managed: boolean
  assetKeys: string[] // the user's apps / flows / agents inside this solution (these are what a transfer can move)
  totalComponents: number // everything in the solution (tables, roles, connection references... are not owner-transferable here)
}
