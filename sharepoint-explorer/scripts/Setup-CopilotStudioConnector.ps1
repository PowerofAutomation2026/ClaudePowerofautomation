<#
.SYNOPSIS
  One-time ADMIN setup so the app can chat with ANY Copilot Studio agent (new or classic) - creates your own Entra app + a custom connector.
.DESCRIPTION
  Why this is needed: Microsoft's own HTTP connectors ("preauthorized" and "non-preauthorized") sign in through Microsoft-owned apps, and Entra does not
  allow a Microsoft-owned app to be consented for the Power Platform API (Copilot Studio answers 403 InsufficientDelegatedPermissions). The supported way is
  your OWN app registration used by a custom connector. This script:
    1. makes sure the Power Platform API exists in your tenant,
    2. creates an Entra app registration (single tenant) with the delegated permission CopilotStudio.Copilots.Invoke and grants admin consent,
    3. creates a client secret,
    4. writes the connector files (OpenAPI + auth settings) for YOUR environment and creates the custom connector with `pac connector create`.
  Needs: Azure CLI (az), Power Platform CLI (pac) signed in to the environment, and an account that may create app registrations and grant admin consent.
.PARAMETER EnvironmentId  Power Platform environment ID (GUID) where the app and the agent live.
.PARAMETER AppName        Name of the Entra app registration. Default: SharePointExplorer-CopilotStudio
.PARAMETER ConnectorName  Display name of the custom connector. Default: SPX Copilot Direct (the deploy script looks for this name)
.PARAMETER OutDir         Folder for the generated connector files. Default: .\copilot-connector
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$EnvironmentId,
  [string]$AppName = 'SharePointExplorer-CopilotStudio',
  [string]$ConnectorName = 'SPX Copilot Direct',
  [string]$OutDir = '.\copilot-connector'
)
$ErrorActionPreference = 'Stop'
$ppApi = '8578e004-a5c6-46e7-913e-12f58912df43'          # Power Platform API
$scopeId = '204440d3-c1d0-4826-b570-99eb6f5e2aeb'       # CopilotStudio.Copilots.Invoke (verified below against your tenant)
function Step($t) { Write-Host "`n==> $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "    $t" -ForegroundColor Green }
if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Azure CLI (az) is required: https://aka.ms/installazurecliwindows' }
if (-not (Get-Command pac -ErrorAction SilentlyContinue)) { throw 'Power Platform CLI (pac) is required (Deploy.cmd installs it).' }
if ($EnvironmentId -notmatch '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$') { throw 'EnvironmentId must be a GUID.' }

Step 'Signing in to Azure (browser)'
$acct = az account show 2>$null | ConvertFrom-Json
if (-not $acct) { az login --allow-no-subscriptions | Out-Null; $acct = az account show | ConvertFrom-Json }
$tenantId = $acct.tenantId; Ok "Tenant $tenantId as $($acct.user.name)"

Step 'Power Platform API in your tenant'
$sp = az ad sp show --id $ppApi 2>$null
if (-not $sp) { az ad sp create --id $ppApi | Out-Null; Ok 'Created the Power Platform API service principal' } else { Ok 'Already present' }
$real = az ad sp show --id $ppApi --query "oauth2PermissionScopes[?value=='CopilotStudio.Copilots.Invoke'].id" -o tsv
if ($real) { $scopeId = $real.Trim(); Ok "Permission CopilotStudio.Copilots.Invoke = $scopeId" } else { Write-Warning "Could not read the permission id from your tenant; using the published id $scopeId" }

Step "Entra app registration '$AppName'"
$appId = az ad app list --display-name $AppName --query "[0].appId" -o tsv
if (-not $appId) {
  $appId = az ad app create --display-name $AppName --sign-in-audience AzureADMyOrg --web-redirect-uris 'https://global.consent.azure-apim.net/redirect' --query appId -o tsv
  az ad sp create --id $appId | Out-Null
  Ok "Created app $appId"
} else { Ok "Reusing app $appId" }
az ad app permission add --id $appId --api $ppApi --api-permissions "$scopeId=Scope" | Out-Null
Start-Sleep -Seconds 5
az ad app permission admin-consent --id $appId | Out-Null
Ok 'Delegated permission added and admin consent granted'
$secret = az ad app credential reset --id $appId --display-name 'copilot-connector' --years 2 --query password -o tsv
Ok 'Client secret created (kept only in the generated connector file below)'

Step 'Writing connector files'
$h = ($EnvironmentId -replace '-', '').ToLower(); $envHost = "$($h.Substring(0, $h.Length - 2)).$($h.Substring($h.Length - 2)).environment.api.powerplatform.com"
New-Item -ItemType Directory -Force $OutDir | Out-Null
$sse = @('text/event-stream', 'application/json')
$agentP = @{ name = 'agent'; in = 'path'; required = $true; type = 'string'; description = 'Agent schema name, e.g. cr56c_spocode' }
$convP = @{ name = 'conversationId'; in = 'path'; required = $true; type = 'string' }
$apiV = @{ name = 'api-version'; in = 'query'; required = $false; type = 'string'; default = '2022-03-01-preview'; 'x-ms-visibility' = 'internal' }
$bodyAny = @{ name = 'body'; in = 'body'; required = $true; schema = @{ type = 'object' } }
$resp = @{ '200' = @{ description = 'OK'; schema = @{ type = 'string' } }; default = @{ description = 'Error'; schema = @{ type = 'string' } } }
$swagger = [ordered]@{
  swagger = '2.0'; info = @{ title = $ConnectorName; description = 'Talks to Copilot Studio agents (Direct-to-Engine) as the signed-in user.'; version = '1.0' }
  host = $envHost; basePath = '/'; schemes = @('https'); consumes = @('application/json'); produces = $sse
  paths = [ordered]@{
    '/copilotstudio/agents/{agent}/conversation-endpoints' = @{ get = @{ operationId = 'Discover'; summary = 'Find the conversation endpoints of an agent'; parameters = @($agentP); responses = $resp } }
    '/copilotstudio/dataverse-backed/authenticated/bots/{agent}/conversations' = @{ post = @{ operationId = 'CreateConversation'; summary = 'Start a conversation'; parameters = @($agentP, $apiV, $bodyAny); responses = $resp } }
    '/copilotstudio/dataverse-backed/authenticated/bots/{agent}/conversations/{conversationId}' = @{ post = @{ operationId = 'ExecuteTurn'; summary = 'Send a message'; parameters = @($agentP, $convP, $apiV, $bodyAny); responses = $resp } }
    '/{route}' = @{ post = @{ operationId = 'Invoke'; summary = 'Call any Copilot Studio route returned by discovery'; parameters = @(@{ name = 'route'; in = 'path'; required = $true; type = 'string'; 'x-ms-url-encoding' = 'double' }, $apiV, $bodyAny); responses = $resp } }
  }
  securityDefinitions = @{ oauth2_auth = @{ type = 'oauth2'; flow = 'accessCode'; authorizationUrl = 'https://login.windows.net/common/oauth2/authorize'; tokenUrl = 'https://login.windows.net/common/oauth2/authorize'; scopes = @{} } }
  security = @(@{ oauth2_auth = @() })
}
$props = [ordered]@{ properties = [ordered]@{
  connectionParameters = @{ token = @{ type = 'oauthSetting'; oAuthSettings = [ordered]@{
    identityProvider = 'aad'; clientId = $appId; clientSecret = $secret
    scopes = @('https://api.powerplatform.com/CopilotStudio.Copilots.Invoke')
    redirectMode = 'Global'; redirectUrl = 'https://global.consent.azure-apim.net/redirect'
    properties = @{ IsFirstParty = 'False'; AzureActiveDirectoryResourceId = 'https://api.powerplatform.com' }
    customParameters = @{ loginUri = @{ value = 'https://login.microsoftonline.com' }; tenantId = @{ value = $tenantId }; resourceUri = @{ value = 'https://api.powerplatform.com' }; enableOnbehalfOfLogin = @{ value = 'false' } } } } }
  iconBrandColor = '#2E7D32'; capabilities = @(); publisher = 'SharePoint Explorer'; stackOwner = 'SharePoint Explorer' } }
$defFile = Join-Path $OutDir 'apiDefinition.swagger.json'; $propFile = Join-Path $OutDir 'apiProperties.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Resolve-Path $OutDir).Path + '\apiDefinition.swagger.json', ($swagger | ConvertTo-Json -Depth 20), $utf8)
[System.IO.File]::WriteAllText((Resolve-Path $OutDir).Path + '\apiProperties.json', ($props | ConvertTo-Json -Depth 20), $utf8)
Ok "Files written to $((Resolve-Path $OutDir).Path) (apiProperties.json contains the client secret - keep it private)"

Step "Creating the custom connector '$ConnectorName' with pac"
& pac auth list 2>&1 | Out-Null
& pac env select --environment $EnvironmentId | Out-Null
$prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
$out = ((& pac connector create --api-definition-file $defFile --api-properties-file $propFile --environment $EnvironmentId 2>&1) | ForEach-Object { "$_" }) -join "`n"
$code = $LASTEXITCODE; $ErrorActionPreference = $prev
Write-Host $out -ForegroundColor DarkGray
if ($code -ne 0) {
  Write-Warning 'pac could not create the connector. Create it by hand instead: Power Apps > Custom connectors > New custom connector > Import an OpenAPI file > apiDefinition.swagger.json; Security: OAuth 2.0, Identity provider Azure Active Directory, Client id/secret from apiProperties.json, Resource URL https://api.powerplatform.com, Scope https://api.powerplatform.com/CopilotStudio.Copilots.Invoke; then copy the redirect URL it shows into the Entra app registration (Authentication > Web). Name it exactly: ' + $ConnectorName
}

Write-Host ''
Write-Host 'Next steps' -ForegroundColor Cyan
Write-Host "  1. Power Apps > Connections > New connection > '$ConnectorName' > sign in once (each user does this the first time they use the agent chat)."
Write-Host '  2. Run Deploy.cmd again and choose option 2 (it finds the connection and adds the connector to the app).'
Write-Host '  3. In the app: Assistant > Setup > Add Copilot Studio agent > pick the agent > Test connection.'
