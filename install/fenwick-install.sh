#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# fenwick-install.sh — runs INSIDE the container, called by ct/fenwick.sh.
#
# Fetches the app, puts it in /opt/fenwick, then hands over to the app's own
# installer (deploy/install.sh), which deals with Node, the service and systemd.
#
# Safe to re-run: it replaces the code but never his data, his .env or the
# config.json you tuned.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO="${REPO:-ethanbanker/fenwick}"
BRANCH="${BRANCH:-main}"
DEST="${DEST:-/opt/fenwick}"
KEYFILE="${KEYFILE:-/root/.fenwick-key}"

say()  { printf '   %s\n' "$*"; }
step() { printf '\n >> %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive

step "base packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates tar >/dev/null
say "curl, certificates, tar"

step "source"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz" -o "$tmp/src.tar.gz" ||
  { echo "could not download the repo — is github.com/${REPO} reachable?" >&2; exit 1; }
tar -xzf "$tmp/src.tar.gz" -C "$tmp"
# awk rather than head -1: an early-closing pipe would fail under pipefail
src=$(find "$tmp" -maxdepth 1 -mindepth 1 -type d -name 'fenwick-*' |
  awk '!s {s=$0} END{print s}')
[ -n "$src" ] || { echo "the tarball did not contain a fenwick-* directory" >&2; exit 1; }
say "downloaded ${BRANCH}"

mkdir -p "$DEST"

# Copy the code over the old code, but never over his life or your settings.
# tar pipe rather than rsync so this does not need another package.
#
# config.json is only protected if it already exists — excluding it on a first
# install would leave him with no config at all.
excludes=(--exclude=./data --exclude=./.env --exclude=./.git --exclude=./.DS_Store)
if [ -d "$DEST/src" ]; then
  excludes+=(--exclude=./config.json)
  say "updating in place — keeping data/, .env, config.json"
fi
( cd "$src" && tar -cf - "${excludes[@]}" . ) | tar -xf - -C "$DEST"

chmod +x "$DEST/deploy/install.sh" "$DEST/deploy/deploy.sh" 2>/dev/null || true

step "model key"
if [ -s "$KEYFILE" ]; then
  key=$(tr -d '\r\n' < "$KEYFILE")
  if [ -n "$key" ]; then
    # rebuild the line rather than sed it, so nothing in the key can be read as
    # a sed expression
    if [ -f "$DEST/.env" ]; then
      grep -v '^GEMINI_API_KEY=' "$DEST/.env" > "$DEST/.env.tmp" || true
      printf 'GEMINI_API_KEY=%s\n' "$key" >> "$DEST/.env.tmp"
      mv "$DEST/.env.tmp" "$DEST/.env"
    else
      printf 'GEMINI_API_KEY=%s\n' "$key" > "$DEST/.env"
    fi
    chmod 600 "$DEST/.env"
    say "key written to .env (600)"
  fi
  rm -f "$KEYFILE"
else
  say "no key supplied"
fi

step "install"
rm -rf "$tmp"
trap - EXIT
cd "$DEST"
exec bash "$DEST/deploy/install.sh"
