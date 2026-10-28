// Proves the page copes with a service that is OLDER than it: the situation that produced
//   Unrecognized key: "pageScalePercent"
// A stand-in old service is started on a random port. It answers exactly like the running one did before page scale existed:
// /api/health without a `features` list, and a start endpoint that rejects any setting it does not know. The real built page is
// driven against it in real Edge. Nothing touches a service you are running.
//
//   node old-service-check.mjs
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startStaticServer } from './static-server.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`);
};

const TOKEN = 'old-service-token-0123456789-abcdef';
const KNOWN = new Set(['urls', 'browser', 'mode', 'screenshotMode', 'followLinks', 'maxPages', 'sameOrigin', 'pageTimeoutMs', 'extraWaitMs', 'delayBetweenPagesMs', 'viewportWidth', 'viewportHeight', 'autoScroll', 'ignoreCertificateErrors', 'outputFolder', 'persistentProfile', 'profileName', 'manualLogin']);
const startBodies = [];

const idle = {
  state: 'idle', active: false, runId: null, startedAt: null, finishedAt: null, message: 'Ready.', settings: null, total: 0, completed: 0,
  succeeded: 0, failed: 0, percent: 0, currentUrl: null, currentStep: null, discovering: false, failures: [], browserVersion: null,
};

const oldService = http.createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Last-Event-ID');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') return void res.writeHead(204).end();
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const path = new URL(req.url, 'http://x').pathname;

  if (path === '/api/health') {
    // No `features` field: this is what a build from before the field existed sends.
    return json(200, { ok: true, service: 'screenshot-gallery-service', version: '1.0.0', apiVersion: 1, authRequired: true, time: new Date().toISOString() });
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: { code: 'unauthorized', message: 'A pairing token is required.' } });

  if (path === '/api/system/info') {
    return json(200, { version: '1.0.0', apiVersion: 1, platform: 'win32', nodeVersion: process.version, uptimeSec: 1, edge: { found: true, executablePath: 'x', version: '155', source: 'standard-path' }, screenshotsDir: 'C:\\x', profilesDir: 'C:\\y', privateTargetsAllowed: false, allowedTargetHosts: [], thumbnailsAvailable: true, maxFullPageHeight: 30000, allowedOrigins: [], allowLocalhostOrigins: true, limits: {} });
  }
  if (path === '/api/automation/status') return json(200, idle);
  if (path === '/api/gallery') return json(200, { items: [], total: 0, totalBytes: 0 });
  if (path === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('retry: 3000\n\n'); return; }
  if (path === '/api/automation/start' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      startBodies.push(parsed);
      const unknown = Object.keys(parsed).find((k) => !KNOWN.has(k));
      if (unknown) {
        // Exactly the old strict schema's answer.
        return json(400, { error: { code: 'validation_failed', message: `Unrecognized key: "${unknown}"`, details: [{ field: 'request', message: `Unrecognized key: "${unknown}"` }] } });
      }
      json(202, { ...idle, state: 'running', active: true, message: 'Running.', total: parsed.urls.length });
    });
    return;
  }
  json(404, { error: { code: 'not_found', message: 'No such endpoint' } });
});
await new Promise((r) => oldService.listen(0, '127.0.0.1', r));
const serviceUrl = `http://127.0.0.1:${oldService.address().port}`;

const pages = await startStaticServer({ dir: path.resolve('..', 'frontend', 'dist-pages'), basePath: '/screenshot-gallery/' });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 1000 } })).newPage();
  const label = () => page.getByTestId('connection-label').first().innerText();
  const until = async (probe, ms, what) => {
    const t0 = Date.now();
    for (;;) { const v = await probe(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await page.waitForTimeout(150); }
  };
  const toastText = async () => (await page.locator('[role=alert], [role=status]').allInnerTexts()).join(' | ');

  await page.goto(`${pages.url}#/connect?service=${encodeURIComponent(serviceUrl)}&token=${encodeURIComponent(TOKEN)}`);
  await page.getByRole('dialog').getByRole('button', { name: 'Pair' }).click();
  await until(async () => /Connected/.test(await label()), 20000, 'connection to the old service');
  check('the page connects to an older service that sends no feature list', true);

  await page.goto(pages.url + '#/');
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  const start = page.getByRole('button', { name: 'Start Automation' });
  await until(async () => !(await start.isDisabled()), 10000, 'Start to be enabled');
  await page.getByLabel('Web addresses (one per line)').fill('https://example.com/');

  // 1. The default scale (100): the older service must still work, the field is simply not sent.
  startBodies.length = 0;
  await start.click();
  await until(async () => startBodies.length > 0, 8000, 'the start request');
  check('at the default 100% the request to an older service leaves out the new setting', !('pageScalePercent' in startBodies[0]), JSON.stringify(Object.keys(startBodies[0])));
  await until(async () => /0 of 1 page/.test(await page.getByTestId('progress-text').innerText().catch(() => '')), 8000, 'the run to appear');
  check('...and the run starts instead of failing with "Unrecognized key"', !/Unrecognized key/i.test(await toastText()), await toastText());
  check('...and the run is shown at once, from the answer to Start (this stand-in sends no live events)', (await page.getByTestId('status-message').innerText()) === 'Running.');
  check('...and Start is disabled while the run is active, so it cannot be started twice', await start.isDisabled());

  // 2. A scale the older service cannot apply: the person is told to restart, nothing is sent, nothing is captured at the wrong scale.
  // (A reload gives a fresh page whose run panel is idle again; this stand-in reports an idle service.)
  await page.reload();
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  await until(async () => /Connected/.test(await label()), 20000, 'reconnect');
  await until(async () => !(await start.isDisabled()), 10000, 'Start to be enabled');
  await page.getByLabel('Page scale').fill('50');
  startBodies.length = 0;
  await start.click();
  await until(async () => /older version/.test(await toastText()), 8000, 'the explanation');
  const text = await toastText();
  check('a scale the older service cannot apply is explained in plain words', /older version/.test(text) && /page scale of 50%/.test(text), text.slice(0, 200));
  check('the explanation says how to fix it', /start-service\.bat/.test(text) && /again/.test(text));
  check('the raw "Unrecognized key" message is never shown', !/Unrecognized key/i.test(text));
  check('nothing was sent, so nothing was captured at the wrong scale', startBodies.length === 0);

} catch (error) {
  check('check completed', false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
  await pages.close();
  oldService.closeAllConnections();
  oldService.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
