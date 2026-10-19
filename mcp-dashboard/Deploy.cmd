@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -Recurse '%~dp0' -File | Unblock-File; & '%~dp0Deploy-LiveDashboardMcp.ps1' %*"
