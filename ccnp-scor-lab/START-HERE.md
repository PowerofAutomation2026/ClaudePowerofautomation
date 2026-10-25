# START HERE — SCOR lab on your Azure Windows VM (GNS3, zero-touch)

## 0. What you need
- Azure Windows VM, resized to **16 vCPU / 32 GB** (`Standard_F16s_v2`; nested virtualization size) and OS disk **>= 256 GB**
  (Portal: stop VM > Size; Disks > OS disk > Size; start VM > Disk Management > Extend C:).
- Your Cisco images (you must supply): put in `C:\images`
  `asav-9.20.qcow2` `vios-15.9.qcow2` `viosl2-15.2.qcow2` `ftd-7.4.1.qcow2` `ise-3.2.qcow2` (+ `fmc-7.4.1.qcow2` only on a 64 GB VM)
  Missing images are skipped.

## 1. Install (once)
1. Copy `ccnp-scor-lab.zip` to the VM, unzip to `C:\ccnp-scor-lab`.
2. Right-click `C:\ccnp-scor-lab\windows\Deploy-Windows.cmd` > **Run as administrator**, e.g. in admin PowerShell:
   `C:\ccnp-scor-lab\windows\Deploy-Windows.cmd C:\images`
3. It enables virtualization features and asks to **reboot**. Reboot, run the same command again.
4. Wait ~60-90 min (builds Ubuntu desktop image, creates the GNS3 project, starts the default devices, pushes configs).

## 2. Run devices a few at a time (32 GB!)
- Profiles: `powershell -File C:\ccnp-scor-lab\windows\Switch-Profile.ps1 -Profile network`
  | Profile | Starts | RAM |
  |---|---|---|
  | network | ASAv, R1, R2, SW1, Client, Outside-Desktop, DMZ-Server | ~12 GB |
  | ftdfdm | FTD1 (managed by its own FDM GUI), R2, FTD-Client, Outside-Desktop, DMZ-Server | ~13 GB |
  | nac | ISE1, R1, SW1, Client, DMZ-Server | ~22 GB |
- Or open GNS3 > File > Open project > **SCOR-Core**, right-click a device > Start/Stop.
- FMC needs 28 GB: not on this VM size (use a 64 GB VM, profile `ftd`).

## 3. Open the GUIs (Firefox on the Windows VM)
ASAv https://192.168.100.11/admin · R1 .21 · R2 .22 · SW1 .23 (https://192.168.100.x, admin / Cisco123!)
FTD (FDM) https://192.168.100.12 (admin / Cisco123!) · ISE https://192.168.100.14/admin (after its wizard) · FMC https://192.168.100.13 (64 GB VM)
Test PCs (Remote Desktop `mstsc`, user lab / Cisco123!): Client 192.168.100.31 · Outside-Desktop .32 · DMZ-Server .33 · FTD-Client .34

## 4. Create policy and test
Follow `labs\windows-test-plan.md` (ASA NAT/ACL exercises, FTD policy, tests with curl/ping/nmap from the test PCs).
ISE wizard answers and FMC steps are in the same file.

## 5. Cost control
Stop (deallocate) the VM in the Portal when done; start it again next session (GNS3 project and images persist).
Not tested on a real VM: send me any error text and I will fix it. Change the `Cisco123!` passwords before exposing anything.
