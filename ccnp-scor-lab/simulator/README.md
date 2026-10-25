# SCOR Lab Simulator — no Cisco images needed

A self-contained browser lab that **simulates** Cisco-style devices and a stateful firewall engine, for practising CCNP Security (350-701) firewall / NAT / ACL / FTD policy skills.
Not real Cisco software: command syntax and behaviour follow ASA/IOS/FMC concepts but are approximations (no ISE, WSA, VPN, IPS signatures database, etc.).

## Run it
- **Windows (also on your Azure Windows VM):** double-click `Run-Simulator.cmd` (or open `index.html`). No install, works offline.
- **Host on Azure for anyone with a browser:** in Azure Cloud Shell: `bash deploy-azure-static.sh` → prints the URL.

## What you get
Topology: Outside-Desktop — R2 — **FW1-ASA** — R1 — SW1 — Client, DMZ-Server on the ASA, and R2 — **FTD1** — FTD-Client.
- **Consoles:** IOS-like routers (`show`, `conf t`, ACLs, routes), ASA-like firewall (`object network`, `nat`, `access-list`, `access-group`, `packet-tracer`, `show conn/xlate/access-list`), Linux hosts (`ping curl nmap traceroute ip`).
- **GUIs:** ASDM-style (interfaces, access rules, NAT, routing, **Packet Tracer**, monitoring) and FMC-style for FTD (zones, interfaces, routing, PAT, access-control policy, IPS toggle, **Deploy**, events).
- **Desktop PCs** with a browser; animated packets on the map (green delivered / red dropped, with the dropping device marked).
- **8 auto-graded lab tasks** (publish a server with static NAT + ACL, least privilege, router ACL, FTD interfaces/PAT/policy, IPS blocking). "Show answer" per task. State is saved in your browser; **Reset lab** restarts.

## Logins
The simulated devices need no login. (Real-device logins are in the other lab docs.)

## Extend
`engine.js` (packet/firewall engine), `cli.js` (command lines), `app.js` (UI). Ask for ISE/WSA/VPN modules.
