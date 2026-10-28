// Verifies scripts\windows\start-dev.bat for real: it must start the service in its own window and the web page, the page must
// pick a free port when 5173 is taken, and a page served from it must be able to pair with the service WITHOUT any browser
// permission prompt. Everything it starts is stopped again at the end.
//
//   node start-dev-check.mjs
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bat = path.join(root, 'scripts', 'windows', 'start-dev.bat');
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(probe, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + label);
    await sleep(250);
  }
}
const get = (url) =>
  new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.setTimeout(2000, () => { req.destroy(); resolve(0); });
  });

// Occupy 5173 ourselves if nothing does, so the "next free port" behaviour is always exercised.
let blocker = null;
if ((await get('http://127.0.0.1:5173/')) === 0) {
  blocker = http.createServer((_, res) => res.end('busy'));
  await new Promise((r, j) => { blocker.once('error', j); blocker.listen(5173, '127.0.0.1', r); }).catch(() => { blocker = null; });
}

const SERVICE_PORT = 4577;
if ((await get(`http://127.0.0.1:${SERVICE_PORT}/api/health`)) !== 0) {
  console.log('Port 4577 already answers - stop that service first. Skipping.');
  process.exit(2);
}

let out = '';
const child = spawn('cmd.exe', ['/d', '/s', '/c', `""${bat}""`], {
  cwd: root, env: { ...process.env, NO_PAUSE: '1', BROWSER: 'none' }, windowsVerbatimArguments: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));

let pageUrl = null;
try {
  pageUrl = await until(() => /Local:\s+(http:\/\/127\.0\.0\.1:\d+)\//.exec(out)?.[1], 90000, 'the web page address');
  check('start-dev.bat prints the web page address', true, pageUrl);
  check('the page did not take the busy port 5173', !pageUrl.endsWith(':5173'), pageUrl);
  check('the page answers over HTTP', (await until(async () => (await get(pageUrl + '/')) === 200, 30000, 'page 200')) === true);

  await until(async () => (await get(`http://127.0.0.1:${SERVICE_PORT}/api/health`)) === 200, 90000, 'the service');
  check('the service started in its own window and answers /api/health', true);

  // Pair a page served from 127.0.0.1 with the service: must work with no permission prompt.
  const token = (await import('node:fs')).readFileSync(path.join(root, 'service', 'data', 'pairing-token.txt'), 'utf8').trim();
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${pageUrl}/#/connect?service=${encodeURIComponent('http://127.0.0.1:' + SERVICE_PORT)}&token=${encodeURIComponent(token)}`);
    await page.getByRole('dialog').getByRole('button', { name: 'Pair' }).click();
    await page.getByTestId('connection-label').first().waitFor();
    await until(async () => /Connected/.test(await page.getByTestId('connection-label').first().innerText()), 30000, 'connected');
    check('a page served from this computer pairs with the service, no browser permission needed', true);
  } finally {
    await browser.close();
  }
} catch (error) {
  check('start-dev.bat flow', false, error instanceof Error ? error.message : String(error));
  console.log('--- output so far ---\n' + out.slice(-1500));
} finally {
  // Stop exactly what we started: the cmd tree rooted at `child`, and the service by its own stop script.
  if (child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  spawnSync(process.execPath, [path.join(root, 'scripts', 'stop-service.mjs'), path.join(root, 'service')], { windowsHide: true });
  await sleep(1500);
  blocker?.close();
}
const stillUp = (await get(`http://127.0.0.1:${SERVICE_PORT}/api/health`)) !== 0;
check('the service is stopped again after the check', !stillUp);
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
