#!/bin/bash
# Runs ON the EVE host over SSH after install: imports lab, sets EVE admin password (best effort).
set -u
PASS="$1"
sudo mkdir -p /opt/unetlab/labs
[ -f /tmp/scor-core.unl ] && sudo cp /tmp/scor-core.unl /opt/unetlab/labs/
sudo /opt/unetlab/wrappers/unl_wrapper -a fixpermissions >/dev/null 2>&1
H=$(printf %s "$PASS" | sha256sum | cut -d' ' -f1)
sudo mysql -u root -peve-ng eve_ng_db -e "UPDATE users SET password='$H' WHERE username='admin';" 2>/dev/null \
  && echo "EVE admin password set" || echo "EVE admin password NOT changed (still admin/eve) — change in GUI"
