import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gatewaySettingsFromEnv } from '../src/gateway/gateway.js';
import { loadConfig } from '../src/config.js';

/**
 * A Render deployment cannot be created from the tests, so these pin the pieces that must agree with each other: the Blueprint,
 * the Dockerfile, the entrypoint and the settings the service reads. The CI job "Container image (Render)" builds and runs the
 * image for real; these fail first, and in seconds, when one file changes without the others.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(repoRoot, ...parts), 'utf8');

const dockerfile = read('Dockerfile');
const blueprint = read('render.yaml');
const entrypoint = read('scripts', 'render', 'entrypoint.sh');
const dockerignore = read('.dockerignore');

/** The `ENV` block of the last stage: `KEY=value` lines joined by backslashes. */
function dockerEnv(): Record<string, string> {
  const last = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
  const block = /\nENV ((?:.|\n)*?)\n\n/.exec(last)?.[1] ?? '';
  const env: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const pair = /^\s*([A-Z_]+)=(\S+?)\s*\\?$/.exec(line.replace(/^\s*#.*$/, ''));
    if (pair) env[pair[1] as string] = pair[2] as string;
  }
  return env;
}

describe('Dockerfile', () => {
  const env = dockerEnv();

  it('reads as the settings the service accepts', () => {
    expect(env['GATEWAY_ENABLED']).toBe('true');
    expect(env['GATEWAY_HOST']).toBe('0.0.0.0');
    const full = { ...env, GATEWAY_ACCESS_PASSWORD: 'a-long-enough-password-123', PAIRING_TOKEN: 'pairing-token-0123456789abcdefg' };
    const gateway = gatewaySettingsFromEnv(full, '/app/service');
    expect(gateway?.host).toBe('0.0.0.0');
    expect(String(gateway?.port)).toBe(env['GATEWAY_PORT']);
    expect(loadConfig(full, '/app/service', '0.0.0').edgePath).toBe('/opt/microsoft/msedge/msedge');
  });

  it('serves on Render\'s default port, and says so', () => {
    expect(env['GATEWAY_PORT']).toBe('10000');
    expect(dockerfile).toMatch(/^EXPOSE 10000$/m);
  });

  it('keeps everything the service stores under /data, where a persistent disk is mounted', () => {
    expect(env['SCREENSHOTS_DIR']).toMatch(/^\/data\//);
    expect(env['DATA_DIR']).toMatch(/^\/data\//);
    expect(blueprint).toMatch(/mountPath: \/data\b/);
  });

  it('refuses to build when Edge is not where the service looks for it', () => {
    expect(dockerfile).toContain('test -x "$EDGE_PATH"');
    expect(dockerfile).toContain('"$EDGE_PATH" --version');
  });

  it('installs Edge only from Microsoft\'s signed repository', () => {
    expect(dockerfile).toContain('https://packages.microsoft.com/keys/microsoft.asc');
    expect(dockerfile).toContain('signed-by=/usr/share/keyrings/microsoft-edge.gpg');
    expect(dockerfile).toContain('https://packages.microsoft.com/repos/edge stable main');
    expect(dockerfile).not.toMatch(/--allow-unauthenticated|trusted=yes|apt-key|curl[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/);
  });

  it('builds from the lock files, runs the shared-file check and builds both parts', () => {
    expect(dockerfile.match(/npm ci --no-audit --no-fund/g)?.length).toBe(2);
    expect(dockerfile).toContain('node scripts/sync-shared.mjs --check');
    expect(dockerfile).toContain('npm run build');
    expect(dockerfile).toContain('npx vite build');
    expect(dockerfile).toContain('npm prune --omit=dev');
  });

  it('starts through tini and the entrypoint, and has a health check that needs no sign-in', () => {
    expect(dockerfile).toMatch(/ENTRYPOINT \["\/usr\/bin\/tini", "--", "\/usr\/local\/bin\/ssg-entrypoint"\]/);
    expect(dockerfile).toContain('/healthz');
    expect(dockerfile).toMatch(/CMD \["node", "dist\/index\.js"\]/);
  });

  it('probes the port the gateway really uses: the platform\'s PORT, else the image default', () => {
    // The health check runs in a fresh shell, where PORT is still the platform's value (the entrypoint changes it only for the service).
    expect(dockerfile).toContain('http://127.0.0.1:${PORT:-${GATEWAY_PORT}}/healthz');
  });

  it('copies the entrypoint it starts, and that file exists', () => {
    expect(dockerfile).toContain('scripts/render/entrypoint.sh /usr/local/bin/');
    expect(fs.existsSync(path.join(repoRoot, 'scripts', 'render', 'entrypoint.sh'))).toBe(true);
  });

  it('never copies a secret, local data or the repository history into the image', () => {
    expect(dockerfile).not.toMatch(/COPY\s+\.\s/);
    expect(dockerfile).not.toMatch(/\.env\b|pairing-token/);
    for (const pattern of ['.git', '.env', '**/.env', '**/pairing-token.txt', 'service/data', 'service/screenshots', '**/node_modules', '*.pem']) {
      expect(dockerignore.split('\n').map((l) => l.trim()), pattern).toContain(pattern);
    }
  });

  it('does not ignore a file the build needs', () => {
    const ignored = dockerignore.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
    for (const needed of ['Dockerfile', 'render.yaml', 'service/src', 'frontend/src', 'scripts/sync-shared.mjs', 'scripts/render/entrypoint.sh', 'service/package-lock.json', 'frontend/package-lock.json']) {
      expect(ignored.filter((l) => needed === l || needed.startsWith(`${l}/`)), needed).toEqual([]);
    }
  });
});

describe('render.yaml', () => {
  it('describes one Docker web service built from this Dockerfile', () => {
    expect(blueprint).toMatch(/^ {2}- type: web$/m);
    expect(blueprint).toMatch(/^ {4}runtime: docker$/m);
    expect(blueprint).toMatch(/^ {4}dockerfilePath: \.\/Dockerfile$/m);
    expect(blueprint).toMatch(/^ {4}dockerContext: \.$/m);
    expect(fs.existsSync(path.join(repoRoot, 'Dockerfile'))).toBe(true);
  });

  it('uses the path the gateway answers without a sign-in', () => {
    expect(blueprint).toMatch(/^ {4}healthCheckPath: \/healthz$/m);
    expect(read('service', 'src', 'gateway', 'gateway.ts')).toContain("HEALTH_PATH = '/healthz'");
  });

  it('asks for both secrets in the dashboard and never contains a value for them', () => {
    for (const key of ['GATEWAY_ACCESS_PASSWORD', 'PAIRING_TOKEN']) {
      expect(blueprint, key).toMatch(new RegExp(`- key: ${key}\\n\\s+sync: false`));
      expect(blueprint, key).not.toMatch(new RegExp(`- key: ${key}\\n\\s+value:`));
      expect(blueprint, key).not.toMatch(new RegExp(`- key: ${key}\\n\\s+generateValue`));
    }
  });

  it('keeps private targets off on a public service', () => {
    expect(blueprint).toMatch(/- key: ALLOW_PRIVATE_TARGETS\n\s+value: "false"/);
  });

  it('deploys only when asked to', () => {
    expect(blueprint).toMatch(/^ {4}autoDeployTrigger: "off"$/m);
  });

  it('says plainly that the free plan is too small, and keeps the disk off it', () => {
    expect(blueprint).toMatch(/^ {4}plan: free$/m);
    expect(blueprint).toMatch(/512 MB/);
    expect(blueprint).toMatch(/1c-2g/);
    // A disk needs a paid plan, so the block stays commented out while the plan is "free".
    expect(blueprint).toMatch(/^ {4}# disk:$/m);
    expect(blueprint).not.toMatch(/^ {4}disk:$/m);
  });
});

describe('entrypoint', () => {
  it('uses Unix line endings and stops on the first error', () => {
    expect(entrypoint).not.toContain('\r');
    expect(entrypoint).toMatch(/^set -eu$/m);
  });

  it('gives Render\'s PORT to the gateway, and tells the service to pick another one', () => {
    // The service reads PORT as well. If it kept Render's value it would take the very port the gateway must listen on.
    expect(entrypoint).toMatch(/^GATEWAY_PORT="\$\{PORT:-\$\{GATEWAY_PORT:-10000\}\}"$/m);
    expect(entrypoint).toMatch(/^PORT=0$/m);
    expect(entrypoint.indexOf('GATEWAY_PORT="${PORT')).toBeLessThan(entrypoint.indexOf('\nPORT=0'));
  });

  it('makes the service and the gateway use different ports, run for real under sh', () => {
    const run = (env: Record<string, string>) =>
      spawnSync('sh', [path.join(repoRoot, 'scripts', 'render', 'entrypoint.sh'), 'sh', '-c', 'echo "$GATEWAY_PORT $PORT"'], {
        encoding: 'utf8',
        env: { PATH: process.env['PATH'] ?? '', GATEWAY_ACCESS_PASSWORD: 'a-long-enough-password-123', PAIRING_TOKEN: 'pairing-token-0123456789abcdefg', SCREENSHOTS_DIR: path.join(repoRoot, 'service', 'test', '.entry-shots'), DATA_DIR: path.join(repoRoot, 'service', 'test', '.entry-data'), ...env },
      });
    const viaRender = run({ PORT: '10000' });
    if (viaRender.error) return; // no POSIX shell on this machine; CI runs it on Linux
    try {
      expect(viaRender.stdout.trim()).toBe('10000 0');
      expect(run({ PORT: '8080' }).stdout.trim()).toBe('8080 0');
      expect(run({}).stdout.trim()).toBe('10000 0'); // outside Render: the image's default
      expect(run({ GATEWAY_PORT: '4580' }).stdout.trim()).toBe('4580 0');
    } finally {
      for (const d of ['.entry-shots', '.entry-data']) fs.rmSync(path.join(repoRoot, 'service', 'test', d), { recursive: true, force: true });
    }
  });

  it('refuses to start without the two secrets, and drops root before running the service', () => {
    expect(entrypoint).toContain('GATEWAY_ACCESS_PASSWORD is not set');
    expect(entrypoint).toContain('PAIRING_TOKEN is not set');
    expect(entrypoint).toMatch(/exec gosu node "\$@"/);
  });

  it('hands over only the folder it is given, never the mount point, and only when it is not the user\'s already', () => {
    const chowns = entrypoint.split('\n').filter((line) => /\bchown\b/.test(line) && !line.trim().startsWith('#'));
    expect(chowns).toEqual(['    chown -R node:node "$1"']);
    expect(entrypoint).toMatch(/if \[ "\$\(stat -c %U "\$1"\)" != "node" \]; then/);
    expect(entrypoint).toMatch(/hand_over "\$SCREENSHOTS_DIR"/);
    expect(entrypoint).toMatch(/hand_over "\$DATA_DIR"/);
    expect(entrypoint).not.toMatch(/hand_over "?\/data"?\s*$/m);
  });

  it('never prints a secret', () => {
    const echoes = entrypoint.split('\n').filter((line) => /\b(echo|printf)\b/.test(line));
    for (const line of echoes) expect(line).not.toMatch(/\$\{?(GATEWAY_ACCESS_PASSWORD|PAIRING_TOKEN)\b(?!\s+is not set)/);
  });

  it('runs under a POSIX shell (the image has no bash)', () => {
    expect(entrypoint.startsWith('#!/bin/sh')).toBe(true);
    const syntax = spawnSync('sh', ['-n', path.join(repoRoot, 'scripts', 'render', 'entrypoint.sh')], { encoding: 'utf8' });
    if (!syntax.error) expect(syntax.status, syntax.stderr).toBe(0);
  });
});
