// The built page driven against a CURRENT service (an isolated copy of this repository's service): the page must send the page
// scale along, the service must apply it, and the captured image must have the scaled size. This is the counterpart of
// old-service-check.mjs and guards against the page wrongly treating an up-to-date service as an old one.
//
//   node page-with-current-service-check.mjs
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startIsolatedService } from './isolated-service.mjs';
import { startStaticServer } from './static-server.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`);
};

const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>Scale page</title><body style="margin:0;font:24px sans-serif"><div style="padding:16px;background:#dbeafe">Scale check</div><div style="height:1200px;background:linear-gradient(#fff,#93c5fd)"></div></body>');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const target = `http://127.0.0.1:${site.address().port}/scaled`;

let svc;
let pages;
let browser;
try {
  svc = await startIsolatedService();
  pages = await startStaticServer({ dir: path.resolve('..', 'frontend', 'dist-pages'), basePath: '/screenshot-gallery/' });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 1000 } })).newPage();
  const label = () => page.getByTestId('connection-label').first().innerText();
  const until = async (probe, ms, what) => {
    const t0 = Date.now();
    for (;;) { const v = await probe(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await page.waitForTimeout(150); }
  };
  const sent = [];
  page.on('request', (r) => { if (r.url().endsWith('/api/automation/start') && r.method() === 'POST') sent.push(r.postDataJSON()); });

  await page.goto(`${pages.url}#/connect?service=${encodeURIComponent(svc.url)}&token=${encodeURIComponent(svc.token)}`);
  await page.getByRole('dialog').getByRole('button', { name: 'Pair' }).click();
  await until(async () => /Connected/.test(await label()), 20000, 'connection');
  check('the page connects to the current service', true);

  await page.goto(pages.url + '#/');
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  const start = page.getByRole('button', { name: 'Start Automation' });
  await until(async () => !(await start.isDisabled()), 10000, 'Start to be enabled');
  await page.getByLabel('Web addresses (one per line)').fill(target);
  await page.getByLabel('Page scale').fill('50');
  await page.getByLabel('Screenshot mode').selectOption('viewport');
  await page.getByLabel('Extra wait after loading').fill('0');
  await page.getByLabel('Delay between pages').fill('0');
  await start.click();

  await until(async () => sent.length > 0, 8000, 'the start request');
  check('the page sent the page scale to the current service', sent[0]?.pageScalePercent === 50, JSON.stringify(sent[0]?.pageScalePercent));
  check('no "older version" message was shown for an up-to-date service', !/older version|Unrecognized key/i.test((await page.locator('[role=alert], [role=status]').allInnerTexts()).join(' ')));

  await until(async () => /Finished/.test(await page.getByTestId('status-message').innerText().catch(() => '')), 90000, 'the run to finish');
  check('the run finished with one capture', /1 captured, 0 failed/.test(await page.getByTestId('status-message').innerText()));

  const items = (await svc.api('GET', '/api/gallery')).json.items;
  check('the screenshot has the 50% size: 2560 x 1440 for the 1280 x 720 base window', items[0]?.width === 2560 && items[0]?.height === 1440, `${items[0]?.width}x${items[0]?.height}`);
  check('the page showed the same image size on the card', (await (async () => { await page.getByRole('link', { name: /^Gallery/ }).first().click(); await page.locator('article').first().waitFor(); return page.locator('article').first().innerText(); })()).includes('2,560 × 1,440 px'));
} catch (error) {
  check('check completed', false, error instanceof Error ? error.message : String(error));
} finally {
  await browser?.close();
  await pages?.close();
  await svc?.stop();
  site.closeAllConnections();
  site.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
