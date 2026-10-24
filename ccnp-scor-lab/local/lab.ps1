param([string]$Action = "up", [string]$Arg = "")
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }  # EVE uses a self-signed cert
$Root = Split-Path $PSScriptRoot -Parent
$S = Join-Path $Root ".lab"; New-Item -ItemType Directory -Force $S | Out-Null
$VM = "SCOR-Lab"; $User = "labadmin"
$Key = Join-Path $S "id_ed25519"
function Say($m){ Write-Host ">> $m" -ForegroundColor Cyan }
function Ok($m){ Write-Host "OK $m" -ForegroundColor Green }
function Die($m){ Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }

# ---------- VirtualBox ----------
function Get-VBox {
  $p = "$env:ProgramFiles\Oracle\VirtualBox\VBoxManage.exe"
  if (-not (Test-Path $p)) {
    Say "Installing VirtualBox via winget..."
    winget install -e --id Oracle.VirtualBox --silent --accept-package-agreements --accept-source-agreements
    if (-not (Test-Path $p)) { Die "VirtualBox install failed. Install it from virtualbox.org and re-run." }
  }
  return $p
}
$VB = Get-VBox
function VBM { & $VB @args; if ($LASTEXITCODE -ne 0) { Die "VBoxManage $($args -join ' ') failed" } }
$SshO = @("-i",$Key,"-p","2222","-o","StrictHostKeyChecking=no","-o","UserKnownHostsFile=NUL","-o","LogLevel=ERROR","-o","ConnectTimeout=10")
$ScpO = @("-i",$Key,"-P","2222","-o","StrictHostKeyChecking=no","-o","UserKnownHostsFile=NUL","-o","LogLevel=ERROR")

function Send-Images($dir) {
  if (-not (Test-Path $dir)) { Die "Folder not found: $dir" }
  foreach ($f in Get-ChildItem $dir -Filter *.qcow2) {
    $n = $f.BaseName; Say "Uploading $n (this can take a while)"
    ssh @SshO "$User@127.0.0.1" "sudo mkdir -p /opt/unetlab/addons/qemu/$n && sudo chown $User /opt/unetlab/addons/qemu/$n"
    scp @ScpO $f.FullName "$User@127.0.0.1:/opt/unetlab/addons/qemu/$n/virtioa.qcow2"
  }
  ssh @SshO "$User@127.0.0.1" "sudo /opt/unetlab/wrappers/unl_wrapper -a fixpermissions"
  Ok "Images ready - refresh the EVE GUI"
}

switch ($Action) {
 "status" { VBM showvminfo $VM --machinereadable | Select-String 'VMState='; try { Invoke-WebRequest https://127.0.0.1:8443 -UseBasicParsing | Out-Null; Ok "EVE GUI up: https://localhost:8443" } catch { Write-Host "GUI not reachable" }; return }
 "stop"   { VBM controlvm $VM acpipoweroff; Ok "Stopped (RAM freed)"; return }
 "start"  { VBM startvm $VM --type headless; Ok "Starting - GUI in ~1 min: https://localhost:8443"; return }
 "desktop" { scp @ScpO (Join-Path $Root "scripts\build-ubuntu-desktop.sh") "$User@127.0.0.1:/tmp/"; ssh @SshO "$User@127.0.0.1" "sudo bash /tmp/build-ubuntu-desktop.sh desktop && sudo bash /tmp/build-ubuntu-desktop.sh admin"; return }
 "images" { Send-Images $Arg; return }
 "down"   { $a = Read-Host "Delete the VM and ALL its disks? [y/N]"; if ($a -eq "y") { try{VBM controlvm $VM poweroff}catch{}; Start-Sleep 3; VBM unregistervm $VM --delete; Ok "Deleted" }; return }
}

# ---------- UP ----------
if (((& $VB list vms) -join "") -match "`"$VM`"") { Die "VM '$VM' already exists. Use: stop/start/down" }

# Hyper-V check: VirtualBox cannot do nested virtualization while Windows Hypervisor is active
$hv = (bcdedit /enum '{current}' | Select-String hypervisorlaunchtype) -join ""
if ($hv -match "Auto") { Write-Host "WARNING: Windows Hypervisor (Hyper-V/WSL2/Core Isolation) is ON. Nested virtualization will NOT work, so Cisco images will be unbearably slow or fail. Fix: run 'bcdedit /set hypervisorlaunchtype off' and reboot (undo with 'auto')." -ForegroundColor Yellow; $c = Read-Host "Continue anyway? [y/N]"; if ($c -ne "y") { exit 1 } }

$totalMB = [int]((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB)
$ram = [Math]::Min(49152, [int]($totalMB * 0.65)); if ($ram -lt 8192) { Write-Host "Only $totalMB MB RAM: ASAv/IOSv labs OK; FTD/FMC/ISE will not fit." -ForegroundColor Yellow }
$cpu = [Math]::Max(2, [Math]::Min(12, [int]((Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors * 0.75)))
Say "VM sizing: $cpu vCPU, $ram MB RAM, 200 GB disk (sparse)"

if (-not (Test-Path $Key)) { ssh-keygen -t ed25519 -N '""' -f $Key -q; Ok "SSH key created" }
$pub = (Get-Content "$Key.pub" -Raw).Trim()
$passFile = Join-Path $S "eve_pass"
if (-not (Test-Path $passFile)) { -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 16 | % {[char]$_}) | Set-Content $passFile }
$pass = (Get-Content $passFile).Trim()

# 1) Ubuntu 22.04 cloud OVA
$dl = Join-Path $S "dl"; New-Item -ItemType Directory -Force $dl | Out-Null
$ova = Join-Path $dl "jammy.ova"
if (-not (Test-Path $ova)) { Say "Downloading Ubuntu 22.04 (~700 MB)..."; Invoke-WebRequest "https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.ova" -OutFile $ova }

# 2) cloud-init seed ISO (cidata)
$seedDir = Join-Path $dl "seed"; Remove-Item $seedDir -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $seedDir | Out-Null
$inst = (Get-Content (Join-Path $Root "scripts\install-eve.sh") -Raw) -replace "`r","" -split "`n" | % { "      $_" }
$ud = @"
#cloud-config
hostname: eve
ssh_pwauth: false
users:
  - name: $User
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - $pub
write_files:
  - path: /root/install-eve.sh
    permissions: '0755'
    content: |
$($inst -join "`n")
runcmd:
  - [ bash, -c, "/root/install-eve.sh" ]
"@
[IO.File]::WriteAllText("$seedDir\user-data", ($ud -replace "`r",""), (New-Object Text.UTF8Encoding $false))
[IO.File]::WriteAllText("$seedDir\meta-data", "instance-id: scor-lab`nlocal-hostname: eve`n", (New-Object Text.UTF8Encoding $false))
Add-Type @"
using System; using System.IO; using System.Runtime.InteropServices; using System.Runtime.InteropServices.ComTypes;
public class IsoW { public static void Write(object o, string path){ IStream s=(IStream)o; STATSTG st; s.Stat(out st,1); byte[] buf=new byte[2048]; long rem=st.cbSize; IntPtr p=Marshal.AllocHGlobal(4);
 using(FileStream fs=File.Create(path)){ while(rem>0){ int n=(int)Math.Min(2048,rem); s.Read(buf,n,p); int rd=Marshal.ReadInt32(p); if(rd==0)break; fs.Write(buf,0,rd); rem-=rd; } } Marshal.FreeHGlobal(p);} }
"@
$iso = Join-Path $dl "seed.iso"; Remove-Item $iso -ErrorAction SilentlyContinue
$fs = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
$fs.FileSystemsToCreate = 3; $fs.VolumeName = "cidata"; $fs.Root.AddTree($seedDir, $false)
[IsoW]::Write($fs.CreateResultImage().ImageStream, $iso)
Ok "cloud-init seed built"

# 3) Import + configure VM
Say "Importing VM..."
VBM import $ova --vsys 0 --vmname $VM --cpus $cpu --memory $ram
VBM modifyvm $VM --nested-hw-virt on --uart1 off --uartmode1 disconnected --nic1 nat --nictype1 virtio --graphicscontroller vmsvga --vram 16 --paravirtprovider kvm
# grow disk (clone vmdk -> vdi, resize)
$info = & $VB showvminfo $VM --machinereadable
$hd = ($info | Select-String '^"(.+)-(\d+)-(\d+)"="(.+\.vmdk)"' | Select-Object -First 1).Matches[0]
$ctl = $hd.Groups[1].Value; $port = $hd.Groups[2].Value; $dev = $hd.Groups[3].Value; $vmdk = $hd.Groups[4].Value
$vdi = Join-Path $dl "eve-disk.vdi"; Remove-Item $vdi -ErrorAction SilentlyContinue
VBM clonemedium disk "$vmdk" "$vdi" --format VDI
VBM modifymedium disk "$vdi" --resize 204800
VBM storageattach $VM --storagectl $ctl --port $port --device $dev --type hdd --medium "$vdi"
VBM storagectl $VM --name "seed" --add sata
VBM storageattach $VM --storagectl "seed" --port 1 --device 0 --type dvddrive --medium $iso
# NAT forwards: SSH, web GUI, node consoles
VBM modifyvm $VM --natpf1 "ssh,tcp,127.0.0.1,2222,,22"
VBM modifyvm $VM --natpf1 "https,tcp,127.0.0.1,8443,,443"
VBM modifyvm $VM --natpf1 "http,tcp,127.0.0.1,8080,,80"
32768..32868 | % { VBM modifyvm $VM --natpf1 "con$_,tcp,127.0.0.1,$_,,$_" }
VBM startvm $VM --type headless
Ok "VM started. EVE-NG installs itself (~20-30 min incl. reboot)"

# 4) Wait, then post-install
$ready = $false
for ($i = 0; $i -lt 160 -and -not $ready; $i++) {
  Start-Sleep 15; Write-Host -NoNewline "."
  try { ssh @SshO "$User@127.0.0.1" "sudo test -f /root/.eve-installed" 2>$null; if ($LASTEXITCODE -eq 0) { Invoke-WebRequest https://127.0.0.1:8443 -UseBasicParsing -TimeoutSec 5 | Out-Null; $ready = $true } } catch {}
}
Write-Host ""; if (-not $ready) { Die "Timed out. Check VM in VirtualBox; log: /var/log/eve-install.log" }
scp @ScpO (Join-Path $Root "labs\scor-core.unl") (Join-Path $Root "scripts\post-install.sh") "$User@127.0.0.1:/tmp/"
ssh @SshO "$User@127.0.0.1" "bash /tmp/post-install.sh '$pass'"
if ($Arg) { Send-Images $Arg }
scp @ScpO (Join-Path $Root "scripts\build-ubuntu-desktop.sh") "$User@127.0.0.1:/tmp/"
ssh @SshO "$User@127.0.0.1" "sudo bash /tmp/build-ubuntu-desktop.sh desktop && sudo bash /tmp/build-ubuntu-desktop.sh admin"

"window.LAB={ip:`"localhost:8443`",pass:`"$pass`",cloud:`"local`"};" | Set-Content (Join-Path $Root "portal\config.js")
Start-Process (Join-Path $Root "portal\index.html")
Ok "READY  https://localhost:8443   user: admin   pass: $pass"
Write-Host "Upload Cisco images:  Deploy-Local.cmd images `"C:\path\to\qcow2s`"   |  Stop:  Deploy-Local.cmd stop"
