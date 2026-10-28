import fs from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { chromium, type BrowserContext } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capturePage, type CaptureOptions } from '../../src/browser/capture.js';
import { detectEdge } from '../../src/browser/edge.js';
import { NavigationGuard } from '../../src/browser/nav-guard.js';
import { createUrlPolicy } from '../../src/browser/url-policy.js';
import { BrowserSession } from '../../src/browser/session.js';
import { silentLogger } from '../../src/logger.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';
import { makeTempDir } from '../helpers/tmp.js';

/**
 * Does the page FILL the screenshot? A red frame sits on the very edge of the viewport, so an image that is padded with blank
 * space, cropped, or scaled to a size the layout never reached shows a frame that stops short of the image edge. (Checking only
 * the image dimensions cannot see this: a 2386 x 1069 image with a 1910 x 856 page in its corner has perfectly good dimensions.)
 */

/** Decodes an 8-bit RGB/RGBA PNG (what the browser produces) into raw pixels, without any image library. */
function decodePng(png: Buffer): { width: number; height: number; channels: number; data: Buffer } {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const colorType = png[25]!;
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (channels === 0 || png[24] !== 8) throw new Error(`unsupported PNG (color type ${colorType}, depth ${png[24]})`);
  const idat: Buffer[] = [];
  for (let p = 8; p < png.length; ) {
    const len = png.readUInt32BE(p);
    if (png.toString('ascii', p + 4, p + 8) === 'IDAT') idat.push(png.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[y * stride + x - channels]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels]! : 0;
      const v = raw[src + x]!;
      let r: number;
      if (filter === 0) r = v;
      else if (filter === 1) r = v + a;
      else if (filter === 2) r = v + b;
      else if (filter === 3) r = v + ((a + b) >> 1);
      else {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[y * stride + x] = r & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** Where the red frame is in the image. An image the page fills has red touching all four edges. */
function frame(png: Buffer) {
  const d = decodePng(png);
  const red = (x: number, y: number) => {
    const i = (y * d.width + x) * d.channels;
    return d.data[i]! > 200 && d.data[i + 1]! < 60 && d.data[i + 2]! < 60;
  };
  const midY = Math.floor(d.height / 2);
  const midX = Math.floor(d.width / 2);
  let left = -1, right = -1, top = -1, bottom = -1;
  for (let x = 0; x < d.width; x += 1) if (red(x, midY)) { if (left < 0) left = x; right = x; }
  for (let y = 0; y < d.height; y += 1) if (red(midX, y)) { if (top < 0) top = y; bottom = y; }
  const tol = 3;
  return {
    width: d.width, height: d.height, left, right, top, bottom,
    fillsWidth: left >= 0 && left <= tol && right >= d.width - 1 - tol,
    fillsHeight: top >= 0 && top <= tol && bottom >= d.height - 1 - tol,
  };
}

const edge = await detectEdge();
const describeEdge = edge.found ? describe : describe.skip;
const policy = createUrlPolicy({ allowPrivate: true, allowedHosts: [] });

describeEdge('the page fills the screenshot', () => {
  let fx: FixtureServer;
  beforeAll(async () => {
    fx = await startFixtureServer();
  });
  afterAll(async () => {
    await fx.close();
  });

  const opts = (session: { guard: NavigationGuard }, over: Partial<CaptureOptions> = {}): CaptureOptions => ({
    screenshotMode: 'viewport', pageTimeoutMs: 8000, extraWaitMs: 0, autoScroll: false, maxFullPageHeight: 30000,
    signal: new AbortController().signal, guard: session.guard, ...over,
  });

  async function shoot(mode: 'headless' | 'headed', scale: number, shot: 'viewport' | 'fullPage', route = '/frame', profileDir: string | null = null) {
    const session = await BrowserSession.launch({
      mode, viewport: { width: 1280, height: 720 }, pageScalePercent: scale, profileDir, ignoreCertificateErrors: false, executablePath: null, policy, logger: silentLogger,
    });
    try {
      const page = await session.newPage();
      const r = await capturePage(page, `${fx.url}${route}`, opts(session, { screenshotMode: shot, pageScalePercent: scale, headed: mode === 'headed' }));
      if (!r.ok) throw new Error(r.message);
      const layout = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
      return { r, layout, f: frame(r.png) };
    } finally {
      await session.close();
    }
  }

  describe('a clean profile: every mode, scale and screenshot type fills the image', () => {
    it.each([
      ['headless', 100, 'viewport'],
      ['headless', 100, 'fullPage'],
      ['headless', 50, 'viewport'],
      ['headless', 200, 'fullPage'],
      ['headed', 100, 'viewport'],
      ['headed', 100, 'fullPage'],
      ['headed', 50, 'viewport'],
      ['headed', 50, 'fullPage'],
      ['headed', 75, 'fullPage'],
    ] as const)('%s at %s %% (%s)', async (mode, scale, shot) => {
      const { f } = await shoot(mode, scale, shot);
      expect(f.fillsWidth, `frame x ${f.left}..${f.right} of ${f.width}`).toBe(true);
      expect(f.fillsHeight, `frame y ${f.top}..${f.bottom} of ${f.height}`).toBe(true);
    });
  });

  describe('a saved profile that remembers a different zoom for the website (the reported white area)', () => {
    /** A profile exactly like the user's: a per-site zoom of about 80 % stored where Edge keeps it. */
    function poisonedProfile(dir: string, host: string, level = -1.2239) {
      fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'Default', 'Preferences'),
        JSON.stringify({ partition: { per_host_zoom_levels: { x: { [host]: { last_modified: '13437642747453333', zoom_level: level } } } } }),
      );
    }

    it.each([
      ['headed', 100, 'viewport'],
      ['headed', 100, 'fullPage'],
      ['headed', 50, 'fullPage'],
      ['headless', 100, 'viewport'],
      ['headless', 50, 'fullPage'],
    ] as const)('%s at %s %% (%s): the remembered zoom is cleared and the page fills the image', async (mode, scale, shot) => {
      const tmp = await makeTempDir('ss3-zoomfill-');
      try {
        const profile = path.join(tmp.dir, 'p');
        poisonedProfile(profile, '127.0.0.1');
        const { f, layout } = await shoot(mode, scale, shot, '/frame', profile);
        expect(f.fillsWidth, `frame x ${f.left}..${f.right} of ${f.width} (layout ${layout.w})`).toBe(true);
        expect(f.fillsHeight, `frame y ${f.top}..${f.bottom} of ${f.height} (layout ${layout.h})`).toBe(true);
        // The requested scale applied, not the remembered one: 50 % shows twice the width of 100 %.
        const expectedWidth = mode === 'headless' ? Math.round(1280 / (scale / 100)) : undefined;
        if (expectedWidth !== undefined) expect(layout.w).toBe(expectedWidth);
      } finally {
        await tmp.cleanup();
      }
    });

    it('the safety net: even if a remembered zoom is NOT cleared, the image still fills the frame', async () => {
      // Launch Edge directly (no cleanup of the profile) with a remembered 80 % zoom, then use the real capture on its page.
      const tmp = await makeTempDir('ss3-zoomnet-');
      let context: BrowserContext | undefined;
      try {
        const profile = path.join(tmp.dir, 'p');
        poisonedProfile(profile, '127.0.0.1');
        context = await chromium.launchPersistentContext(profile, {
          channel: 'msedge', headless: false, viewport: null, args: ['--no-first-run', '--no-default-browser-check', '--start-maximized'],
        });
        const page = context.pages()[0] ?? (await context.newPage());
        const guard = new NavigationGuard(policy, silentLogger);
        await guard.attach(context, page);
        const r = await capturePage(page, `${fx.url}/frame`, {
          screenshotMode: 'viewport', pageTimeoutMs: 8000, extraWaitMs: 0, autoScroll: false, maxFullPageHeight: 30000,
          pageScalePercent: 100, headed: true, signal: new AbortController().signal, guard,
        });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const layout = await page.evaluate(() => ({ w: innerWidth, zoomed: outerWidth / innerWidth }));
        expect(layout.zoomed, 'the remembered zoom really is in force in this test').toBeLessThan(0.9);
        const f = frame(r.png);
        expect(f.fillsWidth, `frame x ${f.left}..${f.right} of ${f.width}`).toBe(true);
        expect(f.fillsHeight, `frame y ${f.top}..${f.bottom} of ${f.height}`).toBe(true);
      } finally {
        await context?.close().catch(() => undefined);
        await tmp.cleanup();
      }
    });
  });

  describe('tall pages', () => {
    it('a headed full-page capture of a tall document has the red frame on all four edges of the whole document', async () => {
      const { f, r } = await (async () => {
        const out = await shoot('headed', 100, 'fullPage', '/frame-tall');
        return { f: out.f, r: out.r };
      })();
      expect(r.height).toBeGreaterThanOrEqual(3000); // the whole document, not just the window
      expect(f.fillsWidth, `frame x ${f.left}..${f.right} of ${f.width}`).toBe(true);
      expect(f.fillsHeight, `frame y ${f.top}..${f.bottom} of ${f.height}`).toBe(true);
    });
  });
});
