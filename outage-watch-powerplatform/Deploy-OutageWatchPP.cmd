@echo off
rem Zero-touch deploy of Outage Watch (Power Platform edition).
rem Usage: Deploy-OutageWatchPP.cmd ^<environment-id^> [-Yes] [-DryRun] [-SkipTests] ...   (or double-click and paste the ID)
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0.' -File | Unblock-File; Get-ChildItem -LiteralPath '%~dp0provision' -Recurse -File | Unblock-File" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Deploy-OutageWatchPP.ps1" %*
set OWPP_EXIT=%ERRORLEVEL%
if "%~1"=="" pause
exit /b %OWPP_EXIT%
