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
import { log } from './oplog'
import { isPartialUpdate } from './util'
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
  noVerifyDelay?: boolean // tests: skip the propagation pause before the read-back
}

export interface TransferOutcome {
  entries: AuditEntry[]
  movedKeys: string[] // CONFIRMED at the source by a read-back (only these rows leave the table)
  acceptedKeys: string[] // the service answered success (superset of movedKeys; used for Undo)
  unverifiedKeys: string[] // accepted but NOT confirmed (read-back shows the old owner, or no read-back possible)
  prepNotes: string
  halted?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ownerOf = (a: Asset): Person => ({ id: a.ownerId, name: a.ownerName, email: a.ownerEmail })

export async function runTransfer(args: TransferArgs): Promise<TransferOutcome> {
  const { backend, items, to, opts, dry, prepare, batch, hooks } = args
  const entries: AuditEntry[] = []
  const movedKeys: string[] = []
  const unverifiedKeys: string[] = []
  const acceptedKeys: string[] = []
  let prepNotes = ''
  let halted: string | undefined

  const record = (a: Asset, status: ItemStatus, error?: string, note?: string) => {
    log(`RESULT ${a.kind} "${a.name}" [${a.envName}] → ${status.toUpperCase()}${dry ? ' (dry run, nothing changed)' : ''}${error ? ' – ' + error.slice(0, 300) : ''}${note ? ' – ' + note.slice(0, 160) : ''}`)
    hooks.status(a.key, status, error, note)
    entries.push({ at: new Date().toISOString(), assetKey: a.key, name: a.name, kind: a.kind, envName: a.envName, from: ownerOf(a), to, mode: opts.mode, status, error, dryRun: dry, batch, note })
  }

  /** Read the owner back from the source; never trust the call's success alone. */
  const verify = async (a: Asset): Promise<{ status: ItemStatus; note?: string }> => {
    acceptedKeys.push(a.key)
    const read = () => (backend.verifyOwner ? backend.verifyOwner(a, to).catch(() => null) : Promise.resolve(null))
    let v = await read()
    // Agents: the inventory / admin views can lag - look once more before calling it unconfirmed.
    if (v === false && a.kind === 'agent' && !args.noVerifyDelay) { await sleep(12000); v = await read() }
    if (v === true) { movedKeys.push(a.key); return { status: 'done', note: 'Verified at the source: the new owner is now the owner.' } }
    unverifiedKeys.push(a.key)
    if (v === false) return { status: 'done', note: a.kind === 'agent'
      ? '⚠ NOT confirmed: the service accepted the request but the read-back does not show the new owner yet. In Copilot Studio it is usually immediate; the admin center / inventory can lag 5–15 min. Check as the new owner in the SAME environment (' + a.envName + '), or use Re-check.'
      : '⚠ NOT confirmed: the service accepted the request but the read-back still shows the OLD owner. Do not assume it changed – check the portal, then Re-check.' }
    return { status: 'done', note: 'Accepted by the service, but the owner could not be read back from here – confirm in the portal (Re-check retries).' }
  }

  log(`=== ${dry ? 'DRY RUN' : 'REAL TRANSFER'} of ${items.length} item(s) to ${to.email} (${to.id}) – batch ${batch}`)
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
      if (backend.preflightTarget) {
        const problem = await backend.preflightTarget(eid, to).catch(() => null)
        if (problem) { lines.push(`✖ ${ename}: ${problem}`); envBlocked.set(eid, problem); continue }
        lines.push(`✔ ${ename}: ${to.email} passed the user checks (enabled, interactive)`)
      }
      if (backend.checkMember) {
        const member = await backend.checkMember(eid, to).catch(() => null)
        if (member === false) { lines.push(`✖ ${ename}: ${to.email} has no user record in this environment`); envBlocked.set(eid, `${to.email} is not a user of this environment`) }
      }
    }
    if (lines.length) prepNotes = '\n\nEnvironment membership step:\n' + lines.join('\n')
    if (ranPrepare && args.settleMs !== 0) await sleep(args.settleMs ?? 8000)
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
      if (!args.noVerifyDelay) await sleep(2500) // let the change propagate before reading back
      const r = await verify(a)
      record(a, r.status, undefined, r.note)
    } catch (e) {
      const m = (e as Error).message
      halted = `"${a.name}" failed: ${m}`
      // A partial-update failure can leave the agent half-moved. Documented recovery = reassign again: put it back with the ORIGINAL owner, then read back.
      if (isPartialUpdate(m)) {
        const orig = ownerOf(a)
        // Read first, never roll back blindly: the 502 can be a parse error after the change already went through.
        const nowNew = backend.verifyOwner ? await backend.verifyOwner(a, to).catch(() => null) : null
        const stillOld = nowNew === true ? false : backend.verifyOwner ? await backend.verifyOwner(a, orig).catch(() => null) : null
        log(`post-failure read: new owner ${nowNew}, original owner ${stillOld}`)
        if (nowNew === true) {
          acceptedKeys.push(a.key); movedKeys.push(a.key)
          record(a, 'done', undefined, `⚠ The service reported an error, but the read-back shows ${to.email} IS the owner now (CONFIRMED). The agent may still be partly updated - open it in Copilot Studio as the new owner and test it; if it misbehaves run the transfer again (a second reassignment completes it).`)
          continue
        }
        if (stillOld === true) {
          record(a, 'failed', m, `Nothing changed: ${orig.email} is still the owner (CONFIRMED at the source). The agent was not taken from the original user.`)
          continue
        }
        log(`AUTO-ROLLBACK "${a.name}": reassigning back to ${orig.email}`)
        hooks.message(`"${a.name}" failed half-way - restoring ${orig.email} as owner automatically…`)
        let note: string
        try {
          await backend.transfer(a, orig, { mode: 'replace', removeOldOwner: false })
          if (!args.noVerifyDelay) await sleep(4000)
          const back = backend.verifyOwner ? await backend.verifyOwner(a, orig).catch(() => null) : null
          note = back === true ? `Rolled back automatically: ${orig.email} is the owner again (CONFIRMED at the source). The agent stays with the original user.`
            : back === false ? `Rollback sent, but the read-back does not show ${orig.email} yet. Check Copilot Studio; use Restore original owner if needed.`
            : `Rollback sent to ${orig.email}; it could not be read back from here – check Copilot Studio.`
          entries.push({ at: new Date().toISOString(), assetKey: a.key, name: a.name, kind: a.kind, envName: a.envName, from: to, to: orig, mode: 'replace', status: 'done', dryRun: false, batch: 'restore', note })
        } catch (re) {
          note = `⚠ Automatic rollback FAILED: ${(re as Error).message.slice(0, 250)}. Use "Restore original owner".`
          entries.push({ at: new Date().toISOString(), assetKey: a.key, name: a.name, kind: a.kind, envName: a.envName, from: to, to: orig, mode: 'replace', status: 'failed', error: (re as Error).message, dryRun: false, batch: 'restore', note })
        }
        log(`AUTO-ROLLBACK result: ${note}`)
        record(a, 'failed', m, note)
      } else record(a, 'failed', m)
    }
  }

  // apps / flows: light parallelism
  const queue = [...others]
  const worker = async () => {
    for (let a = queue.shift(); a; a = queue.shift()) {
      hooks.status(a.key, 'running')
      try {
        if (dry) await sleep(60)
        else {
          await backend.transfer(a, to, opts)
          const r = await verify(a)
          record(a, r.status, undefined, r.note)
          continue
        }
        record(a, 'dry')
      } catch (e) { record(a, 'failed', (e as Error).message) }
    }
  }
  await Promise.all([worker(), worker(), worker()])

  return { entries, movedKeys, acceptedKeys, unverifiedKeys, prepNotes, halted }
}
