<#
.SYNOPSIS
  Smoke test for a deployed Terraform MCP server (both variants): an anonymous call must get 401; an
  authenticated MCP initialize + tools/list must succeed; on the Azure-native server it also calls
  whoami, list_environments and list_templates (read-only tools).

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
if (-not $Token -and $SubscriptionId) {
  $apiId = "$(az ad app list --display-name "$Prefix-api" --query '[0].appId' -o tsv)".Trim()
  $Token = "$(az account get-access-token --resource "api://$apiId" --query accessToken -o tsv)".Trim()
}

# 1. anonymous calls are rejected
$anon = try { [int](Invoke-WebRequest $Url -Method Post -Body '{}' -ContentType 'application/json' -SkipHttpErrorCheck).StatusCode } catch { 0 }
Show 'anonymous POST is rejected' ($anon -eq 401) "(HTTP $anon, expected 401)"

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
  if ($tools -contains 'whoami') {
    $me = Invoke-Tool 'whoami'
    Show 'whoami returns the signed-in user' ([bool]$me.name) "($($me.name))"
    $envs = Invoke-Tool 'list_environments'
    Show 'list_environments' (@($envs.environments).Count -gt 0) "($((@($envs.environments) | ForEach-Object { $_.name }) -join ', '))"
    $templates = Invoke-Tool 'list_templates'
    Show 'list_templates' (@($templates.templates).Count -gt 0) "($(@($templates.templates).Count) templates)"
  }
} catch {
  Show 'authenticated MCP session' $false "$_"
}
if ($failed) { Write-Host "$failed check(s) failed." -ForegroundColor Red; exit 1 }
Write-Host 'All checks passed.' -ForegroundColor Green
