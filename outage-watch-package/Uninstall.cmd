@echo off
rem Remove outage-watch. Usage:  Uninstall.cmd <environment-id> [-Purge]
powershell -NoProfile -ExecutionPolicy Bypass -Command "& '%~dp0Deploy-OutageWatch.ps1' -Uninstall %*"
exit /b %ERRORLEVEL%
