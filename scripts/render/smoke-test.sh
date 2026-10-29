#!/usr/bin/env bash
# Builds the image and checks that it behaves as the Render deployment needs it to. Needs Docker and curl. Used by CI; run it
# by hand with:  bash scripts/render/smoke-test.sh
#
# It checks the parts that cannot be tested on Windows: the Debian install of Microsoft Edge, the entrypoint running as root and
# handing over the storage folder, the sign-in wall on a real listening socket, and that Edge can start inside the container.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

IMAGE="${IMAGE:-screenshot-gallery-smoke}"
NAME="ssg-smoke-$$"
VOLUME="$NAME-data"
PASSWORD="smoke-test-access-password-123"
TOKEN="smoke-test-pairing-token-0123456789abcdef"
HOSTNAME_ON_RENDER="smoke.onrender.com"
PORT_ON_HOST="${PORT_ON_HOST:-18080}"
BASE="http://127.0.0.1:$PORT_ON_HOST"
PASS=0
FAIL=0
JAR="$(mktemp)"
LOG="$(mktemp)"

cleanup() {
  docker logs "$NAME" >"$LOG" 2>&1 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  rm -f "$JAR"
}
trap cleanup EXIT

# --- helpers: every request is a function with a real argument array, so nothing is split or re-parsed by a shell -------------
# A request addressed the way Render addresses the service (its onrender.com name in the Host header).
req() { curl -sS --max-time 20 -H "Host: $HOSTNAME_ON_RENDER" "$@"; }
code() { req -o /dev/null -w '%{http_code}' "$@"; }
authed() { req -b "$JAR" -H "Authorization: Bearer $TOKEN" "$@"; }

ok() { PASS=$((PASS + 1)); echo "PASS  $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL  $1${2:+  ($2)}"; }
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got '$2', wanted '$3'"; fi; }
expect_contains() { if printf '%s' "$2" | grep -q -- "$3"; then ok "$1"; else bad "$1" "'$3' not found"; fi; }
expect_not_contains() { if printf '%s' "$2" | grep -q -- "$3"; then bad "$1" "'$3' was found"; else ok "$1"; fi; }

start_container() { # extra docker arguments
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --user root \
    -e PORT=10000 -e GATEWAY_ACCESS_PASSWORD="$PASSWORD" -e PAIRING_TOKEN="$TOKEN" -e RENDER_EXTERNAL_HOSTNAME="$HOSTNAME_ON_RENDER" \
    -v "$VOLUME:/data" -p "127.0.0.1:$PORT_ON_HOST:10000" "$@" "$IMAGE" >/dev/null
  for _ in $(seq 1 90); do
    if [ "$(code "$BASE/healthz" 2>/dev/null || true)" = "200" ]; then return 0; fi
    sleep 1
  done
  echo "The container did not become healthy:"; docker logs "$NAME" 2>&1 | tail -n 40; return 1
}

echo "== Building the image"
docker build -t "$IMAGE" .

echo "== Starting it the way Render does: as root, with PORT set, with an EMPTY root-owned volume at /data"
docker volume create "$VOLUME" >/dev/null
start_container

expect_eq        "the health check answers without a sign-in"            "$(req "$BASE/healthz")" "ok"
expect_contains  "a stranger gets the sign-in form, not the page"        "$(req "$BASE/")" "Access password"
expect_not_contains "a stranger gets none of the page"                   "$(req "$BASE/")" "ssg-service"
expect_eq        "a stranger cannot read the API (even with the token)"  "$(code -H "Authorization: Bearer $TOKEN" "$BASE/api/health")" "401"
expect_eq        "an unknown Host name is refused"                       "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example.com' "$BASE/")" "421"
expect_eq        "a wrong password is refused"                           "$(code -d 'password=wrong-password-123456' "$BASE/__gate/login")" "401"
expect_eq        "the right password signs in"                           "$(code -c "$JAR" -d "password=$PASSWORD" "$BASE/__gate/login")" "303"
expect_contains  "...and sets the session cookie"                        "$(cat "$JAR")" "__Host-ssg_gate"
expect_contains  "after signing in the page is served"                   "$(req -b "$JAR" "$BASE/")" "ssg-service"
expect_eq        "after signing in the API still needs the token"        "$(code -b "$JAR" "$BASE/api/gallery")" "401"
expect_contains  "with the cookie and the token the API answers"         "$(authed "$BASE/api/gallery")" '"items"'

echo "== The container itself"
expect_eq        "the service runs as the unprivileged user"             "$(docker exec "$NAME" sh -c 'ps -o user= -C node | sort -u | tr -d " \n"')" "node"
expect_eq        "the storage folders belong to that user"               "$(docker exec "$NAME" stat -c %U /data/screenshots)" "node"
expect_contains  "Edge is installed where the service looks for it"      "$(docker exec "$NAME" /opt/microsoft/msedge/msedge --version)" "Microsoft Edge"
expect_eq        "the service did not take the gateway's port"           "$(docker exec "$NAME" sh -c 'cat /proc/net/tcp | grep -c " 0100007F:2710 "' || true)" "0"
expect_not_contains "the pairing token is not printed in the logs"       "$(docker logs "$NAME" 2>&1)" "$TOKEN"
expect_not_contains "the access password is not printed in the logs"     "$(docker logs "$NAME" 2>&1)" "$PASSWORD"

echo "== A restart keeps what is on the disk, and does not walk it again"
docker restart "$NAME" >/dev/null
for _ in $(seq 1 90); do [ "$(code "$BASE/healthz" 2>/dev/null || true)" = "200" ] && break; sleep 1; done
expect_eq        "the service is back after a restart"                   "$(req "$BASE/healthz")" "ok"

echo "== A real capture with Edge inside the container"
# The service refuses private addresses by default, which is right for a public service. For this throw-away container only, it is
# allowed, so that it can capture a page that the container serves to itself.
start_container -e ALLOW_PRIVATE_TARGETS=true
docker exec "$NAME" sh -c 'echo "<title>Smoke</title><h1>Captured in the container</h1>" > /tmp/index.html'
docker exec -d "$NAME" node -e "require('http').createServer((q,r)=>{r.setHeader('content-type','text/html');r.end(require('fs').readFileSync('/tmp/index.html'))}).listen(18999,'127.0.0.1')"
sleep 2
code -c "$JAR" -d "password=$PASSWORD" "$BASE/__gate/login" >/dev/null
expect_eq        "a run is accepted"                                     "$(code -b "$JAR" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"urls":["http://127.0.0.1:18999/"],"mode":"headless","screenshotMode":"viewport","extraWaitMs":0,"delayBetweenPagesMs":0}' "$BASE/api/automation/start")" "202"
state=""
for _ in $(seq 1 90); do
  state="$(authed "$BASE/api/automation/status" | sed -n 's/.*"state":"\([a-z-]*\)".*/\1/p')"
  case "$state" in completed|failed|stopped) break ;; esac
  sleep 1
done
expect_eq        "the run finished"                                      "$state" "completed"
gallery="$(authed "$BASE/api/gallery")"
expect_contains  "the screenshot is in the gallery"                      "$gallery" '"total":1'
id="$(printf '%s' "$gallery" | sed -n 's/.*"id":"\([A-Za-z0-9_-]*\)".*/\1/p' | head -n 1)"
expect_eq        "the image is a PNG"                                    "$(authed "$BASE/api/gallery/$id/image" | head -c 8 | od -An -tx1 | tr -d ' \n')" "89504e470d0a1a0a"

echo
echo "$PASS passed, $FAIL failed."
if [ "$FAIL" -ne 0 ]; then
  echo "Container log (last lines):"
  docker logs "$NAME" 2>&1 | tail -n 60
  exit 1
fi
