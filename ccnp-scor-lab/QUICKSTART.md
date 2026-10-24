# QUICKSTART

## How much RAM / disk?
| Your PC | What runs | Host RAM | Free disk |
|---|---|---|---|
| Minimum | ASAv + IOSv routers/switch + Linux | 16 GB | 100 GB SSD |
| Recommended | + ISE (802.1X/NAC) | 32 GB | 200 GB SSD |
| Full | + FTDv + FMCv + ISE together | 64 GB | 300 GB SSD |
Need: CPU with VT-x/AMD-V (4+ cores, 8+ better), SSD (not HDD). Less than 32 GB? Use the cloud deploy for the heavy parts.

## A) On your Windows PC
1. Reboot-proof prep (once, admin cmd):  `bcdedit /set hypervisorlaunchtype off`  then reboot. Enable VT-x in BIOS.
2. Unzip the package. Put your Cisco images (`asav-9.20.qcow2`, ...) in a folder, e.g. `C:\images`.
3. Right-click `local\Deploy-Local.cmd` -> Run as administrator. Or in admin cmd:
   `local\Deploy-Local.cmd up "C:\images"`
4. Wait ~30 min. Open https://localhost:8443 (admin / password printed at the end).
5. Open lab "SCOR-Core", start nodes. Daily: `local\Deploy-Local.cmd stop` / `start`.

## B) On Azure (needs `az`, Linux/Mac/WSL/Git-Bash)
1. `az login`
2. `./deploy.sh up azure --images ./images`   (~US$0.8/h, auto-off 23:00 UTC; cloud disk 512 GB)
3. Open the printed https URL. End of day: `./deploy.sh stop`. Finished: `./deploy.sh down`.

## C) On AWS (needs `aws configure`)
`./deploy.sh up aws --images ./images`   (bare metal ~US$4/h — stop it!)
