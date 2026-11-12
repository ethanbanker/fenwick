#!/usr/bin/env bash
# Back up his data from the Proxmox host, so the container does not need write
# access to the NAS share (unprivileged LXC + CIFS ownership makes that fragile).
#
#   sudo DEST=/mnt/nasnet/fenwick bash deploy/backup-host.sh
#
# Runs on the host. Archives data/ + config.json from inside the container, pulls
# the archive out, verifies it reads back, then prunes to the last KEEP copies.
set -euo pipefail

DEST=${DEST:-/mnt/nasnet/fenwick}
CTID=${CTID:-103}
APP=${APP:-/opt/fenwick}
KEEP=${KEEP:-14}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
NAME="fenwick-$STAMP.tar.gz"
TMP="$DEST/.$NAME.part"
INSIDE="/tmp/fenwick-backup-$STAMP.tar.gz"

fail() { printf 'backup: %s\n' "$*" >&2; exit 1; }

[ -d "$DEST" ] || fail "$DEST is not a directory — is the share mounted?"
pct status "$CTID" >/dev/null 2>&1 || fail "container $CTID is not there"

# build it inside the container, where his data actually lives
pct exec "$CTID" -- tar -czf "$INSIDE" -C "$APP" data config.json || fail "tar failed inside $CTID"
pct pull "$CTID" "$INSIDE" "$TMP" || { pct exec "$CTID" -- rm -f "$INSIDE"; fail "could not pull the archive out"; }
pct exec "$CTID" -- rm -f "$INSIDE"

# never rotate away good copies for an archive that cannot be read
tar -tzf "$TMP" >/dev/null || { rm -f "$TMP"; fail "the new archive did not read back; keeping the old ones"; }
mv "$TMP" "$DEST/$NAME"
( cd "$DEST" && sha256sum "$NAME" > "$NAME.sha256" )

ls -1t "$DEST"/fenwick-*.tar.gz 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
  rm -f "$old" "$old.sha256"
done

printf 'backup: %s (%s), %s kept in %s\n' \
  "$NAME" "$(du -h "$DEST/$NAME" | cut -f1)" \
  "$(ls -1 "$DEST"/fenwick-*.tar.gz 2>/dev/null | wc -l | tr -d ' ')" "$DEST"
