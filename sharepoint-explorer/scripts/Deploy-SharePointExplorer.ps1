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
.PARAMETER AppId             Update this existing app (GUID from make.powerapps.com > Apps > Details) instead of letting pac decide. Use it if the
                             script says an app with this name already exists and it cannot work out which one.
.PARAMETER BootstrapList     Name of an existing list/library on the config site used to register the connector. Default: tries
                             'Documents', 'Shared Documents', 'Site Pages'.
.PARAMETER AddCopilotStudio  Also wire the Microsoft Copilot Studio connector (agent chat in the app).
.PARAMETER NoCopilotStudio   Skip the Copilot Studio question entirely.
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
  [string]$AppId,
  [switch]$AddCopilotStudio,
  [switch]$NoCopilotStudio,
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
  # A restored power.config.json may point at a connection/app that no longer exists: start clean when it names a different connection
  if (Test-Path $cfgPath) {
    $rawCfg = [System.IO.File]::ReadAllText($cfgPath)
    $ids = [regex]::Matches($rawCfg, '[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}') | ForEach-Object { $_.Value.ToLower() }
    if ($rawCfg -match 'connectionReferences' -and $rawCfg -match 'shared_sharepointonline' -and ($ids -notcontains $conn.Id.ToLower())) {
      Warn 'power.config.json refers to a different SharePoint connection than the one that exists now - clearing the old binding.'
      try { $j = $rawCfg.TrimStart([char]0xFEFF) | ConvertFrom-Json; foreach ($k in 'connectionReferences','databaseReferences','dataSources') { if ($j.PSObject.Properties[$k]) { $j.$k = [pscustomobject]@{} } }; [System.IO.File]::WriteAllText($cfgPath, ($j | ConvertTo-Json -Depth 20), $utf8NoBom) } catch { }
      $dp = Join-Path $root '.power'; if (Test-Path $dp) { Remove-Item $dp -Recurse -Force }
    }
  }

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
  if (-not $ConfigSiteUrl -and -not $NonInteractive) { do { $ConfigSiteUrl = (Read-Host 'Could not detect a SharePoint site. Config site URL (required, e.g. https://contoso.sharepoint.com/sites/Apps)').Trim() } while (-not $ConfigSiteUrl) }
  if (-not $ConfigSiteUrl) { throw 'A config site is required: without it other users cannot see which list the owner connected. Re-run with -ConfigSiteUrl https://<tenant>.sharepoint.com/sites/<site>.' }
  if ($ConfigSiteUrl) { $ConfigSiteUrl = $ConfigSiteUrl.TrimEnd('/') }
  $appConfig = [ordered]@{ owners = $OwnerUpn; configSiteUrl = "$ConfigSiteUrl"; configList = 'SPX_Config' }
  [System.IO.File]::WriteAllText((Join-Path $root 'src\appconfig.json'), (($appConfig | ConvertTo-Json -Depth 4) + "`n"), $utf8NoBom)

  # pac REGENERATES .power\...\dataSourcesInfo.ts on every `add-data-source` (it does not merge) and writes nothing when it answers "already exists".
  # So: add the optional Copilot Studio connector FIRST, SharePoint LAST, then check the generated file really holds each one.
  function Get-SchemaPath { @('.power\schemas\appschemas\dataSourcesInfo.ts', '.power\appschemas\dataSourcesInfo.ts') | Where-Object { Test-Path (Join-Path $root $_) } | Select-Object -First 1 }
  function Schema-Has([string]$needle) {   # text inside the generated dataSourcesInfo.ts (action-style sources such as Copilot Studio are keyed by connector name there)
    $sp = Get-SchemaPath; if (-not $sp) { return $false }
    return ([System.IO.File]::ReadAllText((Join-Path $root $sp)) -match "(?i)$needle")
  }
  function Sp-Count {   # how many SharePoint data sources power.config.json lists
    if (-not (Test-Path $cfgPath)) { return 0 }
    try { $j = ([System.IO.File]::ReadAllText($cfgPath).TrimStart([char]0xFEFF)) | ConvertFrom-Json; $r = $j.connectionReferences.PSObject.Properties | Where-Object { $_.Name -match '(?i)sharepointonline' } | Select-Object -First 1; if ($r) { return @($r.Value.dataSources).Count } } catch { }
    return 0
  }
  function Has-Sp {   # a tabular SharePoint registration is keyed by the LIST name in dataSourcesInfo.ts (no connector name inside), so look for its other traces
    $sp = Get-SchemaPath; if (-not $sp) { return $false }
    $hasEntry = ([System.IO.File]::ReadAllText((Join-Path $root $sp)) -match '["'']?tableId["'']?\s*:\s*["''][^"'']+["'']')
    $trace = (Test-Path (Join-Path $root '.power\schemas\sharepointonline')) -or ((Sp-Count) -gt 0)
    return ($hasEntry -and $trace)
  }
  function Reset-Pac {   # forget what pac believes is registered so the next add writes everything again
    $raw = if (Test-Path $cfgPath) { [System.IO.File]::ReadAllText($cfgPath).TrimStart([char]0xFEFF) } else { $null }
    if ($raw) { try { $j = $raw | ConvertFrom-Json; foreach ($k in 'connectionReferences','databaseReferences','dataSources') { if ($j.PSObject.Properties[$k]) { $j.$k = [pscustomobject]@{} } }; [System.IO.File]::WriteAllText($cfgPath, ($j | ConvertTo-Json -Depth 20), $utf8NoBom) } catch { } }
    $dp = Join-Path $root '.power'; if (Test-Path $dp) { Remove-Item $dp -Recurse -Force }
  }
  function Add-Src([string]$ApiName, [string]$ConnId, [string]$Needle, [string[]]$Extra) {   # true when pac said it worked (words + exit code), then verified
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $o = ((& pac code add-data-source -a $ApiName -c $ConnId @Extra 2>&1) | ForEach-Object { "$_" }) -join "`n"
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    $script:lastPacOutput = $o
    $said = $o -match '(?i)added successfully|already (exists|added|registered)'
    if ($said -or ($code -eq 0 -and $o -notmatch '(?i)(^|\n)\s*error|failed')) {
      $ok = if ($Needle -eq 'sharepointonline') { Has-Sp } else { Schema-Has $Needle }
      if (-not $ok) { Warn "pac reported success for $ApiName but its generated files do not show it yet - continuing (checked again after all connectors are added)." }
      return $true
    }
    return $false
  }
  # SharePoint is a *tabular* connector: pac wants one site (dataset) and one existing list (table) to register it. The app itself
  # reaches any site/list at run time, so which list is used here does not matter.
  function Invoke-PacText([string[]]$PacArgs) { $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; $t = (& pac @PacArgs 2>&1) | Out-String; $ErrorActionPreference = $prev; return $t }
  function Get-TableCandidates([string]$site) {   # lists/libraries pac can see on that site (no question to the user: the app lets the ADMIN pick the real list in its Connect screen)
    $out = ''
    foreach ($a in @(@('code','list-tables','-a',$api,'-c',$conn.Id,'-d',$site), @('code','list-tables','--apiId',$api,'--connectionId',$conn.Id,'--dataset',$site))) { $out = Invoke-PacText $a; if ($LASTEXITCODE -eq 0 -and $out.Trim()) { break } }
    $names = @()
    foreach ($line in ($out -split "`r?`n")) {
      $l = $line.Trim(); if (-not $l -or $l -match '^(?i)(name|id|table|display|-{3,}|=+|error|warning|usage|connected|retrieving|listing)') { continue }
      $col = ($l -split '\s{2,}|\|' | Where-Object { $_ } | Select-Object -First 1).Trim(' ', '"', "'", '*')
      if ($col -and $col.Length -lt 120) { $names += $col }
    }
    return @($names | Select-Object -Unique -First 12)
  }
  function Add-SharePoint {
    if (Add-Src $api $conn.Id 'sharepointonline' @()) { return $true }
    $sites = @($ConfigSiteUrl)
    $dsOut = Invoke-PacText @('code','list-datasets','-a',$api,'-c',$conn.Id)
    $sites += @([regex]::Matches($dsOut, 'https://[A-Za-z0-9.\-]+\.sharepoint\.[a-z]+/[^\s"''|,;]*') | ForEach-Object { $_.Value.TrimEnd('/') } | Select-Object -Unique -First 5)
    foreach ($site in ($sites | Where-Object { $_ } | Select-Object -Unique)) {
      $tables = @($BootstrapList) + @(Get-TableCandidates $site) + @('Documents', 'Shared Documents', 'Site Pages')
      foreach ($t in ($tables | Where-Object { $_ } | Select-Object -Unique)) {
        if (Add-Src $api $conn.Id 'sharepointonline' @('-d', $site, '-t', $t)) { Ok "Registered the SharePoint connector (using $site / $t just to register it - you choose the real list in the app's Connect screen)"; return $true }
      }
    }
    Write-Host "    (last pac output: $(($script:lastPacOutput -replace '\s+',' ').Trim()))" -ForegroundColor DarkGray
    return $false
  }

  function Get-Entry([string]$text, [string]$keyPattern) {   # the text of one top-level entry  "key": { ... }  (balanced braces, quotes respected)
    $m = [regex]::Match($text, '["'']?(' + $keyPattern + ')["'']?\s*:\s*\{')
    if (-not $m.Success) { return $null }
    $i = $m.Index + $m.Length - 1; $depth = 0; $q = [char]0
    for ($k = $i; $k -lt $text.Length; $k++) {
      $c = $text[$k]
      if ($q -ne [char]0) { if ($c -eq '\\') { $k++ } elseif ($c -eq $q) { $q = [char]0 }; continue }
      if ($c -eq '"' -or $c -eq "'" -or $c -eq '`') { $q = $c; continue }
      if ($c -eq '{') { $depth++ } elseif ($c -eq '}') { $depth--; if ($depth -eq 0) { return $text.Substring($m.Index, $k - $m.Index + 1) } }
    }
    return $null
  }
  function Merge-Copilot([string]$csText) {   # pac keeps only the connector it registered last: put the Copilot Studio entry back (checked with esbuild; the file is restored if it would not parse)
    $sp = Get-SchemaPath; if (-not $sp -or -not $csText) { return $false }
    $file = Join-Path $root $sp; $cur = [System.IO.File]::ReadAllText($file)
    $entry = Get-Entry $csText 'microsoftcopilotstudio|[A-Za-z0-9_\-]*copilotstudio[A-Za-z0-9_\-]*'
    if (-not $entry) { return $false }
    $first = [regex]::Match($cur, '=\s*\{'); if (-not $first.Success) { return $false }
    $merged = $cur.Insert($first.Index + $first.Length, "`n  $entry,")
    [System.IO.File]::WriteAllText($file, $merged, $utf8NoBom)
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $null = (& node -e "const fs=require('fs');require('esbuild').transformSync(fs.readFileSync(process.argv[1],'utf8'),{loader:'ts'})" $file 2>&1)
    $okParse = ($LASTEXITCODE -eq 0); $ErrorActionPreference = $prev
    if (-not $okParse -or -not (Has-Sp) -or -not (Schema-Has 'copilotstudio')) { [System.IO.File]::WriteAllText($file, $cur, $utf8NoBom); return $false }
    return $true
  }
  # optional Copilot Studio agent chat: decide first (connection / question), add it before SharePoint
  $csApi = 'shared_microsoftcopilotstudio'; $csConn = $null; $wantCs = $false; $csSchemaText = $null
  if (-not $NoCopilotStudio) {
    try {
      $csConn = @(Get-Connections) | Where-Object { $_.Api -eq $csApi } | Select-Object -First 1
      $wantCs = [bool]$AddCopilotStudio -or [bool]$csConn
      if (-not $wantCs -and -not $NonInteractive) { $wantCs = ((Read-Host 'Add AI assistant support (chat with a Copilot Studio agent inside the app)? [y/N]').Trim()) -match '^(y|yes)$' }
      if ($wantCs -and -not $csConn -and -not $NonInteractive) {
        Warn 'Create the "Microsoft Copilot Studio" connection once (sign-in cannot be scripted). Opening your browser...'
        Start-Process "https://make.powerapps.com/environments/$EnvironmentId/connections/available?apiName=$csApi"
        $null = Read-Host 'Press Enter when the connection is created'
        $csConn = @(Get-Connections) | Where-Object { $_.Api -eq $csApi } | Select-Object -First 1
      }
      if ($wantCs -and -not $csConn) { Warn 'No Copilot Studio connection found - skipping agent chat (agents can still be added as links in the app).'; $wantCs = $false }
    } catch { Warn "Copilot Studio step skipped: $($_.Exception.Message)"; $wantCs = $false }
  }
  # an earlier broken run may have registered SharePoint many times: start clean so exactly one registration remains
  if ((Sp-Count) -gt 1) { Warn "power.config.json lists $(Sp-Count) SharePoint registrations from earlier runs - cleaning up."; Reset-Pac }
  # a stale schema from an earlier deploy must not satisfy the checks below
  if ((Schema-Has 'copilotstudio') -and -not (Has-Sp)) { Warn 'The generated schema from an earlier run has no SharePoint source - starting clean.'; Reset-Pac }
  if ($wantCs) {
    Step 'Wiring the Copilot Studio connector (agent chat)'
    try { if (Add-Src $csApi $csConn.Id 'copilotstudio' @()) { Ok 'Copilot Studio connector added'; $csSchemaText = [System.IO.File]::ReadAllText((Join-Path $root (Get-SchemaPath))) } else { Warn 'Could not add the Copilot Studio connector - continuing with SharePoint only.'; $wantCs = $false } } catch { Warn "Copilot Studio step skipped: $($_.Exception.Message)"; $wantCs = $false }
  }
  $added = Add-SharePoint   # LAST: the connector the app cannot live without
  if (-not $added) {
    Warn 'SharePoint did not end up in the generated schema. Re-registering from a clean state...'
    Reset-Pac
    if ($wantCs) { $null = Add-Src $csApi $csConn.Id 'copilotstudio' @() }
    $added = Add-SharePoint
  }
  if (-not $added) { throw "Could not add the SharePoint connector. Run manually:  pac code add-data-source -a $api -c $($conn.Id) -d <site url> -t <existing list name>   then re-run this script." }
  Ok "SharePoint connector added ($($conn.Id))"
  if ($wantCs -and -not (Schema-Has 'copilotstudio')) {
    if (Merge-Copilot $csSchemaText) { Ok 'Copilot Studio connector merged back into the schema (pac keeps only the last connector it registers)' }
    else { Warn "Your pac version keeps only the last connector it registers (PowerAppsCodeApps issue 366), so agent chat is not included in this build. Update pac ('pac install latest' or 'dotnet tool update --global Microsoft.PowerApps.CLI.Tool') and run again with -AddCopilotStudio. Agents can still be added as links in the app." }
  }
  $schema = Get-SchemaPath
  if (-not $schema -or -not (Has-Sp)) { throw 'The generated data-source schema (.power\schemas\appschemas\dataSourcesInfo.ts) has no SharePoint source (looked for a list entry plus .power\schemas\sharepointonline or power.config.json): the app would show no SharePoint data. Delete power.config.json and the .power folder, then run this script again.' }
  Write-Host "    data sources in schema: $((([regex]::Matches([System.IO.File]::ReadAllText((Join-Path $root $schema)), '(?m)^\s*["'']?([A-Za-z0-9_\-]+)["'']?\s*:\s*\{') | ForEach-Object { $_.Groups[1].Value } | Where-Object { $_ -notin 'dataSourcesInfo','apis' }) -join ', '))" -ForegroundColor DarkGray
  Ok "Data-source schema present ($schema)"

  # ---------- 7. build ----------
  Step 'Building'
  & npm run build
  if ($LASTEXITCODE -ne 0) {   # pac sometimes generates TypeScript that does not compile; the app does not import it
    Warn 'Type-checked build failed - retrying with a plain bundle.'
    Run npx @('vite','build')
  }
  if (-not (Test-Path (Join-Path $root 'dist\index.html'))) { throw 'Build produced no dist\index.html' }
  Ok 'Build OK'
  # the SharePoint data source key pac generated (the entry with a real tableId) must be inside the built app
  $dsKey = $null
  $sf = Get-SchemaPath
  if ($sf) { $m = [regex]::Match([System.IO.File]::ReadAllText((Join-Path $root $sf)), '["'']?([A-Za-z0-9_\-]+)["'']?\s*:\s*\{\s*["'']?tableId["'']?\s*:\s*["''][^"'']+["'']'); if ($m.Success) { $dsKey = $m.Groups[1].Value } }
  if ($dsKey) {
    if (-not (Select-String -Path (Join-Path $root 'dist\assets\*.js') -Pattern ([regex]::Escape($dsKey)) -Quiet)) { throw "The built app does not contain the SharePoint data source '$dsKey': it would run without live data. Check the pac output above and run again." }
    Ok "Bundle contains the SharePoint data source '$dsKey'"
  } else { Warn 'Could not read the SharePoint data-source key from the generated schema; skipping the bundle check.' }
  $pkgVer = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
  Ok "Build stamp: v$pkgVer (shown in the app footer)"

  # ---------- 8. publish ----------
  Step 'Publishing to Power Platform'
  function Push-App {   # pac exits 0 even when the service rejects the push, so judge success by its output
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $text = (& pac code push 2>&1 | ForEach-Object { $_.ToString() }) -join "`n"
    $ErrorActionPreference = $prev
    Write-Host $text
    return $text
  }
  function Set-AppId([string]$id) {
    $raw = [System.IO.File]::ReadAllText($cfgPath).TrimStart([char]0xFEFF)
    if ($raw -match '"appId"\s*:') { $raw = [regex]::Replace($raw, '"appId"\s*:\s*(null|"[^"]*")', '"appId": "' + $id + '"') }
    else { $raw = [regex]::Replace($raw, '^\s*\{', '{' + "`n  `"appId`": `"$id`",", 1) }
    [System.IO.File]::WriteAllText($cfgPath, $raw, $utf8NoBom)
  }
  if ($AppId) { Set-AppId $AppId.Trim(); Ok "Updating app $AppId" }
  $configBefore = if (Test-Path $cfgPath) { [System.IO.File]::ReadAllText($cfgPath) } else { $null }
  $out = Push-App
  if ($configBefore -and -not (Test-Path $cfgPath)) { [System.IO.File]::WriteAllText($cfgPath, $configBefore, $utf8NoBom); Warn 'pac removed power.config.json - restored it' }

  if ($out -match 'ApplicationDisplayNameIsInUse') {   # an app with this name already exists: update THAT app (never publish a second, differently named copy)
    $existing = $null
    if ($out -match "Existing App: '([0-9a-fA-F-]{36})'") { $existing = $Matches[1] }
    else { $existing = ([regex]::Matches($out, '[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}') | ForEach-Object { $_.Value } | Where-Object { $_ -ne $EnvironmentId } | Select-Object -First 1) }
    if (-not $existing) { throw "An app named '$DisplayName' already exists in this environment but its id could not be read from pac's message. Open make.powerapps.com > Apps > $DisplayName > Details, copy the App ID and run again with -AppId <id> (or delete the old app first). Not publishing a duplicate on purpose." }
    Warn "An app named '$DisplayName' already exists ($existing). Updating that app..."
    Set-AppId $existing
    $out = Push-App
    if (-not (Test-Path $cfgPath) -and $configBefore) { [System.IO.File]::WriteAllText($cfgPath, $configBefore, $utf8NoBom); Set-AppId $existing }
  }
  if ($out -notmatch '(?i)pushed successfully') {
    if (-not (Test-Path $cfgPath) -and (Test-Path $cfgBackup)) { Copy-Item $cfgBackup $cfgPath -Force }
    throw 'Publish failed (see the pac message above).'
  }
  Save-ConfigBackup

  $playUrl = if ($out -match '(https://apps\.powerapps\.com/play/\S+)') { $Matches[1] } else { $null }
  Write-Host "`nDone. App published." -ForegroundColor Green
  if ($playUrl) { Write-Host "Open it: $playUrl" -ForegroundColor Green }
  $finalId = try { ([System.IO.File]::ReadAllText($cfgPath).TrimStart([char]0xFEFF) | ConvertFrom-Json).appId } catch { $null }
  Write-Host "Or: https://make.powerapps.com/environments/$EnvironmentId/apps  (look for '$DisplayName'; app id: $finalId)." -ForegroundColor Green
  Write-Host "IMPORTANT: close any open tab of the app, reopen it from that Apps list in environment $EnvironmentId and press Ctrl+F5. The footer must say 'Build v$pkgVer · live SharePoint data'. If it still shows an older build or a SAMPLE DATA bar, you are opening a different/older copy of the app." -ForegroundColor Yellow
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
