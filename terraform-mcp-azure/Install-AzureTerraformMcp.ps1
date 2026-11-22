<#
.SYNOPSIS
  One-stop installer for the Azure Terraform MCP: prerequisites, sign-in, preflight checks, Entra groups,
  Azure deployment, Power Platform connector, smoke test, summary. Start it with Install.cmd (double-click).

.EXAMPLE
  ./Install-AzureTerraformMcp.ps1                              # interactive wizard
.EXAMPLE
  ./Install-AzureTerraformMcp.ps1 -PreflightOnly               # check everything, change nothing
.EXAMPLE
  ./Install-AzureTerraformMcp.ps1 -Unattended -ConfigFile ./install.config.json     # pipelines
.EXAMPLE
  ./Install-AzureTerraformMcp.ps1 -Uninstall

.NOTES
  Re-running is safe (upgrade). After a failure, re-run: finished steps are skipped (use -Force to redo all).
  Executed end to end against FAKE az / pac CLIs (ci/test-installer.sh). NOT run on Windows, and NOT against
  live Azure, Entra ID, Power Platform or Copilot Studio. The Power Platform part is best-effort by design:
  if it fails, the Azure installation still completes and out/agent-setup.md tells you the manual clicks.
#>
#Requires -Version 7.0
[CmdletBinding()]
param(
  [string] $ConfigFile,                 # JSON, see install.config.example.json. Command-line values win.
  [switch] $Unattended,                 # never prompt; fail with a clear message if something is missing
  [switch] $PreflightOnly,              # run the checks and stop
  [switch] $WhatIf,                     # like -PreflightOnly, and print what would be done
  [switch] $Uninstall,
  [switch] $RemoveGroups,               # with -Uninstall: also delete the Entra groups this installer created
  [switch] $Force,                      # do not resume: run every step again
  [switch] $SkipPrerequisites,
  [switch] $SkipPowerPlatform,
  [switch] $SkipSmokeTest,
  [string] $SubscriptionId,
  [string] $Prefix,
  [string] $Location,
  [string[]] $Environments,
  [switch] $EnableApply,
  [switch] $EnableDestroy,
  [string] $SecondApproverUpn,
  [string] $PowerPlatformEnvironment,   # environment URL, id or display name
  [ValidateSet('', 'dynamic', 'manual')] [string] $ConnectorAuth = '',   # default dynamic (Copilot Studio 'Dynamic discovery')
  [string] $AgentTemplateFile,          # optional: template from `pac copilot extract-template` to create the agent
  # still supported: bring your own groups instead of letting the installer create them
  [string] $RequesterGroupId, [string] $ApproverGroupId, [string] $ViewerGroupId, [string] $AdminGroupId
)
$ErrorActionPreference = 'Stop'
$script:Root = $PSScriptRoot
$outDir = Join-Path $Root 'out'
$logDir = Join-Path $Root '.deploy-logs'
$stateFile = Join-Path (Join-Path $Root '.deploy-state') 'install-state.json'
$KnownConfigKeys = @('subscriptionId', 'prefix', 'location', 'environments', 'allowedLocations', 'enableApply', 'enableDestroy',
  'lockEnvironments', 'groupNames', 'secondApproverUpn', 'monthlyBudgetUsd', 'enableScheduledJobs', 'enableMonitoring', 'alertEmail',
  'privateNetworking', 'enableDenyDeletePolicy', 'allowAzureCliClient', 'powerPlatform', 'skipSmokeTest', 'connectorAuth', 'extraRedirectUris')
$Steps = @('Prerequisites', 'Sign-in', 'Preflight checks', 'Entra groups', 'Azure deployment', 'Power Platform', 'Smoke test', 'Summary')

# ------------------------------------------------------------------------------------------------- helpers
function Write-Banner([int] $Number, [string] $Text) {
  Write-Progress -Activity 'Azure Terraform MCP installer' -Status "Step $Number of $($Steps.Count): $Text" -PercentComplete ([int](100 * ($Number - 1) / $Steps.Count))
  Write-Host ''
  Write-Host (" [{0}/{1}] {2} " -f $Number, $Steps.Count, $Text) -ForegroundColor Black -BackgroundColor Cyan
}
function Stop-Install([string] $Problem, [string] $Fix) {
  # every fatal error names the exact fix
  Write-Host ''
  Write-Host " PROBLEM: $Problem" -ForegroundColor Red
  Write-Host " FIX    : $Fix" -ForegroundColor Yellow
  throw "$Problem | Fix: $Fix"
}
function Invoke-Cli([string] $Exe) {
  # run a native CLI, stdout only, throw on non-zero. (Never name a wrapper like the executable: PowerShell
  # command names are case-insensitive and a function would shadow it.)
  $path = (Get-Command $Exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $rest = $args
  $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $all = & $path @rest 2>&1 } finally { $ErrorActionPreference = $previous }
  $code = $LASTEXITCODE
  $stdout = @($all | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
  if ($code -ne 0) {
    $stderr = @($all | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { "$_" }) -join "`n"
    throw "$Exe $($rest[0..([Math]::Min(2, $rest.Count - 1))] -join ' ') failed (exit $code): $stderr $stdout"
  }
  $stdout.Trim()
}
function Test-Cli { try { Invoke-Cli @args | Out-Null; $true } catch { $false } }
function Test-Command([string] $Name) { [bool](Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue) }
function Read-Answer([string] $Question, [string] $Default) {
  if ($Unattended) { return $Default }
  $suffix = if ($Default) { " [$Default]" } else { '' }
  $answer = Read-Host "$Question$suffix"
  if ([string]::IsNullOrWhiteSpace($answer)) { $Default } else { $answer.Trim() }
}
function Read-YesNo([string] $Question, [bool] $Default) {
  $answer = Read-Answer "$Question (y/n)" $(if ($Default) { 'y' } else { 'n' })
  $answer -match '^(y|yes|true|1)$'
}
function Select-FromList([string] $Title, [object[]] $Items, [scriptblock] $Label, [string] $Preselected) {
  # returns the chosen item; in unattended mode the preselected one (matched on any property value) or the only one
  if ($Preselected) {
    $hit = @($Items | Where-Object { $item = $_; @($item.PSObject.Properties.Value | Where-Object { "$_" -eq $Preselected }).Count -gt 0 })
    if ($hit.Count -ge 1) { return $hit[0] }
    Stop-Install "'$Preselected' was not found in: $Title." "Use one of: $(($Items | ForEach-Object { & $Label $_ }) -join '; ')"
  }
  if ($Items.Count -eq 1) { return $Items[0] }
  if ($Unattended) { Stop-Install "${Title}: more than one choice and none configured." 'Set it in the config file or on the command line.' }
  Write-Host $Title -ForegroundColor Cyan
  for ($i = 0; $i -lt $Items.Count; $i++) { Write-Host ("  {0,2}. {1}" -f ($i + 1), (& $Label $Items[$i])) }
  do { $n = (Read-Host "Number (1-$($Items.Count))") -as [int] } while (-not $n -or $n -lt 1 -or $n -gt $Items.Count)
  $Items[$n - 1]
}
function Get-Setting([string] $Name, $ParameterValue, $Default) {
  # precedence: command line > config file > default
  if ($null -ne $ParameterValue -and "$ParameterValue" -ne '' -and -not ($ParameterValue -is [switch] -and -not $ParameterValue)) { return $ParameterValue }
  if ($script:Config.Contains($Name) -and $null -ne $script:Config[$Name]) { return $script:Config[$Name] }
  $Default
}
function Get-State { if (Test-Path $stateFile) { Get-Content -Raw $stateFile | ConvertFrom-Json -AsHashtable } else { @{ status = 'new'; done = @{}; data = @{} } } }
function Save-State { New-Item -ItemType Directory -Force (Split-Path $stateFile) | Out-Null; $script:State | ConvertTo-Json -Depth 8 | Set-Content $stateFile -Encoding utf8 }
function Invoke-Step([int] $Number, [scriptblock] $Action, [switch] $Always) {
  $name = $Steps[$Number - 1]
  Write-Banner $Number $name
  if (-not $Always -and $script:Resuming -and $script:State.done[$name]) {
    Write-Host "   already done in the previous (failed) run - skipped. Use -Force to run it again." -ForegroundColor DarkGray
    return
  }
  & $Action
  $script:State.done[$name] = (Get-Date).ToString('s')
  Save-State
}
$script:Checks = [System.Collections.Generic.List[object]]::new()
function Add-Check([string] $Name, [string] $Result, [string] $Detail, [string] $Fix) {
  $script:Checks.Add([pscustomobject]@{ name = $Name; result = $Result; detail = $Detail; fix = $Fix })
  $color = @{ PASS = 'Green'; WARN = 'Yellow'; FAIL = 'Red'; INFO = 'Gray' }[$Result]
  Write-Host ("   {0}  {1}{2}" -f $Result, $Name, $(if ($Detail) { " - $Detail" } else { '' })) -ForegroundColor $color
  if ($Fix -and $Result -ne 'PASS') { Write-Host "         fix: $Fix" -ForegroundColor DarkYellow }
}

# ------------------------------------------------------------------------------------------------- configuration
$script:Config = @{}
if ($ConfigFile) {
  if (-not (Test-Path $ConfigFile)) { Stop-Install "Config file '$ConfigFile' not found." 'Copy install.config.example.json to install.config.json and edit it.' }
  $script:Config = Get-Content -Raw $ConfigFile | ConvertFrom-Json -AsHashtable
  $unknown = @($script:Config.Keys | Where-Object { $_ -notin $KnownConfigKeys })
  if ($unknown) { Stop-Install "Unknown setting(s) in ${ConfigFile}: $($unknown -join ', ')." "Allowed: $($KnownConfigKeys -join ', ')" }
} elseif ($Unattended) { Stop-Install '-Unattended needs -ConfigFile.' './Install-AzureTerraformMcp.ps1 -Unattended -ConfigFile ./install.config.json' }
$pp = if ($script:Config.Contains('powerPlatform') -and $script:Config.powerPlatform) { $script:Config.powerPlatform } else { @{} }
$groupNames = @{ viewers = 'Azure Terraform MCP Viewers'; requesters = 'Azure Terraform MCP Requesters'; approvers = 'Azure Terraform MCP Approvers'; admins = 'Azure Terraform MCP Admins' }
if ($script:Config.Contains('groupNames') -and $script:Config.groupNames) { foreach ($k in @($script:Config.groupNames.Keys)) { $groupNames[$k] = $script:Config.groupNames[$k] } }
if ($WhatIf) { $PreflightOnly = $true }

New-Item -ItemType Directory -Force $logDir, $outDir | Out-Null
$transcript = Join-Path $logDir ("install-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
try { Start-Transcript -Path $transcript | Out-Null } catch { Write-Warning "No transcript: $_" }
$script:State = Get-State
$script:Resuming = ($script:State.status -eq 'failed') -and -not $Force -and -not $Uninstall -and -not $PreflightOnly
if (-not $script:Resuming) { $script:State.done = @{} }
$script:State.status = 'failed'      # until the last step says otherwise
$summary = [ordered]@{ version = '2.3.0'; startedAt = (Get-Date).ToString('s'); mode = $(if ($Uninstall) { 'uninstall' } elseif ($PreflightOnly) { 'preflight' } else { 'install' }); result = 'failed' }
$exitCode = 1
Write-Host ''
Write-Host ' Azure Terraform MCP - installer ' -ForegroundColor White -BackgroundColor DarkBlue
Write-Host " Log: $transcript" -ForegroundColor DarkGray
if ($script:Resuming) { Write-Host ' Resuming after the previous failed run.' -ForegroundColor Yellow }

try {
  # ============================================================================================= 1 prerequisites
  Invoke-Step 1 -Always {
    $needs = @(@{ exe = 'az'; id = 'Microsoft.AzureCLI'; what = 'Azure CLI'; url = 'https://aka.ms/installazurecli' })
    if (-not $SkipPowerPlatform) { $needs += @{ exe = 'pac'; id = 'Microsoft.PowerAppsCLI'; what = 'Power Platform CLI'; url = 'https://aka.ms/PowerAppsCLI'; optional = $true } }
    foreach ($n in $needs) {
      if (Test-Command $n.exe) { Write-Host "   $($n.what): found" -ForegroundColor Green; continue }
      if ($SkipPrerequisites -or $PreflightOnly) { Write-Host "   $($n.what): MISSING (not installing in this mode)" -ForegroundColor Yellow; continue }
      if ($IsWindows -and (Test-Command 'winget')) {
        Write-Host "   installing $($n.what) with winget ..." -ForegroundColor Cyan
        & winget install --id $n.id -e --source winget --accept-source-agreements --accept-package-agreements | Out-Host
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
      } elseif ($n.exe -eq 'pac' -and (Test-Command 'dotnet')) {
        & dotnet tool install --global Microsoft.PowerApps.CLI.Tool | Out-Host
        $env:Path += [IO.Path]::PathSeparator + (Join-Path $HOME '.dotnet/tools')
      }
      if (-not (Test-Command $n.exe)) {
        if ($n.optional) { Write-Warning "$($n.what) is not available: the Power Platform step will be skipped. Install it from $($n.url) and re-run." }
        else { Stop-Install "$($n.what) is not installed and could not be installed automatically." "Install it from $($n.url), open a NEW terminal, and run Install.cmd again." }
      }
    }
    if (-not (Test-Command 'az')) { Stop-Install 'Azure CLI is required.' 'Install it from https://aka.ms/installazurecli' }
    $script:HasPac = (Test-Command 'pac') -and -not $SkipPowerPlatform
  }

  # ============================================================================================= 2 sign-in + choices
  Invoke-Step 2 -Always {
    if (-not (Test-Cli az account show)) {
      if ($Unattended) { Stop-Install 'Not signed in to Azure.' 'Run "az login" (or az login --service-principal ...) before the unattended install.' }
      Invoke-Cli az login | Out-Null
    }
    $subs = @(Invoke-Cli az account list --query "[?state=='Enabled'].{name:name, id:id, tenantId:tenantId}" -o json | ConvertFrom-Json)
    if (-not $subs) { Stop-Install 'No enabled Azure subscription is visible to this account.' 'Sign in with an account that has a subscription: az login --tenant <tenant>' }
    $sub = Select-FromList 'Azure subscriptions' $subs { param($s) "$($s.name)  ($($s.id))" } (Get-Setting 'subscriptionId' $SubscriptionId $null)
    $script:Sub = $sub.id
    Invoke-Cli az account set --subscription $script:Sub | Out-Null
    $script:Me = Invoke-Cli az ad signed-in-user show --query "{id:id, upn:userPrincipalName}" -o json | ConvertFrom-Json
    $script:PrefixValue = (Get-Setting 'prefix' $Prefix $null); if (-not $script:PrefixValue) { $script:PrefixValue = Read-Answer 'Short name prefix for all resources (3-12 lowercase letters/digits)' 'aztfmcp' }
    if ($script:PrefixValue -cnotmatch '^[a-z][a-z0-9]{2,11}$') { Stop-Install "Prefix '$($script:PrefixValue)' is invalid." 'Use 3-12 lowercase letters or digits, starting with a letter, for example aztfmcp.' }
    $script:LocationValue = (Get-Setting 'location' $Location $null); if (-not $script:LocationValue) { $script:LocationValue = Read-Answer 'Azure region' 'eastus2' }
    $envs = Get-Setting 'environments' $Environments $null
    if (-not $envs) { $envs = (Read-Answer 'Environments (comma separated)' 'dev,test,prod') }
    $script:Envs = @($envs | ForEach-Object { "$_" -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $script:Apply = [bool](Get-Setting 'enableApply' $EnableApply $false)
    $script:Destroy = [bool](Get-Setting 'enableDestroy' $EnableDestroy $false)
    if (-not $Unattended -and -not $ConfigFile -and -not $EnableApply -and -not $PreflightOnly -and -not $Uninstall) {
      $script:Apply = Read-YesNo 'Allow approved changes now? (n = plan-only first, recommended)' $false
      if ($script:Apply) { $script:Destroy = Read-YesNo 'Also allow approved destroys?' $false }
    }
    $script:Approver2 = Get-Setting 'secondApproverUpn' $SecondApproverUpn $null
    if (-not $script:Approver2 -and -not $Unattended -and -not $PreflightOnly -and -not $Uninstall -and -not $ApproverGroupId) {
      $script:Approver2 = Read-Answer 'Sign-in name (UPN) of a second person who may approve (empty = add later)' ''
    }
    # ---- Power Platform environment
    $script:PpEnv = $null
    $wantPp = $script:HasPac -and ($pp.Count -eq 0 -or $pp.enabled -ne $false)
    if ($wantPp) {
      try {
        if (-not (Test-Cli pac auth list)) {
          if ($Unattended) { throw 'pac is not signed in (run "pac auth create" first)' }
          Invoke-Cli pac auth create | Out-Null
        }
        $list = Invoke-Cli pac env list --json | ConvertFrom-Json
        $ppEnvs = @($list | ForEach-Object { [pscustomobject]@{ name = $_.DisplayName ?? $_.FriendlyName; url = ("$($_.EnvironmentUrl ?? $_.Url)").TrimEnd('/'); id = $_.EnvironmentId ?? $_.EnvironmentIdentifier.Id } })
        $wanted = Get-Setting 'ppEnvironment' $PowerPlatformEnvironment $pp.environment
        $script:PpEnv = Select-FromList 'Power Platform environments' $ppEnvs { param($e) "$($e.name)  ($($e.url))" } $wanted
      } catch {
        Write-Warning "Power Platform: could not list or select an environment ($(("$_" -split "`n")[0])). The connector step will be skipped."
      }
    }
    Write-Host "   subscription $($script:Sub) | prefix $($script:PrefixValue) | region $($script:LocationValue) | environments $($script:Envs -join ', ')" -ForegroundColor Gray
    Write-Host "   apply=$($script:Apply) destroy=$($script:Destroy) | Power Platform environment: $(if ($script:PpEnv) { $script:PpEnv.name } else { '(none)' })" -ForegroundColor Gray
  }
  $prefixV = $script:PrefixValue; $rg = "rg-$prefixV"
  $summary.subscriptionId = $script:Sub; $summary.prefix = $prefixV; $summary.location = $script:LocationValue; $summary.environments = $script:Envs

  # ============================================================================================= uninstall
  if ($Uninstall) {
    Write-Banner 5 'Uninstall'
    & (Join-Path $Root 'Deploy-AzureTerraformMcp.ps1') -SubscriptionId $script:Sub -Prefix $prefixV -Destroy
    if ($RemoveGroups) {
      foreach ($g in $groupNames.Values) {
        $id = Invoke-Cli az ad group list --display-name $g --query '[0].id' -o tsv
        if ($id) { Invoke-Cli az ad group delete --group $id | Out-Null; Write-Host "   deleted group $g" -ForegroundColor DarkGray }
      }
    }
    Write-Host @"

 Removed: resource group $rg (server, state, logs) and the three app registrations.
 NOT removed (delete deliberately if you want them gone):
   - workload resource groups, their locks, policy assignments and the custom role definitions
   - the Power Platform solution "Azure Terraform MCP" (connector, agent): delete it in make.powerapps.com > Solutions
   $(if (-not $RemoveGroups) { '- the Entra groups (re-run with -Uninstall -RemoveGroups)' })
"@
    $summary.result = 'uninstalled'; $script:State = @{ status = 'new'; done = @{}; data = @{} }; Save-State
    $exitCode = 0
    return
  }

  # ============================================================================================= 3 preflight
  Invoke-Step 3 -Always {
    $scope = "/subscriptions/$($script:Sub)"
    $roles = @((Invoke-Cli az role assignment list --assignee $script:Me.id --scope $scope --include-inherited --include-groups --query '[].roleDefinitionName' -o tsv) -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($roles -contains 'Owner') { Add-Check 'Subscription role' 'PASS' 'Owner' }
    elseif (($roles -contains 'Contributor') -and ($roles -contains 'User Access Administrator')) { Add-Check 'Subscription role' 'WARN' 'Contributor + User Access Administrator' 'Enough for roles and locks; the deny-delete policy also needs Resource Policy Contributor.' }
    else { Add-Check 'Subscription role' 'FAIL' "found: $(if ($roles) { $roles -join ', ' } else { 'none' })" "Ask an Owner to run: az role assignment create --assignee $($script:Me.upn) --role Owner --scope $scope" }

    $dirRoles = @((Invoke-Cli az rest --method GET --url 'https://graph.microsoft.com/v1.0/me/memberOf/microsoft.graph.directoryRole?$select=displayName' --query 'value[].displayName' -o tsv) -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $policy = Invoke-Cli az rest --method GET --url 'https://graph.microsoft.com/v1.0/policies/authorizationPolicy' --query '{apps:defaultUserRolePermissions.allowedToCreateApps, groups:defaultUserRolePermissions.allowedToCreateSecurityGroups}' -o json | ConvertFrom-Json
    $appAdmin = @($dirRoles | Where-Object { $_ -in 'Global Administrator', 'Application Administrator', 'Cloud Application Administrator' }).Count -gt 0
    if ($appAdmin -or $policy.apps) { Add-Check 'Entra: create app registrations' 'PASS' $(if ($appAdmin) { $dirRoles -join ', ' } else { 'allowed for all users' }) }
    else { Add-Check 'Entra: create app registrations' 'FAIL' 'no admin role and users may not register apps' 'Get the Application Administrator role (Entra ID > Roles and administrators), then re-run.' }
    if ($dirRoles -contains 'Global Administrator' -or $dirRoles -contains 'Privileged Role Administrator') { Add-Check 'Entra: admin consent' 'PASS' 'can grant tenant-wide consent' }
    else { Add-Check 'Entra: admin consent' 'WARN' 'you probably cannot grant admin consent' 'After the install a Global Administrator opens Entra ID > App registrations > <prefix>-connector > API permissions > Grant admin consent.' }
    $groupAdmin = @($dirRoles | Where-Object { $_ -in 'Global Administrator', 'Groups Administrator', 'User Administrator' }).Count -gt 0
    $byoGroups = $RequesterGroupId -and $ApproverGroupId -and $AdminGroupId
    if ($byoGroups) { Add-Check 'Entra: groups' 'PASS' 'using the group ids you passed' }
    elseif ($groupAdmin -or $policy.groups) { Add-Check 'Entra: create security groups' 'PASS' '' }
    else { Add-Check 'Entra: create security groups' 'FAIL' 'not allowed' 'Get the Groups Administrator role, or create four groups yourself and pass -RequesterGroupId -ApproverGroupId -ViewerGroupId -AdminGroupId.' }

    foreach ($ns in 'Microsoft.App', 'Microsoft.ContainerRegistry', 'Microsoft.Storage', 'Microsoft.OperationalInsights') {
      $st = Invoke-Cli az provider show -n $ns --query registrationState -o tsv
      if ($st -eq 'Registered') { Add-Check "Provider $ns" 'PASS' '' } else { Add-Check "Provider $ns" 'WARN' "state: $st" 'The deployment registers it; the first run may take a few minutes longer.' }
    }
    $regions = @((Invoke-Cli az provider show -n Microsoft.App --query "resourceTypes[?resourceType=='managedEnvironments'].locations | [0]" -o tsv) -split "`n" | ForEach-Object { ($_ -replace '\s', '').ToLower() })
    if ($regions -contains $script:LocationValue.ToLower()) { Add-Check 'Container Apps available in region' 'PASS' $script:LocationValue }
    else { Add-Check 'Container Apps available in region' 'FAIL' $script:LocationValue "Choose another region, for example: $(($regions | Select-Object -First 6) -join ', ')" }

    $sub6 = $script:Sub.Replace('-', '').Substring(0, 6).ToLower()
    $sa = "st$prefixV$sub6"; if ($sa.Length -gt 24) { $sa = $sa.Substring(0, 24) }
    $acr = "acr$prefixV$sub6"
    foreach ($c in @(@{ kind = 'Storage account'; name = $sa; mine = { Test-Cli az storage account show -g $rg -n $sa }; check = { Invoke-Cli az storage account check-name --name $sa --query nameAvailable -o tsv } },
                     @{ kind = 'Container registry'; name = $acr; mine = { Test-Cli az acr show -g $rg -n $acr }; check = { Invoke-Cli az acr check-name --name $acr --query nameAvailable -o tsv } })) {
      if (& $c.mine) { Add-Check "$($c.kind) name" 'PASS' "$($c.name) (exists in $rg - upgrade)" }
      elseif ((& $c.check) -eq 'true') { Add-Check "$($c.kind) name" 'PASS' "$($c.name) is available" }
      else { Add-Check "$($c.kind) name" 'FAIL' "$($c.name) is taken by someone else" 'Choose a different -Prefix.' }
    }
    if (-not $script:HasPac) { Add-Check 'Power Platform CLI' 'WARN' 'pac not available' 'The connector will not be created automatically; follow out/agent-setup.md.' }
    elseif (-not $script:PpEnv) { Add-Check 'Power Platform environment' 'WARN' 'none selected' 'Run "pac auth create", then re-run; or create the connector by hand (out/agent-setup.md).' }
    else {
      Add-Check 'Power Platform environment' 'PASS' "$($script:PpEnv.name) ($($script:PpEnv.url))"
      if (Get-Command Get-DlpPolicy -ErrorAction SilentlyContinue) {
        try {
          $dlp = @((Get-DlpPolicy).value | Where-Object { $_.environmentType -eq 'AllEnvironments' -or @($_.environments.name) -contains $script:PpEnv.id })
          if ($dlp) { Add-Check 'DLP policies' 'WARN' "$($dlp.Count) policy(ies) apply: $(($dlp.displayName) -join ', ')" 'In the Power Platform admin center > Policies > Data policies, check that custom connectors are allowed for the endpoint pattern https://*.azurecontainerapps.io (Custom connectors tab).' }
          else { Add-Check 'DLP policies' 'PASS' 'no data policy applies to this environment' }
        } catch { Add-Check 'DLP policies' 'WARN' 'could not be read' 'Check Power Platform admin center > Policies > Data policies for blocked custom connectors.' }
      } else { Add-Check 'DLP policies' 'WARN' 'not checked (module Microsoft.PowerApps.Administration.PowerShell is not installed)' 'Check Power Platform admin center > Policies > Data policies: custom connectors to https://*.azurecontainerapps.io must be allowed.' }
    }
    $script:ConnAuth = Get-Setting 'connectorAuth' $ConnectorAuth 'dynamic'
    if ($script:ConnAuth -eq 'dynamic') { Add-Check 'Copilot Studio sign-in mode' 'WARN' 'Dynamic discovery (paste only the server URL)' 'Your Copilot Studio MCP wizard must offer OAuth 2.0 > Dynamic discovery; some tenants do not have it yet. If yours does not, use the FALLBACK section of out/copilot-studio-wizard-values.md (Manual) - no reinstall needed.' }
    else { Add-Check 'Copilot Studio sign-in mode' 'INFO' 'Manual (paste values and client secret)' '' }
    Add-Check 'Licences' 'INFO' 'each user of the agent needs Copilot Studio access (tenant licence or user licence / message capacity); this cannot be checked from here' ''
    $failed = @($script:Checks | Where-Object { $_.result -eq 'FAIL' })
    $summary.preflight = $script:Checks
    Write-Host ("   => {0} passed, {1} warnings, {2} failed" -f @($script:Checks | Where-Object result -eq 'PASS').Count, @($script:Checks | Where-Object result -eq 'WARN').Count, $failed.Count) -ForegroundColor $(if ($failed) { 'Red' } else { 'Green' })
    if ($failed -and -not $PreflightOnly) { Stop-Install "$($failed.Count) preflight check(s) failed: $(($failed.name) -join '; ')." 'Apply the fix shown under each FAIL line, then run the installer again. Nothing has been changed yet.' }
  }
  if ($PreflightOnly) {
    if ($WhatIf) {
      Write-Host @"

 WHAT WOULD HAPPEN (nothing was changed):
   1. Entra groups: $(($groupNames.Values) -join ', ') - created if missing; you are added to Admins and Requesters.
   2. Azure: resource group $rg in $($script:LocationValue) with two container apps, two managed identities, storage, registry,
      logs; one resource group per environment ($($script:Envs -join ', ')); custom roles; locks; three app registrations.
   3. Power Platform: solution "Azure Terraform MCP" + custom connector in $(if ($script:PpEnv) { $script:PpEnv.name } else { '(skipped: no environment)' }).
   4. Smoke test and summary files in out/.
"@
    }
    $summary.result = if (@($script:Checks | Where-Object result -eq 'FAIL')) { 'preflight-failed' } else { 'preflight-ok' }
    $script:State.status = 'new'; Save-State
    $exitCode = if ($summary.result -eq 'preflight-ok') { 0 } else { 2 }
    return
  }

  # ============================================================================================= 4 groups
  Invoke-Step 4 {
    function Resolve-Group([string] $Key, [string] $GivenId) {
      if ($GivenId) { return $GivenId }
      $name = $groupNames[$Key]
      $id = Invoke-Cli az ad group list --display-name $name --query '[0].id' -o tsv
      if ($id) { Write-Host "   group '$name' exists" -ForegroundColor DarkGray }
      else {
        $id = Invoke-Cli az ad group create --display-name $name --mail-nickname (($name -replace '[^A-Za-z0-9]', '')) --description "Azure Terraform MCP role: $Key" --query id -o tsv
        Write-Host "   created group '$name'" -ForegroundColor Green
        $script:State.data["createdGroup:$Key"] = $id
      }
      $id
    }
    function Add-Member([string] $GroupId, [string] $MemberId, [string] $What) {
      if ((Invoke-Cli az ad group member check --group $GroupId --member-id $MemberId --query value -o tsv) -ne 'true') {
        Invoke-Cli az ad group member add --group $GroupId --member-id $MemberId | Out-Null
        Write-Host "   added $What" -ForegroundColor Green
      }
    }
    $g = @{ viewers = Resolve-Group 'viewers' $ViewerGroupId; requesters = Resolve-Group 'requesters' $RequesterGroupId
            approvers = Resolve-Group 'approvers' $ApproverGroupId; admins = Resolve-Group 'admins' $AdminGroupId }
    if (-not $AdminGroupId) { Add-Member $g.admins $script:Me.id "$($script:Me.upn) to Admins" }
    if (-not $RequesterGroupId) { Add-Member $g.requesters $script:Me.id "$($script:Me.upn) to Requesters" }
    if ($script:Approver2) {
      $other = Invoke-Cli az ad user show --id $script:Approver2 --query id -o tsv
      Add-Member $g.approvers $other "$($script:Approver2) to Approvers"
    } else { Write-Warning "No second approver yet: add at least one OTHER person to '$($groupNames.approvers)' or nobody can approve production changes (two-person rule)." }
    $script:State.data.groups = $g
  }
  $groups = $script:State.data.groups
  $summary.groups = $groups

  # ============================================================================================= 5 deploy
  Invoke-Step 5 -Always {
    $deploy = @{
      SubscriptionId = $script:Sub; Prefix = $prefixV; Location = $script:LocationValue; Environments = $script:Envs
      AllowedLocations = (Get-Setting 'allowedLocations' $null $script:LocationValue)
      RequesterGroupId = $groups.requesters; ApproverGroupId = $groups.approvers; ViewerGroupId = $groups.viewers; AdminGroupId = $groups.admins
      SkipPacConnector = $true; ConnectorAuth = $script:ConnAuth
    }
    $extra = Get-Setting 'extraRedirectUris' $null $null; if ($extra) { $deploy.ExtraRedirectUris = $extra }
    if ($script:Apply) { $deploy.EnableApply = $true }
    if ($script:Destroy) { $deploy.EnableDestroy = $true }
    foreach ($pair in @(@('lockEnvironments', 'LockEnvironments'), @('monthlyBudgetUsd', 'MonthlyBudgetUsd'), @('alertEmail', 'AlertEmail'))) {
      $v = Get-Setting $pair[0] $null $null; if ($v) { $deploy[$pair[1]] = $v }
    }
    foreach ($pair in @(@('enableScheduledJobs', 'EnableScheduledJobs'), @('enableMonitoring', 'EnableMonitoring'), @('privateNetworking', 'PrivateNetworking'),
                        @('enableDenyDeletePolicy', 'EnableDenyDeletePolicy'), @('allowAzureCliClient', 'AllowAzureCliClient'))) {
      if (Get-Setting $pair[0] $null $false) { $deploy[$pair[1]] = $true }
    }
    & (Join-Path $Root 'Deploy-AzureTerraformMcp.ps1') @deploy
    $script:State.data.mcpUrl = "https://$(Invoke-Cli az containerapp show -g $rg -n "ca-$prefixV" --query properties.configuration.ingress.fqdn -o tsv)/mcp"
    $script:State.data.approvalUrl = "https://$(Invoke-Cli az containerapp show -g $rg -n "ca-$prefixV-approval" --query properties.configuration.ingress.fqdn -o tsv)/"
  }
  $summary.mcpUrl = $script:State.data.mcpUrl; $summary.approvalUrl = $script:State.data.approvalUrl; $summary.connectorAuth = $script:ConnAuth

  # ============================================================================================= 6 Power Platform
  $ppResult = [ordered]@{ connector = 'not attempted'; solution = 'not attempted'; sharing = 'manual'; agent = 'manual' }
  Invoke-Step 6 -Always {
    if (-not $script:PpEnv) { Write-Host '   skipped (no Power Platform environment). See out/agent-setup.md.' -ForegroundColor Yellow; return }
    $envUrl = $script:PpEnv.url; $solution = 'AzureTerraformMcp'
    $swagger = Join-Path $outDir 'terraform-mcp.swagger.json'; $props = Join-Path $outDir 'apiProperties.json'
    try {   # (a) publisher + solution through the Dataverse Web API, so the connector can travel between environments
      $api = "$envUrl/api/data/v9.2"
      $pubId = Invoke-Cli az rest --method GET --url "$api/publishers?`$select=publisherid&`$filter=uniquename eq 'aztfmcp'" --resource $envUrl --query 'value[0].publisherid' -o tsv
      if (-not $pubId) {
        $body = Join-Path $outDir 'tmp-publisher.json'
        @{ uniquename = 'aztfmcp'; friendlyname = 'Azure Terraform MCP'; customizationprefix = 'aztf'; customizationoptionvalueprefix = 72700 } | ConvertTo-Json | Set-Content $body
        Invoke-Cli az rest --method POST --url "$api/publishers" --resource $envUrl --headers 'Content-Type=application/json' --body "@$body" | Out-Null
        Remove-Item $body -Force
        $pubId = Invoke-Cli az rest --method GET --url "$api/publishers?`$select=publisherid&`$filter=uniquename eq 'aztfmcp'" --resource $envUrl --query 'value[0].publisherid' -o tsv
      }
      $solId = Invoke-Cli az rest --method GET --url "$api/solutions?`$select=solutionid&`$filter=uniquename eq '$solution'" --resource $envUrl --query 'value[0].solutionid' -o tsv
      if (-not $solId) {
        $body = Join-Path $outDir 'tmp-solution.json'
        @{ uniquename = $solution; friendlyname = 'Azure Terraform MCP'; version = '2.2.0.0'; 'publisherid@odata.bind' = "/publishers($pubId)" } | ConvertTo-Json | Set-Content $body
        Invoke-Cli az rest --method POST --url "$api/solutions" --resource $envUrl --headers 'Content-Type=application/json' --body "@$body" | Out-Null
        Remove-Item $body -Force
      }
      $ppResult.solution = "ok ($solution)"
    } catch { $ppResult.solution = "failed: $(("$_" -split "`n")[0])"; Write-Warning "Solution not created ($($ppResult.solution)). The connector is created outside a solution." }
    try {   # (b) custom connector
      $existing = $null
      try { $existing = @(Invoke-Cli pac connector list --environment $envUrl --json | ConvertFrom-Json) | Where-Object { ($_.DisplayName ?? $_.Name) -eq 'Azure Terraform MCP' } | Select-Object -First 1 } catch { }
      if ($existing) {
        Invoke-Cli pac connector update --connector-id ($existing.ConnectorId ?? $existing.Id) --api-definition-file $swagger --api-properties-file $props --environment $envUrl | Out-Null
        $ppResult.connector = 'updated'
      } else {
        $extra = if ($ppResult.solution -like 'ok*') { @('--solution-unique-name', $solution) } else { @() }
        Invoke-Cli pac connector create --api-definition-file $swagger --api-properties-file $props --environment $envUrl @extra | Out-Null
        $ppResult.connector = 'created'
      }
    } catch { $ppResult.connector = "failed: $(("$_" -split "`n")[0])"; Write-Warning "Connector not created automatically. Follow out/agent-setup.md (2 minutes)." }
    if ($ppResult.connector -in 'created', 'updated' -and ($pp.Count -eq 0 -or $pp.shareWithGroups -ne $false)) {
      if (Get-Command Set-AdminPowerAppConnectorRoleAssignment -ErrorAction SilentlyContinue) {
        try {   # (c) share the connector with the requester and viewer groups
          $conn = @(Invoke-Cli pac connector list --environment $envUrl --json | ConvertFrom-Json) | Where-Object { ($_.DisplayName ?? $_.Name) -eq 'Azure Terraform MCP' } | Select-Object -First 1
          foreach ($gid in $groups.requesters, $groups.viewers, $groups.admins) {
            Set-AdminPowerAppConnectorRoleAssignment -ConnectorName ($conn.Name ?? $conn.ConnectorId) -EnvironmentName $script:PpEnv.id -PrincipalType Group -PrincipalObjectId $gid -RoleName CanView | Out-Null
          }
          $ppResult.sharing = 'connector shared with requesters, viewers, admins (CanView)'
        } catch { $ppResult.sharing = "manual (sharing failed: $(("$_" -split "`n")[0]))" }
      } else { $ppResult.sharing = 'manual (install module Microsoft.PowerApps.Administration.PowerShell to automate, or share in the maker portal)' }
    }
    $template = Get-Setting 'agentTemplateFile' $AgentTemplateFile $pp.agentTemplateFile
    if ($template -and $ppResult.connector -in 'created', 'updated') {
      try {   # (d) agent from YOUR exported template (pac copilot extract-template); there is no supported way to generate one from scratch
        $extra = if ($ppResult.solution -like 'ok*') { @('--solution', $solution) } else { @() }
        Invoke-Cli pac copilot create --schemaName 'aztf_azurePlatformAssistant' --templateFileName $template --displayName 'Azure Platform Assistant' --environment $envUrl @extra | Out-Null
        $ppResult.agent = 'created from template (open it once in Copilot Studio to check the tool connection, then publish)'
      } catch { $ppResult.agent = "manual (pac copilot create failed: $(("$_" -split "`n")[0]))" }
    }
    Write-Host "   solution: $($ppResult.solution) | connector: $($ppResult.connector) | sharing: $($ppResult.sharing) | agent: $($ppResult.agent)" -ForegroundColor Gray
  }
  $summary.powerPlatform = $ppResult

  # ============================================================================================= 7 smoke test
  $smoke = 'skipped'
  Invoke-Step 7 -Always {
    if ($SkipSmokeTest -or (Get-Setting 'skipSmokeTest' $null $false)) { Write-Host '   skipped on request' -ForegroundColor Yellow; return }
    $cliAllowed = [bool](Get-Setting 'allowAzureCliClient' $null $false)
    $args2 = @{ SubscriptionId = $script:Sub; Prefix = $prefixV }
    if (-not $cliAllowed) { $args2.AnonymousOnly = $true; Write-Host '   anonymous checks only (the server accepts the connector app only; set allowAzureCliClient for the full test)' -ForegroundColor DarkGray }
    & (Join-Path $Root 'Test-TerraformMcp.ps1') @args2
    $script:SmokeResult = if ($LASTEXITCODE -eq 0) { 'PASS' } else { 'FAIL' }
  }
  if ($script:SmokeResult) { $smoke = $script:SmokeResult }
  $summary.smokeTest = $smoke

  # ============================================================================================= 8 summary
  Invoke-Step 8 -Always {
    $mcp = $summary.mcpUrl; $approval = $summary.approvalUrl
    $dynamic = $script:ConnAuth -eq 'dynamic'
    @"
# Finish the agent in Copilot Studio

$(if ($dynamic) { @"
## Recommended: Dynamic discovery (about one minute, nothing to paste but the URL)
1. Copilot Studio > Create > New agent > name it **Azure Platform Assistant**.
2. Tools > Add a tool > New tool > **Model Context Protocol**.
3. Server URL: **$mcp**  -  Authentication: **OAuth 2.0 > Dynamic discovery**  -  Create.
4. Create new connection > sign in.  Add to agent.
5. Instructions: paste ``agent-instructions.md``.  Publish.
6. Share the agent with "$($groupNames.requesters)" and "$($groupNames.viewers)" (Share > add the security groups).

If the wizard has no "Dynamic discovery" option or it fails: use the FALLBACK section of
``out/copilot-studio-wizard-values.md`` (OAuth 2.0 > Manual), or the pre-built connector below.
"@ } else { "## Sign-in mode: Manual`nUse the paste-ready values in ``out/copilot-studio-wizard-values.md`` (OAuth 2.0 > Manual), or the pre-built connector below." })

## Alternative: the pre-built custom connector (solution "Azure Terraform MCP")
What the installer did in Power Platform: solution **$($ppResult.solution)**, connector **$($ppResult.connector)**, sharing **$($ppResult.sharing)**, agent **$($ppResult.agent)**.
The connector uses the manual OAuth settings. To use it: make.powerapps.com > Solutions > **Azure Terraform MCP** > the connector >
Edit > **Security** > paste the client secret from ``out/connector-client-secret.txt`` > Update connector; then in the agent:
Tools > Add a tool > search **Azure Terraform MCP** > Add (end user authentication).
$(if ($dynamic) { 'With Dynamic discovery working you do not need this connector.' })

## What only a human can do (Microsoft requires it)
* Each user signs in to the connection once, on first use of the agent.
* A Global Administrator grants admin consent if the installer could not (preflight said so).
* Licensing: users need access to Copilot Studio agents in this environment.
"@ | Set-Content (Join-Path $outDir 'agent-setup.md') -Encoding utf8
    @"
# Azure Platform Assistant - what you do now

You can now ask for Azure infrastructure in chat.

1. Open the agent **Azure Platform Assistant** (Teams or the link your admin sends) and sign in when asked - once.
2. Ask, for example: *"What can you build?"* or *"Plan a storage account called team-data in dev."*
3. Read the plan the assistant shows: what will be created, the risk and the estimated monthly cost.
4. Nothing is created from the chat alone. Ask the assistant to request approval; it gives you a link.
   - dev/test: open the link, sign in again, approve your own plan.
   - prod: send the link to an approver. A second person must approve.
5. Back in the chat say "apply". The assistant reports the names and addresses of what was built.

Approvers: $approval
You only see your own deployments. Temporary things: say "for 8 hours" and it removes itself.
Questions: your platform team.
"@ | Set-Content (Join-Path $outDir 'what-users-do-now.md') -Encoding utf8
    $summary.result = 'succeeded'; $summary.finishedAt = (Get-Date).ToString('s')
    $warn = @($script:Checks | Where-Object result -eq 'WARN')
    @"
# Install summary - Azure Terraform MCP $($summary.version)

| | |
|---|---|
| Result | **$($summary.result)** ($($summary.finishedAt)) |
| Subscription / prefix / region | $($script:Sub) / $prefixV / $($script:LocationValue) |
| Environments | $($script:Envs -join ', ') (apply: $($script:Apply), destroy: $($script:Destroy)) |
| MCP endpoint | $mcp (Copilot Studio sign-in mode: $($script:ConnAuth)) |
| Approval page | $approval |
| Groups | $(($groupNames.Values) -join '; ') |
| Power Platform | solution: $($ppResult.solution); connector: $($ppResult.connector); sharing: $($ppResult.sharing); agent: $($ppResult.agent) |
| Smoke test | $smoke |
| Preflight | $(@($script:Checks | Where-Object result -eq 'PASS').Count) passed, $($warn.Count) warnings |

## Still to do
$(if ($warn) { ($warn | ForEach-Object { "* $($_.name): $($_.fix)" }) -join "`n" } else { '* nothing from preflight' })
* Finish the agent: ``out/agent-setup.md``. Send users: ``out/what-users-do-now.md``.
* Put a Conditional Access policy (MFA, sign-in every time) on the app registration ``$prefixV-approval``.

Log: $transcript
"@ | Set-Content (Join-Path $outDir 'install-summary.md') -Encoding utf8
    $summary | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $outDir 'install-summary.json') -Encoding utf8
    Write-Host ''
    Write-Host ' INSTALLED ' -ForegroundColor Black -BackgroundColor Green
    Write-Host "   MCP endpoint  : $mcp"
    Write-Host "   Approval page : $approval"
    Write-Host "   Power Platform: connector $($ppResult.connector); agent $($ppResult.agent)"
    Write-Host "   Smoke test    : $smoke"
    Write-Host '   Next          : out/agent-setup.md (finish the agent), out/what-users-do-now.md (send to users)' -ForegroundColor Cyan
  }
  $script:State.status = 'succeeded'; Save-State
  $exitCode = if ($smoke -eq 'FAIL') { 3 } else { 0 }
}
catch {
  $summary.error = "$_"
  Write-Host ''
  Write-Host ' INSTALL STOPPED ' -ForegroundColor White -BackgroundColor Red
  Write-Host " $(("$_" -split "`n")[0])" -ForegroundColor Red
  Write-Host ' Fix the problem and run the installer again: finished steps are skipped.' -ForegroundColor Yellow
  Save-State
  $exitCode = 1
}
finally {
  Write-Progress -Activity 'Azure Terraform MCP installer' -Completed
  if ($summary.result -ne 'succeeded') { try { $summary | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $outDir 'install-summary.json') -Encoding utf8 } catch { } }
  try { Stop-Transcript | Out-Null } catch { }
  exit $exitCode      # inside finally on purpose: the early "return"s above must still set the exit code
}
