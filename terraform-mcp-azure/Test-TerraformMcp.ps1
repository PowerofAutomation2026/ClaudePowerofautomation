<# Smoke test: anonymous call must be 401; an authenticated MCP initialize + tools/list must succeed. #>
param([Parameter(Mandatory)][string]$SubscriptionId,[string]$Prefix='tfmcp')
$ErrorActionPreference='Stop'
az account set --subscription $SubscriptionId
$fqdn  = az containerapp show -g "rg-$Prefix" -n "ca-$Prefix" --query properties.configuration.ingress.fqdn -o tsv
$apiId = az ad app list --display-name "$Prefix-api" --query '[0].appId' -o tsv
$url   = "https://$fqdn/mcp"
$anon = try { (Invoke-WebRequest $url -Method Post -Body '{}' -ContentType 'application/json' -SkipHttpErrorCheck).StatusCode } catch { 0 }
Write-Host "Anonymous POST -> $anon  (expected 401)" -ForegroundColor ($(if($anon -eq 401){'Green'}else{'Red'}))
$tok = az account get-access-token --resource "api://$apiId" --query accessToken -o tsv
$h = @{ Authorization="Bearer $tok"; Accept='application/json, text/event-stream' }
$init = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
$r = Invoke-WebRequest $url -Method Post -Headers $h -ContentType 'application/json' -Body $init
Write-Host "initialize -> $($r.StatusCode)" -ForegroundColor Green
$sid = $r.Headers['Mcp-Session-Id']; if ($sid) { $h['Mcp-Session-Id'] = "$sid" }
Invoke-WebRequest $url -Method Post -Headers $h -ContentType 'application/json' -Body '{"jsonrpc":"2.0","method":"notifications/initialized"}' | Out-Null
$t = Invoke-WebRequest $url -Method Post -Headers $h -ContentType 'application/json' -Body '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
Write-Host "tools/list -> $($t.StatusCode)"; $t.Content.Substring(0,[Math]::Min(600,$t.Content.Length))
