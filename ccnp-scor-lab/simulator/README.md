# SCOR Lab Simulator — no Cisco images needed

A self-contained browser lab that **simulates** Cisco-style devices and a stateful firewall engine, for practising CCNP Security (350-701) firewall / NAT / ACL / FTD policy skills.
Not real Cisco software: command syntax and behaviour follow ASA/IOS/FMC concepts but are approximations (no ISE, WSA, VPN, IPS signatures database, etc.).

## Run it
- **Windows (also on your Azure Windows VM):** double-click `Run-Simulator.cmd` (or open `index.html`). No install, works offline.
- **Host on Azure for anyone with a browser:** in Azure Cloud Shell: `bash deploy-azure-static.sh` → prints the URL.

## What you get
**Devices (right-click any device on the map → Terminal / GUI / Power):**

| Device | Terminal | GUI |
|---|---|---|
| FW1-ASA (firewall) | ASA-style CLI | ASDM-style: interfaces, access rules, NAT, routing, Packet Tracer, monitoring, tools, config |
| FTD1 + **FMC1** | FTD clish + diagnostic CLI | FMC: overview, interfaces, routing, NAT, access policy (+IPS), deploy, events |
| R1, R2 (routers) | IOS-style CLI | Router manager: interfaces, routes, ACLs, tools, config |
| SW1, DMZ-SW, MGMT-SW (switches) | IOS-style CLI | Switch manager: ports, VLANs, 802.1X/RADIUS, MAC table, config |
| **ISE1** | admin CLI | Live logs, network devices, users/endpoints, authorization policy, profiles (dACL) |
| **ESA1** (email gateway) | status CLI | Mail policies (spam/AV/DLP/SPF/content filters), HAT, domains+DNS, tracking, quarantine, test mail |
| **WSA1** (web proxy) | status CLI | URL-category policies, custom lists, HTTPS decryption, anti-malware, reporting, test request |
| Client, Outside-Desktop, DMZ-Server, FTD-Client | Linux shell (ping, curl, nmap, swaks...) | Desktop browser (with proxy setting), Mail client, 802.1X login |

**Real behaviour behind the screens:** stateful firewall + NAT engine, ISE RADIUS/802.1X authentication with dACLs (and realistic failure reasons: wrong secret, switch not registered, bad password...), ESA mail pipeline (HAT, SPF, spam score, antivirus, content filters, DLP), WSA proxy (categories, HTTPS decryption blind spot, malware blocking), animated packets on the map.

**20 auto-graded lab tasks** (firewall, FTD/FMC policy + Deploy, ISE 802.1X + dACL, ESA/WSA Commit, port-security, VLANs) with hints and answers; progress saved in your browser. Start screen lets you choose which devices are powered on.

## How to use it (2 ways to open anything)
1. **Click a device on the map** - an action bar appears under the map with **Terminal / Open GUI / Power on-off** buttons.
2. Or **right-click** it (menu) / **double-click** it.

GUIs open like application windows (full size). Use **—** to minimize (the window stays in the taskbar at the top), **▢** for full-screen/restore, **✕** to close.

## If something does not work
- Press **Self-test** (top right): it checks the right-click menu, terminal, GUI and power on/off of every device in *your* browser and lists exactly what fails.
- A red bar at the top shows any error message - send me that text. Its **Reset lab** button clears saved data.
- Saved labs are versioned: an old saved lab from an earlier version is discarded automatically (this was the cause of "right-click FTD/ASA GUI errors").
- Automated tests: `npm i playwright` then `node tests/e2e.cjs` (293 checks: every device menu/power/GUI, a 163-page GUI sweep, stale-save recovery, the self-test, and all 20 lab tasks done through the GUIs).

## Product-style GUIs
ASDM-style (toolbar + navigation tree), FMC-style (top menu, **Deploy** workflow), ISE-style (Home / Operations / Policy / Administration), ESA and WSA (AsyncOS-style: edits stay **pending until Commit Changes**), IOS web-UI style for routers and switches.

## Logins
The simulated devices need no login. (Real-device logins are in the other lab docs.)

## Extend
See `COMMANDS.md` for every supported command.

`engine.js` (packet/firewall engine), `cli.js` (command lines), `app.js` (UI). Ask for ISE/WSA/VPN modules.
