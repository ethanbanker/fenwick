#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# install.sh — run this ON the machine that will keep him alive.
#
#   cd ~/fenwick && bash deploy/install.sh
#
# It is safe to re-run, and re-running it is how you update: it re-deploys the
# service unit and restarts him. It never touches data/ (his life) or .env
# (your key).
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SERVICE_NAME=${SERVICE_NAME:-fenwick}
INSTALL_PREFIX=${INSTALL_PREFIX:-/opt}
BIN_DIR=${BIN_DIR:-/usr/local/bin}
UNIT_DIR=${UNIT_DIR:-/etc/systemd/system}
MIN_MAJOR=22
MIN_MINOR=6

bold=$(printf '\033[1m'); off=$(printf '\033[0m')
step() { printf '\n%s>>%s %s\n' "$bold" "$off" "$*"; }
say()  { printf '   %s\n' "$*"; }
warn() { printf '   %s!%s %s\n' "$bold" "$off" "$*" >&2; }

SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi

# a fresh minimal debian often has no curl, and everything below uses it
if ! command -v curl >/dev/null 2>&1; then
  step "curl"
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -qq && $SUDO apt-get install -y curl
  elif command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y curl
  elif command -v pacman >/dev/null 2>&1; then
    $SUDO pacman -Sy --noconfirm curl
  else
    warn "curl is missing and I do not recognise the package manager. Install curl and re-run."
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 1. Node. Must be >= 22.6, because that is when node started running
#    TypeScript without a build step — and this project has no build step.
# ---------------------------------------------------------------------------
node_is_new_enough() {
  local bin=$1 v major rest minor
  command -v "$bin" >/dev/null 2>&1 || return 1
  v=$("$bin" -v 2>/dev/null) || return 1
  v=${v#v}
  case $v in [0-9]*) ;; *) return 1 ;; esac
  major=${v%%.*}
  rest=${v#*.}
  minor=${rest%%.*}
  case $minor in ''|*[!0-9]*) return 1 ;; esac
  [ "$major" -gt "$MIN_MAJOR" ] && return 0
  [ "$major" -eq "$MIN_MAJOR" ] && [ "$minor" -ge "$MIN_MINOR" ] && return 0
  return 1
}

node_platform() {
  case $(uname -m) in
    x86_64 | amd64) echo linux-x64 ;;
    aarch64 | arm64) echo linux-arm64 ;;
    ppc64le) echo linux-ppc64le ;;
    *) return 1 ;;
  esac
}

install_node() {
  local platform version tarball tmp
  platform=${NODE_PLATFORM:-$(node_platform)} || {
    warn "no official Node build for $(uname -m). Install Node >= ${MIN_MAJOR}.${MIN_MINOR} yourself (nvm works) and re-run."
    exit 1
  }

  say "asking nodejs.org for the current LTS…"
  # read the whole table: exiting awk early kills curl with SIGPIPE, and
  # pipefail turns that into a failed install
  version=$(curl -fsSL https://nodejs.org/dist/index.tab |
    awk -F'\t' '!v && NR>1 && $10!="-" {v=$1} END{print v}' || true)
  [ -n "$version" ] || { warn "could not reach nodejs.org. Check the network and re-run."; exit 1; }

  tarball="node-${version}-${platform}.tar.gz"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN

  say "downloading ${tarball}"
  curl -fL --progress-bar -o "$tmp/$tarball" "https://nodejs.org/dist/${version}/${tarball}"

  say "extracting to ${INSTALL_PREFIX}"
  $SUDO mkdir -p "$INSTALL_PREFIX" "$BIN_DIR"
  $SUDO tar -xzf "$tmp/$tarball" -C "$INSTALL_PREFIX"

  # symlink the binaries individually rather than the whole bin directory, so an
  # apt-managed npm is not silently replaced by a second copy of itself
  local dir="$INSTALL_PREFIX/node-${version}-${platform}"
  $SUDO ln -sfn "$dir/bin/node" "$BIN_DIR/node"
  $SUDO ln -sfn "$dir/bin/npm" "$BIN_DIR/npm"
  $SUDO ln -sfn "$dir/bin/npx" "$BIN_DIR/npx"

  find_node || {
    warn "node was unpacked but nothing runnable was found — see ${INSTALL_PREFIX}"
    exit 1
  }
  say "node $("$NODE_BIN" -v) installed at $NODE_BIN"
}

# Keep the resolved node in one place. Never trust PATH: inside a freshly created
# container PATH can be trimmed, and then a perfectly good install looks like a
# missing one (this actually happened on the first real deployment).
find_node() {
  NODE_BIN=""
  local cand found

  for cand in "$BIN_DIR/node" /usr/local/bin/node /usr/bin/node; do
    if [ -x "$cand" ]; then NODE_BIN=$cand; break; fi
  done

  if [ -z "$NODE_BIN" ]; then
    # the symlink did not resolve; find what the tarball actually produced
    found=$(ls -d "$INSTALL_PREFIX"/node-v*/bin/node 2>/dev/null | head -1 || true)
    if [ -n "$found" ]; then
      $SUDO mkdir -p "$BIN_DIR" 2>/dev/null || true
      $SUDO ln -sfn "$found" "$BIN_DIR/node" 2>/dev/null || true
      [ -x "$BIN_DIR/node" ] && NODE_BIN="$BIN_DIR/node"
    fi
  fi

  [ -n "$NODE_BIN" ] || return 1

  # make it visible to anything this script shells out to later, and to the
  # user's own shells
  case ":$PATH:" in
    *":$(dirname "$NODE_BIN"):"*) ;;
    *) PATH="$(dirname "$NODE_BIN"):$PATH"; export PATH ;;
  esac
  hash -r 2>/dev/null || true
  return 0
}

require_node() {
  find_node && return 0
  warn "node is on disk but will not run as ${BIN_DIR}/node:"
  ls -l "$BIN_DIR/node" >&2 2>/dev/null || true
  ls -l "$INSTALL_PREFIX"/node-v*/bin/node >&2 2>/dev/null || true
  warn "remove ${INSTALL_PREFIX}/node-v* and re-run, or install node >= ${MIN_MAJOR}.${MIN_MINOR} yourself."
  exit 1
}

step "node"
# look for node on disk before asking PATH, so a copy installed by an earlier
# run is found even if this shell's PATH does not include it
if find_node && node_is_new_enough "$NODE_BIN"; then
  say "node $("$NODE_BIN" -v) — fine"
else
  if [ -n "${NODE_BIN:-}" ]; then
    say "node $("$NODE_BIN" -v) is too old (needs ${MIN_MAJOR}.${MIN_MINOR}+)"
  elif command -v node >/dev/null 2>&1; then
    say "node $(node -v) is too old (needs ${MIN_MAJOR}.${MIN_MINOR}+)"
  else
    say "no node found"
  fi
  install_node
  require_node
  node_is_new_enough "$NODE_BIN" || {
    warn "node $("$NODE_BIN" -v 2>/dev/null) is too old, needs ${MIN_MAJOR}.${MIN_MINOR}+"
    exit 1
  }
fi
find_node
# resolve node for the rest of the script even when it was already installed
[ -n "${NODE_BIN:-}" ] && [ -x "$NODE_BIN" ] || link_node

# ---------------------------------------------------------------------------
# 2. His key.
# ---------------------------------------------------------------------------
step "config"
if [ ! -f "$ROOT/.env" ]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  chmod 600 "$ROOT/.env"
  say "created .env from the template"
fi
if grep -qE '^(GEMINI_API_KEY|LLM_API_KEY|OPENAI_API_KEY)=.+' "$ROOT/.env"; then
  say "an api key is set"
else
  warn "no api key in $ROOT/.env"
  warn "he will still live (reflex brain: walking, eating, sleeping, judging offerings)"
  warn "but he will not deliberate. get a free key: https://aistudio.google.com/apikey"
  warn "then: nano $ROOT/.env   and re-run this script"
fi
[ -f "$ROOT/config.json" ] || { warn "config.json missing — it is part of the repo"; exit 1; }
say "his data lives in $ROOT/data (created on first run, never touched here)"

# port: PORT wins, else config.json, else 4321
PORT_RESOLVED=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]\{2,5\}\).*/\1/p' "$ROOT/config.json" | head -1)
PORT_RESOLVED=${PORT:-${PORT_RESOLVED:-4321}}

# ---------------------------------------------------------------------------
# 3. Keep him running.
# ---------------------------------------------------------------------------
if ! command -v systemctl >/dev/null 2>&1; then
  step "no systemd here"
  say "starting him in the foreground instead. ctrl-c stops him."
  say "to keep him alive across reboots, use systemd, launchd, or a tmux session."
  exec "$NODE_BIN" "$ROOT/src/start.ts"
fi

step "service"
UNIT_FILE="$UNIT_DIR/${SERVICE_NAME}.service"
$SUDO mkdir -p "$UNIT_DIR"
$SUDO tee "$UNIT_FILE" >/dev/null <<UNIT
[Unit]
Description=Fenwick — an owl who lives here
Documentation=file://${ROOT}/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=${ROOT}
ExecStart=${NODE_BIN} src/start.ts
Restart=always
RestartSec=5
# he saves his state on SIGTERM, so give him a moment to finish the write
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
UNIT
say "wrote $UNIT_FILE"

$SUDO systemctl daemon-reload
$SUDO systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
# restart rather than start, so re-running this script actually picks up code changes
$SUDO systemctl restart "$SERVICE_NAME"
say "started (and enabled at boot)"

# ---------------------------------------------------------------------------
# 4. Is he actually alive?
# ---------------------------------------------------------------------------
step "health"
ok=""
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT_RESOLVED}/api/state" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done

if [ -z "$ok" ]; then
  warn "he did not answer on port ${PORT_RESOLVED} within 20s. last lines:"
  $SUDO journalctl -u "$SERVICE_NAME" -n 25 --no-pager || true
  exit 1
fi

# hostname -I is linux-only; under pipefail a failure here would kill the script
# silently just before it prints the addresses
lan=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
say "alive on port ${PORT_RESOLVED}"
printf '\n%s   the town:   http://%s:%s%s\n' "$bold" "${lan:-127.0.0.1}" "$PORT_RESOLVED" "$off"
printf '%s   his mind:   http://%s:%s/mind%s\n' "$bold" "${lan:-127.0.0.1}" "$PORT_RESOLVED" "$off"
printf '%s   leave him something: http://%s:%s/offerings%s\n\n' "$bold" "${lan:-127.0.0.1}" "$PORT_RESOLVED" "$off"
say "logs:  sudo journalctl -u ${SERVICE_NAME} -f"
say "stop:  sudo systemctl stop ${SERVICE_NAME}"
say "if you want him reachable as ${SERVICE_NAME}.local, install avahi-daemon"
