# Deploy to Azure — step by step (incl. the FTD / FMC GUI)

## 0. Before you start
- An Azure subscription with **16 vCPU quota** for `Standard_DSv5` in your region (Portal > Subscriptions > Usage + quotas; request +16 if needed). Cost ≈ US$0.8/h + disk; auto-shutdown 23:00 UTC.
- Your Cisco images (you must own/licence them): **FMCv** and **FTDv** KVM `.qcow2`, plus ASAv/IOSv/IOSvL2/ISE/WSA if wanted.
- Your home public IP: https://api.ipify.org

## 1. Deploy (easiest: Azure Cloud Shell — nothing to install)
1. Open https://shell.azure.com -> choose **Bash**.
2. Upload `ccnp-scor-lab.zip` (upload icon), then:
```bash
unzip ccnp-scor-lab.zip && cd ccnp-scor-lab
MY_IP=YOUR.HOME.IP ./deploy.sh up azure
```
`MY_IP` lets your browser in (Cloud Shell's own IP is allowed automatically). Takes ~25 min. At the end it prints
`https://<ip>  user: admin  pass: <random>`. (From a Linux/Mac/WSL shell with `az` installed, same command works.)

## 2. Load the Cisco images onto the server
Big files? Do **not** push them through Cloud Shell. Either
- host them somewhere you control (Azure Storage SAS link, OneDrive direct link) and run
  `./deploy.sh fetch "<URL>" firepower6-FMC-7.4.1` and `./deploy.sh fetch "<URL>" firepower6-FTD-7.4.1`, or
- from your PC: `scp -i .lab/id_ed25519 FMC.qcow2 labadmin@<ip>:/tmp/` then on server move to
  `/opt/unetlab/addons/qemu/firepower6-FMC-7.4.1/virtioa.qcow2`, then `./deploy.sh ssh` and `sudo /opt/unetlab/wrappers/unl_wrapper -a fixpermissions`.
Folder names (must start with `firepower6-`): `firepower6-FMC-<ver>`, `firepower6-FTD-<ver>`. Other prefixes: `asav-`, `vios-`, `viosl2-`, `ise-`, `wsa-`.
`./deploy.sh up` also builds the Ubuntu desktop + admin images automatically.

## 3. Get to the FTD GUI (FMC) — exact clicks
1. Browser: `https://<ip>` -> login `admin` / printed password -> open lab **SCOR-Core**.
2. Start **JumpBox**, **FMC1**, **FTD1** (needs ~40 GB RAM; fine on D16s_v5 = 64 GB; stop the other big nodes).
3. Click **FMC1** (console, VNC). First boot setup: IP `192.168.100.13`, mask `255.255.255.0`, gw `192.168.100.1`, set admin password.
   Wait ~10 min. (Default login before setup: `admin` / `Admin123`.)
4. Click **FTD1** console. Login `admin` / `Admin123` -> accept EULA -> set new password, then:
   `configure network ipv4 manual 192.168.100.12 255.255.255.0 192.168.100.1`
   `configure manager add 192.168.100.13 cisco123`
5. Click **JumpBox** -> desktop opens in the browser tab -> double-click **FMC (Firewall Mgmt)** icon (or Firefox -> `https://192.168.100.13`; accept the certificate warning).
6. In FMC: **Devices > Device Management > Add > Device** -> host `192.168.100.12`, reg key `cisco123`, pick an access-control policy -> Register.
   FTD now appears in FMC: configure interfaces, policies, NAT, VPN, IPS there — that **is** the FTD GUI. Then **Deploy**.
7. Test: **Client** / **Outside-Desktop** desktops generate traffic; watch **Analysis > Connection Events**.

(Standalone alternative without FMC: on FTD run `configure manager local`, then browse `https://192.168.100.12` for FDM.)

## 4. Daily use / cost
`./deploy.sh stop` when done (stops billing for compute; disks still cost a few $/month) · `./deploy.sh start` · `./deploy.sh down` deletes everything.
If your home IP changes: `MY_IP=NEW.IP ./deploy.sh up azure` updates the firewall rule.

## 5. Other GUIs & logins
See `labs/mgmt-guide.md` (all URLs/creds) and `portal/index.html`.
