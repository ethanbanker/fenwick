#!/usr/bin/env bash
# Back up everything that is his, to any directory you can write to — a mounted
# NAS share is the expected use.
#
#   DEST=/mnt/nas/fenwick bash deploy/backup.sh
#   DEST=/mnt/nas/fenwick KEEP=30 bash deploy/backup.sh
#
# What goes in: data/ (his memory, diary, thoughts, vault, marks, workshop,
# offerings), config.json, and the service unit. What does not: .env, because it
# holds API keys and a backup should not be a second copy of your secrets.
#
# The archive is verified by reading it back before the old copies are pruned, so
# a full disk or an interrupted write cannot silently rotate away good backups.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DEST=${DEST:-}
KEEP=${KEEP:-14}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
NAME="fenwick-$STAMP.tar.gz"

fail() { printf 'backup: %s\n' "$*" >&2; exit 1; }

[ -n "$DEST" ] || fail "DEST is required, e.g. DEST=/mnt/nas/fenwick"
[ -d "$DEST" ] || fail "DEST $DEST is not a directory — is the share mounted?"
[ -d "$ROOT/data" ] || fail "$ROOT/data does not exist; nothing to back up"

# refuse to run on a mount that has gone away
df -P "$DEST" >/dev/null 2>&1 || fail "cannot stat the filesystem for $DEST"
avail_kb=$(df -P "$DEST" | awk 'NR==2 {print $4}')
[ "${avail_kb:-0}" -gt 5120 ] || fail "less than 5MB free on $DEST"

tmp="$DEST/.$NAME.part"
trap 'rm -f "$tmp"' EXIT

tar -czf "$tmp" -C "$ROOT" data config.json deploy/install.sh 2>/dev/null ||
  tar -czf "$tmp" -C "$ROOT" data config.json

# read it back before trusting it
tar -tzf "$tmp" >/dev/null || fail "the archive did not read back cleanly; keeping the old copies"

mv "$tmp" "$DEST/$NAME"
( cd "$DEST" && sha256sum "$NAME" > "$NAME.sha256" )

# prune, oldest first, but never the one just written
ls -1t "$DEST"/fenwick-*.tar.gz 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
  rm -f "$old" "$old.sha256"
done

size=$(du -h "$DEST/$NAME" | cut -f1)
count=$(ls -1 "$DEST"/fenwick-*.tar.gz 2>/dev/null | wc -l | tr -d ' ')
printf 'backup: %s (%s), %s kept in %s\n' "$NAME" "$size" "$count" "$DEST"
