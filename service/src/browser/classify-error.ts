import { isAbortedError } from '../util/abort.js';
import { DeadlineError } from '../util/abort.js';
import type { PageErrorKind } from '../shared/contract.js';

export interface ClassifiedError {
  kind: PageErrorKind;
  /** Plain-language explanation that can be shown to the user. */
  message: string;
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? text).trim();
}

/** Chromium network error codes ("net::ERR_NAME_NOT_RESOLVED") mapped to a category. */
const NET_ERRORS: Array<[RegExp, ClassifiedError]> = [
  [/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/, { kind: 'dns', message: 'The web address could not be found (DNS lookup failed). Check the spelling and your internet connection.' }],
  [/ERR_CONNECTION_REFUSED/, { kind: 'connection', message: 'The server refused the connection.' }],
  [/ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE/, { kind: 'connection', message: 'The connection was closed by the server before a page was received.' }],
  [/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/, { kind: 'timeout', message: 'The server did not respond in time.' }],
  [/ERR_ADDRESS_UNREACHABLE|ERR_NETWORK_UNREACHABLE|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NETWORK_ACCESS_DENIED/, { kind: 'connection', message: 'The server could not be reached. Check your network connection.' }],
  [/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED/, { kind: 'connection', message: 'Connecting through the proxy server failed.' }],
  [/ERR_CERT_|ERR_SSL_|ERR_BAD_SSL/, { kind: 'certificate', message: 'The site has a certificate or secure-connection problem. Enable "Ignore certificate errors" only for sites you trust.' }],
  [/ERR_INVALID_AUTH_CREDENTIALS|ERR_UNEXPECTED_PROXY_AUTH|ERR_MISSING_AUTH_CREDENTIALS/, { kind: 'auth-required', message: 'The site asks for a user name and password. Run in headed mode with a saved profile and sign in manually.' }],
  [/ERR_TOO_MANY_REDIRECTS/, { kind: 'navigation', message: 'The page redirects in a loop.' }],
  [/ERR_UNSAFE_REDIRECT|ERR_UNSAFE_PORT|ERR_DISALLOWED_URL_SCHEME/, { kind: 'blocked', message: 'The page redirected to an address that is not allowed.' }],
  [/ERR_INVALID_URL/, { kind: 'invalid-url', message: 'The web address is not valid.' }],
  [/ERR_BLOCKED_BY_CLIENT/, { kind: 'blocked', message: 'The address is blocked by the safety policy.' }],
  [/ERR_FILE_NOT_FOUND|ERR_ACCESS_DENIED/, { kind: 'blocked', message: 'This address cannot be opened.' }],
];

/** Turns a Playwright / Chromium / internal error into a category plus a message a person can act on. */
export function classifyError(error: unknown): ClassifiedError {
  if (isAbortedError(error)) return { kind: 'aborted', message: 'Stopped by the user.' };
  if (error instanceof DeadlineError) return { kind: 'timeout', message: error.message };

  const raw = error instanceof Error ? error.message : String(error);
  const line = firstLine(raw);

  if (/Target (page, context or browser )?(has been )?closed|Browser has been closed|browser has disconnected|Connection closed|Target crashed|Page crashed/i.test(raw)) {
    return { kind: 'browser-closed', message: 'The browser was closed or crashed.' };
  }
  if (/Download is starting/i.test(raw)) {
    return { kind: 'download', message: 'The address downloads a file instead of showing a page, so there is nothing to capture.' };
  }
  if (/Timeout \d+ms exceeded/i.test(raw) && /goto|navigat|waitForLoadState|load state/i.test(raw)) {
    return { kind: 'timeout', message: 'The page did not finish loading in time. Raise the page load timeout if the site is slow.' };
  }
  if (/Timeout \d+ms exceeded/i.test(raw) && /screenshot/i.test(raw)) {
    return { kind: 'screenshot', message: 'The screenshot could not be taken in time. The page may be too large or unresponsive.' };
  }
  for (const [pattern, result] of NET_ERRORS) {
    if (pattern.test(raw)) return result;
  }
  if (/ERR_ABORTED/.test(raw)) {
    return { kind: 'navigation', message: 'The navigation was cancelled. The address may return no content (HTTP 204) or be opened by another handler.' };
  }
  if (/Timeout \d+ms exceeded/i.test(raw)) {
    return { kind: 'timeout', message: 'The operation timed out.' };
  }
  if (/screenshot/i.test(raw)) {
    return { kind: 'screenshot', message: `The screenshot failed: ${line}` };
  }
  const net = /net::(ERR_[A-Z0-9_]+)/.exec(raw);
  if (net) return { kind: 'navigation', message: `The page could not be loaded (${net[1]}).` };
  return { kind: 'unknown', message: line.slice(0, 300) || 'An unexpected error occurred.' };
}
