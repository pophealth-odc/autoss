# Screenshot Gallery for Render (and any other Docker host): the web page and the service in one container, with Microsoft Edge.
#
#   docker build -t screenshot-gallery .
#   docker run --rm -p 10000:10000 -e GATEWAY_ACCESS_PASSWORD=... -e PAIRING_TOKEN=... screenshot-gallery
#
# Read the "Deploying on Render" section of the README before exposing this to the internet.

# ---------------------------------------------------------------------------------------------------------------------
# 1. Build the service and the web page.
# ---------------------------------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /src

COPY service/package.json service/package-lock.json service/
RUN cd service && npm ci --no-audit --no-fund

COPY frontend/package.json frontend/package-lock.json frontend/
RUN cd frontend && npm ci --no-audit --no-fund

COPY service/ service/
COPY frontend/ frontend/
# The frontend keeps copies of two files that live in the service (see scripts/sync-shared.mjs).
COPY scripts/sync-shared.mjs scripts/
RUN node scripts/sync-shared.mjs --check \
 && cd service && npm run build \
 && cd ../frontend && npx vite build

# Only what the running service needs: production dependencies of the service, no dev tools.
RUN cd service && npm prune --omit=dev

# ---------------------------------------------------------------------------------------------------------------------
# 2. The image that runs: Node.js, Microsoft Edge, and the built files.
# ---------------------------------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    # Edge from Microsoft's own package repository installs here (checked below).
    EDGE_PATH=/opt/microsoft/msedge/msedge \
    # Serve the page and the API on one public address, behind the sign-in wall.
    GATEWAY_ENABLED=true \
    GATEWAY_HOST=0.0.0.0 \
    GATEWAY_PORT=10000 \
    # Everything the service stores lives under /data (mount a persistent disk there to keep it across deploys).
    SCREENSHOTS_DIR=/data/screenshots \
    DATA_DIR=/data/state

# Edge needs a set of system libraries; the package declares them, so apt installs them with it.
# tini reaps the processes Edge leaves behind; gosu drops from root to an unprivileged user after the disk has been prepared.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg tini gosu fonts-liberation fonts-noto-color-emoji; \
    curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /usr/share/keyrings/microsoft-edge.gpg; \
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft-edge.gpg] https://packages.microsoft.com/repos/edge stable main" > /etc/apt/sources.list.d/microsoft-edge.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends microsoft-edge-stable; \
    # Fail the build now, not at the first capture, if Edge is not where the service will look for it.
    test -x "$EDGE_PATH"; \
    "$EDGE_PATH" --version; \
    apt-get purge -y --auto-remove gnupg; \
    rm -rf /var/lib/apt/lists/*

# The base image already has an unprivileged "node" user (uid 1000).
WORKDIR /app
COPY --from=build --chown=root:root /src/service/dist service/dist
COPY --from=build --chown=root:root /src/service/node_modules service/node_modules
COPY --from=build --chown=root:root /src/service/package.json service/package.json
COPY --from=build --chown=root:root /src/frontend/dist frontend/dist
COPY --chown=root:root scripts/render/entrypoint.sh /usr/local/bin/ssg-entrypoint
RUN chmod 0755 /usr/local/bin/ssg-entrypoint && mkdir -p /data && chown node:node /data

WORKDIR /app/service
EXPOSE 10000

# Render polls this too (healthCheckPath in render.yaml); it answers without a sign-in and says only that the process is up.
# The port is worked out the same way the entrypoint does: the platform's PORT if there is one, else the image's default.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-${GATEWAY_PORT}}/healthz" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/ssg-entrypoint"]
CMD ["node", "dist/index.js"]
