#!/usr/bin/env bash
# Install a nightly backup of his data to a mounted directory.
#
#   sudo bash install/backup-timer.sh /mnt/nas/fenwick [hour]
#
# Runs deploy/backup.sh as a systemd service at the given UTC hour (default 04:00),
# keeping 14 days. Idempotent.
set -euo pipefail

DEST="${1:-}"
HOUR="${2:-4}"
APP_DIR="${FENWICK_DIR:-/opt/fenwick}"
SERVICE="fenwick-backup"

fail() { printf 'backup-timer: %s\n' "$*" >&2; exit 1; }

[ -n "$DEST" ] || fail "usage: backup-timer.sh /mounted/path [hour]"
[ -d "$DEST" ] || fail "$DEST is not a directory — mount the share first"
[ -x "$APP_DIR/deploy/backup.sh" ] || chmod +x "$APP_DIR/deploy/backup.sh" 2>/dev/null || true
[ -f "$APP_DIR/deploy/backup.sh" ] || fail "$APP_DIR/deploy/backup.sh is missing"

# prove it works right now rather than discovering it at 04:00
if ! DEST="$DEST" KEEP=14 bash "$APP_DIR/deploy/backup.sh"; then
  fail "the first backup failed; not installing a timer that will fail quietly"
fi

cat >"/etc/systemd/system/${SERVICE}.service" <<UNIT
[Unit]
Description=Fenwick — back up his data
After=network-online.target

[Service]
Type=oneshot
Environment=DEST=${DEST}
Environment=KEEP=14
ExecStart=/bin/bash ${APP_DIR}/deploy/backup.sh
UNIT

cat >"/etc/systemd/system/${SERVICE}.timer" <<UNIT
[Unit]
Description=Fenwick — nightly backup

[Timer]
OnCalendar=*-*-* ${HOUR}:00:00
Persistent=true
RandomizedDelaySec=300
Unit=${SERVICE}.service

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now "${SERVICE}.timer" >/dev/null 2>&1
printf 'backup-timer: %s runs daily at %02d:00 UTC into %s (keeps 14)\n' "$SERVICE" "$HOUR" "$DEST"
systemctl list-timers "${SERVICE}.timer" --no-pager | head -3
