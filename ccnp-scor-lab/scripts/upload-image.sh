#!/bin/bash
# Usage: upload-image.sh <host> <user> <local.qcow2> <eve-folder-name>
# e.g.   upload-image.sh 20.1.2.3 labadmin ftdv.qcow2 ftdv-7.4.1
# EVE folder prefixes: asav-, firepower6- (FMC/FTD), vios-, viosl2-, csr1000vng-, cat8000v-, ise-, linux-
set -e
H=$1; U=$2; F=$3; N=$4
ssh "$U@$H" "sudo mkdir -p /opt/unetlab/addons/qemu/$N && sudo chown $U /opt/unetlab/addons/qemu/$N"
scp "$F" "$U@$H:/opt/unetlab/addons/qemu/$N/virtioa.qcow2"
ssh "$U@$H" "sudo /opt/unetlab/wrappers/unl_wrapper -a fixpermissions"
echo "Uploaded. Refresh the EVE GUI and add the node."
