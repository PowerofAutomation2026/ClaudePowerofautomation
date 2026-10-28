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
  [string]$OutDir = '.\copilot-connector',
  [string]$ExtraRedirectUri,
  [string]$AppId,
  [switch]$SwaggerOnly
)
$ErrorActionPreference = 'Stop'
$ppApi = '8578e004-a5c6-46e7-913e-12f58912df43'          # Power Platform API
$scopeId = '204440d3-c1d0-4826-b570-99eb6f5e2aeb'       # CopilotStudio.Copilots.Invoke (verified below against your tenant)
function Step($t) { Write-Host "`n==> $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "    $t" -ForegroundColor Green }
function Build-Swagger {
$h = ($EnvironmentId -replace '-', '').ToLower(); $envHost = "$($h.Substring(0, $h.Length - 2)).$($h.Substring($h.Length - 2)).environment.api.powerplatform.com"
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
  }
  securityDefinitions = @{ oauth2_auth = @{ type = 'oauth2'; flow = 'accessCode'; authorizationUrl = 'https://login.windows.net/common/oauth2/authorize'; tokenUrl = 'https://login.windows.net/common/oauth2/authorize'; scopes = @{} } }
  security = @(@{ oauth2_auth = @() })
}
# Copilot Studio returns long routes (e.g. /copilotstudio/agenticruntime/3p/.../conversations). A path parameter would encode the slashes, so the connector
# offers one operation per segment count (Path4 ... Path14); every segment is its own path parameter and the slashes stay slashes.
foreach ($n in 4..14) {
  $segs = 1..$n | ForEach-Object { @{ name = "s$_"; in = 'path'; required = $true; type = 'string' } }
  $swagger.paths["/" + ((1..$n | ForEach-Object { "{s$_}" }) -join '/')] = @{ post = @{ operationId = "Path$n"; summary = "Call a $n-segment Copilot Studio route"; parameters = @($segs + @($apiV, $bodyAny)); responses = $resp } }
}
return $swagger
}
if ($SwaggerOnly) {   # just regenerate the OpenAPI file (to paste into an existing connector: Power Apps > Custom connectors > Edit > Swagger editor)
  if ($EnvironmentId -notmatch '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$') { throw 'EnvironmentId must be a GUID.' }
  New-Item -ItemType Directory -Force $OutDir | Out-Null
  $f = Join-Path (Resolve-Path $OutDir).Path 'apiDefinition.swagger.json'
  [System.IO.File]::WriteAllText($f, ((Build-Swagger) | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "Written: $f" -ForegroundColor Green; return
}
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
if ($AppId) { $appId = $AppId }
else {
  $apps = @(az ad app list --display-name $AppName --query "[?displayName=='$AppName'].{appId:appId,created:createdDateTime}" -o json | ConvertFrom-Json)
  if ($apps.Count -gt 1) { Write-Warning "Several Entra apps are named '$AppName': $(($apps | ForEach-Object { $_.appId }) -join ', '). Using the oldest. Delete the extras or pass -AppId <id>." }
  $appId = ($apps | Sort-Object created | Select-Object -First 1).appId
}
if (-not $appId) {
  $appId = az ad app create --display-name $AppName --sign-in-audience AzureADMyOrg --web-redirect-uris 'https://global.consent.azure-apim.net/redirect' --query appId -o tsv
  az ad sp create --id $appId | Out-Null
  Ok "Created app $appId"
} else { Ok "Reusing app $appId" }
az ad app permission add --id $appId --api $ppApi --api-permissions "$scopeId=Scope" | Out-Null
Start-Sleep -Seconds 5
az ad app permission admin-consent --id $appId | Out-Null
Ok 'Delegated permission added and admin consent granted'
$secret = az ad app credential reset --append --id $appId --display-name 'copilot-connector' --years 2 --query password -o tsv
Ok 'Client secret created (kept only in the generated connector file below)'

Step 'Writing connector files'
New-Item -ItemType Directory -Force $OutDir | Out-Null
$swagger = Build-Swagger
$props = [ordered]@{ properties = [ordered]@{
  connectionParameters = @{ token = @{ type = 'oauthSetting'; oAuthSettings = [ordered]@{
    identityProvider = 'aad'; clientId = $appId; clientSecret = $secret
    scopes = @('https://api.powerplatform.com/CopilotStudio.Copilots.Invoke')
    redirectMode = 'GlobalPerConnector'; redirectUrl = 'https://global.consent.azure-apim.net/redirect'
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

Step 'Redirect address of the connector (Entra must know it, otherwise sign-in fails with AADSTS50011)'
$base = 'https://global.consent.azure-apim.net/redirect'
$uris = @($base)
if ($ExtraRedirectUri) { $uris += $ExtraRedirectUri }
else {
  $found = $null
  foreach ($cmd in @(@('connector', 'list', '--environment', $EnvironmentId), @('connector', 'list'))) {
    try { $t = ((& pac @cmd 2>&1) | ForEach-Object { "$_" }) -join "`n"; if ($t -match '(?i)((?:new-5f)?spx-20copilot-20direct-5f[0-9a-f]+)') { $found = $Matches[1].ToLower(); break } } catch { }
  }
  if ($found) { $uris += "$base/$found"; Ok "Detected connector redirect: $base/$found" }
  else {
    Write-Warning 'Could not detect the connector''s own redirect address automatically.'
    Write-Host 'Create the connection once in Power Apps (Connections > New connection > SPX Copilot Direct). The sign-in error shows the address, e.g.' -ForegroundColor Yellow
    Write-Host "  'https://global.consent.azure-apim.net/redirect/new-5fspx-20copilot-20direct-5f<hash>' - copy it from the error text." -ForegroundColor Yellow
    $in = (Read-Host 'Paste that address here (or press Enter to skip)').Trim().Trim("'")
    if ($in -match '^https://global\.consent\.azure-apim\.net/redirect/\S+$') { $uris += $in } elseif ($in) { Write-Warning 'That does not look like a redirect address - skipped.' }
  }
}
if (-not $ExtraRedirectUri -and $found -and $uris.Count -ge 2) {   # try to read the exact redirect URL back from the service
  try {
    $dl = Join-Path $OutDir 'downloaded'; New-Item -ItemType Directory -Force $dl | Out-Null
    & pac connector download --connector-id $found --environment $EnvironmentId --outputDirectory $dl 2>&1 | Out-Null
    $dp = Get-ChildItem $dl -Recurse -Filter apiProperties.json -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($dp) { $ru = (Get-Content $dp.FullName -Raw | ConvertFrom-Json).properties.connectionParameters.token.oAuthSettings.redirectUrl; if ($ru -match '^https://global\.consent\.azure-apim\.net/redirect/\S+$') { $uris += $ru } }
  } catch { }
}
$cur = @(az ad app show --id $appId --query 'web.redirectUris' -o json | ConvertFrom-Json)
$all = @($cur + $uris | Where-Object { $_ } | Select-Object -Unique)
az ad app update --id $appId --web-redirect-uris @all | Out-Null
$after = @(az ad app show --id $appId --query 'web.redirectUris' -o json | ConvertFrom-Json)
foreach ($u in $uris) { if ($after -notcontains $u) { Write-Warning "Redirect address was NOT saved on the app: $u" } }
Ok ("App (client id) $appId - redirect addresses: " + ($after -join ', '))
Write-Host "Any AADSTS50011 error must name application '$appId'. If it names another GUID, the connection uses a different app/connector - delete extra 'SPX Copilot Direct' connectors in Power Apps > Custom connectors and create the connection again." -ForegroundColor Yellow
Write-Host ''
Write-Host 'If signing in to the connection fails with AADSTS50011 (redirect URI mismatch), copy the redirect URI from that error and run again with  -ExtraRedirectUri <that URI>  (or add it under Entra > App registrations > $AppName > Authentication).' -ForegroundColor Yellow
Write-Host 'Next steps' -ForegroundColor Cyan
Write-Host "  1. Power Apps > Connections > New connection > '$ConnectorName' > sign in once (each user does this the first time they use the agent chat)."
Write-Host '  2. Run Deploy.cmd again and choose option 2 (it finds the connection and adds the connector to the app).'
Write-Host '  3. In the app: Assistant > Setup > Add Copilot Studio agent > pick the agent > Test connection.'
