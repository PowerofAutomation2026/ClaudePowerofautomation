<#
.SYNOPSIS
  Zero-touch deploy of "Ownership Command Center" (Power Apps code app) to a Power Platform environment.

.DESCRIPTION
  Prompts for the target environment (or pass -EnvironmentId), installs missing prerequisites,
  signs you in, wires up the connectors the app needs, builds, and publishes with `pac code push`.
  NO Azure app registration is used: the app runs with the signed-in admin's own connections.

  Connectors wired up:
    - Power Apps for Admins        (shared_powerappsforadmins)
    - Power Automate for Admins    (shared_flowforadmins / shared_powerautomateforadmins / shared_flowmanagement)
    - Office 365 Users             (shared_office365users)

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
  @{ Label = 'Power Apps for Admins';     Apis = @('shared_powerappsforadmins');                                                   Link = 'shared_powerappsforadmins' },
  @{ Label = 'Power Automate for Admins'; Apis = @('shared_flowforadmins','shared_powerautomateforadmins','shared_flowmanagement'); Link = $null },
  @{ Label = 'Office 365 Users';          Apis = @('shared_office365users');                                                       Link = 'shared_office365users' }
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
  if ($c) { Run pac @('code','add-data-source','-a',$c.Api,'-c',$c.Id); Ok "$($n.Label): added ($($c.Api))" }
}

# ---------- 6. build + publish ----------
Step 'Building'
Run npm @('run','build')

Step 'Publishing to Power Platform'
Run pac @('code','push')

Write-Host "`nDone. Open it from https://make.powerapps.com/environments/$EnvironmentId/apps  (look for '$DisplayName')." -ForegroundColor Green
Write-Host 'First launch: approve the connector consent prompts. You need Power Platform admin (or Environment admin) rights for the admin connectors to return data.' -ForegroundColor Gray
