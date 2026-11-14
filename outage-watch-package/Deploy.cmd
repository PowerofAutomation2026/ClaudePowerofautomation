@echo off
rem Zero-touch deploy of outage-watch. Usage:  Deploy.cmd <environment-id> [-Yes] [-Tenant contoso] [-Port 8080]
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -Recurse '%~dp0' -File | Unblock-File; & '%~dp0Deploy-OutageWatch.ps1' %*"
exit /b %ERRORLEVEL%
