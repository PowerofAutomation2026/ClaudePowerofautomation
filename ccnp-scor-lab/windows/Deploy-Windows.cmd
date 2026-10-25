@echo off
REM Right-click > Run as administrator. Optional: Deploy-Windows.cmd C:\images   (folder with your Cisco .qcow2 files)
net session >nul 2>&1 || (echo Run as administrator. & pause & exit /b 1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Windows-Lab.ps1" -Images "%~1"
pause
