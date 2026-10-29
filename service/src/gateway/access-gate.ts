import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { tokensMatch } from '../http/auth.js';
import type { Logger } from '../logger.js';
import { sendText } from './respond.js';

/**
 * A sign-in wall for a service that is reachable from the internet (a Render web service), where the pairing token alone
 * would be the only protection.
 *
 * Until a visitor has signed in with the access password, the gateway answers nothing but the sign-in form. Strangers
 * therefore never reach the service, cannot probe it, and cannot use up its limit on wrong pairing tokens (which counts all
 * requests as coming from one address, because they all arrive through the gateway).
 *
 * The password is checked in constant time. A correct password is always accepted at once. Only WRONG attempts are slowed
 * down, and only a limited number are held open at a time, so guessing is slow and nobody can lock the owner out by
 * guessing: the owner's correct password does not wait behind anyone else's wrong ones.
 *
 * What this does NOT do: limit guesses per visitor. That needs the visitor's address, and behind a hosting platform's proxy
 * every request appears to come from the proxy, with no header documented as trustworthy. So the limit is shared: about
 * (held attempts / delay) wrong guesses per second in total, which makes the MINIMUM PASSWORD LENGTH the real defence. A
 * visitor who mistypes while someone else is guessing is told to wait a few seconds; they are never locked out.
 *
 * A session is a signed cookie (HMAC-SHA256 with a key derived from the password) that expires on its own; changing the
 * password signs everybody out. There is no server-side state, so a restart does not sign anyone out.
 */

export const GATE_LOGIN_PATH = '/__gate/login';
export const MIN_PASSWORD_LENGTH = 16;
export const MAX_PASSWORD_LENGTH = 200;

export const DEFAULT_SESSION_MS = 12 * 60 * 60 * 1000;
const DEFAULT_WRONG_DELAY_MS = 1_000;
const DEFAULT_MAX_PENDING_WRONG = 20;
const MAX_BODY_BYTES = 4_096;
const BODY_TIMEOUT_MS = 10_000;
const LOG_EVERY_MS = 60_000;
const COOKIE_VALUE = /^v1\.(\d{10,16})\.([A-Za-z0-9_-]{43})$/;

const WRONG_MESSAGE = 'That password is not correct.';
const BUSY_MESSAGE = 'Too many wrong attempts at the moment. Wait a few seconds and try again.';

/** Returns what is wrong with a password, or null when it is acceptable. Never repeats the password. */
export function validateAccessPassword(value: string): string | null {
  if (value.length < MIN_PASSWORD_LENGTH) return `The access password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  if (value.length > MAX_PASSWORD_LENGTH) return `The access password must be at most ${MAX_PASSWORD_LENGTH} characters long.`;
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'The access password must not contain control characters.';
  return null;
}

export interface AccessGateOptions {
  password: string;
  /** True when the public address is https: the cookie then gets "Secure" and the "__Host-" prefix (which the browser enforces). */
  secureCookie: boolean;
  logger: Logger;
  /** How long a sign-in lasts. */
  sessionMs?: number;
  /** How long a wrong password is held before it is answered. */
  wrongDelayMs?: number;
  /** How many wrong passwords may be held at once; more are turned away at once with 429. */
  maxPendingWrong?: number;
  now?: () => number;
}

class BodyError extends Error {
  constructor(readonly reason: 'too_large' | 'timeout' | 'aborted') {
    super(reason);
  }
}

/**
 * The value of one cookie. The header may be long: a browser sends every cookie it holds for the site, and refusing a long
 * header would sign out a visitor who simply has other cookies. Node already caps all headers together (16 KB by default), so
 * this only has to be careful, not small.
 */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

function readBody(req: IncomingMessage, limit: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => settle(() => reject(new BodyError('timeout'))), timeoutMs);
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) settle(() => reject(new BodyError('too_large')));
      else chunks.push(chunk);
    });
    req.on('end', () => settle(() => resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', () => settle(() => reject(new BodyError('aborted'))));
    req.on('close', () => settle(() => reject(new BodyError('aborted'))));
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function signInHtml(message: string | null): string {
  // `message` is always one of the fixed texts above, never anything the visitor typed.
  const note = message ? `\n      <p class="error" role="alert">${message}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta name="color-scheme" content="light dark">
  <title>Sign in - Screenshot Gallery</title>
  <style>
    :root { --bg: #f8fafc; --fg: #0f172a; --muted: #475569; --card: #ffffff; --line: #cbd5e1; --brand: #1d4ed8; --btn-fg: #ffffff; --err: #b91c1c; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #0b1220; --fg: #e2e8f0; --muted: #94a3b8; --card: #111a2e; --line: #334155; --brand: #60a5fa; --btn-fg: #0b1220; --err: #fca5a5; }
    }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
    main { box-sizing: border-box; width: min(24rem, calc(100vw - 2rem)); background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 1.5rem; }
    h1 { font-size: 1.25rem; margin: 0 0 0.25rem; }
    p { margin: 0.25rem 0 1rem; color: var(--muted); font-size: 0.9rem; }
    p.error { color: var(--err); font-weight: 600; }
    label { display: block; font-weight: 600; margin-bottom: 0.25rem; }
    input { box-sizing: border-box; width: 100%; padding: 0.6rem 0.75rem; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; font: inherit; }
    button { margin-top: 1rem; width: 100%; padding: 0.65rem; border: 0; border-radius: 8px; background: var(--brand); color: var(--btn-fg); font: inherit; font-weight: 600; cursor: pointer; }
    :focus-visible { outline: 3px solid var(--brand); outline-offset: 2px; }
  </style>
</head>
<body>
  <main>
    <h1>Screenshot Gallery</h1>
    <p>Enter the access password for this site. It is the <code>GATEWAY_ACCESS_PASSWORD</code> setting of the deployment.</p>${note}
    <form method="post" action="${GATE_LOGIN_PATH}">
      <label for="password">Access password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required maxlength="${MAX_PASSWORD_LENGTH}" autofocus>
      <button type="submit">Sign in</button>
    </form>
  </main>
</body>
</html>
`;
}

export class AccessGate {
  readonly cookieName: string;
  private readonly key: Buffer;
  private readonly sessionMs: number;
  private readonly wrongDelayMs: number;
  private readonly maxPendingWrong: number;
  private pendingWrong = 0;
  private lastLoggedAt = Number.NEGATIVE_INFINITY;
  private wrongSinceLog = 0;

  constructor(private readonly options: AccessGateOptions) {
    const problem = validateAccessPassword(options.password);
    if (problem) throw new Error(problem);
    this.key = createHmac('sha256', options.password).update('ssg-gate-session-key-v1').digest();
    this.cookieName = options.secureCookie ? '__Host-ssg_gate' : 'ssg_gate';
    this.sessionMs = options.sessionMs ?? DEFAULT_SESSION_MS;
    this.wrongDelayMs = options.wrongDelayMs ?? DEFAULT_WRONG_DELAY_MS;
    this.maxPendingWrong = options.maxPendingWrong ?? DEFAULT_MAX_PENDING_WRONG;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private sign(expiry: number): string {
    return createHmac('sha256', this.key).update(`v1.${expiry}`).digest('base64url');
  }

  /** The `Set-Cookie` value for a sign-in that starts now. */
  sessionCookie(): string {
    const expiry = this.now() + this.sessionMs;
    // SameSite=Lax (not Strict) so that following a link to the site, for example from the hosting dashboard, keeps the sign-in.
    // Lax still withholds the cookie from every cross-site request except a plain top-level GET, and the API needs the
    // pairing token on top of it.
    return `${this.cookieName}=v1.${expiry}.${this.sign(expiry)}; Path=/; HttpOnly; SameSite=Lax${this.options.secureCookie ? '; Secure' : ''}`;
  }

  /** Expiry (ms since 1970) of the session in the request's cookie, or null when there is no valid, current session. */
  private expiryOf(req: IncomingMessage): number | null {
    const raw = readCookie(req.headers.cookie, this.cookieName);
    const match = raw === null ? null : COOKIE_VALUE.exec(raw);
    if (!match) return null;
    const expiry = Number(match[1]);
    const given = Buffer.from(match[2] as string, 'utf8');
    const wanted = Buffer.from(this.sign(expiry), 'utf8');
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
    const now = this.now();
    // A value further ahead than any sign-in could have produced is not ours, whatever its signature says.
    if (expiry <= now || expiry > now + this.sessionMs + 60_000) return null;
    return expiry;
  }

  isSignedIn(req: IncomingMessage): boolean {
    return this.expiryOf(req) !== null;
  }

  /** A fresh cookie when the current session is valid but more than half used, so an open page stays signed in. */
  renewal(req: IncomingMessage): string | null {
    const expiry = this.expiryOf(req);
    if (expiry === null) return null;
    return expiry - this.now() < this.sessionMs / 2 ? this.sessionCookie() : null;
  }

  sendSignInPage(res: ServerResponse, status = 200, message: string | null = null, headOnly = false, extra: OutgoingHttpHeaders = {}): void {
    if (res.destroyed) return;
    const body = Buffer.from(signInHtml(message), 'utf8');
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      // No script of any kind: the page is a plain form. Nothing else may be loaded, framed or posted to.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      // NOT "no-referrer": that makes the browser send "Origin: null" with a form post, which the gateway (rightly) refuses as
      // coming from nowhere, so nobody could sign in. "same-origin" sends the real origin to this site and nothing to any other.
      'Referrer-Policy': 'same-origin',
      ...extra,
    });
    res.end(headOnly ? undefined : body);
  }

  private noteWrong(): void {
    this.wrongSinceLog += 1;
    const now = this.now();
    if (now - this.lastLoggedAt < LOG_EVERY_MS) return;
    this.options.logger.warn('Wrong access password', { attemptsSinceLastMessage: this.wrongSinceLog });
    this.lastLoggedAt = now;
    this.wrongSinceLog = 0;
  }

  /** POST /__gate/login with `password=...` as a form. */
  async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET' || req.method === 'HEAD') {
      this.sendSignInPage(res, 200, null, req.method === 'HEAD');
      return;
    }
    if (req.method !== 'POST') {
      sendText(res, 405, 'Use the sign-in form.', { Allow: 'GET, HEAD, POST' });
      return;
    }
    const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/x-www-form-urlencoded') {
      sendText(res, 415, 'Use the sign-in form.');
      return;
    }

    let body: string;
    try {
      body = await readBody(req, MAX_BODY_BYTES, BODY_TIMEOUT_MS);
    } catch (error) {
      const reason = error instanceof BodyError ? error.reason : 'aborted';
      sendText(res, reason === 'too_large' ? 413 : 408, reason === 'too_large' ? 'That request is too large.' : 'The request took too long.', { Connection: 'close' });
      res.once('finish', () => req.destroy());
      return;
    }

    const supplied = new URLSearchParams(body).get('password') ?? '';
    if (supplied.length > 0 && supplied.length <= MAX_PASSWORD_LENGTH && tokensMatch(this.options.password, supplied)) {
      res.writeHead(303, { Location: '/', 'Set-Cookie': this.sessionCookie(), 'Cache-Control': 'no-store', 'Content-Length': 0, 'Referrer-Policy': 'no-referrer' });
      res.end();
      return;
    }

    this.noteWrong();
    if (this.pendingWrong >= this.maxPendingWrong) {
      this.sendSignInPage(res, 429, BUSY_MESSAGE, false, { 'Retry-After': '2' });
      return;
    }
    this.pendingWrong += 1;
    try {
      await sleep(this.wrongDelayMs);
    } finally {
      this.pendingWrong -= 1;
    }
    this.sendSignInPage(res, 401, WRONG_MESSAGE);
  }
}
