#!/usr/bin/env bash
# Runs once when the Codespace is created. Installs Microsoft Edge (the browser the service drives), the packages, and builds
# the service and the web page. Safe to run again.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
ROOT="$PWD"
EDGE_PATH="${EDGE_PATH:-/opt/microsoft/msedge/msedge}"

say() { printf '\n== %s\n' "$*"; }

# ---------------------------------------------------------------------------------------------------------------------
# 1. Microsoft Edge, from Microsoft's own package repository (the same version the Windows setup uses).
# ---------------------------------------------------------------------------------------------------------------------
if [ -x "$EDGE_PATH" ]; then
  say "Microsoft Edge is already installed: $("$EDGE_PATH" --version)"
else
  say "Installing Microsoft Edge"
  arch="$(dpkg --print-architecture)"
  if [ "$arch" != "amd64" ]; then
    echo "Microsoft publishes Edge for Linux only on amd64; this machine is $arch." >&2
    echo "Create the Codespace on a standard (x86-64) machine type." >&2
    exit 1
  fi
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends curl gpg ca-certificates
  curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor | sudo tee /usr/share/keyrings/microsoft-edge.gpg >/dev/null
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft-edge.gpg] https://packages.microsoft.com/repos/edge stable main" \
    | sudo tee /etc/apt/sources.list.d/microsoft-edge.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y microsoft-edge-stable
fi

# The service finds Edge on Linux only through EDGE_PATH. If the package ever installs somewhere else, say so now instead of
# failing later with "Microsoft Edge was not found" during a run.
if [ ! -x "$EDGE_PATH" ]; then
  echo >&2
  echo "Edge was installed, but not at $EDGE_PATH. Found:" >&2
  ls -l /opt/microsoft/*/ 2>/dev/null >&2 || true
  command -v microsoft-edge-stable >&2 || true
  echo "Set EDGE_PATH in .devcontainer/devcontainer.json to the right file and rebuild." >&2
  exit 1
fi
say "Edge: $("$EDGE_PATH" --version)"

# ---------------------------------------------------------------------------------------------------------------------
# 2. Storage folders (outside the repository, so a git command can never pick screenshots up).
# ---------------------------------------------------------------------------------------------------------------------
SCREENSHOTS_DIR="${SCREENSHOTS_DIR:-/workspaces/screenshots}"
DATA_DIR="${DATA_DIR:-/workspaces/screenshot-data}"
for dir in "$SCREENSHOTS_DIR" "$DATA_DIR"; do
  if ! mkdir -p "$dir" 2>/dev/null; then sudo mkdir -p "$dir" && sudo chown "$(id -u):$(id -g)" "$dir"; fi
  chmod 700 "$dir"
done

# ---------------------------------------------------------------------------------------------------------------------
# 3. Packages and build.
# ---------------------------------------------------------------------------------------------------------------------
say "Installing the service"
( cd "$ROOT/service" && npm ci --no-audit --no-fund && npm run build )

say "Installing and building the web page"
( cd "$ROOT/frontend" && npm ci --no-audit --no-fund && npx vite build )

say "Done. The service starts automatically; open the 'Screenshot Gallery' port from the Ports tab."
