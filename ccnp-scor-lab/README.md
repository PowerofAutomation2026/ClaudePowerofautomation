# CCNP Security 350-701 SCOR — Real-Device Cloud Lab (AWS + Azure)

Real Cisco software images (IOSv, ASAv, FTDv/FMCv, ISE, C8000V…) running in **EVE-NG's web GUI**, hosted on your own Azure or AWS account. No Packet Tracer.

## What I can and can't do
- ✅ Terraform for the infrastructure, installer, image-upload helper, and a lab plan mapped to the 350-701 blueprint.
- ❌ **I can't supply Cisco images.** They are licensed. Get them legitimately:
  - Cisco CML / CML-Personal (includes IOSv, ASAv, ISE-capable nodes) — ~US$200/yr, the best-value legal route.
  - Cisco VIRL/CML refplat ISO, or your CCO entitlement (FTDv/FMCv/ISE need eval or a contract).
  - **Native cloud route:** subscribe in AWS Marketplace / Azure Marketplace to Cisco Secure Firewall (FTDv/FMCv), Catalyst 8000V, ASAv — free trial or BYOL; pass AMI IDs to `aws/` Terraform.
  - Free alternative: Cisco DevNet Sandbox (always-on/reservable real gear) and Umbrella/Duo/XDR trials.
- Terraform has not been run against live accounts by me — run `terraform plan` and review before `apply`.

## Which cloud?
| | Azure (`azure/`) | AWS (`aws/`) |
|---|---|---|
| EVE-NG/KVM | Dsv5 VM supports nested virt, ~US$0.8/hr | needs `.metal` (c5.metal ≈ US$4/hr) |
| Native Cisco appliances | use Marketplace NVAs | `ftdv_ami/fmcv_ami/c8000v_ami` vars |
| Recommendation | **Start here for EVE** | Use for the Domain-2 cloud labs |

## 🖥️ Run it on your own Windows PC (no cloud)
Double-click `local\Deploy-Local.cmd` (run as admin the first time), or:
```cmd
local\Deploy-Local.cmd up "C:\my-images"     :: optional folder of .qcow2 images
local\Deploy-Local.cmd stop | start | status | down
local\Deploy-Local.cmd images "C:\my-images"
```
Installs VirtualBox (winget), downloads Ubuntu 22.04, builds a VM (≈65% of your RAM, 200 GB sparse disk), installs EVE-NG itself, imports the SCOR-Core lab and opens the portal. GUI: https://localhost:8443.
**Requirements:** Intel VT-x/AMD-V on, 32 GB+ RAM recommended (16 GB works for ASAv/IOSv only), and Hyper-V/WSL2 off (`bcdedit /set hypervisorlaunchtype off`, reboot) because VirtualBox can't nest-virtualize alongside it. Not tested on a real Windows machine - report any error text and it gets fixed.

## ⚡ Zero-touch cloud (recommended for heavy images)
```bash
./deploy.sh                      # menu
./deploy.sh up azure --images ./my-images   # my-images/asav-9.20.qcow2 etc.
```
It installs Terraform if missing, logs into your cloud, detects your IP, generates an SSH key and random EVE password, deploys, waits for the GUI, imports the `SCOR-Core` lab, and opens the `portal/` control center. Also: `status | stop | start | ssh | images DIR | down`. Needs `az` (Azure) or `aws` (AWS) CLI, `curl`, `unzip`, `ssh`.

## Manual deploy (Azure)
```bash
cd azure
terraform init
terraform apply -var 'my_ip_cidr=YOUR.PUBLIC.IP/32'
# wait ~15 min (install + reboot), then open https://<ip>   admin / eve  (change it)
../scripts/upload-image.sh <ip> labadmin ./asav.qcow2 asav-9.20
```
## Deploy (AWS)
```bash
cd aws
terraform init
terraform apply -var 'my_ip_cidr=YOUR.IP/32'    # optional -var ftdv_ami=ami-...
```
## Safety / cost
- Everything is locked to **your IP only**; don't open to 0.0.0.0/0.
- Azure auto-shuts down 23:00 UTC; on AWS **stop the metal instance** after each session (`terraform destroy` when finished).
- Change default `admin/eve` and the `ChangeMe!12345` passwords immediately.
- Respect Cisco license terms; don't redistribute images (`.gitignore` blocks qcow2/iso/ova).

## Study order
`labs/00-topology.md` then domains 1→6 (`labs/0*.md`). Blueprint weights: Network 30, Cloud 15, Content 20, Endpoint 10, Secure Access 15, Visibility 10.

## Device GUIs
See labs/mgmt-guide.md - every device sits on a MGMT network with a browser-based JumpBox desktop, so FMC, ASDM, ISE and IOS web GUIs are all reachable from your browser.
