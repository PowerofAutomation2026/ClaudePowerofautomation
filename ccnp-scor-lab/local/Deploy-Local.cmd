@echo off
REM CCNP SCOR Lab - zero-touch LOCAL install (Windows + VirtualBox).  Double-click, or:
REM   Deploy-Local.cmd [up|status|stop|start|down|images "C:\path\to\qcow2s"]
REM Run from an elevated prompt the first time (needs to install VirtualBox via winget).
net session >nul 2>&1 || (echo Right-click and "Run as administrator" for first install. & pause & exit /b 1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lab.ps1" %*
pause
