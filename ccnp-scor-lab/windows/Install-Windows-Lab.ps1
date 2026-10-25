# ONE-COMMAND zero-touch install of the SCOR lab on a Windows (Azure) VM.  Admin PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\Install-Windows-Lab.ps1 -Images C:\images
# Run it again after the reboot it asks for.  Needs a nested-virtualization VM size (Dsv3/Dsv4/Dsv5...), 8+ vCPU recommended.
param([string]$Images = "")
$ErrorActionPreference = "Stop"
function Say($m){ Write-Host ">> $m" -ForegroundColor Cyan }
function Warn($m){ Write-Host "!! $m" -ForegroundColor Yellow }
function Die($m){ Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole("Administrator")) { Die "Run in an ADMIN PowerShell." }
$cs = Get-CimInstance Win32_ComputerSystem; $cpu = $cs.NumberOfLogicalProcessors; $ram = [int]($cs.TotalPhysicalMemory/1GB); $free = [int]((Get-PSDrive C).Free/1GB)
Say "This VM: $cpu vCPU, $ram GB RAM, $free GB free on C:"
if ($cpu -lt 4) { Warn "Only $cpu vCPU: far too slow. Resize to Standard_D8s_v5 in the Portal (Windows is kept)." }
if ($ram -lt 24) { Warn "Under 24 GB RAM: the full topology will not fit." }
if ($free -lt 60) { Die "Need >= 60 GB free on C: (120+ recommended). Expand the OS disk in the Portal, then extend C: in Disk Management." }

# 1) Windows features (reboot once)
$need = $false
foreach ($feat in "HypervisorPlatform","Microsoft-Hyper-V-All") {
  if ((Get-WindowsOptionalFeature -Online -FeatureName $feat).State -ne "Enabled") { Say "Enabling $feat"; Enable-WindowsOptionalFeature -Online -FeatureName $feat -All -NoRestart | Out-Null; $need = $true } }
if ($need) { Warn "REBOOT the VM now, then run this same command again."; exit 0 }

# 2) software
function WG($id){ Say "Installing $id"; winget install -e --id $id --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null }
WG "SoftwareFreedomConservancy.QEMU"; WG "Mozilla.Firefox"; WG "WiresharkFoundation.Wireshark"; WG "PuTTY.PuTTY"; WG "WinSCP.WinSCP"
if (-not (Test-Path "$env:ProgramFiles\GNS3\gns3.exe")) {
  Say "Downloading GNS3..."; $rel = Invoke-RestMethod "https://api.github.com/repos/GNS3/gns3-gui/releases/latest" -Headers @{ "User-Agent"="scor-lab" }
  $a = $rel.assets | ? { $_.name -match "all-in-one.*\.exe$" } | Select -First 1; if (-not $a) { Die "GNS3 installer not found - install from gns3.com, re-run." }
  $exe = "$env:TEMP\gns3-setup.exe"; Invoke-WebRequest $a.browser_download_url -OutFile $exe; Say "Installing GNS3 (silent)..."; Start-Process $exe -ArgumentList "/S" -Wait }
if (-not (Test-Path "$env:ProgramFiles\qemu\qemu-system-x86_64.exe")) { Die "QEMU missing - install from qemu.org (Windows) and re-run." }

# 3) management network: Hyper-V internal switch = your Windows VM on 192.168.100.1
if (-not (Get-VMSwitch -Name LabMgmt -ErrorAction SilentlyContinue)) { Say "Creating LabMgmt network"; New-VMSwitch -Name LabMgmt -SwitchType Internal | Out-Null }
$ifa = "vEthernet (LabMgmt)"
if (-not (Get-NetIPAddress -InterfaceAlias $ifa -IPAddress 192.168.100.1 -ErrorAction SilentlyContinue)) { New-NetIPAddress -InterfaceAlias $ifa -IPAddress 192.168.100.1 -PrefixLength 24 | Out-Null }
Set-NetConnectionProfile -InterfaceAlias $ifa -NetworkCategory Private -ErrorAction SilentlyContinue

# 4) images
$imgDir = "$env:USERPROFILE\GNS3\images\QEMU"; New-Item -ItemType Directory -Force $imgDir | Out-Null
if ($Images -and (Test-Path $Images)) { Say "Copying Cisco images..."; Copy-Item "$Images\*.qcow2" $imgDir -Force }
Copy-Item "$PSScriptRoot\..\labs\mgmt-guide.md" "$env:USERPROFILE\Desktop\SCOR-device-urls-and-logins.md" -Force -ErrorAction SilentlyContinue
& "$PSScriptRoot\Build-Desktop-Image.ps1"

# 5) topology + start + day-0 configs
& "$PSScriptRoot\Build-Topology.ps1"
Say "ALL DONE. Open Firefox here for device GUIs (ASDM https://192.168.100.11/admin ...). Client desktop: mstsc -> 192.168.100.31 (lab / Cisco123!)."
