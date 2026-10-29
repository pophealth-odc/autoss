#!/bin/sh
# Starts the service inside the container.
#
#  * Render tells a web service which port to use through PORT. The gateway (the one public listener) takes that port.
#    The service behind it must NOT also try to use it: the service reads PORT too, so it is told to pick any free port, which
#    only the gateway ever connects to, on 127.0.0.1.
#  * A persistent disk is mounted by the platform, usually owned by root. When this runs as root it makes the storage folders
#    and gives them to the unprivileged "node" user, then continues as that user. The service itself never runs as root.
#  * The two secrets must be set. The service checks their form; this only gives a clearer message than "invalid configuration".
set -eu

# The port the platform wants us on, else the image's default. Exported for the gateway, the health check and the service.
GATEWAY_PORT="${PORT:-${GATEWAY_PORT:-10000}}"
export GATEWAY_PORT
# 0 = any free port. Without this the service would take the same port as the gateway and the gateway could not start.
PORT=0
export PORT

fail() {
  echo >&2
  echo "  $1" >&2
  echo >&2
  exit 1
}

[ -n "${GATEWAY_ACCESS_PASSWORD:-}" ] || fail "GATEWAY_ACCESS_PASSWORD is not set. Set it (16 or more characters) in the service's Environment settings."
[ -n "${PAIRING_TOKEN:-}" ] || fail "PAIRING_TOKEN is not set. Set it (24 or more letters, digits, - _ . ~ + / =) in the service's Environment settings."

SCREENSHOTS_DIR="${SCREENSHOTS_DIR:-/data/screenshots}"
DATA_DIR="${DATA_DIR:-/data/state}"

# Gives a folder to the unprivileged user, but only when it is not theirs already. Walking a disk that holds thousands of
# screenshots on every start would delay the health check for no reason; a folder that was handed over once stays handed over.
hand_over() {
  mkdir -p "$1"
  if [ "$(stat -c %U "$1")" != "node" ]; then
    chown -R node:node "$1"
  fi
  chmod 700 "$1"
}

if [ "$(id -u)" = "0" ]; then
  hand_over "$SCREENSHOTS_DIR"
  hand_over "$DATA_DIR"
  # Edge writes its profile and cache under the home folder and /tmp.
  export HOME=/home/node
  exec gosu node "$@"
fi

mkdir -p "$SCREENSHOTS_DIR" "$DATA_DIR"
exec "$@"
