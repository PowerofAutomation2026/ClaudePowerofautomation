# SCOR lab ON a Windows (Azure) VM — native, no Linux VM

## Reality check (read first)
- Azure allows ONE level of virtualization inside a VM. This design runs Cisco images directly on Windows via **QEMU + Windows Hypervisor Platform (WHPX)**, so it fits. Running Ubuntu/EVE-NG inside Windows would be two levels deep and is not supported.
- WHPX is slower and less proven with Cisco images than Linux/KVM. **Not tested by me**; if an image won't boot, say which and I'll tune the template.
- Your VM (2 vCPU / 32 GB / 100 GB) is too small. **Resize it in the Portal** (VM > Size): `Standard_D8s_v5` (8 vCPU/32 GB), and expand the OS disk to 256 GB (VM stopped, then Disk Management > Extend C:). Windows is not erased.
- Realistic here: ASAv, IOSv routers, IOSvL2 switch, WSA, and ISE (alone, 16 GB). **FTDv+FMCv (36 GB together) do not fit in 32 GB**: use the 16 vCPU / 64 GB size (`D16s_v5`) for those.

## Install (admin PowerShell on the Windows VM)
```powershell
Expand-Archive ccnp-scor-lab.zip -DestinationPath C:\ ; cd C:\ccnp-scor-lab\windows
powershell -ExecutionPolicy Bypass -File .\Install-Windows-Lab.ps1 -Images C:\images
# first run enables Windows Hypervisor Platform -> reboot -> run the same command again
```
It installs GNS3 (the GUI), QEMU, Firefox, Wireshark, PuTTY, WinSCP and registers your Cisco images as devices in GNS3.
Put your images in `C:\images` first, named like `asav-9.20.qcow2`, `vios-15.9.qcow2`, `viosl2-15.2.qcow2`, `ise-3.2.qcow2`, `wsa-15.0.qcow2`.

## Management network = the Windows VM itself (it IS your admin desktop)
1. Create a loopback NIC: run `hdwwiz` > Install hardware manually > Network adapters > Microsoft > **Microsoft KM-TEST Loopback Adapter**. Rename it `LabMgmt`, set IP **192.168.100.1 / 255.255.255.0**.
2. In GNS3: drag a **Cloud** node, Configure > Ethernet interfaces > tick **LabMgmt**. Add an **Ethernet switch**; connect Cloud -> switch, and every device's management port (Mgmt0/0 of ASAv, Gi0/0 of routers, ISE Gi0, WSA M1) -> that switch.
3. Give devices the IPs in `labs/mgmt-guide.md` (192.168.100.11 ASAv, .14 ISE, .15 WSA, .21/.22/.23 R1/R2/SW1; gateway 192.168.100.1; **skip the 'JumpBox' - Windows is your JumpBox**).
4. Open **Firefox on the Windows VM** and browse `https://192.168.100.11/admin` (ASDM), `https://192.168.100.14/admin` (ISE), `https://192.168.100.15:8443` (WSA), `https://192.168.100.21` (R1) ... Logins: `labs/mgmt-guide.md` (also copied to your Desktop).
   Windows firewall: allow the LabMgmt network as Private. ASDM Java launcher works on Windows (download from the ASA's web page).

## Topology
Same as the SCOR-Core design (`labs/00-topology.md`): ASAv in the middle with OUTSIDE / INSIDE / DMZ, R1+SW1 inside, R2 outside. GNS3 has no import for the EVE file, so build by drag-and-drop (10 minutes) - or ask me for a ready `.gns3project`.
Test machines: the Windows VM itself (via a second loopback "LabInside" NIC bridged by another Cloud node) or add GNS3's Docker/Ubuntu appliance from the GNS3 marketplace.
