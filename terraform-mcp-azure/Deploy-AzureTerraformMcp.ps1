<#
.SYNOPSIS
  Zero-touch deploy of an Azure-native Terraform MCP server: the agent plans/applies/destroys Azure resources
  DIRECTLY (Terraform runs inside Azure Container Apps using a managed identity). No HCP Terraform needed.

.EXAMPLE
  ./Deploy-AzureTerraformMcp.ps1 -SubscriptionId <guid>                       # plan-only (safe default)
  ./Deploy-AzureTerraformMcp.ps1 -SubscriptionId <guid> -EnableApply          # allow create/update after a plan is confirmed
  ./Deploy-AzureTerraformMcp.ps1 -SubscriptionId <guid> -EnableApply -EnableDestroy
  ./Deploy-AzureTerraformMcp.ps1 -SubscriptionId <guid> -Destroy              # remove the MCP itself

.NOTES
  Guardrails: the managed identity has Contributor ONLY on the workload resource group (rg-<prefix>-workloads),
  only curated templates can be deployed, and apply needs a saved plan the user confirmed.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $SubscriptionId,
  [string] $Location = 'eastus2',
  [string] $Prefix = 'aztfmcp',
  [string] $AllowedLocations = 'eastus2',          # comma separated regions the agent may deploy to
  [switch] $EnableApply,
  [switch] $EnableDestroy,
  [string] $SecurityGroupId,
  [string[]] $AllowedCidrs,
  [switch] $Destroy
)
$ErrorActionPreference = 'Stop'
$rg = "rg-$Prefix"; $workRg = "rg-$Prefix-workloads"; $envName = "cae-$Prefix"; $app = "ca-$Prefix"; $law = "log-$Prefix"
$outDir = Join-Path $PSScriptRoot 'out'
$ApplyText = if ($EnableApply) { 'true' } else { 'false' }
$DestroyText = if ($EnableDestroy) { 'true' } else { 'false' }
$ops = $ApplyText
function Az { $out = & az @args 2>&1; if ($LASTEXITCODE -ne 0) { throw "az $($args -join ' ') failed:`n$out" }; $out }

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  if ($IsWindows -or $env:OS -eq 'Windows_NT') {
    winget install -e --id Microsoft.AzureCLI --accept-source-agreements --accept-package-agreements
    $env:Path += ";$env:ProgramFiles\Microsoft SDKs\Azure\CLI2\wbin"
  } else { throw 'Install Azure CLI first: https://aka.ms/installazurecli' }
}
az extension add --name containerapp --upgrade --only-show-errors | Out-Null
foreach ($ns in 'Microsoft.App','Microsoft.OperationalInsights','Microsoft.ContainerRegistry','Microsoft.Storage') { az provider register --namespace $ns | Out-Null }
if (-not (az account show 2>$null)) { az login | Out-Null }
Az account set --subscription $SubscriptionId | Out-Null
$tenantId = (Az account show --query tenantId -o tsv).Trim()

if ($Destroy) {
  Write-Host "Deleting $rg (MCP + state storage) and app registrations. Workload RG $workRg is NOT deleted." -ForegroundColor Yellow
  az group delete -n $rg --yes --no-wait
  foreach ($n in "$Prefix-api","$Prefix-connector") { $id = (az ad app list --display-name $n --query '[0].appId' -o tsv); if ($id) { az ad app delete --id $id } }
  return
}

Write-Host '1/6 Resource groups, state storage, registry' -ForegroundColor Cyan
Az group create -n $rg -l $Location | Out-Null
Az group create -n $workRg -l $Location | Out-Null
$sub6 = $SubscriptionId.Replace('-','').Substring(0,6)
$sa  = ("st$Prefix$sub6" -replace '[^a-z0-9]','').ToLower(); if ($sa.Length -gt 24) { $sa = $sa.Substring(0,24) }
$acr = ("acr$Prefix$sub6" -replace '[^a-z0-9]','').ToLower()
if (-not (az storage account show -g $rg -n $sa 2>$null)) {
  Az storage account create -g $rg -n $sa -l $Location --sku Standard_LRS --min-tls-version TLS1_2 --allow-blob-public-access false --allow-shared-key-access false | Out-Null
}
$saId = (Az storage account show -g $rg -n $sa --query id -o tsv).Trim()
$meUser = (Az ad signed-in-user show --query id -o tsv).Trim()
Az role assignment create --assignee-object-id $meUser --assignee-principal-type User --role 'Storage Blob Data Contributor' --scope $saId 2>$null | Out-Null
Start-Sleep 20
foreach ($c in 'tfstate','plans') { Az storage container create --account-name $sa --name $c --auth-mode login | Out-Null }
if (-not (az acr show -g $rg -n $acr 2>$null)) { Az acr create -g $rg -n $acr --sku Basic --admin-enabled false | Out-Null }

Write-Host '2/6 Building the server image in ACR (no local Docker needed)' -ForegroundColor Cyan
Az acr build -r $acr -g $rg -t azure-terraform-mcp:latest (Join-Path $PSScriptRoot 'server') | Out-Null

Write-Host '3/6 Container Apps environment + app with managed identity' -ForegroundColor Cyan
Az monitor log-analytics workspace create -g $rg -n $law -l $Location | Out-Null
$lawId  = (Az monitor log-analytics workspace show -g $rg -n $law --query customerId -o tsv).Trim()
$lawKey = (Az monitor log-analytics workspace get-shared-keys -g $rg -n $law --query primarySharedKey -o tsv).Trim()
if (-not (az containerapp env show -g $rg -n $envName 2>$null)) {
  Az containerapp env create -g $rg -n $envName -l $Location --logs-workspace-id $lawId --logs-workspace-key $lawKey | Out-Null
}
$envVars = @("SUBSCRIPTION_ID=$SubscriptionId","TENANT_ID=$tenantId","WORKLOAD_RG=$workRg","STATE_SA=$sa",
  "ALLOWED_LOCATIONS=$AllowedLocations","ENABLE_APPLY=$ApplyText","ENABLE_DESTROY=$DestroyText")
if (-not (az containerapp show -g $rg -n $app 2>$null)) {
  # max 1 replica: background Terraform runs and state locking are per-instance
  Az containerapp create -g $rg -n $app --environment $envName --image 'mcr.microsoft.com/k8se/quickstart:latest' `
    --target-port 8080 --ingress external --transport http --min-replicas 1 --max-replicas 1 --cpu 1 --memory 2Gi `
    --system-assigned --env-vars $envVars | Out-Null
}
$miPrincipal = (Az containerapp show -g $rg -n $app --query identity.principalId -o tsv).Trim()

Write-Host '4/6 Least-privilege role assignments for the managed identity' -ForegroundColor Cyan
$workScope = (Az group show -n $workRg --query id -o tsv).Trim()
$acrId = (Az acr show -g $rg -n $acr --query id -o tsv).Trim()
foreach ($r in @(@('AcrPull',$acrId), @('Storage Blob Data Contributor',$saId), @('Contributor',$workScope))) {
  Az role assignment create --assignee-object-id $miPrincipal --assignee-principal-type ServicePrincipal --role $r[0] --scope $r[1] 2>$null | Out-Null
}
for ($i=0; $i -lt 8; $i++) {   # RBAC propagation
  try {
    Az containerapp registry set -g $rg -n $app --server "$acr.azurecr.io" --identity system | Out-Null
    Az containerapp update -g $rg -n $app --image "$acr.azurecr.io/azure-terraform-mcp:latest" --set-env-vars $envVars --cpu 1 --memory 2Gi | Out-Null
    break
  } catch { if ($i -eq 7) { throw }; Start-Sleep 30 }
}
$fqdn = (Az containerapp show -g $rg -n $app --query properties.configuration.ingress.fqdn -o tsv).Trim()

# --- Entra ID ----------------------------------------------------------------
Write-Host '5/6 Entra app registrations (API + connector client)' -ForegroundColor Cyan
$apiName = "$Prefix-api"; $cliName = "$Prefix-connector"
$apiId = (az ad app list --display-name $apiName --query '[0].appId' -o tsv)
if (-not $apiId) { $apiId = (Az ad app create --display-name $apiName --sign-in-audience AzureADMyOrg --query appId -o tsv).Trim() }
$apiObj = (Az ad app show --id $apiId --query id -o tsv).Trim()
$scopeId = [guid]::NewGuid().ToString()
$existingScope = (az ad app show --id $apiId --query "api.oauth2PermissionScopes[?value=='access_as_user'].id | [0]" -o tsv)
if ($existingScope) { $scopeId = $existingScope.Trim() }
$apiBody = @{ identifierUris = @("api://$apiId"); api = @{
  requestedAccessTokenVersion = 2
  preAuthorizedApplications = @(@{ appId='04b07795-8ddb-461a-bbee-02f9e1bf7b46'; delegatedPermissionIds=@($scopeId) })  # Azure CLI, for the smoke test
  oauth2PermissionScopes = @(@{ id=$scopeId; value='access_as_user'; type='User'; isEnabled=$true
    adminConsentDisplayName='Use Terraform MCP'; adminConsentDescription='Call the Terraform MCP server as the signed-in user'
    userConsentDisplayName='Use Terraform MCP'; userConsentDescription='Call the Terraform MCP server on your behalf' }) } } | ConvertTo-Json -Depth 6 -Compress
$tmp = New-TemporaryFile; Set-Content $tmp $apiBody
Az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$apiObj" --headers 'Content-Type=application/json' --body "@$tmp" | Out-Null
Remove-Item $tmp
if (-not (az ad sp show --id $apiId 2>$null)) { Az ad sp create --id $apiId | Out-Null }

$cliId = (az ad app list --display-name $cliName --query '[0].appId' -o tsv)
if (-not $cliId) { $cliId = (Az ad app create --display-name $cliName --sign-in-audience AzureADMyOrg `
    --web-redirect-uris 'https://global.consent.azure-apim.net/redirect' --query appId -o tsv).Trim() }
$cliSecret = (Az ad app credential reset --id $cliId --display-name 'copilot-studio' --years 1 --query password -o tsv).Trim()
if (-not (az ad sp show --id $cliId 2>$null)) { Az ad sp create --id $cliId | Out-Null }
Az ad app permission add --id $cliId --api $apiId --api-permissions "$scopeId=Scope" | Out-Null
try { Az ad app permission grant --id $cliId --api $apiId --scope access_as_user | Out-Null }
catch { Write-Warning 'Admin consent not granted automatically; ask a Global Admin to grant it in Entra.' }

Write-Host '6/6 Container Apps authentication (reject anonymous calls)' -ForegroundColor Cyan
Az containerapp auth microsoft update -g $rg -n $app --client-id $apiId `
  --tenant-id $tenantId --allowed-audiences "api://$apiId" --client-secret $cliSecret --yes | Out-Null
Az containerapp auth update -g $rg -n $app --enabled true --unauthenticated-client-action Return401 --yes | Out-Null

# --- optional hardening: group-only access + IP allow-list -------------------
if ($SecurityGroupId) {
  Write-Host 'Restricting access to the Entra group (requires Entra ID P1)' -ForegroundColor Cyan
  $apiSp = (Az ad sp show --id $apiId --query id -o tsv).Trim()
  Az ad sp update --id $apiSp --set appRoleAssignmentRequired=true | Out-Null
  $b = @{ principalId=$SecurityGroupId; resourceId=$apiSp; appRoleId='00000000-0000-0000-0000-000000000000' } | ConvertTo-Json -Compress
  $t = New-TemporaryFile; Set-Content $t $b
  try { Az rest --method POST --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$apiSp/appRoleAssignedTo" --headers 'Content-Type=application/json' --body "@$t" | Out-Null }
  catch { Write-Warning "Group assignment skipped (maybe already assigned): $_" }
  Remove-Item $t
}
if ($AllowedCidrs) {
  $i = 0
  foreach ($c in $AllowedCidrs) { $i++; Az containerapp ingress access-restriction set -g $rg -n $app --rule-name "allow$i" --ip-address $c --action Allow | Out-Null }
}

# --- Copilot Studio connector files -----------------------------------------
Write-Host 'Generating Copilot Studio custom connector files' -ForegroundColor Cyan
New-Item -ItemType Directory -Force $outDir | Out-Null
$swagger = [ordered]@{
  swagger='2.0'
  info=[ordered]@{ title='Azure Terraform MCP'; description='Azure Terraform MCP server (runs Terraform with a managed identity)'; version='1.0' }
  host=$fqdn; basePath='/'; schemes=@('https')
  paths=[ordered]@{ '/mcp'=[ordered]@{ post=[ordered]@{
    summary='Azure Terraform MCP'; operationId='InvokeServer'
    'x-ms-agentic-protocol'='mcp-streamable-1.0'
    parameters=@(); responses=@{ default=@{ description='default' } } } } }
  securityDefinitions=[ordered]@{ oauth2_auth=[ordered]@{
    type='oauth2'; flow='accessCode'
    authorizationUrl="https://login.microsoftonline.com/$tenantId/oauth2/v2.0/authorize"
    tokenUrl="https://login.microsoftonline.com/$tenantId/oauth2/v2.0/token"
    scopes=@{ "api://$apiId/access_as_user"='Use Terraform MCP' } } }
  security=@(@{ oauth2_auth=@("api://$apiId/access_as_user") })
}
$swagger | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $outDir 'terraform-mcp.swagger.json')
$props = [ordered]@{ properties=[ordered]@{
  connectionParameters=@{ token=[ordered]@{ type='oauthSetting'; oAuthSettings=[ordered]@{
    identityProvider='oauth2'; clientId=$cliId; scopes=@("api://$apiId/access_as_user")
    redirectMode='Global'; redirectUrl='https://global.consent.azure-apim.net/redirect'
    properties=@{ IsFirstParty='False'; IsOnbehalfofLoginSupported='False' }
    customParameters=@{ authorizationUrl=@{ value="https://login.microsoftonline.com/$tenantId/oauth2/v2.0/authorize" }
      tokenUrl=@{ value="https://login.microsoftonline.com/$tenantId/oauth2/v2.0/token" }
      refreshUrl=@{ value="https://login.microsoftonline.com/$tenantId/oauth2/v2.0/token" } } } } }
  iconBrandColor='#7B42BC'; capabilities=@(); publisher='Platform Engineering' } }
$props | ConvertTo-Json -Depth 12 | Set-Content (Join-Path $outDir 'apiProperties.json')
# client secret goes to a git-ignored file, never the swagger
Set-Content (Join-Path $outDir 'connector-client-secret.txt') $cliSecret

# Paste-ready values for the Copilot Studio MCP wizard (OAuth 2.0 > Manual).
# Entra ID has no dynamic client registration, so "Dynamic discovery" cannot self-register here;
# the app is pre-created and pre-consented instead, so makers only paste these values once.
$authUrl  = "https://login.microsoftonline.com/$tenantId/oauth2/v2.0/authorize"
$tokenUrl = "https://login.microsoftonline.com/$tenantId/oauth2/v2.0/token"
@"
# Copilot Studio - add Terraform MCP (copy/paste)

Agent > Tools > Add a tool > New tool > Model Context Protocol

| Field | Value |
|---|---|
| Server name | Terraform MCP |
| Server description | Manage Terraform registry lookups and HCP Terraform workspaces/runs |
| Server URL | https://$fqdn/mcp |
| Authentication | OAuth 2.0 > Manual |
| Client ID | $cliId |
| Client secret | (out/connector-client-secret.txt) |
| Authorization URL | $authUrl |
| Token URL template | $tokenUrl |
| Refresh URL | $tokenUrl |
| Scopes | api://$apiId/access_as_user offline_access |

Then Create > copy the Redirect URL shown. If it is not
https://global.consent.azure-apim.net/redirect, add it to app $cliName in Entra
(Authentication > Web > Redirect URIs). Then Create new connection > sign in > Add to agent.
Admin consent is already granted, so users get no consent prompt.
"@ | Set-Content (Join-Path $outDir 'copilot-studio-wizard-values.md')

if (Get-Command pac -ErrorAction SilentlyContinue) {
  Write-Host 'pac found: creating the connector (select your Power Platform environment first with `pac auth`)' -ForegroundColor Cyan
  pac connector create --api-definition-file (Join-Path $outDir 'terraform-mcp.swagger.json') `
                       --api-properties-file (Join-Path $outDir 'apiProperties.json')
}

@"

================ DONE ================
MCP endpoint      : https://$fqdn/mcp
Entra API app     : $apiId   (scope api://$apiId/access_as_user)
Connector client  : $cliId   (secret saved to out/connector-client-secret.txt)
Group-restricted: $([bool]$SecurityGroupId)   IP allow-list: $([bool]$AllowedCidrs)
Smoke test        : ./Test-TerraformMcp.ps1 -SubscriptionId $SubscriptionId -Prefix $Prefix
Apply enabled: $ApplyText   Destroy enabled: $DestroyText   Workload RG: $workRg (the ONLY place it can deploy)

Next, in Copilot Studio (easiest path, ~1 minute):
  open out/copilot-studio-wizard-values.md and paste its values into
  Agent > Tools > Add a tool > New tool > Model Context Protocol.
  Alternative: pick "Azure Terraform MCP" if pac created the connector, or import out/terraform-mcp.swagger.json + out/apiProperties.json as a custom connector,
   paste the client secret on the Security tab, then create the connection).
Test:  curl -i https://$fqdn/mcp   -> must return 401 (anonymous calls blocked)
"@ | Write-Host
