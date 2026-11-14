<#
.SYNOPSIS
  Zero-touch deploy of outage-watch (Microsoft 365 / Copilot early-warning monitor) on Windows.

.DESCRIPTION
  Give it a Power Platform environment ID (or let it ask). It checks Python, installs the app under
  %ProgramData%\OutageWatch\<envId>, generates config and a private admin token, runs the unit tests as a
  gate, does a live dry-run probe, registers a Scheduled Task that starts at boot and restarts on failure,
  starts it, and smoke-tests it. The dashboard listens on localhost only. No firewall port is opened.

  The environment ID names the deployment and folders and adds one probe for that environment's maker
  portal page. outage-watch cannot run inside Power Platform and reads nothing from the environment.

.PARAMETER EnvironmentId  Power Platform environment GUID. Prompted if omitted (unless -Yes).
.PARAMETER Tenant         Short tenant name (contoso) to also probe SharePoint/OneDrive.
.PARAMETER Port           Dashboard port on 127.0.0.1 (default 8080).
.PARAMETER RunAs          LocalService (default, least privilege) or System.
.PARAMETER Yes            Unattended: never prompt; try to install Python with winget if missing.
.PARAMETER DryRun         Print what would happen; change nothing.
.PARAMETER SkipTests      Skip the unit-test gate (not recommended).
.PARAMETER Uninstall      Remove the Scheduled Task and the app (keeps config/tokens/data).
.PARAMETER Purge          With -Uninstall: also delete config, tokens, data and logs.

.EXAMPLE
  .\Deploy-OutageWatch.ps1 -EnvironmentId 00000000-0000-0000-0000-000000000000 -Yes
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$EnvironmentId,
  [string]$Tenant,
  [int]$Port = 8080,
  [ValidateSet('LocalService', 'System')][string]$RunAs = 'LocalService',
  [switch]$Yes,
  [switch]$DryRun,
  [switch]$SkipTests,
  [switch]$Uninstall,
  [switch]$Purge
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Step($m) { Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    [ok]   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    [warn] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "    [fail] $m" -ForegroundColor Red }

# ---------- 1. Validate input BEFORE it touches a path, a task name or a command line ----------
$guidPattern = '\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\z'
if ([string]::IsNullOrWhiteSpace($EnvironmentId)) { $EnvironmentId = $env:OUTAGEWATCH_ENV_ID }
if ([string]::IsNullOrWhiteSpace($EnvironmentId)) {
  if ($Yes) { Fail 'No environment ID. Pass -EnvironmentId <guid> (or set OUTAGEWATCH_ENV_ID).'; exit 2 }
  $EnvironmentId = Read-Host 'Power Platform environment ID (GUID, the part after /environments/ in the maker portal URL)'
}
$EnvironmentId = $EnvironmentId.Trim()
if ($EnvironmentId -cnotmatch $guidPattern) {
  Fail 'Environment ID must look like 00000000-0000-0000-0000-000000000000.'; exit 2
}
$EnvironmentId = $EnvironmentId.ToLowerInvariant()
if ([string]::IsNullOrWhiteSpace($Tenant) -and -not $Yes -and -not $Uninstall -and -not $DryRun) {
  $Tenant = Read-Host 'Tenant name for the SharePoint/OneDrive checks (the "contoso" in contoso.sharepoint.com). Press Enter to skip'
  if ($Tenant) { $Tenant = $Tenant.Trim() }
}
if ($Tenant -and ($Tenant -cnotmatch '\A[A-Za-z0-9][A-Za-z0-9-]{0,62}\z')) {
  Fail 'Tenant must be the short name (contoso), letters/digits/hyphens only.'; exit 2
}
if ($Port -lt 1024 -or $Port -gt 65535) { Fail 'Port must be 1024-65535.'; exit 2 }

$short    = $EnvironmentId.Substring(0, 8)
$taskName = "OutageWatch-$short"
$base     = Join-Path $env:ProgramData 'OutageWatch'
$envDir   = Join-Path $base $EnvironmentId
$appDir   = Join-Path $envDir 'app'
$dataDir  = Join-Path $envDir 'data'
$envFile  = Join-Path $envDir 'outagewatch.env'
$account  = if ($RunAs -eq 'System') { 'NT AUTHORITY\SYSTEM' } else { 'NT AUTHORITY\LOCAL SERVICE' }

# ---------- 2. Elevate (Scheduled Task + ProgramData need admin) ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $DryRun) {
  Write-Host 'Administrator rights are needed; asking Windows to elevate...' -ForegroundColor Yellow
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $MyInvocation.MyCommand.Path),
               '-EnvironmentId', $EnvironmentId, '-Port', "$Port", '-RunAs', $RunAs)   # all values validated above
  if ($Tenant)    { $argList += @('-Tenant', $Tenant) }
  if ($Yes)       { $argList += '-Yes' }
  if ($SkipTests) { $argList += '-SkipTests' }
  if ($Uninstall) { $argList += '-Uninstall' }
  if ($Purge)     { $argList += '-Purge' }
  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs -Wait -PassThru
  exit $p.ExitCode
}

# ---------- helpers ----------
function Find-Python {
  $cands = @()
  $py = Get-Command py -ErrorAction SilentlyContinue
  if ($py) { try { $x = & $py.Source -3 -c 'import sys;print(sys.executable)' 2>$null; if ($x) { $cands += "$x".Trim() } } catch {} }
  foreach ($n in @('python', 'python3')) {
    $c = Get-Command $n -ErrorAction SilentlyContinue
    if ($c -and $c.Source -notmatch 'WindowsApps') { $cands += $c.Source }   # skip the Store stub
  }
  foreach ($c in $cands) {
    try {
      $v = & $c -c 'import sys;print(int(sys.version_info>=(3,9)))' 2>$null
      if ($v -and "$v".Trim() -eq '1') { return $c }
    } catch {}
  }
  return $null
}

function Test-Health($url) {
  try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5; return [int]$r.StatusCode } catch { return -1 }
}

$createdTask = $false
$logPath = Join-Path $envDir 'deploy.log'
try {
  # ---------- uninstall ----------
  if ($Uninstall) {
    Step "Uninstalling $taskName"
    if ($DryRun) { Ok "[dry run] would stop and remove task $taskName and the app; purge=$Purge"; exit 0 }
    $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($t) { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Ok 'Scheduled Task removed' } else { Ok 'no Scheduled Task found' }
    if (Test-Path $envDir) {
      if ($Purge) { Remove-Item -Recurse -Force $envDir; Ok 'removed everything (config, tokens, data, logs)' }
      elseif (Test-Path $appDir) { Remove-Item -Recurse -Force $appDir; Ok "app removed; config/tokens/data kept in $envDir" }
    }
    exit 0
  }

  Write-Host ''
  Write-Host "outage-watch zero-touch deploy" -ForegroundColor White
  Write-Host "  Environment ID : $EnvironmentId"
  Write-Host "  Task name      : $taskName   (runs as $account, starts at boot)"
  Write-Host "  Dashboard      : http://127.0.0.1:$Port/  (this machine only)"
  Write-Host "  Install folder : $envDir"

  # ---------- 3. Python ----------
  Step '1/7 Checking Python 3.9+'
  $python = Find-Python
  if (-not $python) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($DryRun) { Warn '[dry run] Python 3.9+ not found; a real run would try: winget install Python.Python.3.12 --scope machine' }
    elseif ($winget -and $Yes) {
      Warn 'Python not found. Installing Python 3.12 for all users with winget...'
      & winget install --id Python.Python.3.12 -e --scope machine --silent --accept-package-agreements --accept-source-agreements | Out-Null
      $python = Find-Python
      if (-not $python) { throw 'Python was installed but this window cannot see it yet. Open a NEW terminal and run this script again.' }
    } else {
      throw 'Python 3.9+ not found. Install it for all users (https://www.python.org/downloads/, tick "Install for all users" and "Add to PATH") or re-run with -Yes to let winget do it.'
    }
  }
  if ($python) {
    Ok "Python: $python"
    if ($RunAs -eq 'LocalService' -and $python -match '\\Users\\') {
      throw "Python is installed under a user profile ($python). The low-privilege service account cannot run it. Install Python for all users (winget install Python.Python.3.12 --scope machine), or re-run with -RunAs System."
    }
  }

  if ($DryRun) {
    Step 'Dry run: no changes made'
    Ok "would copy the app to $appDir, generate config and a private token, run tests, probe Microsoft 365, register task $taskName as $account, start it and smoke-test http://127.0.0.1:$Port/"
    exit 0
  }

  New-Item -ItemType Directory -Force -Path $envDir | Out-Null
  try { Start-Transcript -Path $logPath -Append | Out-Null } catch {}

  # ---------- 4. Installer logic (config, tokens, tests, live probe) ----------
  Step '2/7 Installing app, generating config and token, running tests, probing Microsoft 365'
  $inst = @((Join-Path $here 'install.py'), '--env-id', $EnvironmentId, '--base-dir', $base, '--port', "$Port")
  if ($Tenant)    { $inst += @('--tenant', $Tenant) }
  if ($SkipTests) { $inst += '--skip-tests' }
  & $python @inst
  if ($LASTEXITCODE -ne 0) { throw "installer step failed (exit code $LASTEXITCODE); nothing was started" }
  Copy-Item -Force (Join-Path $here 'launch.py') (Join-Path $envDir 'launch.py')

  # ---------- 5. Lock down permissions ----------
  Step '3/7 Restricting folder permissions'
  # SYSTEM + Administrators: full. Service account: read the app/token, write only the data folder.
  & icacls $envDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if ($RunAs -eq 'LocalService') {
    & icacls $envDir /grant:r '*S-1-5-19:(OI)(CI)RX' | Out-Null
    & icacls $dataDir /grant:r '*S-1-5-19:(OI)(CI)M' | Out-Null
  }
  # The token file gets its own explicit, tighter ACL (read-only for the service account).
  & icacls $envFile /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
  if ($RunAs -eq 'LocalService') { & icacls $envFile /grant:r '*S-1-5-19:R' | Out-Null }
  Ok 'permissions set (token file readable only by SYSTEM, Administrators and the service account)'

  # ---------- 6. Scheduled Task ----------
  Step "4/7 Registering Scheduled Task $taskName (start at boot, restart on failure)"
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }
  $launch  = Join-Path $envDir 'launch.py'
  $action  = New-ScheduledTaskAction -Execute $python -Argument ('"{0}" --env-dir "{1}"' -f $launch, $envDir) -WorkingDirectory $appDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $princ   = New-ScheduledTaskPrincipal -UserId $account -LogonType ServiceAccount -RunLevel Limited
  $set     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
               -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $princ -Settings $set `
    -Description "outage-watch for Power Platform environment $EnvironmentId" -Force | Out-Null
  if (-not $existing) { $createdTask = $true }
  Ok 'task registered'

  # ---------- 7. Start + wait ----------
  Step '5/7 Starting and waiting for the dashboard'
  Start-ScheduledTask -TaskName $taskName
  $up = $false
  for ($i = 0; $i -lt 60; $i++) { if ((Test-Health "http://127.0.0.1:$Port/healthz") -eq 200) { $up = $true; break }; Start-Sleep -Seconds 1 }
  if (-not $up) { throw "The dashboard did not answer on port $Port within 60 s. Port in use? Check Task Scheduler > $taskName > History, and $dataDir" }
  Ok "dashboard is answering on http://127.0.0.1:$Port/"

  # ---------- 8. Smoke tests ----------
  Step '6/7 Smoke tests'
  if ((Test-Health "http://127.0.0.1:$Port/status.json") -eq 200) { Ok '/status.json answers' } else { throw '/status.json did not answer' }
  if ((Test-Health "http://127.0.0.1:$Port/metrics") -eq 200) { Ok '/metrics answers' } else { Warn '/metrics did not answer' }
  $code = -1
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/test" -Method Post -Body '{}' -ContentType 'application/json' -UseBasicParsing -TimeoutSec 15 | Out-Null
    $code = 200
  } catch { if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode } }
  if ($code -eq 401 -or $code -eq 403) { Ok "admin API refuses requests without the token (HTTP $code)" }
  else { throw "SECURITY CHECK FAILED: admin API answered HTTP $code without a token. Stopping the task." }

  # ---------- 9. Summary ----------
  Step '7/7 Done'
  Write-Host ''
  Write-Host "  Dashboard      : http://127.0.0.1:$Port/" -ForegroundColor Green
  if (-not $Tenant) { Warn 'No -Tenant given: SharePoint Online and OneDrive for Business are NOT checked (shown as "needs your tenant name"). Re-run with -Tenant <name> to add them.' }
  Write-Host "  Admin token    : in $envFile  (to run manual tests from the dashboard; shown nowhere else)"
  Write-Host "  Data and logs  : $dataDir   (deploy log: $logPath)"
  Write-Host "  Starts at boot : Scheduled Task '$taskName' as $account, restarts on failure"
  Write-Host "  Add alerts     : edit the config (see README-DEPLOY.txt), then restart the task"
  Write-Host "  Uninstall      : Uninstall.cmd $EnvironmentId   (add -Purge to delete data too)"
  Write-Host ''
  try { Stop-Transcript | Out-Null } catch {}
  if (-not $Yes) { [void](Read-Host 'Press Enter to close') }
  exit 0
}
catch {
  Fail $_.Exception.Message
  if ($createdTask) {
    try { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue; Warn "rolled back: removed Scheduled Task $taskName" } catch {}
  }
  Warn "Files created so far remain in $envDir (re-run to retry, or Uninstall.cmd $EnvironmentId -Purge to remove)."
  try { Stop-Transcript | Out-Null } catch {}
  if (-not $Yes) { [void](Read-Host 'Press Enter to close') }
  exit 1
}
