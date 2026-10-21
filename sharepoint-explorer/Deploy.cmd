@echo off
REM Double-click to deploy. Extra arguments are passed to the script, e.g. Deploy.cmd -EnvironmentId <guid>
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem '%~dp0scripts','%~dp0src','%~dp0index.html' -Recurse -File | Unblock-File; & '%~dp0scripts\Deploy-SharePointExplorer.ps1' %*"
pause
