import path from 'node:path';
import type { Page } from 'playwright-core';
import { RunController, type RunSession } from '../../src/automation/run-controller.js';
import type { CaptureOptions, CaptureResult } from '../../src/browser/capture.js';
import type { NavigationGuard } from '../../src/browser/nav-guard.js';
import type { SessionOptions } from '../../src/browser/session.js';
import { loadConfig, type ServiceConfig } from '../../src/config.js';
import { silentLogger } from '../../src/logger.js';
import { startService, type RunningService } from '../../src/server.js';
import { makePng, makeTempDir } from './tmp.js';

export const TEST_TOKEN = 'test-token-0123456789abcdef-0123456789';
export const TEST_PAGES_ORIGIN = 'https://tester.github.io';

export interface TestService {
  service: RunningService;
  base: string;
  config: ServiceConfig;
  dir: string;
  /** fetch() with the Authorization header and a Host-matching URL. */
  api(pathname: string, init?: RequestInit): Promise<Response>;
  cleanup(): Promise<void>;
}

export interface FakeBrowser {
  launched: SessionOptions[];
  closed: number;
  pages: string[];
  launchSession: (options: SessionOptions) => Promise<RunSession>;
  capture: (page: Page, url: string, options: CaptureOptions) => Promise<CaptureResult>;
  /** Controls what the fake capture returns for a URL. Defaults to a successful 40x30 capture. */
  behave: (url: string) => Promise<CaptureResult> | CaptureResult | undefined;
  failLaunchWith?: Error;
  /** Called at the beginning of each capture; tests use it to block a capture until released. */
  gate?: (url: string, signal: AbortSignal) => Promise<void>;
  triggerBrowserLoss(): void;
}

/** Resolves when the signal aborts - immediately if it already has (an `abort` listener added late would never fire). */
export function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

export function okCapture(url: string, extra: Partial<Extract<CaptureResult, { ok: true }>> = {}): CaptureResult {
  return {
    ok: true,
    png: makePng(40, 30),
    width: 40,
    height: 30,
    title: `Title of ${new URL(url).pathname}`,
    finalUrl: url,
    httpStatus: 200,
    warnings: [],
    links: [],
    ...extra,
  };
}

export function createFakeBrowser(): FakeBrowser {
  let onLost: (() => void) | undefined;
  const fake: FakeBrowser = {
    launched: [],
    closed: 0,
    pages: [],
    behave: () => undefined,
    triggerBrowserLoss: () => onLost?.(),
    launchSession: async (options) => {
      if (fake.failLaunchWith) throw fake.failLaunchWith;
      fake.launched.push(options);
      onLost = options.onUnexpectedClose;
      let open = true;
      const page = { isClosed: () => !open, close: async () => undefined } as unknown as Page;
      const guard = { blockedFor: () => [], attach: async () => undefined } as unknown as NavigationGuard;
      return {
        version: '155.0.0.0-fake',
        get isOpen() {
          return open;
        },
        guard,
        newPage: async () => page,
        closeOtherPages: async () => 0,
        close: async () => {
          open = false;
          fake.closed += 1;
        },
      };
    },
    capture: async (_page, url, options) => {
      fake.pages.push(url);
      options.onStep?.('capturing');
      if (fake.gate) await fake.gate(url, options.signal);
      if (options.signal.aborted) throw new DOMException('aborted', 'AbortError');
      return (await fake.behave(url)) ?? okCapture(url);
    },
  };
  return fake;
}

export async function startTestService(
  options: { env?: Record<string, string>; fake?: FakeBrowser; realBrowser?: boolean } = {},
): Promise<TestService & { fake: FakeBrowser }> {
  const tmp = await makeTempDir('ss3-svc-');
  const fake = options.fake ?? createFakeBrowser();
  const config = loadConfig(
    {
      PORT: '0',
      DATA_DIR: path.join(tmp.dir, 'data'),
      SCREENSHOTS_DIR: path.join(tmp.dir, 'screenshots'),
      ALLOWED_ORIGINS: TEST_PAGES_ORIGIN,
      ALLOW_PRIVATE_TARGETS: 'true',
      LOG_LEVEL: 'silent',
      ...options.env,
    },
    tmp.dir,
    '0.0.0-test',
  );
  const service = await startService({
    config,
    logger: silentLogger,
    token: { value: TEST_TOKEN, source: 'environment', file: null },
    // With realBrowser the controller launches Microsoft Edge itself; otherwise a scripted fake stands in for it.
    runs: (deps) =>
      options.realBrowser
        ? new RunController(deps)
        : new RunController({ ...deps, launchSession: fake.launchSession, capture: fake.capture, loginTimeoutMs: 2_000 }),
  });
  const base = `http://127.0.0.1:${service.port}`;
  return {
    service,
    base,
    config,
    dir: tmp.dir,
    fake,
    api: (pathname, init = {}) =>
      fetch(`${base}${pathname}`, {
        ...init,
        headers: { Authorization: `Bearer ${TEST_TOKEN}`, ...(init.headers as Record<string, string> | undefined) },
      }),
    cleanup: async () => {
      await service.stop();
      await tmp.cleanup();
    },
  };
}

export async function waitFor<T>(probe: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 5_000, label = 'condition'): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
