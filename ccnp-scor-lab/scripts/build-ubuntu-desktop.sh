#!/bin/bash
# Run ON the EVE host (as root). Usage: build-ubuntu-desktop.sh [desktop|admin]
#  desktop -> linux-ubuntu-desktop-22.04  (test client: XFCE, Firefox, nmap/curl/hping3/iperf3/tshark)
#  admin   -> linux-ubuntu-admin-22.04    (admin workstation: + Wireshark GUI, PuTTY, Remmina, FileZilla, Ansible,
#                                          Netmiko, desktop shortcuts to FMC/ISE/ASDM/routers, static IP 192.168.100.10)
# Login: lab / Cisco123!  (auto-login). Takes ~15-30 min per image.
set -e
KIND=${1:-desktop}
export DEBIAN_FRONTEND=noninteractive
N=linux-ubuntu-desktop-22.04; SIZE=20G
[ "$KIND" = admin ] && { N=linux-ubuntu-admin-22.04; SIZE=30G; }
D=/opt/unetlab/addons/qemu/$N; W=/root/udesk-$KIND
[ -f $D/virtioa.qcow2 ] && { echo "Already built: $D"; exit 0; }
apt-get install -y qemu-utils genisoimage wget >/dev/null
mkdir -p $W $D; cd $W
[ -f /root/jammy.img ] || wget -qO /root/jammy.img https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img
qemu-img convert -O qcow2 /root/jammy.img base.qcow2; qemu-img resize base.qcow2 $SIZE

PKGS="xubuntu-core, lightdm, firefox, nmap, curl, wget, iperf3, hping3, netcat-openbsd, tcpdump, tshark, dnsutils, traceroute, openssh-server, vim, python3-pip, net-tools"
EXTRA=""
if [ "$KIND" = admin ]; then
  PKGS="$PKGS, wireshark, remmina, putty, filezilla, minicom, picocom, git, ansible, python3-venv, mousepad, xfce4-terminal, gparted"
  EXTRA=$(cat <<'X'
#!/bin/bash
usermod -aG wireshark lab || true
pip3 install netmiko requests ansible-pylibssh >/dev/null 2>&1 || true
D=/home/lab/Desktop; mkdir -p $D
mk(){ printf '[Desktop Entry]\nType=Application\nName=%s\nExec=firefox %s\nIcon=firefox\nTerminal=false\n' "$1" "$2" > "$D/$1.desktop"; chmod +x "$D/$1.desktop"; }
mk "FMC (Firewall Mgmt)" https://192.168.100.13
mk "ASAv ASDM" https://192.168.100.11/admin
mk "ISE" https://192.168.100.14/admin
mk "R1" https://192.168.100.21
mk "R2" https://192.168.100.22
mk "SW1" https://192.168.100.23
mk "FTD FDM" https://192.168.100.12
chown -R lab:lab /home/lab
cat > /etc/netplan/60-mgmt.yaml <<'Y'
network:
  version: 2
  ethernets:
    mgmt:
      match: {name: "e*"}
      dhcp4: false
      addresses: [192.168.100.10/24]
Y
rm -f /etc/netplan/50-cloud-init.yaml
X
)
fi
EXTRA_IND=$(printf '%s\n' "$EXTRA" | sed 's/^/      /')

cat > user-data <<UD
#cloud-config
hostname: $KIND
ssh_pwauth: true
users:
  - name: lab
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: false
chpasswd:
  expire: false
  list: ["lab:Cisco123!", "root:Cisco123!"]
bootcmd:
  - echo "wireshark-common wireshark-common/install-setuid boolean true" | debconf-set-selections
package_update: true
packages: [$PKGS]
write_files:
  - path: /etc/lightdm/lightdm.conf.d/50-auto.conf
    content: |
      [Seat:*]
      autologin-user=lab
      autologin-user-timeout=0
  - path: /root/extras.sh
    permissions: '0755'
    content: |
$EXTRA_IND
runcmd:
  - systemctl set-default graphical.target
  - [ bash, -c, "bash /root/extras.sh || true" ]
  - touch /etc/cloud/cloud-init.disabled
power_state:
  mode: poweroff
  timeout: 3600
UD
printf 'instance-id: u-%s\nlocal-hostname: %s\n' "$KIND" "$KIND" > meta-data
genisoimage -output seed.iso -volid cidata -joliet -rock user-data meta-data >/dev/null 2>&1
echo "Building $N (QEMU exits by itself when done)..."
qemu-system-x86_64 -enable-kvm -m 4096 -smp 2 -nographic -drive file=base.qcow2,if=virtio \
  -drive file=seed.iso,media=cdrom -netdev user,id=n0 -device virtio-net-pci,netdev=n0
mv base.qcow2 $D/virtioa.qcow2
/opt/unetlab/wrappers/unl_wrapper -a fixpermissions >/dev/null
rm -rf $W; echo "DONE: $N ready (login lab / Cisco123!)"
