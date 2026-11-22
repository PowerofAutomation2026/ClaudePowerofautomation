@echo off
rem ============================================================================================
rem  Azure Terraform MCP - one double-click installer.
rem  Works from a plain Windows command prompt / Explorer (Windows PowerShell 5.1 is enough to start):
rem  1. unblocks the downloaded files, 2. installs PowerShell 7 if it is missing (winget, else MSI),
rem  3. starts Install-AzureTerraformMcp.ps1 under PowerShell 7 and passes all arguments on.
rem  Examples:  Install.cmd            Install.cmd -PreflightOnly
rem             Install.cmd -Unattended -ConfigFile install.config.json        Install.cmd -Uninstall
rem  NOTE: this file was reviewed, not executed - the build environment had no Windows.
rem ============================================================================================
setlocal
set "HERE=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%HERE%' -Recurse -File | Unblock-File" 2>nul

set "PWSH="
for /f "delims=" %%P in ('where pwsh 2^>nul') do if not defined PWSH set "PWSH=%%P"
if not defined PWSH if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
if defined PWSH goto run

echo PowerShell 7 is not installed. Installing it now...
where winget >nul 2>nul
if not errorlevel 1 winget install --id Microsoft.PowerShell -e --source winget --accept-source-agreements --accept-package-agreements
if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
if defined PWSH goto run

echo winget did not install it. Downloading the official MSI from github.com/PowerShell/PowerShell ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol='Tls12'; $r=Invoke-RestMethod 'https://api.github.com/repos/PowerShell/PowerShell/releases/latest'; $a=$r.assets | Where-Object { $_.name -like '*-win-x64.msi' } | Select-Object -First 1; $f=Join-Path $env:TEMP $a.name; Invoke-WebRequest $a.browser_download_url -OutFile $f; Start-Process msiexec.exe -ArgumentList ('/i \"{0}\" /qn ADD_PATH=1' -f $f) -Wait -Verb RunAs"
if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
if defined PWSH goto run

echo.
echo Could not install PowerShell 7 automatically.
echo Install it from https://aka.ms/powershell-release?tag=stable and run Install.cmd again.
pause
exit /b 1

:run
"%PWSH%" -NoProfile -ExecutionPolicy Bypass -File "%HERE%Install-AzureTerraformMcp.ps1" %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" echo. & echo The installer ended with code %CODE%. The log is in the .deploy-logs folder.
rem keep the window open when started by double-click (no arguments)
if "%~1"=="" pause
exit /b %CODE%
