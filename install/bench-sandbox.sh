#!/usr/bin/env bash
# Create the unprivileged user his approved commands run as.
#
# Some containers have no useradd, so this writes the account into /etc/passwd
# directly. Idempotent: run it as often as you like.
#
#   sudo bash install/bench-sandbox.sh [name] [uid] [gid]
set -euo pipefail

NAME="${1:-builder}"
UID_="${2:-1500}"
GID_="${3:-1500}"
APP_DIR="${FENWICK_DIR:-/opt/fenwick}"
WORKSHOP="$APP_DIR/data/workshop"

say() { printf '%s\n' "$*"; }

if ! command -v setpriv >/dev/null 2>&1; then
  say "setpriv is missing (util-linux). The bench cannot drop privileges without it." >&2
  exit 1
fi

if ! grep -q "^${NAME}:" /etc/group 2>/dev/null; then
  printf '%s:x:%s:\n' "$NAME" "$GID_" >>/etc/group
  say "group   ${NAME} (${GID_})"
else
  say "group   ${NAME} already exists"
fi

if ! grep -q "^${NAME}:" /etc/passwd 2>/dev/null; then
  printf '%s:*:%s:%s::%s:/usr/sbin/nologin\n' "$NAME" "$UID_" "$GID_" "$WORKSHOP" >>/etc/passwd
  say "user    ${NAME} (${UID_}:${GID_})"
else
  say "user    ${NAME} already exists"
fi

mkdir -p "$WORKSHOP"
chown -R "$NAME:$NAME" "$WORKSHOP" 2>/dev/null || true
# group: he can write, the service (root) can read, nobody else needs in
chmod 0750 "$WORKSHOP"
say "home    $WORKSHOP (0750, owned by ${NAME})"

UID_REAL="$(id -u "$NAME")"
GID_REAL="$(id -g "$NAME")"
say "resolved uid:gid = ${UID_REAL}:${GID_REAL}"

if command -v unshare >/dev/null 2>&1; then
  if unshare -n -- setpriv --reuid="$UID_REAL" --regid="$GID_REAL" --clear-groups -- sh -c 'true' 2>/dev/null; then
    say "network namespace: available — approved commands get no network"
  else
    say "network namespace: NOT available — commands will run with network access" >&2
  fi
else
  say "network namespace: unshare missing — commands will run with network access" >&2
fi

say ""
say "The bench is reachable from the admin panel: /admin, 'bench' section."
say "Approve or refuse each command there; approved output comes back to him next turn."
