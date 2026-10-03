<#
.SYNOPSIS
  Fallback executor for a transfer plan exported from Ownership Command Center.
  Uses Microsoft.PowerApps.Administration.PowerShell with interactive sign-in - NO Azure app registration.

.PARAMETER PlanCsv   CSV exported from the app ("Download plan"): Type,EnvironmentId,Id,Name,OldOwnerId,NewOwnerId
.PARAMETER KeepOldFlowOwner  Add the new owner to flows but don't remove the old one (co-owner mode).
.EXAMPLE
  ./Invoke-OwnershipPlan.ps1 -PlanCsv .\plan.csv -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][string]$PlanCsv,
  [switch]$KeepOldFlowOwner
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Module -ListAvailable Microsoft.PowerApps.Administration.PowerShell)) {
  Install-Module Microsoft.PowerApps.Administration.PowerShell -Scope CurrentUser -Force
}
Add-PowerAppsAccount   # interactive browser sign-in with your admin account

$rows = Import-Csv $PlanCsv
$ok = 0; $fail = 0
foreach ($r in $rows) {
  try {
    if ($r.Type -eq 'app') {
      if ($PSCmdlet.ShouldProcess("app $($r.Name)", "owner -> $($r.NewOwnerId)")) {
        Set-AdminPowerAppOwner -AppName $r.Id -EnvironmentName $r.EnvironmentId -AppOwner $r.NewOwnerId | Out-Null
      }
    } else {
      if ($PSCmdlet.ShouldProcess("flow $($r.Name)", "owner -> $($r.NewOwnerId)")) {
        Set-AdminFlowOwnerRole -EnvironmentName $r.EnvironmentId -FlowName $r.Id -RoleName CanEdit -PrincipalType User -PrincipalObjectId $r.NewOwnerId | Out-Null
        if (-not $KeepOldFlowOwner -and $r.OldOwnerId) {
          Remove-AdminFlowOwnerRole -EnvironmentName $r.EnvironmentId -FlowName $r.Id -RoleId $r.OldOwnerId | Out-Null
        }
      }
    }
    Write-Host "OK    $($r.Type) $($r.Name)" -ForegroundColor Green; $ok++
  } catch {
    Write-Host "FAIL  $($r.Type) $($r.Name): $($_.Exception.Message)" -ForegroundColor Red; $fail++
  }
}
Write-Host "`nDone: $ok ok, $fail failed."
