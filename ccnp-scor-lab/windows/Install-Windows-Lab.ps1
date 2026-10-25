# SCOR lab NATIVE on a Windows 10/11 Azure VM (no Linux VM): GNS3 + QEMU (WHPX acceleration) + tools.
# Run in an ADMIN PowerShell:   powershell -ExecutionPolicy Bypass -File .\Install-Windows-Lab.ps1 [-Images C:\images]
# -Images = folder of Cisco .qcow2 files named like asav-9.20.qcow2, vios-15.9.qcow2, viosl2-15.2.qcow2 ...
param([string]$Images = "")
$ErrorActionPreference = "Stop"
function Say($m){ Write-Host ">> $m" -ForegroundColor Cyan }
function Warn($m){ Write-Host "!! $m" -ForegroundColor Yellow }
function Die($m){ Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole("Administrator")) { Die "Run in an Administrator PowerShell." }

# ---- preflight ----
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = $cs.NumberOfLogicalProcessors; $ram = [int]($cs.TotalPhysicalMemory/1GB)
$free = [int]((Get-PSDrive C).Free/1GB)
Say "This VM: $cpu vCPU, $ram GB RAM, $free GB free on C:"
if ($cpu -lt 4) { Warn "Only $cpu vCPU: expect ASAv/IOSv to be very slow. Resize the VM to 8 vCPU (Portal > VM > Size > Standard_D8s_v5 - Windows stays intact)." }
if ($free -lt 60) { Die "Need >= 60 GB free on C: (150+ recommended). Expand the OS disk in the Portal, then extend C: in Disk Management." }
if (-not (Get-CimInstance Win32_Processor | Select -First 1).VirtualizationFirmwareEnabled -and -not $cs.HypervisorPresent) {
  Die "No virtualization exposed. Use a nested-virtualization VM size (Dsv3/Dsv4/Dsv5, Ddsv5, Esv3/Esv5, Fsv2; NOT B-series/Av2)." }

# ---- Windows Hypervisor Platform (needed for QEMU acceleration) ----
$f = Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform
if ($f.State -ne "Enabled") {
  Say "Enabling Windows Hypervisor Platform..."; Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All -NoRestart | Out-Null
  Warn "REBOOT the VM now, then run this script again."; exit 0 }

# ---- software ----
function WG($id){ Say "Installing $id"; winget install -e --id $id --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null }
WG "SoftwareFreedomConservancy.QEMU"; WG "Mozilla.Firefox"; WG "WiresharkFoundation.Wireshark"; WG "PuTTY.PuTTY"; WG "WinSCP.WinSCP"; WG "Python.Python.3.12"
$gns = "$env:ProgramFiles\GNS3\gns3.exe"
if (-not (Test-Path $gns)) {
  Say "Downloading GNS3 all-in-one..."
  $rel = Invoke-RestMethod "https://api.github.com/repos/GNS3/gns3-gui/releases/latest" -Headers @{ "User-Agent" = "scor-lab" }
  $a = $rel.assets | ? { $_.name -match "all-in-one.*\.exe$" } | Select -First 1
  if (-not $a) { Die "Could not find GNS3 installer. Download from gns3.com and re-run." }
  $exe = "$env:TEMP\gns3-setup.exe"; Invoke-WebRequest $a.browser_download_url -OutFile $exe
  Say "Installing GNS3 (silent)..."; Start-Process $exe -ArgumentList "/S" -Wait
}
$q = (Get-ChildItem "$env:ProgramFiles\qemu\qemu-system-x86_64.exe" -ErrorAction SilentlyContinue | Select -First 1).FullName
if (-not $q) { Die "QEMU not found in Program Files\qemu - install from qemu.org and re-run." }

# ---- folders + images ----
$imgDir = "$env:USERPROFILE\GNS3\images\QEMU"; New-Item -ItemType Directory -Force $imgDir | Out-Null
if ($Images -and (Test-Path $Images)) { Say "Copying images..."; Copy-Item "$Images\*.qcow2" $imgDir -Force }
Copy-Item "$PSScriptRoot\..\labs\mgmt-guide.md" "$env:USERPROFILE\Desktop\SCOR-device-urls-and-logins.md" -Force -ErrorAction SilentlyContinue

# ---- GNS3 templates (via local server API; start GNS3 once so the server runs) ----
Say "Starting GNS3 to register device templates..."
Start-Process $gns; Start-Sleep 25
$spec = @{
  "asav"   = @{ name="Cisco ASAv";  ram=2048; ad=4; type="e1000"; console="telnet" }
  "vios-"  = @{ name="Cisco IOSv";  ram=1024; ad=4; type="e1000"; console="telnet" }
  "viosl2" = @{ name="Cisco IOSvL2";ram=1024; ad=8; type="e1000"; console="telnet" }
  "wsa"    = @{ name="Cisco WSA";   ram=8192; ad=3; type="e1000"; console="telnet" }
  "ise"    = @{ name="Cisco ISE";   ram=16384;ad=2; type="e1000"; console="vnc" }
}
foreach ($f in Get-ChildItem $imgDir -Filter *.qcow2) {
  $k = $spec.Keys | ? { $f.Name.ToLower().StartsWith($_) } | Sort Length -Desc | Select -First 1
  if (-not $k) { continue }; $s = $spec[$k]
  $body = @{ template_type="qemu"; name="$($s.name) ($($f.BaseName))"; qemu_path=$q; hda_disk_image=$f.Name; ram=$s.ram; adapters=$s.ad
             adapter_type=$s.type; console_type=$s.console; platform="x86_64"; options="-accel whpx,kernel-irqchip=off"; category="router"; symbol=":/symbols/classic/router.svg" } | ConvertTo-Json
  try { Invoke-RestMethod -Uri "http://127.0.0.1:3080/v2/templates" -Method Post -ContentType "application/json" -Body $body | Out-Null; Say "Template added: $($s.name) ($($f.Name))" }
  catch { Warn "Could not auto-add template for $($f.Name): add it in GNS3 (File > New template > Qemu VM). $($_.Exception.Message)" }
}
Say "DONE. Open GNS3 (desktop icon). Next: read WINDOWS-GUIDE.md (build topology, management network, device GUIs)."
