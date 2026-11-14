@echo off
rem Removes the Outage Watch probe flow. Add -Purge to delete tables, collected data, solution and publisher too.
rem Usage: Uninstall-OutageWatchPP.cmd ^<environment-id^> [-Purge] [-Yes]
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Deploy-OutageWatchPP.ps1" -Uninstall %*
set OWPP_EXIT=%ERRORLEVEL%
if "%~1"=="" pause
exit /b %OWPP_EXIT%
