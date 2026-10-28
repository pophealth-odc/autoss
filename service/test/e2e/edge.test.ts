import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectEdge } from '../../src/browser/edge.js';
import { createUrlPolicy } from '../../src/browser/url-policy.js';
import { BrowserSession } from '../../src/browser/session.js';
import { capturePage } from '../../src/browser/capture.js';
import { silentLogger } from '../../src/logger.js';
import type { AutomationStatus, GalleryItem } from '../../src/shared/contract.js';
import { readPngSize } from '../../src/storage/png.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';
import { startTestService, waitFor } from '../helpers/service.js';
import { makeTempDir } from '../helpers/tmp.js';

const edge = await detectEdge();
const describeEdge = edge.found ? describe : describe.skip;

const json = { 'Content-Type': 'application/json' };

/** Edge processes that belong to this test run, found by the unique profile directory in their command line. */
function edgeProcessesUsing(marker: string): number {
  if (process.platform !== 'win32') return 0;
  const script = `@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*' + $env:SS3_MARK + '*' }).Count`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, SS3_MARK: marker },
  });
  return Number(out.trim());
}

describeEdge('real Microsoft Edge', () => {
  let fx: FixtureServer;
  beforeAll(async () => {
    fx = await startFixtureServer();
  });
  afterAll(async () => {
    await fx.close();
  });

  async function withSession<T>(fn: (session: BrowserSession) => Promise<T>, allowPrivate = true, mode: 'headless' | 'headed' = 'headless'): Promise<T> {
    const policy = createUrlPolicy({ allowPrivate, allowedHosts: [] });
    const session = await BrowserSession.launch({
      mode,
      viewport: { width: 1280, height: 720 },
      profileDir: null,
      ignoreCertificateErrors: false,
      executablePath: null,
      policy,
      logger: silentLogger,
    });
    try {
      return await fn(session);
    } finally {
      await session.close();
    }
  }

  const baseOptions = (session: BrowserSession) => ({
    screenshotMode: 'fullPage' as const,
    pageTimeoutMs: 6_000,
    extraWaitMs: 0,
    autoScroll: true,
    maxFullPageHeight: 30_000,
    signal: new AbortController().signal,
    guard: session.guard,
  });

  it('detects the installed Edge and reports a version', () => {
    expect(edge.executablePath).toMatch(/msedge\.exe$/i);
    expect(edge.version).toMatch(/^\d+\.\d+/);
  });

  it('captures an ordinary page: title, final URL, size, links', async () => {
    await withSession(async (session) => {
      const page = await session.newPage();
      const r = await capturePage(page, `${fx.url}/ok`, baseOptions(session));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.title).toBe('OK page');
      expect(r.finalUrl).toBe(`${fx.url}/ok`);
      expect(r.httpStatus).toBe(200);
      expect(r.warnings).toEqual([]);
      expect(readPngSize(r.png)).toEqual({ width: r.width, height: r.height });
      expect(r.width).toBe(1280);
      expect(r.links).toContain(`${fx.url}/page2`);
      expect(r.links).not.toContain(`${fx.url}/ok#section`);
    });
  });

  it('follows redirects and reports the final address', async () => {
    await withSession(async (session) => {
      const r = await capturePage(await session.newPage(), `${fx.url}/redirect-chain`, baseOptions(session));
      expect(r.ok && r.finalUrl).toBe(`${fx.url}/ok`);
    });
  });

  it('captures error pages (404/500) with a warning instead of failing', async () => {
    await withSession(async (session) => {
      const page = await session.newPage();
      for (const [route, code] of [['/status/404', 404], ['/status/500', 500]] as const) {
        const r = await capturePage(page, `${fx.url}${route}`, baseOptions(session));
        expect(r.ok, route).toBe(true);
        if (!r.ok) continue;
        expect(r.httpStatus).toBe(code);
        expect(r.warnings.join(' ')).toContain(`HTTP status ${code}`);
      }
    });
  });

  it('full-page is taller than the viewport; viewport mode is exactly the viewport', async () => {
    await withSession(async (session) => {
      const page = await session.newPage();
      const full = await capturePage(page, `${fx.url}/tall?px=4000`, baseOptions(session));
      const view = await capturePage(page, `${fx.url}/tall?px=4000`, { ...baseOptions(session), screenshotMode: 'viewport' });
      expect(full.ok && full.height).toBe(4000);
      expect(view.ok && [view.width, view.height]).toEqual([1280, 720]);
    });
  });

  it('limits extremely tall pages and says so', async () => {
    await withSession(async (session) => {
      const r = await capturePage(await session.newPage(), `${fx.url}/tall?px=12000`, { ...baseOptions(session), maxFullPageHeight: 5_000 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.height).toBe(5_000);
      expect(r.warnings.join(' ')).toMatch(/limited to the first 5,000 px/);
    });
  });

  it('scrolling loads lazy images before a full-page capture', async () => {
    await withSession(async (session) => {
      const page = await session.newPage();
      const before = fx.hits.get('/img.png?0') ?? 0;
      const withScroll = await capturePage(page, `${fx.url}/lazy`, baseOptions(session));
      expect(withScroll.ok).toBe(true);
      expect(fx.hits.get('/img.png?2') ?? 0).toBeGreaterThan(0);
      expect((fx.hits.get('/img.png?0') ?? 0) - before).toBeGreaterThan(0);
    });
  });

  it('waits for pages that render with JavaScript', async () => {
    await withSession(async (session) => {
      const r = await capturePage(await session.newPage(), `${fx.url}/spa`, { ...baseOptions(session), extraWaitMs: 1_200 });
      expect(r.ok).toBe(true);
    });
  });

  it.each([
    ['a download', '/download', 'download'],
    ['HTTP 401 Basic auth', '/basic-auth', 'auth-required'],
    ['a page that never answers', '/never-answers', 'timeout'],
    ['a port nothing listens on', null, 'connection'],
  ])('reports %s as a failure of kind "%s"', async (_label, route, kind) => {
    await withSession(async (session) => {
      // Chromium refuses to connect to well-known service ports (1, 25, 6000...) before trying, so pick an unused high port.
      const url = route === null ? `http://127.0.0.1:${fx.port + 1 > 65_000 ? fx.port - 1 : fx.port + 1}/` : `${fx.url}${route}`;
      const r = await capturePage(await session.newPage(), url, { ...baseOptions(session), pageTimeoutMs: 2_500 });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.kind).toBe(kind);
        expect(r.message.length).toBeGreaterThan(10);
      }
    });
  });

  it('still captures a page whose load event never fires, with a warning', async () => {
    await withSession(async (session) => {
      const r = await capturePage(await session.newPage(), `${fx.url}/never-load`, { ...baseOptions(session), pageTimeoutMs: 2_000 });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.title).toBe('Never-load page');
        expect(r.warnings.join(' ')).toMatch(/did not finish loading/);
      }
    });
  });

  it('survives dialogs and pop-ups on the page', async () => {
    await withSession(async (session) => {
      const page = await session.newPage();
      const a = await capturePage(page, `${fx.url}/dialog`, baseOptions(session));
      const b = await capturePage(page, `${fx.url}/popup`, baseOptions(session));
      expect(a.ok && b.ok).toBe(true);
      await session.closeOtherPages(page);
      expect(session.context.pages().filter((p) => !p.isClosed())).toHaveLength(1);
    });
  });

  it('captures a PDF and a JSON document without failing', async () => {
    await withSession(async (session) => {
      const page = await session.newPage();
      expect((await capturePage(page, `${fx.url}/pdf`, baseOptions(session))).ok).toBe(true);
      expect((await capturePage(page, `${fx.url}/json`, baseOptions(session))).ok).toBe(true);
    });
  });

  describe('server-side request forgery protection', () => {
    it('refuses a redirect from a public-looking page to a local address (every hop is checked)', async () => {
      const internal = await startFixtureServer();
      try {
        // Only "127.0.0.1:<port of fx>" is exempt, as if it were the public site; the other port is "internal".
        const policy = createUrlPolicy({ allowPrivate: false, allowedHosts: ['127.0.0.1'] });
        // An exemption is per host name, so use a stricter policy that only allows the first fixture's origin via a custom resolver.
        const strict = {
          check: async (u: string) => (u.startsWith(fx.url) ? { allowed: true as const } : { allowed: false as const, reason: 'internal address' }),
          checkSyntax: policy.checkSyntax,
        };
        const session = await BrowserSession.launch({
          mode: 'headless',
          viewport: { width: 1280, height: 720 },
          profileDir: null,
          ignoreCertificateErrors: false,
          executablePath: null,
          policy: strict,
          logger: silentLogger,
        });
        try {
          const page = await session.newPage();
          const target = `${internal.url}/ok`;
          const r = await capturePage(page, `${fx.url}/redirect-to?target=${encodeURIComponent(target)}`, baseOptions(session));
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.kind).toBe('blocked');
          expect(internal.hits.get('/ok') ?? 0).toBe(0); // the request never reached the internal server
        } finally {
          await session.close();
        }
      } finally {
        await internal.close();
      }
    });

    it.each(['file:///C:/Windows/win.ini', 'data:text/html,hi', 'javascript:alert(1)', 'edge://settings', 'chrome://version'])(
      'does not follow a redirect to %s',
      async (target) => {
        await withSession(async (session) => {
          const r = await capturePage(await session.newPage(), `${fx.url}/redirect-to?target=${encodeURIComponent(target)}`, baseOptions(session));
          expect(r.ok).toBe(false);
        });
      },
    );
  });

  describe('window size', () => {
    /** State of the OS window that holds `page`, plus the page's own size. */
    async function windowOf(session: BrowserSession, page: Awaited<ReturnType<BrowserSession['newPage']>>) {
      const cdp = await session.context.newCDPSession(page);
      try {
        const { bounds } = await cdp.send('Browser.getWindowForTarget');
        const inner = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, availW: screen.availWidth, availH: screen.availHeight, dpr: devicePixelRatio }));
        return { state: bounds.windowState, ...inner };
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    }

    it('headed runs open a maximized window and the page fills it (no empty space around a fixed viewport)', async () => {
      await withSession(async (session) => {
        const page = await session.newPage();
        await page.goto(`${fx.url}/ok`);
        const w = await windowOf(session, page);
        expect(w.state).toBe('maximized');
        // The page is as wide as the maximized window allows: within the browser frame, not the old 1280 x 720 emulation.
        expect(w.w).toBeGreaterThan(w.availW - 40);
        expect(w.h).toBeGreaterThan(w.availH * 0.6);
      }, true, 'headed');
    });

    it('headed screenshots are taken in CSS pixels, whatever the screen scaling', async () => {
      await withSession(async (session) => {
        const page = await session.newPage();
        const r = await capturePage(page, `${fx.url}/ok`, { ...baseOptions(session), screenshotMode: 'viewport' });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const w = await windowOf(session, page);
        // A display scaled to 250% must not produce a 2.5x larger image.
        expect(r.width).toBeLessThanOrEqual(w.availW);
        expect(r.width).toBeGreaterThan(w.availW - 40);
      }, true, 'headed');
    });

    it('a saved profile that remembers a small window is still maximized', async () => {
      const tmp = await makeTempDir('ss3-maxprofile-');
      try {
        const profile = path.join(tmp.dir, 'p');
        const policy = createUrlPolicy({ allowPrivate: true, allowedHosts: [] });
        const launch = () =>
          BrowserSession.launch({ mode: 'headed', viewport: { width: 800, height: 600 }, profileDir: profile, ignoreCertificateErrors: false, executablePath: null, policy, logger: silentLogger });
        const first = await launch();
        // Restore the window to a small size so the profile remembers it.
        const page = await first.newPage();
        const cdp = await first.context.newCDPSession(page);
        const { windowId } = await cdp.send('Browser.getWindowForTarget');
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal', left: 40, top: 40, width: 700, height: 500 } });
        await cdp.detach().catch(() => undefined);
        await first.close();

        const second = await launch();
        try {
          const p2 = await second.newPage();
          await p2.goto(`${fx.url}/ok`);
          expect((await windowOf(second, p2)).state).toBe('maximized');
        } finally {
          await second.close();
        }
      } finally {
        await tmp.cleanup();
      }
    });

    it('headless runs keep the requested viewport (there is no window to maximize)', async () => {
      await withSession(async (session) => {
        const page = await session.newPage();
        await page.goto(`${fx.url}/ok`);
        const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));
        expect(size).toEqual({ w: 1280, h: 720, dpr: 1 });
      }, true, 'headless');
    });
  });

  describe('page scale through the session', () => {
    async function launchScaled(mode: 'headless' | 'headed', pageScalePercent: number, profileDir: string | null = null) {
      return BrowserSession.launch({
        mode,
        viewport: { width: 1280, height: 720 },
        pageScalePercent,
        profileDir,
        ignoreCertificateErrors: false,
        executablePath: null,
        policy: createUrlPolicy({ allowPrivate: true, allowedHosts: [] }),
        logger: silentLogger,
      });
    }
    const layout = (page: import('playwright-core').Page) => page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    const layoutOf = layout;

    it.each([
      [50, 2560, 1440],
      [100, 1280, 720],
      [150, 853, 480],
      [200, 640, 360],
    ])('headless at %s %% lays the page out at %s x %s CSS pixels and screenshots it at that size', async (percent, w, h) => {
      const session = await launchScaled('headless', percent);
      try {
        const page = await session.newPage();
        const r = await capturePage(page, `${fx.url}/ok`, { ...baseOptions(session), screenshotMode: 'viewport' });
        expect(await layout(page)).toEqual({ w, h });
        expect(r.ok && [r.width, r.height]).toEqual([w, h]);
      } finally {
        await session.close();
      }
    });

    it('headless at 50 % fits a page twice as tall into one full-page capture width', async () => {
      const session = await launchScaled('headless', 50);
      try {
        const r = await capturePage(await session.newPage(), `${fx.url}/tall?px=3000`, baseOptions(session));
        expect(r.ok && r.width).toBe(2560);
        expect(r.ok && r.height).toBe(3000);
      } finally {
        await session.close();
      }
    });

    it('headed zooms the real window: 50 % shows twice the CSS width of 100 %, with and without a saved profile', async () => {
      const widths: Record<string, number> = {};
      const tmp = await makeTempDir('ss3-scale-');
      try {
        for (const [label, percent, profile] of [
          ['temp100', 100, null],
          ['temp50', 50, null],
          ['saved50', 50, path.join(tmp.dir, 'saved')],
          ['saved100', 100, path.join(tmp.dir, 'saved')], // the SAME profile reused at another scale: the new scale must win
        ] as const) {
          const session = await launchScaled('headed', percent, profile);
          try {
            const page = await session.newPage();
            await page.goto(`${fx.url}/ok`);
            widths[label] = (await layout(page)).w;
          } finally {
            await session.close();
          }
        }
        expect(widths['temp50']! / widths['temp100']!).toBeCloseTo(2, 1);
        expect(widths['saved50']! / widths['temp100']!).toBeCloseTo(2, 1);
        expect(widths['saved100']).toBe(widths['temp100']);
      } finally {
        await tmp.cleanup();
      }
    });

    /** Opens a headed session at `percent`, captures `route`, and returns the layout size next to the image size. */
    async function headedShot(percent: number, route: string, mode: 'viewport' | 'fullPage') {
      const session = await launchScaled('headed', percent);
      try {
        const page = await session.newPage();
        const r = await capturePage(page, `${fx.url}${route}`, { ...baseOptions(session), screenshotMode: mode, pageScalePercent: percent, headed: true });
        const layout = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, docH: document.documentElement.scrollHeight }));
        return { layout, r };
      } finally {
        await session.close();
      }
    }

    it('headed screenshots at 100 % stay exactly as before (CSS pixels, never multiplied by screen scaling)', async () => {
      const { layout, r } = await headedShot(100, '/ok', 'viewport');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(Math.abs(r.width - layout.w)).toBeLessThanOrEqual(1);
      expect(r.warnings).toEqual([]);
    });

    it.each([50, 75])('headed screenshots zoomed OUT to %s %% come out at the page layout size (within one pixel)', async (percent) => {
      const view = await headedShot(percent, '/ok', 'viewport');
      expect(view.r.ok).toBe(true);
      if (!view.r.ok) return;
      expect(Math.abs(view.r.width - view.layout.w)).toBeLessThanOrEqual(1);
      expect(Math.abs(view.r.height - view.layout.h)).toBeLessThanOrEqual(1);
      expect(view.r.warnings).toEqual([]);

      const full = await headedShot(percent, '/tall?px=3000', 'fullPage');
      expect(full.r.ok).toBe(true);
      if (!full.r.ok) return;
      expect(Math.abs(full.r.width - full.layout.w)).toBeLessThanOrEqual(1);
      expect(Math.abs(full.r.height - 3000)).toBeLessThanOrEqual(2);
    });

    it('headed screenshots zoomed IN (200 %) are flagged: the limit is reported, not hidden', async () => {
      const { r } = await headedShot(200, '/ok', 'viewport');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.warnings.join(' ')).toMatch(/zoomed in to 200 %.*Headless mode/);
    });

    it('headless screenshots are exact at every scale and never carry a scale warning', async () => {
      for (const percent of [50, 200]) {
        const session = await launchScaled('headless', percent);
        try {
          const page = await session.newPage();
          const r = await capturePage(page, `${fx.url}/ok`, { ...baseOptions(session), screenshotMode: 'viewport', pageScalePercent: percent });
          const layout = await layoutOf(page);
          expect(r.ok && [r.width, r.height]).toEqual([layout.w, layout.h]);
          expect(r.ok && r.warnings).toEqual([]);
        } finally {
          await session.close();
        }
      }
    });

    it('removes the temporary profile folder of a headed run without a saved profile', async () => {
      const os = await import('node:os');
      const list = () => readdirSync(os.tmpdir()).filter((n) => n.startsWith('ss3-edge-'));
      const before = new Set(list());
      const session = await launchScaled('headed', 80);
      const during = list().filter((n) => !before.has(n));
      expect(during).toHaveLength(1);
      await session.close();
      expect(list().filter((n) => !before.has(n))).toEqual([]);
    });

    it('does not create a profile folder for a headless run without a saved profile', async () => {
      const os = await import('node:os');
      const list = () => readdirSync(os.tmpdir()).filter((n) => n.startsWith('ss3-edge-'));
      const before = new Set(list());
      const session = await launchScaled('headless', 80);
      try {
        expect(list().filter((n) => !before.has(n))).toEqual([]);
      } finally {
        await session.close();
      }
    });
  });

  it('closes every Edge process it started', async () => {
    const tmp = await makeTempDir('ss3-orphan-');
    try {
      const profile = path.join(tmp.dir, 'profile-orphan-check');
      const policy = createUrlPolicy({ allowPrivate: true, allowedHosts: [] });
      const session = await BrowserSession.launch({
        mode: 'headless',
        viewport: { width: 1280, height: 720 },
        profileDir: profile,
        ignoreCertificateErrors: false,
        executablePath: null,
        policy,
        logger: silentLogger,
      });
      await capturePage(await session.newPage(), `${fx.url}/ok`, baseOptions(session));
      expect(edgeProcessesUsing('profile-orphan-check')).toBeGreaterThan(0);
      await session.close();
      await waitFor(() => edgeProcessesUsing('profile-orphan-check') === 0 || undefined, 10_000, 'Edge processes to exit');
    } finally {
      await tmp.cleanup();
    }
  });

  it('persistent profiles keep cookies between runs and refuse concurrent use', async () => {
    const tmp = await makeTempDir('ss3-profile-');
    try {
      const profile = path.join(tmp.dir, 'p1');
      const policy = createUrlPolicy({ allowPrivate: true, allowedHosts: [] });
      const launch = () =>
        BrowserSession.launch({ mode: 'headless', viewport: { width: 1280, height: 720 }, profileDir: profile, ignoreCertificateErrors: false, executablePath: null, policy, logger: silentLogger });

      const first = await launch();
      await first.context.addCookies([{ name: 'session', value: 'abc', url: fx.url, expires: Math.floor(Date.now() / 1000) + 3_600 }]);
      await expect(launch()).rejects.toMatchObject({ code: 'profile_in_use' });
      await first.close();

      const second = await launch();
      try {
        expect((await second.context.cookies(fx.url)).map((c) => c.name)).toContain('session');
      } finally {
        await second.close();
      }
    } finally {
      await tmp.cleanup();
    }
  });

  describe('a complete run through the HTTP API', () => {
    it('captures real pages, saves PNG files, serves them back and zips them', async () => {
      const t = await startTestService({ env: { ALLOW_PRIVATE_TARGETS: 'true' }, realBrowser: true });
      const base = t.base;
      const auth = { Authorization: 'Bearer test-token-0123456789abcdef-0123456789' };
      try {
        const start = await fetch(`${base}/api/automation/start`, {
          method: 'POST',
          headers: { ...auth, ...json },
          body: JSON.stringify({
            urls: [`${fx.url}/ok`, `${fx.url}/status/404`, `${fx.url}/title-chars`, `${fx.url}/download`, `${fx.url}/tall?px=2500`],
            screenshotMode: 'fullPage',
            extraWaitMs: 100,
            delayBetweenPagesMs: 0,
            pageTimeoutMs: 8_000,
          }),
        });
        expect(start.status).toBe(202);

        const final = await waitFor(async () => {
          const s = (await (await fetch(`${base}/api/automation/status`, { headers: auth })).json()) as AutomationStatus;
          return s.active ? false : s;
        }, 60_000, 'real run to finish');

        expect(final.state).toBe('completed');
        expect(final).toMatchObject({ total: 5, completed: 5, succeeded: 4, failed: 1, percent: 100 });
        expect(final.failures[0]).toMatchObject({ kind: 'download' });
        expect(final.browserVersion).toMatch(/^\d+\./);

        const gallery = (await (await fetch(`${base}/api/gallery`, { headers: auth })).json()) as { items: GalleryItem[] };
        expect(gallery.items).toHaveLength(4);
        const titles = gallery.items.map((i) => i.title);
        expect(titles).toContain('OK page');
        expect(titles).toContain('Not Found Page');
        const odd = gallery.items.find((i) => i.url.endsWith('/title-chars'))!;
        expect(odd.filename).not.toMatch(/[<>:"/\\|?*]/);
        expect(odd.filename.toLowerCase()).not.toMatch(/(^|_)con(_|\.)/);

        for (const item of gallery.items) {
          const file = path.join(t.config.screenshotsDir, item.folder, item.filename);
          const head = await fs.readFile(file);
          expect(readPngSize(head)).toEqual({ width: item.width, height: item.height });
          expect(item.bytes).toBe(head.length);
          const img = await fetch(`${base}/api/gallery/${item.id}/image`, { headers: auth });
          expect(Buffer.from(await img.arrayBuffer()).equals(head)).toBe(true);
        }

        const zip = await fetch(`${base}/api/gallery/download-zip`, { method: 'POST', headers: { ...auth, ...json }, body: '{}' });
        const zipPath = path.join(t.dir, 'e2e.zip');
        await fs.writeFile(zipPath, Buffer.from(await zip.arrayBuffer()));
        const listing = execFileSync('tar', ['-tf', zipPath], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
        expect(listing.filter((n) => n.endsWith('.png'))).toHaveLength(4);
        expect(listing).toContain('index.csv');

        // Persistence: a new store over the same folders sees the same gallery.
        const { GalleryStore } = await import('../../src/storage/gallery-store.js');
        const reopened = await GalleryStore.open({ dataDir: t.config.dataDir, screenshotsDir: t.config.screenshotsDir, logger: silentLogger });
        expect(reopened.count).toBe(4);
      } finally {
        await t.cleanup().catch(() => undefined);
      }
    });

    it('Stop ends a run that is waiting on a slow page, keeps earlier screenshots and leaves no Edge behind', async () => {
      const t = await startTestService({ env: { ALLOW_PRIVATE_TARGETS: 'true' }, realBrowser: true });
      const base = t.base;
      const auth = { Authorization: 'Bearer test-token-0123456789abcdef-0123456789' };
      const status = async () => (await (await fetch(`${base}/api/automation/status`, { headers: auth })).json()) as AutomationStatus;
      try {
        await fetch(`${base}/api/automation/start`, {
          method: 'POST',
          headers: { ...auth, ...json },
          body: JSON.stringify({ urls: [`${fx.url}/ok`, `${fx.url}/never-answers`, `${fx.url}/page2`], pageTimeoutMs: 60_000, extraWaitMs: 0, delayBetweenPagesMs: 0 }),
        });
        await waitFor(async () => {
          const s = await status();
          return (s.succeeded === 1 && s.currentUrl?.endsWith('/never-answers')) || undefined;
        }, 30_000, 'second page to start');

        const t0 = Date.now();
        await fetch(`${base}/api/automation/stop`, { method: 'POST', headers: auth });
        const final = await waitFor(async () => {
          const s = await status();
          return s.active ? false : s;
        }, 20_000, 'run to stop');
        expect(Date.now() - t0).toBeLessThan(15_000);
        expect(final.state).toBe('stopped');
        expect(final.succeeded).toBe(1);
        expect((await (await fetch(`${base}/api/gallery`, { headers: auth })).json() as { total: number }).total).toBe(1);
        expect(fx.hits.get('/page2') ?? 0).toBe(0);
      } finally {
        await t.cleanup().catch(() => undefined);
      }
    });
  });
});
