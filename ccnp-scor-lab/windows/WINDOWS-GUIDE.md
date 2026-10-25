# SCOR lab on a Windows (Azure) VM — zero touch (GNS3 + QEMU/WHPX)

## Before
1. Portal: resize the VM to **Standard_D8s_v5** (8 vCPU/32 GB; Windows is kept) and expand the OS disk to **>=256 GB** (then Disk Management > Extend C:). A 2-core/100 GB VM will not work.
2. Put your Cisco images in `C:\images` named: `asav-9.20.qcow2`, `vios-15.9.qcow2`, `viosl2-15.2.qcow2` `ftd-7.4.1.qcow2`, `fmc-7.4.1.qcow2`, `ise-3.2.qcow2` (optional `wsa-15.0.qcow2`). Images you do not have are skipped.
   **RAM:** FTD 8 + FMC 28 + ISE 16 GB: use profiles (`windows\Switch-Profile.ps1 -Profile network|ftd|nac|all`). Sizes: network/nac = D8s_v5 (32 GB), ftd = D16s_v5 (64 GB), all = E16s_v5 (128 GB). See `labs/windows-test-plan.md`.

## Install (one command; run twice - the first run asks for a reboot)
Right-click `windows\Deploy-Windows.cmd` > Run as administrator, or in admin PowerShell:
`powershell -ExecutionPolicy Bypass -File .\Install-Windows-Lab.ps1 -Images C:\images`
It enables Windows Hypervisor Platform + Hyper-V, installs QEMU/GNS3/Firefox/Wireshark/PuTTY, creates the LabMgmt network (Windows = 192.168.100.1),
builds the Ubuntu desktop image (~40 min), creates the **SCOR-Core** project in GNS3 with all devices and cables, starts it, and pushes day-0 configs.

## Use
- GNS3 desktop app: File > Open project > **SCOR-Core** (start/stop devices, consoles).
- Device GUIs: Firefox on this Windows VM -> URLs in `labs/windows-test-plan.md` (also on your Desktop).
- Test PCs: `mstsc` -> 192.168.100.31 (Client), .32 (Outside-Desktop), .33 (DMZ-Server), .34 (FTD-Client) — full XFCE desktop, login `lab` / `Cisco123!`.
- Create firewall policy in ASDM/CLI and test from Client / Outside-Desktop: `labs/windows-test-plan.md`.

## Honest limits
Not tested on a real Windows VM (I cannot run PowerShell/GNS3 here). Likely first-run snags: winget package IDs, the GNS3 silent install, Cloud-node binding to `vEthernet (LabMgmt)`, WHPX booting a particular Cisco image, console-prompt timing in the config push. Send me the error text and I will fix it.
