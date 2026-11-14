import type { RawRow, TargetSpec } from '../logic/classify'

export interface TargetRow extends TargetSpec { url: string; enabled: boolean; family: string }

export interface Snapshot {
  targets: TargetRow[]
  rows: RawRow[]
  settings: Record<string, string>
}

export interface DataSource {
  /** 'live' = Dataverse tables of this environment; 'demo' = generated sample data (no connection). */
  kind: 'live' | 'demo'
  load(): Promise<Snapshot>
}
