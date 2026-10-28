import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildPairingLink,
  gatewaySettingsFromEnv,
  isHostnameAllowed,
  publicOrigin,
  SAME_ORIGIN_MARKER,
  startGateway,
  type RunningGateway,
} from '../src/gateway/gateway.js';
import { silentLogger } from '../src/logger.js';
import type { ApiErrorBody } from '../src/shared/contract.js';
import { startTestService, TEST_TOKEN, type TestService } from './helpers/service.js';
import { makeTempDir } from './helpers/tmp.js';

const CODESPACE_HOST = 'my-space-abc123-4580.app.github.dev';

describe('gateway settings from the environment', () => {
  const root = path.resolve('some', 'service');

  it('is off unless GATEWAY_ENABLED is true', () => {
    expect(gatewaySettingsFromEnv({}, root)).toBeNull();
    expect(gatewaySettingsFromEnv({ GATEWAY_ENABLED: 'false' }, root)).toBeNull();
    expect(gatewaySettingsFromEnv({ GATEWAY_ENABLED: '' }, root)).toBeNull();
    expect(gatewaySettingsFromEnv({ GATEWAY_ENABLED: 'true' }, root)).not.toBeNull();
  });

  it('rejects a GATEWAY_ENABLED that is neither true nor false', () => {
    expect(() => gatewaySettingsFromEnv({ GATEWAY_ENABLED: 'maybe' }, root)).toThrow(/true or false/);
  });

  it('uses port 4580 and the built frontend next to the service by default', () => {
    const s = gatewaySettingsFromEnv({ GATEWAY_ENABLED: 'true' }, root);
    expect(s?.port).toBe(4580);
    expect(s?.webRoot).toBe(path.resolve(root, '..', 'frontend', 'dist'));
    expect(s?.allowedHosts).toEqual([]);
  });

  it.each(['abc', '-1', '70000', '1.5'])('rejects the port %j', (port) => {
    expect(() => gatewaySettingsFromEnv({ GATEWAY_ENABLED: 'true', GATEWAY_PORT: port }, root)).toThrow(/GATEWAY_PORT/);
  });

  it('accepts exactly the forwarded address of this codespace and port', () => {
    const s = gatewaySettingsFromEnv(
      { GATEWAY_ENABLED: 'true', CODESPACE_NAME: 'my-space-abc123', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev' },
      root,
    );
    expect(s?.allowedHosts).toEqual([CODESPACE_HOST]);
  });

  it('follows a different port in the forwarded address', () => {
    const s = gatewaySettingsFromEnv(
      { GATEWAY_ENABLED: 'true', GATEWAY_PORT: '9000', CODESPACE_NAME: 'x', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev' },
      root,
    );
    expect(s?.allowedHosts).toEqual(['x-9000.app.github.dev']);
  });

  it('ignores codespace variables that look wrong, instead of building an address from them', () => {
    const s = gatewaySettingsFromEnv(
      { GATEWAY_ENABLED: 'true', CODESPACE_NAME: 'a/b', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev' },
      root,
    );
    expect(s?.allowedHosts).toEqual([]);
  });

  it('takes extra host names, and refuses anything that is not a bare host name', () => {
    const ok = gatewaySettingsFromEnv({ GATEWAY_ENABLED: 'true', GATEWAY_ALLOWED_HOSTS: 'One.Example.com, two.example.com' }, root);
    expect(ok?.allowedHosts).toEqual(['one.example.com', 'two.example.com']);
    for (const bad of ['https://one.example.com', 'one.example.com:4580', 'a/b', '*.example.com']) {
      expect(() => gatewaySettingsFromEnv({ GATEWAY_ENABLED: 'true', GATEWAY_ALLOWED_HOSTS: bad }, root), bad).toThrow(/GATEWAY_ALLOWED_HOSTS/);
    }
  });
});

describe('addresses', () => {
  it('uses the forwarded https address inside a codespace, and this computer otherwise', () => {
    const env = { CODESPACE_NAME: 'my-space-abc123', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev' };
    expect(publicOrigin(env, 4580)).toBe(`https://${CODESPACE_HOST}`);
    expect(publicOrigin({}, 4580)).toBe('http://127.0.0.1:4580');
  });

  it('puts the token after "#", where a browser never sends it to a server', () => {
    const link = buildPairingLink('https://x.app.github.dev/', 'tok+en/123');
    expect(link).toBe('https://x.app.github.dev/#/connect?service=https%3A%2F%2Fx.app.github.dev%2F&token=tok%2Ben%2F123');
    expect(link.indexOf('#')).toBeLessThan(link.indexOf('token='));
  });
});

describe('which host names are accepted', () => {
  const policy = { allowedHosts: [CODESPACE_HOST] };

  it.each(['localhost', '127.0.0.1', '[::1]', 'LOCALHOST', CODESPACE_HOST, CODESPACE_HOST.toUpperCase()])('accepts %s', (host) => {
    expect(isHostnameAllowed(host, policy)).toBe(true);
  });

  it.each([
    'evil.example.com',
    // A look-alike must not pass for the real name, in either direction.
    `x${CODESPACE_HOST}`,
    `${CODESPACE_HOST}.evil.com`,
    'other-space-4580.app.github.dev',
    'my-space-abc123-9999.app.github.dev',
    '192.168.1.5',
    '',
  ])('refuses %j', (host) => {
    expect(isHostnameAllowed(host, policy)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The real thing: a gateway in front of a real service
// ---------------------------------------------------------------------------------------------------------------------

let t: TestService;
let gateway: RunningGateway;
let webRoot: string;
let cleanupWeb: () => Promise<void>;

const INDEX_HTML = '<!doctype html>\n<html lang="en">\n  <head>\n    <title>Fixture page</title>\n  </head>\n  <body><div id="root"></div></body>\n</html>\n';

beforeAll(async () => {
  t = await startTestService();
  // Everything lives in one folder of our own: the web root is a sub-folder, and a file NEXT to it is what a path trick would reach.
  const scratch = await makeTempDir('ss3-gw-web-');
  cleanupWeb = scratch.cleanup;
  webRoot = path.join(scratch.dir, 'web');
  await fs.mkdir(path.join(webRoot, 'assets'), { recursive: true });
  await fs.writeFile(path.join(webRoot, 'index.html'), INDEX_HTML);
  await fs.writeFile(path.join(webRoot, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await fs.writeFile(path.join(webRoot, 'assets', 'app-abc123.js'), 'export const ok = true;');
  await fs.writeFile(path.join(webRoot, '.secret'), 'must never be served');
  await fs.writeFile(path.join(scratch.dir, 'outside-gateway-test.txt'), 'outside');
  gateway = await startGateway({ port: 0, upstreamPort: t.service.port, webRoot, allowedHosts: [CODESPACE_HOST], logger: silentLogger });
});

afterAll(async () => {
  await gateway?.stop();
  await t?.cleanup();
  await cleanupWeb?.();
});

/** fetch() cannot set a Host header, so these tests speak HTTP directly. */
function raw(options: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: gateway.port, method: options.method ?? 'GET', path: options.path, headers: { Host: `127.0.0.1:${gateway.port}`, ...options.headers } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** Writes the text to the gateway's socket exactly as given. http.request would tidy up the cases these tests need to see. */
function sendRaw(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(gateway.port, '127.0.0.1', () => socket.write(text));
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (data += chunk));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
    socket.setTimeout(5_000, () => socket.destroy(new Error('no answer within 5 s')));
  });
}

const auth = { Authorization: `Bearer ${TEST_TOKEN}` };

describe('gateway: the web page', () => {
  it('serves the page and marks it as served together with its service', async () => {
    const r = await raw({ path: '/' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.body).toContain(SAME_ORIGIN_MARKER);
    expect(r.body.indexOf(SAME_ORIGIN_MARKER)).toBeGreaterThan(r.body.indexOf('<head>'));
    expect(r.body).toContain('<title>Fixture page</title>');
    expect(r.headers['content-length']).toBe(String(Buffer.byteLength(r.body)));
    expect(r.headers['cache-control']).toBe('no-cache');
  });

  it('serves the same page at /index.html, and answers HEAD without a body', async () => {
    expect((await raw({ path: '/index.html' })).body).toContain(SAME_ORIGIN_MARKER);
    const head = await raw({ method: 'HEAD', path: '/' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });

  it('serves built assets with the right type and a long cache time', async () => {
    const js = await raw({ path: '/assets/app-abc123.js' });
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(js.body).toBe('export const ok = true;');
    const icon = await raw({ path: '/favicon.svg' });
    expect(icon.headers['content-type']).toBe('image/svg+xml');
    expect(icon.headers['cache-control']).toBe('no-cache');
  });

  it('answers 404 for a file that is not there (no single-page fallback)', async () => {
    expect((await raw({ path: '/nothing-here.js' })).status).toBe(404);
    expect((await raw({ path: '/some/route' })).status).toBe(404);
  });

  it('never serves hidden files or anything outside the web folder', async () => {
    for (const p of ['/.secret', '/%2esecret', '/assets/../.secret', '/../outside-gateway-test.txt', '/%2e%2e/outside-gateway-test.txt', '/..%2foutside-gateway-test.txt', '/assets/%2e%2e/%2e%2e/outside-gateway-test.txt', '/a%00.js']) {
      const r = await raw({ path: p });
      expect(r.status, p).not.toBe(200);
      expect(r.body, p).not.toContain('must never be served');
      expect(r.body, p).not.toContain('outside');
    }
  });

  it('says what to do when the page has not been built', async () => {
    const empty = await makeTempDir('ss3-gw-empty-');
    const g = await startGateway({ port: 0, upstreamPort: t.service.port, webRoot: path.join(empty.dir, 'missing'), logger: silentLogger });
    try {
      const body = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: g.port, path: '/' }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
        }).on('error', reject);
      });
      expect(body.status).toBe(503);
      expect(body.text).toMatch(/has not been built/);
    } finally {
      await g.stop();
      await empty.cleanup();
    }
  });

  it('refuses methods the page never uses', async () => {
    const r = await raw({ method: 'POST', path: '/', body: '{}' });
    expect(r.status).toBe(405);
    expect(r.headers['allow']).toBe('GET, HEAD');
  });
});

describe('gateway: the API', () => {
  it('passes /api/health through without a token', async () => {
    const r = await raw({ path: '/api/health' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, service: 'screenshot-gallery-service', authRequired: true });
  });

  it('still requires the pairing token', async () => {
    const none = await raw({ path: '/api/gallery' });
    expect(none.status).toBe(401);
    expect((JSON.parse(none.body) as ApiErrorBody).error.code).toBe('unauthorized');
    const wrong = await raw({ path: '/api/gallery', headers: { Authorization: 'Bearer not-the-token-0123456789abcdef' } });
    expect(wrong.status).toBe(401);
    const ok = await raw({ path: '/api/gallery', headers: auth });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ items: [], total: 0 });
  });

  it('carries request bodies and query strings to the service', async () => {
    const empty = await raw({ method: 'DELETE', path: '/api/gallery', headers: auth });
    expect(empty.status).toBe(400); // no ?confirm=true
    expect((JSON.parse(empty.body) as ApiErrorBody).error.code).toBe('confirmation_required');
    const confirmed = await raw({ method: 'DELETE', path: '/api/gallery?confirm=true', headers: auth });
    expect(confirmed.status).toBe(200);

    const body = JSON.stringify({ ids: [] });
    const posted = await raw({ method: 'POST', path: '/api/gallery/delete', headers: { ...auth, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }, body });
    expect(posted.status).toBe(400);
    expect((JSON.parse(posted.body) as ApiErrorBody).error.message).toMatch(/at least one/);
  });

  it('carries the service\'s answers back unchanged: status, JSON, request id', async () => {
    const r = await raw({ path: '/api/nothing-like-this', headers: auth });
    expect(r.status).toBe(404);
    expect((JSON.parse(r.body) as ApiErrorBody).error.code).toBe('not_found');
    expect(r.headers['x-request-id']).toMatch(/^[0-9a-f]{8}$/);
    expect(r.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  });

  it('streams server-sent events as they happen, not when the stream ends', async () => {
    const chunks: string[] = [];
    const first = await new Promise<string>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: gateway.port, path: '/api/events', headers: { Host: `127.0.0.1:${gateway.port}`, ...auth, Accept: 'text/event-stream' } }, (res) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          chunks.push(chunk);
          if (chunks.join('').includes('event: state')) {
            resolve(chunks.join(''));
            req.destroy();
          }
        });
      });
      req.on('error', (error: NodeJS.ErrnoException) => (error.code === 'ECONNRESET' ? undefined : reject(error)));
      setTimeout(() => reject(new Error('no event within 5 s')), 5_000).unref();
    });
    expect(first).toContain('event: hello');
    expect(first).toContain('event: state');
    // Closing the browser's side must close the service's side too, or the service would count a stream that is gone.
    await expect.poll(() => t.service.hub.clientCount, { timeout: 5_000 }).toBe(0);
  });

  it('reports a stopped service as a normal error the page can read', async () => {
    const lone = await startGateway({ port: 0, upstreamPort: 1, webRoot, logger: silentLogger });
    try {
      const r = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: lone.port, path: '/api/health' }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
        }).on('error', reject);
      });
      expect(r.status).toBe(502);
      expect((JSON.parse(r.text) as ApiErrorBody).error.message).toMatch(/did not answer/);
    } finally {
      await lone.stop();
    }
  });
});

describe('gateway: what it refuses', () => {
  it('refuses a Host header it does not know (DNS rebinding and wrong addresses)', async () => {
    for (const host of ['evil.example.com', `${CODESPACE_HOST}.evil.com`, 'other-space-4580.app.github.dev', '192.168.1.5:4580']) {
      const r = await raw({ path: '/api/health', headers: { Host: host } });
      expect(r.status, host).toBe(421);
      expect((JSON.parse(r.body) as ApiErrorBody).error.code).toBe('bad_host');
    }
    // Static files are covered by the same check.
    expect((await raw({ path: '/', headers: { Host: 'evil.example.com' } })).status).toBe(421);
  });

  it('refuses a malformed Host header', async () => {
    for (const host of ['a b', 'a/b', 'a@b', 'a?b']) {
      const r = await raw({ path: '/api/health', headers: { Host: host } });
      expect(r.status, JSON.stringify(host)).toBe(421);
    }
  });

  it('refuses an empty Host header and a request with no Host header at all', async () => {
    // Raw sockets: http.request replaces an empty Host with the real one, which would hide this case.
    // Node may turn the HTTP/1.1 request away itself before the gateway sees it (400); either way it is not served.
    const empty = await sendRaw('GET /api/health HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n');
    expect(empty).toMatch(/^HTTP\/1\.1 (400|421) /);
    expect(empty).not.toContain('screenshot-gallery-service');
    // HTTP/1.0 has no Host requirement, so this one always reaches the gateway.
    const missing = await sendRaw('GET /api/health HTTP/1.0\r\nConnection: close\r\n\r\n');
    expect(missing).toMatch(/^HTTP\/1\.1 421 /);
    expect(missing).not.toContain('screenshot-gallery-service');
  });

  it('accepts this codespace\'s forwarded address as the Host', async () => {
    const r = await raw({ path: '/api/health', headers: { Host: CODESPACE_HOST } });
    expect(r.status).toBe(200);
  });

  it('refuses a request that comes from another website', async () => {
    for (const origin of ['https://evil.example.com', 'null', 'not a url', 'https://pophealth-odc.github.io']) {
      const r = await raw({ path: '/api/gallery', headers: { ...auth, Origin: origin } });
      expect(r.status, origin).toBe(403);
      expect((JSON.parse(r.body) as ApiErrorBody).error.code).toBe('origin_not_allowed');
    }
  });

  it('accepts a request from its own address, and from a page on this computer', async () => {
    for (const origin of [`https://${CODESPACE_HOST}`, `http://127.0.0.1:${gateway.port}`, 'http://localhost:5173']) {
      const r = await raw({ path: '/api/gallery', headers: { ...auth, Origin: origin } });
      expect(r.status, origin).toBe(200);
    }
  });

  it('does not let the browser\'s Origin or Host choose what the service sees', async () => {
    // The service has its own allow-list; the gateway made its own decision above and does not pass the Origin on. Without
    // this the service would answer 403 to the codespace address, which it has never heard of.
    const r = await raw({ path: '/api/gallery', headers: { ...auth, Origin: `https://${CODESPACE_HOST}`, Host: CODESPACE_HOST } });
    expect(r.status).toBe(200);
  });

  it('refuses absolute-form and protocol-relative request targets', async () => {
    for (const target of ['http://evil.example.com/api/health', '//evil.example.com/api/health', 'api/health']) {
      const text = await sendRaw(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${gateway.port}\r\nConnection: close\r\n\r\n`);
      expect(text, target).toMatch(/^HTTP\/1\.1 400 /);
    }
  });

  it('only passes the methods the API uses', async () => {
    for (const method of ['PUT', 'PATCH', 'OPTIONS', 'TRACE']) {
      const r = await raw({ method, path: '/api/gallery', headers: auth });
      expect(r.status, method).toBe(405);
    }
  });

  it('does not forward the browser\'s connection headers, so the service sees a plain request', async () => {
    const r = await raw({ path: '/api/health', headers: { Connection: 'close, X-Evil', 'X-Evil': '1', Upgrade: 'websocket' } });
    expect(r.status).toBe(200);
  });
});
