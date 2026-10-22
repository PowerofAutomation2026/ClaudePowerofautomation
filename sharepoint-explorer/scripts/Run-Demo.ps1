<#
.SYNOPSIS
  Try PNC SharePoint Team Explorer on your own PC with sample data - nothing is deployed and nothing is sent anywhere.
.DESCRIPTION
  Installs Node.js if missing (via winget), installs the packages once, starts the app and opens it in your browser.
  The demo has a 2,000,000-row list, a 180,000-file library, a 640-row wide list (tabbed form) and more.
  Press Ctrl+C in this window to stop it.
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
if (-not (Have 'node')) {
  if (Have 'winget') { Write-Host 'Installing Node.js LTS...' -ForegroundColor Yellow; winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }
  else { throw 'Node.js is required: https://nodejs.org (LTS). Install it, then run this again.' }
}
if (-not (Have 'node')) { throw 'Node.js was installed but is not on PATH yet. Close this window, open a new one and run again.' }
if (-not (Test-Path (Join-Path $root 'node_modules'))) { Write-Host 'Installing packages (first run only)...' -ForegroundColor Cyan; npm install --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw 'npm install failed' } }
Write-Host "`nStarting the demo at http://127.0.0.1:3000/?demo=1  (Ctrl+C to stop)" -ForegroundColor Green
Start-Job -ScriptBlock { Start-Sleep -Seconds 4; Start-Process 'http://127.0.0.1:3000/?demo=1' } | Out-Null
npm run dev
