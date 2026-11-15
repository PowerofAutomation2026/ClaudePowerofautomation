<#
.SYNOPSIS
  Zero-touch deploy of "Outage Watch" (Power Platform edition) to ONE Power Platform environment.
  You type the environment ID; the script does the rest.

.DESCRIPTION
  One run, in order, safe to re-run (a re-run continues / upgrades, it never duplicates):
    1. prerequisites (Node.js, Power Platform CLI)        6. probe flow + connection reference, turned ON
    2. sign-in, environment access, code-apps check        7. dashboard (code app): build + pac code push
    3. unit tests (skip with -SkipTests)                   8. smoke test (waits for the first result rows)
    4. Dataverse tables (solution "OutageWatch")           9. summary
    5. default targets (36 Microsoft 365 / Copilot services; 34 probed without -TenantName)

  What can NOT be automated (the script opens the right page and waits; see README "Honest limits"):
    - interactive sign-in (Power Platform CLI, and once more for the Dataverse token if no Az session exists)
    - creating the Microsoft Dataverse connection the flow runs with, if you do not have one yet (one click)
    - licences: the flow owner needs Power Automate Premium (HTTP is a premium connector); dashboard users
      need Power Apps Premium; "code apps" must be enabled on the environment by an admin.

  SAME-FATE WARNING: the probe flow runs INSIDE Microsoft's cloud. If Power Platform or sign-in fails, this
  monitor fails with it. Keep the independent host-based Python monitor (outage-watch-package) as the witness.

  Secrets: the Dataverse token and the optional heartbeat URL are passed to the helper through process
  environment variables only, are never printed and never written to disk by this script.

.PARAMETER EnvironmentId     Target environment GUID (the part after /environments/ in the maker portal URL). Prompted if omitted.
.PARAMETER Yes               Do not ask for confirmations (unattended where the platform allows it).
.PARAMETER DryRun            Show the plan (every Dataverse request of a first deployment) and exit. Changes nothing, needs no sign-in.
.PARAMETER Uninstall         Remove the probe flow (data is kept). Add -Purge to delete tables, data, connection reference, solution, publisher.
.PARAMETER Purge             With -Uninstall: also delete the tables and ALL collected results.
.PARAMETER SkipTests         Do not run the unit tests before deploying.
.PARAMETER IntervalMinutes   Probe interval, 1-60 (default 10). With 36 services, 5 minutes uses about 78% of a Premium licence's
                             40,000 requests/day; 10 minutes about 39%. Shorter = faster detection, more quota.
.PARAMETER RetentionDays     Result rows older than this are pruned by the flow, 1-90 (default 7).
.PARAMETER TenantName        Optional override: the SharePoint tenant name (the contoso in contoso.sharepoint.com). Normally NOT needed:
                             the script detects it (Get-AzTenant, then Microsoft Graph), checks that https://<name>.sharepoint.com
                             answers, and then probes sharepoint-online, onedrive-business (<name>-my) and sharepoint-admin (<name>-admin).
                             If nothing can be verified those three stay 'unconfigured' (neutral, never a failure).
.PARAMETER NoSharePointAutoDetect  Do not try to detect the SharePoint tenant name.
.PARAMETER SetHeartbeat      Prompt (hidden input) for a dead-man's-switch URL the flow pings after every complete round.
                             Alternative for unattended runs: set the environment variable OUTAGEWATCH_HEARTBEAT_URL.
.PARAMETER ClearHeartbeat    Remove a previously configured heartbeat.
.PARAMETER TeamsChannelLink  Alerts to a Teams channel: the link from Teams (channel name > ... > Get link to channel). Not a secret.
                             Interactive runs ask for it (Enter skips). Needs a Microsoft Teams connection (the script opens the page).
.PARAMETER SetSlackWebhook   Alerts to Slack: prompts (hidden input) for a Slack incoming-webhook URL. The URL is a credential and is
                             never taken from the command line. Unattended: environment variable OUTAGEWATCH_SLACK_WEBHOOK.
.PARAMETER SetWebexWebhook   Alerts to Webex: prompts (hidden) for a Webex incoming-webhook URL. Unattended: OUTAGEWATCH_WEBEX_WEBHOOK.
.PARAMETER SetAlertWebhook   Alerts to any endpoint that accepts POST {"text": "..."}: hidden prompt. Unattended: OUTAGEWATCH_ALERT_WEBHOOK.
.PARAMETER RemoveChannels    Comma list of channels to remove: teams,slack,webex,webhook. Channels are otherwise kept between runs.
.PARAMETER NoAlerts          Turn the alert flow off (probing, dashboard and the configuration stay).
.PARAMETER SendTestAlert     After deploying, send a live, clearly labelled TEST message with the current status to every configured channel (same mechanism as the dashboard button) and wait for each channel's result.
.PARAMETER EnvironmentUrl    Optional: Dataverse URL (https://org.crm4.dynamics.com). Normally discovered from the environment ID.
.PARAMETER DisplayName       Dashboard app name (default "Outage Watch").
.PARAMETER SkipDashboard     Deploy tables + flow only.
.PARAMETER SkipPrereqInstall Do not try to install Node.js / Power Platform CLI / Az.Accounts automatically.
.PARAMETER SmokeWaitSeconds  How long to wait for the first result rows (default 240).

.EXAMPLE
  .\Deploy-OutageWatchPP.cmd 00000000-0000-0000-0000-000000000000
.EXAMPLE
  .\Deploy-OutageWatchPP.ps1 -EnvironmentId 00000000-0000-0000-0000-000000000000 -Yes
.EXAMPLE
  .\Deploy-OutageWatchPP.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$EnvironmentId,
  [switch]$Yes,
  [switch]$DryRun,
  [switch]$Uninstall,
  [switch]$Purge,
  [switch]$SkipTests,
  [int]$IntervalMinutes = 10,
  [int]$RetentionDays = 7,
  [string]$TenantName,
  [switch]$NoSharePointAutoDetect,
  [switch]$SetHeartbeat,
  [switch]$ClearHeartbeat,
  [string]$TeamsChannelLink,
  [switch]$SetSlackWebhook,
  [switch]$SetWebexWebhook,
  [switch]$SetAlertWebhook,
  [string]$RemoveChannels,
  [switch]$NoAlerts,
  [switch]$SendTestAlert,
  [string]$EnvironmentUrl,
  [string]$DisplayName = 'Outage Watch',
  [switch]$SkipDashboard,
  [switch]$SkipPrereqInstall,
  [int]$SmokeWaitSeconds = 240
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if (-not $root) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location $root

# ---------- validation patterns (anchored with \A and \z: no trailing newline, no partial match) ----------
$GuidPattern = '\A[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\z'
$OrgUrlPattern = '\Ahttps://[a-z0-9][a-z0-9-]{0,62}\.(?:crm(?:[0-9]{1,2})?\.dynamics\.com|crm(?:[0-9]{1,2})?\.microsoftdynamics\.us|crm\.appsplatform\.us|crm\.dynamics\.cn)/?\z'
$TenantPattern = '\A[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\z'
$ConnIdPattern = '\A[A-Za-z0-9][A-Za-z0-9_-]{7,127}\z'
$DisplayNamePattern = '\A[A-Za-z0-9][A-Za-z0-9 ._-]{0,48}\z'
$OnMicrosoftPattern = '\A[A-Za-z0-9][A-Za-z0-9-]{0,62}\.onmicrosoft\.com\z'
$TeamsLinkPattern = '\Ahttps://teams\.(?:microsoft\.com|cloud\.microsoft)/l/channel/[A-Za-z0-9%._~:@!$&()*+,;=/?-]{10,1100}\z'
$ChannelListPattern = '\A(?:teams|slack|webex|webhook)(?:,(?:teams|slack|webex|webhook)){0,3}\z'
$DashboardUrlPattern = '\Ahttps://apps\.powerapps\.com/play/[A-Za-z0-9/?=&._%-]{10,300}\z'

$script:Stage = 'starting'
$script:Changed = $false
$helper = Join-Path (Join-Path $root 'provision') 'owpp.mjs'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)   # pac (Node) cannot parse a BOM

function Step($m) { $script:Stage = $m; Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }
function Info($m) { Write-Host "    $m" -ForegroundColor Gray }
function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }

function Assert-Guid {
  param([string]$Value, [string]$What = 'Environment ID')
  if ($null -eq $Value -or $Value -cnotmatch $GuidPattern) {
    throw "$What is not a valid GUID. Expected the form 00000000-0000-0000-0000-000000000000 (the part after /environments/ in the maker portal URL)."
  }
}

# Runs a native command, captures stdout+stderr as text. Windows PowerShell 5.1 turns stderr lines into errors
# when redirected, so the error preference is relaxed just for the call (same pattern as the existing deploy script).
function Invoke-Native {
  param([string]$Exe, [string[]]$Arguments)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $text = (& $Exe @Arguments 2>&1 | ForEach-Object { $_.ToString() }) -join "`n"
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  return [pscustomobject]@{ Text = $text; Code = $code }
}

function Run {
  param([string]$Exe, [string[]]$Arguments)
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "'$Exe $($Arguments -join ' ')' failed (exit $LASTEXITCODE)" }
}

# Runs the Node helper with live output. Returns its exit code (0 ok, 2 bad input, 3 needs connection, 4 flow not on, 5 smoke timeout).
function Invoke-Helper {
  param([string[]]$Arguments)
  $all = @($helper) + $Arguments
  & node @all | Out-Host
  return $LASTEXITCODE
}

function Confirm-Step {
  param([string]$Question)
  if ($Yes) { return $true }
  $a = Read-Host "$Question [Y/n]"
  return ($a -eq '' -or $a -match '\A[yY]')
}

function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $null }
  try { return ([System.IO.File]::ReadAllText($Path).TrimStart([char]0xFEFF) | ConvertFrom-Json) } catch { return $null }
}

function ConvertTo-PlainText {
  param($Secure)
  if ($Secure -is [string]) { return $Secure }
  return (New-Object System.Net.NetworkCredential('', $Secure)).Password
}

function Clear-Secrets {
  Remove-Item Env:\OWPP_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:\OWPP_HEARTBEAT_URL -ErrorAction SilentlyContinue
  Remove-Item Env:\OWPP_GRAPH_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:\OWPP_SLACK_WEBHOOK -ErrorAction SilentlyContinue
  Remove-Item Env:\OWPP_WEBEX_WEBHOOK -ErrorAction SilentlyContinue
  Remove-Item Env:\OWPP_ALERT_WEBHOOK -ErrorAction SilentlyContinue
}

function Show-Checklist {
  Write-Host ''
  Write-Host 'Outage Watch - Power Platform edition' -ForegroundColor White
  Write-Host 'This script deploys everything from the environment ID alone. A few things cannot be automated;' -ForegroundColor Gray
  Write-Host 'when one is needed the script opens the exact page and waits, so you never have to re-run:' -ForegroundColor Gray
  Write-Host '  [you] 1. Sign in when a browser window opens (Power Platform CLI; possibly once more for Dataverse).' -ForegroundColor Gray
  Write-Host '  [you] 2. If you have no Microsoft Dataverse connection in this environment yet: click "Create" once.' -ForegroundColor Gray
  Write-Host '  [you] 3. Optional alerts: paste a Teams channel link when asked (and click "Create" once for the Teams connection).' -ForegroundColor Gray
  Write-Host '  [admin, beforehand] Licences: Power Automate Premium for the flow owner (HTTP is a premium connector),' -ForegroundColor Gray
  Write-Host '        Power Apps Premium for dashboard users, and "Enable code apps" turned on for the environment.' -ForegroundColor Gray
  Write-Host 'SAME-FATE WARNING: this monitor runs inside Microsoft''s cloud and fails together with it.' -ForegroundColor Yellow
  Write-Host 'Keep the independent Python monitor (outage-watch-package) on a host outside Microsoft 365 as the witness.' -ForegroundColor Yellow
}

# ---------- prerequisites ----------
# NOTE: functions that run installers / builds are called as plain statements (never captured into a variable),
# so the output of winget, npm and pac stays visible. They report results through $script: variables.
function Ensure-Prerequisites {
  param([bool]$ReportOnly)
  Step 'Checking prerequisites'
  if (-not (Have 'node')) {
    if ($ReportOnly) { Warn 'Node.js: MISSING (a real run installs Node.js LTS with winget)'; return }
    if ($SkipPrereqInstall) { throw 'Node.js is required (https://nodejs.org).' }
    if (Have 'winget') {
      Warn 'Installing Node.js LTS via winget...'
      winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
      $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    } else { throw 'Node.js not found and winget unavailable. Install Node.js LTS and re-run.' }
    if (-not (Have 'node')) { throw 'Node.js was installed but is not on PATH yet. Open a NEW PowerShell window and re-run the same command.' }
  }
  $nodeVersion = (& node --version)
  $major = 0
  if ($nodeVersion -match '\Av([0-9]+)\.') { $major = [int]$Matches[1] }
  if ($major -lt 20) { throw "Node.js 20 or newer is required (found $nodeVersion). Install Node.js LTS and re-run." }
  Ok "node $nodeVersion"

  if (-not (Have 'pac')) {
    if ($ReportOnly) { Warn 'Power Platform CLI (pac): MISSING (a real run installs it with dotnet tool or winget)'; return }
    if ($SkipPrereqInstall) { throw 'Power Platform CLI (pac) is required.' }
    if (Have 'dotnet') {
      Warn 'Installing Power Platform CLI via dotnet tool...'
      dotnet tool install --global Microsoft.PowerApps.CLI.Tool
      $env:Path += ";$HOME\.dotnet\tools"
    } elseif (Have 'winget') {
      Warn 'Installing Power Platform CLI via winget...'
      winget install -e --id Microsoft.PowerAppsCLI --accept-source-agreements --accept-package-agreements
      $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    } else { throw 'pac not found. Install: https://aka.ms/PowerAppsCLI' }
  }
  if (-not (Have 'pac')) { throw 'pac was installed but is not on PATH yet. Open a NEW PowerShell window and re-run the same command.' }
  Ok 'Power Platform CLI present'
}

# ---------- sign-in + environment ----------
function Connect-Environment {
  Step 'Signing in and selecting the environment'
  $who = Invoke-Native 'pac' @('auth', 'who')
  if ($who.Text -notmatch 'Tenant|User') {
    Warn 'A browser window opens: sign in with an account that is System Administrator / System Customizer in the target environment.'
    Run 'pac' @('auth', 'create', '--environment', $EnvironmentId)
  } else { Ok 'Existing pac profile found' }
  $sel = Invoke-Native 'pac' @('env', 'select', '--environment', $EnvironmentId)
  if ($sel.Code -ne 0) {
    Write-Host $sel.Text
    Warn 'The current pac profile cannot select this environment. Signing in again for this environment...'
    Run 'pac' @('auth', 'create', '--environment', $EnvironmentId)
    Run 'pac' @('env', 'select', '--environment', $EnvironmentId)
  }
  Ok "Environment selected: $EnvironmentId"
}

function Get-TenantId {
  $who = Invoke-Native 'pac' @('auth', 'who')
  if ($who.Text -match '(?im)^\s*Tenant\s*Id\s*:?\s*([0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12})\s*$') { return $Matches[1] }
  return $null
}

function Resolve-OrgUrl {
  if ($EnvironmentUrl) {
    $u = $EnvironmentUrl.Trim().ToLowerInvariant()
    if ($u -cnotmatch $OrgUrlPattern) { throw '-EnvironmentUrl is not a Dataverse URL (expected https://<org>.crm<N>.dynamics.com).' }
    return $u.TrimEnd('/')
  }
  foreach ($cmd in @(@('env', 'who'), @('org', 'who'))) {
    $r = Invoke-Native 'pac' $cmd
    foreach ($m in [regex]::Matches($r.Text, '(?i)https://[a-z0-9][a-z0-9-]*\.crm[a-z0-9.]*\.(?:com|us|cn)/?')) {
      $u = $m.Value.ToLowerInvariant()
      if ($u -cmatch $OrgUrlPattern) { return $u.TrimEnd('/') }
    }
  }
  throw 'Could not read the Dataverse URL of this environment from pac. Does the environment have a Dataverse database? Re-run with -EnvironmentUrl https://<org>.crm<N>.dynamics.com'
}

# Code apps must be enabled by an admin (admin center > Environments > [env] > Settings > Product > Features).
# There is no documented API to read that switch, so this is a best-effort early check; `pac code push` is the real test.
function Test-CodeApps {
  Step 'Checking that code apps are available in this environment'
  while ($true) {
    $r = Invoke-Native 'pac' @('code', 'list')
    if ($r.Text -match '(?i)not\s+enabled|isn.t\s+enabled|is\s+disabled|not\s+allowed|CodeAppsDisabled') {
      Warn 'Code apps appear to be DISABLED for this environment:'
      Write-Host $r.Text
      Warn 'An environment admin must enable them: Power Platform admin center > Manage > Environments > (this environment)'
      Warn '  > Settings > Product > Features > "Power Apps code apps" > turn on "Enable code apps" > Save.'
      if ($Yes) { throw 'Code apps are disabled for this environment. Enable them (see above) and re-run the same command; nothing has been changed yet.' }
      Start-Process "https://admin.powerplatform.microsoft.com/manage/environments/environment/$EnvironmentId/hub"
      $a = Read-Host 'Press Enter when it is enabled to check again (or type S to deploy tables + flow only, without the dashboard)'
      if ($a -match '\A[sS]') { return $false }
      continue
    }
    if ($r.Code -ne 0) { Warn 'pac code list returned an error (older pac, or no code apps yet). Continuing: the publish step is the definitive check.' }
    else { Ok 'No objection from pac code list (the publish step is the definitive check)' }
    return $true
  }
}

# ---------- Dataverse access token (documented route: Az.Accounts Get-AzAccessToken -ResourceUrl <org>) ----------
function Get-DataverseToken {
  param([string]$OrgUrl)
  if ($env:OUTAGEWATCH_DATAVERSE_TOKEN) { Info 'Using the token from OUTAGEWATCH_DATAVERSE_TOKEN'; return $env:OUTAGEWATCH_DATAVERSE_TOKEN }

  $tenantId = Get-TenantId
  if (-not (Get-Module -ListAvailable -Name Az.Accounts) -and -not $SkipPrereqInstall) {
    if (Confirm-Step 'The Az.Accounts PowerShell module is needed to get a Dataverse token. Install it for the current user?') {
      Warn 'Installing Az.Accounts (current user)...'
      try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        if (-not (Get-PackageProvider -Name NuGet -ListAvailable -ErrorAction SilentlyContinue)) { Install-PackageProvider -Name NuGet -Scope CurrentUser -Force | Out-Null }
        Install-Module Az.Accounts -Scope CurrentUser -Force -AllowClobber
      } catch { Warn "Could not install Az.Accounts: $($_.Exception.Message)" }
    }
  }
  if (Get-Module -ListAvailable -Name Az.Accounts) {
    Import-Module Az.Accounts -ErrorAction Stop
    $ctx = Get-AzContext -ErrorAction SilentlyContinue
    if (-not $ctx -or ($tenantId -and $ctx.Tenant.Id -ne $tenantId)) {
      Warn 'A browser window opens: sign in once more (same account) so the script can call the Dataverse Web API.'
      if ($tenantId) { Connect-AzAccount -Tenant $tenantId -ErrorAction Stop | Out-Null } else { Connect-AzAccount -ErrorAction Stop | Out-Null }
    }
    $tok = $null
    try { $tok = (Get-AzAccessToken -ResourceUrl $OrgUrl -AsSecureString -ErrorAction Stop).Token }
    catch { $tok = (Get-AzAccessToken -ResourceUrl $OrgUrl -ErrorAction Stop).Token }   # older Az.Accounts: no -AsSecureString
    $plain = ConvertTo-PlainText $tok
    if ($plain) {
      Ok 'Dataverse token acquired (not shown)'
      return $plain
    }
  }
  if (Have 'az') {
    Info 'Trying Azure CLI for the Dataverse token...'
    $r = Invoke-Native 'az' @('account', 'get-access-token', '--resource', $OrgUrl, '--query', 'accessToken', '-o', 'tsv')
    if ($r.Code -eq 0 -and $r.Text -match '\A[A-Za-z0-9._-]{100,}\s*\z') { Ok 'Dataverse token acquired via Azure CLI (not shown)'; return $r.Text.Trim() }
    Warn 'Azure CLI could not provide a token (run "az login" first).'
  }
  throw 'No Dataverse access token. Install the Az.Accounts module (Install-Module Az.Accounts -Scope CurrentUser) or sign in with Azure CLI (az login), then re-run the same command. Nothing has been changed yet.'
}

# ---------- connections (same parsing as the existing Ownership Command Center deploy script) ----------
function Get-Connections {
  $r = Invoke-Native 'pac' @('connection', 'list')
  foreach ($line in ($r.Text -split "`n")) {
    if ($line -match '(?i)\b([0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\b.*?(shared_[a-z0-9_\-]+)') {
      [pscustomobject]@{ Id = $Matches[1]; Api = $Matches[2].ToLower() }
    } elseif ($line -match '(?i)(shared_[a-z0-9_\-]+).*?\b([0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\b') {
      [pscustomobject]@{ Id = $Matches[2]; Api = $Matches[1].ToLower() }
    }
  }
}

function Find-ConnectionFor {
  param([string]$Api)
  $hit = @(Get-Connections) | Where-Object { $_.Api -eq $Api } | Select-Object -First 1
  if ($hit -and $hit.Id -cmatch $ConnIdPattern) { return $hit.Id }
  return $null
}

function Find-DataverseConnection { return (Find-ConnectionFor 'shared_commondataserviceforapps') }

# Same as for Dataverse: opens the "create connection" page once and polls until the Teams connection exists.
function Wait-TeamsConnection {
  Step 'Finding the Microsoft Teams connection the alert flow will post with'
  $id = Find-ConnectionFor 'shared_teams'
  if ($id) { Ok 'Microsoft Teams connection found'; return $id }
  Warn 'No Microsoft Teams connection exists in this environment for your account yet.'
  Warn 'Opening the page now: click "Create" and sign in with an account that is a MEMBER of the team to post in.'
  Warn 'The script continues by itself as soon as the connection exists.'
  Start-Process "https://make.powerapps.com/environments/$EnvironmentId/connections/available?apiName=shared_teams"
  $deadline = (Get-Date).AddMinutes(15)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 10
    $id = Find-ConnectionFor 'shared_teams'
    if ($id) { Ok 'Microsoft Teams connection found'; return $id }
    Info ('waiting for the Teams connection... ({0} min left)' -f [int][Math]::Ceiling(($deadline - (Get-Date)).TotalMinutes))
  }
  Warn 'No Microsoft Teams connection after 15 minutes: continuing WITHOUT Teams alerts. Re-run the same command later to add them.'
  return ''
}

# ---------- SharePoint / OneDrive tenant name: detected, verified, never guessed ----------
# Order: (1) the domains of this tenant from the Az session that is already signed in (Get-AzTenant .Domains);
# (2) Microsoft Graph /organization with a token from the same session, if that token is allowed to read it;
# (3) interactive runs only: one optional question. Every candidate is checked by the helper: strict pattern, then
# https://<name>.sharepoint.com must answer like an existing tenant. Nothing here can stop the deployment.
function Resolve-SharePointTenant {
  param([string]$OrgUrl, [string]$StateDir)
  $script:SpoTenant = ''
  $script:SpoHow = ''
  $outFile = Join-Path $StateDir 'tenant-detect.json'
  $domains = @()
  try {
    $tid = Get-TenantId
    if ($tid -and (Get-Module -ListAvailable -Name Az.Accounts)) {
      $t = Get-AzTenant -TenantId $tid -ErrorAction Stop
      $domains = @($t.Domains | Where-Object { $_ -is [string] -and $_.Length -le 90 -and $_ -cmatch $OnMicrosoftPattern })
    }
  } catch { $domains = @() }
  try {
    if (Get-Module -ListAvailable -Name Az.Accounts) {
      $g = $null
      try { $g = (Get-AzAccessToken -ResourceTypeName MSGraph -AsSecureString -ErrorAction Stop).Token } catch { $g = (Get-AzAccessToken -ResourceTypeName MSGraph -ErrorAction Stop).Token }
      $env:OWPP_GRAPH_TOKEN = ConvertTo-PlainText $g
    }
  } catch { Remove-Item Env:\OWPP_GRAPH_TOKEN -ErrorAction SilentlyContinue }
  $detectArgs = @('detect-tenant', '--org-url', $OrgUrl, '--out', $outFile)
  if ($domains.Count -gt 0) { $detectArgs += @('--domains', (($domains | Select-Object -First 50) -join ',')) }
  [void](Invoke-Helper $detectArgs)
  Remove-Item Env:\OWPP_GRAPH_TOKEN -ErrorAction SilentlyContinue
  $d = Read-JsonFile $outFile
  if (-not $d) { return }
  if ($d.already) { $script:SpoHow = 'already'; return }
  if ($d.unsupported) { $script:SpoHow = 'unsupported'; return }
  if ($d.tenant -and ("$($d.tenant)" -cmatch $TenantPattern)) { $script:SpoTenant = "$($d.tenant)"; $script:SpoHow = "detected via $($d.via)"; return }
  if ($Yes) { return }
  $answer = Read-Host 'SharePoint tenant name (the contoso in contoso.sharepoint.com) - could not be detected; press Enter to skip'
  if (-not $answer) { return }
  $answer = $answer.Trim().ToLowerInvariant()
  if ($answer -cnotmatch $TenantPattern) { Warn 'That is not a tenant name (lowercase letters, digits, dashes). SharePoint / OneDrive stay unconfigured; add -TenantName later.'; return }
  [void](Invoke-Helper @('detect-tenant', '--org-url', $OrgUrl, '--candidate', $answer, '--out', $outFile))
  $script:SpoTenant = $answer
  $script:SpoHow = 'typed in'
}

# Hidden prompt for a webhook URL (a credential). Returns plain text for the helper's environment only; never printed.
function Read-WebhookSecret {
  param([string]$Label)
  $sec = Read-Host "$Label incoming-webhook URL (https, input hidden; Enter to skip)" -AsSecureString
  return (ConvertTo-PlainText $sec)
}

# Opens the "create connection" page once and polls until the connection exists (no re-run needed).
function Wait-DataverseConnection {
  Step 'Finding the Microsoft Dataverse connection the flow will run with'
  $id = Find-DataverseConnection
  if ($id) { Ok 'Microsoft Dataverse connection found'; return $id }
  Warn 'No Microsoft Dataverse connection exists in this environment for your account yet.'
  Warn 'This is the one thing that cannot be scripted (it is an OAuth consent). Opening the page now:'
  Warn '  click "Create" and sign in. The script continues by itself as soon as the connection exists.'
  Start-Process "https://make.powerapps.com/environments/$EnvironmentId/connections/available?apiName=shared_commondataserviceforapps"
  $deadline = (Get-Date).AddMinutes(15)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 10
    $id = Find-DataverseConnection
    if ($id) { Ok 'Microsoft Dataverse connection found'; return $id }
    Info ('waiting for the connection... ({0} min left)' -f [int][Math]::Ceiling(($deadline - (Get-Date)).TotalMinutes))
  }
  throw 'No Microsoft Dataverse connection after 15 minutes. Create it at make.powerapps.com > Connections > New connection > Microsoft Dataverse, then re-run the same command: it continues where it stopped.'
}

# ---------- npm ----------
function Install-Packages {
  Step 'Installing npm packages'
  if (Test-Path (Join-Path $root 'package-lock.json')) {
    & npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Warn 'npm ci failed - falling back to npm install'; Run 'npm' @('install', '--no-audit', '--no-fund') }
  } else { Run 'npm' @('install', '--no-audit', '--no-fund') }
  Ok 'npm packages installed'
}

# ---------- dashboard (code app) - power.config.json handling reused from the existing deploy script ----------
function Publish-Dashboard {
  Step 'Initialising the dashboard code app'
  $cfgPath   = Join-Path $root 'power.config.json'
  $stateDir  = Join-Path (Join-Path $root '.deploy-state') $EnvironmentId     # per environment: its own app id
  $cfgBackup = Join-Path $stateDir 'power.config.json'
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

  if (Test-Path $cfgPath) {
    $otherEnv = $null
    try { $otherEnv = ([System.IO.File]::ReadAllText($cfgPath).TrimStart([char]0xFEFF) | ConvertFrom-Json).environmentId } catch { }
    if ($otherEnv -and $otherEnv -ne $EnvironmentId) {
      if ($otherEnv -cmatch $GuidPattern) {
        $parked = Join-Path (Join-Path $root '.deploy-state') $otherEnv
        New-Item -ItemType Directory -Force -Path $parked | Out-Null
        Copy-Item $cfgPath (Join-Path $parked 'power.config.json') -Force
      }
      Remove-Item $cfgPath -Force
      foreach ($d in @('.power', 'src\generated')) { $dp = Join-Path $root $d; if (Test-Path $dp) { Remove-Item $dp -Recurse -Force } }
      Warn 'This folder was set up for a different environment - parked its config and starting clean for this one.'
    }
  }
  if (-not (Test-Path $cfgPath) -and (Test-Path $cfgBackup)) {
    Copy-Item $cfgBackup $cfgPath -Force
    Ok 'Restored power.config.json from the previous deploy (keeps the same app)'
  }
  if (-not (Test-Path $cfgPath)) { Run 'pac' @('code', 'init', '--displayName', $DisplayName) } else { Ok 'power.config.json exists - reusing' }
  if (Test-Path $cfgPath) { Copy-Item $cfgPath $cfgBackup -Force }

  Step 'Adding the Outage Watch tables as data sources of the dashboard'
  foreach ($tbl in @('owatch_target', 'owatch_result', 'owatch_setting', 'owatch_incident', 'owatch_command')) {
    $r = Invoke-Native 'pac' @('code', 'add-data-source', '-a', 'dataverse', '-t', $tbl)
    if ($r.Code -eq 0) { Ok "Dataverse table '$tbl' added" }
    elseif ($r.Text -match '(?i)already') { Ok "Dataverse table '$tbl' already added" }
    else { throw "Could not add Dataverse table '$tbl' to the dashboard: $($r.Text.Trim())" }
  }

  Step 'Building the dashboard'
  # pac sometimes generates TypeScript that does not compile; the app does not import src/generated, so fall back to a plain bundle.
  & npm run build
  if ($LASTEXITCODE -ne 0) {
    Warn 'Type-checked build failed - retrying with a plain bundle (the app does not import generated code).'
    Run 'npx' @('vite', 'build')
  }
  if (-not (Test-Path (Join-Path (Join-Path $root 'dist') 'index.html'))) { throw 'Build produced no dist\index.html' }
  Ok 'Build OK'

  Step 'Publishing the dashboard to Power Platform'
  $configBefore = $null
  if (Test-Path $cfgPath) { $configBefore = [System.IO.File]::ReadAllText($cfgPath) }
  # pac exits 0 even when the service rejects the push, so success is judged by its output.
  $push = Invoke-Native 'pac' @('code', 'push')
  $out = $push.Text
  Write-Host $out
  if ($configBefore -and -not (Test-Path $cfgPath)) { [System.IO.File]::WriteAllText($cfgPath, $configBefore, $utf8NoBom); Warn 'pac removed power.config.json - restored it' }

  # Same app name already exists (power.config.json was recreated): bind to the existing app and update it in place.
  if ($out -match 'ApplicationDisplayNameIsInUse' -and $out -match "Existing App: '([0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12})'") {
    $existing = $Matches[1]
    Warn "An app named '$DisplayName' already exists. Updating that app instead of creating a new one..."
    $raw = [System.IO.File]::ReadAllText($cfgPath).TrimStart([char]0xFEFF)
    if ($raw -match '"appId"\s*:') { $raw = [regex]::Replace($raw, '"appId"\s*:\s*(null|"[^"]*")', '"appId": "' + $existing + '"') }
    else { $raw = [regex]::Replace($raw, '^\s*\{', '{' + "`n  `"appId`": `"$existing`",", 1) }
    [System.IO.File]::WriteAllText($cfgPath, $raw, $utf8NoBom)   # no BOM, no re-serialisation
    $push = Invoke-Native 'pac' @('code', 'push')
    $out = $push.Text
    Write-Host $out
    if (-not (Test-Path $cfgPath)) { [System.IO.File]::WriteAllText($cfgPath, $raw, $utf8NoBom) }
  }
  if ($out -notmatch '(?i)pushed successfully') {
    if (-not (Test-Path $cfgPath) -and (Test-Path $cfgBackup)) { Copy-Item $cfgBackup $cfgPath -Force }
    $hint = ''
    if ($out -match '(?i)code\s*apps?.{0,40}(not|disabled)|not\s+enabled') { $hint = ' It looks like code apps are not enabled for this environment (admin center > Environments > Settings > Product > Features > Enable code apps).' }
    throw "Dashboard publish failed (see the pac message above).$hint Tables and flow are deployed and keep working; re-run the same command to retry only what is missing."
  }
  Copy-Item $cfgPath $cfgBackup -Force
  $script:AppUrl = "https://make.powerapps.com/environments/$EnvironmentId/apps"
  if ($out -match '(https://apps\.powerapps\.com/play/\S+)') { $script:AppUrl = $Matches[1] }
}

# ===== main =====
$exitCode = 0
try {
  Show-Checklist

  if (-not $EnvironmentId) {
    if ($Yes -and -not $DryRun) { throw 'With -Yes the environment ID must be given: Deploy-OutageWatchPP.cmd <environment-id> -Yes' }
    if (-not $DryRun) {
      Write-Host ''
      $EnvironmentId = Read-Host 'Paste the Power Platform Environment ID (GUID) to deploy to'
    }
  }
  if ($EnvironmentId) { $EnvironmentId = $EnvironmentId.Trim() }
  if ($EnvironmentId -or -not $DryRun) { Assert-Guid $EnvironmentId 'Environment ID'; $EnvironmentId = $EnvironmentId.ToLowerInvariant() }

  if ($IntervalMinutes -lt 1 -or $IntervalMinutes -gt 60) { throw '-IntervalMinutes must be 1..60.' }
  if ($RetentionDays -lt 1 -or $RetentionDays -gt 90) { throw '-RetentionDays must be 1..90.' }
  if ($SmokeWaitSeconds -lt 0 -or $SmokeWaitSeconds -gt 1800) { throw '-SmokeWaitSeconds must be 0..1800.' }
  if ($TenantName) { $TenantName = $TenantName.Trim().ToLowerInvariant(); if ($TenantName -cnotmatch $TenantPattern) { throw '-TenantName must be the short tenant name: lowercase letters, digits, dashes (e.g. contoso).' } }
  if ($DisplayName -cnotmatch $DisplayNamePattern) { throw '-DisplayName may contain letters, digits, space, dot, dash, underscore (max 49 characters).' }
  if ($Purge -and -not $Uninstall) { throw '-Purge only works together with -Uninstall.' }
  if ($SetHeartbeat -and $ClearHeartbeat) { throw 'Use either -SetHeartbeat or -ClearHeartbeat.' }

  $common = @('--interval', "$IntervalMinutes", '--retention', "$RetentionDays")
  if ($TenantName) { $common += @('--tenant', $TenantName) }
  if ($ClearHeartbeat) { $common += '--clear-heartbeat' }

  # ----- dry run: no sign-in, no changes -----
  if ($DryRun) {
    Ensure-Prerequisites $true
    Step 'DRY RUN - plan only, nothing is changed'
    if (-not (Have 'node')) { Warn 'Node.js is needed even for the dry run. Install Node.js LTS and re-run -DryRun.'; exit 1 }
    if ($env:OUTAGEWATCH_HEARTBEAT_URL) { $env:OWPP_HEARTBEAT_URL = $env:OUTAGEWATCH_HEARTBEAT_URL }
    if ($NoAlerts) { $common += '--no-alerts' }
    elseif ($TeamsChannelLink) {
      if ($TeamsChannelLink.Trim() -cnotmatch $TeamsLinkPattern) { throw 'That is not a Teams channel link. In Teams: channel name > "..." > "Get link to channel".' }
      $common += @('--teams-channel-link', $TeamsChannelLink.Trim())
    }
    if ($env:OUTAGEWATCH_SLACK_WEBHOOK) { $env:OWPP_SLACK_WEBHOOK = $env:OUTAGEWATCH_SLACK_WEBHOOK }
    if ($env:OUTAGEWATCH_WEBEX_WEBHOOK) { $env:OWPP_WEBEX_WEBHOOK = $env:OUTAGEWATCH_WEBEX_WEBHOOK }
    if ($env:OUTAGEWATCH_ALERT_WEBHOOK) { $env:OWPP_ALERT_WEBHOOK = $env:OUTAGEWATCH_ALERT_WEBHOOK }
    $code = Invoke-Helper (@('plan') + $common)
    if ($code -ne 0) { throw 'The plan could not be produced (see the message above).' }
    Info 'A real run also detects the SharePoint tenant name (Get-AzTenant, then Microsoft Graph), checks that https://<name>.sharepoint.com answers, and enables the three SharePoint / OneDrive targets. No input needed; -TenantName overrides; -NoSharePointAutoDetect skips.'
    Info 'Then: pac code init / add-data-source (5 tables) / npm run build / pac code push, and a smoke test that waits for the first result rows.'
    Info 'Run the same command without -DryRun to deploy.'
    exit 0
  }

  Ensure-Prerequisites $false
  Connect-Environment
  $orgUrl = Resolve-OrgUrl
  Ok "Dataverse: $orgUrl"

  # ----- uninstall -----
  if ($Uninstall) {
    Step 'Uninstall'
    if ($Purge) {
      Warn 'PURGE deletes the Outage Watch tables with ALL collected results, the connection reference, the solution and the publisher.'
      if (-not $Yes) { $a = Read-Host 'Type PURGE to continue'; if ($a -cne 'PURGE') { throw 'Cancelled. Nothing was removed.' } }
    } elseif (-not (Confirm-Step "Remove the Outage Watch probe flow from $orgUrl (tables and data are kept)?")) { throw 'Cancelled. Nothing was removed.' }
    $env:OWPP_TOKEN = @(Get-DataverseToken $orgUrl)[-1]   # last value only: stray output can never end up in the token
    $script:Changed = $true
    $u = @('uninstall', '--org-url', $orgUrl)
    if ($Purge) { $u += '--purge' }
    $code = Invoke-Helper $u
    if ($code -ne 0) { throw 'Uninstall did not finish (see the message above). It is safe to run it again.' }
    Write-Host "`nDone." -ForegroundColor Green
    Info "The dashboard app is NOT deleted automatically (no documented CLI command): delete '$DisplayName' at https://make.powerapps.com/environments/$EnvironmentId/apps"
    Info 'The Microsoft Dataverse connection is yours and is left untouched.'
    exit 0
  }

  # ----- deploy -----
  $deployDashboard = -not $SkipDashboard
  if ($deployDashboard) { $deployDashboard = Test-CodeApps }

  if ($SetHeartbeat) {
    $sec = Read-Host 'Heartbeat URL (https, input hidden; e.g. a healthchecks.io ping URL)' -AsSecureString
    $env:OWPP_HEARTBEAT_URL = ConvertTo-PlainText $sec
  } elseif ($env:OUTAGEWATCH_HEARTBEAT_URL) { $env:OWPP_HEARTBEAT_URL = $env:OUTAGEWATCH_HEARTBEAT_URL }

  # ----- alert channels (all optional). Webhook URLs are credentials: hidden prompt or environment variable only. -----
  $teamsConnectionId = ''
  if ($NoAlerts) { $common += '--no-alerts' }
  else {
    # One guided step. Without a channel NOBODY is told when a service fails, so interactive runs always ask.
    $guided = (-not $Yes) -and (-not $TeamsChannelLink) -and (-not $SetSlackWebhook) -and (-not $SetWebexWebhook) -and (-not $SetAlertWebhook)
    if ($guided) {
      Write-Host ''
      Write-Host '==> Alert channels: who should be told when a service fails? (each is optional; press Enter to skip one)' -ForegroundColor Cyan
      Info 'Channels set up on an earlier run are kept. Skipping all on a first run means: NO alerts, only the dashboard.'
      Info '1/4 Microsoft Teams. In Teams: hover the channel name > "..." > "Get link to channel" > Copy. (Standard channels only.)'
      $TeamsChannelLink = Read-Host '    Teams channel link'
      Info '2/4 Slack. Needs an "Incoming Webhook" URL for the channel (a webhook, not a Power Platform connector). Input is hidden.'
      $env:OWPP_SLACK_WEBHOOK = Read-WebhookSecret 'Slack'
      Info '3/4 Webex. Needs the "Incoming Webhooks" integration URL for the space (a webhook, not a connector). Input is hidden.'
      $env:OWPP_WEBEX_WEBHOOK = Read-WebhookSecret 'Webex'
      Info '4/4 Any other tool that accepts POST {"text": "..."} (generic webhook). Input is hidden.'
      $env:OWPP_ALERT_WEBHOOK = Read-WebhookSecret 'Generic'
      # (an empty answer leaves the variable unset: assigning an empty string to $env:NAME removes it)
    }
    if ($TeamsChannelLink) {
      $TeamsChannelLink = $TeamsChannelLink.Trim()
      if ($TeamsChannelLink -cnotmatch $TeamsLinkPattern) { throw 'That is not a Teams channel link. In Teams: channel name > "..." > "Get link to channel". Nothing has been changed.' }
      $code = Invoke-Helper @('check-teams-link', '--teams-channel-link', $TeamsChannelLink)
      if ($code -ne 0) { throw 'The Teams channel link was not accepted (see the message above). Nothing has been changed.' }
      $common += @('--teams-channel-link', $TeamsChannelLink)
    }
    if ($guided) { }
    elseif ($SetSlackWebhook) { $env:OWPP_SLACK_WEBHOOK = Read-WebhookSecret 'Slack' } elseif ($env:OUTAGEWATCH_SLACK_WEBHOOK) { $env:OWPP_SLACK_WEBHOOK = $env:OUTAGEWATCH_SLACK_WEBHOOK }
    if ($guided) { }
    elseif ($SetWebexWebhook) { $env:OWPP_WEBEX_WEBHOOK = Read-WebhookSecret 'Webex' } elseif ($env:OUTAGEWATCH_WEBEX_WEBHOOK) { $env:OWPP_WEBEX_WEBHOOK = $env:OUTAGEWATCH_WEBEX_WEBHOOK }
    if ($guided) { }
    elseif ($SetAlertWebhook) { $env:OWPP_ALERT_WEBHOOK = Read-WebhookSecret 'Generic' } elseif ($env:OUTAGEWATCH_ALERT_WEBHOOK) { $env:OWPP_ALERT_WEBHOOK = $env:OUTAGEWATCH_ALERT_WEBHOOK }
    if ($RemoveChannels) {
      $RemoveChannels = $RemoveChannels.Trim().ToLowerInvariant()
      if ($RemoveChannels -cnotmatch $ChannelListPattern) { throw '-RemoveChannels takes a comma list of: teams,slack,webex,webhook' }
      $common += @('--remove-channels', $RemoveChannels)
    }
  }

  Step 'Validating inputs'
  $code = Invoke-Helper (@('validate', '--environment-id', $EnvironmentId, '--org-url', $orgUrl) + $common)
  if ($code -ne 0) { throw 'Input validation failed (see the message above). Nothing has been changed.' }
  [void](Invoke-Helper (@('estimate') + $common))
  Warn 'The flow uses the premium HTTP connector: its owner (you) needs a Power Automate Premium licence (or a Process licence on the flow).'

  if (-not (Confirm-Step "Deploy Outage Watch to $orgUrl ?")) { throw 'Cancelled. Nothing has been changed.' }

  Install-Packages
  if (-not $SkipTests) {
    Step 'Running unit tests (classification logic, provisioning sequence against a mock Dataverse)'
    & npm test
    if ($LASTEXITCODE -ne 0) { throw 'Unit tests failed. Nothing has been changed in the environment. (Use -SkipTests to deploy anyway.)' }
    Ok 'Tests passed'
  }

  $connectionId = @(Wait-DataverseConnection)[-1]
  $env:OWPP_TOKEN = @(Get-DataverseToken $orgUrl)[-1]   # last value only: stray output can never end up in the token

  $stateDir = Join-Path (Join-Path $root '.deploy-state') $EnvironmentId
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  $resultFile = Join-Path $stateDir 'provision-result.json'

  # SharePoint / OneDrive coverage without asking: detect the tenant name unless it was given or detection is switched off
  $script:SpoTenant = ''
  $script:SpoHow = ''
  if ($TenantName) { $script:SpoHow = 'given with -TenantName' }
  elseif (-not $NoSharePointAutoDetect) {
    Step 'Detecting the SharePoint / OneDrive tenant name (no input needed)'
    Resolve-SharePointTenant $orgUrl $stateDir
    if ($script:SpoTenant) { $common += @('--tenant', $script:SpoTenant); Ok "SharePoint tenant: $($script:SpoTenant) ($($script:SpoHow))" }
    elseif ($script:SpoHow -eq 'already') { Ok 'SharePoint / OneDrive targets were configured on an earlier run' }
    elseif ($script:SpoHow -eq 'unsupported') { Warn 'SharePoint / OneDrive: this cloud is not supported yet; the three targets stay unconfigured.' }
    else { Warn 'SharePoint tenant name not detected: sharepoint-online, onedrive-business and sharepoint-admin stay unconfigured (not a failure).' }
  }

  Step 'Creating / upgrading tables, targets, connection reference and the probe flow'
  $script:Changed = $true
  $attempt = 0
  while ($true) {
    $attempt++
    $applyArgs = @('apply', '--org-url', $orgUrl, '--connection-id', $connectionId, '--out', $resultFile) + $common
    if ($teamsConnectionId) { $applyArgs += @('--teams-connection-id', $teamsConnectionId) }
    $code = Invoke-Helper $applyArgs
    if ($code -eq 0) { break }
    if ($code -eq 6 -and $attempt -le 3) {
      # Tables, targets and the probe flow are already in place and ON. Only the Teams alert channel is waiting.
      $teamsConnectionId = @(Wait-TeamsConnection)[-1]
      if (-not $teamsConnectionId) { $common = @($common | Where-Object { $_ -ne $TeamsChannelLink -and $_ -ne '--teams-channel-link' }) + @('--remove-channels', 'teams') }
      continue
    }
    if ($code -eq 3 -and $attempt -le 3) { $connectionId = @(Wait-DataverseConnection)[-1]; continue }
    if ($code -eq 4) {
      $res = Read-JsonFile $resultFile
      Warn 'The flow was created but Power Automate refused to turn it on (message above). Usual causes:'
      Warn '  - no Power Automate Premium licence for the flow owner (the HTTP action is premium)'
      Warn '  - a data loss prevention (DLP) policy blocks HTTP together with Microsoft Dataverse'
      Warn '  - the Dataverse connection needs to be re-authenticated'
      $flowUrl = "https://make.powerautomate.com/environments/$EnvironmentId/solutions"
      if ($res -and $res.flowId -and ("$($res.flowId)" -cmatch $GuidPattern)) { $flowUrl = "https://make.powerautomate.com/environments/$EnvironmentId/flows/$($res.flowId)/details" }
      if ($Yes -or $attempt -ge 5) { throw "The probe flow is deployed but OFF. Fix the cause, then re-run the same command (it only retries what is missing) or turn the flow on at $flowUrl" }
      Start-Process $flowUrl
      [void](Read-Host 'Fix the cause (the flow page is open), then press Enter to retry turning it on')
      continue
    }
    throw 'Provisioning failed (see the message above).'
  }
  $result = Read-JsonFile $resultFile
  Ok 'Tables, targets and flow are in place; the flow is ON'

  $script:AppUrl = $null
  if ($deployDashboard) { Publish-Dashboard }
  $appUrl = $script:AppUrl
  if ($appUrl -and $appUrl -cmatch $DashboardUrlPattern) {
    # so alert messages can link to the dashboard (the URL is not a secret)
    [void](Invoke-Helper @('set-dashboard-url', '--org-url', $orgUrl, '--url', $appUrl))
  }

  Step "Smoke test (reads the tables through the Web API and waits up to $SmokeWaitSeconds s for the first probe results)"
  $code = Invoke-Helper @('smoke', '--org-url', $orgUrl, '--wait-seconds', "$SmokeWaitSeconds")
  $smokeOk = ($code -eq 0)
  if ($code -eq 5) {
    Warn "No result row appeared within $SmokeWaitSeconds s. The deployment itself succeeded; the flow has not completed a run yet."
    Warn "Check the run history: https://make.powerautomate.com/environments/$EnvironmentId/flows (flow 'Outage Watch - probe')."
    Warn 'A failed run usually means a licence / DLP problem with the HTTP action. Re-run this command later to repeat the smoke test.'
  } elseif ($code -ne 0) { Warn 'The smoke test could not read the tables (message above).' }
  else { Ok 'First probe results are in Dataverse' }

  # ----- live test notification (same command row the dashboard button writes) -----
  $testState = ''
  if ($SendTestAlert) {
    if ($result -and $result.alerts -and "$($result.alerts.status)" -eq 'on') {
      Step 'Sending a live TEST notification to every configured channel (waits up to 180 s for the flow)'
      $code = Invoke-Helper @('test-notification', '--org-url', $orgUrl, '--channels', 'all', '--requested-by', 'Deploy-OutageWatchPP', '--wait-seconds', '180')
      if ($code -eq 0) { $testState = 'delivered'; Ok 'Every configured channel accepted the TEST message. Check that it is visible there.' }
      elseif ($code -eq 8) { $testState = 'timeout'; Warn "No answer within 180 s. The message may still arrive. Check the run history of the flow 'Outage Watch - test notification'." }
      elseif ($code -eq 7) { $testState = 'failed'; Warn 'The TEST message was NOT delivered to every channel (see the per-channel line above). A wrong or revoked webhook URL answers 404 / 403: set it again with -SetSlackWebhook / -SetWebexWebhook.' }
      else { $testState = 'failed'; Warn 'The TEST notification could not be requested (message above).' }
    } else { Warn '-SendTestAlert: no channel is configured (or alerts are off), so nothing was sent.' }
  }

  # ----- summary -----
  Write-Host "`n================ Outage Watch deployed ================" -ForegroundColor Green
  Write-Host "Environment : $EnvironmentId"
  Write-Host "Dataverse   : $orgUrl  (solution 'OutageWatch': tables owatch_target / owatch_result / owatch_setting / owatch_incident / owatch_command)"
  Write-Host "Probe flow  : 'Outage Watch - probe', every $IntervalMinutes min, results kept $RetentionDays days  ->  https://make.powerautomate.com/environments/$EnvironmentId/flows"
  if ($appUrl) { Write-Host "Dashboard   : $appUrl" -ForegroundColor Green }
  elseif ($SkipDashboard) { Write-Host 'Dashboard   : skipped (-SkipDashboard)' }
  else { Write-Host 'Dashboard   : NOT deployed (code apps disabled) - enable code apps and re-run the same command' -ForegroundColor Yellow }
  if ($smokeOk) { Write-Host 'Smoke test  : passed (first results written)' -ForegroundColor Green } else { Write-Host 'Smoke test  : NOT confirmed yet (see above)' -ForegroundColor Yellow }
  $spoMissing = @()
  if ($result -and $result.unconfigured) { $spoMissing = @($result.unconfigured) }
  if ($spoMissing.Count -eq 0) { Write-Host 'SharePoint  : sharepoint-online, onedrive-business and sharepoint-admin are probed' -ForegroundColor Green }
  else { Write-Host ("SharePoint  : NOT covered yet ({0} unconfigured). Add the tenant name: Deploy-OutageWatchPP.cmd {1} -TenantName contoso   (the contoso in contoso.sharepoint.com)" -f ($spoMissing -join ', '), $EnvironmentId) -ForegroundColor Yellow }
  if ($result -and $result.heartbeat) { Write-Host "Heartbeat   : configured (dead man's switch; URL not shown)" }
  else { Write-Host "Heartbeat   : NOT configured - re-run with -SetHeartbeat to be told from OUTSIDE when this monitor goes silent" -ForegroundColor Yellow }
  $alertStatus = ''
  if ($result -and $result.alerts) { $alertStatus = "$($result.alerts.status)" }
  if ($alertStatus -eq 'on') {
    Write-Host ("Alerts      : ON to {0}" -f (@($result.alerts.channels) -join ', ')) -ForegroundColor Green
    Write-Host "              created: cloud flow 'Outage Watch - alert' (Power Automate > Solutions > Outage Watch > Cloud flows), table 'Outage Watch Incident'"
    if (@($result.alerts.channels) -contains 'teams') { Write-Host "                       connection reference 'Outage Watch - Teams' (owatch_teams), bound to your Microsoft Teams connection" }
    Write-Host '              Slack / Webex / generic are incoming WEBHOOKS (HTTP action), not connectors: there is no Slack or Webex connection to look for. URLs are never shown.'
    if ($result.alerts.test -and "$($result.alerts.test.status)" -eq 'on') {
      Write-Host "              test   : dashboard > 'Send test notification now', or re-run with -SendTestAlert (flow 'Outage Watch - test notification', table 'Outage Watch Command')"
      Write-Host "                       only people with Create on the table 'Outage Watch Command' can send tests; at most one test every 5 minutes"
    } else {
      Write-Host "              test   : NOT AVAILABLE - the flow 'Outage Watch - test notification' could not be created or turned on (message above). Alerts themselves are on." -ForegroundColor Yellow
    }
    if ($testState -eq 'delivered') { Write-Host '              TEST   : delivered to every configured channel just now' -ForegroundColor Green }
    elseif ($testState) { Write-Host '              TEST   : NOT confirmed (see above)' -ForegroundColor Yellow }
    Write-Host '              mute  : set the setting alert_snooze_until to a UTC time such as 2026-12-31T18:00:00Z (probing continues)'
    Write-Host '              change: re-run with -TeamsChannelLink / -SetSlackWebhook / -SetWebexWebhook; remove with -RemoveChannels slack; stop with -NoAlerts'
    Write-Host '              CI    : pipelines read the setting ci_status (see the ci folder); agents: see the agent folder'
  } elseif ($alertStatus -eq 'failed') {
    Write-Host 'Alerts      : NOT ACTIVE - the alert flow could not be created or turned on (message above). Probing and the dashboard are unaffected.' -ForegroundColor Yellow
  } elseif ($alertStatus -eq 'disabled') {
    Write-Host 'Alerts      : OFF (-NoAlerts)' -ForegroundColor Yellow
  } else {
    Write-Host ''
    Write-Host '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!' -ForegroundColor Yellow
    Write-Host 'ALERTS ARE OFF: no channel is configured. Nobody is told when a service fails.' -ForegroundColor Yellow
    Write-Host 'No Teams / Slack / Webex integration exists until you give a channel. To add one, run:' -ForegroundColor Yellow
    Write-Host ("  Deploy-OutageWatchPP.cmd {0} -TeamsChannelLink ""<link from Teams: channel > ... > Get link to channel>"" -SendTestAlert" -f $EnvironmentId) -ForegroundColor Yellow
    Write-Host ("  Deploy-OutageWatchPP.cmd {0} -SetSlackWebhook -SendTestAlert      (asks for the Slack incoming-webhook URL, hidden)" -f $EnvironmentId) -ForegroundColor Yellow
    Write-Host ("  Deploy-OutageWatchPP.cmd {0} -SetWebexWebhook -SendTestAlert      (asks for the Webex incoming-webhook URL, hidden)" -f $EnvironmentId) -ForegroundColor Yellow
    Write-Host 'or run it without options and answer the "Alert channels" questions.' -ForegroundColor Yellow
    Write-Host '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!' -ForegroundColor Yellow
  }
  if ($result -and $result.estimate) { Write-Host ("Flow usage  : about {0} Power Platform requests/day (~{1}% of a 40,000/day Premium licence), {2} result rows/day" -f $result.estimate.perDay, $result.estimate.pctOf40k, $result.estimate.rowsPerDay) }
  Write-Host ''
  Write-Host 'SAME-FATE WARNING' -ForegroundColor Yellow
  Write-Host '  This monitor runs inside Microsoft''s cloud. If Power Platform, Dataverse or sign-in fails, the flow stops probing' -ForegroundColor Yellow
  Write-Host '  and the dashboard may not even open. It is NOT an independent vantage point. The dashboard shows a STALE banner' -ForegroundColor Yellow
  Write-Host '  when results stop arriving, and the optional heartbeat tells an outside service about the silence.' -ForegroundColor Yellow
  Write-Host '  Recommended witness: the host-based Python monitor (outage-watch-package) on a machine outside Microsoft 365.' -ForegroundColor Yellow
  Write-Host '  The same applies to the alerts: Power Automate (and Teams) run in the cloud being watched, so in a Microsoft outage an alert' -ForegroundColor Yellow
  Write-Host '  may be late or never arrive. Slack and Webex are outside Microsoft but are still sent BY Power Automate.' -ForegroundColor Yellow
  Write-Host ''
  Write-Host 'Still manual (cannot be scripted):' -ForegroundColor Gray
  Write-Host '  - First launch of the dashboard: approve the connection consent prompt.' -ForegroundColor Gray
  Write-Host '  - Other viewers: share the app with them and give them a security role with Read on the three owatch_ tables' -ForegroundColor Gray
  Write-Host '    (System Administrators / Customizers can already read them). They need a Power Apps Premium licence.' -ForegroundColor Gray
  Write-Host 'Re-run the same command any time to upgrade. Remove with Uninstall-OutageWatchPP.cmd <environment-id> [-Purge].' -ForegroundColor Gray
}
catch {
  $exitCode = 1
  Write-Host ''
  Write-Host "FAILED during: $($script:Stage)" -ForegroundColor Red
  Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
  if ($script:Changed) {
    Write-Host '  What exists so far is consistent and safe to keep: every step is idempotent.' -ForegroundColor Yellow
    Write-Host '  -> Fix the cause and re-run the SAME command: it continues where it stopped and creates no duplicates.' -ForegroundColor Yellow
    Write-Host '  -> To roll back instead: Uninstall-OutageWatchPP.cmd <environment-id>   (add -Purge to delete tables and data too).' -ForegroundColor Yellow
  } else {
    Write-Host '  Nothing was changed in the environment.' -ForegroundColor Yellow
  }
}
finally {
  Clear-Secrets
}
exit $exitCode
