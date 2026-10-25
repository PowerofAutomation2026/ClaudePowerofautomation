# Windows/GNS3 lab: addressing + firewall-policy tests

| Device | Mgmt (browse/RDP from the Windows VM) | Data IP |
|---|---|---|
| ASAv | https://192.168.100.11/admin (admin / Cisco123!) | outside 203.0.113.1, inside 10.1.1.1, dmz 172.16.1.1 |
| R1 | https://192.168.100.21 | 10.1.1.2 (to ASA), 10.1.10.1 (LAN) |
| R2 | https://192.168.100.22 | 203.0.113.2, 198.51.100.1 |
| SW1 | https://192.168.100.23 | VLAN10 access ports |
| **Client** (Ubuntu desktop) | `mstsc` -> 192.168.100.31, user lab / Cisco123! | 10.1.10.10 gw 10.1.10.1 |
| **Outside-Desktop** | `mstsc` -> 192.168.100.32 | 198.51.100.10 gw 198.51.100.1 |
| **DMZ-Server** (nginx) | `mstsc` -> 192.168.100.33 | 172.16.1.10 gw 172.16.1.1 |

Windows VM = your admin PC: browser for device GUIs, `mstsc` (Remote Desktop) for the Linux desktops, PuTTY for consoles.
Base state: inside->outside/DMZ allowed (PAT on), outside->anything denied. Add the policy, then test.

## Exercise 1 - baseline (from Client, in the RDP desktop terminal)
`ping 172.16.1.10` (inside->DMZ ok) · `curl http://172.16.1.10` (page "dmz web server") · `ping 198.51.100.10` (inside->outside via PAT)
On ASA CLI: `show xlate`, `show conn`.
## Exercise 2 - publish the DMZ web server (you create the policy in ASDM or CLI)
```
object network DMZ-WEB
 host 172.16.1.10
 nat (dmz,outside) static 203.0.113.10
access-list OUT-IN extended permit tcp any object DMZ-WEB eq 80
access-group OUT-IN in interface outside
```
Test from Outside-Desktop: `curl http://203.0.113.10` -> works. Before the ACL it fails; `packet-tracer input outside tcp 198.51.100.10 1234 203.0.113.10 80` shows why.
## Exercise 3 - block + log: deny inside->DMZ port 80, permit ICMP only; verify with Client curl/ping and `show access-list`.
## Exercise 4 - scan/IPS: from Outside-Desktop `nmap -Pn 203.0.113.10`; compare open ports before/after ACL.

## FTD / FMC / ISE (Windows lab)  — RAM profiles
Start only what fits: `windows\Switch-Profile.ps1 -Profile network|ftd|nac|all`
| Profile | Devices started | RAM needed | Azure size |
|---|---|---|---|
| network | ASAv, R1, R2, SW1, Client, Outside, DMZ | ~12 GB | D8s_v5 (32 GB) |
| ftd | FTD1, FMC1, R2, FTD-Client, Outside, DMZ | ~42 GB | D16s_v5 (64 GB) |
| nac | ISE1, R1, SW1, Client, DMZ | ~22 GB | D8s_v5 |
| all | everything | ~70 GB | **E16s_v5 (128 GB)** |

| Device | URL (Firefox on the Windows VM) | Login |
|---|---|---|
| FMC1 | https://192.168.100.13 | admin / password set in its wizard (suggest Cisco123!) |
| FTD1 | managed in FMC (CLI via GNS3 console) | admin / Cisco123! |
| ISE1 | https://192.168.100.14/admin | admin / password set in its wizard |
| FTD-Client | mstsc 192.168.100.34 | lab / Cisco123! |

FTD path: R2 Gi0/3 192.0.2.2 -- FTD1 Gi0/0 (outside, set 192.0.2.1/24) ; FTD1 Gi0/1 (inside, set 10.2.1.1/24) -- FTD-Client 10.2.1.10.
### FMC / ISE first-boot wizards (do in the GNS3 console, VNC)
- **FMC1** (login admin / Admin123, accept EULA, new password): hostname `fmc1`, IPv4 manual `192.168.100.13` / `255.255.255.0` / gw `192.168.100.1`, DNS `192.168.100.33`. Wait ~15 min, then browse https://192.168.100.13.
- **ISE1** (login `setup`, no password): hostname `ise1`, IP `192.168.100.14`, mask `255.255.255.0`, gw `192.168.100.1`, domain `lab.local`, DNS `192.168.100.33` (DMZ-Server must be running - it answers ise1.lab.local), timezone UTC, admin `admin` / `Cisco123!`. Install runs 30+ min.
### FTD in FMC (create + test policy)
1. FTD1 is pre-pointed at FMC (`configure manager add 192.168.100.13 cisco123`). In FMC: Devices > Device Management > Add > Device: host `192.168.100.12`, key `cisco123`.
2. Interfaces: Gi0/0 = outside 192.0.2.1/24, Gi0/1 = inside 10.2.1.1/24 (security zones OUT/IN). Routing: default route to 192.0.2.2. NAT: dynamic PAT IN->OUT.
3. Access policy: allow IN->OUT, block OUT->IN; enable intrusion policy + logging. Deploy.
4. Test from FTD-Client: `ping 198.51.100.10`, `curl http://172.16.1.10` ; from Outside-Desktop `nmap 192.0.2.1`. Watch Analysis > Connection Events.
