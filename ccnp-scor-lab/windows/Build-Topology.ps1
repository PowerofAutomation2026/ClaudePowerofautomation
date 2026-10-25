# Creates the full SCOR-Core project in GNS3 (nodes, cables, mgmt network), starts it, and pushes day-0 configs.
# Prereq: Install-Windows-Lab.ps1 finished, Cisco images in %USERPROFILE%\GNS3\images\QEMU
param([switch]$NoStart, [switch]$NoPush)
$ErrorActionPreference = "Stop"
function Say($m){ Write-Host ">> $m" -ForegroundColor Cyan }
function Warn($m){ Write-Host "!! $m" -ForegroundColor Yellow }
$api = "http://127.0.0.1:3080/v2"
function Api($m,$p,$b=$null){ $a=@{Uri="$api$p";Method=$m;ContentType="application/json"}; if($null -ne $b){$a.Body=($b|ConvertTo-Json -Depth 10)}; Invoke-RestMethod @a }
$q = (Get-ChildItem "$env:ProgramFiles\qemu\qemu-system-x86_64.exe").FullName
$imgDir = "$env:USERPROFILE\GNS3\images\QEMU"

# ---- make sure the GNS3 server is up ----
try { Api GET "/version" | Out-Null } catch { Say "Starting GNS3..."; Start-Process "$env:ProgramFiles\GNS3\gns3.exe" }
for ($i=0; $i -lt 40; $i++) { try { Api GET "/version" | Out-Null; break } catch { Start-Sleep 3 } }
Api GET "/version" | Out-Null

# ---- device templates from the images present ----
$spec = @(
 @{k="asav";   name="Cisco ASAv";   ram=2048; ad=4; con="telnet"},
 @{k="vios-";  name="Cisco IOSv";   ram=1024; ad=4; con="telnet"},
 @{k="viosl2"; name="Cisco IOSvL2"; ram=1024; ad=8; con="telnet"},
 @{k="lab-desktop"; name="Lab Desktop"; ram=2048; ad=2; con="vnc"},
 @{k="wsa";    name="Cisco WSA";    ram=8192; ad=3; con="telnet"},
 @{k="ise";    name="Cisco ISE";    ram=16384;ad=2; con="vnc"})
$tpl = @{}
foreach ($f in Get-ChildItem $imgDir -Filter *.qcow2) {
  $s = $spec | ? { $f.Name.ToLower().StartsWith($_.k) } | Select -First 1; if (-not $s) { continue }
  $t = Api POST "/templates" @{ template_type="qemu"; name="$($s.name) [$($f.BaseName)]"; qemu_path=$q; hda_disk_image=$f.Name; ram=$s.ram; adapters=$s.ad
        adapter_type="e1000"; console_type=$s.con; platform="x86_64"; options="-accel whpx,kernel-irqchip=off"; category="router"; symbol=":/symbols/classic/router.svg" }
  $tpl[$s.k] = $t.template_id; Say "Template: $($s.name) <- $($f.Name)"
}

# ---- project ----
$name = "SCOR-Core"; $exist = (Api GET "/projects") | ? { $_.name -eq $name }
if ($exist) { Warn "Project '$name' already exists. Delete it in GNS3 first to rebuild."; return }
$p = Api POST "/projects" @{ name=$name }; $pid_ = $p.project_id
function Node($label,$key,$x,$y,$opts=""){
  if (-not $tpl.ContainsKey($key)) { Warn "No image for '$label' ($key*) - skipped"; return $null }
  $n = Api POST "/projects/$pid_/templates/$($tpl[$key])" @{ x=$x; y=$y; compute_id="local" }
  $o = "-accel whpx,kernel-irqchip=off $opts".Trim()
  Api PUT "/projects/$pid_/nodes/$($n.node_id)" @{ name=$label; properties=@{ options=$o } } | Out-Null
  $n | Add-Member name $label -Force -PassThru
}
$asa = Node "FW1-ASAv"  "asav"  0 -120
$r1  = Node "R1"        "vios-" -250 40
$r2  = Node "R2"        "vios-" 250 40
$sw1 = Node "SW1"       "viosl2" -250 200
$cli = Node "Client"    "lab-desktop" -400 330 "-smbios type=1,serial=client"
$out = Node "Outside-Desktop" "lab-desktop" 250 200 "-smbios type=1,serial=outside"
$dmz = Node "DMZ-Server" "lab-desktop" 0 100 "-smbios type=1,serial=dmz"
$cloud = Api POST "/projects/$pid_/nodes" @{ name="Windows-Mgmt"; node_type="cloud"; compute_id="local"; x=-400; y=-250
   properties=@{ ports_mapping=@(@{interface="vEthernet (LabMgmt)"; name="vEthernet (LabMgmt)"; port_number=0; type="ethernet"}) } }
$ports = 0..15 | % { @{ name="Ethernet$_"; port_number=$_; type="access"; vlan=1 } }
$msw = Api POST "/projects/$pid_/nodes" @{ name="MGMT-SW"; node_type="ethernet_switch"; compute_id="local"; x=-250; y=-250; properties=@{ ports_mapping=$ports } }
function Link($a,$ai,$b,$bi){ if (-not $a -or -not $b) { return }
  Api POST "/projects/$pid_/links" @{ nodes=@( @{node_id=$a.node_id;adapter_number=$ai;port_number=0}, @{node_id=$b.node_id;adapter_number=$bi;port_number=0} ) } | Out-Null }
function SLink($a,$ai,$sp){ if (-not $a) { return }
  Api POST "/projects/$pid_/links" @{ nodes=@( @{node_id=$a.node_id;adapter_number=$ai;port_number=0}, @{node_id=$msw.node_id;adapter_number=0;port_number=$sp} ) } | Out-Null }
# data plane
Link $asa 1 $r2 1;  Link $asa 2 $r1 1;  Link $asa 3 $dmz 1
Link $r1 2 $sw1 1;  Link $sw1 2 $cli 1; Link $r2 2 $out 1
# management plane (all mgmt NICs -> MGMT-SW -> Windows loopback switch)
Api POST "/projects/$pid_/links" @{ nodes=@( @{node_id=$cloud.node_id;adapter_number=0;port_number=0}, @{node_id=$msw.node_id;adapter_number=0;port_number=0} ) } | Out-Null
$i = 1; foreach ($d in @(@($asa,0),@($r1,0),@($r2,0),@($sw1,0),@($cli,0),@($out,0),@($dmz,0))) { SLink $d[0] $d[1] $i; $i++ }
Say "Topology built in project '$name'"
if ($NoStart) { return }
Api POST "/projects/$pid_/nodes/start" @{} | Out-Null; Say "All devices starting (IOSv ~2 min, ASAv ~4 min)..."
if ($NoPush) { return }

# ---- day-0 configs over the console (telnet) ----
$cfg = @{}
$cfg["FW1-ASAv"] = @'
hostname ASA1
interface Management0/0
 nameif mgmt
 security-level 99
 ip address 192.168.100.11 255.255.255.0
 no shutdown
interface GigabitEthernet0/0
 nameif outside
 security-level 0
 ip address 203.0.113.1 255.255.255.0
 no shutdown
interface GigabitEthernet0/1
 nameif inside
 security-level 100
 ip address 10.1.1.1 255.255.255.0
 no shutdown
interface GigabitEthernet0/2
 nameif dmz
 security-level 50
 ip address 172.16.1.1 255.255.255.0
 no shutdown
route outside 0.0.0.0 0.0.0.0 203.0.113.2
route inside 10.1.10.0 255.255.255.0 10.1.1.2
object network INSIDE-NETS
 subnet 10.1.0.0 255.255.0.0
 nat (inside,outside) dynamic interface
policy-map global_policy
 class inspection_default
  inspect icmp
username admin password Cisco123! privilege 15
aaa authentication http console LOCAL
http server enable
http 192.168.100.0 255.255.255.0 mgmt
'@
$cfg["R1"] = @'
hostname R1
ip domain-name lab.local
username admin privilege 15 secret Cisco123!
interface GigabitEthernet0/0
 ip address 192.168.100.21 255.255.255.0
 no shutdown
interface GigabitEthernet0/1
 ip address 10.1.1.2 255.255.255.0
 no shutdown
interface GigabitEthernet0/2
 ip address 10.1.10.1 255.255.255.0
 no shutdown
ip route 0.0.0.0 0.0.0.0 10.1.1.1
ip http secure-server
ip http authentication local
line vty 0 4
 login local
'@
$cfg["R2"] = @'
hostname R2
ip domain-name lab.local
username admin privilege 15 secret Cisco123!
interface GigabitEthernet0/0
 ip address 192.168.100.22 255.255.255.0
 no shutdown
interface GigabitEthernet0/1
 ip address 203.0.113.2 255.255.255.0
 no shutdown
interface GigabitEthernet0/2
 ip address 198.51.100.1 255.255.255.0
 no shutdown
ip http secure-server
ip http authentication local
line vty 0 4
 login local
'@
$cfg["SW1"] = @'
hostname SW1
ip domain-name lab.local
username admin privilege 15 secret Cisco123!
vlan 10
interface GigabitEthernet0/0
 switchport mode access
 switchport access vlan 1
interface GigabitEthernet0/1
 switchport mode access
 switchport access vlan 10
 no shutdown
interface GigabitEthernet0/2
 switchport mode access
 switchport access vlan 10
 no shutdown
interface Vlan1
 ip address 192.168.100.23 255.255.255.0
 no shutdown
ip http secure-server
ip http authentication local
line vty 0 4
 login local
'@
function Push($port, $text, $who){
  $c = New-Object Net.Sockets.TcpClient("127.0.0.1", $port); $s = $c.GetStream()
  function Rd { $sb=''; $buf=New-Object byte[] 4096; while($s.DataAvailable){ $n=$s.Read($buf,0,4096); $sb+=[Text.Encoding]::ASCII.GetString($buf,0,$n) }; $sb }
  function Tx($t){ $b=[Text.Encoding]::ASCII.GetBytes($t+"`r"); $s.Write($b,0,$b.Length) }
  $ok = $false; $end = (Get-Date).AddMinutes(12)
  while ((Get-Date) -lt $end) { Tx ""; Start-Sleep 5; $o = Rd
    if ($o -match 'initial configuration dialog') { Tx 'no'; continue }
    if ($o -match '(?m)[\w\-\.]+[>#]\s*$') { $ok = $true; break } }
  if (-not $ok) { Warn "$who console never gave a prompt - paste its config manually (labs/mgmt-guide.md)"; $c.Close(); return }
  Tx 'enable'; Start-Sleep 1; Tx ''; Start-Sleep 1; Tx 'configure terminal'; Start-Sleep 1
  foreach ($l in ($text -replace "`r","" -split "`n")) { if ($l.Trim()) { Tx $l; Start-Sleep -Milliseconds 200 } }
  Tx 'end'; Start-Sleep 1; Tx 'write memory'; Start-Sleep 4; Tx ''; $c.Close(); Say "Configured $who"
}
$nodes = Api GET "/projects/$pid_/nodes"
foreach ($n in $nodes) { if ($cfg.ContainsKey($n.name)) { Push $n.console $cfg[$n.name] $n.name } }
Say "DONE. In GNS3: File > Open project > SCOR-Core. Client RDP: 192.168.100.31 (lab / Cisco123!). See labs/windows-test-plan.md"
