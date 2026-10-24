#!/bin/bash
# Run ON the EVE host (as root). Builds a full-GUI Ubuntu 22.04 (XFCE) image for EVE-NG: 20 GB, ~15-25 min.
# Result: /opt/unetlab/addons/qemu/linux-ubuntu-desktop-22.04   login: lab / Cisco123!  (auto-login to desktop)
set -e
N=linux-ubuntu-desktop-22.04; D=/opt/unetlab/addons/qemu/$N; W=/root/udesk
[ -f $D/virtioa.qcow2 ] && { echo "Already built: $D"; exit 0; }
export DEBIAN_FRONTEND=noninteractive
apt-get install -y qemu-utils genisoimage wget >/dev/null
mkdir -p $W $D; cd $W
[ -f jammy.img ] || wget -qO jammy.img https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img
qemu-img convert -O qcow2 jammy.img base.qcow2; qemu-img resize base.qcow2 20G
cat > user-data <<'UD'
#cloud-config
hostname: desktop
ssh_pwauth: true
users:
  - name: lab
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: false
chpasswd:
  expire: false
  list: ["lab:Cisco123!", "root:Cisco123!"]
package_update: true
packages: [xubuntu-core, lightdm, firefox, nmap, curl, wget, iperf3, hping3, netcat-openbsd, tcpdump, tshark, dnsutils, traceroute, openssh-server, vim, python3-pip, net-tools]
write_files:
  - path: /etc/lightdm/lightdm.conf.d/50-auto.conf
    content: |
      [Seat:*]
      autologin-user=lab
      autologin-user-timeout=0
runcmd:
  - systemctl set-default graphical.target
  - touch /etc/cloud/cloud-init.disabled
power_state:
  mode: poweroff
  timeout: 3600
UD
printf 'instance-id: udesk\nlocal-hostname: desktop\n' > meta-data
genisoimage -output seed.iso -volid cidata -joliet -rock user-data meta-data >/dev/null 2>&1
echo "Building (QEMU will exit by itself when done)..."
qemu-system-x86_64 -enable-kvm -m 4096 -smp 2 -nographic -drive file=base.qcow2,if=virtio \
  -drive file=seed.iso,media=cdrom -netdev user,id=n0 -device virtio-net-pci,netdev=n0
mv base.qcow2 $D/virtioa.qcow2
/opt/unetlab/wrappers/unl_wrapper -a fixpermissions >/dev/null
rm -rf $W; echo "DONE: image $N ready (login lab / Cisco123!)"
