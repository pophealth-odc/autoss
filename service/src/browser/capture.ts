import type { Page } from 'playwright-core';
import { errorMessage } from '../errors.js';
import type { PageErrorKind, RunStep, ScreenshotMode } from '../shared/contract.js';
import { AbortedError, isAbortedError, raceAbort, sleep, throwIfAborted, withDeadline } from '../util/abort.js';
import { readPngSize } from '../storage/png.js';
import { classifyError } from './classify-error.js';
import type { NavigationGuard } from './nav-guard.js';
import { planZoomCapture, type ZoomCapturePlan } from './page-scale.js';

export interface CaptureOptions {
  screenshotMode: ScreenshotMode;
  pageTimeoutMs: number;
  extraWaitMs: number;
  autoScroll: boolean;
  /** Full-page captures taller than this are cut off at this height (with a warning). */
  maxFullPageHeight: number;
  /**
   * The page scale (browser zoom) the browser was opened with, in percent. Only a headed browser needs it here: its zoom is
   * Edge's own, which the screenshot conversion does not account for (see planZoomCapture). Headless scales by emulation,
   * where screenshots are already exact. Defaults to 100.
   */
  pageScalePercent?: number;
  /** True when the browser has a real window (headed). */
  headed?: boolean;
  signal: AbortSignal;
  guard: NavigationGuard;
  onStep?: (step: RunStep) => void;
}

export interface CaptureSuccess {
  ok: true;
  png: Buffer;
  width: number;
  height: number;
  title: string;
  finalUrl: string;
  httpStatus: number | null;
  warnings: string[];
  links: string[];
}

export interface CaptureFailure {
  ok: false;
  kind: PageErrorKind;
  message: string;
}

export type CaptureResult = CaptureSuccess | CaptureFailure;

const SCREENSHOT_TIMEOUT_MS = 45_000;
const MAX_LINKS_PER_PAGE = 300;

/** Navigates to `url`, waits until the page has settled, and takes a screenshot. Never throws (except it reports Stop). */
export async function capturePage(page: Page, url: string, options: CaptureOptions): Promise<CaptureResult> {
  const { signal } = options;
  const warnings: string[] = [];
  const blockedBefore = options.guard.blockedFor(page).length;

  try {
    throwIfAborted(signal);

    // 1. Navigate. "load" is the right target for ordinary pages; if it never fires but the document is usable we continue.
    options.onStep?.('navigating');
    let httpStatus: number | null = null;
    let navigationError: unknown = null;
    try {
      const response = await raceAbort(page.goto(url, { waitUntil: 'load', timeout: options.pageTimeoutMs }), signal);
      httpStatus = response ? response.status() : null;
    } catch (error) {
      if (isAbortedError(error)) throw error;
      navigationError = error;
    }

    if (navigationError !== null) {
      const refused = options.guard.blockedFor(page).slice(blockedBefore)[0];
      if (refused) return { ok: false, kind: 'blocked', message: `Blocked: ${refused.reason}` };
      const classified = classifyError(navigationError);
      // A page whose "load" event never fired (a hanging image or ad) can usually still be captured.
      if (classified.kind !== 'timeout' || !(await documentIsUsable(page))) {
        return { ok: false, kind: classified.kind, message: classified.message };
      }
      warnings.push(`The page did not finish loading within ${Math.round(options.pageTimeoutMs / 1000)} s; captured as it was.`);
    }

    const refused = options.guard.blockedFor(page).slice(blockedBefore)[0];
    if (refused) return { ok: false, kind: 'blocked', message: `Blocked: ${refused.reason}` };

    if (httpStatus !== null && httpStatus >= 400) warnings.push(`The server answered with HTTP status ${httpStatus}.`);

    // 2. Let the network quiet down briefly. A busy page (analytics, polling) must never fail the capture.
    options.onStep?.('waiting');
    await page.waitForLoadState('networkidle', { timeout: Math.min(5_000, options.pageTimeoutMs) }).catch(() => undefined);
    throwIfAborted(signal);

    if (options.extraWaitMs > 0) await sleep(options.extraWaitMs, signal);

    // 3. Scroll through full-page captures so lazy-loaded images and sections are rendered.
    if (options.screenshotMode === 'fullPage' && options.autoScroll) {
      options.onStep?.('scrolling');
      await scrollThrough(page, signal);
    }

    // 4. Collect links for link-following before the screenshot (the page is fully rendered now).
    const links = await collectLinks(page);

    // 5. Capture.
    options.onStep?.('capturing');
    const title = await readTitle(page);
    const finalUrl = page.url();
    const shot = await takeScreenshot(page, options, warnings);
    if (!shot.ok) return shot;

    return {
      ok: true,
      png: shot.png,
      width: shot.width,
      height: shot.height,
      title,
      finalUrl,
      httpStatus,
      warnings,
      links,
    };
  } catch (error) {
    if (isAbortedError(error)) throw new AbortedError();
    const classified = classifyError(error);
    return { ok: false, kind: classified.kind, message: classified.message };
  }
}

async function documentIsUsable(page: Page): Promise<boolean> {
  try {
    const state = await withDeadline(
      page.evaluate(() => document.readyState),
      3_000,
      'Checking the page state',
    );
    return state === 'interactive' || state === 'complete';
  } catch {
    return false;
  }
}

async function readTitle(page: Page): Promise<string> {
  try {
    const title = await withDeadline(page.title(), 5_000, 'Reading the page title');
    return title.replace(/\s+/g, ' ').trim().slice(0, 300);
  } catch {
    return '';
  }
}

interface Shot {
  ok: true;
  png: Buffer;
  width: number;
  height: number;
}

/**
 * The first full-page screenshot of a page in a visible window changes the layout (the window's scrollbar column goes away:
 * clientWidth 1513 -> 1528 on a 250 % display) AND is itself taken from the old layout, so it comes out 1 px narrower and 2 px
 * shorter than the page (1512 x 2998 for a 1513 x 3000 page). Later captures are exact. A tiny full-page capture is enough to
 * trigger the change; doing it BEFORE the page is measured makes the measurement and the real capture agree. A viewport capture
 * and waiting do not trigger it (measured), and headless windows have no scrollbar column to lose.
 */
async function settleWindowLayout(page: Page, options: CaptureOptions): Promise<void> {
  if (!options.headed || options.screenshotMode !== 'fullPage') return;
  try {
    await withDeadline(page.screenshot({ fullPage: true, clip: { x: 0, y: 0, width: 1, height: 1 }, scale: 'css', type: 'png', timeout: 15_000 }), 20_000, 'Preparing the full-page capture');
  } catch {
    /* only a preparation step; the real capture reports any real problem */
  }
}

async function takeScreenshot(page: Page, options: CaptureOptions, warnings: string[]): Promise<Shot | CaptureFailure> {
  const viewportOnly = options.screenshotMode === 'viewport';
  let clip: { x: number; y: number; width: number; height: number } | undefined;

  await settleWindowLayout(page, options);

  if (!viewportOnly) {
    const size = await measureDocument(page);
    if (size && size.height > options.maxFullPageHeight) {
      clip = { x: 0, y: 0, width: Math.max(1, Math.min(size.width, 8_000)), height: options.maxFullPageHeight };
      warnings.push(
        `The page is ${size.height.toLocaleString('en-US')} px tall; the capture was limited to the first ${options.maxFullPageHeight.toLocaleString('en-US')} px.`,
      );
    }
  }

  // A zoomed real window needs a corrected region, or the image comes out the wrong size (see planZoomCapture).
  const zoomPlan = await planForZoomedWindow(page, options);
  if (zoomPlan.kind === 'inexact') {
    // The zoom reported here is the one measured on the page, not the one that was asked for.
    warnings.push(
      `The browser is zoomed in to ${Math.round(zoomPlan.zoom * 100)} %. In a visible window the screenshot then comes out ` +
        `${Math.round((1 / zoomPlan.zoom) * 100)} % of the page's own size; use Headless mode for an exact image at this page scale.`,
    );
  }

  try {
    // A visible window always gets an explicit region of the measured page size. Left to itself, Playwright converts through
    // the screen's fractional pixel ratio and rounds down: on a 250 % display a 1513 x 3000 document came out 1512 x 2998 and
    // lost its last column and rows. With the region the image is exactly the page.
    const region = clip || options.headed ? await clipFor(page, viewportOnly, clip, zoomPlan) : undefined;
    const png = await raceAbort(
      page.screenshot({
        type: 'png',
        fullPage: !viewportOnly,
        ...(region ? { clip: region } : {}),
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
        timeout: SCREENSHOT_TIMEOUT_MS,
      }),
      options.signal,
    );
    const size = readPngSize(png);
    if (!size) return { ok: false, kind: 'screenshot', message: 'The browser returned an image that could not be read.' };
    return { ok: true, png, width: size.width, height: size.height };
  } catch (error) {
    if (isAbortedError(error)) throw error;
    const classified = classifyError(error);
    return {
      ok: false,
      kind: classified.kind === 'browser-closed' ? 'browser-closed' : 'screenshot',
      message: classified.kind === 'browser-closed' ? classified.message : `The screenshot failed: ${errorMessage(error).split('\n')[0]}`,
    };
  }
}

/**
 * How a visible (headed) window's screenshot must be corrected for the zoom the page is ACTUALLY at.
 *
 * The requested page scale is deliberately not used: Edge can apply another zoom than the one asked for (a zoom remembered for
 * the website wins over the default, and was seen to make a page 1910 px wide inside a 2386 px image). The window's width
 * (`outerWidth`) is in zoom-free units while the layout width (`innerWidth`) is in zoomed CSS pixels, so their ratio is the zoom
 * in force, whatever its cause. Measured: 1.005 at 100 %, 0.503 at 50 %, 2.010 at 200 %, 0.804 with a site zoom of 80 %.
 */
async function planForZoomedWindow(page: Page, options: CaptureOptions): Promise<ZoomCapturePlan> {
  if (!options.headed) return { kind: 'plain' };
  try {
    const sizes = await withDeadline(
      page.evaluate(() => ({ outer: window.outerWidth, inner: window.innerWidth, ratio: window.devicePixelRatio })),
      3_000,
      'Reading the page zoom',
    );
    if (!(sizes.outer > 0) || !(sizes.inner > 0)) return { kind: 'plain' };
    // outer/inner is the zoom within a percent or two (the window frame adds a few pixels), so it is only used to tell whether
    // the page is zoomed at all and to choose between the cases; the clip itself uses the exact value derived from the ratio.
    const measured = sizes.outer / sizes.inner;
    if (Math.abs(measured - 1) < 0.03) return { kind: 'plain' };
    // devicePixelRatio scales with the zoom, so the screen's own ratio is current / zoom. Take the zoom from the closest
    // standard Edge zoom step when one is near (Edge only offers fixed steps), otherwise from the measurement itself.
    const zoom = nearestStep(measured);
    return planZoomCapture({ layoutWidth: sizes.inner, layoutHeight: 0, currentRatio: sizes.ratio, nominalRatio: sizes.ratio / zoom });
  } catch {
    return { kind: 'plain' };
  }
}

/** Edge's own zoom steps (in percent), plus the finer steps a typed page scale can produce. */
const EDGE_ZOOM_STEPS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];

/** The zoom (as a factor) of the standard step closest to `measured`, when it lies within 2.5 % of one; else `measured`. */
function nearestStep(measured: number): number {
  let best = measured;
  let bestDistance = Infinity;
  for (const step of EDGE_ZOOM_STEPS) {
    const distance = Math.abs(measured - step / 100) / (step / 100);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = step / 100;
    }
  }
  return bestDistance <= 0.025 ? best : measured;
}

/** The region to capture: the page-sized area, shrunk by the zoom so the image lands on the page's own size. */
async function clipFor(
  page: Page,
  viewportOnly: boolean,
  limited: { x: number; y: number; width: number; height: number } | undefined,
  plan: ZoomCapturePlan,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const zoom = plan.kind === 'clip' ? plan.zoom : 1;
  const windowSize = () => page.evaluate(() => ({ width: innerWidth, height: innerHeight }));

  let size: { width: number; height: number };
  if (limited) {
    size = limited;
  } else if (viewportOnly) {
    size = await windowSize();
  } else {
    size = (await measureDocument(page)) ?? (await windowSize());
  }
  return { x: 0, y: 0, width: Math.max(1, size.width * zoom), height: Math.max(1, size.height * zoom) };
}

async function measureDocument(page: Page): Promise<{ width: number; height: number } | null> {
  try {
    return await withDeadline(
      page.evaluate(() => {
        const doc = document.documentElement;
        const body = document.body;
        // The content width: clientWidth leaves out the scrollbar that a taller-than-the-window page gets (15 px here), while
        // innerWidth includes it. A full-page image has no window scrollbar, and clipping to innerWidth was seen to give a
        // wrong-sized image (1512 x 2998 for a 1513 x 3000 page). A page wider than the window reports it in scrollWidth.
        return {
          width: Math.max(doc.scrollWidth, body?.scrollWidth ?? 0, doc.clientWidth || window.innerWidth),
          height: Math.max(doc.scrollHeight, body?.scrollHeight ?? 0, doc.clientHeight || window.innerHeight),
        };
      }),
      4_000,
      'Measuring the page',
    );
  } catch {
    return null;
  }
}

/** Scrolls down in steps, then back to the top. Bounded in both steps and time, and never throws (except for Stop). */
async function scrollThrough(page: Page, signal: AbortSignal): Promise<void> {
  const started = Date.now();
  const MAX_MS = 15_000;
  const MAX_STEPS = 40;
  try {
    let lastY = -1;
    for (let step = 0; step < MAX_STEPS && Date.now() - started < MAX_MS; step += 1) {
      throwIfAborted(signal);
      const y = await withDeadline(
        page.evaluate(() => {
          window.scrollBy(0, Math.max(400, Math.floor(window.innerHeight * 0.85)));
          return Math.round(window.scrollY);
        }),
        3_000,
        'Scrolling the page',
      );
      if (y === lastY) break; // reached the bottom (or the page cannot scroll)
      lastY = y;
      await sleep(120, signal);
    }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
    await sleep(250, signal);
  } catch (error) {
    if (isAbortedError(error)) throw error;
    // A page that blocks scripting is still captured, just without lazy content.
  }
}

/** Absolute http(s) links on the page, without fragments, duplicates, downloads or obvious non-page files. */
async function collectLinks(page: Page): Promise<string[]> {
  try {
    const hrefs = await withDeadline(
      page.evaluate((max) => {
        const out: string[] = [];
        for (const a of Array.from(document.querySelectorAll('a[href]'))) {
          if (out.length >= max * 3) break;
          if (a.hasAttribute('download')) continue;
          const href = (a as HTMLAnchorElement).href;
          if (typeof href === 'string') out.push(href);
        }
        return out;
      }, MAX_LINKS_PER_PAGE),
      4_000,
      'Collecting links',
    );
    const seen = new Set<string>();
    const links: string[] = [];
    for (const href of hrefs) {
      let url: URL;
      try {
        url = new URL(href);
      } catch {
        continue;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      url.hash = '';
      if (/\.(zip|rar|7z|exe|msi|dmg|iso|pdf|png|jpe?g|gif|webp|svg|mp[34]|avi|mov|docx?|xlsx?|pptx?|csv)(\?|$)/i.test(url.pathname)) continue;
      const clean = url.href;
      if (seen.has(clean)) continue;
      seen.add(clean);
      links.push(clean);
      if (links.length >= MAX_LINKS_PER_PAGE) break;
    }
    return links;
  } catch {
    return [];
  }
}
