#!/usr/bin/env bash
# Starts the service (with the web page on the same address) in the background. Runs each time the Codespace starts or resumes,
# so it must be quick and must not start a second copy. Output goes to a log file; the pairing link is printed here once.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
ROOT="$PWD"
PORT="${GATEWAY_PORT:-4580}"
STATE="${DATA_DIR:-/workspaces/screenshot-data}"
LOG="$STATE/service.log"
PIDFILE="$STATE/service.pid"

mkdir -p "$STATE"
chmod 700 "$STATE"

if [ ! -f "$ROOT/service/dist/index.js" ] || [ ! -f "$ROOT/frontend/dist/index.html" ]; then
  echo "The service or the web page is not built yet. Run: bash scripts/codespaces/post-create.sh" >&2
  exit 1
fi

# Already running? The web page's own address answers /api/health as this service.
is_up() { curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"screenshot-gallery-service"'; }

if is_up; then
  echo "The service is already running."
else
  # Only a leftover of this script is cleaned up: the process in our own pid file, and only if it is still a node process.
  if [ -f "$PIDFILE" ]; then
    old="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "$old" ] && [ "$(ps -p "$old" -o comm= 2>/dev/null || true)" = "node" ]; then kill "$old" 2>/dev/null || true; sleep 1; fi
    rm -f "$PIDFILE"
  fi
  # The service reads service/.env itself; values set here (devcontainer.json) win over it.
  ( cd "$ROOT/service" && nohup node dist/index.js >"$LOG" 2>&1 & echo $! >"$PIDFILE" )

  for _ in $(seq 1 60); do
    is_up && break
    sleep 0.5
  done
  if ! is_up; then
    echo "The service did not start within 30 seconds. Last lines of $LOG:" >&2
    tail -n 25 "$LOG" >&2 || true
    exit 1
  fi
fi

# The pairing link is the only thing worth printing. Anyone who has it can control this service, so it is not written anywhere
# but this terminal and the log file (readable by this user only).
echo
grep -A1 -m1 'Open this link once to pair this browser' "$LOG" | tail -n 1 | sed 's/^ *//' || true
echo
echo "Open the link above in your browser once. The 'Screenshot Gallery' port stays private to your GitHub account."
