#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Fenwick — Proxmox VE one-liner installer
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/ethanbanker/fenwick/main/ct/fenwick.sh)"
#
# Creates an unprivileged Debian LXC, installs Node and the app inside it, and
# starts him under systemd. Run this on the Proxmox host, as root.
#
# Everything is asked up front with sensible defaults; the default path is two
# keypresses. Self-contained on purpose: no external helper library to drift
# out from under it.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO="ethanbanker/fenwick"
BRANCH="main"
RAW="https://raw.githubusercontent.com/${REPO}/${BRANCH}"

# whiptail renders em dashes and ticks as garbage under a bare POSIX locale,
# which is what a fresh host console often has
export LC_ALL=${LC_ALL:-C.UTF-8}

APP="Fenwick"
DEFAULT_HOSTNAME="fenwick"
DEFAULT_CORES=1
DEFAULT_RAM=1024
DEFAULT_SWAP=512
DEFAULT_DISK=8
DEFAULT_BRIDGE="vmbr0"
DEFAULT_DNS="1.1.1.1"

# colours, but only on a terminal
if [ -t 1 ]; then
  B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; O=$'\033[0m'
else
  B=""; D=""; G=""; Y=""; R=""; C=""; O=""
fi

msg()   { printf '  %s\n' "$*"; }
info()  { printf '%s  •%s %s\n' "$C" "$O" "$*"; }
ok()    { printf '%s  ✓%s %s\n' "$G" "$O" "$*"; }
warn()  { printf '%s  !%s %s\n' "$Y" "$O" "$*" >&2; }
die()   { printf '\n%s  ✗ %s%s\n\n' "$R" "$*" "$O" >&2; exit 1; }

banner() {
  printf '\n%s' "$B"
  cat <<'ASCII'
   ______                    _ _
  |  ____|                  (_) |
  | |__ ___ _ __  __      ___| | __
  |  __/ _ \ '_ \ \ \ /\ / / | |/ /
  | | |  __/ | | | \ V  V /| |   <
  |_|  \___|_| |_|  \_/\_/ |_|_|\_\

ASCII
  printf '%s' "$O"
  printf '  %sAn owl who lives in a small town.%s\n' "$D" "$O"
  printf '  %sHe walks, eats, sleeps, browses the internet and keeps a diary.%s\n\n' "$D" "$O"
}

require_host() {
  [ "$(id -u)" -eq 0 ] || die "run this on the Proxmox host as root"
  command -v pct >/dev/null 2>&1 || die "pct not found — this has to run on the Proxmox VE host, not inside a container"
  for c in whiptail pvesm pveam pvesh curl; do
    command -v "$c" >/dev/null 2>&1 || die "$c not found — is this really a Proxmox VE host?"
  done
}

# ---------------------------------------------------------------------------
# prompts
# ---------------------------------------------------------------------------
ask() {
  local title=$1 prompt=$2 default=${3:-}
  whiptail --backtitle "$APP" --title " $title " --inputbox "$prompt" 10 74 "$default" \
    3>&1 1>&2 2>&3
}

ask_plain() {
  local title=$1 prompt=$2
  whiptail --backtitle "$APP" --title " $title " --inputbox "$prompt" 10 74 "" \
    3>&1 1>&2 2>&3
}

ask_password() {
  local title=$1 prompt=$2
  whiptail --backtitle "$APP" --title " $title " --passwordbox "$prompt" 10 74 \
    3>&1 1>&2 2>&3
}

menu() {
  local title=$1 prompt=$2; shift 2
  whiptail --backtitle "$APP" --title " $title " --menu "$prompt" 16 74 6 "$@" \
    3>&1 1>&2 2>&3
}

confirm() {
  whiptail --backtitle "$APP" --title " $1 " --yesno "$2" 14 74 3>&1 1>&2 2>&3
}

# whiptail returns 1 on cancel/ESC. Under `set -e` a failing command
# substitution would abort the script before we could say anything, so every
# prompt site ends in `|| cancel`.
cancel() { printf '\n  cancelled.\n\n'; exit 1; }
trap cancel INT TERM

# ---------------------------------------------------------------------------
# host probing
# ---------------------------------------------------------------------------
next_ctid() {
  local id
  id=$(pvesh get /cluster/nextid 2>/dev/null | tr -d '"[:space:]') || true
  case ${id:-} in ''|*[!0-9]*) id=100 ;; esac
  printf '%s' "$id"
}

# storage that can hold a container rootfs
rootdir_storages() {
  pvesm status --content rootdir 2>/dev/null | awk 'NR>1 && $3=="active" {print $1}'
}

vztmpl_storages() {
  pvesm status --content vztmpl 2>/dev/null | awk 'NR>1 && $3=="active" {print $1}'
}

bridges() {
  local files="/etc/network/interfaces /etc/network/interfaces.d/*"
  # shellcheck disable=SC2086
  { grep -hoE '^iface (vmbr[0-9]+)' $files 2>/dev/null || true; } | awk '{print $2}' | sort -u
}

default_gateway() {
  ip route show default 2>/dev/null | awk '/default/ {print $3; exit}'
}

# ---------------------------------------------------------------------------
# template
# ---------------------------------------------------------------------------
ensure_template() {
  local store avail
  store=$(vztmpl_storages | head -1)
  [ -n "$store" ] || die "no storage with 'vztmpl' content — enable it under Datacenter → Storage"

  # already downloaded? (awk reads to the end on purpose: exiting early sends
  # SIGPIPE to pveam, and pipefail turns that into a failed install)
  local existing
  existing=$(pveam list "$store" 2>/dev/null |
    awk '/debian-1[23]-standard/ && !t {t=$1} END{print t}')
  if [ -n "$existing" ]; then
    TEMPLATE=$existing
    ok "using template ${existing##*/}"
    return
  fi

  info "no Debian template on $store, fetching the catalogue"
  pveam update >/dev/null 2>&1 || true
  avail=$(pveam available --section system 2>/dev/null |
    awk '/debian-1[23]-standard/ && !t {t=$2} END{print t}')
  [ -n "$avail" ] || die "no Debian 12/13 template in the catalogue (pveam available --section system)"

  info "downloading $avail"
  pveam download "$store" "$avail" >/dev/null 2>&1 || die "template download failed: $avail"
  TEMPLATE="$store:vztmpl/$avail"
  ok "template ready"
}

# ---------------------------------------------------------------------------
# create
# ---------------------------------------------------------------------------
create_ct() {
  local net
  if [ "$NET_MODE" = "static" ]; then
    net="name=eth0,bridge=${BRIDGE},ip=${STATIC_CIDR},gw=${GATEWAY},type=veth"
  else
    net="name=eth0,bridge=${BRIDGE},ip=dhcp,type=veth"
  fi

  CTID=$(next_ctid)
  info "creating container $CTID (${CORES} core, ${RAM} MB, ${DISK} GB, ${STORAGE})"

  pct create "$CTID" "$TEMPLATE" \
    --hostname "$HOSTNAME" \
    --cores "$CORES" \
    --memory "$RAM" \
    --swap "$SWAP" \
    --rootfs "${STORAGE}:${DISK}" \
    --net0 "$net" \
    --nameserver "$DNS" \
    --unprivileged 1 \
    --onboot 1 \
    --password "$CT_PASS" \
    --description "$APP — an autonomous owl who lives in a small town. https://github.com/$REPO" \
    --start 1 >/dev/null || die "pct create failed"

  ok "container $CTID created"

  info "waiting for it to come up"
  local i
  for i in $(seq 1 60); do
    pct exec "$CTID" -- true >/dev/null 2>&1 && break
    sleep 1
    [ "$i" -eq 60 ] && die "container $CTID did not start within 60s — check: pct status $CTID"
  done
  ok "container is up"

  # DHCP needs a lease before anything tries to reach the internet
  for i in $(seq 1 30); do
    ct_ip=$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}') || true
    [ -n "${ct_ip:-}" ] && break
    sleep 1
  done
  [ -n "${ct_ip:-}" ] || warn "no IP yet on $CTID — continuing, the installer may still work"
}

# ---------------------------------------------------------------------------
# install inside
# ---------------------------------------------------------------------------
install_inside() {
  local script="/tmp/fenwick-install-$$.sh" keyfile=""

  info "fetching installer"
  curl -fsSL "${RAW}/install/fenwick-install.sh" -o "$script" ||
    die "could not download install/fenwick-install.sh from github.com/$REPO"
  pct push "$CTID" "$script" /root/fenwick-install.sh --perms 0700 >/dev/null ||
    die "could not push the installer into $CTID"
  rm -f "$script"

  # the api key goes over as a file rather than an argument, so it never shows
  # up in a process list on either side
  if [ -n "$API_KEY" ]; then
    keyfile=$(mktemp)
    chmod 600 "$keyfile"
    printf '%s' "$API_KEY" > "$keyfile"
    pct push "$CTID" "$keyfile" /root/.fenwick-key --perms 0600 >/dev/null ||
      warn "could not push the api key — add it to /opt/fenwick/.env afterwards"
    rm -f "$keyfile"
  fi

  echo
  # PATH is set explicitly: a bare 'pct exec' shell can come up with a trimmed
  # PATH, and then a freshly installed node in /usr/local/bin is invisible.
  pct exec "$CTID" -- env "PATH=$CT_PATH" bash /root/fenwick-install.sh
}

# is there already a fenwick container? used to offer a repair/update instead of
# quietly creating a second one
find_existing_ct() {
  local conf dir
  dir=${FENWICK_LXC_DIR:-/etc/pve/lxc}
  for conf in "$dir"/*.conf; do
    [ -f "$conf" ] || continue
    if grep -qE "^hostname: ${DEFAULT_HOSTNAME}\$" "$conf" 2>/dev/null; then
      basename "$conf" .conf
      return 0
    fi
  done
  return 1
}

# re-run the installer inside an existing container: code is refreshed from the
# repo, data/ .env and config.json stay exactly as they are
repair_inside() {
  local script="/tmp/fenwick-install-$$.sh"
  pct status "$CTID" >/dev/null 2>&1 || die "container $CTID does not exist"
  pct status "$CTID" | grep -q running || {
    info "starting container $CTID"
    pct start "$CTID" >/dev/null 2>&1 || die "could not start $CTID"
    sleep 2
  }
  curl -fsSL "${RAW}/install/fenwick-install.sh" -o "$script" ||
    die "could not download install/fenwick-install.sh from github.com/$REPO"
  pct push "$CTID" "$script" /root/fenwick-install.sh --perms 0700 >/dev/null ||
    die "could not push the installer into $CTID"
  rm -f "$script"
  echo
  pct exec "$CTID" -- env "PATH=$CT_PATH" bash /root/fenwick-install.sh
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
banner
require_host

CT_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# An earlier run may have stopped halfway. Re-running the paste command should
# fix that container, not build a second one next to it.
EXISTING=$(find_existing_ct || true)
if [ -n "$EXISTING" ]; then
  CTID=$EXISTING
  info "found an existing fenwick container ($EXISTING)"
  ACTION=$(menu "Existing install" "Container $EXISTING is already here. What now?" \
    "repair" "reinstall the code and service, keeping his life and your key" \
    "new" "leave it alone and create a second container") || cancel
  [ -n "$ACTION" ] || cancel

  if [ "$ACTION" = "repair" ]; then
    repair_inside
    ct_ip=$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}') || true
    cat <<EOF

${G}  ✓ Fenwick is up in container ${CTID}.${O}

${B}  the town${O}     http://${ct_ip:-<container-ip>}:4321
${B}  his mind${O}     http://${ct_ip:-<container-ip>}:4321/mind

  watch him think   pct exec $CTID -- journalctl -u fenwick -f
  update the code   pct exec $CTID -- env PATH=$CT_PATH bash /opt/fenwick/deploy/install.sh

EOF
    exit 0
  fi
  CTID=""
fi

MODE=$(menu "Setup" "Default settings, or choose your own?" \
  "default" "1 core · 1024 MB RAM · 8 GB disk · DHCP · next free CT ID" \
  "advanced" "pick the hostname, resources, network and password") || cancel
[ -n "$MODE" ] || cancel

HOSTNAME=$DEFAULT_HOSTNAME
CORES=$DEFAULT_CORES
RAM=$DEFAULT_RAM
SWAP=$DEFAULT_SWAP
DISK=$DEFAULT_DISK
BRIDGE=$DEFAULT_BRIDGE
DNS=$DEFAULT_DNS
NET_MODE="dhcp"
STATIC_CIDR=""
GATEWAY=$(default_gateway || true)
# cut, not head: an early-closing pipe stage would fail the pipeline under pipefail
CT_PASS=$(dd if=/dev/urandom bs=64 count=1 2>/dev/null | LC_ALL=C tr -dc 'a-zA-Z0-9' | cut -c1-16)
[ "${#CT_PASS}" -ge 8 ] || CT_PASS="fenwick$((RANDOM))"

if [ "$MODE" = "advanced" ]; then
  HOSTNAME=$(ask "Hostname" "What should the container be called?" "$DEFAULT_HOSTNAME") || cancel
  CORES=$(ask "CPU" "Cores:" "$DEFAULT_CORES") || cancel
  RAM=$(ask "Memory" "RAM in MB (1 GB is comfortable, 512 works):" "$DEFAULT_RAM") || cancel
  DISK=$(ask "Disk" "Disk in GB:" "$DEFAULT_DISK") || cancel

  # storage, if there is more than one candidate (no mapfile: this has to run
  # on whatever bash the host has, and mapfile is bash 4+)
  stores=()
  while IFS= read -r line; do [ -n "$line" ] && stores+=("$line"); done < <(rootdir_storages)
  if [ "${#stores[@]}" -eq 0 ]; then
    die "no storage with 'rootdir' content — enable it under Datacenter → Storage"
  elif [ "${#stores[@]}" -eq 1 ]; then
    STORAGE="${stores[0]}"
  else
    opts=()
    for s in "${stores[@]}"; do opts+=("$s" ""); done
    STORAGE=$(menu "Storage" "Where should his disk live?" "${opts[@]}") || cancel
  fi

  brs=()
  while IFS= read -r line; do [ -n "$line" ] && brs+=("$line"); done < <(bridges)
  if [ "${#brs[@]}" -eq 1 ]; then
    BRIDGE="${brs[0]}"
  elif [ "${#brs[@]}" -gt 1 ]; then
    opts=()
    for b in "${brs[@]}"; do opts+=("$b" ""); done
    BRIDGE=$(menu "Bridge" "Which network bridge?" "${opts[@]}") || cancel
  fi

  NET_MODE=$(menu "Network" "Address:" \
    "dhcp" "ask your router (fine — I print the address at the end)" \
    "static" "fixed IP, so nothing has to look him up") || cancel
  if [ "$NET_MODE" = "static" ]; then
    STATIC_CIDR=$(ask_plain "Static address" "Address with prefix, e.g. 192.168.1.50/24:") || cancel
    [ -n "$STATIC_CIDR" ] || die "a static setup needs an address"
    GATEWAY=$(ask "Gateway" "Default gateway:" "${GATEWAY:-192.168.1.1}") || cancel
  fi

  DNS=$(ask "DNS" "Resolver for the container (he needs outbound HTTPS):" "$DEFAULT_DNS") || cancel
fi

STORAGE=${STORAGE:-$(rootdir_storages | head -1)}
[ -n "$STORAGE" ] || die "no storage with 'rootdir' content — enable it under Datacenter → Storage"

API_KEY=$(ask "Model key" "Paste a free Gemini API key, or leave this empty.

He needs a language model to deliberate. Without one he still lives — walking,
eating, sleeping, judging what you leave him — but he stops making real
decisions. Free key, no card: https://aistudio.google.com/apikey

Leave empty to add it later." "") || API_KEY=""
API_KEY=$(printf '%s' "${API_KEY:-}" | tr -d '[:space:]')

printf '\n%s  About to create:%s\n' "$B" "$O"
msg "container   ${CTID:-$(next_ctid)} on $STORAGE, ${DISK} GB, unprivileged"
msg "resources   ${CORES} core, ${RAM} MB RAM, ${SWAP} MB swap"
msg "network     ${BRIDGE}, ${NET_MODE}${STATIC_CIDR:+ ($STATIC_CIDR)}"
msg "model key   $([ -n "$API_KEY" ] && echo 'provided' || echo 'none — reflex only')"
echo
confirm "Confirm" "Create it now?" || { printf '\n  cancelled.\n\n'; exit 0; }

ensure_template
create_ct
install_inside

cat <<EOF

${G}  ✓ Fenwick is installed and running.${O}

${B}  the town${O}     http://${ct_ip:-<container-ip>}:4321
${B}  his diary${O}    http://${ct_ip:-<container-ip>}:4321/diary
${B}  his memory${O}   http://${ct_ip:-<container-ip>}:4321/memories
${B}  his mind${O}     http://${ct_ip:-<container-ip>}:4321/mind
${B}  offerings${O}    http://${ct_ip:-<container-ip>}:4321/offerings

  container $CTID, hostname $HOSTNAME

  watch him think   pct exec $CTID -- journalctl -u fenwick -f
  restart           pct exec $CTID -- systemctl restart fenwick
  update the code   pct exec $CTID -- env PATH=$CT_PATH bash /opt/fenwick/deploy/install.sh
  add a model key   pct exec $CTID -- nano /opt/fenwick/.env
                    pct exec $CTID -- systemctl restart fenwick
  his files         pct exec $CTID -- ls /opt/fenwick/data

  container root password: ${CT_PASS}
  ${D}write it down. there is no sshd inside — use 'pct exec', or
  install openssh-server yourself if you want to log in${O}

EOF

if [ -z "$API_KEY" ]; then
  printf '%s  He is on reflexes until you add a key.%s\n' "$Y" "$O"
  printf '  Free, no card: https://aistudio.google.com/apikey\n\n'
fi
