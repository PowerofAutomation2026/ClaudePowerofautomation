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
