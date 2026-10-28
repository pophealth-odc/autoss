import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gatewaySettingsFromEnv } from '../src/gateway/gateway.js';
import { loadConfig } from '../src/config.js';

/**
 * A Codespace cannot be created from the tests, so these pin the pieces that must agree with each other: the dev container
 * file, the scripts it runs and the settings the service reads. If one changes alone, this fails before a Codespace does.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(repoRoot, ...parts), 'utf8');

/** devcontainer.json allows // comments and trailing commas. */
function readDevContainer(): {
  image: string;
  features: Record<string, unknown>;
  containerEnv: Record<string, string>;
  postCreateCommand: string;
  postStartCommand: string;
  forwardPorts: number[];
  portsAttributes: Record<string, { onAutoForward?: string; visibility?: string; label?: string }>;
  otherPortsAttributes?: { onAutoForward?: string; visibility?: string };
} {
  const text = read('.devcontainer', 'devcontainer.json').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(text);
}

describe('dev container configuration', () => {
  const dc = readDevContainer();

  it('builds from a Debian image (the only Linux Microsoft publishes Edge packages for here)', () => {
    expect(dc.image).toMatch(/^mcr\.microsoft\.com\/devcontainers\/javascript-node:1-22-bookworm$/);
  });

  it('turns the gateway on and gives the service the settings it reads', () => {
    const env = dc.containerEnv;
    // The service must accept every value, or it refuses to start.
    const gateway = gatewaySettingsFromEnv({ ...env }, '/workspaces/autoss/service');
    expect(gateway).not.toBeNull();
    expect(String(gateway?.port)).toBe(env['GATEWAY_PORT']);
    expect(() => loadConfig({ ...env }, '/workspaces/autoss/service', '0.0.0')).not.toThrow();
    expect(loadConfig({ ...env }, '/workspaces/autoss/service', '0.0.0').edgePath).toBe('/opt/microsoft/msedge/msedge');
  });

  it('keeps screenshots and data outside the repository, so git can never pick them up', () => {
    for (const key of ['SCREENSHOTS_DIR', 'DATA_DIR']) {
      const dir = dc.containerEnv[key] as string;
      expect(path.posix.isAbsolute(dir), key).toBe(true);
      expect(dir.startsWith('/workspaces/autoss/'), key).toBe(false);
    }
  });

  it('forwards exactly the gateway port, and never makes any port public', () => {
    expect(dc.forwardPorts).toEqual([Number(dc.containerEnv['GATEWAY_PORT'])]);
    const all = [...Object.values(dc.portsAttributes), dc.otherPortsAttributes ?? {}];
    for (const attrs of all) expect(attrs.visibility, JSON.stringify(attrs)).toBeUndefined(); // the default is private
    expect(JSON.stringify(dc)).not.toMatch(/"visibility"\s*:\s*"public"/i);
    expect(JSON.stringify(dc)).not.toMatch(/gh\s+codespace\s+ports\s+visibility/i);
  });

  it('runs scripts that exist', () => {
    for (const command of [dc.postCreateCommand, dc.postStartCommand]) {
      const script = /^bash\s+(\S+)$/.exec(command)?.[1];
      expect(script, command).toBeDefined();
      expect(fs.existsSync(path.join(repoRoot, script as string)), command).toBe(true);
    }
  });
});

describe('Codespace scripts', () => {
  const create = read('scripts', 'codespaces', 'post-create.sh');
  const start = read('scripts', 'codespaces', 'start.sh');

  it('use Unix line endings (a carriage return breaks bash)', () => {
    expect(create).not.toContain('\r');
    expect(start).not.toContain('\r');
  });

  it('stop on the first error', () => {
    expect(create).toMatch(/^set -euo pipefail$/m);
    expect(start).toMatch(/^set -euo pipefail$/m);
  });

  it('check the Edge path against the one in the dev container file', () => {
    const edgePath = readDevContainer().containerEnv['EDGE_PATH'] as string;
    expect(create).toContain(`EDGE_PATH:-${edgePath}`);
  });

  it('install Edge from Microsoft\'s signed repository only', () => {
    expect(create).toContain('https://packages.microsoft.com/keys/microsoft.asc');
    expect(create).toContain('signed-by=/usr/share/keyrings/microsoft-edge.gpg');
    expect(create).toContain('https://packages.microsoft.com/repos/edge stable main');
    expect(create).not.toMatch(/--allow-unauthenticated|trusted=yes|apt-key|curl[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/);
  });

  it('build both parts with the lock files, so the same versions are used every time', () => {
    expect(create).toMatch(/cd "\$ROOT\/service" && npm ci/);
    expect(create).toMatch(/cd "\$ROOT\/frontend" && npm ci/);
  });

  it('start the service once, and never kill a process that is not their own', () => {
    expect(start).toContain('/api/health');
    expect(start).toContain('"screenshot-gallery-service"');
    // The only kill is of the process recorded in the script's own pid file, after checking that it is node.
    const kills = start.split('\n').filter((line) => /\bkill\b/.test(line) && !line.trim().startsWith('#'));
    expect(kills.length).toBeGreaterThan(0);
    for (const line of kills) expect(line).toContain('"$old"');
    expect(start).not.toMatch(/\bpkill\b|\bkillall\b|fuser\s+-k/);
  });

  it('keep the state folder private to the user', () => {
    expect(start).toMatch(/chmod 700 "\$STATE"/);
    expect(create).toMatch(/chmod 700 "\$dir"/);
  });
});
