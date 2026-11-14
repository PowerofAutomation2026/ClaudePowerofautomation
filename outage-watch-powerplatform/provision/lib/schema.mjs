// Dataverse schema for Outage Watch (Power Platform edition).
// Payload shapes follow the documented Web API metadata examples (see DESIGN.md for the doc links).
import { readFileSync } from 'node:fs'

export const catalog = JSON.parse(readFileSync(new URL('../../shared/catalog.json', import.meta.url), 'utf8'))

export const PUBLISHER = { uniquename: 'outagewatch', friendlyname: 'Outage Watch', customizationprefix: 'owatch', customizationoptionvalueprefix: 72700, description: 'Publisher for the Outage Watch monitor tables and flow.' }
export const SOLUTION = { uniquename: 'OutageWatch', friendlyname: 'Outage Watch', version: '1.0.0.0', description: 'Outage Watch: probe flow, tables and connection reference. Created by Deploy-OutageWatchPP.' }
export const CONNREF = { logicalName: 'owatch_dataverse', displayName: 'Outage Watch - Dataverse', connectorId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps', api: 'shared_commondataserviceforapps' }
export const FLOW_NAME = 'Outage Watch - probe'
export const SCHEMA_VERSION = '2'
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
  ]),
  table('owatch_result', 'Outage Watch Result', 'Outage Watch Results', 'One RAW probe fact per target per flow run. No judgement is stored.', 'Target name', 100, [
    int('owatch_httpstatus', 'HTTP status', 0, 999, 'HTTP status of the answer. Empty = no HTTP answer.'),
    int('owatch_elapsedms', 'Elapsed ms', 0, 2147483647, 'Duration of the probe action in milliseconds.'),
    str('owatch_errorkind', 'Error kind', 100, 'Raw code of the failed flow action. Empty when it succeeded.'),
    datetime('owatch_probedat', 'Probed at', 'UTC time the row was written.'),
    str('owatch_round', 'Round', 40, 'Start time of the flow run: all rows of one run share it.'),
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
    // created once and then the admin's; upgraded only while it still equals a default this tool shipped earlier
    { name: 'roles_json', value: JSON.stringify(catalog.roles), replaceIf: catalog.previousRoles.map((r) => JSON.stringify(r)) },
  ]
}
