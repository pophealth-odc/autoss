import type { RequestHandler } from 'express';
import { ApiError } from '../errors.js';

export interface OriginHostOptions {
  port: number;
  allowedOrigins: readonly string[];
  allowLocalhostOrigins: boolean;
  /** Extra Host header values to accept (tests use the ephemeral listening port). */
  extraHosts?: readonly string[];
}

const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** Origins of pages served from this computer: http://localhost:5173, http://127.0.0.1:4173, http://[::1]:3000 ... */
export function isLocalhostOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return LOOPBACK_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

export function isOriginAllowed(origin: string, options: Pick<OriginHostOptions, 'allowedOrigins' | 'allowLocalhostOrigins'>): boolean {
  if (origin.length > 300 || origin === 'null') return false;
  if (options.allowedOrigins.includes(origin)) return true;
  return options.allowLocalhostOrigins && isLocalhostOrigin(origin);
}

/**
 * Rejects requests whose Host header is not this computer. A DNS-rebinding page (evil.example resolving to 127.0.0.1) sends
 * its own name in Host, so it is refused even though the TCP connection reaches the service.
 */
export function hostGuard(options: OriginHostOptions): RequestHandler {
  const allowed = new Set<string>([
    `127.0.0.1:${options.port}`,
    `localhost:${options.port}`,
    `[::1]:${options.port}`,
    ...(options.extraHosts ?? []).map((h) => h.toLowerCase()),
  ]);
  return (req, _res, next) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!allowed.has(host)) {
      next(new ApiError(421, 'bad_host', 'This service only answers requests addressed to localhost or 127.0.0.1.'));
      return;
    }
    next();
  };
}

const ALLOWED_METHODS = 'GET, POST, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Authorization, Content-Type, Last-Event-ID';
const EXPOSED_HEADERS = 'Content-Disposition, Content-Length, Retry-After, X-Request-Id';

/**
 * CORS with an exact allow-list. Pages from other origins get no CORS headers (the browser then blocks the response) and a
 * 403 so the cause is visible in the network log. Requests without an Origin header (curl, same-origin) pass through and still
 * need the token. Preflight requests never need the token.
 */
export function corsPolicy(options: OriginHostOptions): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    res.vary('Origin');

    if (origin === undefined) {
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      next();
      return;
    }

    if (!isOriginAllowed(origin, options)) {
      next(
        new ApiError(
          403,
          'origin_not_allowed',
          `The website ${origin.slice(0, 120)} is not allowed to use this service. Add it to ALLOWED_ORIGINS in service/.env and restart the service.`,
        ),
      );
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      res.setHeader('Access-Control-Max-Age', '600');
      // Chrome/Edge ask for this when a public https page calls a loopback address (Private Network Access).
      if (req.headers['access-control-request-private-network'] === 'true') {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
      res.status(204).end();
      return;
    }
    next();
  };
}
