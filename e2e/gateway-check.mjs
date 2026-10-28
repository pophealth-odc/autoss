// The built page driven in real Edge through the GATEWAY: one address for the page and the service, as in GitHub Codespaces.
//
// It starts a throw-away copy of the service (random port, temporary folders, its own token) and puts the real gateway in
// front of it. The browser is only ever given the gateway's address, never the service's. It checks that the page
//   * finds the service at its own address without being told,
//   * pairs, runs a capture and shows the screenshot in the gallery (so images and the event stream work through the proxy),
//   * and that the gateway refuses another website and a wrong Host name.
//
//   node gateway-check.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startIsolatedService } from './isolated-service.mjs';

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

// A page to capture: a plain local page (the isolated service is allowed to capture addresses on this computer).
const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>Gateway target</title><body style="margin:0;font:28px sans-serif"><div style="padding:24px;background:#dcfce7">Captured through the gateway</div></body>');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const target = `http://127.0.0.1:${site.address().port}/hello`;

/** The real gateway, run the way the launcher runs it: inside the service process, enabled by an environment variable. */
async function startServiceWithGateway() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss3-gwcheck-'));
  const token = 'gateway-check-token-' + Math.random().toString(36).slice(2, 14).padEnd(12, 'x');
  const child = spawn(process.execPath, [path.join(root, 'service', 'dist', 'index.js')], {
    cwd: path.join(root, 'service'),
    env: {
      ...process.env,
      PORT: '0',
      DATA_DIR: path.join(dir, 'data'),
      SCREENSHOTS_DIR: path.join(dir, 'shots'),
      PAIRING_TOKEN: token,
      ALLOWED_ORIGINS: '',
      ALLOW_PRIVATE_TARGETS: 'true',
      ALLOWED_TARGET_HOSTS: '',
      FRONTEND_URL: '',
      LOG_LEVEL: 'warn',
      GATEWAY_ENABLED: 'true',
      GATEWAY_PORT: '0',
      GATEWAY_WEB_ROOT: path.join(root, 'frontend', 'dist'),
      GATEWAY_ALLOWED_HOSTS: '',
      CODESPACE_NAME: '',
      GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
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
    url, token, output: () => output,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill();
        await new Promise((resolve) => { const t = setTimeout(resolve, 5000); child.once('exit', () => { clearTimeout(t); resolve(); }); });
      }
      if (path.basename(dir).startsWith('ss3-gwcheck-')) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

/** One HTTP request with a Host header of our choosing (fetch cannot set one). */
function request({ port, host, pathname, headers = {} }) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname, headers: { Host: host, ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

let svc;
let browser;
try {
  svc = await startServiceWithGateway();
  const gwPort = Number(new URL(svc.url).port);
  check('the service started with the gateway enabled', true, svc.url);

  const pairingLine = /Open this link once to pair this browser:\s*\n\s*(\S+)/.exec(svc.output());
  check('the start-up message prints a pairing link on the gateway address', !!pairingLine && pairingLine[1].startsWith(svc.url + '/#/connect?'), pairingLine ? pairingLine[1].replace(svc.token, '[token]') : 'missing');

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  const page = await context.newPage();
  const until = async (probe, ms, what) => {
    const t0 = Date.now();
    for (;;) { const v = await probe(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await page.waitForTimeout(150); }
  };
  const label = () => page.getByTestId('connection-label').first().innerText();

  // Every network request the browser makes, to prove that it only ever talked to the gateway. blob: and data: addresses are
  // made inside the page (the gallery shows images from blob: addresses) and never leave the browser, so they are listed apart.
  const hosts = new Set();
  const local = new Set();
  page.on('request', (r) => {
    try {
      const u = new URL(r.url());
      if (u.protocol === 'http:' || u.protocol === 'https:') hosts.add(u.host);
      else local.add(u.protocol);
    } catch { /* ignore */ }
  });

  // 1. Open the plain address. No pairing link, no saved settings: the page must find the service on its own.
  await page.goto(svc.url + '/');
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  await until(async () => /Pairing needed|Not connected|Connected|Connecting/.test(await label()), 10000, 'a connection state');
  const settings = await page.evaluate(() => ({ marker: document.querySelector('meta[name=ssg-service]')?.getAttribute('content'), stored: localStorage.getItem('ssg.serviceUrl') }));
  check('the page carries the same-origin marker', settings.marker === 'same-origin');
  await page.goto(svc.url + '/#/settings');
  const addressField = page.getByLabel('Service address');
  await addressField.waitFor();
  check('the page looks for the service at its own address, not at 127.0.0.1:4577', (await addressField.inputValue()) === svc.url, await addressField.inputValue());
  check('no warning that the address is "not on your computer"', (await page.getByText('This address is not on your computer').count()) === 0);

  // 2. Pair with the printed link.
  await page.goto(pairingLine[1]);
  await page.getByRole('dialog').getByRole('button', { name: 'Pair' }).click();
  await until(async () => /Connected/.test(await label()), 20000, 'the connected badge');
  check('the page pairs and shows "Connected"', true);
  check('the token was removed from the address bar', !page.url().includes(svc.token), page.url().replace(svc.token, '[token]'));
  await until(async () => /Live updates on/.test(await page.getByTestId('connection-label').first().innerText().catch(() => '')) || (await page.getByText('Live updates on').count()) > 0, 10000, 'live updates');
  check('the live event stream works through the gateway ("Live updates on")', true);

  // 3. A real capture, end to end.
  await page.goto(svc.url + '/#/');
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  const start = page.getByRole('button', { name: 'Start Automation' });
  await until(async () => !(await start.isDisabled()), 10000, 'Start to be enabled');
  await page.getByLabel('Web addresses (one per line)').fill(target);
  await page.getByLabel('Extra wait after loading').fill('0');
  await page.getByLabel('Delay between pages').fill('0');
  await start.click();
  await until(async () => /Finished/.test(await page.getByTestId('status-message').innerText().catch(() => '')), 90000, 'the run to finish');
  check('a capture runs and finishes', /1 captured, 0 failed/.test(await page.getByTestId('status-message').innerText()), await page.getByTestId('status-message').innerText());

  await page.getByRole('link', { name: /^Gallery/ }).first().click();
  const card = page.locator('article').first();
  await card.waitFor();
  check('the gallery shows the new screenshot', (await card.innerText()).includes('Gateway target'));
  const thumb = card.locator('img').first();
  await until(async () => thumb.evaluate((img) => img.complete && img.naturalWidth > 0), 15000, 'the thumbnail to load');
  check('the thumbnail image loads through the gateway', true);

  const download = page.waitForEvent('download', { timeout: 15000 });
  await card.getByRole('button', { name: /Download/ }).first().click();
  const file = await download;
  const saved = path.join(os.tmpdir(), `ss3-gwcheck-${Date.now()}.png`);
  await file.saveAs(saved);
  const bytes = fs.readFileSync(saved);
  fs.rmSync(saved, { force: true });
  check('the download is a real PNG', bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', `${bytes.length} bytes`);

  check('the browser only ever talked to the gateway address', hosts.size > 0 && [...hosts].every((h) => h === new URL(svc.url).host), `network: ${[...hosts].join(', ')}; in-page only: ${[...local].join(', ') || 'none'}`);

  // 4. What the gateway must refuse.
  const wrongHost = await request({ port: gwPort, host: 'evil.example.com', pathname: '/api/health' });
  check('a request with a foreign Host name is refused (421)', wrongHost.status === 421, String(wrongHost.status));
  const foreign = await request({ port: gwPort, host: `127.0.0.1:${gwPort}`, pathname: '/api/gallery', headers: { Origin: 'https://evil.example.com', Authorization: `Bearer ${svc.token}` } });
  check('a request from another website is refused (403) even with the right token', foreign.status === 403, String(foreign.status));
  const noToken = await request({ port: gwPort, host: `127.0.0.1:${gwPort}`, pathname: '/api/gallery' });
  check('the pairing token is still required (401)', noToken.status === 401, String(noToken.status));
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
