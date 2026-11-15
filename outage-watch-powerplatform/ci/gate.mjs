#!/usr/bin/env node
// Outage Watch CI gate: "is it safe to change things right now?"
//
// Reads ONE row (setting ci_status) from the Dataverse Web API of the environment where Outage Watch is deployed
// and exits 0 (go) or 1 (stop). Zero dependencies, Node 18+.
//
//   OUTAGEWATCH_ORG_URL   https://<org>.crm<N>.dynamics.com          (required)
//   OUTAGEWATCH_TOKEN     bearer token for that URL                  (required; see ci/README.md for how a pipeline gets one)
//   --block-on freeze|caution   default freeze: only a confirmed failure (or failing sign-in) stops the pipeline
//   --stale-minutes N           default 35 (3 probe intervals + margin): older data counts as STALE
//   --on-stale fail|pass        default fail (fail closed: if the monitor itself is silent, do not deploy blind)
//   --json                      print the decision as JSON
//
// Same-fate note: this gate reads from Power Platform. If Dataverse or sign-in is down the request fails and the
// gate stops the pipeline (exit 1) unless --on-stale pass is given.

/** Pure decision. `value` is the text of the ci_status setting (or null), `nowMs` the current time. */
export function decide(value, nowMs, { blockOn = 'freeze', staleMinutes = 35, onStale = 'fail' } = {}) {
  let s = null
  try { s = JSON.parse(value ?? '') } catch { s = null }
  const known = s && typeof s === 'object' && ['ok', 'caution', 'freeze'].includes(s.level) && typeof s.updated === 'string' && Number.isFinite(Date.parse(s.updated))
  if (!known) return { allow: onStale === 'pass', level: 'unknown', stale: true, reason: 'no readable status (the alert flow has not written one yet, or it is not deployed)', services: [], since: null, ageMinutes: null }
  const ageMinutes = Math.floor((nowMs - Date.parse(s.updated)) / 60000)
  const services = String(s.services ?? '').split(',').filter(Boolean).slice(0, 40)
  const base = { level: s.level, since: typeof s.since === 'string' ? s.since : null, services, ageMinutes, failing: Number(s.failing) || 0, confirmed: Number(s.confirmed) || 0 }
  if (ageMinutes > staleMinutes || ageMinutes < -5) return { ...base, allow: onStale === 'pass', stale: true, reason: `status is ${ageMinutes} min old (limit ${staleMinutes}): the monitor is not updating` }
  const rank = { ok: 0, caution: 1, freeze: 2 }
  const allow = rank[s.level] < rank[blockOn === 'caution' ? 'caution' : 'freeze']
  const what = services.length ? `${base.failing} failing: ${services.slice(0, 8).join(', ')}${services.length > 8 ? ', ...' : ''}` : 'nothing failing'
  return { ...base, allow, stale: false, reason: `level ${s.level} since ${base.since ?? '?'} (${what})` }
}

const ORG_RE = /^https:\/\/[a-z0-9][a-z0-9-]{0,62}\.(?:crm(?:[0-9]{1,2})?\.dynamics\.com|crm(?:[0-9]{1,2})?\.microsoftdynamics\.us|crm\.appsplatform\.us|crm\.dynamics\.cn)$/

export async function main(argv, env = process.env, fetchImpl = fetch, now = () => Date.now(), print = console.log) {
  const opt = { blockOn: 'freeze', staleMinutes: 35, onStale: 'fail', json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opt.json = true
    else if (a === '--block-on' && ['freeze', 'caution'].includes(argv[i + 1])) opt.blockOn = argv[++i]
    else if (a === '--on-stale' && ['fail', 'pass'].includes(argv[i + 1])) opt.onStale = argv[++i]
    else if (a === '--stale-minutes' && /^[0-9]{1,5}$/.test(argv[i + 1] ?? '')) opt.staleMinutes = Number(argv[++i])
    else { print('usage: gate.mjs [--block-on freeze|caution] [--stale-minutes N] [--on-stale fail|pass] [--json]'); return 2 }
  }
  const org = String(env.OUTAGEWATCH_ORG_URL ?? '').replace(/\/+$/, '')
  if (!ORG_RE.test(org) && !(env.OUTAGEWATCH_TEST_MODE === '1' && /^http:\/\/127\.0\.0\.1:[0-9]+$/.test(org))) { print('OUTAGEWATCH_ORG_URL must be https://<org>.crm<N>.dynamics.com'); return 2 }
  if (!env.OUTAGEWATCH_TOKEN) { print('OUTAGEWATCH_TOKEN is empty'); return 2 }
  let value = null; let d
  try {
    const set = env.OUTAGEWATCH_SETTINGS_SET ?? 'owatch_settings'
    if (!/^[a-z0-9_]{1,80}$/.test(set)) { print('OUTAGEWATCH_SETTINGS_SET is not an entity set name'); return 2 }
    const res = await fetchImpl(`${org}/api/data/v9.2/${set}?$select=owatch_value&$filter=owatch_name eq 'ci_status'&$top=1`, { headers: { Authorization: 'Bearer ' + env.OUTAGEWATCH_TOKEN, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' }, redirect: 'error' })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    value = (await res.json())?.value?.[0]?.owatch_value ?? null
    d = decide(value, now(), opt)
  } catch (e) {
    d = { allow: opt.onStale === 'pass', level: 'unknown', stale: true, reason: 'could not read the status: ' + String(e?.message ?? e).replace(/Bearer\s+\S+/g, 'Bearer [redacted]').slice(0, 120), services: [], since: null, ageMinutes: null }
  }
  if (opt.json) print(JSON.stringify(d))
  else print(`Outage Watch gate: ${d.allow ? 'GO' : 'STOP'} - ${d.reason}${d.stale ? ' [STALE: ' + (opt.onStale === 'pass' ? 'passing as configured' : 'failing closed') + ']' : ''}`)
  return d.allow ? 0 : 1
}

import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2)).then((c) => { process.exitCode = c })
