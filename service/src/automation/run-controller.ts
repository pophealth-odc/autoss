import { randomBytes } from 'node:crypto';
import type { Page } from 'playwright-core';
import { capturePage, type CaptureOptions, type CaptureResult } from '../browser/capture.js';
import { classifyError } from '../browser/classify-error.js';
import type { NavigationGuard } from '../browser/nav-guard.js';
import { profileDir } from '../browser/profiles.js';
import { BrowserSession, type SessionOptions } from '../browser/session.js';
import type { UrlPolicy } from '../browser/url-policy.js';
import type { ServiceConfig } from '../config.js';
import { ApiError, errorMessage } from '../errors.js';
import type { EventHub } from '../events/event-hub.js';
import type { Logger } from '../logger.js';
import {
  LIMITS,
  type AutomationSettings,
  type AutomationStatus,
  type PageErrorKind,
  type RunState,
  type RunStep,
} from '../shared/contract.js';
import type { GalleryStore } from '../storage/gallery-store.js';
import { AbortedError, isAbortedError, raceAbort, sleep, throwIfAborted, withDeadline } from '../util/abort.js';

/** What the run needs from a browser. BrowserSession implements it; tests substitute a fake. */
export interface RunSession {
  readonly version: string;
  readonly isOpen: boolean;
  readonly guard: NavigationGuard;
  newPage(): Promise<Page>;
  closeOtherPages(keep: Page): Promise<number>;
  close(): Promise<void>;
}

export interface RunControllerDeps {
  config: ServiceConfig;
  store: GalleryStore;
  hub: EventHub;
  policy: UrlPolicy;
  logger: Logger;
  launchSession?: (options: SessionOptions) => Promise<RunSession>;
  capture?: (page: Page, url: string, options: CaptureOptions) => Promise<CaptureResult>;
  /** How long a manual-login pause may last before the run is cancelled. */
  loginTimeoutMs?: number;
}

const STATE_PUBLISH_INTERVAL_MS = 150;
const CONSECUTIVE_STORAGE_FAILURES_LIMIT = 3;
/** Added to the page timeout + extra wait to bound everything else a capture does (idle wait, scrolling, screenshot). */
const PAGE_OVERHEAD_BUDGET_MS = 100_000;

type StopReason = 'user' | 'browser-closed' | 'login-timeout' | 'storage';

function keyOf(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.href;
}

function idleStatus(): AutomationStatus {
  return {
    state: 'idle',
    active: false,
    runId: null,
    startedAt: null,
    finishedAt: null,
    message: 'Ready.',
    settings: null,
    total: 0,
    completed: 0,
    succeeded: 0,
    failed: 0,
    percent: 0,
    currentUrl: null,
    currentStep: null,
    discovering: false,
    failures: [],
    browserVersion: null,
  };
}

/** Runs one screenshot job at a time and publishes its progress. */
export class RunController {
  private status: AutomationStatus = idleStatus();
  private abort: AbortController | null = null;
  private runPromise: Promise<void> | null = null;
  private loginGate: (() => void) | null = null;
  private stopReason: StopReason | null = null;
  private lastPublish = 0;
  private pendingPublish: NodeJS.Timeout | null = null;
  private queueLength = 0;

  private readonly launchSession: (options: SessionOptions) => Promise<RunSession>;
  private readonly capture: (page: Page, url: string, options: CaptureOptions) => Promise<CaptureResult>;
  private readonly loginTimeoutMs: number;

  constructor(private readonly deps: RunControllerDeps) {
    this.launchSession = deps.launchSession ?? ((options) => BrowserSession.launch(options));
    this.capture = deps.capture ?? capturePage;
    this.loginTimeoutMs = deps.loginTimeoutMs ?? 30 * 60 * 1000;
  }

  snapshot(): AutomationStatus {
    return { ...this.status, failures: [...this.status.failures] };
  }

  get isActive(): boolean {
    return this.status.active;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Public control surface
  // -------------------------------------------------------------------------------------------------------------

  /** Launches the browser and begins the run in the background. Resolves once the run is under way. */
  async start(settings: AutomationSettings): Promise<AutomationStatus> {
    if (this.status.active) {
      throw new ApiError(409, 'conflict', 'A run is already in progress. Stop it before starting another one.');
    }

    const abort = new AbortController();
    this.abort = abort;
    this.stopReason = null;
    this.loginGate = null;
    this.queueLength = settings.urls.length;
    const { urls, ...summary } = settings;
    this.status = {
      ...idleStatus(),
      state: 'starting',
      active: true,
      runId: randomBytes(6).toString('hex'),
      startedAt: new Date().toISOString(),
      message: 'Starting Microsoft Edge…',
      settings: { ...summary, urlCount: urls.length },
      total: urls.length,
      currentStep: 'launching',
    };
    this.publishState(true);

    let session: RunSession;
    try {
      session = await this.launchSession({
        mode: settings.mode,
        viewport: { width: settings.viewportWidth, height: settings.viewportHeight },
        pageScalePercent: settings.pageScalePercent,
        profileDir: settings.persistentProfile ? profileDir(this.deps.config.profilesDir, settings.profileName) : null,
        ignoreCertificateErrors: settings.ignoreCertificateErrors,
        executablePath: this.deps.config.edgePath,
        policy: this.deps.policy,
        logger: this.deps.logger,
        onUnexpectedClose: () => this.onBrowserLost(),
      });
    } catch (error) {
      this.finish('failed', error instanceof ApiError ? error.message : `Microsoft Edge could not be started: ${errorMessage(error)}`);
      throw error;
    }

    if (abort.signal.aborted) {
      await session.close();
      this.finish('stopped', 'Stopped before the browser finished starting.');
      throw new ApiError(409, 'conflict', 'The run was stopped while the browser was starting.');
    }

    this.status = {
      ...this.status,
      state: settings.manualLogin ? 'waiting-for-login' : 'running',
      browserVersion: session.version,
      message: settings.manualLogin ? 'Opening the first page…' : 'Running.',
      currentStep: null,
    };
    this.publishState(true);

    const run = this.execute(settings, session, abort);
    this.runPromise = run.catch(() => undefined);
    return this.snapshot();
  }

  /** Asks the run to stop. Screenshots that are already saved are kept; the page in progress is abandoned. */
  stop(): AutomationStatus {
    if (!this.status.active) {
      throw new ApiError(409, 'not_running', 'No run is in progress.');
    }
    if (this.status.state !== 'stopping') {
      this.stopReason ??= 'user';
      this.status = { ...this.status, state: 'stopping', message: 'Stopping…' };
      this.publishState(true);
      this.abort?.abort();
    }
    return this.snapshot();
  }

  /** Ends the manual-login pause so capturing starts. */
  continueRun(): AutomationStatus {
    if (this.status.state !== 'waiting-for-login' || this.loginGate === null) {
      throw new ApiError(409, 'not_running', 'The run is not waiting for you to sign in.');
    }
    const gate = this.loginGate;
    this.loginGate = null;
    gate();
    return this.snapshot();
  }

  /** Stops any run and waits (bounded) for the browser to close. Called when the service shuts down. */
  async shutdown(timeoutMs = 15_000): Promise<void> {
    if (this.status.active) {
      this.stopReason ??= 'user';
      this.abort?.abort();
    }
    if (this.runPromise) {
      await withDeadline(this.runPromise, timeoutMs, 'Waiting for the run to stop').catch(() => undefined);
    }
    if (this.pendingPublish) clearTimeout(this.pendingPublish);
  }

  // -------------------------------------------------------------------------------------------------------------
  // The run
  // -------------------------------------------------------------------------------------------------------------

  private async execute(settings: AutomationSettings, session: RunSession, abort: AbortController): Promise<void> {
    let unexpected: string | null = null;
    try {
      if (settings.manualLogin) await this.waitForLogin(settings, session, abort.signal);
      this.setState('running', 'Running.');
      await this.processQueue(settings, session, abort.signal);
    } catch (error) {
      if (!isAbortedError(error)) {
        this.deps.logger.error('The run ended because of an unexpected error', {
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        unexpected = errorMessage(error);
      }
    } finally {
      await session.close();
    }

    const { succeeded, failed } = this.status;
    const saved = `${succeeded} screenshot${succeeded === 1 ? '' : 's'} saved`;
    if (unexpected !== null) {
      this.finish('failed', `The run stopped because of an unexpected error: ${unexpected} (${saved}).`);
    } else if (this.stopReason === 'user') {
      this.finish('stopped', `Stopped. ${saved}.`);
    } else if (this.stopReason === 'browser-closed') {
      this.finish(
        settings.mode === 'headed' ? 'stopped' : 'failed',
        `The Edge window was closed, so the run ended early. ${saved}.`,
      );
    } else if (this.stopReason === 'login-timeout') {
      this.finish('stopped', 'Nobody pressed Continue within 30 minutes, so the run was cancelled.');
    } else if (this.stopReason === 'storage') {
      this.finish('failed', `Screenshots could not be saved, so the run was stopped. ${saved}.`);
    } else {
      this.finish('completed', `Finished. ${succeeded} captured, ${failed} failed.`);
    }
  }

  private async waitForLogin(settings: AutomationSettings, session: RunSession, signal: AbortSignal): Promise<void> {
    const first = settings.urls[0] as string;
    const verdict = await this.deps.policy.check(first);
    if (!verdict.allowed) {
      this.recordFailure(first, 'blocked', `Blocked: ${verdict.reason}`);
      this.stopReason = 'storage'; // unreachable seed: nothing sensible to sign in to
      this.status = { ...this.status, message: `The first address is blocked: ${verdict.reason}` };
      throw new AbortedError();
    }

    const page = await session.newPage();
    this.update({ currentUrl: first, currentStep: 'navigating' }, true);
    try {
      await page.goto(first, { waitUntil: 'domcontentloaded', timeout: settings.pageTimeoutMs });
    } catch {
      // The page may be slow or need a sign-in redirect; the person can still continue manually.
    }

    this.update(
      {
        state: 'waiting-for-login',
        currentStep: null,
        message: 'Sign in to the website in the Edge window, then press Continue.',
      },
      true,
    );

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stopReason ??= 'login-timeout';
        this.loginGate = null;
        reject(new AbortedError());
      }, this.loginTimeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.loginGate = null;
        reject(new AbortedError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.loginGate = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
    });
  }

  private async processQueue(settings: AutomationSettings, session: RunSession, signal: AbortSignal): Promise<void> {
    const queue: string[] = [...settings.urls];
    const known = new Set<string>(queue.map(keyOf));
    let storageFailures = 0;
    let page = await session.newPage();

    for (let index = 0; index < queue.length; index += 1) {
      throwIfAborted(signal);
      const url = queue[index] as string;
      this.queueLength = queue.length;
      this.update(
        {
          currentUrl: url,
          currentStep: 'navigating',
          total: queue.length,
          discovering: settings.followLinks && queue.length < settings.maxPages,
          message: `Capturing page ${this.status.completed + 1} of ${queue.length}`,
        },
        true,
      );

      const verdict = await this.deps.policy.check(url);
      if (!verdict.allowed) {
        this.recordFailure(url, 'blocked', `Blocked: ${verdict.reason}`);
        continue;
      }

      if (page.isClosed()) page = await this.freshPage(session);

      let result: CaptureResult;
      try {
        // Racing against the signal here (and not only inside capture) keeps Stop responsive whatever the capture is doing;
        // the browser is closed in execute()'s finally block, which cancels whatever is still in flight.
        result = await raceAbort(
          withDeadline(
            this.capture(page, url, {
              screenshotMode: settings.screenshotMode,
              pageTimeoutMs: settings.pageTimeoutMs,
              extraWaitMs: settings.extraWaitMs,
              autoScroll: settings.autoScroll,
              maxFullPageHeight: this.deps.config.maxFullPageHeight,
              pageScalePercent: settings.pageScalePercent,
              headed: settings.mode === 'headed',
              signal,
              guard: session.guard,
              onStep: (step: RunStep) => this.update({ currentStep: step }),
            }),
            settings.pageTimeoutMs + settings.extraWaitMs + PAGE_OVERHEAD_BUDGET_MS,
            'Capturing the page',
            () => page.close(),
          ),
          signal,
        );
      } catch (error) {
        if (isAbortedError(error)) throw error;
        const classified = classifyError(error);
        result = { ok: false, kind: classified.kind, message: classified.message };
      }

      await session.closeOtherPages(page).catch(() => undefined);

      if (!result.ok) {
        if (result.kind === 'browser-closed') {
          // Give the disconnect notification a moment to arrive, so a user closing the window is not reported as a failure.
          await sleep(500, signal).catch(() => undefined);
          throwIfAborted(signal);
        }
        this.recordFailure(url, result.kind, result.message);
        storageFailures = 0;
      } else {
        this.update({ currentStep: 'saving' }, true);
        try {
          const item = await this.deps.store.add({
            title: result.title,
            url,
            finalUrl: result.finalUrl,
            capturedAt: new Date(),
            screenshotMode: settings.screenshotMode,
            httpStatus: result.httpStatus,
            warnings: result.warnings,
            runId: this.status.runId ?? 'unknown',
            folder: settings.outputFolder,
            png: result.png,
            width: result.width,
            height: result.height,
          });
          storageFailures = 0;
          this.status = { ...this.status, succeeded: this.status.succeeded + 1, completed: this.status.completed + 1 };
          this.deps.hub.publish({ type: 'capture', data: item });
          known.add(keyOf(result.finalUrl));
          if (settings.followLinks) this.discover(queue, known, result.links, result.finalUrl, settings);
        } catch (error) {
          storageFailures += 1;
          const message = error instanceof ApiError ? error.message : errorMessage(error);
          this.recordFailure(url, 'storage', message);
          this.deps.logger.error('Saving a screenshot failed', { url, error: message });
          if (storageFailures >= CONSECUTIVE_STORAGE_FAILURES_LIMIT) {
            this.stopReason = 'storage';
            throw new AbortedError();
          }
        }
      }

      this.update({ total: queue.length, currentStep: null, percent: this.computePercent(queue.length) }, true);

      if (index + 1 < queue.length && settings.delayBetweenPagesMs > 0) {
        this.update({ currentStep: 'pausing' });
        await sleep(settings.delayBetweenPagesMs, signal);
      }
    }
  }

  private async freshPage(session: RunSession): Promise<Page> {
    try {
      return await session.newPage();
    } catch (error) {
      if (!session.isOpen) {
        this.stopReason ??= 'browser-closed';
        throw new AbortedError();
      }
      throw error;
    }
  }

  /** Adds links found on a page to the queue, within the page budget and the same-origin rule. */
  private discover(queue: string[], known: Set<string>, links: string[], pageUrl: string, settings: AutomationSettings): void {
    let origin: string;
    try {
      origin = new URL(pageUrl).origin;
    } catch {
      return;
    }
    for (const link of links) {
      if (queue.length >= settings.maxPages) break;
      let key: string;
      let linkOrigin: string;
      try {
        key = keyOf(link);
        linkOrigin = new URL(link).origin;
      } catch {
        continue;
      }
      if (known.has(key)) continue;
      // "Same origin" is judged against the page the link was found on, after redirects.
      if (settings.sameOrigin && linkOrigin !== origin) continue;
      // Links to private network addresses are skipped silently; the full check (including DNS) runs before capture.
      if (!this.deps.policy.checkSyntax(link).allowed) continue;
      known.add(key);
      // The queue holds the fragment-free form: "#section" links point into the page that was already captured.
      queue.push(key);
    }
    this.queueLength = queue.length;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Status bookkeeping
  // -------------------------------------------------------------------------------------------------------------

  private onBrowserLost(): void {
    if (!this.status.active) return;
    this.stopReason ??= 'browser-closed';
    this.abort?.abort();
    this.deps.hub.publish({
      type: 'notice',
      data: { level: 'warning', message: 'The browser was closed. The run is ending.' },
    });
  }

  private computePercent(total: number): number {
    if (total <= 0) return 0;
    return Math.min(100, Math.floor((this.status.completed / total) * 100));
  }

  private recordFailure(url: string, kind: PageErrorKind, message: string): void {
    const failures = [...this.status.failures, { url: url.slice(0, 300), kind, message: message.slice(0, 300), at: new Date().toISOString() }];
    if (failures.length > LIMITS.maxFailuresKept) failures.splice(0, failures.length - LIMITS.maxFailuresKept);
    this.status = {
      ...this.status,
      failed: this.status.failed + 1,
      completed: this.status.completed + 1,
      failures,
    };
    this.publishState(true);
  }

  private setState(state: RunState, message: string): void {
    this.update({ state, message }, true);
  }

  private update(patch: Partial<AutomationStatus>, immediate = false): void {
    if (!this.status.active) return;
    this.status = { ...this.status, ...patch };
    this.publishState(immediate);
  }

  private finish(state: Extract<RunState, 'completed' | 'stopped' | 'failed'>, message: string): void {
    const total = Math.max(this.status.total, this.queueLength);
    this.abort = null;
    this.loginGate = null;
    this.status = {
      ...this.status,
      state,
      active: false,
      message,
      finishedAt: new Date().toISOString(),
      currentUrl: null,
      currentStep: null,
      discovering: false,
      total,
      percent: state === 'completed' && total > 0 ? 100 : this.computePercent(total),
    };
    this.publishState(true);
  }

  /** State events are throttled so rapid step changes do not flood the event stream; milestones are sent at once. */
  private publishState(immediate: boolean): void {
    const emit = () => {
      this.pendingPublish = null;
      this.lastPublish = Date.now();
      this.deps.hub.publish({ type: 'state', data: this.snapshot() });
    };
    if (immediate) {
      if (this.pendingPublish) {
        clearTimeout(this.pendingPublish);
        this.pendingPublish = null;
      }
      emit();
      return;
    }
    if (this.pendingPublish) return;
    const wait = STATE_PUBLISH_INTERVAL_MS - (Date.now() - this.lastPublish);
    if (wait <= 0) {
      emit();
      return;
    }
    this.pendingPublish = setTimeout(emit, wait);
    this.pendingPublish.unref();
  }
}
