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

## Deploy (Azure)
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
terraform apply -var 'my_ip_cidr=YOUR.IP/32' -var 'key_name=mykey'   # optional -var ftdv_ami=ami-...
```
## Safety / cost
- Everything is locked to **your IP only**; don't open to 0.0.0.0/0.
- Azure auto-shuts down 23:00 UTC; on AWS **stop the metal instance** after each session (`terraform destroy` when finished).
- Change default `admin/eve` and the `ChangeMe!12345` passwords immediately.
- Respect Cisco license terms; don't redistribute images (`.gitignore` blocks qcow2/iso/ova).

## Study order
`labs/00-topology.md` then domains 1→6 (`labs/0*.md`). Blueprint weights: Network 30, Cloud 15, Content 20, Endpoint 10, Secure Access 15, Visibility 10.
