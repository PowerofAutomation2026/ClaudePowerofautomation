<#
.SYNOPSIS
  Zero-touch deploy of "SharePoint Explorer" (Power Apps code app) to a Power Platform environment.

.DESCRIPTION
  Installs missing prerequisites, signs you in, picks the environment, wires the SharePoint connector, bakes the app
  OWNER into the bundle (only owners see the Connect screen), builds and publishes with `pac code push`.
  You are the owner by default (the account you sign in with). No Azure app registration is used: the app runs on each
  user's own SharePoint connection.

  The only thing that cannot be scripted is the one-time OAuth sign-in that creates the SharePoint *connection*;
  if it does not exist yet the script opens the right page in your browser and waits for you.

.PARAMETER EnvironmentId     Target environment GUID. Prompted (with a list) if omitted.
.PARAMETER DisplayName       App display name.
.PARAMETER OwnerUpn          App owner(s) allowed to choose the list/library. Default: the signed-in pac user.
.PARAMETER ConfigSiteUrl     SharePoint site that (a) stores the app's shared settings - a small list "SPX_Config" the owner creates there on first
                             Connect - and (b) is used to register the SharePoint connector with `pac` (it needs one site + one existing list
                             to bootstrap; the app itself can then reach ANY site). Strongly recommended.
.PARAMETER BootstrapList     Name of an existing list/library on the config site used to register the connector. Default: tries
                             'Documents', 'Shared Documents', 'Site Pages'.
.PARAMETER NonInteractive    Never prompt; fail instead.
.PARAMETER SkipPrereqInstall Do not try to install Node.js / Power Platform CLI.

.EXAMPLE
  ./scripts/Deploy-SharePointExplorer.ps1
.EXAMPLE
  ./scripts/Deploy-SharePointExplorer.ps1 -EnvironmentId 00000000-0000-0000-0000-000000000000 -ConfigSiteUrl https://contoso.sharepoint.com/sites/Apps -OwnerUpn alice@contoso.com,bob@contoso.com
#>
[CmdletBinding()]
param(
  [string]$EnvironmentId,
  [string]$DisplayName = 'SharePoint Explorer',
  [string[]]$OwnerUpn,
  [string]$ConfigSiteUrl,
  [string]$BootstrapList,
  [switch]$NonInteractive,
  [switch]$SkipPrereqInstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$logDir = Join-Path $root '.deploy-logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
try { Start-Transcript -Path (Join-Path $logDir ("deploy-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date))) | Out-Null } catch { }

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }
function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Ask($prompt) { if ($NonInteractive) { throw "$prompt (required, but -NonInteractive was set)" }; Read-Host $prompt }
function Run {
  param([string]$Exe, [string[]]$Arguments)
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "'$Exe $($Arguments -join ' ')' failed (exit $LASTEXITCODE)" }
}
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ";$HOME\.dotnet\tools" }
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)   # pac (Node) cannot parse a BOM

try {
  # ---------- 1. prerequisites ----------
  Step 'Checking prerequisites'
  if (-not (Have 'node')) {
    if ($SkipPrereqInstall) { throw 'Node.js is required (https://nodejs.org).' }
    if (Have 'winget') { Warn 'Installing Node.js LTS via winget...'; winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements; Refresh-Path }
    else { throw 'Node.js not found and winget is unavailable. Install Node.js LTS and re-run.' }
  }
  if (-not (Have 'node')) { throw 'Node.js was installed but is not on PATH yet. Open a NEW PowerShell window and re-run.' }
  Ok "node $(node --version)"

  if (-not (Have 'pac')) {
    if ($SkipPrereqInstall) { throw 'Power Platform CLI (pac) is required.' }
    if (Have 'dotnet') { Warn 'Installing Power Platform CLI via dotnet tool...'; dotnet tool install --global Microsoft.PowerApps.CLI.Tool; Refresh-Path }
    elseif (Have 'winget') { Warn 'Installing Power Platform CLI via winget...'; winget install -e --id Microsoft.PowerAppsCLI --accept-source-agreements --accept-package-agreements; Refresh-Path }
    else { throw 'pac not found. Install it from https://aka.ms/PowerAppsCLI and re-run.' }
  }
  if (-not (Have 'pac')) { throw 'pac was installed but is not on PATH yet. Open a NEW PowerShell window and re-run.' }
  Ok 'Power Platform CLI present'

  # ---------- 2. sign in ----------
  Step 'Signing in (a browser window opens)'
  $who = (& pac auth who 2>&1) | Out-String
  if ($who -notmatch '(?i)Tenant|User') { Run pac @('auth','create'); $who = (& pac auth who 2>&1) | Out-String } else { Ok 'Existing pac profile found' }
  $signedIn = $null
  if ($who -match '(?i)(?:User|Name)\s*:?\s*([^\s@]+@[^\s]+)') { $signedIn = $Matches[1].Trim() }
  elseif ($who -match '([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})') { $signedIn = $Matches[1] }

  # ---------- 3. environment ----------
  Step 'Choosing target environment'
  if (-not $EnvironmentId) {
    Write-Host ((& pac env list 2>&1) | Out-String)
    $EnvironmentId = Ask 'Enter the Environment ID (GUID) to deploy to'
  }
  $EnvironmentId = $EnvironmentId.Trim()
  if ($EnvironmentId -notmatch '^[0-9a-fA-F-]{36}$') { throw "'$EnvironmentId' is not a valid environment GUID." }
  Run pac @('env','select','--environment',$EnvironmentId)
  Ok "Target: $EnvironmentId"

  # ---------- 4. owner + config ----------
  Step 'Configuring app owner'
  if (-not $OwnerUpn -or -not $OwnerUpn.Count) {
    if ($signedIn) { $OwnerUpn = @($signedIn); Ok "Owner = signed-in user $signedIn" }
    else { $OwnerUpn = @((Ask 'Owner e-mail / UPN (the person who may choose the list or library)')) }
  }
  $OwnerUpn = @($OwnerUpn | ForEach-Object { $_ -split '[,;]' } | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
  if (-not $OwnerUpn.Count) { throw 'At least one owner is required.' }
  Ok "Owners: $($OwnerUpn -join ', ')"

  # ---------- 5. install + init ----------
  Step 'Installing npm packages'
  Run npm @('install','--no-audit','--no-fund')

  Step 'Initialising code app'
  $cfgPath   = Join-Path $root 'power.config.json'
  $stateDir  = Join-Path (Join-Path $root '.deploy-state') $EnvironmentId     # each environment has its own app id + connections
  $cfgBackup = Join-Path $stateDir 'power.config.json'
  function Save-ConfigBackup { if (Test-Path $cfgPath) { New-Item -ItemType Directory -Force -Path $stateDir | Out-Null; Copy-Item $cfgPath $cfgBackup -Force } }

  if (Test-Path $cfgPath) {  # folder last used for ANOTHER environment: park its files so they do not leak into this deployment
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
  if (-not (Test-Path $cfgPath) -and (Test-Path $cfgBackup)) { Copy-Item $cfgBackup $cfgPath -Force; Ok 'Restored power.config.json from the previous deploy (keeps the same app)' }
  if (-not (Test-Path $cfgPath)) { Run pac @('code','init','--displayName',$DisplayName) } else { Ok 'power.config.json exists - reusing' }
  Save-ConfigBackup

  # ---------- 6. SharePoint connection ----------
  Step 'Wiring the SharePoint connector (uses each user''s own connection - no app registration)'
  function Get-Connections {
    $out = (& pac connection list 2>&1) | Out-String
    foreach ($line in ($out -split "`n")) {
      if ($line -match '(?i)\b([0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\b.*?(shared_[a-z0-9_\-]+)') { [pscustomobject]@{ Id = $Matches[1]; Api = $Matches[2].ToLower() } }
      elseif ($line -match '(?i)(shared_[a-z0-9_\-]+).*?\b([0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\b') { [pscustomobject]@{ Id = $Matches[2]; Api = $Matches[1].ToLower() } }
    }
  }
  $api = 'shared_sharepointonline'
  $attempt = 0
  while (-not (@(Get-Connections) | Where-Object { $_.Api -eq $api })) {
    if ($NonInteractive) { throw "No SharePoint connection exists in environment $EnvironmentId. Create one at https://make.powerapps.com/environments/$EnvironmentId/connections and re-run." }
    Warn 'The SharePoint connection must be created once (OAuth sign-in cannot be scripted).'
    Warn 'Opening your browser: click "Create" and sign in.'
    Start-Process "https://make.powerapps.com/environments/$EnvironmentId/connections/available?apiName=$api"
    $null = Read-Host 'Press Enter when the connection is created'
    if (++$attempt -ge 10) { throw 'SharePoint connection still missing after 10 checks.' }
  }
  $conn = @(Get-Connections) | Where-Object { $_.Api -eq $api } | Select-Object -First 1
  # No config site given: discover one from the user's own SharePoint connection (asked only if discovery finds nothing)
  if (-not $ConfigSiteUrl) {
    foreach ($cmd in @(@('code','list-datasets','-a',$api,'-c',$conn.Id), @('code','list-datasets','--apiId',$api,'--connectionId',$conn.Id))) {
      $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      $dsOut = (& pac @cmd 2>&1) | Out-String
      $ErrorActionPreference = $prev
      $urls = @([regex]::Matches($dsOut, 'https://[A-Za-z0-9.\-]+\.sharepoint\.[a-z]+/[^\s"''|,;]*') | ForEach-Object { $_.Value.TrimEnd('/') } | Select-Object -Unique)
      if ($urls.Count) { $ConfigSiteUrl = ($urls | Where-Object { $_ -match '/(sites|teams)/' } | Select-Object -First 1); if (-not $ConfigSiteUrl) { $ConfigSiteUrl = $urls[0] }; Ok "Using SharePoint site $ConfigSiteUrl for shared settings"; break }
    }
  }
  if (-not $ConfigSiteUrl -and -not $NonInteractive) { $ConfigSiteUrl = (Read-Host 'Could not detect a SharePoint site. Config site URL (e.g. https://contoso.sharepoint.com/sites/Apps)').Trim() }
  if ($ConfigSiteUrl) { $ConfigSiteUrl = $ConfigSiteUrl.TrimEnd('/') }
  $appConfig = [ordered]@{ owners = $OwnerUpn; configSiteUrl = "$ConfigSiteUrl"; configList = 'SPX_Config' }
  [System.IO.File]::WriteAllText((Join-Path $root 'src\appconfig.json'), (($appConfig | ConvertTo-Json -Depth 4) + "`n"), $utf8NoBom)

  function Add-Source([string[]]$Extra) {   # true when pac accepted it (or it is already there)
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $o = (& pac code add-data-source -a $api -c $conn.Id @Extra 2>&1) | Out-String
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    if ($code -eq 0 -or $o -match '(?i)already') { return $true }
    Write-Host "    (pac said: $(($o -replace '\s+',' ').Trim()))" -ForegroundColor DarkGray
    return $false
  }
  # SharePoint is a *tabular* connector: pac wants one site (dataset) and one existing list (table) to register it. The app itself
  # reaches any site/list at run time, so which list is used here does not matter.
  $added = Add-Source @()
  if (-not $added -and $ConfigSiteUrl) {
    $tables = @($BootstrapList, 'Documents', 'Shared Documents', 'Site Pages') | Where-Object { $_ } | Select-Object -Unique
    foreach ($t in $tables) { if (Add-Source @('-d', $ConfigSiteUrl, '-t', $t)) { $added = $true; Ok "Registered with $ConfigSiteUrl / $t"; break } }
    if (-not $added -and -not $NonInteractive) {
      $t = (Read-Host "Name of any existing list or library on $ConfigSiteUrl").Trim()
      if ($t -and (Add-Source @('-d', $ConfigSiteUrl, '-t', $t))) { $added = $true }
    }
  }
  if (-not $added) { throw "Could not add the SharePoint connector. Run manually:  pac code add-data-source -a $api -c $($conn.Id) -d <site url> -t <existing list name>   then re-run this script." }
  Ok "SharePoint connector added ($($conn.Id))"

  # ---------- 7. build ----------
  Step 'Building'
  & npm run build
  if ($LASTEXITCODE -ne 0) {   # pac sometimes generates TypeScript that does not compile; the app does not import it
    Warn 'Type-checked build failed - retrying with a plain bundle.'
    Run npx @('vite','build')
  }
  if (-not (Test-Path (Join-Path $root 'dist\index.html'))) { throw 'Build produced no dist\index.html' }
  Ok 'Build OK'

  # ---------- 8. publish ----------
  Step 'Publishing to Power Platform'
  function Push-App {   # pac exits 0 even when the service rejects the push, so judge success by its output
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $text = (& pac code push 2>&1 | ForEach-Object { $_.ToString() }) -join "`n"
    $ErrorActionPreference = $prev
    Write-Host $text
    return $text
  }
  $configBefore = if (Test-Path $cfgPath) { [System.IO.File]::ReadAllText($cfgPath) } else { $null }
  $out = Push-App
  if ($configBefore -and -not (Test-Path $cfgPath)) { [System.IO.File]::WriteAllText($cfgPath, $configBefore, $utf8NoBom); Warn 'pac removed power.config.json - restored it' }

  if ($out -match 'ApplicationDisplayNameIsInUse' -and $out -match "Existing App: '([0-9a-fA-F-]{36})'") {   # same name already exists: update it in place
    $existing = $Matches[1]
    Warn "An app named '$DisplayName' already exists ($existing). Updating that app..."
    $raw = [System.IO.File]::ReadAllText($cfgPath).TrimStart([char]0xFEFF)
    if ($raw -match '"appId"\s*:') { $raw = [regex]::Replace($raw, '"appId"\s*:\s*(null|"[^"]*")', '"appId": "' + $existing + '"') }
    else { $raw = [regex]::Replace($raw, '^\s*\{', '{' + "`n  `"appId`": `"$existing`",", 1) }
    [System.IO.File]::WriteAllText($cfgPath, $raw, $utf8NoBom)
    $out = Push-App
    if (-not (Test-Path $cfgPath)) { [System.IO.File]::WriteAllText($cfgPath, $raw, $utf8NoBom) }
  }
  if ($out -notmatch '(?i)pushed successfully' -and $out -match 'ApplicationDisplayNameIsInUse' -and (Test-Path $cfgPath)) {   # last resort: publish under a dated name
    $newName = "$DisplayName " + (Get-Date -Format 'yyMMdd-HHmm')
    Warn "Could not update the existing app. Publishing as a NEW app named '$newName' (delete the old one later in make.powerapps.com)."
    $raw = [System.IO.File]::ReadAllText($cfgPath).TrimStart([char]0xFEFF)
    $raw = [regex]::Replace($raw, '"appId"\s*:\s*"[^"]*"', '"appId": null')
    $raw = [regex]::Replace($raw, '"appDisplayName"\s*:\s*"[^"]*"', '"appDisplayName": "' + $newName + '"')
    [System.IO.File]::WriteAllText($cfgPath, $raw, $utf8NoBom)
    $out = Push-App
  }
  if ($out -notmatch '(?i)pushed successfully') {
    if (-not (Test-Path $cfgPath) -and (Test-Path $cfgBackup)) { Copy-Item $cfgBackup $cfgPath -Force }
    throw 'Publish failed (see the pac message above).'
  }
  Save-ConfigBackup

  $playUrl = if ($out -match '(https://apps\.powerapps\.com/play/\S+)') { $Matches[1] } else { $null }
  Write-Host "`nDone. App published." -ForegroundColor Green
  if ($playUrl) { Write-Host "Open it: $playUrl" -ForegroundColor Green }
  Write-Host "Or: https://make.powerapps.com/environments/$EnvironmentId/apps  (look for '$DisplayName')." -ForegroundColor Green
  Write-Host ''
  Write-Host 'Next steps' -ForegroundColor Cyan
  Write-Host "  1. Open the app -> approve the SharePoint consent prompt -> Connect tab -> pick the site, list or library -> press Connect." -ForegroundColor Gray
  Write-Host "  2. Share the app with your users in make.powerapps.com (they need a Power Apps premium licence for code apps and SharePoint access to the data)." -ForegroundColor Gray
  if ($ConfigSiteUrl) { Write-Host "  3. Give users READ and owners EDIT permission on the '$($appConfig.configList)' list at $ConfigSiteUrl (created on first Connect) so only owners can change the shared settings." -ForegroundColor Gray }
  Write-Host 'Keep power.config.json - it links this folder to the published app for future updates.' -ForegroundColor Gray
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
