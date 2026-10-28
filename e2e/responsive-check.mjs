// Checks the layout at desktop, tablet and phone widths in real Edge: no horizontal scrolling, nothing wider than the screen,
// the navigation reachable, and the main controls usable. Screenshots are written for a visual review.
//
//   node responsive-check.mjs [--shots <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startStaticServer } from './static-server.mjs';

const i = process.argv.indexOf('--shots');
const shotsDir = i > -1 ? path.resolve(process.argv[i + 1]) : null;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`);
};

const pages = await startStaticServer({ dir: path.resolve('..', 'frontend', 'dist-pages'), basePath: '/screenshot-gallery/' });
const browser = await chromium.launch({ channel: 'msedge', headless: true });

const SIZES = [
  { name: 'desktop', width: 1360, height: 900 },
  { name: 'laptop', width: 1024, height: 768 },
  { name: 'tablet-portrait', width: 768, height: 1024 },
  { name: 'tablet-landscape', width: 1180, height: 820 },
  { name: 'phone', width: 390, height: 844 },
];

try {
  for (const size of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height } });
    const page = await ctx.newPage();
    for (const route of ['/', '/gallery', '/settings']) {
      await page.goto(`${pages.url}#${route}`);
      await page.waitForTimeout(400);
      const metrics = await page.evaluate(() => {
        const doc = document.documentElement;
        const wide = [];
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > window.innerWidth + 1 && getComputedStyle(el).position !== 'fixed') {
            const inScroller = el.closest('pre, [class*="overflow-x"], [class*="overflow-auto"]');
            if (!inScroller) wide.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} right=${Math.round(r.right)}`);
          }
        }
        return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, wide: wide.slice(0, 4) };
      });
      const label = `${size.name} ${size.width}px ${route}`;
      check(`${label}: no horizontal page scroll`, metrics.scrollWidth <= metrics.clientWidth + 1, `scrollWidth=${metrics.scrollWidth} clientWidth=${metrics.clientWidth}`);
      check(`${label}: nothing sticks out past the screen`, metrics.wide.length === 0, metrics.wide.join('; '));
      if (shotsDir && route === '/' ) await page.screenshot({ path: path.join(shotsDir, `${size.name}-dashboard.png`), fullPage: false });
      if (shotsDir && route === '/gallery') await page.screenshot({ path: path.join(shotsDir, `${size.name}-gallery.png`), fullPage: false });
    }

    // Navigation must be reachable at every width: the sidebar on wide screens, a menu button on narrow ones.
    await page.goto(`${pages.url}#/`);
    await page.waitForTimeout(300);
    const sidebarVisible = await page.locator('aside').first().isVisible();
    if (sidebarVisible) {
      check(`${size.name}: sidebar navigation is visible`, await page.getByRole('navigation', { name: 'Main' }).first().isVisible());
    } else {
      await page.getByRole('button', { name: 'Open navigation' }).click();
      check(`${size.name}: menu button opens the navigation`, await page.getByRole('navigation', { name: 'Main' }).last().isVisible());
      await page.getByRole('navigation', { name: 'Main' }).last().getByRole('link', { name: /Settings/ }).click();
      await page.getByRole('heading', { name: 'Settings' }).waitFor();
      check(`${size.name}: the menu navigates and closes`, (await page.getByRole('button', { name: 'Close navigation' }).count()) === 0);
    }

    // Touch targets: primary buttons should be at least 32px tall (the smallest control size used).
    await page.goto(`${pages.url}#/`);
    await page.waitForTimeout(300);
    const heights = await page.getByRole('button', { name: /Start Automation|Stop Automation|Clear Gallery/ }).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    check(`${size.name}: main buttons are at least 40px tall`, heights.length === 3 && heights.every((h) => h >= 40), heights.join(','));
    await ctx.close();
  }

  // Text must remain readable at the zoom levels people use: 200% zoom is a WCAG requirement (reflow at 320 CSS px).
  const ctx = await browser.newContext({ viewport: { width: 320, height: 640 } });
  const page = await ctx.newPage();
  await page.goto(`${pages.url}#/`);
  await page.waitForTimeout(400);
  const m = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  check('320px wide (400% zoom equivalent): content reflows without horizontal scrolling', m.s <= m.c + 1, `scrollWidth=${m.s} clientWidth=${m.c}`);
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'reflow-320.png') });
  await ctx.close();
} finally {
  await browser.close();
  await pages.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
