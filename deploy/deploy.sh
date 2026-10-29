#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# deploy.sh — run this from your computer to push him to the micropc.
#
#   ./deploy/deploy.sh you@micropc.local
#   ./deploy/deploy.sh you@192.168.1.42 fenwick      # a different remote dir
#
# Three things are deliberately never overwritten on the far side:
#   data/         his life — memory, diary, persona, the offerings you left him
#   .env          your api key, only copied if the remote has none yet
#   config.json   how you tuned him on the device, only copied if missing
# Each is copied once, the first time, and then left alone.
# ---------------------------------------------------------------------------
set -euo pipefail

usage() {
  sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

TARGET=${1:-}
REMOTE_DIR=${2:-fenwick}
[ -n "$TARGET" ] || usage

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

command -v rsync >/dev/null 2>&1 || { echo "rsync is not installed here"; exit 1; }

printf '\n>> checking %s\n' "$TARGET"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" 'uname -sm; command -v node >/dev/null && node -v || echo "no node yet"' ||
  { echo "could not ssh to $TARGET — try 'ssh $TARGET' once by hand to accept the host key"; exit 1; }

printf '\n>> sending code to %s:%s\n' "$TARGET" "$REMOTE_DIR"
rsync -az --delete --stats \
  --exclude '.git/' \
  --exclude 'data/' \
  --exclude '.env' \
  --exclude 'config.json' \
  --exclude 'node_modules/' \
  --exclude '.DS_Store' \
  "$ROOT"/ "$TARGET:$REMOTE_DIR"/

# first run only: his settings and your key
for f in config.json .env; do
  [ -f "$ROOT/$f" ] || continue
  if ssh "$TARGET" "test -f '$REMOTE_DIR/$f'"; then
    printf '   %s already on the device — left alone\n' "$f"
  else
    rsync -az "$ROOT/$f" "$TARGET:$REMOTE_DIR/$f"
    printf '   copied %s\n' "$f"
  fi
done

printf '\n>> installing on the device\n'
ssh -t "$TARGET" "cd '$REMOTE_DIR' && bash deploy/install.sh"
