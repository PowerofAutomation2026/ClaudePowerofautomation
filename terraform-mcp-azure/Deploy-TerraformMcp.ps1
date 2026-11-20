<#
.SYNOPSIS
  Zero-touch deploy of HashiCorp's Terraform MCP server to Azure Container Apps,
  protected by Entra ID, plus the custom-connector files Copilot Studio needs.

.EXAMPLE
  $env:TFE_TOKEN = '<HCP Terraform team token>'
  ./Deploy-TerraformMcp.ps1 -SubscriptionId <guid>
  ./Deploy-TerraformMcp.ps1 -SubscriptionId <guid> -EnableOperations   # allow plan/apply/destroy via HCP Terraform runs
  ./Deploy-TerraformMcp.ps1 -SubscriptionId <guid> -Destroy            # tear everything down

.NOTES
  Needs: Azure CLI (installed automatically via winget if missing on Windows), rights to create
  an Entra app registration and to create resources in the subscription.
  Safe by default: apply/destroy tools are OFF unless -EnableOperations is passed.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $SubscriptionId,
  [string] $Location = 'eastus2',
  [string] $Prefix = 'tfmcp',
  [string] $Image = 'hashicorp/terraform-mcp-server:latest',   # pin a version tag for production
  [string] $TfeAddress = 'https://app.terraform.io',
  [SecureString] $TfeToken,                                     # or set $env:TFE_TOKEN
  [switch] $EnableOperations,
  [switch] $UseKeyVault,                 # keep the HCP token in Key Vault (managed identity), not in the app
  [string] $SecurityGroupId,             # Entra group object id: only members may call the MCP server
  [string[]] $AllowedCidrs,              # optional ingress IP allow-list, e.g. 203.0.113.0/24
  [switch] $Destroy
)
$ErrorActionPreference = 'Stop'
$rg      = "rg-$Prefix"
$envName = "cae-$Prefix"
$app     = "ca-$Prefix"
$law     = "log-$Prefix"
$outDir  = Join-Path $PSScriptRoot 'out'

function Az { # run az, fail on non-zero, return stdout
  $out = & az @args 2>&1
  if ($LASTEXITCODE -ne 0) { throw "az $($args -join ' ') failed:`n$out" }
  $out
}

# --- prerequisites -----------------------------------------------------------
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  if ($IsWindows -or $env:OS -eq 'Windows_NT') {
    winget install -e --id Microsoft.AzureCLI --accept-source-agreements --accept-package-agreements
    $env:Path += ";$env:ProgramFiles\Microsoft SDKs\Azure\CLI2\wbin"
  } else { throw 'Install Azure CLI first: https://aka.ms/installazurecli' }
}
az extension add --name containerapp --upgrade --only-show-errors | Out-Null
az provider register --namespace Microsoft.App --wait | Out-Null
az provider register --namespace Microsoft.OperationalInsights | Out-Null

if (-not (az account show 2>$null)) { az login | Out-Null }
Az account set --subscription $SubscriptionId | Out-Null
$tenantId = (Az account show --query tenantId -o tsv).Trim()

# --- teardown ----------------------------------------------------------------
if ($Destroy) {
  Write-Host "Deleting resource group $rg and app registrations..." -ForegroundColor Yellow
  az group delete -n $rg --yes --no-wait
  foreach ($n in "$Prefix-api","$Prefix-connector") {
    $id = (az ad app list --display-name $n --query '[0].appId' -o tsv)
    if ($id) { az ad app delete --id $id }
  }
  return
}

# --- secrets -----------------------------------------------------------------
if (-not $TfeToken) {
  if ($env:TFE_TOKEN) { $TfeToken = ConvertTo-SecureString $env:TFE_TOKEN -AsPlainText -Force }
  else { $TfeToken = Read-Host 'HCP Terraform team API token' -AsSecureString }
}
$tfePlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($TfeToken))

# --- Azure hosting -----------------------------------------------------------
Write-Host '1/5 Resource group + Container Apps environment' -ForegroundColor Cyan
Az group create -n $rg -l $Location | Out-Null
Az monitor log-analytics workspace create -g $rg -n $law -l $Location | Out-Null
$lawId  = (Az monitor log-analytics workspace show -g $rg -n $law --query customerId -o tsv).Trim()
$lawKey = (Az monitor log-analytics workspace get-shared-keys -g $rg -n $law --query primarySharedKey -o tsv).Trim()
$envExists = az containerapp env show -g $rg -n $envName 2>$null
if (-not $envExists) {
  Az containerapp env create -g $rg -n $envName -l $Location --logs-workspace-id $lawId --logs-workspace-key $lawKey | Out-Null
}

Write-Host '2/5 Terraform MCP server container' -ForegroundColor Cyan
$ops = if ($EnableOperations) { 'true' } else { 'false' }
$envVars = @(
  'TRANSPORT_MODE=streamable-http', 'TRANSPORT_HOST=0.0.0.0', 'TRANSPORT_PORT=8080',
  'MCP_ENDPOINT=/mcp', "TFE_ADDRESS=$TfeAddress", 'TFE_TOKEN=secretref:tfe-token',
  "ENABLE_TF_OPERATIONS=$ops",
  'MCP_CORS_MODE=disabled'          # server-to-server only; Copilot Studio is not a browser
)
$appExists = az containerapp show -g $rg -n $app 2>$null
if (-not $appExists) {
  Az containerapp create -g $rg -n $app --environment $envName --image $Image `
    --target-port 8080 --ingress external --transport http `
    --min-replicas 1 --max-replicas 5 --cpu 0.5 --memory 1Gi `
    --scale-rule-name http --scale-rule-type http --scale-rule-http-concurrency 20 `
    --secrets "tfe-token=$tfePlain" --env-vars $envVars | Out-Null
} else {
  Az containerapp secret set -g $rg -n $app --secrets "tfe-token=$tfePlain" | Out-Null
  Az containerapp update -g $rg -n $app --image $Image --set-env-vars $envVars | Out-Null
}
$fqdn = (Az containerapp show -g $rg -n $app --query properties.configuration.ingress.fqdn -o tsv).Trim()

# --- optional: Key Vault for the HCP Terraform token -------------------------
if ($UseKeyVault) {
  Write-Host '2b/5 Key Vault + managed identity for the HCP token' -ForegroundColor Cyan
  $kv = ("kv-$Prefix-" + (Az account show --query id -o tsv).Trim().Substring(0,6)).ToLower()
  if (-not (az keyvault show -n $kv 2>$null)) {
    Az keyvault create -g $rg -n $kv -l $Location --enable-rbac-authorization true --enable-purge-protection true | Out-Null
  }
  $kvScope = (Az keyvault show -n $kv --query id -o tsv).Trim()
  $me = (Az ad signed-in-user show --query id -o tsv).Trim()
  Az role assignment create --assignee-object-id $me --assignee-principal-type User --role 'Key Vault Secrets Officer' --scope $kvScope 2>$null | Out-Null
  Start-Sleep 20
  Az keyvault secret set --vault-name $kv --name tfe-token --value $tfePlain | Out-Null
  $kvUri = (Az keyvault secret show --vault-name $kv --name tfe-token --query id -o tsv).Trim() -replace '/[0-9a-f]{32}$',''
  Az containerapp identity assign -g $rg -n $app --system-assigned | Out-Null
  $miPrincipal = (Az containerapp show -g $rg -n $app --query identity.principalId -o tsv).Trim()
  Az role assignment create --assignee-object-id $miPrincipal --assignee-principal-type ServicePrincipal --role 'Key Vault Secrets User' --scope $kvScope | Out-Null
  for ($i=0; $i -lt 8; $i++) {   # RBAC propagation can take a few minutes
    try { Az containerapp secret set -g $rg -n $app --secrets "tfe-token=keyvaultref:$kvUri,identityref:system" | Out-Null; break }
    catch { if ($i -eq 7) { throw }; Start-Sleep 30 }
  }
}

# --- Entra ID ----------------------------------------------------------------
Write-Host '3/5 Entra app registrations (API + connector client)' -ForegroundColor Cyan
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

Write-Host '4/5 Container Apps authentication (reject anonymous calls)' -ForegroundColor Cyan
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
Write-Host '5/5 Generating Copilot Studio custom connector files' -ForegroundColor Cyan
New-Item -ItemType Directory -Force $outDir | Out-Null
$swagger = [ordered]@{
  swagger='2.0'
  info=[ordered]@{ title='Terraform MCP'; description='Terraform MCP server on Azure Container Apps'; version='1.0' }
  host=$fqdn; basePath='/'; schemes=@('https')
  paths=[ordered]@{ '/mcp'=[ordered]@{ post=[ordered]@{
    summary='Terraform MCP'; operationId='InvokeServer'
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
Key Vault token     : $($UseKeyVault.IsPresent)   Group-restricted: $([bool]$SecurityGroupId)   IP allow-list: $([bool]$AllowedCidrs)
Smoke test        : ./Test-TerraformMcp.ps1 -SubscriptionId $SubscriptionId -Prefix $Prefix
Operations (apply/destroy via HCP Terraform runs): $ops

Next, in Copilot Studio (easiest path, ~1 minute):
  open out/copilot-studio-wizard-values.md and paste its values into
  Agent > Tools > Add a tool > New tool > Model Context Protocol.
  Alternative: pick "Terraform MCP" if pac created the connector, or import out/terraform-mcp.swagger.json + out/apiProperties.json as a custom connector,
   paste the client secret on the Security tab, then create the connection).
Test:  curl -i https://$fqdn/mcp   -> must return 401 (anonymous calls blocked)
"@ | Write-Host
