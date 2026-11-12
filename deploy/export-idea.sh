#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# export-idea.sh — print the oldest pending idea as a self-contained build
# prompt, ready to hand to Freebuff on the server.
#
#   ./deploy/export-idea.sh                 # read ./data
#   ./deploy/export-idea.sh /opt/fenwick/data
#   ./deploy/export-idea.sh /opt/fenwick/data --claim
#
# --claim moves the idea from pending/ to claimed/ so a second run does not
# hand the same one out twice. The world still needs the file at the reserved
# target path; once it exists, the idea is moved to done/ automatically.
# ---------------------------------------------------------------------------
set -euo pipefail

DATA_DIR=${1:-data}
CLAIM=${2:-}
if [ ! -d "$DATA_DIR/ideas/pending" ]; then
  echo "no idea queue at $DATA_DIR/ideas/pending" >&2
  exit 1
fi

shopt -s nullglob
files=("$DATA_DIR"/ideas/pending/*.md)
if [ ${#files[@]} -eq 0 ]; then
  echo "no pending ideas" >&2
  exit 1
fi

oldest=$(ls -tr "${files[@]}" | head -1)
json="${oldest%.md}.json"

printf '%s\n\n' "You are building one object for a small neon town. Create exactly the one file the brief asks for. Do not ask questions, do not change any other file."
cat "$oldest"

if [ "$CLAIM" = "--claim" ]; then
  mkdir -p "$DATA_DIR/ideas/claimed"
  mv -f "$oldest" "$DATA_DIR/ideas/claimed/" 2>/dev/null || true
  [ -f "$json" ] && mv -f "$json" "$DATA_DIR/ideas/claimed/" 2>/dev/null || true
  echo
  echo "(claimed: $(basename "$oldest"))" >&2
fi
