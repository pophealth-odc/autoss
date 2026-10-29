// The sign-in wall of a public deployment, driven in real Edge: the visitor meets a password form, a wrong password is refused, the
// right one opens the page, and from then on pairing and a real capture work through the gateway. It also shows that someone who
// has NOT signed in gets nothing, with a browser and with plain requests.
//
// It starts a throw-away copy of the service (random port, temporary folders) with the gateway listening on this computer only, so
// nothing is exposed. The cookie is therefore the plain-http kind; its "Secure" and "__Host-" form is covered by the unit tests.
//
//   node gate-check.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`);
};

if (!fs.existsSync(path.join(root, 'frontend', 'dist', 'index.html'))) {
  console.error('The web page is not built. Run "npx vite build" in the frontend folder first.');
  process.exit(2);
}

const PASSWORD = 'gate-check access password 2026';
const TOKEN = 'gate-check-pairing-token-0123456789abcdef';

const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>Behind the wall</title><body style="margin:0;font:28px sans-serif"><div style="padding:24px;background:#fee2e2">Captured behind the sign-in wall</div></body>');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const target = `http://127.0.0.1:${site.address().port}/hello`;

async function startService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss3-gatecheck-'));
  const child = spawn(process.execPath, [path.join(root, 'service', 'dist', 'index.js')], {
    cwd: path.join(root, 'service'),
    env: {
      ...process.env, PORT: '0', DATA_DIR: path.join(dir, 'data'), SCREENSHOTS_DIR: path.join(dir, 'shots'),
      PAIRING_TOKEN: TOKEN, ALLOWED_ORIGINS: '', ALLOW_PRIVATE_TARGETS: 'true', ALLOWED_TARGET_HOSTS: '', FRONTEND_URL: '', LOG_LEVEL: 'warn',
      GATEWAY_ENABLED: 'true', GATEWAY_PORT: '0', GATEWAY_HOST: '127.0.0.1', GATEWAY_ACCESS_PASSWORD: PASSWORD,
      GATEWAY_WEB_ROOT: path.join(root, 'frontend', 'dist'), GATEWAY_ALLOWED_HOSTS: '', CODESPACE_NAME: '', RENDER_EXTERNAL_HOSTNAME: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const started = Date.now();
  let url = '';
  while (!url) {
    const m = /Web page \+ service on one address[^\n]*\n\s*(http:\/\/127\.0\.0\.1:\d+)/.exec(output);
    if (m) url = m[1];
    else if (child.exitCode !== null) throw new Error(`The service exited early:\n${output.slice(-800)}`);
    else if (Date.now() - started > 30000) { child.kill(); throw new Error(`No gateway address within 30 s:\n${output.slice(-800)}`); }
    else await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url, output: () => output,
    stop: async () => {
      if (child.exitCode === null) { child.kill(); await new Promise((resolve) => { const t = setTimeout(resolve, 5000); child.once('exit', () => { clearTimeout(t); resolve(); }); }); }
      if (path.basename(dir).startsWith('ss3-gatecheck-')) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

function plain(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode, body })); }).on('error', reject);
  });
}

let svc;
let browser;
try {
  svc = await startService();
  check('the service started with the sign-in wall on', true, svc.url);
  check('the start-up message says the wall is on', /Sign-in wall: ON/.test(svc.output()));
  check('a local gateway still prints its pairing link (nobody else can reach it)', /Open this link once to pair this browser/.test(svc.output()));

  // Plain requests, no browser: a stranger gets nothing.
  const home = await plain(svc.url + '/');
  check('a stranger asking for the page gets only the sign-in form', home.status === 200 && home.body.includes('Access password') && !home.body.includes('id="root"'));
  const api = await plain(svc.url + '/api/gallery', { Authorization: `Bearer ${TOKEN}` });
  check('a stranger with the RIGHT pairing token still cannot read the API (401)', api.status === 401, String(api.status));
  const health = await plain(svc.url + '/healthz');
  check('the health check needs no sign-in and reveals nothing', health.status === 200 && health.body === 'ok');

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  const page = await context.newPage();
  const until = async (probe, ms, what) => {
    const t0 = Date.now();
    for (;;) { const v = await probe(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await page.waitForTimeout(150); }
  };

  // 1. The browser meets the form.
  await page.goto(svc.url + '/');
  await page.getByLabel('Access password').waitFor();
  check('the browser shows the sign-in form', true);
  check('the form page carries no script', (await page.locator('script').count()) === 0);
  check('the password field is a password field', (await page.getByLabel('Access password').getAttribute('type')) === 'password');

  // 2. A wrong password is refused, politely, and the password is not echoed.
  await page.getByLabel('Access password').fill('definitely the wrong password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('That password is not correct.').waitFor();
  check('a wrong password is refused with a clear message', true);
  check('the wrong password is not shown back', !(await page.content()).includes('definitely the wrong password'));
  check('no cookie was set by the wrong password', (await context.cookies()).every((c) => !c.name.includes('ssg_gate')));

  // 3. The right password opens the page.
  await page.getByLabel('Access password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  check('the right password opens the web page', true);
  const cookie = (await context.cookies()).find((c) => c.name === 'ssg_gate');
  check('the sign-in cookie is HttpOnly and SameSite=Lax', !!cookie && cookie.httpOnly === true && cookie.sameSite === 'Lax', cookie ? `httpOnly=${cookie.httpOnly} sameSite=${cookie.sameSite}` : 'no cookie');
  check('the page cannot read the cookie with script', !(await page.evaluate(() => document.cookie)).includes('ssg_gate'));
  check('the password is nowhere in the page address', !page.url().includes('password'), page.url());

  // 4. Pairing still needs the token; then a real capture works.
  const pairing = /Open this link once to pair this browser:\s*\n\s*(\S+)/.exec(svc.output())[1];
  await page.goto(pairing);
  await page.getByRole('dialog').getByRole('button', { name: 'Pair' }).click();
  await until(async () => /Connected/.test(await page.getByTestId('connection-label').first().innerText()), 20000, 'the connected badge');
  check('after signing in, the page pairs with the token and shows "Connected"', true);

  await page.goto(svc.url + '/#/');
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  const start = page.getByRole('button', { name: 'Start Automation' });
  await until(async () => !(await start.isDisabled()), 10000, 'Start to be enabled');
  await page.getByLabel('Web addresses (one per line)').fill(target);
  await page.getByLabel('Extra wait after loading').fill('0');
  await page.getByLabel('Delay between pages').fill('0');
  await start.click();
  await until(async () => /Finished/.test(await page.getByTestId('status-message').innerText().catch(() => '')), 90000, 'the run to finish');
  check('a capture runs behind the wall', /1 captured, 0 failed/.test(await page.getByTestId('status-message').innerText()));
  await page.getByRole('link', { name: /^Gallery/ }).first().click();
  const card = page.locator('article').first();
  await card.waitFor();
  check('the screenshot appears in the gallery', (await card.innerText()).includes('Behind the wall'));
  const thumb = card.locator('img').first();
  await until(async () => thumb.evaluate((img) => img.complete && img.naturalWidth > 0), 15000, 'the thumbnail to load');
  check('the thumbnail loads (images work behind the wall)', true);

  // 5. Signing out: with the cookie gone the page is shut again, and the page says what is wrong instead of blaming the token.
  await context.clearCookies();
  await page.reload();
  await page.getByLabel('Access password').waitFor();
  check('without the cookie the page is the sign-in form again', true);

  await page.goto(svc.url + '/#/settings');
  await page.getByLabel('Access password').waitFor();
  await page.getByLabel('Access password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Settings' }).first().waitFor();
  await until(async () => /Connected/.test(await page.getByTestId('connection-label').first().innerText()), 20000, 'the connected badge again');
  check('signing in again reconnects with the token the page remembered for this tab', true);

  // The sign-in runs out while the page is open. The page notices on its own (its live connection is refused) and must say so,
  // instead of blaming the pairing token, which is fine.
  await context.clearCookies();
  const advice = await until(async () => { const t = await page.locator('body').innerText(); return /signed out of this site/i.test(t) ? t : ''; }, 40000, 'the signed-out message');
  check('the page notices by itself that the sign-in ran out', true);
  check('it is explained as a sign-out, not as a wrong pairing token', /Reload this page and enter the access password/.test(advice) && /Your pairing token is not the problem/.test(advice) && !/pairing token was not accepted/i.test(advice));
} catch (error) {
  check('check completed', false, error instanceof Error ? error.message : String(error));
} finally {
  await browser?.close();
  await svc?.stop();
  site.closeAllConnections();
  site.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
