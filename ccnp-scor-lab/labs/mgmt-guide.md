# Reaching EVERY device's GUI (one browser, one jump box)

All devices' management ports sit on one internal network **MGMT 192.168.100.0/24**.
**JumpBox** (Ubuntu desktop, has Firefox) is on it. Click JumpBox in EVE-NG -> desktop opens in your browser -> browse to the device.

| Device | Mgmt IP | GUI URL (from JumpBox) | Login |
|---|---|---|---|
| FMC1 | 192.168.100.13 | https://192.168.100.13 | admin / (set at FMC setup) |
| FTD1 | 192.168.100.12 | managed via FMC (or FDM at https://192.168.100.12 if standalone) | |
| FW1-ASAv | 192.168.100.11 | https://192.168.100.11/admin (ASDM) | admin / Cisco123! |
| ISE1 | 192.168.100.14 | https://192.168.100.14/admin | admin / (setup wizard) |
| R1 / R2 / SW1 | .21 / .22 / .23 | https://<ip> (IOS web UI) | admin / Cisco123! |
| JumpBox (admin desktop) | 192.168.100.10 (pre-set) | - | lab / Cisco123! |

## Day-0 commands (paste into each device's console in EVE-NG)
**JumpBox** (console): `sudo ip addr add 192.168.100.10/24 dev ens3; sudo ip link set ens3 up`  (iface name may be eth0/ens3)

**ASAv**
```
interface Management0/0
 nameif mgmt
 security-level 100
 ip address 192.168.100.11 255.255.255.0
 no shutdown
username admin password Cisco123! privilege 15
aaa authentication http console LOCAL
http server enable
http 192.168.100.0 255.255.255.0 mgmt
```
**FTD** (CLI): `configure network ipv4 manual 192.168.100.12 255.255.255.0 192.168.100.1` then
`configure manager add 192.168.100.13 cisco123`   (FMC: Devices > Add Device, same key)

**FMC** (console first boot wizard): IP 192.168.100.13/24, gw 192.168.100.1, set admin password.
**ISE** (console wizard): hostname ise1, IP 192.168.100.14/24, gw 192.168.100.1, DNS 192.168.100.10, set admin password. Wait ~30 min after setup for the GUI.

**R1 / R2 / SW1** (IOS), change IP per device (.21/.22/.23):
```
interface GigabitEthernet0/0
 ip address 192.168.100.21 255.255.255.0
 no shutdown
username admin privilege 15 secret Cisco123!
ip http secure-server
ip http authentication local
```
## RAM reality
Don't boot everything: ASAv-or-FTD, not both, unless you have 64 GB. Full set is ~66 GB.
Typical combos: Network labs = ASAv+R1+R2+SW1+JumpBox (~9 GB). NAC = + ISE1 (~25 GB). FTD = FTD1+FMC1+JumpBox+WebSrv (~42 GB).
Image names in lab: edit in EVE (Edit node > Image) if yours differ.

## Desktop machines for testing firewall policy (full XFCE GUI + Firefox, nmap, curl, hping3, iperf3, tshark)
Built automatically by deploy (or run `./deploy.sh desktop` / `local\Deploy-Local.cmd desktop`). Login `lab` / `Cisco123!`, auto-logs in.
- **Client** (inside, behind SW1/R1) - test outbound policy: browse/curl/ping to WebSrv and "internet".
- **Outside-Desktop** (outside, behind R2) - test inbound: NAT/port-forwards, nmap scans, IPS triggers (`curl -A "sqlmap"`, EICAR file).
- **JumpBox** - management network only; use its Firefox to open FMC/ASDM/ISE.
In each desktop terminal set an address, e.g. Client: `sudo ip addr add 10.1.1.10/24 dev ens3; sudo ip route add default via 10.1.1.1`.
(Interface name may be ens3/eth0: check `ip a`.) The routers/firewall still need their data-plane IP/routes.

## Admin desktop (JumpBox) - full admin workstation
Image `linux-ubuntu-admin-22.04`: XFCE desktop, auto-login, **static IP 192.168.100.10 already set** (no manual config),
desktop icons that open FMC / ASDM / ISE / R1 / R2 / SW1 / FDM in Firefox, plus Wireshark (GUI), PuTTY, minicom, Remmina (RDP/VNC/SSH),
FileZilla, Git, Ansible, Python with Netmiko + requests. Note: ASDM's Java launcher is not included (use the web UI of the other devices, or the ASA CLI).
