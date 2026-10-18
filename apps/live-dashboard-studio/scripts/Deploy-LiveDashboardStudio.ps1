<#
.SYNOPSIS
  Zero-touch deploy of "Live Dashboard Studio" (Power Apps code app) to a Power Platform environment.

.DESCRIPTION
  Installs missing prerequisites, signs you in, wires your database tables (SQL Server / Oracle / Dataverse) as data
  sources, builds and publishes with `pac code push`. NO Azure app registration: the app runs on the signed-in user's
  own connector connections. Files, pasted data and the demo work without any database setup.

.PARAMETER EnvironmentId   Target environment GUID. Prompted if omitted.
.PARAMETER DisplayName     App display name.
.PARAMETER SqlServer       SQL Server / Azure SQL server name, e.g. myserver.database.windows.net (needed with -SqlTables).
.PARAMETER SqlDatabase     Database name (needed with -SqlTables).
.PARAMETER SqlTables       Tables to expose, e.g. 'dbo.Orders','dbo.Customers'.
.PARAMETER OracleDataset   Oracle dataset / server value used by the Oracle connection (see README), needed with -OracleTables.
.PARAMETER OracleTables    Oracle tables to expose, e.g. 'SALES.ORDERS'.
.PARAMETER DataverseTables Dataverse tables of this environment to expose, e.g. 'account','opportunity'.
.PARAMETER SkipPrereqInstall  Don't try to install Node.js / Power Platform CLI automatically.

.EXAMPLE
  ./scripts/Deploy-LiveDashboardStudio.ps1
.EXAMPLE
  ./scripts/Deploy-LiveDashboardStudio.ps1 -EnvironmentId <guid> -SqlServer myserver.database.windows.net -SqlDatabase Sales -SqlTables 'dbo.Orders'
#>
[CmdletBinding()]
param(
  [string]$EnvironmentId,
  [string]$DisplayName = 'Live Dashboard Studio',
  [string]$SqlServer,
  [string]$SqlDatabase,
  [string[]]$SqlTables = @(),
  [string]$OracleDataset,
  [string[]]$OracleTables = @(),
  [string[]]$DataverseTables = @(),
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
Step 'Signing in (a browser window opens; use your work account)'
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
Set-Location $root
Run npm @('install','--no-audit','--no-fund')

Step 'Initialising code app'
$cfgPath   = Join-Path $root 'power.config.json'
$stateDir  = Join-Path (Join-Path $root '.deploy-state') $EnvironmentId     # per-environment: each environment has its own app id + connections
$cfgBackup = Join-Path $stateDir 'power.config.json'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)   # pac (Node) cannot parse a BOM

function Save-ConfigBackup { if (Test-Path $cfgPath) { New-Item -ItemType Directory -Force -Path $stateDir | Out-Null; Copy-Item $cfgPath $cfgBackup -Force } }
function Restore-ConfigIfMissing { if (-not (Test-Path $cfgPath) -and (Test-Path $cfgBackup)) { Copy-Item $cfgBackup $cfgPath -Force; Warn 'Restored power.config.json from .deploy-state' } }

# If the folder was last used for a DIFFERENT environment, park that environment's files so they do not leak into this deployment.
if (Test-Path $cfgPath) {
  $otherEnv = $null
  try { $otherEnv = ([System.IO.File]::ReadAllText($cfgPath).TrimStart([char]0xFEFF) | ConvertFrom-Json).environmentId } catch { }
  if ($otherEnv -and $otherEnv -ne $EnvironmentId) {
    $parked = Join-Path (Join-Path $root '.deploy-state') $otherEnv
    New-Item -ItemType Directory -Force -Path $parked | Out-Null
    Copy-Item $cfgPath (Join-Path $parked 'power.config.json') -Force
    Remove-Item $cfgPath -Force
    foreach ($d in @('.power','src\generated')) { $dp = Join-Path $root $d; if (Test-Path $dp) { Remove-Item $dp -Recurse -Force } }
    Warn "This folder was set up for environment $otherEnv - parked its config and starting clean for $EnvironmentId."
  }
}

if (-not (Test-Path $cfgPath) -and (Test-Path $cfgBackup)) {
  Copy-Item $cfgBackup $cfgPath -Force
  Ok 'Restored power.config.json from previous deploy (keeps the same app)'
}
if (-not (Test-Path $cfgPath)) {
  Run pac @('code','init','--displayName',$DisplayName)
} else { Ok 'power.config.json exists - reusing' }
Save-ConfigBackup

# ---------- 5. connectors ----------
Step 'Wiring database connectors (uses YOUR connections - no app registration)'
if ($SqlTables.Count -and (-not $SqlServer -or -not $SqlDatabase)) { throw '-SqlTables needs -SqlServer and -SqlDatabase.' }
if ($OracleTables.Count -and -not $OracleDataset) { throw '-OracleTables needs -OracleDataset.' }
$needed = @()
if ($SqlTables.Count)    { $needed += @{ Label = 'SQL Server';       Apis = @('shared_sql');    Link = 'shared_sql' } }
if ($OracleTables.Count) { $needed += @{ Label = 'Oracle Database';  Apis = @('shared_oracle'); Link = 'shared_oracle' } }
if (-not $needed.Count -and -not $DataverseTables.Count) { Ok 'No database tables requested: files, pasted data and the demo work without any connection.' }

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
  Warn 'Opening your browser. For each page: click "Create" / "+ New connection" and sign in with your account.'
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

function Add-Source([string]$label, [string[]]$cliArgs) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $out = (& pac code add-data-source @cliArgs 2>&1) | Out-String
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($code -eq 0) { Ok "$label : added" }
  elseif ($out -match '(?i)already') { Ok "$label : already added" }
  else { Warn "$label : could not add - $($out.Trim())"; Warn "Check the flags with: pac code add-data-source --help" }
}

$help = (& pac code add-data-source --help 2>&1) | Out-String
if ($help -notmatch '(?i)--dataset|-d\b') { Warn 'This pac version does not list a dataset option for add-data-source. Update pac (pac install latest) if SQL / Oracle tables fail to add.' }

foreach ($n in $needed) {
  if ($n.Skipped) { continue }
  $c = Find-Connection $n (Get-Connections)
  if (-not $c) { continue }
  if ($c.Api -eq 'shared_sql') {
    foreach ($t in $SqlTables) { Add-Source "SQL $t" @('-a','shared_sql','-c',$c.Id,'-d',"$SqlServer,$SqlDatabase",'-t',$t) }
  } elseif ($c.Api -eq 'shared_oracle') {
    foreach ($t in $OracleTables) { Add-Source "Oracle $t" @('-a','shared_oracle','-c',$c.Id,'-d',$OracleDataset,'-t',$t) }
  }
}
foreach ($t in $DataverseTables) { Add-Source "Dataverse $t" @('-a','dataverse','-t',$t) }

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

$configBefore = if (Test-Path $cfgPath) { [System.IO.File]::ReadAllText($cfgPath) } else { $null }
$out = Push-App
if ($configBefore -and -not (Test-Path $cfgPath)) { [System.IO.File]::WriteAllText($cfgPath, $configBefore, $utf8NoBom); Warn 'pac removed power.config.json - restored it' }

# Same app name already exists (power.config.json was recreated): bind to the existing app and update it in place.
if ($out -match 'ApplicationDisplayNameIsInUse' -and $out -match "Existing App: '([0-9a-fA-F-]{36})'") {
  $existing = $Matches[1]
  Warn "An app named '$DisplayName' already exists ($existing). Updating that app instead of creating a new one..."
  $raw = [System.IO.File]::ReadAllText($cfgPath).TrimStart([char]0xFEFF)
  if ($raw -match '"appId"\s*:') { $raw = [regex]::Replace($raw, '"appId"\s*:\s*(null|"[^"]*")', '"appId": "' + $existing + '"') }
  else { $raw = [regex]::Replace($raw, '^\s*\{', '{' + "`n  `"appId`": `"$existing`",", 1) }
  [System.IO.File]::WriteAllText($cfgPath, $raw, $utf8NoBom)   # no BOM, no re-serialisation
  Write-Host "    power.config.json now:`n$raw" -ForegroundColor DarkGray
  $out = Push-App
  if (-not (Test-Path $cfgPath)) { [System.IO.File]::WriteAllText($cfgPath, $raw, $utf8NoBom) }
}

# Last resort: binding to the old app did not work - publish under a new, dated name so you still get a working deployment.
if ($out -notmatch '(?i)pushed successfully' -and $out -match 'ApplicationDisplayNameIsInUse' -and (Test-Path $cfgPath)) {
  $newName = "$DisplayName " + (Get-Date -Format 'yyMMdd-HHmm')
  Warn "Could not update the existing app. Publishing as a NEW app named '$newName' (delete the old one later in make.powerapps.com)."
  $raw = [System.IO.File]::ReadAllText($cfgPath).TrimStart([char]0xFEFF)
  $raw = [regex]::Replace($raw, '"appId"\s*:\s*"[^"]*"', '"appId": null')
  $raw = [regex]::Replace($raw, '"appDisplayName"\s*:\s*"[^"]*"', '"appDisplayName": "' + $newName + '"')
  [System.IO.File]::WriteAllText($cfgPath, $raw, $utf8NoBom)
  $out = Push-App
}

if ($out -notmatch '(?i)pushed successfully') {
  Restore-ConfigIfMissing
  throw "Publish failed (see the pac message above). Copy everything shown above and send it for diagnosis."
}

Save-ConfigBackup
$playUrl = if ($out -match '(https://apps\.powerapps\.com/play/\S+)') { $Matches[1] } else { $null }
Write-Host "`nDone. App published." -ForegroundColor Green
if ($playUrl) { Write-Host "Open it: $playUrl" -ForegroundColor Green }
Write-Host "Or from https://make.powerapps.com/environments/$EnvironmentId/apps  (look for '$DisplayName')." -ForegroundColor Green
Write-Host 'First launch: approve the connector consent prompts (only needed when database tables were added).' -ForegroundColor Gray
Write-Host 'Keep power.config.json - it links this folder to the published app for future updates.' -ForegroundColor Gray
Write-Host 'Add more tables later by re-running this script with the extra -SqlTables / -OracleTables / -DataverseTables.' -ForegroundColor Gray
