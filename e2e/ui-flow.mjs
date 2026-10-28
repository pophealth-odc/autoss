// End-to-end check of the whole product in real Microsoft Edge:
//   built web page (served like GitHub Pages)  ->  real local service  ->  real Edge automation  ->  gallery.
//
//   node scripts/e2e/ui-flow.mjs [--headed] [--shots <dir>]
//
// Needs: frontend built into frontend/dist-pages with VITE_BASE=/screenshot-gallery/, and the service built (service/dist).
// Everything runs on 127.0.0.1 with throw-away folders; the user's own Edge profile is never touched.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startStaticServer } from './static-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const headed = process.argv.includes('--headed');
const shotsIndex = process.argv.indexOf('--shots');
const shotsDir = shotsIndex > -1 ? path.resolve(process.argv[shotsIndex + 1]) : null;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(probe, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}

// ---- a small site to capture --------------------------------------------------------------------------------------
const site = http.createServer((req, res) => {
  const page = (title, body) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset=utf-8><title>${title}</title><body style="margin:0;font:22px sans-serif;background:#fff"><h1 style="padding:24px">${title}</h1>${body}`);
  };
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/one') return page('First test page', '<div style="height:900px;background:linear-gradient(#bfdbfe,#1d4ed8)"></div>');
  if (u.pathname === '/two') return page('Second test page', '<div style="height:400px;background:#fde68a"></div>');
  if (u.pathname === '/three') return page('日本語のページ 🙂', '<div style="height:300px;background:#bbf7d0"></div>');
  if (u.pathname === '/slow') return setTimeout(() => page('Slow page', '<p>late</p>'), 25000);
  res.writeHead(404).end('nope');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const sitePort = site.address().port;
const siteUrl = `http://127.0.0.1:${sitePort}`;

// ---- the real service ---------------------------------------------------------------------------------------------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ss3-ui-'));
const servicePort = 45000 + Math.floor(Math.random() * 3000);
const PAGES_ORIGIN = 'https://tester.github.io';
const service = spawn(process.execPath, [path.join(root, 'service', 'dist', 'index.js')], {
  cwd: path.join(root, 'service'),
  env: {
    ...process.env,
    PORT: String(servicePort),
    DATA_DIR: path.join(work, 'data'),
    SCREENSHOTS_DIR: path.join(work, 'shots'),
    ALLOWED_ORIGINS: PAGES_ORIGIN,
    ALLOW_PRIVATE_TARGETS: 'true',
    LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let serviceOut = '';
service.stdout.on('data', (d) => (serviceOut += d));
service.stderr.on('data', (d) => (serviceOut += d));
const serviceUrl = `http://127.0.0.1:${servicePort}`;
await until(() => /PAIRING TOKEN/.test(serviceOut) && fs.existsSync(path.join(work, 'data', 'pairing-token.txt')), 20000, 'service to start');
const token = fs.readFileSync(path.join(work, 'data', 'pairing-token.txt'), 'utf8').trim();

// ---- the web page, served like GitHub Pages -----------------------------------------------------------------------
const pages = await startStaticServer({ dir: path.join(root, 'frontend', 'dist-pages'), basePath: '/screenshot-gallery/' });

const browser = await chromium.launch({ channel: 'msedge', headless: !headed });
let exitCode = 0;
try {
  // Scenario A: a page on a localhost origin (like `npm run preview`) -> no permission prompt needed.
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) consoleErrors.push(m.text()); });
  const shot = async (name) => { if (shotsDir) await page.screenshot({ path: path.join(shotsDir, name + '.png'), fullPage: false }); };

  // 1a. The page is pointed at an address where nothing is listening, so it must say so. The default address (127.0.0.1:4577)
  // is NOT used for this: anyone who is running the real service has it answering, which is not what this step is about.
  const deadPort = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p)); // a port that was free a moment ago and is closed again
    });
  });
  await page.addInitScript((url) => {
    try {
      if (!localStorage.getItem('ssg.serviceUrl')) localStorage.setItem('ssg.serviceUrl', url);
    } catch { /* storage blocked */ }
  }, `http://127.0.0.1:${deadPort}`);
  await page.goto(pages.url + '#/');
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  check('page loads under the GitHub Pages sub-path', true, pages.url);
  const startBtn = page.getByRole('button', { name: 'Start Automation' });
  const label = () => page.getByTestId('connection-label').first().innerText();
  await until(async () => /Not connected/.test(await label()), 30000, 'unreachable state');
  check('with no service at the saved address the page says "Not connected"', true);
  check('the page explains that the service is not reachable', (await page.getByText('The local service is not reachable').count()) === 1);
  check('Start Automation is disabled while disconnected', await startBtn.isDisabled());
  check('Stop Automation is disabled while disconnected', await page.getByRole('button', { name: 'Stop Automation' }).isDisabled());
  await shot('01-not-connected');

  // 1a'. What a brand-new browser shows: the two default Dynatrace addresses and the page scale at 100.
  const addresses = await page.getByLabel('Web addresses (one per line)').inputValue();
  check('a new browser starts with the two default addresses', addresses.split('\n').filter(Boolean).length === 2 && addresses.includes('aaj23525.live.dynatrace.com/ui/problems') && addresses.includes('status=CLOSED'));
  check('the defaults are written with {$prevday}, so they stay current', (addresses.match(/\{\$prevday\}/g) ?? []).length === 4);
  const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();
  const previewText = await page.getByTestId('prevday-preview').innerText();
  check('the page previews yesterday\'s date for the placeholder', previewText.includes(yesterday) && previewText.includes(`gtf=${yesterday}T00:00:00%2B08:00%20to%20${yesterday}T23:59:00%2B08:00`), yesterday);
  check('page scale starts at 100', (await page.getByLabel('Page scale').inputValue()) === '100');
  await page.getByLabel('Page scale').fill('10');
  await page.getByRole('button', { name: 'Start Automation' }).isDisabled(); // not connected: nothing is sent, the field is only edited
  await page.getByLabel('Page scale').fill('100');

  // 1b. A pairing link that carries only the service address: the service answers, but no token is known yet.
  await page.goto(`${pages.url}#/connect?service=${encodeURIComponent(serviceUrl)}`);
  await page.getByRole('dialog').getByRole('button', { name: 'Pair' }).click();
  await until(async () => /Pairing needed/.test(await label()), 30000, 'needs-token state');
  check('a reachable service without a token is reported as "Pairing needed" (not as connected)', true);
  await shot('01b-needs-pairing');
  await page.getByRole('link', { name: 'Dashboard' }).first().click();
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  check('Start Automation stays disabled until paired', await startBtn.isDisabled());

  // 2. Pair through the pairing link, as the service banner offers it. The token must disappear from the address bar.
  const link = `${pages.url}#/connect?service=${encodeURIComponent(serviceUrl)}&token=${encodeURIComponent(token)}`;
  await page.goto(link);
  await page.getByRole('dialog').getByRole('button', { name: 'Pair' }).click();
  await until(async () => /Connected/.test(await page.getByTestId('connection-label').first().innerText()), 20000, 'connected');
  check('pairing link connects to the real service', true);
  check('token is scrubbed from the address bar after pairing', !page.url().includes(token), page.url().replace(pages.url, '…/'));
  check('pairing link was not leaked in any request or Referer', !pages.requests.some((r) => r.includes(token)));
  const stored = await page.evaluate(() => ({ local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }) }));
  check('token is not persisted in localStorage unless the user opts in', !stored.local.includes(token));

  // 3. Build the URL list and start.
  await page.goto(pages.url + '#/');
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  await page.getByLabel('Web addresses (one per line)').fill(`${siteUrl}/one\n${siteUrl}/two\n# a comment\n${siteUrl}/three\n${siteUrl}/two\nnot a url at all`);
  await page.getByLabel('Extra wait after loading').fill('0.2');
  await page.getByLabel('Delay between pages').fill('0.2');
  await startBtn.click();
  await until(async () => /Address|address|Line|valid/.test(await page.locator('[role=alert]').first().innerText().catch(() => '')), 5000, 'validation message');
  check('an invalid line is reported with its line number before anything starts', /Line 6/.test(await page.locator('[role=alert]').first().innerText()));
  await shot('02-validation');
  await page.getByLabel('Web addresses (one per line)').fill(`${siteUrl}/one\n${siteUrl}/two\n# a comment\n${siteUrl}/three\n${siteUrl}/two`);
  await startBtn.click();

  await until(async () => /1 of 3|2 of 3|3 of 3|0 of 3/.test(await page.getByTestId('progress-text').innerText().catch(() => '')), 20000, 'progress to appear');
  await shot('03-running');
  await until(async () => /Finished/.test(await page.getByTestId('status-message').innerText().catch(() => '')), 90000, 'run to finish');
  check('progress shows 3 of 3 pages and 100% (duplicate removed)', /3 of 3/.test(await page.getByTestId('progress-text').innerText()) && (await page.getByTestId('progress-percent').innerText()).trim() === '100%');
  check('success count is 3 and failed count is 0', (await page.getByTestId('stat-success').innerText()).trim() === '3' && (await page.getByTestId('stat-failed').innerText()).trim() === '0');
  await shot('04-finished');

  // 4. Gallery: cards, fields, thumbnails (loaded through authenticated fetch, shown as blob: URLs).
  await page.getByRole('link', { name: /^Gallery/ }).first().click();
  await page.getByRole('heading', { name: 'Gallery' }).waitFor();
  await until(async () => (await page.locator('article').count()) === 3, 15000, '3 cards');
  check('the gallery shows one card per page', true);
  await until(async () => (await page.locator('article img').count()) === 3, 20000, 'thumbnails');
  const imgSrcs = await page.locator('article img').evaluateAll((els) => els.map((e) => e.src));
  check('thumbnails are blob: URLs (token never in a URL)', imgSrcs.every((s) => s.startsWith('blob:')), imgSrcs[0]?.slice(0, 40));
  const loaded = await page.locator('article img').evaluateAll((els) => els.map((e) => e.naturalWidth > 0));
  check('thumbnail images actually decoded', loaded.every(Boolean));
  const firstCard = page.locator('article').first();
  const text = await firstCard.innerText();
  check('card shows title, source URL, date/time and dimensions', /(test page|ページ)/.test(text) && text.includes(siteUrl.replace('http://', '')) || text.includes('127.0.0.1'), text.replace(/\n+/g, ' | ').slice(0, 140));
  check('card shows pixel dimensions', /\d[\d,]* × \d[\d,]* px/.test(text));
  check('card has Preview, Download and Delete buttons', (await firstCard.getByRole('button', { name: /^Preview/ }).count()) >= 1 && (await firstCard.getByRole('button', { name: /^Download/ }).count()) === 1 && (await firstCard.getByRole('button', { name: /^Delete/ }).count()) === 1);
  await shot('05-gallery');

  // 5. Sorting.
  const titles = async () => page.locator('article h3').allInnerTexts();
  await page.getByLabel('Sort by').selectOption('title');
  const byTitle = await titles();
  check('sort by title orders A-Z', JSON.stringify(byTitle) === JSON.stringify([...byTitle].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))), byTitle.join(' / '));
  await page.getByLabel('Sort by').selectOption('oldest');
  const oldest = await titles();
  await page.getByLabel('Sort by').selectOption('newest');
  const newest = await titles();
  check('oldest and newest are reverses of each other', JSON.stringify(oldest) === JSON.stringify([...newest].reverse()));

  // 6. Preview modal.
  await firstCard.getByRole('button', { name: /^Preview/ }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await until(async () => (await dialog.locator('img').count()) > 0 && (await dialog.locator('img').first().evaluate((e) => e.naturalWidth)) > 0, 15000, 'preview image');
  check('clicking the thumbnail opens a preview modal with the full image', true);
  await shot('06-preview');
  await page.keyboard.press('Escape');
  await until(async () => (await page.getByRole('dialog').count()) === 0 || !(await page.getByRole('dialog').first().isVisible()), 5000, 'modal to close');
  check('Escape closes the preview', true);

  // 7. Individual download.
  const [download] = await Promise.all([page.waitForEvent('download'), firstCard.getByRole('button', { name: /^Download/ }).click()]);
  const dlPath = path.join(work, 'single.png');
  await download.saveAs(dlPath);
  const head = fs.readFileSync(dlPath).subarray(0, 8);
  check('individual download produces a real PNG', head.toString('hex') === '89504e470d0a1a0a', download.suggestedFilename());

  // 8. Select + download selected + download all as ZIP.
  await page.getByRole('button', { name: 'Select all' }).click();
  check('select all selects every card', (await page.getByTestId('selection-count').innerText()).includes('3 of 3'));
  const [zipSel] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download selected' }).click()]);
  await zipSel.saveAs(path.join(work, 'selected.zip'));
  check('Download selected produces a ZIP', fs.readFileSync(path.join(work, 'selected.zip')).subarray(0, 4).toString('hex') === '504b0304', zipSel.suggestedFilename());
  await page.getByRole('button', { name: 'Select none' }).click();
  const [zipAll] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download all (ZIP)' }).click()]);
  await zipAll.saveAs(path.join(work, 'all.zip'));
  check('Download all produces a ZIP', fs.readFileSync(path.join(work, 'all.zip')).subarray(0, 4).toString('hex') === '504b0304', zipAll.suggestedFilename());

  // 9. Persistence: reload the page, the gallery comes from the service.
  await page.reload();
  await page.getByRole('heading', { name: 'Gallery' }).waitFor();
  await until(async () => (await page.locator('article').count()) === 3, 20000, 'gallery after reload');
  check('after reloading the page the gallery is restored from the service', true);

  // 10. Delete one with confirmation; cancel keeps it.
  await page.locator('article').first().getByRole('button', { name: /^Delete/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  check('cancelling a delete keeps the screenshot', (await page.locator('article').count()) === 3);
  await page.locator('article').first().getByRole('button', { name: /^Delete/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await until(async () => (await page.locator('article').count()) === 2, 10000, 'card removed');
  check('confirming a delete removes it', true);

  // 11. Clear all requires confirmation.
  await page.getByRole('button', { name: 'Clear all' }).click();
  check('Clear all asks for confirmation', await page.getByRole('dialog').getByText('Clear the whole gallery?').isVisible());
  await page.getByRole('dialog').getByRole('button', { name: 'Clear gallery' }).click();
  await until(async () => (await page.getByText('No screenshots yet').count()) === 1, 10000, 'empty state');
  check('clearing shows the empty state with instructions', true);
  await shot('07-empty');
  const leftover = fs.existsSync(path.join(work, 'shots')) ? fs.readdirSync(path.join(work, 'shots')).filter((n) => n.endsWith('.png')) : [];
  check('cleared screenshots are gone from the disk', leftover.length === 0);

  // 12. Stop: start a run on a slow page, press Stop, the run ends quickly and keeps earlier shots.
  await page.goto(pages.url + '#/');
  await page.getByLabel('Web addresses (one per line)').fill(`${siteUrl}/two\n${siteUrl}/slow\n${siteUrl}/one`);
  await startBtn.click();
  await until(async () => /\/slow/.test(await page.getByTestId('current-url').innerText().catch(() => '')), 30000, 'slow page to start');
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Stop Automation' }).click();
  await until(async () => /Stopped/.test(await page.getByTestId('status-message').innerText().catch(() => '')), 20000, 'stopped');
  check('Stop ends the run within seconds even while a page is loading', Date.now() - t0 < 15000, `${Date.now() - t0} ms`);
  check('Stop keeps the screenshots already captured', /1 screenshot saved/.test(await page.getByTestId('status-message').innerText()));
  await shot('08-stopped');

  // 13. Stop the service: the page must stop claiming it is connected.
  service.kill();
  await until(async () => /Not connected/.test(await page.getByTestId('connection-label').first().innerText()), 60000, 'disconnected state');
  check('when the service stops the page says "Not connected"', true);
  check('Start Automation is disabled again', await startBtn.isDisabled());
  check('the page explains that capturing is unavailable', (await page.getByText('Capturing screenshots is unavailable until the service is connected').count()) >= 1);
  await shot('09-disconnected');

  check('no unexpected errors in the page console', consoleErrors.length === 0, consoleErrors.join(' ; ').slice(0, 300));
  await ctx.close();
} catch (error) {
  exitCode = 1;
  check('flow completed without throwing', false, error instanceof Error ? error.message.split('\n')[0] : String(error));
} finally {
  await browser.close();
  service.kill();
  site.closeAllConnections();
  site.close();
  await pages.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) exitCode = 1;
console.log('Scratch folder (safe to delete):', work);
process.exit(exitCode);
