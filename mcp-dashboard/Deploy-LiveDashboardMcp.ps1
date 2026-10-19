<#
.SYNOPSIS
  Zero-touch deploy of the Live Dashboard MCP server to Azure Container Apps, plus a Copilot Studio custom connector.

.DESCRIPTION
  One command does everything:
    1. installs/validates Azure CLI (+ containerapp extension) and signs you in
    2. creates resource group, container registry, storage (for dashboards + datasources.json), Container Apps environment
    3. builds the image IN AZURE (no local Docker needed) and deploys it: 1 replica, HTTPS, secrets in the platform secret store
    4. generates the server key (API key) and checks the live server end to end
    5. (optional) creates a Power Platform custom connector from the generated swagger so the server shows up
       as a tool in Copilot Studio (needs the Power Platform CLI; skipped when -EnvironmentId is empty / -SkipConnector)
  No Azure app registration is created or needed.
  Re-running is safe: it updates the same resources and keeps the same server key.

.PARAMETER Name              Base name of the app (default live-dashboard-mcp)
.PARAMETER ResourceGroup     Default rg-<Name>
.PARAMETER Location          Azure region (default eastus)
.PARAMETER Subscription      Subscription name or id (default: your current one)
.PARAMETER EnvironmentId     Power Platform environment GUID for the Copilot Studio connector. Prompted if omitted; leave blank to skip.
.PARAMETER ApiKey            Server key. Generated if omitted (reused on re-runs).
.PARAMETER AnthropicApiKey   Optional. Only needed for the generate_dashboard tool; the agent's own Claude model does not need it.
.PARAMETER DataSourcesFile   Optional datasources.json (see datasources.example.json). Uploaded to the persistent share.
.PARAMETER Secrets           Optional hashtable of env vars referenced as "env:NAME" in datasources.json, e.g. @{ ERP_USER='ro_user'; ERP_PASSWORD='...' }
.PARAMETER AlertWebhookUrl   Optional URL (Power Automate / Teams workflow) that receives KPI threshold alerts.
.PARAMETER SkipConnector     Do not create the Copilot Studio custom connector.
.PARAMETER SkipPrereqInstall Do not try to install Azure CLI / Power Platform CLI.
.PARAMETER Remove            Delete everything this script created (the resource group) after confirmation.

.EXAMPLE
  ./Deploy-LiveDashboardMcp.ps1
.EXAMPLE
  ./Deploy-LiveDashboardMcp.ps1 -EnvironmentId 00000000-0000-0000-0000-000000000000 -DataSourcesFile ./datasources.json -Secrets @{ ERP_USER='ro'; ERP_PASSWORD='***' }
#>
[CmdletBinding()]
param(
  [string]$Name = 'live-dashboard-mcp',
  [string]$ResourceGroup,
  [string]$Location = 'eastus',
  [string]$Subscription,
  [string]$EnvironmentId,
  [string]$ApiKey,
  [string]$AnthropicApiKey,
  [string]$DataSourcesFile,
  [hashtable]$Secrets = @{},
  [string]$AlertWebhookUrl,
  [switch]$SkipConnector,
  [switch]$SkipPrereqInstall,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$app = $PSScriptRoot
Set-Location $app
if (-not $ResourceGroup) { $ResourceGroup = "rg-$Name" }
$env:PYTHONIOENCODING = 'utf-8'   # az acr build log streaming crashes on Windows code pages without this

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }
function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }

# Runs az, returns stdout lines, throws with az's own error text on failure.
function Invoke-AzCli {
  $errFile = [System.IO.Path]::GetTempFileName()
  try {
    $out = & az @args 2> $errFile
    if ($LASTEXITCODE -ne 0) { throw "az $($args -join ' ') failed:`n$([System.IO.File]::ReadAllText($errFile))" }
    return $out
  } finally { Remove-Item $errFile -ErrorAction SilentlyContinue }
}
function Test-AzResource { try { Invoke-AzCli @args | Out-Null; return $true } catch { return $false } }

# Stable, globally-unique-ish suffix so re-runs hit the same registry / storage account.
function Short-Hash($s) { $h = [System.Security.Cryptography.MD5]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($s)); return (-join ($h[0..3] | ForEach-Object { $_.ToString('x2') })) }

# ---------- 1. prerequisites ----------
Step 'Checking prerequisites'
if (-not (Have 'az')) {
  if ($SkipPrereqInstall) { throw 'Azure CLI is required: https://aka.ms/installazurecliwindows' }
  if (Have 'winget') { Warn 'Installing Azure CLI via winget...'; winget install -e --id Microsoft.AzureCLI --accept-source-agreements --accept-package-agreements; Refresh-Path }
  else { throw 'Azure CLI not found and winget unavailable. Install Azure CLI and re-run.' }
}
if (-not (Have 'az')) { throw 'Azure CLI was installed but is not on PATH yet. Open a NEW PowerShell window and re-run.' }
Ok 'Azure CLI present'
Invoke-AzCli config set extension.use_dynamic_install=yes_without_prompt extension.dynamic_install_allow_preview=true | Out-Null
Invoke-AzCli extension add --name containerapp --upgrade --yes | Out-Null
Ok 'containerapp extension ready'

# ---------- 2. sign in ----------
Step 'Signing in to Azure'
$acct = $null
try { $acct = (Invoke-AzCli account show -o json | Out-String | ConvertFrom-Json) } catch { }
if (-not $acct) { & az login | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'az login failed' } }
if ($Subscription) { Invoke-AzCli account set --subscription $Subscription | Out-Null }
$acct = (Invoke-AzCli account show -o json | Out-String | ConvertFrom-Json)
$subId = $acct.id
Ok "Subscription: $($acct.name) ($subId)"

if ($Remove) {
  $ans = Read-Host "Delete resource group '$ResourceGroup' and EVERYTHING in it? Type the group name to confirm"
  if ($ans -ne $ResourceGroup) { throw 'Cancelled.' }
  Invoke-AzCli group delete --name $ResourceGroup --yes --no-wait | Out-Null
  Ok 'Deletion started (runs in the background). The Copilot Studio connector, if created, must be deleted in Power Apps.'
  return
}

if ($DataSourcesFile -and -not (Test-Path $DataSourcesFile)) { throw "DataSourcesFile not found: $DataSourcesFile" }

Step 'Registering Azure resource providers (first run only, can take a few minutes)'
foreach ($p in 'Microsoft.App','Microsoft.OperationalInsights','Microsoft.ContainerRegistry','Microsoft.Storage') {
  $state = (Invoke-AzCli provider show --namespace $p --query registrationState -o tsv | Out-String).Trim()
  if ($state -ne 'Registered') { Warn "Registering $p..."; Invoke-AzCli provider register --namespace $p --wait | Out-Null }
}
Ok 'Providers registered'

# ---------- 3. names ----------
$suffix   = Short-Hash "$subId/$Name"
$safe     = ($Name -replace '[^a-zA-Z0-9]', '').ToLower()
if ($safe.Length -gt 12) { $safe = $safe.Substring(0, 12) }
$acrName  = "acr$safe$suffix"            # 5-50 alphanumeric, globally unique
$saName   = "st$safe$suffix"             # 3-24 lowercase alphanumeric, globally unique
if ($saName.Length -gt 24) { $saName = $saName.Substring(0, 24) }
$envName  = "cae-$Name"
$shareName = 'dashdata'

# ---------- 4. resource group, registry, build ----------
Step "Creating resource group $ResourceGroup ($Location)"
Invoke-AzCli group create --name $ResourceGroup --location $Location | Out-Null
Ok 'Resource group ready'

Step "Creating container registry $acrName"
if (-not (Test-AzResource acr show --name $acrName --resource-group $ResourceGroup)) {
  Invoke-AzCli acr create --name $acrName --resource-group $ResourceGroup --location $Location --sku Basic --admin-enabled true | Out-Null
}
$acrServer = (Invoke-AzCli acr show --name $acrName --resource-group $ResourceGroup --query loginServer -o tsv | Out-String).Trim()
$acrUser   = (Invoke-AzCli acr credential show --name $acrName --resource-group $ResourceGroup --query username -o tsv | Out-String).Trim()
$acrPass   = (Invoke-AzCli acr credential show --name $acrName --resource-group $ResourceGroup --query 'passwords[0].value' -o tsv | Out-String).Trim()
Ok $acrServer

Step 'Building the image in Azure (no local Docker needed; ~1-2 minutes)'
$tag = Get-Date -Format 'yyyyMMddHHmmss'
$image = "$acrServer/${Name}:$tag"
& az acr build --registry $acrName --resource-group $ResourceGroup --image "${Name}:$tag" --file Dockerfile $app
if ($LASTEXITCODE -ne 0) { throw 'Image build failed (see output above).' }
Ok $image

# ---------- 5. storage for dashboards + datasources ----------
Step "Creating persistent storage $saName"
if (-not (Test-AzResource storage account show --name $saName --resource-group $ResourceGroup)) {
  Invoke-AzCli storage account create --name $saName --resource-group $ResourceGroup --location $Location --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 --allow-blob-public-access false | Out-Null
}
$saKey = (Invoke-AzCli storage account keys list --account-name $saName --resource-group $ResourceGroup --query '[0].value' -o tsv | Out-String).Trim()
if (-not (Test-AzResource storage share-rm show --storage-account $saName --resource-group $ResourceGroup --name $shareName)) {
  Invoke-AzCli storage share-rm create --storage-account $saName --resource-group $ResourceGroup --name $shareName --quota 5 | Out-Null
}
if ($DataSourcesFile) {
  Invoke-AzCli storage file upload --account-name $saName --account-key $saKey --share-name $shareName --source (Resolve-Path $DataSourcesFile).Path --path 'datasources.json' | Out-Null
  Ok 'Uploaded datasources.json'
}
Ok 'Storage ready'

# ---------- 6. container apps environment ----------
Step "Creating Container Apps environment $envName"
if (-not (Test-AzResource containerapp env show --name $envName --resource-group $ResourceGroup)) {
  Invoke-AzCli containerapp env create --name $envName --resource-group $ResourceGroup --location $Location | Out-Null
}
Invoke-AzCli containerapp env storage set --name $envName --resource-group $ResourceGroup --storage-name $shareName --azure-file-account-name $saName --azure-file-account-key $saKey --azure-file-share-name $shareName --access-mode ReadWrite | Out-Null
$envId   = (Invoke-AzCli containerapp env show --name $envName --resource-group $ResourceGroup --query id -o tsv | Out-String).Trim()
$domain  = (Invoke-AzCli containerapp env show --name $envName --resource-group $ResourceGroup --query properties.defaultDomain -o tsv | Out-String).Trim()
$publicUrl = "https://$Name.$domain"
Ok "Public URL will be $publicUrl"

# ---------- 7. server key ----------
$appExists = Test-AzResource containerapp show --name $Name --resource-group $ResourceGroup
if (-not $ApiKey -and $appExists) {
  try { $ApiKey = (Invoke-AzCli containerapp secret show --name $Name --resource-group $ResourceGroup --secret-name api-key --query value -o tsv | Out-String).Trim() } catch { }
}
if (-not $ApiKey) {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($bytes)
  $ApiKey = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
  Ok 'Generated a new server key'
} else { Ok 'Using existing/provided server key' }

# ---------- 8. deploy the app ----------
Step 'Deploying the container app'
$secretList = New-Object System.Collections.ArrayList
$envList    = New-Object System.Collections.ArrayList
function Add-Secret($secretName, $value) { [void]$secretList.Add(@{ name = $secretName; value = $value }) }
function Add-EnvPlain($n, $v)  { [void]$envList.Add(@{ name = $n; value = $v }) }
function Add-EnvSecret($n, $s) { [void]$envList.Add(@{ name = $n; secretRef = $s }) }

Add-Secret 'acr-pwd' $acrPass
Add-Secret 'api-key' $ApiKey
Add-EnvPlain 'PORT' '3000'
Add-EnvPlain 'PUBLIC_URL' $publicUrl
Add-EnvPlain 'DATA_FILE' '/data/dashboards.json'
Add-EnvPlain 'DATASOURCES_FILE' '/data/datasources.json'
Add-EnvSecret 'API_KEY' 'api-key'
if ($AnthropicApiKey) { Add-Secret 'anthropic-key' $AnthropicApiKey; Add-EnvSecret 'ANTHROPIC_API_KEY' 'anthropic-key' }
if ($AlertWebhookUrl) { Add-Secret 'alert-webhook' $AlertWebhookUrl; Add-EnvSecret 'ALERT_WEBHOOK_URL' 'alert-webhook' }
foreach ($k in $Secrets.Keys) {
  $sn = ('s-' + ($k.ToString().ToLower() -replace '[^a-z0-9]', '-'))
  Add-Secret $sn ([string]$Secrets[$k]); Add-EnvSecret $k.ToString() $sn
}

$spec = @{
  location = $Location
  properties = @{
    environmentId = $envId
    configuration = @{
      ingress = @{ external = $true; targetPort = 3000; transport = 'auto'; allowInsecure = $false }
      registries = @(@{ server = $acrServer; username = $acrUser; passwordSecretRef = 'acr-pwd' })
      secrets = @($secretList)
    }
    template = @{
      containers = @(@{
        name = $Name; image = $image
        resources = @{ cpu = 0.5; memory = '1Gi' }
        env = @($envList)
        volumeMounts = @(@{ volumeName = 'data'; mountPath = '/data' })
        probes = @(@{ type = 'Liveness'; httpGet = @{ path = '/healthz'; port = 3000 }; initialDelaySeconds = 10; periodSeconds = 30 })
      })
      # One replica only: dashboards live in one file and the live page holds long-lived connections.
      scale = @{ minReplicas = 1; maxReplicas = 1 }
      volumes = @(@{ name = 'data'; storageType = 'AzureFile'; storageName = $shareName })
    }
  }
}
$specFile = Join-Path ([System.IO.Path]::GetTempPath()) "$Name-containerapp.json"
[System.IO.File]::WriteAllText($specFile, ($spec | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
try {
  if ($appExists) { Invoke-AzCli containerapp update --name $Name --resource-group $ResourceGroup --yaml $specFile | Out-Null }
  else            { Invoke-AzCli containerapp create --name $Name --resource-group $ResourceGroup --yaml $specFile | Out-Null }
} finally { Remove-Item $specFile -ErrorAction SilentlyContinue }   # contains secrets
$fqdn = (Invoke-AzCli containerapp show --name $Name --resource-group $ResourceGroup --query properties.configuration.ingress.fqdn -o tsv | Out-String).Trim()
if ($fqdn -and ("https://$fqdn" -ne $publicUrl)) { Warn "Azure assigned $fqdn; updating PUBLIC_URL"; $publicUrl = "https://$fqdn"; Invoke-AzCli containerapp update --name $Name --resource-group $ResourceGroup --set-env-vars "PUBLIC_URL=$publicUrl" | Out-Null }
Ok 'Container app deployed'

# ---------- 9. verify end to end ----------
Step 'Waiting for the server to answer'
$healthy = $false
for ($i = 0; $i -lt 36 -and -not $healthy; $i++) {
  try { $r = Invoke-WebRequest -Uri "$publicUrl/healthz" -UseBasicParsing -TimeoutSec 10; if ($r.StatusCode -eq 200) { $healthy = $true } } catch { Start-Sleep -Seconds 5 }
}
if (-not $healthy) { throw "The server did not become healthy. Check logs:  az containerapp logs show -n $Name -g $ResourceGroup --tail 100" }
Ok 'Health check passed'

$body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
$hdr = @{ 'x-api-key' = $ApiKey; 'Accept' = 'application/json, text/event-stream' }
try { Invoke-WebRequest -Uri "$publicUrl/mcp" -Method Post -Body $body -ContentType 'application/json' -UseBasicParsing -TimeoutSec 15 | Out-Null; Warn 'WARNING: /mcp answered without a key. Check API_KEY.' }
catch { Ok 'Unauthenticated requests are rejected (401)' }
$tools = Invoke-RestMethod -Uri "$publicUrl/mcp" -Method Post -Body $body -ContentType 'application/json' -Headers $hdr -TimeoutSec 15
Ok "MCP answers with a key: $(@($tools.result.tools).Count) tools available"

# ---------- 10. Copilot Studio connector ----------
$connectorDone = $false
if (-not $SkipConnector) {
  Step 'Creating the Copilot Studio custom connector'
  if (-not $EnvironmentId) {
    Write-Host '    Power Platform environment GUID (the part after /environments/ in the maker portal URL).'
    $EnvironmentId = (Read-Host '    Enter it to create the connector now, or press Enter to skip').Trim()
  }
  if ($EnvironmentId) {
    try {
      if ($EnvironmentId -notmatch '^[0-9a-fA-F-]{36}$') { throw "'$EnvironmentId' is not a valid environment GUID." }
      if (-not (Have 'pac')) {
        if ($SkipPrereqInstall) { throw 'Power Platform CLI (pac) not found.' }
        if (Have 'dotnet') { Warn 'Installing Power Platform CLI via dotnet tool...'; dotnet tool install --global Microsoft.PowerApps.CLI.Tool | Out-Null; $env:Path += ";$HOME\.dotnet\tools" }
        elseif (Have 'winget') { Warn 'Installing Power Platform CLI via winget...'; winget install -e --id Microsoft.PowerAppsCLI --accept-source-agreements --accept-package-agreements; Refresh-Path }
      }
      if (-not (Have 'pac')) { throw 'pac is not available on PATH yet (open a NEW PowerShell window and re-run with -EnvironmentId).' }
      $who = (& pac auth who 2>&1) | Out-String
      if ($who -notmatch 'Tenant|User') { & pac auth create; if ($LASTEXITCODE -ne 0) { throw 'pac auth create failed' } }
      $outDir = Join-Path $app 'deploy-output'; New-Item -ItemType Directory -Force -Path $outDir | Out-Null
      $swagger = Join-Path $outDir 'connector.swagger.json'; $props = Join-Path $outDir 'connector.properties.json'
      Invoke-WebRequest -Uri "$publicUrl/copilot-studio/connector.swagger.json" -OutFile $swagger -UseBasicParsing
      Invoke-WebRequest -Uri "$publicUrl/copilot-studio/connector.properties.json" -OutFile $props -UseBasicParsing
      $existing = (& pac connector list --environment $EnvironmentId 2>&1) | Out-String
      if ($existing -match 'Live Dashboard MCP') { Ok 'A "Live Dashboard MCP" connector already exists in that environment; leaving it as is.'; $connectorDone = $true }
      else {
        & pac connector create --environment $EnvironmentId --api-definition-file $swagger --api-properties-file $props
        if ($LASTEXITCODE -ne 0) { throw 'pac connector create failed' }
        Ok 'Custom connector created'; $connectorDone = $true
      }
    } catch {
      Warn "Could not create the connector automatically: $($_.Exception.Message)"
      Warn "Manual route (2 minutes): Power Apps > Custom connectors > New > Import an OpenAPI file, choose deploy-output\connector.swagger.json, or add the MCP URL directly in Copilot Studio (see below)."
    }
  } else { Warn 'Skipped (no environment id).' }
}

# ---------- 11. summary ----------
$summary = @"

=====================================================================
 Live Dashboard MCP is live
=====================================================================
 Setup page : $publicUrl/
 MCP URL    : $publicUrl/mcp
 Server key : $ApiKey      (keep it secret: it is the API key and the sign-in key)
 Dashboards : $publicUrl/dashboards?key=<server key>

 Add to a Copilot Studio agent (pick one):
   A) Tools > Add a tool > New tool > Model Context Protocol
        URL = $publicUrl/mcp  |  Authentication = OAuth 2.0 > Dynamic discovery
        When the sign-in page opens, enter the server key.
   B) Same wizard with Authentication = API key, Header, name x-api-key, value = server key.
   C) $(if ($connectorDone) { 'Tools > Add a tool > pick the "Live Dashboard MCP" connector (already created); create the connection with the server key.' } else { 'Custom connector: import deploy-output\connector.swagger.json (or re-run this script with -EnvironmentId).' })

 Then set the agent's model to Claude and paste the agent instructions from:
   $publicUrl/copilot-studio/agent-instructions.md

 Logs   : az containerapp logs show -n $Name -g $ResourceGroup --follow
 Remove : ./Deploy-LiveDashboardMcp.ps1 -Name $Name -ResourceGroup $ResourceGroup -Remove
=====================================================================
"@
Write-Host $summary -ForegroundColor Green
$outDir = Join-Path $app 'deploy-output'; New-Item -ItemType Directory -Force -Path $outDir | Out-Null
[System.IO.File]::WriteAllText((Join-Path $outDir "$Name-summary.txt"), $summary, (New-Object System.Text.UTF8Encoding($false)))
Warn "Summary (including the server key) saved to deploy-output\$Name-summary.txt. It is git-ignored; store it somewhere safe."
