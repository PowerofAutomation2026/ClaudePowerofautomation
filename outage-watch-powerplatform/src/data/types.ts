import type { RawRow, TargetSpec } from '../logic/classify'

export interface TargetRow extends TargetSpec { url: string; enabled: boolean; family: string }

export interface Snapshot {
  targets: TargetRow[]
  rows: RawRow[]
  settings: Record<string, string>
  /** Incident records written by the alert flow (newest first). Empty when the table is not there yet. */
  incidents?: IncidentRow[]
}

export interface IncidentRow { name: string; family: string; open: boolean; openedAt: string; closedAt: string | null; minutes: number; rounds: number; reminders: number; error: string }

export interface DataSource {
  /** 'live' = Dataverse tables of this environment; 'demo' = generated sample data (no connection). */
  kind: 'live' | 'demo'
  load(): Promise<Snapshot>
}
