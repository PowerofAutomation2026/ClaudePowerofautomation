#!/bin/bash
# cloud-init user-data: installs EVE-NG Community (web GUI, real Cisco images via QEMU/KVM).
# Runs as root on first boot. Progress: /var/log/eve-install.log
exec > >(tee -a /var/log/eve-install.log) 2>&1
set -x
export DEBIAN_FRONTEND=noninteractive
apt-get update && apt-get -y install wget curl
# Official EVE-NG Community installer (https://www.eve-ng.net) — review before use.
wget -qO /root/install-eve.sh https://www.eve-ng.net/jammy/install-eve.sh
bash /root/install-eve.sh
touch /root/.eve-installed
reboot
