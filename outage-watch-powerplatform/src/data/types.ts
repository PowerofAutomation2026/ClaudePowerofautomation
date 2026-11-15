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
  /** The "send test notification" button. Absent when this build has no command table (older deployment). */
  notifier?: Notifier
}

/** Creates a command row and reads its state back. Never sees a webhook URL. */
export interface Notifier {
  /** Resolves with the id of the command row; rejects with the Dataverse message (e.g. a 403) when it could not be created. */
  request(channels: string, note: string): Promise<string>
  poll(id: string): Promise<{ status: string; result: string }>
}
