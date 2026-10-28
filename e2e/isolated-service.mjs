// Starts a throw-away copy of the local service for tests: a random port, temporary data and screenshot folders, its own
// pairing token, and permission to capture pages served from this computer.
//
// It never reads or touches a service that is already running: not its port, its token, its gallery or its profiles.
// Only the one process started here is ever stopped.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH_PREFIX = 'ss3-iso-';

/**
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{
 *   url: string, port: number, token: string, dir: string, child: import('node:child_process').ChildProcess,
 *   api: (method: string, pathname: string, body?: unknown) => Promise<{ status: number, json: any }>,
 *   stop: () => Promise<void>,
 * }>}
 */
export async function startIsolatedService({ timeoutMs = 30_000 } = {}) {
  const entry = path.join(root, 'service', 'dist', 'index.js');
  if (!fs.existsSync(entry)) throw new Error('The service is not built. Run "npm run build" in the service folder first.');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), SCRATCH_PREFIX));
  const token = randomBytes(24).toString('base64url');
  const child = spawn(process.execPath, [entry], {
    cwd: path.join(root, 'service'),
    // Values set here win over service\.env, so the user's own settings cannot redirect this copy to their folders or token.
    env: {
      ...process.env,
      PORT: '0',
      DATA_DIR: path.join(dir, 'data'),
      SCREENSHOTS_DIR: path.join(dir, 'shots'),
      PAIRING_TOKEN: token,
      ALLOWED_ORIGINS: '',
      ALLOW_PRIVATE_TARGETS: 'true',
      ALLOWED_TARGET_HOSTS: '',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));

  const started = Date.now();
  let port = 0;
  while (!port) {
    const match = /Listening on\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    if (match) port = Number(match[1]);
    else if (child.exitCode !== null) throw new Error(`The test copy of the service exited early:\n${output.slice(-800)}`);
    else if (Date.now() - started > timeoutMs) {
      child.kill();
      throw new Error(`The test copy of the service did not start within ${timeoutMs / 1000} s:\n${output.slice(-800)}`);
    } else await new Promise((r) => setTimeout(r, 100));
  }

  const url = `http://127.0.0.1:${port}`;
  const api = async (method, pathname, body) => {
    const res = await fetch(url + pathname, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  };

  const stop = async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    // Only the scratch folder created above is removed.
    if (path.basename(dir).startsWith(SCRATCH_PREFIX)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };

  return { url, port, token, dir, child, api, stop };
}
