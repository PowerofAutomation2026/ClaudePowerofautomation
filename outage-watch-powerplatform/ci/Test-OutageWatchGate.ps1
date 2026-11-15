<#
.SYNOPSIS
  Outage Watch CI gate in plain PowerShell (5.1 and 7): exit 0 = go, exit 1 = stop.
.DESCRIPTION
  Reads the ci_status row through the Dataverse Web API. The token comes from $env:OUTAGEWATCH_TOKEN (for example
  from "az account get-access-token --resource <org url> --query accessToken -o tsv"); it is never printed.
  Same decision rules as ci/gate.mjs. This script was NOT executed where it was written (no PowerShell there).
.EXAMPLE
  $env:OUTAGEWATCH_TOKEN = az account get-access-token --resource https://contoso.crm4.dynamics.com --query accessToken -o tsv
  ./ci/Test-OutageWatchGate.ps1 -OrgUrl https://contoso.crm4.dynamics.com
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OrgUrl,
  [ValidateSet('freeze', 'caution')][string]$BlockOn = 'freeze',
  [int]$StaleMinutes = 35,
  [ValidateSet('fail', 'pass')][string]$OnStale = 'fail'
)
$ErrorActionPreference = 'Stop'
$OrgUrl = $OrgUrl.TrimEnd('/').ToLowerInvariant()
if ($OrgUrl -cnotmatch '\Ahttps://[a-z0-9][a-z0-9-]{0,62}\.(?:crm(?:[0-9]{1,2})?\.dynamics\.com|crm(?:[0-9]{1,2})?\.microsoftdynamics\.us|crm\.appsplatform\.us|crm\.dynamics\.cn)\z') { Write-Host 'OrgUrl must be https://<org>.crm<N>.dynamics.com'; exit 2 }
if (-not $env:OUTAGEWATCH_TOKEN) { Write-Host 'OUTAGEWATCH_TOKEN is empty'; exit 2 }
$staleExit = 1
if ($OnStale -eq 'pass') { $staleExit = 0 }
try {
  $headers = @{ Authorization = 'Bearer ' + $env:OUTAGEWATCH_TOKEN; Accept = 'application/json'; 'OData-MaxVersion' = '4.0'; 'OData-Version' = '4.0' }
  $uri = $OrgUrl + "/api/data/v9.2/owatch_settings?`$select=owatch_value&`$filter=owatch_name eq 'ci_status'&`$top=1"
  $r = Invoke-RestMethod -Uri $uri -Headers $headers -Method Get
  $s = $r.value[0].owatch_value | ConvertFrom-Json
  $age = [int]((Get-Date).ToUniversalTime() - ([datetime]::Parse($s.updated, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal))).TotalMinutes
} catch {
  Write-Host "Outage Watch gate: could not read the status ($($_.Exception.GetType().Name)) [STALE]"
  exit $staleExit
}
if ($age -gt $StaleMinutes) { Write-Host "Outage Watch gate: status is $age min old (limit $StaleMinutes): the monitor is not updating [STALE]"; exit $staleExit }
$stop = ($s.level -eq 'freeze') -or ($BlockOn -eq 'caution' -and $s.level -eq 'caution')
if ($stop) { Write-Host "Outage Watch gate: STOP - level $($s.level) since $($s.since) ($($s.failing) failing: $($s.services))"; exit 1 }
Write-Host "Outage Watch gate: GO - level $($s.level) since $($s.since)"
exit 0
