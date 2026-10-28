// Renders the Dashboard's settings form in real Edge and saves a screenshot for a visual review. No service is needed: the
// form is shown in its disconnected state, which is enough to see the fields.
//
//   node dashboard-shot.mjs <output-folder> [width]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startStaticServer } from './static-server.mjs';

const out = path.resolve(process.argv[2] ?? '.');
const width = Number(process.argv[3] ?? 1360);
fs.mkdirSync(out, { recursive: true });

const pages = await startStaticServer({ dir: path.resolve('..', 'frontend', 'dist-pages'), basePath: '/screenshot-gallery/' });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await (await browser.newContext({ viewport: { width, height: 1500 } })).newPage();
  await page.goto(pages.url + '#/');
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  await page.getByLabel('Page scale').waitFor();
  const form = page.getByRole('form', { name: 'Automation settings' });
  await form.scrollIntoViewIfNeeded();
  await page.getByLabel('Page scale').fill('75');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, `dashboard-${width}.png`) });
  const state = await page.evaluate(() => ({
    scale: document.querySelector('input[type=number][list]')?.value,
    urls: document.querySelector('textarea')?.value.split('\n').length,
    preview: document.querySelector('[data-testid=prevday-preview]')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 400),
  }));
  console.log(JSON.stringify(state, null, 2));
} finally {
  await browser.close();
  await pages.close();
}
