import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { ApiError, errorMessage } from '../errors.js';
import type { Logger } from '../logger.js';
import { LIMITS, type BrowserMode } from '../shared/contract.js';
import { withDeadline } from '../util/abort.js';
import { isMissingBrowserError } from './edge.js';
import { NavigationGuard } from './nav-guard.js';
import { emulatedViewport, writeDefaultZoom } from './page-scale.js';
import { isProfileInUse } from './profiles.js';
import type { UrlPolicy } from './url-policy.js';

/** Prefix of the throw-away profile folders made for headed runs without a saved profile; only folders with it are ever deleted. */
const TEMP_PROFILE_PREFIX = 'ss3-edge-';

export interface SessionOptions {
  mode: BrowserMode;
  /**
   * Page size for headless runs, which have no window. Headed runs ignore it: their window is maximized and the page
   * fills the window (see `contextViewport`).
   */
  viewport: { width: number; height: number };
  /** Page scale in percent (the browser's zoom), applied when the browser opens; defaults to 100. */
  pageScalePercent?: number;
  /** Directory of a persistent profile, or null for a throw-away profile that is deleted when the browser closes. */
  profileDir: string | null;
  ignoreCertificateErrors: boolean;
  /** Explicit path to msedge.exe (EDGE_PATH). When null Playwright's "msedge" channel finds the installed browser. */
  executablePath: string | null;
  policy: UrlPolicy;
  logger: Logger;
  /** Called once if the browser disappears while the session is open (window closed by the user, crash, kill). */
  onUnexpectedClose?: () => void;
}

/**
 * Injected into every page before its own scripts run. Pages cannot open pop-up windows, which keeps the run on a single
 * tab. Real navigations (links, redirects) are unaffected.
 */
const BLOCK_POPUPS = `
  try {
    Object.defineProperty(window, 'open', { value: function () { return null; }, writable: false, configurable: false });
  } catch (e) { /* already defined */ }
`;

const LAUNCH_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--disable-features=msEdgeSignIn,msImplicitSignin,msEdgeSyncPromo',
];

/** Opens every window of a headed browser maximized. It also applies to a saved profile that remembers a smaller window. */
const MAXIMIZED_ARGS = ['--start-maximized'];

/**
 * What the page is laid out in.
 *
 * Headless has no window, so the requested size is used and the page scale is emulated (see page-scale.ts).
 *
 * Headed runs use the real window: `viewport: null` makes the page as large as the maximized window. (Emulating a fixed
 * viewport instead leaves the page at that size inside a maximized window, with empty space around it.) The page scale is
 * Edge's own zoom there, set through the profile. Playwright rejects a device scale factor together with `viewport: null`;
 * screenshots are taken in CSS pixels (`scale: 'css'`) on every screen.
 */
function contextViewport(options: Pick<SessionOptions, 'mode' | 'viewport' | 'pageScalePercent'>) {
  return options.mode === 'headed'
    ? { viewport: null }
    : emulatedViewport(options.viewport, options.pageScalePercent ?? LIMITS.pageScalePercent.default);
}

/**
 * Deletes a temporary profile folder made by this module. Refuses anything that is not such a folder, and retries because
 * Windows keeps files locked for a moment after the browser exits.
 */
async function removeTempProfile(dir: string | null): Promise<void> {
  if (dir === null) return;
  const resolved = path.resolve(dir);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(TEMP_PROFILE_PREFIX)) return;
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }).catch(() => undefined);
}

export class BrowserSession {
  private closing = false;
  private closed = false;

  private constructor(
    readonly context: BrowserContext,
    private readonly browser: Browser | null,
    readonly guard: NavigationGuard,
    private readonly options: SessionOptions,
    readonly version: string,
    /** A temporary profile folder to delete after the browser has closed, or null. */
    private readonly tempProfile: string | null,
  ) {}

  static async launch(options: SessionOptions): Promise<BrowserSession> {
    const guard = new NavigationGuard(options.policy, options.logger);
    const headless = options.mode === 'headless';
    const args = headless ? LAUNCH_ARGS : [...LAUNCH_ARGS, ...MAXIMIZED_ARGS];
    const scale = options.pageScalePercent ?? LIMITS.pageScalePercent.default;
    const base = {
      headless,
      args,
      ...contextViewport(options),
      serviceWorkers: 'block' as const,
      acceptDownloads: false,
      ignoreHTTPSErrors: options.ignoreCertificateErrors,
      ...(options.executablePath ? { executablePath: options.executablePath } : { channel: 'msedge' as const }),
      timeout: 30_000,
    };

    let context: BrowserContext;
    let browser: Browser | null = null;
    let tempProfile: string | null = null;
    try {
      // A headed window is zoomed through its profile, so a headed run always has a profile folder: the saved one, or a
      // temporary one that is removed again afterwards. Headless runs without a saved profile need none.
      let profileDir = options.profileDir;
      if (profileDir === null && !headless) {
        tempProfile = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_PROFILE_PREFIX));
        profileDir = tempProfile;
      }

      if (profileDir) {
        await fs.mkdir(profileDir, { recursive: true });
        if (await isProfileInUse(profileDir)) {
          throw new ApiError(
            409,
            'profile_in_use',
            'This browser profile is already open in another Edge window started by this tool. Close that window or choose another profile name.',
          );
        }
        // Both modes: a headed window is zoomed through the profile, and a zoom Edge remembered for a website would otherwise
        // also change a headless page (measured: layout 1600x900 under a 1280x720 image, so the image no longer matched). A
        // headless run is scaled by emulation, so its profile is written with 100 % and only its saved site zooms are removed.
        await writeDefaultZoom(profileDir, headless ? 100 : scale);
        context = await chromium.launchPersistentContext(profileDir, base);
        browser = context.browser();
      } else {
        browser = await chromium.launch({
          headless,
          args,
          timeout: 30_000,
          ...(options.executablePath ? { executablePath: options.executablePath } : { channel: 'msedge' as const }),
        });
        context = await browser.newContext({
          ...contextViewport(options),
          serviceWorkers: 'block',
          acceptDownloads: false,
          ignoreHTTPSErrors: options.ignoreCertificateErrors,
        });
      }
    } catch (error) {
      await removeTempProfile(tempProfile);
      if (error instanceof ApiError) throw error;
      const message = errorMessage(error);
      if (isMissingBrowserError(message)) {
        throw new ApiError(
          400,
          'edge_not_found',
          'Microsoft Edge was not found. Install Edge from https://www.microsoft.com/edge or set EDGE_PATH in service/.env.',
        );
      }
      options.logger.error('Browser launch failed', { error: message.split('\n')[0] });
      throw new ApiError(
        500,
        'browser_launch_failed',
        options.profileDir
          ? 'Microsoft Edge could not be started with this profile. If the profile is open in another window, close it and try again.'
          : 'Microsoft Edge could not be started. Close any stuck "msedge" windows started by this tool and try again.',
      );
    }

    const version = browser?.version() ?? 'unknown';
    const session = new BrowserSession(context, browser, guard, options, version, tempProfile);
    try {
      await session.prepare();
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }

  private async prepare(): Promise<void> {
    await this.context.addInitScript(BLOCK_POPUPS);
    this.context.on('page', (page) => {
      void this.adopt(page);
    });
    // The browser may have created its first tab already; guard it and close any extras so there is exactly one.
    const existing = this.context.pages();
    for (const page of existing) await this.adopt(page);
    if (this.options.mode === 'headed') await this.maximizeWindow(existing[0]);
    const disconnected = () => {
      if (this.closing || this.closed) return;
      this.closed = true;
      this.options.logger.warn('The browser closed unexpectedly');
      this.options.onUnexpectedClose?.();
    };
    if (this.browser) this.browser.on('disconnected', disconnected);
    else this.context.on('close', disconnected);
  }

  /**
   * Makes sure the headed window is maximized. `--start-maximized` normally does it; this covers a window that was restored
   * to a smaller size anyway. Cosmetic, so a failure is logged and the run carries on.
   */
  private async maximizeWindow(page: Page | undefined): Promise<void> {
    if (!page) return; // the first tab appears with the first newPage(); the launch flag already covers its window
    try {
      const session = await this.context.newCDPSession(page);
      try {
        const { windowId, bounds } = await session.send('Browser.getWindowForTarget');
        if (bounds.windowState !== 'maximized') {
          await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
        }
      } finally {
        await session.detach().catch(() => undefined);
      }
    } catch (error) {
      this.options.logger.warn('Could not maximize the browser window', { error: errorMessage(error) });
    }
  }

  /** Guards a page, dismisses its dialogs and closes pages that were not requested by us. */
  private async adopt(page: Page): Promise<void> {
    try {
      page.on('dialog', (dialog) => {
        dialog.dismiss().catch(() => undefined);
      });
      await this.guard.attach(this.context, page);
    } catch (error) {
      // Cannot guard this page, so it must not be used.
      this.options.logger.warn('Could not guard a browser tab; closing it', { error: errorMessage(error) });
      await page.close().catch(() => undefined);
    }
  }

  /** Creates the single working tab. Extra tabs opened later by pages are closed. */
  async newPage(): Promise<Page> {
    const reusable = this.context.pages().find((p) => !p.isClosed());
    const page = reusable ?? (await this.context.newPage());
    if (!reusable) await this.adopt(page);
    page.setDefaultTimeout(30_000);
    return page;
  }

  /** Closes every tab except `keep`: pop-ups and the download manager tab Edge opens for file downloads. */
  async closeOtherPages(keep: Page): Promise<number> {
    let closed = 0;
    for (const page of this.context.pages()) {
      if (page === keep || page.isClosed()) continue;
      await page.close().catch(() => undefined);
      closed += 1;
    }
    return closed;
  }

  get isOpen(): boolean {
    return !this.closing && !this.closed;
  }

  /** Closes the browser. Never throws and never waits longer than 10 seconds. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try {
      await withDeadline(
        (this.browser ?? this.context).close().catch(() => undefined),
        10_000,
        'Closing the browser',
      );
    } catch (error) {
      this.options.logger.warn('The browser did not close in time', { error: errorMessage(error) });
    } finally {
      this.closed = true;
    }
    // Only after the browser has let go of it.
    await removeTempProfile(this.tempProfile);
  }
}
