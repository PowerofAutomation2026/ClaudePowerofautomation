<#
.SYNOPSIS
  One-time ADMIN step: lets the "HTTP with Microsoft Entra ID" (NOT preauthorized) connector call Copilot Studio agents on behalf of signed-in users.
.DESCRIPTION
  The preauthorized connector (shared_webcontents) is a Microsoft app that does not hold the Power Platform API permission
  CopilotStudio.Copilots.Invoke, so Copilot Studio answers 403 "InsufficientDelegatedPermissions". The non-preauthorized connector
  (shared_webcontentsv2) signs in through Microsoft's app "HttpWithAADApp" (d2ebd3a9-1ada-4480-8b2d-eac162716601) which has NO permissions
  until a tenant admin grants them. This script creates that grant: client = HttpWithAADApp, resource = Power Platform API, scope = CopilotStudio.Copilots.Invoke.
  Needs a Global Administrator (or Privileged Role / Cloud Application Administrator). No app registration of your own is needed.
.PARAMETER Scope      Scope(s) to grant, space separated. Default CopilotStudio.Copilots.Invoke
.PARAMETER PerUser    Grant only to the signed-in admin instead of the whole organisation.
#>
[CmdletBinding()]
param([string]$Scope = 'CopilotStudio.Copilots.Invoke', [switch]$PerUser)

$ErrorActionPreference = 'Stop'
$ppApiAppId = '8578e004-a5c6-46e7-913e-12f58912df43'   # Power Platform API
$httpAppId  = 'd2ebd3a9-1ada-4480-8b2d-eac162716601'   # HttpWithAADApp (the app behind "HTTP with Microsoft Entra ID")

if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication)) {
  Write-Host 'Installing the Microsoft Graph PowerShell module (current user)...' -ForegroundColor Cyan
  Install-Module Microsoft.Graph -Scope CurrentUser -Force -AllowClobber
}
Import-Module Microsoft.Graph.Authentication, Microsoft.Graph.Applications, Microsoft.Graph.Identity.SignIns
Connect-MgGraph -Scopes 'Application.ReadWrite.All', 'DelegatedPermissionGrant.ReadWrite.All' -NoWelcome
$me = (Get-MgContext).Account

$res = Get-MgServicePrincipal -Filter "appId eq '$ppApiAppId'"
if (-not $res) { Write-Host 'Creating the Power Platform API service principal in your tenant...' -ForegroundColor Cyan; $res = New-MgServicePrincipal -AppId $ppApiAppId }
$cli = Get-MgServicePrincipal -Filter "appId eq '$httpAppId'"
if (-not $cli) { Write-Host 'Creating the HTTP with Microsoft Entra ID service principal in your tenant...' -ForegroundColor Cyan; $cli = New-MgServicePrincipal -AppId $httpAppId }

foreach ($s in ($Scope -split '\s+' | Where-Object { $_ })) {
  if (-not ($res.Oauth2PermissionScopes | Where-Object { $_.Value -eq $s })) { Write-Warning "The Power Platform API in this tenant does not list the permission '$s'. Check the spelling (CopilotStudio.Copilots.Invoke) and try again later; it can take a few minutes after the service principal is created." }
}

if ($PerUser) {
  $user = Get-MgUser -UserId $me
  $filter = "clientId eq '$($cli.Id)' and resourceId eq '$($res.Id)' and consentType eq 'Principal' and principalId eq '$($user.Id)'"
} else { $filter = "clientId eq '$($cli.Id)' and resourceId eq '$($res.Id)' and consentType eq 'AllPrincipals'" }
$existing = Get-MgOauth2PermissionGrant -Filter $filter
if ($existing) {
  $merged = ((@($existing.Scope -split ' ') + @($Scope -split '\s+')) | Where-Object { $_ } | Select-Object -Unique) -join ' '
  Update-MgOauth2PermissionGrant -OAuth2PermissionGrantId $existing.Id -BodyParameter @{ scope = $merged } | Out-Null
  Write-Host "Updated the existing grant. Scopes now: $merged" -ForegroundColor Green
} else {
  $body = @{ clientId = $cli.Id; resourceId = $res.Id; scope = $Scope }
  if ($PerUser) { $body.consentType = 'Principal'; $body.principalId = $user.Id } else { $body.consentType = 'AllPrincipals' }
  New-MgOauth2PermissionGrant -BodyParameter $body | Out-Null
  Write-Host "Granted '$Scope' to the HTTP with Microsoft Entra ID connector ($(if ($PerUser) { "for $me" } else { 'for everyone in the organisation' }))." -ForegroundColor Green
}

Write-Host ''
Write-Host 'Next steps' -ForegroundColor Cyan
Write-Host '  1. In Power Apps > Connections, create a NEW connection "HTTP with Microsoft Entra ID" (not the preauthorized one):'
Write-Host '       Base Resource URL : https://<environment host>   (Deploy.cmd prints it; the app Setup screen shows it)'
Write-Host '       Microsoft Entra ID Resource URI : https://api.powerplatform.com'
Write-Host '     Existing connections can take up to an hour to notice the grant, a NEW connection works at once.'
Write-Host '  2. Run Deploy.cmd again and choose option 2 (new-experience agents).'
Write-Host '  3. Each user creates/approves their own connection the first time they open the app.'
