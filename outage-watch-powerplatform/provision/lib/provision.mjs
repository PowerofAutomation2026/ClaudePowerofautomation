// Idempotent provisioning of Outage Watch into one Dataverse environment.
// Every step first READS, then creates only what is missing: running it again is an upgrade, never a duplicate.
import { q, DataverseError } from './client.mjs'
import { ALERT_FLOW_NAME, CONNREF, FLOW_NAME, PUBLISHER, RENAMED, RETIRED_SETTINGS, SOLUTION, TABLES, TEAMS_CONNREF, TENANT_TARGET_NAMES, assertRowFits, seedSettings, seedTargets } from './schema.mjs'
import { CHANNELS, buildAlertClientData, estimateAlertRequests, existingChannels } from './alert-flow.mjs'
import { buildClientData, canonical, estimateRequests, existingHeartbeatUrl, worstCaseRunSeconds } from './flow.mjs'

const SOL = { 'MSCRM.SolutionUniqueName': SOLUTION.uniquename }

export class NeedsConnection extends Error {}
export class NeedsTeamsConnection extends Error {}

/** Dataverse answers a metadata change that collides with another one with this generic, usually transient error. */
export const isTransientMetadata = (e) => e instanceof DataverseError &&
  (e.status >= 500 || (e.status === 400 && (/unexpected error/i.test(e.message) || e.code === '0x80040216')))
const RETRY_WAITS_S = [4, 8, 15, 25, 40]

/** POST a metadata change; on the generic transient error wait, CHECK whether it was applied anyway, then retry. */
async function postMetadata(client, path, body, what, exists, log) {
  for (let attempt = 0; ; attempt++) {
    try { await client.post(path, body, SOL); return }
    catch (e) {
      if (!isTransientMetadata(e)) throw e
      if (attempt >= RETRY_WAITS_S.length) {
        throw new DataverseError(`${e.message} [while creating ${what}; retried ${attempt} times over ${RETRY_WAITS_S.reduce((a, b) => a + b, 0)} s]`, e.status, e.code, e.requestId)
      }
      const w = RETRY_WAITS_S[attempt]
      log(`    ~ ${what}: Dataverse answered "unexpected error" (this is often a timing collision between metadata changes); waiting ${w} s, then checking and retrying (${attempt + 1}/${RETRY_WAITS_S.length})`)
      await client.sleep(w * 1000)
      if (await exists()) { log(`    ~ ${what}: it was created after all`); return }
    }
  }
}

/**
 * Dataverse's Web API keeps its own cached copy of the schema. Right after a table or column is created it can
 * answer "Could not find a property named 'owatch_value' ..." (code 0x80060888) for a while, although the metadata call
 * succeeded. That is a wait-and-retry condition, not a failure.
 */
export const isStaleSchema = (e) => e instanceof DataverseError &&
  (e.code === '0x80060888' || (e.status === 400 && /Could not find a property named/i.test(e.message)))
const SCHEMA_WAITS_S = [5, 10, 15, 20, 30, 30, 30, 30, 30, 30]   // about 4 minutes in total

async function retrySchema(client, what, fn, log) {
  for (let i = 0; ; i++) {
    try { return await fn() }
    catch (e) {
      if (!isStaleSchema(e)) throw e
      if (i >= SCHEMA_WAITS_S.length) {
        throw new DataverseError(`${e.message} [${what}: Dataverse still did not list the new columns after ${SCHEMA_WAITS_S.reduce((a, b) => a + b, 0)} s. ` +
          'This is a delay on the Dataverse side: wait a few minutes and re-run the same command]', e.status, e.code, e.requestId)
      }
      log(`    ~ ${what}: Dataverse has not refreshed its schema yet; waiting ${SCHEMA_WAITS_S[i]} s (${i + 1}/${SCHEMA_WAITS_S.length})`)
      await client.sleep(SCHEMA_WAITS_S[i] * 1000)
    }
  }
}

/** Do not seed anything until the Web API can read every column we are about to use. */
async function waitForColumns(client, entitySets, log) {
  for (const t of TABLES) {
    const cols = [t.primaryId, 'owatch_name', ...t.columns.map((c) => c.SchemaName.toLowerCase())]
    await retrySchema(client, `table ${t.logical}`, () => client.get(`${entitySets[t.logical]}?$select=${cols.join(',')}&$top=1`), log)
  }
}

/** A table that was just created is not always ready for column changes: wait until its primary column can be read. */
async function waitForTable(client, path, log) {
  for (let i = 0; i < 30; i++) {
    if (await client.find(`${path}/Attributes(LogicalName='owatch_name')?$select=LogicalName`)) { await client.sleep(3000); return }
    if (i === 0) log('    waiting for the new table to become ready...')
    await client.sleep(2000)
  }
  log('    the new table is still not readable after 60 s; trying to continue')
}
export class FlowNotOn extends Error { constructor(m, flowId) { super(m); this.flowId = flowId } }

/**
 * @param client  createClient(...)
 * @param o       { intervalMinutes, retentionDays, timeoutSeconds, tenant?, connectionId?, heartbeatUrl?, clearHeartbeat? }
 * @param log     (text) => void   (never receives secrets)
 */
export async function apply(client, o, log = () => {}) {
  const res = { created: [], updated: [], warnings: [], entitySets: {}, flowId: null, flowOn: false, targets: 0, heartbeat: false }
  const did = (kind, what) => { res[kind].push(what); log(`  ${kind === 'created' ? '+' : '~'} ${what}`) }

  log('[1/8] Checking access (WhoAmI)')
  const who = (await client.get('WhoAmI')).json
  res.userId = who?.UserId ?? null

  log('[2/8] Publisher and solution')
  let pub = (await client.get(`publishers?$select=publisherid,customizationprefix&$filter=uniquename eq ${q(PUBLISHER.uniquename)}`)).json.value[0]
  if (!pub) {
    const r = await client.post('publishers', PUBLISHER)
    pub = { publisherid: r.entityId, customizationprefix: PUBLISHER.customizationprefix }
    did('created', `publisher ${PUBLISHER.uniquename} (prefix ${PUBLISHER.customizationprefix}_)`)
  } else if (pub.customizationprefix !== PUBLISHER.customizationprefix) {
    throw new DataverseError(`a publisher named '${PUBLISHER.uniquename}' already exists with a different prefix ('${pub.customizationprefix}'). Nothing was changed.`, 0, 'PublisherConflict')
  }
  const sol = (await client.get(`solutions?$select=solutionid,ismanaged&$filter=uniquename eq ${q(SOLUTION.uniquename)}`)).json.value[0]
  if (!sol) {
    await client.post('solutions', { uniquename: SOLUTION.uniquename, friendlyname: SOLUTION.friendlyname, version: SOLUTION.version, description: SOLUTION.description, 'publisherid@odata.bind': `/publishers(${pub.publisherid})` })
    did('created', `solution ${SOLUTION.uniquename}`)
  }

  log('[3/8] Tables and columns')
  let metadataChanged = false
  for (const t of TABLES) {
    const path = `EntityDefinitions(LogicalName=${q(t.logical)})`
    let meta = await client.find(`${path}?$select=MetadataId,LogicalName,EntitySetName`)
    if (!meta) {
      await postMetadata(client, 'EntityDefinitions', t.create, `table ${t.logical}`,
        async () => !!(await client.find(`${path}?$select=MetadataId`)), log)
      did('created', `table ${t.logical}`); metadataChanged = true
      await waitForTable(client, path, log)
    }
    for (const c of t.columns) {
      const col = c.SchemaName.toLowerCase()
      if (meta) {   // a table created a moment ago cannot have the column yet: skip the read
        const have = await client.find(`${path}/Attributes(LogicalName=${q(col)})?$select=LogicalName`)
        if (have) continue
      }
      await postMetadata(client, `${path}/Attributes`, c, `column ${t.logical}.${col} (${c.AttributeType})`,
        async () => !!(await client.find(`${path}/Attributes(LogicalName=${q(col)})?$select=LogicalName`)), log)
      did('created', `column ${t.logical}.${col}`); metadataChanged = true
    }
    if (!meta) meta = (await client.get(`${path}?$select=MetadataId,LogicalName,EntitySetName`)).json
    if (!meta?.EntitySetName) throw new DataverseError(`table ${t.logical} has no entity set name`, 0, 'Metadata')
    res.entitySets[t.logical] = meta.EntitySetName
  }
  if (metadataChanged) {
    const xml = '<importexportxml><entities>' + TABLES.map((t) => `<entity>${t.logical}</entity>`).join('') + '</entities></importexportxml>'
    await client.post('PublishXml', { ParameterXml: xml })
    log('  published table customizations')
  }
  log('  checking that the Web API can read the new columns')
  await waitForColumns(client, res.entitySets, log)
  const sets = { target: res.entitySets.owatch_target, result: res.entitySets.owatch_result, setting: res.entitySets.owatch_setting, incident: res.entitySets.owatch_incident }

  log('[4/8] Seeding targets (existing rows are never overwritten)')
  const existing = (await client.get(`${sets.target}?$select=owatch_name,owatch_url,owatch_enabled,owatch_targetid`)).json.value
  const haveT = new Map(existing.map((r) => [r.owatch_name, r]))
  // Upgrade from the 15-target version: sharepoint -> sharepoint-online, onedrive -> onedrive-business.
  // The ROW is renamed in place (keeps its URL and enabled flag: no duplicate, nothing re-created). Result rows keep
  // the old name; the dashboard maps old names to new ones when it reads them, so history stays visible and
  // simply ages out with the retention. No bulk rewrite of result rows.
  for (const [oldName, newName] of Object.entries(RENAMED)) {
    const old = haveT.get(oldName)
    if (!old) continue
    if (!haveT.has(newName)) {
      await client.patch(`${sets.target}(${old.owatch_targetid})`, assertRowFits('owatch_target', { owatch_name: newName }, { partial: true }))
      haveT.delete(oldName); haveT.set(newName, { ...old, owatch_name: newName })
      did('updated', `target ${oldName} renamed to ${newName}`)
    } else if (old.owatch_enabled !== false) {
      await client.patch(`${sets.target}(${old.owatch_targetid})`, { owatch_enabled: false })
      old.owatch_enabled = false
      did('updated', `target ${oldName} disabled (superseded by ${newName})`)
      res.warnings.push(`both ${oldName} and ${newName} exist; ${oldName} was disabled, delete it when convenient`)
    }
  }
  const seeds = seedTargets(o.tenant)
  for (const row of seeds) assertRowFits('owatch_target', row)        // check ALL rows first: never stop half-way through the list
  for (const row of seeds) {
    const cur = haveT.get(row.owatch_name)
    if (!cur) {
      await client.post(sets.target, row)
      did('created', `target ${row.owatch_name}${row.owatch_url ? '' : ' (disabled: needs tenant name)'}`); haveT.set(row.owatch_name, row)
    } else if (TENANT_TARGET_NAMES.includes(row.owatch_name) && !cur.owatch_url && row.owatch_url) {
      // tenant name supplied now: fill in the row that was waiting for it (a row that already has a URL is the admin's)
      await client.patch(`${sets.target}(${cur.owatch_targetid})`, assertRowFits('owatch_target', { owatch_url: row.owatch_url, owatch_enabled: true }, { partial: true }))
      cur.owatch_url = row.owatch_url; cur.owatch_enabled = true
      did('updated', `target ${row.owatch_name} configured for the tenant`)
    }
  }
  res.targets = haveT.size
  res.enabledTargets = [...haveT.values()].filter((r) => r.owatch_enabled !== false && r.owatch_url).length
  res.unconfigured = [...haveT.values()].filter((r) => !r.owatch_url).map((r) => r.owatch_name).sort()

  log('[5/8] Connection reference for the Dataverse connector')
  let ref = (await client.get(`connectionreferences?$select=connectionreferenceid,connectionid&$filter=connectionreferencelogicalname eq ${q(CONNREF.logicalName)}`)).json.value[0]
  if (!ref) {
    if (!o.connectionId) throw new NeedsConnection('no Microsoft Dataverse connection id was supplied and no connection reference exists yet')
    const r = await client.post('connectionreferences', { connectionreferencelogicalname: CONNREF.logicalName, connectionreferencedisplayname: CONNREF.displayName, connectorid: CONNREF.connectorId, connectionid: o.connectionId, description: 'Used by the Outage Watch probe flow.' }, SOL)
    ref = { connectionreferenceid: r.entityId, connectionid: o.connectionId }
    did('created', `connection reference ${CONNREF.logicalName}`)
  } else if (o.connectionId && ref.connectionid !== o.connectionId) {
    await client.patch(`connectionreferences(${ref.connectionreferenceid})`, { connectionid: o.connectionId })
    did('updated', `connection reference ${CONNREF.logicalName} -> current connection`)
  } else if (!ref.connectionid) {
    throw new NeedsConnection('the connection reference exists but is not bound to a connection')
  }

  log('[6/8] Probe flow')
  const flow = await findFlow(client, sets, log)
  let heartbeatUrl = o.clearHeartbeat ? null : (o.heartbeatUrl ?? null)
  if (!heartbeatUrl && !o.clearHeartbeat && flow) heartbeatUrl = existingHeartbeatUrl(flow.clientdata)   // keep it across upgrades
  res.heartbeat = !!heartbeatUrl
  const clientdata = buildClientData({ intervalMinutes: o.intervalMinutes, retentionDays: o.retentionDays, timeoutSeconds: o.timeoutSeconds, heartbeatUrl, sets })
  const description = 'Outage Watch probe: records RAW facts only (HTTP status, elapsed ms, error code). Managed by Deploy-OutageWatchPP; manual edits are overwritten on the next deploy.'
  let flowId = flow?.workflowid ?? null
  let state = flow?.statecode ?? 0
  if (!flow) {
    const r = await client.post('workflows', { category: 5, name: FLOW_NAME, type: 1, description, primaryentity: 'none', clientdata: JSON.stringify(clientdata) }, SOL)
    flowId = r.entityId
    if (!flowId) flowId = (await findFlow(client, sets, log))?.workflowid ?? null
    if (!flowId) throw new DataverseError('the flow was created but its id could not be read back', 0, 'FlowId')
    did('created', `cloud flow "${FLOW_NAME}"`)
  } else if (!sameDefinition(flow.clientdata, clientdata)) {
    if (state === 1) { await client.patch(`workflows(${flowId})`, { statecode: 0 }); state = 0 }   // edit while off
    await client.patch(`workflows(${flowId})`, { clientdata: JSON.stringify(clientdata), description })
    did('updated', `cloud flow "${FLOW_NAME}" definition`)
  }
  res.flowId = flowId

  log('[7/8] Settings (flow id, interval, retention, thresholds)')
  const haveS = new Map((await retrySchema(client, 'settings', () => client.get(`${sets.setting}?$select=owatch_name,owatch_value,owatch_settingid`), log)).json.value.map((r) => [r.owatch_name, r]))
  const settings = [...seedSettings({ ...o, heartbeat: res.heartbeat }), { name: 'flow_workflowid', value: flowId, force: true }]
  for (const s of settings) assertRowFits('owatch_setting', { owatch_name: s.name, owatch_value: s.value })   // all checked before the first write
  for (const s of settings) {
    const cur = haveS.get(s.name)
    if (!cur) { await client.post(sets.setting, { owatch_name: s.name, owatch_value: s.value }); did('created', `setting ${s.name}`) }
    else if (s.force && cur.owatch_value !== s.value) { await client.patch(`${sets.setting}(${cur.owatch_settingid})`, { owatch_value: s.value }); did('updated', `setting ${s.name}`) }
  }
  for (const r of RETIRED_SETTINGS) {       // no longer stored: remove only an untouched shipped default, keep an admin's own value
    const cur = haveS.get(r.name)
    if (cur && r.deleteIf.includes(cur.owatch_value)) { await client.del(`${sets.setting}(${cur.owatch_settingid})`); did('updated', `setting ${r.name} removed (the dashboard now uses its built-in list)`) }
  }

  log('[8/8] Turning the flow on')
  if (state !== 1) {
    try {
      await client.patch(`workflows(${flowId})`, { statecode: 1 })
      did('updated', 'cloud flow turned ON')
    } catch (e) {
      throw new FlowNotOn(e.message, flowId)
    }
  }
  res.flowOn = true

  log('[alerts] Teams alert flow (separate from the probe flow: a Teams problem can never stop probing)')
  res.alerts = await applyAlerts(client, o, sets, did, log)
  res.estimate = estimateRequests(res.enabledTargets, o.intervalMinutes, res.heartbeat)
  // total for BOTH flows: the alert flow costs requests only while it is on
  res.estimate.probePerDay = res.estimate.perDay
  res.estimate.alertPerDay = res.alerts.status === 'on' ? estimateAlertRequests(o.intervalMinutes).perDay : 0     // quiet-day figure; failures and messages add a little (see README)
  res.estimate.perDay = res.estimate.probePerDay + res.estimate.alertPerDay
  res.estimate.pctOf40k = Math.round((res.estimate.perDay / 40000) * 100)
  res.estimate.pctOf6k = Math.round((res.estimate.perDay / 6000) * 100)
  res.estimate.high = res.estimate.pctOf40k > 60
  res.estimate.over = res.estimate.perDay > 40000
  res.worstCaseRunSeconds = worstCaseRunSeconds(res.enabledTargets, o.timeoutSeconds)
  return res
}

async function upsertSetting(client, sets, name, value, did) {
  assertRowFits('owatch_setting', { owatch_name: name, owatch_value: value })
  const cur = (await client.get(`${sets.setting}?$select=owatch_value,owatch_settingid&$filter=owatch_name eq ${q(name)}`)).json.value[0]
  if (!cur) { await client.post(sets.setting, { owatch_name: name, owatch_value: value }); did?.('created', `setting ${name}`) }
  else if ((cur.owatch_value ?? '') !== value) { await client.patch(`${sets.setting}(${cur.owatch_settingid})`, { owatch_value: value }); did?.('updated', `setting ${name}`) }
}

async function findAlertFlow(client) {
  return (await client.get(`workflows?$select=workflowid,name,statecode,clientdata&$filter=category eq 5 and name eq ${q(ALERT_FLOW_NAME)}`)).json.value[0] ?? null
}

/**
 * Alert channels (Teams / Slack / Webex / generic webhook). Returns { status: 'on' | 'not-configured' | 'disabled' |
 * 'failed', channels: [...] } and NEVER throws for a problem of the alert flow itself: tables, targets and the
 * probe flow are already deployed and must stay usable. (The one exception is "a Teams connection is needed",
 * which the deploy script resolves and then retries.)
 *   o.teams              { groupId, channelId, channelName }  parsed from -TeamsChannelLink (optional)
 *   o.teamsConnectionId  id of the caller's Microsoft Teams connection (optional when the reference already exists)
 *   o.webhooks           { slack?, webex?, webhook? }  incoming-webhook URLs. SECRETS: only ever placed in the flow definition
 *   o.removeChannels     ['slack', ...]   o.noAlerts   turn the flow off      o.sendTestAlert   TEST message on the next run
 * Channels given earlier are kept when a later run does not mention them.
 */
async function applyAlerts(client, o, sets, did, log) {
  const flow = await findAlertFlow(client)
  if (o.noAlerts) {
    if (flow && flow.statecode === 1) { await client.patch(`workflows(${flow.workflowid})`, { statecode: 0 }); did('updated', `cloud flow "${ALERT_FLOW_NAME}" turned OFF (-NoAlerts)`) }
    await upsertSetting(client, sets, 'alert_configured', 'no', did)
    return { status: 'disabled', channels: [] }
  }
  const kept = flow ? existingChannels(flow.clientdata) : { teams: null, slack: null, webex: null, webhook: null }
  const channels = { teams: o.teams ? { groupId: o.teams.groupId, channelId: o.teams.channelId } : kept.teams, slack: o.webhooks?.slack ?? kept.slack, webex: o.webhooks?.webex ?? kept.webex, webhook: o.webhooks?.webhook ?? kept.webhook }
  for (const c of o.removeChannels ?? []) channels[c] = null
  const names = CHANNELS.filter((c) => channels[c])
  if (!names.length) {
    if (flow && flow.statecode === 1) { await client.patch(`workflows(${flow.workflowid})`, { statecode: 0 }); did('updated', `cloud flow "${ALERT_FLOW_NAME}" turned OFF (no channel left)`) }
    await upsertSetting(client, sets, 'alert_configured', 'no', did)
    await upsertSetting(client, sets, 'alert_channels', '', did)
    log('  not configured: no alert channel was given (re-run with -TeamsChannelLink, -SetSlackWebhook or -SetWebexWebhook to add alerts)')
    return { status: 'not-configured', channels: [] }
  }
  let ref = null
  if (channels.teams) {
    ref = (await client.get(`connectionreferences?$select=connectionreferenceid,connectionid&$filter=connectionreferencelogicalname eq ${q(TEAMS_CONNREF.logicalName)}`)).json.value[0]
    if (!ref?.connectionid && !o.teamsConnectionId) throw new NeedsTeamsConnection('a Microsoft Teams connection is needed for the alert flow')
  }
  try {
    if (channels.teams && !ref) {
      const r = await client.post('connectionreferences', { connectionreferencelogicalname: TEAMS_CONNREF.logicalName, connectionreferencedisplayname: TEAMS_CONNREF.displayName, connectorid: TEAMS_CONNREF.connectorId, connectionid: o.teamsConnectionId, description: 'Used by the Outage Watch alert flow to post in a Teams channel.' }, SOL)
      ref = { connectionreferenceid: r.entityId, connectionid: o.teamsConnectionId }
      did('created', `connection reference ${TEAMS_CONNREF.logicalName}`)
    } else if (channels.teams && o.teamsConnectionId && ref.connectionid !== o.teamsConnectionId) {
      await client.patch(`connectionreferences(${ref.connectionreferenceid})`, { connectionid: o.teamsConnectionId })
      did('updated', `connection reference ${TEAMS_CONNREF.logicalName} -> current connection`)
    }
    const clientdata = buildAlertClientData({ intervalMinutes: o.intervalMinutes, channels, sets })
    const description = 'Outage Watch alerts: tells the configured channels when a service fails, keeps failing, or recovers; keeps incident records and the CI status. Managed by Deploy-OutageWatchPP; manual edits are overwritten on the next deploy.'
    let flowId = flow?.workflowid ?? null
    let state = flow?.statecode ?? 0
    if (!flow) {
      const r = await client.post('workflows', { category: 5, name: ALERT_FLOW_NAME, type: 1, description, primaryentity: 'none', clientdata: JSON.stringify(clientdata) }, SOL)
      flowId = r.entityId ?? (await findAlertFlow(client))?.workflowid ?? null
      if (!flowId) throw new DataverseError('the alert flow was created but its id could not be read back', 0, 'FlowId')
      did('created', `cloud flow "${ALERT_FLOW_NAME}"`)
    } else if (!sameDefinition(flow.clientdata, clientdata)) {
      if (state === 1) { await client.patch(`workflows(${flowId})`, { statecode: 0 }); state = 0 }
      await client.patch(`workflows(${flowId})`, { clientdata: JSON.stringify(clientdata), description })
      did('updated', `cloud flow "${ALERT_FLOW_NAME}" definition`)
    }
    if (state !== 1) { await client.patch(`workflows(${flowId})`, { statecode: 1 }); did('updated', `cloud flow "${ALERT_FLOW_NAME}" turned ON`) }
    await upsertSetting(client, sets, 'alert_configured', 'yes', did)
    await upsertSetting(client, sets, 'alert_channels', names.join(','), did)                   // channel TYPES only - never a URL
    if (o.teams) await upsertSetting(client, sets, 'alert_channel_name', o.teams.channelName ?? '', did)
    if (o.sendTestAlert) { await upsertSetting(client, sets, 'alert_test', 'yes', did); log('  TEST message requested: it is sent to every configured channel by the next run of the alert flow (within one interval)') }
    return { status: 'on', flowId, channels: names }
  } catch (e) {
    // The probe flow, tables and dashboard are fine. Say exactly what happened and carry on.
    try { await upsertSetting(client, sets, 'alert_configured', 'no') } catch { /* the original error is the one to report */ }
    log('  ALERT FLOW NOT ACTIVE: ' + e.message)
    return { status: 'failed', message: String(e.message).slice(0, 500), channels: names }
  }
}

/** Stores the URL of the published dashboard so alert messages can link to it. */
export async function setDashboardUrl(client, url) {
  const sm = await client.find(`EntityDefinitions(LogicalName='owatch_setting')?$select=EntitySetName`)
  if (!sm) throw new DataverseError('the settings table does not exist', 404, 'Missing')
  await upsertSetting(client, { setting: sm.EntitySetName }, 'dashboard_url', url)
}

function sameDefinition(existingText, wanted) {
  try {
    const cur = JSON.parse(existingText)
    return canonical(cur?.properties?.definition) === canonical(wanted.properties.definition)
      && canonical(cur?.properties?.connectionReferences) === canonical(wanted.properties.connectionReferences)
  } catch { return false }
}

async function findFlow(client, sets, log = () => {}) {
  const sel = '$select=workflowid,name,statecode,clientdata'
  if (sets?.setting) {
    const s = (await retrySchema(client, 'settings', () => client.get(`${sets.setting}?$select=owatch_value&$filter=owatch_name eq 'flow_workflowid'`), log)).json.value[0]
    if (s && /^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/.test(s.owatch_value ?? '')) {
      const f = await client.find(`workflows(${s.owatch_value})?${sel}`)
      if (f) return f
    }
  }
  const list = (await client.get(`workflows?${sel}&$filter=category eq 5 and name eq ${q(FLOW_NAME)}`)).json.value
  return list[0] ?? null
}

/** Read-only smoke test: tables readable, targets seeded, and (optionally) wait for the first NEW result row. */
export async function smoke(client, { waitSeconds = 240, pollSeconds = 10, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {}, log = () => {}) {
  const sets = {}
  for (const t of TABLES) {
    const meta = await client.find(`EntityDefinitions(LogicalName=${q(t.logical)})?$select=EntitySetName`)
    if (!meta) throw new DataverseError(`table ${t.logical} does not exist`, 404, 'Missing')
    sets[t.logical] = meta.EntitySetName
  }
  const targets = (await client.get(`${sets.owatch_target}?$select=owatch_name&$filter=owatch_enabled eq true`)).json.value.length
  log(`  targets table readable: ${targets} enabled target(s)`)
  const since = new Date(now() - 60_000).toISOString()
  const deadline = now() + waitSeconds * 1000
  const query = `${sets.owatch_result}?$select=owatch_name,owatch_httpstatus,owatch_elapsedms,owatch_errorkind,owatch_probedat&$filter=owatch_probedat ge ${since}&$orderby=owatch_probedat desc&$top=50`
  for (;;) {
    const rows = (await client.get(query)).json.value
    if (rows.length) {
      log(`  first result rows arrived: ${rows.length} row(s)`)
      return { ok: true, targets, rows: rows.length, sample: rows.slice(0, 20).map((r) => ({ name: r.owatch_name, http: r.owatch_httpstatus ?? null, ms: r.owatch_elapsedms ?? null, error: r.owatch_errorkind || null })) }
    }
    if (now() >= deadline) return { ok: false, targets, rows: 0, sample: [] }
    log(`  waiting for the first flow run to write results... (${Math.max(0, Math.round((deadline - now()) / 1000))} s left)`)
    await sleep(pollSeconds * 1000)
  }
}

/** Removes the flow; with purge also the tables (ALL collected data), connection reference, solution and publisher. */
export async function uninstall(client, { purge = false } = {}, log = () => {}) {
  const res = { removed: [], kept: [] }
  const gone = (w) => { res.removed.push(w); log(`  - ${w}`) }
  let sets = null
  const sm = await client.find(`EntityDefinitions(LogicalName='owatch_setting')?$select=EntitySetName`)
  if (sm) sets = { setting: sm.EntitySetName }
  const flow = await findFlow(client, sets)
  if (flow) {
    if (flow.statecode === 1) await client.patch(`workflows(${flow.workflowid})`, { statecode: 0 })
    await client.del(`workflows(${flow.workflowid})`)
    gone(`cloud flow "${FLOW_NAME}"`)
  }
  const alertFlow = await findAlertFlow(client)
  if (alertFlow) {
    if (alertFlow.statecode === 1) await client.patch(`workflows(${alertFlow.workflowid})`, { statecode: 0 })
    await client.del(`workflows(${alertFlow.workflowid})`)
    gone(`cloud flow "${ALERT_FLOW_NAME}"`)
  }
  if (!purge) { res.kept.push('tables and collected data', 'connection reference', 'solution', 'publisher'); return res }
  const ref = (await client.get(`connectionreferences?$select=connectionreferenceid&$filter=connectionreferencelogicalname eq ${q(CONNREF.logicalName)}`)).json.value[0]
  if (ref) { await client.del(`connectionreferences(${ref.connectionreferenceid})`); gone(`connection reference ${CONNREF.logicalName}`) }
  const tref = (await client.get(`connectionreferences?$select=connectionreferenceid&$filter=connectionreferencelogicalname eq ${q(TEAMS_CONNREF.logicalName)}`)).json.value[0]
  if (tref) { await client.del(`connectionreferences(${tref.connectionreferenceid})`); gone(`connection reference ${TEAMS_CONNREF.logicalName}`) }
  for (const t of [...TABLES].reverse()) {
    if (await client.find(`EntityDefinitions(LogicalName=${q(t.logical)})?$select=MetadataId`)) { await client.del(`EntityDefinitions(LogicalName=${q(t.logical)})`); gone(`table ${t.logical} (with its rows)`) }
  }
  const sol = (await client.get(`solutions?$select=solutionid&$filter=uniquename eq ${q(SOLUTION.uniquename)}`)).json.value[0]
  if (sol) { await client.del(`solutions(${sol.solutionid})`); gone(`solution ${SOLUTION.uniquename}`) }
  const pub = (await client.get(`publishers?$select=publisherid&$filter=uniquename eq ${q(PUBLISHER.uniquename)}`)).json.value[0]
  if (pub) { await client.del(`publishers(${pub.publisherid})`); gone(`publisher ${PUBLISHER.uniquename}`) }
  return res
}
