# Install the lab inside YOUR existing Azure VM

## VM requirements (check in Portal > your VM)
| Item | Needed |
|---|---|
| OS | **Ubuntu Server 22.04 LTS** (EVE-NG installer needs exactly this) |
| Size | A nested-virtualization size: **Dsv5 / Dsv4 / Dsv3 / Ddsv5 / Esv5 / Fsv2** (NOT B-series, NOT Av2). 8 vCPU/32 GB minimum for ISE; 16 vCPU/64 GB for FTD+FMC |
| Disk | OS disk **>= 200 GB** (Portal > VM > Disks > OS disk > Size; stop VM to resize) |
| Network | Allow inbound **TCP 443 and 22 from your IP** (Portal > VM > Networking > Add inbound rule, Source = My IP). Don't open to Any. |

## Steps
1. Get the package onto the VM (from your PC):
   `scp ccnp-scor-lab.zip youruser@<VM-public-IP>:~`
2. SSH in and install:
```bash
ssh youruser@<VM-public-IP>
sudo apt-get install -y unzip && unzip ccnp-scor-lab.zip && cd ccnp-scor-lab
sudo ./install-on-vm.sh
```
   It checks your VM, installs EVE-NG, **reboots** (SSH drops), then finishes automatically (~40-60 min total).
3. Reconnect and watch: `sudo tail -f /var/log/scor-lab.log` — wait for `ALL DONE`.
4. Get your login: `sudo cat /root/eve-admin-password.txt`
5. Browse `https://<VM-public-IP>` -> `admin` / that password -> open lab **SCOR-Core**.
6. Upload Cisco images (you supply them) from the VM itself:
```bash
sudo mkdir -p /opt/unetlab/addons/qemu/firepower6-FMC-7.4.1
sudo wget -O /opt/unetlab/addons/qemu/firepower6-FMC-7.4.1/virtioa.qcow2 "<your-download-link>"
# same for firepower6-FTD-7.4.1, asav-9.20, ise-3.2, wsa-15.0 ...
sudo /opt/unetlab/wrappers/unl_wrapper -a fixpermissions
```
   (Or `scp` the qcow2 files from your PC to `/tmp`, then `sudo mv` them into those folders.)
7. FTD GUI / all device GUIs: follow **AZURE-GUIDE.md section 3** and `labs/mgmt-guide.md`.

## Notes
- The installer rewrites the VM's networking (EVE bridge `pnet0`) and web server: use a **dedicated** VM, not one running other apps.
- To keep cost down: Portal > VM > **Stop (deallocate)** when finished.
