import type { Env } from '../types'

export type PrincipalType = 'User' | 'Group' | 'Tenant' | 'Guest' | 'Unknown'
export type ResKind = 'app' | 'flow' | 'connection'
export type Severity = 'High' | 'Medium' | 'Low' | 'Info'

export interface Principal {
  id: string
  type: PrincipalType
  name?: string
  email?: string
  /** false = disabled / deleted in Entra, null/undefined = not checked. */
  enabled?: boolean | null
}

export interface Share {
  /** Id of the permission row (used to remove it). Falls back to the principal id. */
  rowId: string
  role: string // CanView, CanViewWithShare, CanEdit, CanUse, CanUseAndShare ...
  principal: Principal
}

export interface Resource {
  key: string // kind:env:id
  kind: ResKind
  id: string
  name: string
  envId: string
  envName: string
  owner?: Principal // app owner / flow creator / connection creator
  state?: string
  modified?: string
  connector?: string // connections: short connector name (shared_office365 ...)
  status?: string // connections: Connected / Error ...
  shares: Share[] // everyone who can reach it, EXCLUDING its owner/creator
  /** Number of people this resource is shared with, as reported by the list call (may exceed shares.length when permissions could not be read). */
  sharedCount?: number
}

export type RuleId =
  | 'EVERYONE' | 'GUEST' | 'CONN_SHARED' | 'CONN_DEAD_OWNER' | 'EDITOR_SPRAWL' | 'FLOW_OWNER_SPRAWL' | 'CONN_ERROR' | 'UNREADABLE'

export interface Finding {
  id: string
  rule: RuleId
  severity: Severity
  resourceKey: string
  kind: ResKind
  name: string
  envId: string
  envName: string
  title: string
  detail: string
  /** The share to remove to fix this finding (apps and flows only). */
  share?: Share
}

export interface ScanOutput {
  resources: Resource[]
  notes: { env: string; level: 'info' | 'warn' | 'error'; text: string }[]
}

export interface ExposureBackend {
  readonly label: 'Demo' | 'Live'
  scan(envs: Env[], onProgress: (done: number, total: number, label: string) => void): Promise<ScanOutput>
  /** Remove one share. Throws on failure. */
  removeShare(r: Resource, s: Share): Promise<void>
  /** true = the share is gone, false = still there, null = cannot tell. */
  verifyGone(r: Resource, s: Share): Promise<boolean | null>
  diagnostics(): Promise<{ name: string; ok: boolean; detail: string }[]>
}

export interface Thresholds {
  /** CanEdit users on one app above this => EDITOR_SPRAWL. */
  maxEditors: number
  /** Co-owners on one flow above this => FLOW_OWNER_SPRAWL. */
  maxFlowOwners: number
}
export const DEFAULT_THRESHOLDS: Thresholds = { maxEditors: 5, maxFlowOwners: 3 }
