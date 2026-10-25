# Builds the lab's Ubuntu 22.04 desktop image (XFCE + xrdp + nginx + test tools) with QEMU on this Windows VM. ~30-45 min.
# Output: %USERPROFILE%\GNS3\images\QEMU\lab-desktop.qcow2   (login lab / Cisco123!)
param([string]$Out = "$env:USERPROFILE\GNS3\images\QEMU\lab-desktop.qcow2")
$ErrorActionPreference = "Stop"
function Say($m){ Write-Host ">> $m" -ForegroundColor Cyan }
if (Test-Path $Out) { Say "Already built: $Out"; return }
$q = (Get-ChildItem "$env:ProgramFiles\qemu\qemu-system-x86_64.exe").FullName; $qi = Join-Path (Split-Path $q) "qemu-img.exe"
$w = "$env:TEMP\labdesk"; New-Item -ItemType Directory -Force $w, (Split-Path $Out) | Out-Null
$img = "$env:TEMP\jammy.img"
if (-not (Test-Path $img)) { Say "Downloading Ubuntu 22.04 cloud image..."; Invoke-WebRequest "https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img" -OutFile $img }
$base = "$w\base.qcow2"; Copy-Item $img $base -Force; & $qi resize $base 20G | Out-Null

$labnet = @'
#!/bin/bash
# Per-node identity comes from the QEMU smbios serial set by the topology builder (client|outside|dmz)
ROLE=$(cat /sys/class/dmi/id/product_serial 2>/dev/null)
IFS_=($(ls /sys/class/net | grep -v '^lo$' | sort)); M=${IFS_[0]}; D=${IFS_[1]}
case $ROLE in
  client)  MI=192.168.100.31; DI=10.1.10.10/24;    GW=10.1.10.1;;
  outside) MI=192.168.100.32; DI=198.51.100.10/24; GW=198.51.100.1;;
  dmz)     MI=192.168.100.33; DI=172.16.1.10/24;   GW=172.16.1.1;;
  ftdclient) MI=192.168.100.34; DI=10.2.1.10/24;   GW=10.2.1.1;;
  *) exit 0;;
esac
ip link set $M up; ip addr flush dev $M; ip addr add $MI/24 dev $M
ip link set $D up; ip addr flush dev $D; ip addr add $DI dev $D; ip route replace default via $GW dev $D
hostnamectl set-hostname $ROLE
echo "<h1>$ROLE web server</h1>" > /var/www/html/index.html
if [ "$ROLE" = dmz ]; then   # DNS for the lab (ISE/FMC setup wizards need a resolvable name)
  printf 'listen-address=192.168.100.33\nbind-interfaces\ndomain=lab.local\naddress=/ise1.lab.local/192.168.100.14\naddress=/fmc1.lab.local/192.168.100.13\naddress=/ftd1.lab.local/192.168.100.12\naddress=/asa1.lab.local/192.168.100.11\n' > /etc/dnsmasq.d/lab.conf
  systemctl restart dnsmasq
fi
'@
$ind = { param($t) ($t -replace "`r","" -split "`n" | % { "      $_" }) -join "`n" }
$ud = @"
#cloud-config
hostname: desktop
ssh_pwauth: true
users:
  - name: lab
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: false
chpasswd:
  expire: false
  list: ["lab:Cisco123!", "root:Cisco123!"]
package_update: true
packages: [xubuntu-core, lightdm, firefox, xrdp, nginx, nmap, curl, wget, iperf3, hping3, netcat-openbsd, tcpdump, tshark, dnsutils, traceroute, openssh-server, vim, net-tools, dnsmasq]
write_files:
  - path: /usr/local/sbin/labnet.sh
    permissions: '0755'
    content: |
$(& $ind $labnet)
  - path: /etc/systemd/system/labnet.service
    content: |
      [Unit]
      Description=Lab static addressing
      After=network.target
      [Service]
      Type=oneshot
      RemainAfterExit=yes
      ExecStart=/usr/local/sbin/labnet.sh
      [Install]
      WantedBy=multi-user.target
  - path: /etc/lightdm/lightdm.conf.d/50-auto.conf
    content: |
      [Seat:*]
      autologin-user=lab
runcmd:
  - systemctl set-default graphical.target
  - echo xfce4-session > /home/lab/.xsession
  - chown lab:lab /home/lab/.xsession
  - adduser xrdp ssl-cert
  - systemctl disable dnsmasq
  - systemctl enable xrdp nginx labnet.service
  - rm -f /etc/netplan/*.yaml
  - touch /etc/cloud/cloud-init.disabled
power_state:
  mode: poweroff
  timeout: 7200
"@
$seed = "$w\seed"; New-Item -ItemType Directory -Force $seed | Out-Null
$u8 = New-Object Text.UTF8Encoding $false
[IO.File]::WriteAllText("$seed\user-data", ($ud -replace "`r",""), $u8)
[IO.File]::WriteAllText("$seed\meta-data", "instance-id: labdesk`nlocal-hostname: desktop`n", $u8)
Add-Type @"
using System; using System.IO; using System.Runtime.InteropServices; using System.Runtime.InteropServices.ComTypes;
public class IsoW { public static void Write(object o, string path){ IStream s=(IStream)o; STATSTG st; s.Stat(out st,1); byte[] buf=new byte[2048]; long rem=st.cbSize; IntPtr p=Marshal.AllocHGlobal(4);
 using(FileStream fs=File.Create(path)){ while(rem>0){ int n=(int)Math.Min(2048,rem); s.Read(buf,n,p); int rd=Marshal.ReadInt32(p); if(rd==0)break; fs.Write(buf,0,rd); rem-=rd; } } Marshal.FreeHGlobal(p);} }
"@
$iso = "$w\seed.iso"; Remove-Item $iso -ErrorAction SilentlyContinue
$fs = New-Object -ComObject IMAPI2FS.MsftFileSystemImage; $fs.FileSystemsToCreate = 3; $fs.VolumeName = "cidata"; $fs.Root.AddTree($seed, $false)
[IsoW]::Write($fs.CreateResultImage().ImageStream, $iso)

Say "Building desktop image (VM powers itself off when finished; be patient)..."
& $q -accel "whpx,kernel-irqchip=off" -m 4096 -smp 2 -display none -drive "file=$base,if=virtio" -drive "file=$iso,media=cdrom" `
  -netdev user,id=n0 -device virtio-net-pci,netdev=n0
Move-Item $base $Out -Force
Say "DONE: $Out"
