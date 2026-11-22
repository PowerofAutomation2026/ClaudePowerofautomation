<#
.SYNOPSIS
  Smoke test for a deployed Terraform MCP server (both variants): an anonymous call must get 401; an
  authenticated MCP initialize + tools/list must succeed; on the Azure-native server it also calls
  whoami and catalog (read-only tools) and checks that no approval tool is exposed.
  The Azure CLI token only works if the server was deployed with -AllowAzureCliClient (the connector's
  client id is the only one accepted otherwise) and your account has a role (viewer / requester / admin).

.EXAMPLE
  ./Test-TerraformMcp.ps1 -SubscriptionId <guid> -Prefix aztfmcp

.EXAMPLE
  # against any URL with a token you already have (no az needed)
  ./Test-TerraformMcp.ps1 -Url https://host/mcp -Token <access token>
#>
[CmdletBinding()]
param(
  [string] $SubscriptionId,
  [string] $Prefix = 'aztfmcp',
  [string] $Url,
  [string] $Token,
  [string] $ApprovalUrl,
  [string] $TokenCode,                   # local end-to-end tests only: exchange this authorization code at the server's /token
  [switch] $AnonymousOnly,               # only the checks that need no token (anonymous calls must be rejected)
  [hashtable] $ExtraHeaders = @{}
)
$ErrorActionPreference = 'Stop'
$failed = 0
function Show([string] $What, [bool] $Ok, [string] $Detail = '') {
  if (-not $Ok) { $script:failed++ }
  Write-Host ("{0}  {1} {2}" -f $(if ($Ok) { 'PASS' } else { 'FAIL' }), $What, $Detail) -ForegroundColor $(if ($Ok) { 'Green' } else { 'Red' })
}

if (-not $Url) {
  if (-not $SubscriptionId) { throw 'Give -SubscriptionId (and -Prefix), or -Url and -Token.' }
  az account set --subscription $SubscriptionId | Out-Null
  $fqdn = (az containerapp show -g "rg-$Prefix" -n "ca-$Prefix" --query properties.configuration.ingress.fqdn -o tsv)
  if (-not $fqdn) { throw "Container app ca-$Prefix not found in rg-$Prefix." }
  $Url = "https://$("$fqdn".Trim())/mcp"
}
# (PowerShell variable names are case-insensitive: do not reuse the -ApprovalUrl parameter name here)
if ($SubscriptionId -and -not $ApprovalUrl) {
  $afqdn = "$(az containerapp show -g "rg-$Prefix" -n "ca-$Prefix-approval" --query properties.configuration.ingress.fqdn -o tsv 2>$null)".Trim()
  if ($afqdn) { $ApprovalUrl = "https://$afqdn" }
}
if (-not $Token -and $SubscriptionId -and -not $AnonymousOnly) {
  $apiId = "$(az ad app list --display-name "$Prefix-api" --query '[0].appId' -o tsv)".Trim()
  $Token = "$(az account get-access-token --resource "api://$apiId" --query accessToken -o tsv)".Trim()
}

# 1. anonymous calls are rejected
$anonResponse = try { Invoke-WebRequest $Url -Method Post -Body '{}' -ContentType 'application/json' -SkipHttpErrorCheck } catch { $null }
$anon = if ($anonResponse) { [int]$anonResponse.StatusCode } else { 0 }
Show 'anonymous POST is rejected' ($anon -eq 401) "(HTTP $anon, expected 401)"

# 1b. OAuth "Dynamic discovery": walk the same path an MCP client (Copilot Studio) takes, knowing only the URL
$challenge = if ($anonResponse) { "$($anonResponse.Headers['WWW-Authenticate'])" } else { '' }
if ($challenge -match 'resource_metadata="([^"]+)"') {
  try {
    $prm = Invoke-RestMethod $Matches[1]
    Show 'discovery: protected-resource metadata' ($prm.resource -like '*/mcp' -and @($prm.authorization_servers).Count -eq 1) "(resource $($prm.resource))"
    $as = "$(@($prm.authorization_servers)[0])".TrimEnd('/')
    $meta = Invoke-RestMethod "$as/.well-known/oauth-authorization-server"
    Show 'discovery: authorization-server metadata' ($meta.registration_endpoint -and $meta.code_challenge_methods_supported -contains 'S256' -and $meta.token_endpoint_auth_methods_supported -contains 'none') "(issuer $($meta.issuer))"
    $redirect = 'https://global.consent.azure-apim.net/redirect'
    $reg = Invoke-RestMethod $meta.registration_endpoint -Method Post -ContentType 'application/json' -Body (@{ client_name = 'smoke-test'; redirect_uris = @($redirect) } | ConvertTo-Json)
    Show 'discovery: dynamic client registration' ([bool]$reg.client_id -and -not $reg.client_secret -and $reg.token_endpoint_auth_method -eq 'none') "(client $($reg.client_id), no secret returned)"
    $bad = [int](Invoke-WebRequest $meta.registration_endpoint -Method Post -ContentType 'application/json' -Body '{"redirect_uris":["https://evil.example/cb"]}' -SkipHttpErrorCheck).StatusCode
    Show 'discovery: unknown redirect URI is refused' ($bad -eq 400) "(HTTP $bad, expected 400)"
    $verifier = -join ((1..64) | ForEach-Object { [char](Get-Random -Minimum 97 -Maximum 123) })
    $hash = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::ASCII.GetBytes($verifier))
    $codeChallenge = [Convert]::ToBase64String($hash).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $authUrl = "$($meta.authorization_endpoint)?client_id=$($reg.client_id)&response_type=code&state=smoke&code_challenge=$codeChallenge&code_challenge_method=S256&redirect_uri=$([uri]::EscapeDataString($redirect))"
    $r = Invoke-WebRequest $authUrl -MaximumRedirection 0 -SkipHttpErrorCheck -ErrorAction SilentlyContinue
    $location = "$($r.Headers['Location'])"
    Show 'discovery: /authorize redirects to the tenant sign-in with PKCE' ([int]$r.StatusCode -eq 302 -and $location -match '/oauth2/v2\.0/authorize\?' -and $location -match 'code_challenge_method=S256') "($(($location -split '\?')[0]))"
    $noPkce = [int](Invoke-WebRequest ($authUrl -replace '&code_challenge=[^&]+', '') -MaximumRedirection 0 -SkipHttpErrorCheck -ErrorAction SilentlyContinue).StatusCode
    Show 'discovery: /authorize without PKCE is refused' ($noPkce -eq 400) "(HTTP $noPkce, expected 400)"
    if ($TokenCode) {
      $tok = Invoke-RestMethod $meta.token_endpoint -Method Post -ContentType 'application/x-www-form-urlencoded' -Body @{ grant_type = 'authorization_code'; client_id = $reg.client_id; code = $TokenCode; redirect_uri = $redirect; code_verifier = $verifier }
      Show 'discovery: /token returns an access token' ([bool]$tok.access_token -and -not $tok.client_secret) ''
      $Token = $tok.access_token
    }
  } catch { Show 'discovery flow' $false "$_" }
} elseif ($anon -eq 401) { Write-Host '      (no OAuth discovery challenge: the server runs in manual connector mode)' -ForegroundColor DarkGray }

if ($ApprovalUrl) {
  $base = $ApprovalUrl.TrimEnd('/')
  $a1 = try { [int](Invoke-WebRequest "$base/api/pending" -SkipHttpErrorCheck).StatusCode } catch { 0 }
  Show 'approval API rejects anonymous calls' ($a1 -eq 401) "(HTTP $a1, expected 401)"
  if ($Token) {
    $a2 = try { [int](Invoke-WebRequest "$base/api/pending" -Headers @{ Authorization = "Bearer $Token" } -SkipHttpErrorCheck).StatusCode } catch { 0 }
    Show 'approval API rejects the MCP token (wrong audience)' ($a2 -eq 401) "(HTTP $a2, expected 401)"
  }
}

if ($AnonymousOnly) {
  if ($failed) { Write-Host "$failed check(s) failed." -ForegroundColor Red; exit 1 }
  Write-Host 'Anonymous checks passed (authenticated checks skipped).' -ForegroundColor Green
  exit 0
}
# 2. authenticated MCP session
$headers = @{ Accept = 'application/json, text/event-stream' }
if ($Token) { $headers['Authorization'] = "Bearer $Token" }
foreach ($k in $ExtraHeaders.Keys) { $headers[$k] = $ExtraHeaders[$k] }
$script:rpcId = 0
function Invoke-Mcp([string] $Method, $Params = $null) {
  $script:rpcId++
  $body = @{ jsonrpc = '2.0'; id = $script:rpcId; method = $Method }
  if ($null -ne $Params) { $body.params = $Params }
  $r = Invoke-WebRequest $Url -Method Post -Headers $headers -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 10 -Compress) -SkipHttpErrorCheck
  if ([int]$r.StatusCode -ne 200) { throw "HTTP $($r.StatusCode): $($r.Content)" }
  $sid = $r.Headers['Mcp-Session-Id']
  if ($sid) { $headers['Mcp-Session-Id'] = "$sid" }
  $text = "$($r.Content)"
  if ($text -match '(?m)^data:\s*(\{.*\})\s*$') { $text = $Matches[1] }   # event-stream framed answer
  $json = $text | ConvertFrom-Json
  if ($json.error) { throw "MCP error: $($json.error.message)" }
  $json.result
}
function Invoke-Tool([string] $Name, [hashtable] $Arguments = @{}) {
  $result = Invoke-Mcp 'tools/call' @{ name = $Name; arguments = $Arguments }
  if ($result.isError) { throw "tool $Name failed: $($result.content[0].text)" }
  $result.content[0].text | ConvertFrom-Json
}
try {
  $init = Invoke-Mcp 'initialize' @{ protocolVersion = '2025-03-26'; capabilities = @{}; clientInfo = @{ name = 'smoke-test'; version = '2' } }
  Show 'initialize' $true "(server: $($init.serverInfo.name))"
  $tools = @((Invoke-Mcp 'tools/list').tools | ForEach-Object { $_.name })
  Show 'tools/list' ($tools.Count -gt 0) "($($tools.Count) tools)"
  Show 'no approval / admin tools are exposed to the agent' (-not ($tools | Where-Object { $_ -match 'approve|reject|freeze|admin' })) "($($tools -join ', '))"
  if ($tools -contains 'whoami') {
    $me = Invoke-Tool 'whoami'
    Show 'whoami returns the signed-in user' ([bool]$me.name) "($($me.name); roles: $(@($me.roles) -join ', '))"
    if (-not $me.roles) { Write-Host '      note: this account has no role yet (viewer/requester/admin); catalog calls will be refused' -ForegroundColor Yellow }
    else {
      $envs = Invoke-Tool 'catalog' @{ what = 'environments' }
      Show 'catalog environments' ([bool]$envs.envs) "($(@($envs.envs.PSObject.Properties.Name) -join ', '))"
      $templates = Invoke-Tool 'catalog' @{ what = 'templates' }
      Show 'catalog templates' ([bool]$templates.templates) "($(@($templates.templates.PSObject.Properties.Name).Count) templates)"
    }
  }
} catch {
  Show 'authenticated MCP session' $false "$_"
}
if ($failed) { Write-Host "$failed check(s) failed." -ForegroundColor Red; exit 1 }
Write-Host 'All checks passed.' -ForegroundColor Green
