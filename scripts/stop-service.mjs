// Stops this project's local service and nothing else.
//
//   node scripts/stop-service.mjs <service-folder>
//
// A process is stopped only when it is positively identified as THIS service, by either of two independent rules:
//
//   1. Its command line contains the absolute path of this service's entry file (<service>\dist\index.js or
//      <service>\src\index.ts). That is how it looks when started with a full path.
//   2. It owns the TCP port this service is configured for (PORT in <service>\.env, default 4577) AND that port answers
//      GET /api/health as "screenshot-gallery-service". That is how it looks when started by `npm start` or
//      start-service.bat, whose command line is the relative "node dist/index.js" and so cannot be tied to a folder.
//
// Other Node.js programs, including other copies of similar projects, are never touched.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SERVICE_ID = 'screenshot-gallery-service';
const DEFAULT_PORT = 4577;

/** @param {string} commandLine @param {string[]} entries */
export function isServiceCommandLine(commandLine, entries) {
  const normalized = commandLine.replace(/"/g, '').replace(/\//g, '\\').toLowerCase();
  return entries.some((entry) => normalized.includes(entry.toLowerCase()));
}

/** Reads PORT from <service>\.env the way the service does (the process environment wins over the file). */
export function configuredPort(serviceDir, env = process.env) {
  const fromEnv = (env.PORT ?? '').trim();
  let raw = fromEnv;
  if (raw === '') {
    const file = path.join(serviceDir, '.env');
    if (existsSync(file)) {
      const match = /^\s*PORT\s*=\s*(\d+)\s*(?:#.*)?$/m.exec(readFileSync(file, 'utf8'));
      if (match) raw = match[1];
    }
  }
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

/** True when 127.0.0.1:<port> answers /api/health as this service. */
export function answersAsService(port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (body.length < 4096) body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 && JSON.parse(body).service === SERVICE_ID);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function powershell(script) {
  // PowerShell writes to a pipe in the console's legacy code page unless told otherwise, which turns accented letters in a
  // folder name (C:\Users\José\...) into "?". Asking for UTF-8 output explicitly keeps the paths intact.
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`],
    { windowsHide: true, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' },
  );
  return stdout.replace(/^\uFEFF/, '').trim();
}

async function listNodeProcesses() {
  const text = await powershell("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress");
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Process id that is listening on 127.0.0.1:<port>, or null. */
async function ownerOfPort(port) {
  const text = await powershell(
    `Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in '127.0.0.1','::1' } | Select-Object -First 1 -ExpandProperty OwningProcess`,
  );
  const id = Number(text);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('  This script is for Windows. Stop the service with Ctrl+C in its terminal.');
    return 0;
  }
  const service = path.resolve(process.argv[2] ?? '.');
  const entries = [path.join(service, 'dist', 'index.js'), path.join(service, 'src', 'index.ts')].map((p) => p.replace(/\//g, '\\'));

  /** @type {Set<number>} */
  const targets = new Set();

  // Rule 1: started with the full path to this service's entry file.
  for (const p of await listNodeProcesses()) {
    if (p.CommandLine && p.ProcessId !== process.pid && isServiceCommandLine(p.CommandLine, entries)) targets.add(p.ProcessId);
  }

  // Rule 2: the process behind this service's port, but only if that port really answers as this service.
  const port = configuredPort(service);
  if (await answersAsService(port)) {
    const owner = await ownerOfPort(port);
    if (owner !== null && owner !== process.pid) targets.add(owner);
  }

  if (targets.size === 0) {
    console.log('  The service is not running.');
    return 0;
  }
  let failed = false;
  for (const id of targets) {
    try {
      process.kill(id); // SIGTERM: the service shuts down cleanly and closes its browser
      console.log(`  Stopped the service (process ${id}).`);
    } catch (error) {
      console.log(`  Could not stop process ${id}: ${error instanceof Error ? error.message : String(error)}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`  Could not look for the service: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
