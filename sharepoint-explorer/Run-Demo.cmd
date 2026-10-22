@echo off
REM Double-click to try the app locally with sample data (no deployment).
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem '%~dp0scripts','%~dp0src' -Recurse -File | Unblock-File; & '%~dp0scripts\Run-Demo.ps1'"
pause
