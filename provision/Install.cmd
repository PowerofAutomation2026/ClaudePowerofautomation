@echo off
setlocal
where node >nul 2>nul || (echo Installing Node.js LTS... & winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements & echo. & echo Node.js installed. Close this window, open a NEW terminal and run Install.cmd again. & pause & exit /b 1)
where az >nul 2>nul || (echo Installing Azure CLI... & winget install -e --id Microsoft.AzureCLI --accept-source-agreements --accept-package-agreements & echo. & echo Azure CLI installed. Close this window, open a NEW terminal and run Install.cmd again. & pause & exit /b 1)
node "%~dp0provision.mjs" %*
echo.
pause
