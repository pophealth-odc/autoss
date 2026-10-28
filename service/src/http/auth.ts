import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RequestHandler } from 'express';
import type { Logger } from '../logger.js';
import { ApiError, errnoCode } from '../errors.js';

const execFileAsync = promisify(execFile);

const TOKEN_FILE = 'pairing-token.txt';
const TOKEN_PATTERN = /^[A-Za-z0-9_\-.~+/=]{24,200}$/;

export interface PairingToken {
  value: string;
  /** Where the token was loaded from (shown in the start-up banner). */
  source: 'environment' | 'file' | 'generated';
  file: string | null;
}

/**
 * Returns the pairing token. A PAIRING_TOKEN from the environment wins; otherwise a random token is generated once and
 * stored in the data directory so the browser stays paired across restarts.
 */
export async function loadOrCreateToken(dataDir: string, fromEnv: string | null, logger: Logger): Promise<PairingToken> {
  if (fromEnv) return { value: fromEnv, source: 'environment', file: null };

  const file = path.join(dataDir, TOKEN_FILE);
  try {
    const existing = (await fs.readFile(file, 'utf8')).trim();
    if (TOKEN_PATTERN.test(existing)) return { value: existing, source: 'file', file };
    logger.warn('The stored pairing token is malformed; a new one is generated.');
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') throw error;
  }

  const value = randomBytes(32).toString('base64url');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(file, `${value}\n`, { encoding: 'utf8', mode: 0o600 });
  await restrictToCurrentUser(file, logger);
  return { value, source: 'generated', file };
}

/** Node ignores POSIX mode bits on Windows, so remove inherited permissions with icacls (best effort). */
async function restrictToCurrentUser(file: string, logger: Logger): Promise<void> {
  if (process.platform !== 'win32') return;
  const user = process.env['USERNAME'];
  if (!user) return;
  try {
    await execFileAsync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { windowsHide: true, timeout: 10_000 });
  } catch {
    logger.debug('Could not restrict the permissions of the pairing token file.');
  }
}

/** Constant-time comparison that also hides the length of the secret. */
export function tokensMatch(expected: string, provided: string): boolean {
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(provided).digest();
  return timingSafeEqual(a, b);
}

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S{1,512})$/i.exec(header.trim());
  return match ? (match[1] as string) : null;
}

/** Counts failed attempts per client address in a sliding window. */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds the client must wait, or 0 if it may try. */
  retryAfterSeconds(key: string): number {
    const list = this.prune(key);
    if (list.length < this.maxFailures) return 0;
    const oldest = list[0] as number;
    return Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1000));
  }

  recordFailure(key: string): void {
    const list = this.prune(key);
    list.push(this.now());
    this.failures.set(key, list);
    if (this.failures.size > 1_000) {
      for (const k of this.failures.keys()) {
        if (this.prune(k).length === 0) this.failures.delete(k);
      }
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  private prune(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) this.failures.delete(key);
    else this.failures.set(key, list);
    return list;
  }
}

export interface AuthOptions {
  token: string;
  limiter?: FailureLimiter;
  logger: Logger;
}

/** Requires `Authorization: Bearer <pairing token>`. Repeated failures from one address are slowed down with HTTP 429. */
export function requireAuth(options: AuthOptions): RequestHandler {
  const limiter = options.limiter ?? new FailureLimiter();
  return (req, res, next) => {
    const client = req.socket.remoteAddress ?? 'unknown';
    const wait = limiter.retryAfterSeconds(client);
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait));
      next(new ApiError(429, 'rate_limited', `Too many failed attempts. Try again in ${wait} seconds.`));
      return;
    }

    const provided = extractBearer(req.headers.authorization);
    if (provided === null || !tokensMatch(options.token, provided)) {
      limiter.recordFailure(client);
      if (provided === null) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="screenshot-gallery-service"');
        next(new ApiError(401, 'unauthorized', 'A pairing token is required. Open Settings and enter the token shown in the service window.'));
      } else {
        options.logger.warn('Rejected a request with a wrong pairing token', { path: req.path });
        next(new ApiError(401, 'unauthorized', 'The pairing token is not correct. Copy it again from the service window.'));
      }
      return;
    }
    limiter.reset(client);
    next();
  };
}
