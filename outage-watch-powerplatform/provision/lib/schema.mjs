// Dataverse schema for Outage Watch (Power Platform edition).
// Payload shapes follow the documented Web API metadata examples (see DESIGN.md for the doc links).
import { readFileSync } from 'node:fs'

export const catalog = JSON.parse(readFileSync(new URL('../../shared/catalog.json', import.meta.url), 'utf8'))

export const PUBLISHER = { uniquename: 'outagewatch', friendlyname: 'Outage Watch', customizationprefix: 'owatch', customizationoptionvalueprefix: 72700, description: 'Publisher for the Outage Watch monitor tables and flow.' }
export const SOLUTION = { uniquename: 'OutageWatch', friendlyname: 'Outage Watch', version: '1.0.0.0', description: 'Outage Watch: probe flow, tables and connection reference. Created by Deploy-OutageWatchPP.' }
export const CONNREF = { logicalName: 'owatch_dataverse', displayName: 'Outage Watch - Dataverse', connectorId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps', api: 'shared_commondataserviceforapps' }
export const FLOW_NAME = 'Outage Watch - probe'
export const ALERT_FLOW_NAME = 'Outage Watch - alert'
export const TEAMS_CONNREF = { logicalName: 'owatch_teams', displayName: 'Outage Watch - Teams', connectorId: '/providers/Microsoft.PowerApps/apis/shared_teams', api: 'shared_teams' }
export const SCHEMA_VERSION = '3'
/** Targets renamed since the 15-target version: old name -> new name. */
export const RENAMED = catalog.renamed

const label = (text) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: text, LanguageCode: 1033 }] })
const required = (v = 'None') => ({ Value: v, CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' })

const str = (name, display, max, desc) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata', AttributeType: 'String', AttributeTypeName: { Value: 'StringType' },
  SchemaName: name, DisplayName: label(display), Description: label(desc), RequiredLevel: required(), MaxLength: max, FormatName: { Value: 'Text' },
})
const int = (name, display, min, max, desc) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata', AttributeType: 'Integer', AttributeTypeName: { Value: 'IntegerType' },
  SchemaName: name, DisplayName: label(display), Description: label(desc), RequiredLevel: required(), Format: 'None', MinValue: min, MaxValue: max,
})
const bool = (name, display, def, desc) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.BooleanAttributeMetadata', AttributeType: 'Boolean', AttributeTypeName: { Value: 'BooleanType' },
  SchemaName: name, DisplayName: label(display), Description: label(desc), RequiredLevel: required(), DefaultValue: def,
  OptionSet: { TrueOption: { Value: 1, Label: label('Yes') }, FalseOption: { Value: 0, Label: label('No') }, OptionSetType: 'Boolean' },
})
const datetime = (name, display, desc) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata', AttributeType: 'DateTime', AttributeTypeName: { Value: 'DateTimeType' },
  SchemaName: name, DisplayName: label(display), Description: label(desc), RequiredLevel: required(), Format: 'DateAndTime',
})

const table = (logical, display, plural, desc, primaryDisplay, primaryMax, columns) => ({
  logical, primaryId: logical + 'id', columns,
  create: {
    '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
    SchemaName: logical, DisplayName: label(display), DisplayCollectionName: label(plural), Description: label(desc),
    OwnershipType: 'UserOwned', HasActivities: false, HasNotes: false, IsActivity: false,
    Attributes: [{ ...str('owatch_name', primaryDisplay, primaryMax, 'Primary name.'), IsPrimaryName: true, RequiredLevel: required('ApplicationRequired') }],
  },
})

export const TABLES = [
  table('owatch_target', 'Outage Watch Target', 'Outage Watch Targets', 'Endpoints probed by the Outage Watch flow.', 'Name', 100, [
    str('owatch_url', 'URL', 500, 'https:// URL probed with an unauthenticated GET. Empty = not set up yet (shown as unconfigured, never probed).'),
    str('owatch_alivecodes', 'Alive HTTP codes', 200, 'Comma separated HTTP codes that mean healthy. Empty = any answer below 500 that is not 429.'),
    bool('owatch_dependsonauth', 'Depends on sign-in', false, 'Cannot work for signed-in users when the auth target is down.'),
    bool('owatch_copilotneeds', 'Copilot needs it', false, 'Microsoft 365 Copilot reads from this service.'),
    bool('owatch_enabled', 'Enabled', true, 'Only enabled targets are probed.'),
    str('owatch_family', 'Family', 100, 'Service family: groups the target on the dashboard map. Empty = looked up by name, else Independent.'),
    // --- alert state, written ONLY by the alert flow (one row per target, so alerts are never duplicated across runs) ---
    int('owatch_failcount', 'Consecutive failures', 0, 1000000, 'Alert state: failed probe rounds in a row. 0 = healthy.'),
    datetime('owatch_failingsince', 'Failing since', 'Alert state: time of the first failed probe of the current streak (meaningful only while consecutive failures > 0).'),
    str('owatch_lastok', 'Last success round', 40, 'Alert state: probe round before the current failure streak began.'),
    bool('owatch_alertopen', 'Alert open', false, 'Alert state: an incident message was posted and no recovery message yet.'),
    datetime('owatch_lastalertat', 'Last alert at', 'Alert state: when the last incident or reminder message for this target was posted.'),
  ]),
  table('owatch_result', 'Outage Watch Result', 'Outage Watch Results', 'One RAW probe fact per target per flow run. No judgement is stored.', 'Target name', 100, [
    int('owatch_httpstatus', 'HTTP status', 0, 999, 'HTTP status of the answer. Empty = no HTTP answer.'),
    int('owatch_elapsedms', 'Elapsed ms', 0, 2147483647, 'Duration of the probe action in milliseconds.'),
    str('owatch_errorkind', 'Error kind', 100, 'Raw code of the failed flow action. Empty when it succeeded.'),
    datetime('owatch_probedat', 'Probed at', 'UTC time the row was written.'),
    str('owatch_round', 'Round', 40, 'Start time of the flow run: all rows of one run share it.'),
    str('owatch_errormessage', 'Error message', 1000, 'Error text of the failed HTTP action (or the start of the error response), cut to this length by the flow. Empty when it succeeded.'),
    bool('owatch_failed', 'Failed', false, 'Raw failure flag used by the alert flow: no HTTP answer, HTTP 5xx, 429, or a status outside the alive codes.'),
  ]),
  table('owatch_setting', 'Outage Watch Setting', 'Outage Watch Settings', 'Name/value settings read by the dashboard.', 'Name', 100, [
    str('owatch_value', 'Value', 400, 'Setting value (never a secret).'),
  ]),
]

const codes = (alive) => (alive == null ? '' : alive.join(','))

/**
 * Seed rows for the targets table: 36 services. The 34 fixed ones are enabled. The two tenant-specific ones
 * (sharepoint-online, onedrive-business) get a URL and are enabled only when a tenant name is given; otherwise they
 * are seeded DISABLED with an empty URL = "needs tenant name": the flow never probes them and the dashboard shows
 * the neutral "unconfigured" state, never a failure.
 */
export function seedTargets(tenant) {
  const row = (t, url, enabled) => ({ owatch_name: t.name, owatch_url: url, owatch_alivecodes: codes(t.alive), owatch_dependsonauth: t.dependsOnAuth, owatch_copilotneeds: t.copilotNeeds, owatch_enabled: enabled, owatch_family: t.family })
  const rows = catalog.targets.map((t) => row(t, t.url, true))
  for (const t of catalog.tenantTargets) rows.push(tenant ? row(t, t.urlTemplate.replace('{tenant}', tenant), true) : row(t, '', false))
  return rows
}
export const TENANT_TARGET_NAMES = catalog.tenantTargets.map((t) => t.name)

/** Settings: `force` ones always follow the deployment; the others are created once and then left to the admin. */
export function seedSettings(o) {
  const d = catalog.defaults
  return [
    { name: 'interval_minutes', value: String(o.intervalMinutes), force: true },
    { name: 'retention_days', value: String(o.retentionDays), force: true },
    { name: 'probe_timeout_seconds', value: String(o.timeoutSeconds), force: true },
    { name: 'schema_version', value: SCHEMA_VERSION, force: true },
    { name: 'heartbeat_configured', value: o.heartbeat ? 'yes' : 'no', force: true },
    { name: 'confirm', value: String(d.confirm) }, { name: 'factor', value: String(d.factor) }, { name: 'floor_ms', value: String(d.floorMs) },
    { name: 'slow_ms', value: String(d.slowMs) }, { name: 'recover_after', value: String(d.recoverAfter) },
    // --- Teams alerts. Admin-editable (created once, then yours): ---
    { name: 'alert_enabled', value: 'yes' },                 // 'no' = never post (state is still tracked)
    { name: 'alert_confirm', value: String(d.confirm) },     // failed rounds in a row before an incident is posted
    { name: 'alert_reminder_minutes', value: '60' },         // repeat while still failing
    { name: 'alert_snooze_until', value: '' },               // UTC time like 2026-12-31T18:00:00Z: no posts before it; probing continues
    { name: 'alert_test', value: 'no' },                     // 'yes' = post a TEST message on the next run, then reset to 'no'
    // --- written by the alert flow (do not edit): ---
    { name: 'alert_last_round', value: '' }, { name: 'last_alert_at', value: '' }, { name: 'last_alert_error', value: '' },
  ]
}

/**
 * Settings this tool no longer stores. `roles_json` (the "Can I do my job?" list) used to be seeded; with 11 roles its
 * JSON is 618 characters and no longer fits the 400-character owatch_value column (first seen on a real tenant:
 * 0x80044331). The dashboard has the same list built in (shared/catalog.json), so it is simply not stored any more.
 * A row that still holds a default this tool shipped earlier is removed (so the built-in, current list applies);
 * a row an admin edited is kept and still honoured.
 */
export const RETIRED_SETTINGS = [
  { name: 'roles_json', deleteIf: [...catalog.previousRoles, catalog.roles].map((r) => JSON.stringify(r)) },
]

// ---------------------------------------------------------------------------------------------
// Column constraints, derived from the SAME metadata payloads that create the columns.
// Every row the provisioner writes is checked against them BEFORE it is sent (assertRowFits), the mock Dataverse
// enforces them like the real service does, and tests check everything the flow can write.
// ---------------------------------------------------------------------------------------------
export function columnSpec(tableLogical) {
  const t = TABLES.find((x) => x.logical === tableLogical)
  if (!t) throw new Error('unknown table ' + tableLogical)
  const spec = {}
  for (const a of [...t.create.Attributes, ...t.columns]) {
    spec[a.SchemaName.toLowerCase()] = {
      type: a.AttributeType, maxLength: a.MaxLength ?? null, min: a.MinValue ?? null, max: a.MaxValue ?? null,
      required: a.RequiredLevel?.Value === 'ApplicationRequired' || a.RequiredLevel?.Value === 'SystemRequired',
    }
  }
  return spec
}

/** Returns a list of violations (empty = the row fits). `partial` = PATCH: required columns may be absent. */
export function rowViolations(tableLogical, row, { partial = false } = {}) {
  const spec = columnSpec(tableLogical)
  const bad = []
  for (const [k, v] of Object.entries(row)) {
    const c = spec[k]
    if (!c) { bad.push(`${tableLogical}.${k}: no such column`); continue }
    if (v === null || v === undefined || v === '') { if (c.required) bad.push(`${tableLogical}.${k}: required`); continue }
    if (c.type === 'String' && (typeof v !== 'string' || v.length > c.maxLength)) bad.push(`${tableLogical}.${k}: ${typeof v === 'string' ? v.length + ' characters, maximum ' + c.maxLength : 'not text'}`)
    if (c.type === 'Integer' && (!Number.isInteger(v) || v < c.min || v > c.max)) bad.push(`${tableLogical}.${k}: ${v} is outside ${c.min}..${c.max}`)
    if (c.type === 'Boolean' && typeof v !== 'boolean') bad.push(`${tableLogical}.${k}: not a boolean`)
    if (c.type === 'DateTime' && (typeof v !== 'string' || !Number.isFinite(Date.parse(v)))) bad.push(`${tableLogical}.${k}: not a date/time`)
  }
  if (!partial) for (const [k, c] of Object.entries(spec)) if (c.required && (row[k] === undefined || row[k] === null || row[k] === '')) bad.push(`${tableLogical}.${k}: required`)
  return [...new Set(bad)]
}

export class RowTooBig extends Error {}
/** Throws BEFORE anything is sent, naming the column: a clear local error instead of a half-finished step. */
export function assertRowFits(tableLogical, row, opts) {
  const bad = rowViolations(tableLogical, row, opts)
  if (bad.length) throw new RowTooBig('internal check failed, nothing was sent for this row: ' + bad.join('; '))
  return row
}
