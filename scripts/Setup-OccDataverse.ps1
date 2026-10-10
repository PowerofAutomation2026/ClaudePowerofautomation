<#
.SYNOPSIS
  One-time setup: creates the Dataverse table `occ_finding` ("OCC Finding") that "Publish to Copilot agent" writes to and a Copilot Studio agent reads.
  NO Azure app registration: you sign in interactively as yourself (Azure PowerShell's own sign-in) and the Dataverse Web API is called with your identity.
.PARAMETER OrgUrl  Environment URL of the environment the app is deployed to, e.g. https://org1234abcd.crm.dynamics.com
                   (Power Platform admin center > Environments > your environment > Environment URL). Prompted if omitted.
.NOTES
  Needs System Administrator / System Customizer in that environment. NOT TESTED against a live tenant - if anything fails, create the table by hand
  (make.powerapps.com > Tables > New table) using the columns in agent/README.md; the app only needs the logical names.
#>
param([string]$OrgUrl)
$ErrorActionPreference = 'Stop'
if (-not $OrgUrl) { $OrgUrl = Read-Host 'Enter the Dataverse Environment URL (https://orgXXXX.crm.dynamics.com)' }
$OrgUrl = $OrgUrl.Trim().TrimEnd('/')
if ($OrgUrl -notmatch '^https://[a-z0-9.-]+\.dynamics\.com$') { throw "'$OrgUrl' does not look like a Dataverse environment URL." }

if (-not (Get-Module -ListAvailable Az.Accounts)) { Write-Host 'Installing Az.Accounts (current user)...'; Install-Module Az.Accounts -Scope CurrentUser -Force -AllowClobber }
Import-Module Az.Accounts
Connect-AzAccount | Out-Null
$tok = (Get-AzAccessToken -ResourceUrl $OrgUrl).Token
if ($tok -is [System.Security.SecureString]) { $tok = [System.Net.NetworkCredential]::new('', $tok).Password }
$h = @{ Authorization = "Bearer $tok"; 'Content-Type' = 'application/json; charset=utf-8'; 'OData-MaxVersion' = '4.0'; 'OData-Version' = '4.0' }
$api = "$OrgUrl/api/data/v9.2"

function Label($t) { @{ '@odata.type' = 'Microsoft.Dynamics.CRM.Label'; LocalizedLabels = @(@{ '@odata.type' = 'Microsoft.Dynamics.CRM.LocalizedLabel'; Label = $t; LanguageCode = 1033 }) } }
function StrCol($name, $disp, $len = 200, [bool]$primary = $false) {
  @{ '@odata.type' = 'Microsoft.Dynamics.CRM.StringAttributeMetadata'; AttributeType = 'String'; AttributeTypeName = @{ Value = 'StringType' }; SchemaName = $name; IsPrimaryName = $primary
     RequiredLevel = @{ Value = 'None' }; MaxLength = $len; FormatName = @{ Value = 'Text' }; DisplayName = (Label $disp) }
}
function MemoCol($name, $disp) {
  @{ '@odata.type' = 'Microsoft.Dynamics.CRM.MemoAttributeMetadata'; AttributeType = 'Memo'; AttributeTypeName = @{ Value = 'MemoType' }; SchemaName = $name
     RequiredLevel = @{ Value = 'None' }; MaxLength = 10000; Format = 'TextArea'; DisplayName = (Label $disp) }
}
function DateCol($name, $disp) {
  @{ '@odata.type' = 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata'; AttributeType = 'DateTime'; AttributeTypeName = @{ Value = 'DateTimeType' }; SchemaName = $name
     RequiredLevel = @{ Value = 'None' }; Format = 'DateAndTime'; DateTimeBehavior = @{ Value = 'UserLocal' }; DisplayName = (Label $disp) }
}
function Post($path, $body) { Invoke-RestMethod -Method Post -Uri "$api/$path" -Headers $h -Body ($body | ConvertTo-Json -Depth 12) }

$exists = $false
try { Invoke-RestMethod -Uri "$api/EntityDefinitions(LogicalName='occ_finding')?`$select=LogicalName" -Headers $h | Out-Null; $exists = $true } catch { }
if ($exists) { Write-Host "Table occ_finding already exists - checking columns." -ForegroundColor Yellow }
else {
  Write-Host 'Creating table occ_finding (user-owned)...'
  Post 'EntityDefinitions' @{
    '@odata.type' = 'Microsoft.Dynamics.CRM.EntityMetadata'; SchemaName = 'occ_finding'
    DisplayName = (Label 'OCC Finding'); DisplayCollectionName = (Label 'OCC Findings'); Description = (Label 'Security findings published by the Ownership Command Center suite for Copilot Studio agents')
    OwnershipType = 'UserOwned'; HasActivities = $false; HasNotes = $false; IsActivity = $false; PrimaryNameAttribute = 'occ_name'
    Attributes = @((StrCol 'occ_name' 'Title' 200 $true))
  } | Out-Null
}
$cols = @(
  (StrCol 'occ_fingerprint' 'Fingerprint'), (StrCol 'occ_module' 'Module' 50), (StrCol 'occ_rule' 'Rule' 80), (StrCol 'occ_severity' 'Severity' 20), (StrCol 'occ_kind' 'Kind' 100),
  (StrCol 'occ_resourcename' 'Resource'), (StrCol 'occ_envname' 'Environment'), (StrCol 'occ_envid' 'Environment Id' 100), (StrCol 'occ_principal' 'Principal'), (StrCol 'occ_host' 'Host'),
  (StrCol 'occ_snapshot' 'Snapshot' 100), (StrCol 'occ_status' 'Status' 20),
  (MemoCol 'occ_detail' 'Detail'), (MemoCol 'occ_fixpayload' 'Fix payload'), (DateCol 'occ_firstseen' 'First seen'), (DateCol 'occ_lastseen' 'Last seen'))
foreach ($c in $cols) {
  $ln = $c.SchemaName.ToLower()
  $have = $false
  try { Invoke-RestMethod -Uri "$api/EntityDefinitions(LogicalName='occ_finding')/Attributes(LogicalName='$ln')?`$select=LogicalName" -Headers $h | Out-Null; $have = $true } catch { }
  if ($have) { continue }
  Write-Host "  + $ln"
  Post "EntityDefinitions(LogicalName='occ_finding')/Attributes" $c | Out-Null
}
Write-Host 'Publishing customizations...'
Post 'PublishAllXml' @{} | Out-Null
Write-Host "Done. Next: re-run Deploy.cmd (it adds the table to the app), then follow agent/README.md." -ForegroundColor Green
