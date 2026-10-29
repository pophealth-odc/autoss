import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type RequestListener,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { ConfigError } from '../config.js';
import { isLocalhostOrigin } from '../http/origin-host.js';
import type { Logger } from '../logger.js';
import { AccessGate, GATE_LOGIN_PATH, validateAccessPassword } from './access-gate.js';
import { sendError, sendText } from './respond.js';

/**
 * One address for the web page AND the service, for places where the browser cannot reach 127.0.0.1 (GitHub Codespaces,
 * Render).
 *
 * It serves the built web page and passes everything under /api to the service, which keeps listening on this computer
 * only and keeps all of its own checks. The page and its API share one origin, so the browser never makes a cross-site
 * request (a forwarded private port cannot answer those: the browser's pre-flight request carries no sign-in).
 *
 * The service refuses any Host header but its own, and any Origin that is not allow-listed. This gateway therefore makes
 * the request look like what the service expects (Host 127.0.0.1, no Origin) AFTER doing the equivalent check itself.
 * The pairing token is still required for every call except /api/health.
 *
 * On a public address (Render) the gateway listens on every interface and an ACCESS PASSWORD is mandatory: nothing but the
 * sign-in page and /healthz is answered until a visitor has signed in (see access-gate.ts).
 */

export const DEFAULT_GATEWAY_PORT = 4580;
/** Path a hosting platform may poll without signing in. It says only that the process is up. */
export const HEALTH_PATH = '/healthz';

export interface HostPolicy {
  /** Host names accepted in addition to localhost, 127.0.0.1 and [::1] (names only: no port, no scheme). */
  allowedHosts?: readonly string[];
}

export interface GatewayOptions extends HostPolicy {
  /** Port of the service, which listens on 127.0.0.1. */
  upstreamPort: number;
  /** Folder with the built web page (index.html, assets/...). */
  webRoot: string;
  logger: Logger;
  /** When set, nothing but the sign-in page and HEALTH_PATH is answered before the visitor has signed in. */
  gate?: AccessGate;
}

/** Describes one connection, not the message, so a proxy must not pass it on (RFC 9110, section 7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const API_METHODS = ['GET', 'HEAD', 'POST', 'DELETE'];
const STATIC_METHODS = ['GET', 'HEAD'];

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

// ---------------------------------------------------------------------------------------------------------------------
// Which hosts and origins are acceptable
// ---------------------------------------------------------------------------------------------------------------------

/** True for this computer's own names and the exact names in `allowedHosts`. There are no wildcards. */
export function isHostnameAllowed(hostname: string, policy: HostPolicy): boolean {
  const name = hostname.toLowerCase();
  if (isLocalhostOrigin(`http://${name}`)) return true;
  return policy.allowedHosts?.some((host) => host.toLowerCase() === name) ?? false;
}

function hostnameFromHostHeader(value: string | undefined): string | null {
  if (value === undefined || value === '' || value.length > 300 || /[\s/\\@?#]/.test(value)) return null;
  try {
    return new URL(`http://${value}`).hostname;
  } catch {
    return null;
  }
}

function hostnameFromOrigin(value: string): string | null {
  if (value.length > 300 || value === 'null') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Settings taken from the environment
// ---------------------------------------------------------------------------------------------------------------------

export interface GatewaySettings {
  port: number;
  /** '127.0.0.1' (default), or '0.0.0.0' for a hosting platform that connects from outside the machine (needs a password). */
  host: '127.0.0.1' | '0.0.0.0';
  webRoot: string;
  /** Host names that may be used in the address bar besides this computer's own: a Codespace's or Render's public address. */
  allowedHosts: string[];
  /** The access password, or null when the gateway is only reachable from inside this machine. */
  accessPassword: string | null;
  /** True when the public address is https. */
  secureCookie: boolean;
}

type Env = Record<string, string | undefined>;

const TRUE = /^(1|true|yes|on)$/i;
const FALSE = /^(0|false|no|off)$/i;

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 *  GATEWAY_ENABLED          true to serve the web page and the API on one address (off by default: null is returned)
 *  GATEWAY_PORT             port of the web page + API (default 4580; 0 picks a free one)
 *  GATEWAY_HOST             127.0.0.1 (default) or 0.0.0.0. 0.0.0.0 is for a hosting platform and REQUIRES GATEWAY_ACCESS_PASSWORD
 *  GATEWAY_ACCESS_PASSWORD  sign-in password for the public address (16-200 characters)
 *  GATEWAY_WEB_ROOT         folder with the built web page (default: ../frontend/dist next to the service folder)
 *  GATEWAY_ALLOWED_HOSTS    extra host names that may be used in the address bar, comma separated
 *
 * Inside a Codespace the forwarded address of this exact port is accepted too (CODESPACE_NAME and
 * GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN are set by Codespaces). Other Codespaces, and other ports of this one, are not.
 * On Render, RENDER_EXTERNAL_HOSTNAME (this service's own onrender.com name) is accepted.
 */
export function gatewaySettingsFromEnv(env: Env, serviceRoot: string): GatewaySettings | null {
  const problems: string[] = [];

  const enabled = clean(env['GATEWAY_ENABLED']);
  if (enabled !== undefined && !TRUE.test(enabled) && !FALSE.test(enabled)) {
    throw new ConfigError([`GATEWAY_ENABLED must be true or false (got "${enabled}")`]);
  }
  if (enabled === undefined || FALSE.test(enabled)) return null;

  let port = DEFAULT_GATEWAY_PORT;
  const rawPort = clean(env['GATEWAY_PORT']);
  if (rawPort !== undefined) {
    const n = Number(rawPort);
    if (Number.isInteger(n) && n >= 0 && n <= 65_535) port = n;
    else problems.push(`GATEWAY_PORT must be an integer between 0 and 65535 (got "${rawPort}")`);
  }

  let host: GatewaySettings['host'] = '127.0.0.1';
  const rawHost = clean(env['GATEWAY_HOST']);
  if (rawHost !== undefined) {
    if (rawHost === '127.0.0.1' || rawHost === '0.0.0.0') host = rawHost;
    else problems.push(`GATEWAY_HOST must be 127.0.0.1 or 0.0.0.0 (got "${rawHost}")`);
  }

  const accessPassword = clean(env['GATEWAY_ACCESS_PASSWORD']) ?? null;
  if (accessPassword !== null) {
    const problem = validateAccessPassword(accessPassword);
    if (problem) problems.push(`GATEWAY_ACCESS_PASSWORD: ${problem}`);
  }
  // Listening on every interface makes the service reachable by anyone who can reach the machine. Never without a password.
  if (host === '0.0.0.0' && accessPassword === null) {
    problems.push('GATEWAY_HOST=0.0.0.0 makes the service reachable from other machines, so GATEWAY_ACCESS_PASSWORD must be set as well.');
  }
  // On a public address the pairing token is a value you set and can read in the hosting dashboard. It is not generated and
  // printed: the start-up message goes to logs that everyone with access to the project can read.
  if (host === '0.0.0.0' && clean(env['PAIRING_TOKEN']) === undefined) {
    problems.push('GATEWAY_HOST=0.0.0.0 also needs PAIRING_TOKEN to be set (24 or more characters), so that the token is never printed in the logs.');
  }

  const allowedHosts = (clean(env['GATEWAY_ALLOWED_HOSTS']) ?? '')
    .split(/[\s,;]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  for (const host of allowedHosts) {
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) {
      problems.push(`GATEWAY_ALLOWED_HOSTS entry "${host}" is not a host name (write the name only, without https:// or a port)`);
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);

  const forwarded = codespaceHost(env, port);
  if (forwarded !== null && !allowedHosts.includes(forwarded)) allowedHosts.push(forwarded);
  const render = renderHost(env);
  if (render !== null && !allowedHosts.includes(render)) allowedHosts.push(render);
  return {
    port,
    host,
    webRoot: path.resolve(serviceRoot, clean(env['GATEWAY_WEB_ROOT']) ?? path.join('..', 'frontend', 'dist')),
    allowedHosts,
    accessPassword,
    // A public gateway always sits behind a TLS-terminating proxy, so its cookie must be Secure whatever the proxy is. Both known
    // hosting platforms are https as well. Only a gateway reachable from this computer alone is plain http, where a "Secure"
    // cookie would never be sent back.
    secureCookie: host === '0.0.0.0' || forwarded !== null || render !== null,
  };
}

/** This Render web service's own onrender.com name (RENDER_EXTERNAL_HOSTNAME), or null elsewhere. */
function renderHost(env: Env): string | null {
  const name = clean(env['RENDER_EXTERNAL_HOSTNAME'])?.toLowerCase();
  if (name === undefined || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(name)) return null;
  return name;
}

/** Host name under which Codespaces forwards `port` of this codespace, or null outside Codespaces. */
function codespaceHost(env: Env, port: number): string | null {
  const name = clean(env['CODESPACE_NAME']);
  const domain = clean(env['GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN']);
  if (name === undefined || domain === undefined) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(domain)) return null;
  return `${name}-${port}.${domain}`.toLowerCase();
}

/** The address a person types: the Render or Codespaces address when running there, otherwise this computer. */
export function publicOrigin(env: Env, port: number): string {
  const render = renderHost(env);
  if (render !== null) return `https://${render}`;
  const forwarded = codespaceHost(env, port);
  return forwarded !== null ? `https://${forwarded}` : `http://127.0.0.1:${port}`;
}

/** Same format as the service's own start-up link. The token sits after "#", which a browser never sends to a server. */
export function buildPairingLink(origin: string, token: string): string {
  return `${origin.replace(/\/$/, '')}/#/connect?service=${encodeURIComponent(origin)}&token=${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------------------------------------------------

function connectionTokens(value: string | string[] | undefined): Set<string> {
  const joined = Array.isArray(value) ? value.join(',') : (value ?? '');
  return new Set(
    joined
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** The headers worth passing on: everything except hop-by-hop headers, headers they name, and `drop`. */
function forwardable(headers: IncomingHttpHeaders, drop: readonly string[]): OutgoingHttpHeaders {
  const named = connectionTokens(headers.connection);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || named.has(name) || drop.includes(name)) continue;
    out[name] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// API: pass through to the service
// ---------------------------------------------------------------------------------------------------------------------

function proxy(req: IncomingMessage, res: ServerResponse, target: string, options: GatewayOptions): void {
  // The service only answers to its own name and rejects any Origin it was not told about; the caller was checked above.
  const headers = forwardable(req.headers, ['host', 'origin', 'expect']);
  headers['host'] = `127.0.0.1:${options.upstreamPort}`;
  req.socket.setNoDelay(true);

  const upstream = http.request(
    // A fresh connection per request: the service closes idle connections after a few seconds, and a pooled one could be
    // closed just as it is reused.
    { host: '127.0.0.1', port: options.upstreamPort, method: req.method, path: target, headers, agent: false },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, forwardable(upstreamRes.headers, []));
      res.flushHeaders();
      // Events and downloads are streamed, never buffered. If the browser goes away the service's side is closed as well.
      pipeline(upstreamRes, res, () => undefined);
    },
  );

  upstream.on('error', (error: Error) => {
    options.logger.warn('The gateway could not reach the service', { error: error.message });
    if (res.headersSent) res.destroy();
    else sendError(res, 502, 'internal_error', 'The screenshot service did not answer. It may be restarting; try again in a moment.');
  });
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}

// ---------------------------------------------------------------------------------------------------------------------
// Web page: static files
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Tells the page that the service is at the page's own address. Without it the page would start by looking for the service
 * at 127.0.0.1:4577, which from a browser on another computer is that computer, not this one.
 */
export const SAME_ORIGIN_MARKER = '<meta name="ssg-service" content="same-origin" />';

async function serveIndex(req: IncomingMessage, res: ServerResponse, file: string): Promise<void> {
  const html = await fs.readFile(file, 'utf8');
  // If a future build has no <head> tag the marker is left out and the page falls back to its usual default address.
  const body = Buffer.from(html.replace(/<head(\s[^>]*)?>/i, (open) => `${open}\n    ${SAME_ORIGIN_MARKER}`), 'utf8');
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES['.html'] as string,
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, root: string): Promise<void> {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    sendText(res, 400, 'Bad request');
    return;
  }
  if (relative === '/') relative = '/index.html';

  // No hidden files and no ".." in any form. The resolved path is checked again below, as the last line of defence.
  if (relative.includes('\0') || relative.split(/[\\/]/).some((part) => part.startsWith('.'))) {
    sendText(res, 404, 'Not found');
    return;
  }
  const file = path.resolve(root, `.${relative}`);
  if (!file.startsWith(root + path.sep)) {
    sendText(res, 404, 'Not found');
    return;
  }

  const stat = await fs.stat(file).catch(() => null);
  if (stat === null || !stat.isFile()) {
    if (relative === '/index.html') {
      sendText(res, 503, 'The web page has not been built yet. Run "npm run build" in the frontend folder, then reload.');
    } else {
      sendText(res, 404, 'Not found');
    }
    return;
  }

  if (relative === '/index.html') {
    await serveIndex(req, res, file);
    return;
  }

  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    // Vite puts a hash in the name of everything under /assets, so those files never change; the page itself may.
    'Cache-Control': relative.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  pipeline(createReadStream(file), res, () => undefined);
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------------------------------

/** True for exactly "/healthz" with or without a query string. */
function isHealthRequest(rawUrl: string | undefined): boolean {
  return rawUrl === HEALTH_PATH || (rawUrl?.startsWith(`${HEALTH_PATH}?`) ?? false);
}

async function handle(req: IncomingMessage, res: ServerResponse, options: GatewayOptions, root: string): Promise<void> {
  // The hosting platform's health check comes before every other check, the Host check included: Render sends the Host of a
  // verified custom domain, which would otherwise fail the deploy. The answer is a constant that carries no data and no CORS
  // headers, so a page on another website can learn nothing from it (including through DNS rebinding).
  if (isHealthRequest(req.url)) {
    const healthMethod = req.method ?? 'GET';
    if (healthMethod !== 'GET' && healthMethod !== 'HEAD') {
      sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    } else {
      sendText(res, 200, healthMethod === 'HEAD' ? '' : 'ok');
    }
    return;
  }

  const hostHeader = req.headers.host;
  const hostname = hostnameFromHostHeader(hostHeader);
  if (hostname === null || !isHostnameAllowed(hostname, options)) {
    const shown = String(hostHeader ?? '').slice(0, 120);
    options.logger.warn('The gateway refused a request addressed to an unexpected host name', { host: shown });
    sendError(
      res,
      421,
      'bad_host',
      `The address "${shown}" is not allowed. If it is your own address, add its host name to GATEWAY_ALLOWED_HOSTS and restart.`,
    );
    return;
  }

  const origin = req.headers.origin;
  if (origin !== undefined) {
    const originHost = hostnameFromOrigin(origin);
    if (originHost === null || !isHostnameAllowed(originHost, options)) {
      sendError(res, 403, 'origin_not_allowed', `The website ${origin.slice(0, 120)} is not allowed to use this service.`);
      return;
    }
  }

  // Only a plain path is accepted: no "http://host/..." (absolute form) and no "//host/..." (which a URL parser reads as a host).
  const rawUrl = req.url ?? '/';
  if (!rawUrl.startsWith('/') || rawUrl.startsWith('//')) {
    sendError(res, 400, 'bad_request', 'The request address is not valid.');
    return;
  }
  let url: URL;
  try {
    url = new URL(rawUrl, 'http://gateway.invalid');
  } catch {
    sendError(res, 400, 'bad_request', 'The request address is not valid.');
    return;
  }

  const method = req.method ?? 'GET';
  const { pathname } = url;

  // Behind the sign-in wall nothing is answered until the visitor has signed in: no page, no file, no API.
  const gate = options.gate;
  if (gate) {
    if (pathname === GATE_LOGIN_PATH) {
      await gate.handleLogin(req, res);
      return;
    }
    if (!gate.isSignedIn(req)) {
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        // The page reads this as an error and says so; it does not get an HTML page to choke on. The code is how the page tells
        // "signed out" from "wrong pairing token" (both are 401); it must not depend on the wording of the message.
        sendError(res, 401, 'sign_in_required', 'Sign in with the access password first. Reload the page to see the sign-in form.');
      } else if (method === 'GET' || method === 'HEAD') {
        gate.sendSignInPage(res, 200, null, method === 'HEAD');
      } else {
        sendError(res, 401, 'sign_in_required', 'Sign in with the access password first.');
      }
      return;
    }
    // Keep an open page signed in: a sign-in that is more than half used is renewed on the next request.
    const renewal = gate.renewal(req);
    if (renewal !== null) res.setHeader('Set-Cookie', renewal);
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    if (!API_METHODS.includes(method)) {
      sendError(res, 405, 'method_not_allowed', `${method} is not supported here.`, { Allow: API_METHODS.join(', ') });
      return;
    }
    // Rebuilt from the parsed address, so what reaches the service is always a plain path and query.
    proxy(req, res, `${pathname}${url.search}`, options);
    return;
  }
  if (!STATIC_METHODS.includes(method)) {
    sendError(res, 405, 'method_not_allowed', `${method} is not supported here.`, { Allow: STATIC_METHODS.join(', ') });
    return;
  }
  await serveStatic(req, res, pathname, root);
}

/** The request listener, without a server around it (tests wrap it in their own). */
export function createGatewayHandler(options: GatewayOptions): RequestListener {
  const root = path.resolve(options.webRoot);
  return (req, res) => {
    handle(req, res, options, root).catch((error: unknown) => {
      options.logger.error('Gateway request failed', { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
      if (res.headersSent) res.destroy();
      else sendError(res, 500, 'internal_error', 'Something went wrong inside the gateway.');
    });
  };
}

export interface RunningGateway {
  server: Server;
  port: number;
  stop(): Promise<void>;
}

/**
 * Starts listening. By default on 127.0.0.1 only: the forwarding layer in front of it (Codespaces) connects from inside the
 * same machine. A hosting platform that connects from outside (Render) needs `host: '0.0.0.0'`, which is refused unless the
 * sign-in wall is on.
 */
export async function startGateway(options: GatewayOptions & { port: number; host?: '127.0.0.1' | '0.0.0.0' }): Promise<RunningGateway> {
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && !options.gate) {
    throw new Error('The gateway will not listen on every network interface without an access password (GATEWAY_ACCESS_PASSWORD).');
  }
  const server = http.createServer(createGatewayHandler(options));
  // Browsers arrive through a forwarding proxy that keeps connections open; closing idle ones after a few seconds would race
  // with it. Streams (events, ZIP downloads) must not be cut by the default time limits either.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 0;
  server.timeout = 0;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('error', (error) => options.logger.error('Gateway server error', { error: error.message }));

  const port = (server.address() as AddressInfo).port;
  const stop = (): Promise<void> =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 2_000).unref();
    });
  return { server, port, stop };
}
