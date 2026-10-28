import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { detectEdge } from '../../src/browser/edge.js';
import { emulatedViewport, writeDefaultZoom, zoomLevelFor } from '../../src/browser/page-scale.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';
import { makeTempDir } from '../helpers/tmp.js';

/**
 * Probes how the real Edge on this computer reacts to each way of scaling a page. The first two blocks are experiments that pin
 * down the mechanisms; the product relies on exactly what they assert.
 */
const edge = await detectEdge();
const describeEdge = edge.found ? describe : describe.skip;
const ARGS = ['--no-first-run', '--no-default-browser-check'];

describeEdge('page scale in the real Edge', () => {
  let fx: FixtureServer;
  beforeAll(async () => {
    fx = await startFixtureServer();
  });
  afterAll(async () => {
    await fx.close();
  });

  async function metrics(page: import('playwright-core').Page) {
    return page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: Number(devicePixelRatio.toFixed(3)) }));
  }

  describe('headless: emulation', () => {
    it.each([
      [50, { w: 2560, h: 1440, dpr: 0.5 }],
      [100, { w: 1280, h: 720, dpr: 1 }],
      [200, { w: 640, h: 360, dpr: 2 }],
      [125, { w: 1024, h: 576, dpr: 1.25 }],
    ])('%s %% lays the page out in the zoomed-browser size', async (percent, expected) => {
      const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ARGS });
      try {
        const ctx = await browser.newContext(emulatedViewport({ width: 1280, height: 720 }, percent));
        const page = await ctx.newPage();
        await page.goto(`${fx.url}/ok`);
        expect(await metrics(page)).toEqual(expected);
        // Screenshots are taken in CSS pixels, so they match the laid-out size whatever the scale.
        const shot = await page.screenshot({ scale: 'css' });
        expect([shot.readUInt32BE(16), shot.readUInt32BE(20)]).toEqual([expected.w, expected.h]);
      } finally {
        await browser.close();
      }
    });

    it('a media query sees the zoomed width (so a responsive page reacts as it would in a zoomed browser)', async () => {
      const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ARGS });
      try {
        const ctx = await browser.newContext(emulatedViewport({ width: 1280, height: 720 }, 200));
        const page = await ctx.newPage();
        await page.goto(`${fx.url}/ok`);
        expect(await page.evaluate(() => matchMedia('(max-width: 700px)').matches)).toBe(true);
        expect(await page.evaluate(() => matchMedia('(min-width: 1000px)').matches)).toBe(false);
      } finally {
        await browser.close();
      }
    });
  });

  describe('headed: the default zoom stored in the profile', () => {
    /** Opens a maximized headed Edge on `profile` and returns the page's CSS size and pixel ratio. */
    async function headedMetrics(profile: string) {
      const ctx = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: false, args: [...ARGS, '--start-maximized'], viewport: null });
      try {
        const page = ctx.pages()[0] ?? (await ctx.newPage());
        await page.goto(`${fx.url}/ok`);
        return await metrics(page);
      } finally {
        await ctx.close();
      }
    }

    it('the zoom level written to the Preferences file is honoured by Edge', async () => {
      const tmp = await makeTempDir('ss3-zoom-');
      try {
        const profile100 = path.join(tmp.dir, 'p100');
        const profile50 = path.join(tmp.dir, 'p50');
        const profile200 = path.join(tmp.dir, 'p200');
        await writeDefaultZoom(profile100, 100);
        await writeDefaultZoom(profile50, 50);
        await writeDefaultZoom(profile200, 200);

        const stored = JSON.parse(fs.readFileSync(path.join(profile50, 'Default', 'Preferences'), 'utf8')) as { partition: { default_zoom_level: { x: number } } };
        expect(stored.partition.default_zoom_level.x).toBeCloseTo(zoomLevelFor(50), 6);

        const at100 = await headedMetrics(profile100);
        const at50 = await headedMetrics(profile50);
        const at200 = await headedMetrics(profile200);
        // Zooming out to 50 % doubles the CSS width of the same window; zooming in to 200 % halves it.
        expect(at50.w / at100.w).toBeCloseTo(2, 1);
        expect(at200.w / at100.w).toBeCloseTo(0.5, 1);
        // The pixel ratio moves the opposite way (0.5x as many device pixels per CSS pixel at 50 %).
        expect(at50.dpr / at100.dpr).toBeCloseTo(0.5, 1);
      } finally {
        await tmp.cleanup();
      }
    });

    it('keeps the profile\'s other preferences when it writes the zoom', async () => {
      const tmp = await makeTempDir('ss3-zoom-keep-');
      try {
        const profile = path.join(tmp.dir, 'p');
        fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
        fs.writeFileSync(
          path.join(profile, 'Default', 'Preferences'),
          JSON.stringify({ intl: { selected_languages: 'fr' }, partition: { other: 1, default_zoom_level: { x: 3, keep: true } }, profile: { per_host_zoom_levels: { x: { 'example.com': 2 } }, name: 'work' } }),
        );
        await writeDefaultZoom(profile, 80);
        const after = JSON.parse(fs.readFileSync(path.join(profile, 'Default', 'Preferences'), 'utf8')) as Record<string, any>;
        expect(after.intl.selected_languages).toBe('fr');
        expect(after.partition.other).toBe(1);
        expect(after.partition.default_zoom_level.keep).toBe(true);
        expect(after.partition.default_zoom_level.x).toBeCloseTo(zoomLevelFor(80), 6);
        expect(after.profile.name).toBe('work');
        expect(after.profile.per_host_zoom_levels).toEqual({}); // an old per-site zoom must not override the chosen scale
      } finally {
        await tmp.cleanup();
      }
    });

    it('replaces a damaged preferences file instead of failing', async () => {
      const tmp = await makeTempDir('ss3-zoom-bad-');
      try {
        const profile = path.join(tmp.dir, 'p');
        fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
        fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), '{ this is not json');
        await writeDefaultZoom(profile, 150);
        const after = JSON.parse(fs.readFileSync(path.join(profile, 'Default', 'Preferences'), 'utf8')) as { partition: { default_zoom_level: { x: number } } };
        expect(after.partition.default_zoom_level.x).toBeCloseTo(zoomLevelFor(150), 6);
      } finally {
        await tmp.cleanup();
      }
    });
  });
});
