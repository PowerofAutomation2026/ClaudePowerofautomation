/**
 * Transfer orchestration, kept free of React so it can be unit-tested against a simulated service.
 *
 * Safe protocol for Copilot Studio AGENTS (a failed reassignment can leave an agent half-updated):
 *   1. refuse anything that is not a real Copilot Studio agent (tool / MCP / Agent Builder / CLI rows);
 *   2. per environment: add the new owner as a member and confirm membership - any failure BLOCKS that environment's agents;
 *   3. reassign strictly one agent at a time (pilot first), no automatic retry;
 *   4. the first service failure HALTS the batch - remaining agents are skipped, never touched;
 *   5. after success, verify the owner in the inventory (informational: the inventory can lag by minutes).
 * Apps and flows keep light parallelism (3) because their operations are atomic single calls.
 */
import type { Asset, AuditEntry, Backend, ItemStatus, Person, TransferOptions } from './types'

export interface TransferHooks {
  status(key: string, s: ItemStatus, err?: string, note?: string): void
  message(text: string): void
}

export interface TransferArgs {
  backend: Backend
  items: Asset[]
  to: Person
  opts: TransferOptions
  dry: boolean
  prepare: boolean
  batch: string
  hooks: TransferHooks
  settleMs?: number // pause after adding a user to an environment before reassigning
}

export interface TransferOutcome {
  entries: AuditEntry[]
  movedKeys: string[]
  prepNotes: string
  halted?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ownerOf = (a: Asset): Person => ({ id: a.ownerId, name: a.ownerName, email: a.ownerEmail })

export async function runTransfer(args: TransferArgs): Promise<TransferOutcome> {
  const { backend, items, to, opts, dry, prepare, batch, hooks } = args
  const entries: AuditEntry[] = []
  const movedKeys: string[] = []
  let prepNotes = ''
  let halted: string | undefined

  const record = (a: Asset, status: ItemStatus, error?: string, note?: string) => {
    hooks.status(a.key, status, error, note)
    entries.push({ at: new Date().toISOString(), assetKey: a.key, name: a.name, kind: a.kind, envName: a.envName, from: ownerOf(a), to, mode: opts.mode, status, error, dryRun: dry, batch, note })
  }

  const agents = items.filter((a) => a.kind === 'agent')
  const others = items.filter((a) => a.kind !== 'agent')

  // 1. category guard (applies to dry runs too)
  const blocked = new Map<string, string>()
  for (const a of agents) {
    if (a.category && a.category !== 'agent') {
      blocked.set(a.key, `Not attempted: this inventory item is a "${a.category}", not a Copilot Studio agent. The Copilot Studio reassign API is only for real agents – nothing was changed.`)
    }
  }

  // 2. per-environment preparation (real runs only)
  const envBlocked = new Map<string, string>()
  const candidates = agents.filter((a) => !blocked.has(a.key))
  if (!dry && candidates.length) {
    const envs = [...new Map(candidates.map((a) => [a.envId, a.envName])).entries()]
    const lines: string[] = []
    let ranPrepare = false
    for (const [eid, ename] of envs) {
      if (prepare && backend.prepareOwner) {
        ranPrepare = true
        try { lines.push(`✔ ${ename}: ${await backend.prepareOwner(eid, to)}`) }
        catch (e) { const m = (e as Error).message; lines.push(`✖ ${ename}: ${m}`); envBlocked.set(eid, `could not add ${to.email} to this environment (${m})`); continue }
      }
      if (backend.checkMember) {
        const member = await backend.checkMember(eid, to).catch(() => null)
        if (member === false) { lines.push(`✖ ${ename}: ${to.email} has no user record in this environment`); envBlocked.set(eid, `${to.email} is not a user of this environment`) }
      }
    }
    if (lines.length) prepNotes = '\n\nEnvironment membership step:\n' + lines.join('\n')
    if (ranPrepare && args.settleMs !== 0) await sleep(args.settleMs ?? 4000)
    hooks.message(`${dry ? 'Simulating' : 'Transferring'} ${items.length} item(s) to ${to.name} (${to.email})…${prepNotes}`)
  }

  // 3-5. agents: strictly sequential, halt on first service failure
  for (const a of agents) {
    hooks.status(a.key, 'running')
    const pre = blocked.get(a.key) ?? (envBlocked.has(a.envId) ? `Not attempted: ${envBlocked.get(a.envId)}. Nothing was changed.` : undefined)
    if (pre) { record(a, 'failed', pre); continue }
    if (halted) { record(a, 'skipped', undefined, 'Skipped: the batch was stopped after an earlier agent failed (protects the remaining agents).'); continue }
    if (dry) { await sleep(60); record(a, 'dry'); continue }
    try {
      await backend.transfer(a, to, opts)
      movedKeys.push(a.key)
      let note: string | undefined
      if (backend.verifyOwner) {
        const v = await backend.verifyOwner(a, to).catch(() => null)
        note = v === true ? 'Verified: the inventory shows the new owner.' : v === false ? 'Reassign succeeded; the inventory does not show the new owner yet (can take 5–15 minutes). Check the agent opens in Copilot Studio.' : undefined
      }
      record(a, 'done', undefined, note)
    } catch (e) {
      const m = (e as Error).message
      record(a, 'failed', m)
      halted = `"${a.name}" failed: ${m}`
    }
  }

  // apps / flows: light parallelism
  const queue = [...others]
  const worker = async () => {
    for (let a = queue.shift(); a; a = queue.shift()) {
      hooks.status(a.key, 'running')
      try {
        if (dry) await sleep(60)
        else { await backend.transfer(a, to, opts); movedKeys.push(a.key) }
        record(a, dry ? 'dry' : 'done')
      } catch (e) { record(a, 'failed', (e as Error).message) }
    }
  }
  await Promise.all([worker(), worker(), worker()])

  return { entries, movedKeys, prepNotes, halted }
}
