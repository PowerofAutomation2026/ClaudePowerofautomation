#!/usr/bin/env bash
# CCNP SCOR Lab — zero-touch deployer.   ./deploy.sh            (interactive menu)
#   ./deploy.sh up azure|aws [--images DIR]   ./deploy.sh status|stop|start|ssh|images DIR|down
set -euo pipefail
cd "$(dirname "$0")"
S=.lab; mkdir -p $S
C=$'\e[36m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; B=$'\e[1m'; N=$'\e[0m'
say(){ echo "${C}▶${N} $*"; }; ok(){ echo "${G}✔${N} $*"; }; die(){ echo "${R}✘ $*${N}" >&2; exit 1; }
banner(){ echo "${C}${B}
   ╔═╗╔═╗╔═╗╦═╗   ╦  ╔═╗╔╗   CCNP Security 350-701
   ╚═╗║  ║ ║╠╦╝   ║  ╠═╣╠╩╗   real Cisco gear · EVE-NG GUI
   ╚═╝╚═╝╚═╝╩╚═   ╩═╝╩ ╩╚═╝   AWS + Azure · zero-touch
${N}"; }

TF_VER=1.9.8
need_tf(){
  command -v terraform >/dev/null && return
  say "Installing Terraform $TF_VER locally…"
  os=$(uname -s | tr A-Z a-z); ar=$(uname -m); [ "$ar" = x86_64 ] && ar=amd64; [ "$ar" = aarch64 ] && ar=arm64
  curl -fsSL "https://releases.hashicorp.com/terraform/${TF_VER}/terraform_${TF_VER}_${os}_${ar}.zip" -o $S/tf.zip
  (cd $S && unzip -qo tf.zip terraform && rm tf.zip); export PATH="$PWD/$S:$PATH"
}
need_key(){ [ -f $S/id_ed25519 ] || { ssh-keygen -t ed25519 -N "" -f $S/id_ed25519 -q; ok "SSH key generated"; }; }
myip(){ curl -fsS https://api.ipify.org || die "Cannot detect public IP"; }
cloud(){ cat $S/cloud 2>/dev/null || die "Nothing deployed yet. Run: ./deploy.sh up azure|aws"; }

auth(){
  case $1 in
   azure) command -v az >/dev/null || die "Install Azure CLI: https://aka.ms/installazurecli"
          az account show >/dev/null 2>&1 || { say "Azure login…"; az login >/dev/null; }
          ok "Azure: $(az account show --query name -o tsv)";;
   aws)   command -v aws >/dev/null || die "Install AWS CLI v2"
          aws sts get-caller-identity >/dev/null 2>&1 || die "Run 'aws configure' (or set AWS_* env vars) first"
          ok "AWS: $(aws sts get-caller-identity --query Account --output text)";;
  esac
}

up(){
  local c=$1; shift; local imgs=""; [ "${1:-}" = "--images" ] && imgs=${2:-}
  [ "$c" = azure ] || [ "$c" = aws ] || die "Choose azure or aws"
  need_tf; need_key; auth "$c"
  [ -f $S/eve_pass ] || openssl rand -base64 15 | tr -d '/+=' > $S/eve_pass
  PASS=$(cat $S/eve_pass); IP=$(myip); echo "$c" > $S/cloud
  say "Locking lab to your IP: $IP"
  [ "$c" = aws ] && warn_metal
  terraform -chdir=$c init -input=false -upgrade >/dev/null
  terraform -chdir=$c apply -auto-approve -input=false \
     -var "my_ip_cidr=$IP/32" -var "ssh_pubkey_path=$PWD/$S/id_ed25519.pub"
  EVE=$(terraform -chdir=$c output -raw eve_ip); echo "$EVE" > $S/ip
  SSHO="-i $S/id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o LogLevel=ERROR"
  USR=labadmin; [ "$c" = aws ] && USR=ubuntu; echo "$USR" > $S/user
  say "Waiting for EVE-NG install + reboot (~15-20 min)…"
  for i in $(seq 1 120); do
    if ssh $SSHO $USR@$EVE 'test -f /root/.eve-installed || sudo test -f /root/.eve-installed' 2>/dev/null \
       && curl -ksf -o /dev/null "https://$EVE/"; then break; fi
    printf "."; sleep 15
  done; echo
  scp $SSHO labs/scor-core.unl scripts/post-install.sh $USR@$EVE:/tmp/ >/dev/null
  ssh $SSHO $USR@$EVE "bash /tmp/post-install.sh '$PASS'"
  [ -n "$imgs" ] && images "$imgs"
  desktop
  portal_cfg "$EVE" "$PASS" "$c"
  ok "${B}READY${N}  https://$EVE   user: admin   pass: $PASS"
  echo "   Portal: portal/index.html   |   SSH: ./deploy.sh ssh   |   Done for the day: ./deploy.sh stop"
}
warn_metal(){ echo "${Y}AWS uses bare-metal (~\$4/h). Remember ./deploy.sh stop or down.${N}"; }

images(){  # folder of qcow2 named <eve-folder>.qcow2, e.g. asav-9.20.qcow2 -> /opt/unetlab/addons/qemu/asav-9.20/virtioa.qcow2
  local d=${1:?folder}; local EVE USR; EVE=$(cat $S/ip); USR=$(cat $S/user)
  SSHO="-i $S/id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"
  shopt -s nullglob
  for f in "$d"/*.qcow2; do
    n=$(basename "$f" .qcow2); say "Uploading $n"
    ssh $SSHO $USR@$EVE "sudo mkdir -p /opt/unetlab/addons/qemu/$n && sudo chown $USR /opt/unetlab/addons/qemu/$n"
    scp $SSHO "$f" $USR@$EVE:/opt/unetlab/addons/qemu/$n/virtioa.qcow2
  done
  ssh $SSHO $USR@$EVE "sudo /opt/unetlab/wrappers/unl_wrapper -a fixpermissions" && ok "Images ready"
}
desktop(){ local EVE USR; EVE=$(cat $S/ip); USR=$(cat $S/user)
  SSHO="-i $S/id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"
  scp $SSHO scripts/build-ubuntu-desktop.sh $USR@$EVE:/tmp/ >/dev/null
  say "Building Ubuntu test-desktop + admin-desktop images on the lab host (30-50 min)…"; ssh $SSHO $USR@$EVE "sudo bash /tmp/build-ubuntu-desktop.sh desktop && sudo bash /tmp/build-ubuntu-desktop.sh admin"; ok "Desktop + Admin images ready (login lab / Cisco123!)"; }
portal_cfg(){
  printf 'window.LAB={ip:"%s",pass:"%s",cloud:"%s"};\n' "$1" "$2" "$3" > portal/config.js
  (xdg-open portal/index.html || open portal/index.html) >/dev/null 2>&1 || true
}
status(){ c=$(cloud); echo "cloud=$c ip=$(cat $S/ip 2>/dev/null)"; curl -ksf -o /dev/null "https://$(cat $S/ip)/" && ok "EVE GUI up" || echo "${Y}EVE GUI not reachable${N}"; }
stop(){ c=$(cloud); if [ $c = azure ]; then az vm deallocate -g rg-scor-lab -n eve-ng-scor; else
  aws ec2 stop-instances --instance-ids "$(aws ec2 describe-instances --filters Name=tag:Name,Values=eve-ng-scor Name=instance-state-name,Values=running --query 'Reservations[].Instances[].InstanceId' --output text)" >/dev/null; fi; ok "Stopped (no compute billing)"; }
start(){ c=$(cloud); if [ $c = azure ]; then az vm start -g rg-scor-lab -n eve-ng-scor; NEW=$(az network public-ip show -g rg-scor-lab -n pip-eve --query ipAddress -o tsv); else
  id=$(aws ec2 describe-instances --filters Name=tag:Name,Values=eve-ng-scor --query 'Reservations[].Instances[].InstanceId' --output text); aws ec2 start-instances --instance-ids $id >/dev/null; aws ec2 wait instance-running --instance-ids $id
  NEW=$(aws ec2 describe-instances --instance-ids $id --query 'Reservations[0].Instances[0].PublicIpAddress' --output text); fi
  echo "$NEW" > $S/ip; ok "Started: https://$NEW  (if your home IP changed, re-run ./deploy.sh up $c to update the firewall rule)"; }
down(){ c=$(cloud); need_tf; read -rp "Destroy EVERYTHING in $c (lab + disks)? [y/N] " a; [ "$a" = y ] || exit 0
  terraform -chdir=$c destroy -auto-approve -input=false -var "my_ip_cidr=0.0.0.0/32" -var "ssh_pubkey_path=$PWD/$S/id_ed25519.pub"; rm -f $S/cloud $S/ip; ok "Destroyed"; }
sshc(){ exec ssh -i $S/id_ed25519 -o StrictHostKeyChecking=no $(cat $S/user)@$(cat $S/ip); }

banner
case "${1:-menu}" in
  up) shift; up "$@";; status) status;; stop) stop;; start) start;; down) down;; ssh) sshc;; desktop) desktop;; images) images "${2:-}";;
  menu) echo "1) Deploy on Azure (recommended)  2) Deploy on AWS  3) Status  4) Stop  5) Start  6) Destroy  7) Upload images"
        read -rp "> " m; case $m in 1) up azure;; 2) up aws;; 3) status;; 4) stop;; 5) start;; 6) down;; 7) read -rp "Folder: " f; images "$f";; esac;;
  *) die "Usage: $0 [up azure|aws [--images DIR] | status | stop | start | down | ssh | images DIR]";;
esac
