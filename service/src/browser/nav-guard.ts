import type { BrowserContext, CDPSession, Page } from 'playwright-core';
import type { Logger } from '../logger.js';
import { errorMessage } from '../errors.js';
import type { PolicyVerdict, UrlPolicy } from './url-policy.js';

export interface BlockedNavigation {
  url: string;
  reason: string;
}

/** Schemes that never touch the network; they are allowed so about:blank, data: and blob: frames keep working. */
const LOCAL_SCHEMES = new Set(['about:', 'data:', 'blob:']);

/**
 * Checks every document request a page makes (the page itself, each redirect hop, and frames inside it) against the
 * URL policy, and refuses the ones that are not allowed.
 *
 * Playwright's own `context.route()` cannot do this: it does not see redirect hops, so a public page could redirect
 * the browser to an internal address. The DevTools `Fetch` domain pauses each hop before it is sent.
 *
 * Every handler here swallows its own errors. An exception inside a browser event handler would otherwise terminate the
 * whole service process.
 */
export class NavigationGuard {
  private readonly blockedByPage = new WeakMap<Page, BlockedNavigation[]>();

  constructor(
    private readonly policy: UrlPolicy,
    private readonly logger: Logger,
  ) {}

  /** Installs the guard on a page. Call it for every page of the context, including pop-ups. */
  async attach(context: BrowserContext, page: Page): Promise<void> {
    const blocked: BlockedNavigation[] = [];
    this.blockedByPage.set(page, blocked);
    const session = await context.newCDPSession(page);
    session.on('Fetch.requestPaused', (event) => {
      void this.handle(session, event.requestId, event.request.url, blocked);
    });
    await session.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
    });
  }

  /** Navigations of this page that were refused, oldest first. */
  blockedFor(page: Page): readonly BlockedNavigation[] {
    return this.blockedByPage.get(page) ?? [];
  }

  private async verdictFor(url: string): Promise<PolicyVerdict> {
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      return { allowed: false, reason: 'The address could not be parsed.' };
    }
    if (LOCAL_SCHEMES.has(protocol)) return { allowed: true };
    if (protocol !== 'http:' && protocol !== 'https:') {
      return { allowed: false, reason: `Addresses starting with ${protocol} are not allowed.` };
    }
    try {
      return await this.policy.check(url);
    } catch (error) {
      // Fail closed: when the check itself breaks, nothing is let through.
      return { allowed: false, reason: `The address could not be verified (${errorMessage(error)}).` };
    }
  }

  private async handle(session: CDPSession, requestId: string, url: string, blocked: BlockedNavigation[]): Promise<void> {
    try {
      const verdict = await this.verdictFor(url);
      if (verdict.allowed) {
        await session.send('Fetch.continueRequest', { requestId });
        return;
      }
      if (blocked.length < 20) blocked.push({ url, reason: verdict.reason });
      this.logger.warn('Blocked navigation', { url: url.slice(0, 200), reason: verdict.reason });
      await session.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    } catch {
      // The page or request is already gone (closed tab, cancelled navigation). Nothing left to answer.
    }
  }
}
