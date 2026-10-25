#!/usr/bin/env bash
# Install the whole SCOR lab INSIDE an existing Azure (or any) Ubuntu 22.04 VM.
#   sudo ./install-on-vm.sh          (run from the unzipped package folder, ON the VM)
# Phase 1: checks + EVE-NG install, then reboots.  Phase 2 (automatic after reboot): imports SCOR-Core lab,
# sets EVE admin password, builds Ubuntu desktop + admin images.  Progress: tail -f /var/log/scor-lab.log
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
SRC="$(cd "$(dirname "$0")" && pwd)"; DST=/opt/scor-lab; LOG=/var/log/scor-lab.log
exec > >(tee -a $LOG) 2>&1
echo "=== SCOR lab install on this VM: $(date) ==="

# ---- preflight ----
. /etc/os-release; [ "${VERSION_ID}" = "22.04" ] || { echo "ERROR: needs Ubuntu 22.04 (found $VERSION_ID). Create the VM from 'Ubuntu Server 22.04 LTS'."; exit 1; }
if ! grep -Eq 'vmx|svm' /proc/cpuinfo; then
  echo "ERROR: no virtualization (vmx/svm) exposed. Cisco images need KVM."
  echo "Use a nested-virt VM size: Dsv3/Dsv4/Dsv5, Ddsv5, Esv3/Esv5, Fsv2, Lsv2 (NOT B-series, NOT Av2). Resize in Portal > VM > Size."; exit 1; fi
RAM=$(awk '/MemTotal/{printf "%d",$2/1048576}' /proc/meminfo); DISK=$(df -BG --output=avail / | tail -1 | tr -dc 0-9); CPU=$(nproc)
echo "Detected: ${CPU} vCPU, ${RAM} GB RAM, ${DISK} GB free on /"
[ "$RAM" -ge 15 ] || echo "WARNING: <16 GB RAM: only ASAv/IOSv labs will fit."
[ "$DISK" -ge 100 ] || { echo "ERROR: need >=100 GB free (200+ recommended). Portal > VM > Disks > OS disk > Size, then reboot."; exit 1; }
[ "$DISK" -ge 200 ] || echo "WARNING: <200 GB free; Cisco images + 2 desktop images need space."

# ---- stage files ----
mkdir -p $DST; cp -r "$SRC/scripts" "$SRC/labs" "$SRC/portal" $DST/ 2>/dev/null; chmod +x $DST/scripts/*.sh
PASS_FILE=/root/eve-admin-password.txt
[ -f $PASS_FILE ] || { openssl rand -base64 15 | tr -d '/+=' > $PASS_FILE; chmod 600 $PASS_FILE; }

# ---- phase 2 (runs after reboot via systemd) ----
cat > $DST/phase2.sh <<'P2'
#!/bin/bash
exec >> /var/log/scor-lab.log 2>&1
echo "=== phase 2: $(date) ==="
for i in $(seq 1 60); do curl -ksf -o /dev/null https://127.0.0.1/ && break; sleep 10; done
cp /opt/scor-lab/labs/scor-core.unl /tmp/scor-core.unl
bash /opt/scor-lab/scripts/post-install.sh "$(cat /root/eve-admin-password.txt)"
bash /opt/scor-lab/scripts/build-ubuntu-desktop.sh desktop || true
bash /opt/scor-lab/scripts/build-ubuntu-desktop.sh admin || true
echo "=== ALL DONE $(date) ==="
echo "READY. Browse https://<VM public IP>   user: admin   pass: $(cat /root/eve-admin-password.txt)"
systemctl disable scor-phase2.service
P2
chmod +x $DST/phase2.sh
cat > /etc/systemd/system/scor-phase2.service <<U
[Unit]
Description=SCOR lab phase 2
After=network-online.target apache2.service mysql.service
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=$DST/phase2.sh
TimeoutStartSec=0
[Install]
WantedBy=multi-user.target
U
systemctl daemon-reload; systemctl enable scor-phase2.service

# ---- phase 1: install EVE-NG (reboots at the end) ----
export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get install -y wget curl openssl
wget -qO /root/install-eve.sh https://www.eve-ng.net/jammy/install-eve.sh
bash /root/install-eve.sh
touch /root/.eve-installed
echo ">>> EVE-NG installed. Rebooting in 10s. Reconnect in ~3 min; phase 2 continues automatically (30-50 min)."
echo ">>> Watch: sudo tail -f /var/log/scor-lab.log      Password: sudo cat $PASS_FILE"
sleep 10; reboot
