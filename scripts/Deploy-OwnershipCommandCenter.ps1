<#
.SYNOPSIS
  Zero-touch deploy of "Ownership Command Center" (Power Apps code app) to a Power Platform environment.

.DESCRIPTION
  Prompts for the target environment (or pass -EnvironmentId), installs missing prerequisites,
  signs you in, wires up the connectors the app needs, builds, and publishes with `pac code push`.
  NO Azure app registration is used: the app runs with the signed-in admin's own connections.

  Connectors wired up:
    - Power Apps for Admins        (shared_powerappsforadmins)      apps + change app owner
    - Power Platform for Admins    (shared_powerplatformforadmins)  list all environments
    - Power Automate Management    (shared_flowmanagement)          list flows + change flow owner (as admin)
    - Power Automate for Admins    (shared_microsoftflowforadmins)  optional extra flow admin operations
    - Office 365 Users             (shared_office365users)          email -> user

.PARAMETER EnvironmentId   Target environment GUID (the part after /environments/ in the maker portal URL). Prompted if omitted.
.PARAMETER DisplayName     App display name.
.PARAMETER SkipPrereqInstall  Don't try to install Node.js / Power Platform CLI automatically.

.EXAMPLE
  ./scripts/Deploy-OwnershipCommandCenter.ps1
.EXAMPLE
  ./scripts/Deploy-OwnershipCommandCenter.ps1 -EnvironmentId 00000000-0000-0000-0000-000000000000
#>
[CmdletBinding()]
param(
  [string]$EnvironmentId,
  [string]$DisplayName = 'Ownership Command Center',
  [switch]$SkipPrereqInstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }
function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Run {
  param([string]$Exe, [string[]]$Args_)
  & $Exe @Args_
  if ($LASTEXITCODE -ne 0) { throw "'$Exe $($Args_ -join ' ')' failed (exit $LASTEXITCODE)" }
}

# ---------- 1. prerequisites ----------
Step 'Checking prerequisites'
if (-not (Have 'node')) {
  if ($SkipPrereqInstall) { throw 'Node.js is required (https://nodejs.org).' }
  if (Have 'winget') { Warn 'Installing Node.js LTS via winget...'; winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }
  else { throw 'Node.js not found and winget unavailable. Install Node.js LTS and re-run.' }
}
Ok "node $(node --version)"

if (-not (Have 'pac')) {
  if ($SkipPrereqInstall) { throw 'Power Platform CLI (pac) is required.' }
  if (Have 'dotnet') { Warn 'Installing Power Platform CLI via dotnet tool...'; dotnet tool install --global Microsoft.PowerApps.CLI.Tool
    $env:Path += ";$HOME\.dotnet\tools" }
  elseif (Have 'winget') { Warn 'Installing Power Platform CLI via winget...'; winget install -e --id Microsoft.PowerAppsCLI --accept-source-agreements --accept-package-agreements }
  else { throw 'pac not found. Install: https://aka.ms/PowerAppsCLI' }
}
if (-not (Have 'pac')) { throw 'pac was installed but is not on PATH yet. Open a NEW PowerShell window and re-run.' }
Ok 'Power Platform CLI present'

# ---------- 2. sign in ----------
Step 'Signing in (a browser window opens; use a Power Platform admin account)'
$who = (& pac auth who 2>&1) | Out-String
if ($who -notmatch 'Tenant|User') { Run pac @('auth','create') } else { Ok 'Existing pac profile found' }

# ---------- 3. choose environment ----------
Step 'Choosing target environment'
if (-not $EnvironmentId) {
  $list = (& pac env list 2>&1) | Out-String
  Write-Host $list
  $EnvironmentId = Read-Host 'Enter the Environment ID (GUID) to deploy to'
}
$EnvironmentId = $EnvironmentId.Trim()
if ($EnvironmentId -notmatch '^[0-9a-fA-F-]{36}$') { throw "'$EnvironmentId' is not a valid environment GUID." }
Run pac @('env','select','--environment',$EnvironmentId)
Ok "Target: $EnvironmentId"

# ---------- 4. install + init ----------
Step 'Installing npm packages'
Run npm @('install','--no-audit','--no-fund')

Step 'Initialising code app'
if (-not (Test-Path (Join-Path $root 'power.config.json'))) {
  Run pac @('code','init','--displayName',$DisplayName)
} else { Ok 'power.config.json exists - reusing' }

# ---------- 5. connectors ----------
Step 'Wiring connectors (uses YOUR connections - no app registration)'
$needed = @(
  @{ Label = 'Power Apps for Admins';     Apis = @('shared_powerappsforadmins');     Link = 'shared_powerappsforadmins' },
  @{ Label = 'Power Platform for Admins'; Apis = @('shared_powerplatformforadmins'); Link = 'shared_powerplatformforadmins' },
  @{ Label = 'Power Automate Management'; Apis = @('shared_flowmanagement');         Link = 'shared_flowmanagement' },
  @{ Label = 'Office 365 Users';          Apis = @('shared_office365users');         Link = 'shared_office365users' },
  @{ Label = 'Power Automate for Admins (optional)'; Apis = @('shared_microsoftflowforadmins'); Link = 'shared_microsoftflowforadmins'; Optional = $true }
)

function Get-Connections {
  $out = (& pac connection list 2>&1) | Out-String
  foreach ($line in ($out -split "`n")) {
    if ($line -match '(?i)\b([0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\b.*?(shared_[a-z0-9_\-]+)') {
      [pscustomobject]@{ Id = $Matches[1]; Api = $Matches[2].ToLower() }
    } elseif ($line -match '(?i)(shared_[a-z0-9_\-]+).*?\b([0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\b') {
      [pscustomobject]@{ Id = $Matches[2]; Api = $Matches[1].ToLower() }
    }
  }
}

function Find-Connection($n, $conns) {
  foreach ($a in $n.Apis) {
    $hit = $conns | Where-Object { $_.Api -eq $a } | Select-Object -First 1
    if ($hit) { return [pscustomobject]@{ Api = $a; Id = $hit.Id } }
  }
  return $null
}

$attempt = 0
while ($true) {
  $conns = @(Get-Connections)
  Write-Host ''
  $missing = @()
  foreach ($n in $needed) {
    if ($n.Skipped) { Write-Host "    [skipped] $($n.Label)" -ForegroundColor DarkGray; continue }
    if (Find-Connection $n $conns) { Write-Host "    [  OK  ]  $($n.Label)" -ForegroundColor Green }
    elseif ($n.Optional) { Write-Host "    [  --  ]  $($n.Label) - not created (fine to skip)" -ForegroundColor DarkGray }
    else { Write-Host "    [MISSING] $($n.Label)" -ForegroundColor Red; $missing += $n }
  }
  if (-not $missing) { break }

  Write-Host ''
  Warn 'These connections must be created once (OAuth sign-in cannot be scripted):'
  $missing | ForEach-Object { Warn "   - $($_.Label)" }
  Warn 'Opening your browser. For each page: click "Create" / "+ New connection" and sign in with your admin account.'
  $base = "https://make.powerapps.com/environments/$EnvironmentId/connections"
  foreach ($n in $missing) {
    if ($n.Link) { Start-Process "$base/available?apiName=$($n.Link)" }
  }
  if ($missing | Where-Object { -not $_.Link }) {
    Start-Process $base
    Warn "On the Connections page click '+ New connection' and search for: $((($missing | Where-Object { -not $_.Link }).Label) -join ', ')"
  }

  $ans = Read-Host 'Press Enter when done to re-check (or type S to skip the missing ones)'
  if ($ans -match '^[sS]') { $missing | ForEach-Object { $_.Skipped = $true; Warn "Skipped $($_.Label) - related features will show as 'missing' in Diagnostics." }; $attempt = 0; continue }
  if (++$attempt -ge 10) { throw 'Connections still missing after 10 checks.' }
}

foreach ($n in $needed) {
  if ($n.Skipped) { continue }
  $c = Find-Connection $n (Get-Connections)
  if ($c) {
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $out = (& pac code add-data-source -a $c.Api -c $c.Id 2>&1) | Out-String
    $ErrorActionPreference = $prev
    if ($LASTEXITCODE -eq 0) { Ok "$($n.Label): added ($($c.Api))" }
    elseif ($out -match '(?i)already') { Ok "$($n.Label): already added" }
    else { Warn "$($n.Label): could not add - $($out.Trim())" }
  }
}

# ---------- 6. build + publish ----------
Step 'Building'
# pac sometimes generates TypeScript that does not compile (e.g. parameters named api-version). The app does not
# use src/generated, so the type-check ignores it; if the strict build still fails, fall back to a plain bundle.
& npm run build
if ($LASTEXITCODE -ne 0) {
  Warn 'Type-checked build failed - retrying with a plain bundle (the app does not import generated code).'
  Run npx @('vite','build')
}
if (-not (Test-Path (Join-Path $root 'dist\index.html'))) { throw 'Build produced no dist\index.html' }
Ok 'Build OK'

Step 'Publishing to Power Platform'
function Push-App {
  # pac exits 0 even when the service rejects the push, so judge success by its output.
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $text = (& pac code push 2>&1 | ForEach-Object { $_.ToString() }) -join "`n"
  $ErrorActionPreference = $prev
  Write-Host $text
  return $text
}

$out = Push-App

# Same app name already exists (e.g. power.config.json was recreated): bind to the existing app and update it in place.
if ($out -match 'ApplicationDisplayNameIsInUse' -and $out -match "Existing App: '([0-9a-fA-F-]{36})'") {
  $existing = $Matches[1]
  Warn "An app named '$DisplayName' already exists ($existing). Updating that app instead of creating a new one..."
  $cfgPath = Join-Path $root 'power.config.json'
  $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
  if ($cfg.PSObject.Properties.Name -contains 'appId') { $cfg.appId = $existing }
  else { $cfg | Add-Member -NotePropertyName appId -NotePropertyValue $existing }
  ($cfg | ConvertTo-Json -Depth 20) | Set-Content -Path $cfgPath -Encoding UTF8
  $out = Push-App
}

if ($out -notmatch '(?i)pushed successfully') {
  throw "Publish failed (see the pac message above). If it says the name is in use, open power.config.json and set `"appId`" to the Existing App id it printed, then re-run."
}

$playUrl = if ($out -match '(https://apps\.powerapps\.com/play/\S+)') { $Matches[1] } else { $null }
Write-Host "`nDone. App published." -ForegroundColor Green
if ($playUrl) { Write-Host "Open it: $playUrl" -ForegroundColor Green }
Write-Host "Or from https://make.powerapps.com/environments/$EnvironmentId/apps  (look for '$DisplayName')." -ForegroundColor Green
Write-Host 'First launch: approve the connector consent prompts. You need Power Platform admin (or Environment admin) rights for the admin connectors to return data.' -ForegroundColor Gray
Write-Host 'Keep power.config.json - it links this folder to the published app for future updates.' -ForegroundColor Gray
