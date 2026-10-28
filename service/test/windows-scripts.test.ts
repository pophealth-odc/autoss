import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Runs the real .bat files in a scratch copy of the repository whose path contains spaces and non-ASCII letters, the
 * usual way batch scripts break. Skipped on other platforms.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const onWindows = process.platform === 'win32';
const describeWin = onWindows ? describe : describe.skip;

let sandbox = '';
let project = '';

function run(script: string, options: { cwd?: string; env?: Record<string, string>; removeFromPath?: boolean } = {}) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), NO_PAUSE: '1', ...options.env };
  if (options.removeFromPath) env['PATH'] = `${process.env['SystemRoot']};${process.env['SystemRoot']}\\System32`;
  // cmd.exe needs the whole command quoted once more when the path contains spaces; verbatim arguments stop Node from
  // escaping those quotes, which would hand cmd a backslash-quoted path it cannot find.
  const target = path.join(project, 'scripts', 'windows', script);
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${target}""`], {
    cwd: options.cwd ?? process.env['SystemRoot'] ?? project,
    env,
    encoding: 'utf8',
    windowsHide: true,
    windowsVerbatimArguments: true,
    timeout: 120_000,
  });
  return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

describeWin('Windows scripts', () => {
  beforeAll(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ss3-bat-'));
    project = path.join(sandbox, 'Mi Proyecto Ñandú (prueba)');
    fs.mkdirSync(path.join(project, 'scripts', 'windows'), { recursive: true });
    fs.mkdirSync(path.join(project, 'service', 'src'), { recursive: true });
    fs.writeFileSync(path.join(project, 'service', 'src', 'index.ts'), '// stand-in source file\n');
    for (const f of fs.readdirSync(path.join(repoRoot, 'scripts', 'windows'))) {
      if (f.endsWith('.bat')) fs.copyFileSync(path.join(repoRoot, 'scripts', 'windows', f), path.join(project, 'scripts', 'windows', f));
    }
    for (const f of ['check-node-version.mjs', 'find-edge.mjs', 'needs-build.mjs', 'stop-service.mjs']) {
      fs.copyFileSync(path.join(repoRoot, 'scripts', f), path.join(project, 'scripts', f));
    }
    // A stand-in service: real npm runs, and "build" leaves proof that the batch file continued past the first npm call.
    fs.writeFileSync(
      path.join(project, 'service', 'package.json'),
      JSON.stringify({
        name: 'dummy-service',
        version: '1.0.0',
        private: true,
        engines: { node: '>=22.12.0' },
        scripts: {
          build: 'node -e "require(\'fs\').writeFileSync(\'built.txt\',\'ok\')"',
          start: 'node -e "console.log(\'DUMMY SERVICE STARTED\')"',
        },
      }),
    );
    fs.writeFileSync(path.join(project, 'service', '.env.example'), 'PORT=4577\n');
  });

  afterAll(() => {
    // Only the scratch folder created above is removed.
    if (sandbox.includes('ss3-bat-')) fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('install.bat succeeds from an unrelated folder, in a path with spaces and accents', () => {
    const r = run('install.bat');
    expect(r.out).toMatch(/Node\.js: \d+\.\d+\.\d+/);
    expect(r.out).toMatch(/Done\./);
    expect(r.code).toBe(0);
  });

  it('install.bat keeps going after the first npm call (bare "npm" would end the script)', () => {
    expect(fs.existsSync(path.join(project, 'service', 'built.txt'))).toBe(true);
  });

  it('install.bat creates service\\.env from the example, and does not overwrite it', () => {
    const env = path.join(project, 'service', '.env');
    expect(fs.readFileSync(env, 'utf8')).toBe('PORT=4577\n');
    fs.writeFileSync(env, 'PORT=9999\n');
    run('install.bat');
    expect(fs.readFileSync(env, 'utf8')).toBe('PORT=9999\n');
  });

  it('install.bat stops with a clear message when Node.js is missing', () => {
    const r = run('install.bat', { removeFromPath: true, cwd: project });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Node\.js was not found/);
    expect(r.out).toMatch(/nodejs\.org/);
  });

  it('install.bat warns about a missing Edge but still finishes', () => {
    const empty = path.join(sandbox, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    const r = run('install.bat', { env: { 'PROGRAMFILES(X86)': empty, PROGRAMFILES: empty, LOCALAPPDATA: empty, EDGE_PATH: '' } });
    expect(r.out).toMatch(/Microsoft Edge was not found/);
    expect(r.out).toMatch(/Done\./);
    expect(r.code).toBe(0);
  });

  it('does not pause when NO_PAUSE is set (scripted runs never hang)', () => {
    const started = Date.now();
    run('install.bat');
    expect(Date.now() - started).toBeLessThan(110_000);
  });

  it('start-service.bat builds when needed, then starts the service (and reports its exit code)', () => {
    fs.rmSync(path.join(project, 'service', 'built.txt'), { force: true });
    const r = run('start-service.bat');
    expect(r.out).toMatch(/DUMMY SERVICE STARTED/);
    expect(r.code).toBe(0);
  });

  it('start-service.bat stops with a clear message when Node.js is missing', () => {
    const r = run('start-service.bat', { removeFromPath: true, cwd: project });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Node\.js was not found/);
  });

  it('stop-service.bat says so when nothing is running', () => {
    const r = run('stop-service.bat');
    expect(r.out).toMatch(/not running/);
    expect(r.code).toBe(0);
  });

  it('stop-service.bat stops this project\'s service and leaves other Node.js programs alone', async () => {
    // A stand-in "service" whose entry file sits at <service>\dist\index.js, and a decoy that must survive.
    fs.mkdirSync(path.join(project, 'service', 'dist'), { recursive: true });
    const entry = path.join(project, 'service', 'dist', 'index.js');
    fs.writeFileSync(entry, 'setInterval(() => {}, 1000);');
    const decoyFile = path.join(sandbox, 'decoy-other-program.js');
    fs.writeFileSync(decoyFile, 'setInterval(() => {}, 1000);');

    const { spawn } = await import('node:child_process');
    const service = spawn(process.execPath, [entry], { stdio: 'ignore', windowsHide: true });
    const decoy = spawn(process.execPath, [decoyFile], { stdio: 'ignore', windowsHide: true });
    const alive = (pid: number | undefined) => {
      try {
        process.kill(pid as number, 0);
        return true;
      } catch {
        return false;
      }
    };
    const exited = (child: ReturnType<typeof spawn>) => new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
      const timer = setTimeout(() => resolve(false), 8_000);
      child.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
    try {
      await new Promise((r) => setTimeout(r, 1_000)); // let both processes appear in the process table
      expect(alive(service.pid)).toBe(true);
      expect(alive(decoy.pid)).toBe(true);

      const r = run('stop-service.bat');
      expect(r.out).toMatch(/Stopped the service/);
      expect(await exited(service)).toBe(true);
      expect(alive(decoy.pid)).toBe(true); // the unrelated Node.js program is untouched
    } finally {
      service.kill();
      decoy.kill();
    }
  });

  describe('stop-service.bat finds a service started with a RELATIVE path (as "npm start" does)', () => {
    /** A stand-in that answers /api/health the way the real service does, started as `node dist/index.js` inside <service>. */
    function standIn(port: number, identity = 'screenshot-gallery-service') {
      const dir = path.join(project, 'service', `relative-${port}`);
      fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'dist', 'index.js'),
        `require('http').createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ ok: true, service: ${JSON.stringify(identity)} })); }).listen(${port}, '127.0.0.1');`,
      );
      return dir;
    }
    const freePort = async () => {
      const net = await import('node:net');
      return new Promise<number>((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
          const p = (s.address() as { port: number }).port;
          s.close(() => resolve(p));
        });
      });
    };
    const isAlive = (pid: number | undefined) => {
      try {
        process.kill(pid as number, 0);
        return true;
      } catch {
        return false;
      }
    };
    const waitGone = async (pid: number | undefined) => {
      for (let i = 0; i < 40; i += 1) {
        if (!isAlive(pid)) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
      return false;
    };
    const waitUp = async (port: number) => {
      for (let i = 0; i < 40; i += 1) {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return true;
        } catch {
          /* not yet */
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    };

    it('stops the service it can identify by port, leaves a look-alike on another port alone', async () => {
      const { spawn } = await import('node:child_process');
      const servicePort = await freePort();
      const otherPort = await freePort();
      // Both run the SAME relative command line "node dist/index.js"; only the port tells them apart.
      const mine = spawn(process.execPath, ['dist/index.js'], { cwd: standIn(servicePort), stdio: 'ignore', windowsHide: true });
      const lookAlike = spawn(process.execPath, ['dist/index.js'], { cwd: standIn(otherPort), stdio: 'ignore', windowsHide: true });
      try {
        expect(await waitUp(servicePort)).toBe(true);
        expect(await waitUp(otherPort)).toBe(true);
        fs.writeFileSync(path.join(project, 'service', '.env'), `PORT=${servicePort}\n`);

        const r = run('stop-service.bat');
        expect(r.out).toMatch(/Stopped the service/);
        expect(await waitGone(mine.pid)).toBe(true);
        expect(isAlive(lookAlike.pid)).toBe(true); // same command line, different port: not ours
        expect(await waitUp(otherPort)).toBe(true);
      } finally {
        mine.kill();
        lookAlike.kill();
      }
    });

    it('leaves a different program that happens to use the configured port alone', async () => {
      const { spawn } = await import('node:child_process');
      const port = await freePort();
      const stranger = spawn(process.execPath, ['dist/index.js'], { cwd: standIn(port, 'some-other-product'), stdio: 'ignore', windowsHide: true });
      try {
        expect(await waitUp(port)).toBe(true);
        fs.writeFileSync(path.join(project, 'service', '.env'), `PORT=${port}\n`);
        const r = run('stop-service.bat');
        expect(r.out).toMatch(/not running/);
        expect(isAlive(stranger.pid)).toBe(true);
      } finally {
        stranger.kill();
      }
    });

    it('reads PORT from service\\.env, ignoring comments and falling back to the default', async () => {
      const mod = (await import(new URL(`file:///${path.join(repoRoot, 'scripts', 'stop-service.mjs').replace(/\\/g, '/')}`).href)) as {
        configuredPort: (dir: string, env?: Record<string, string | undefined>) => number;
      };
      const dir = path.join(sandbox, 'port-test');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '.env'), '# PORT=1111\nPORT=4600 # my port\n');
      expect(mod.configuredPort(dir, {})).toBe(4600);
      expect(mod.configuredPort(dir, { PORT: '4700' })).toBe(4700); // the environment wins, as in the service
      fs.writeFileSync(path.join(dir, '.env'), 'PORT=notanumber\n');
      expect(mod.configuredPort(dir, {})).toBe(4577);
      fs.rmSync(path.join(dir, '.env'));
      expect(mod.configuredPort(dir, {})).toBe(4577);
    });
  });
});
