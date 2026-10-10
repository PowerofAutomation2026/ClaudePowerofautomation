import { dataClient, nativeByLogical } from '../services/live'
import type { Existing, Module, Store } from './persist'

/* eslint-disable @typescript-eslint/no-explicit-any */
const table = () => nativeByLogical('occ_finding', 'occ_findings')
export const tableBound = () => !!table()

/** Dataverse store through this app's own Dataverse data source (no extra connection, no app registration). */
export function liveStore(): Store {
  const t = table()
  if (!t) throw new Error('The occ_finding table is not added to this app. Run scripts/Setup-OccDataverse.ps1, then re-run the deploy script (see agent/README.md).')
  const c = dataClient()
  return {
    async listModule(module: Module): Promise<Existing[]> {
      const out: Existing[] = []
      const r: any = await c.retrieveMultipleRecordsAsync<any>(t, { filter: `occ_module eq '${module}'`, select: ['occ_findingid', 'occ_fingerprint', 'occ_status'], maxPageSize: 5000 } as any)
      if (!r?.success) throw new Error(r?.error?.message ?? 'Could not read occ_finding')
      for (const x of r.data ?? []) out.push({ id: x.occ_findingid, fingerprint: x.occ_fingerprint ?? '', status: x.occ_status ?? 'open' })
      return out
    },
    async create(rec) { const r: any = await c.createRecordAsync<any, any>(t, rec); if (!r?.success) throw new Error(r?.error?.message ?? 'create failed') },
    async update(id, changes) { const r: any = await c.updateRecordAsync<any, any>(t, id, changes); if (!r?.success) throw new Error(r?.error?.message ?? 'update failed') },
  }
}
