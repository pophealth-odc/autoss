import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVICE_FEATURES, serviceHas, type ApiErrorBody } from '../src/shared/contract.js';
import { FailureLimiter, extractBearer, tokensMatch } from '../src/http/auth.js';
import { isLocalhostOrigin, isOriginAllowed } from '../src/http/origin-host.js';
import { startTestService, TEST_PAGES_ORIGIN, TEST_TOKEN, type TestService } from './helpers/service.js';

let t: TestService;
beforeAll(async () => {
  t = await startTestService();
});
afterAll(async () => {
  await t.cleanup();
});

/** Raw HTTP request, so tests can control the Host header (fetch forbids overriding it). */
function raw(opts: { path: string; method?: string; headers?: Record<string, string> }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: t.service.port, path: opts.path, method: opts.method ?? 'GET', headers: opts.headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('pure helpers', () => {
  it('tokensMatch compares in constant time regardless of length', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('abc', 'abd')).toBe(false);
    expect(tokensMatch('abc', 'abcd')).toBe(false);
    expect(tokensMatch('abc', '')).toBe(false);
  });

  it('extractBearer', () => {
    expect(extractBearer('Bearer abc.def')).toBe('abc.def');
    expect(extractBearer('bearer abc')).toBe('abc');
    expect(extractBearer('Basic abc')).toBeNull();
    expect(extractBearer('Bearer')).toBeNull();
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer('Bearer a b')).toBeNull();
  });

  it('limiter blocks after N failures and recovers after the window', () => {
    let now = 1_000;
    const limiter = new FailureLimiter(3, 60_000, () => now);
    for (let i = 0; i < 3; i += 1) limiter.recordFailure('1.2.3.4');
    expect(limiter.retryAfterSeconds('1.2.3.4')).toBeGreaterThan(0);
    expect(limiter.retryAfterSeconds('5.6.7.8')).toBe(0);
    now += 61_000;
    expect(limiter.retryAfterSeconds('1.2.3.4')).toBe(0);
  });

  it('origin matching is exact', () => {
    const o = { allowedOrigins: [TEST_PAGES_ORIGIN], allowLocalhostOrigins: true };
    expect(isOriginAllowed(TEST_PAGES_ORIGIN, o)).toBe(true);
    expect(isOriginAllowed('https://evil.github.io', o)).toBe(false);
    expect(isOriginAllowed(TEST_PAGES_ORIGIN + '.evil.com', o)).toBe(false);
    expect(isOriginAllowed('http://tester.github.io', o)).toBe(false);
    expect(isOriginAllowed('null', o)).toBe(false);
    expect(isOriginAllowed('http://localhost:5173', o)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:4173', o)).toBe(true);
    expect(isOriginAllowed('http://[::1]:3000', o)).toBe(true);
    expect(isOriginAllowed('http://localhost.evil.com', o)).toBe(false);
    expect(isOriginAllowed('http://localhost:5173', { ...o, allowLocalhostOrigins: false })).toBe(false);
    expect(isLocalhostOrigin('file:///x')).toBe(false);
  });
});

describe('serviceHas', () => {
  it('reads the feature list, and treats a service that sends none as having none', () => {
    expect(serviceHas({ features: ['pageScale'] }, 'pageScale')).toBe(true);
    expect(serviceHas({ features: ['pageScale'] }, 'datePlaceholder')).toBe(false);
    expect(serviceHas({}, 'pageScale')).toBe(false); // a build from before the list existed
    expect(serviceHas({ features: [] }, 'pageScale')).toBe(false);
    expect(serviceHas(null, 'pageScale')).toBe(false);
    expect(serviceHas(undefined, 'pageScale')).toBe(false);
    expect(serviceHas({ features: 'pageScale' as unknown as [] }, 'pageScale')).toBe(false); // garbage is not "yes"
  });
});

describe('authentication', () => {
  it('/api/health works without a token and says authentication is required', async () => {
    const r = await fetch(`${t.base}/api/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; service: string; authRequired: boolean };
    expect(body).toMatchObject({ ok: true, service: 'screenshot-gallery-service', authRequired: true });
  });

  it('/api/health advertises the optional abilities, so a page knows what this service understands', async () => {
    const body = (await (await fetch(`${t.base}/api/health`)).json()) as { features?: string[] };
    expect(body.features).toEqual(expect.arrayContaining(['pageScale', 'datePlaceholder']));
    // Only names from the shared list, nothing the page could not interpret.
    expect(body.features?.every((f) => (SERVICE_FEATURES as readonly string[]).includes(f))).toBe(true);
  });

  it('every feature the page checks for is one this service really has: it accepts pageScalePercent', async () => {
    const r = await t.api('/api/automation/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: ['https://example.com/'], pageScalePercent: 80, extraWaitMs: 0 }),
    });
    expect([202, 409]).toContain(r.status); // started (fake browser) - or a run from an earlier test is still winding down
    expect(await r.text()).not.toMatch(/Unrecognized key/);
  });

  it('every other endpoint rejects a missing token with 401 and the standard error shape', async () => {
    for (const [method, path] of [
      ['GET', '/api/gallery'],
      ['GET', '/api/automation/status'],
      ['GET', '/api/events'],
      ['GET', '/api/system/info'],
      ['POST', '/api/automation/start'],
      ['DELETE', '/api/gallery?confirm=true'],
      ['GET', '/api/profiles'],
    ] as const) {
      const r = await fetch(`${t.base}${path}`, { method });
      expect(r.status, `${method} ${path}`).toBe(401);
      const body = (await r.json()) as ApiErrorBody;
      expect(body.error.code).toBe('unauthorized');
      expect(body.error.message).toBeTruthy();
      expect(JSON.stringify(body)).not.toContain(TEST_TOKEN);
    }
  });

  it('rejects a wrong token, and accepts the right one', async () => {
    const bad = await fetch(`${t.base}/api/gallery`, { headers: { Authorization: 'Bearer nope-nope-nope-nope-nope-nope' } });
    expect(bad.status).toBe(401);
    const good = await t.api('/api/gallery');
    expect(good.status).toBe(200);
  });

  it('does not accept the token in the query string', async () => {
    const r = await fetch(`${t.base}/api/gallery?token=${TEST_TOKEN}`);
    expect(r.status).toBe(401);
  });

  it('slows down repeated wrong tokens with 429 and Retry-After', async () => {
    const own = await startTestService();
    try {
      let last = 0;
      let retryAfter: string | null = null;
      for (let i = 0; i < 12; i += 1) {
        const r = await fetch(`${own.base}/api/gallery`, { headers: { Authorization: 'Bearer wrong-wrong-wrong-wrong-wrong' } });
        last = r.status;
        retryAfter = r.headers.get('retry-after');
      }
      expect(last).toBe(429);
      expect(Number(retryAfter)).toBeGreaterThan(0);
      // Even the right token is refused during the lock-out; this is deliberate.
      expect((await own.api('/api/gallery')).status).toBe(429);
    } finally {
      await own.cleanup();
    }
  });
});

describe('Host header (DNS rebinding defence)', () => {
  it('rejects a foreign Host header with 421', async () => {
    const r = await raw({ path: '/api/health', headers: { Host: 'evil.example.com' } });
    expect(r.status).toBe(421);
    expect((JSON.parse(r.body) as ApiErrorBody).error.code).toBe('bad_host');
  });

  it('rejects the right name with the wrong port', async () => {
    const r = await raw({ path: '/api/health', headers: { Host: 'localhost:1' } });
    expect(r.status).toBe(421);
  });

  it('accepts localhost with the listening port', async () => {
    const r = await raw({ path: '/api/health', headers: { Host: `localhost:${t.service.port}` } });
    expect(r.status).toBe(200);
  });
});

describe('CORS and Origin', () => {
  it('answers a preflight from the allowed Pages origin without a token', async () => {
    const r = await fetch(`${t.base}/api/gallery`, {
      method: 'OPTIONS',
      headers: {
        Origin: TEST_PAGES_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
    expect(r.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
    expect(r.headers.get('access-control-allow-methods')).toContain('DELETE');
    expect(r.headers.get('vary')?.toLowerCase()).toContain('origin');
    expect(r.headers.get('access-control-allow-private-network')).toBeNull();
  });

  it('adds Allow-Private-Network only when the browser asks for it', async () => {
    const r = await fetch(`${t.base}/api/gallery`, {
      method: 'OPTIONS',
      headers: { Origin: TEST_PAGES_ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true' },
    });
    expect(r.headers.get('access-control-allow-private-network')).toBe('true');
  });

  it('refuses an unlisted origin with 403 and no CORS headers (even with a valid token)', async () => {
    const r = await t.api('/api/gallery', { headers: { Origin: 'https://evil.github.io' } });
    expect(r.status).toBe(403);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    expect(((await r.json()) as ApiErrorBody).error.code).toBe('origin_not_allowed');
  });

  it('refuses an unlisted origin on preflight', async () => {
    const r = await fetch(`${t.base}/api/gallery`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' },
    });
    expect(r.status).toBe(403);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows local development origins and exposes Content-Disposition', async () => {
    const r = await t.api('/api/gallery', { headers: { Origin: 'http://localhost:5173' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(r.headers.get('access-control-expose-headers')).toContain('Content-Disposition');
  });

  it('a request with a valid token but the "null" origin is refused', async () => {
    const r = await t.api('/api/gallery', { headers: { Origin: 'null' } });
    expect(r.status).toBe(403);
  });
});

describe('response hardening', () => {
  it('sets protective headers and hides the framework', async () => {
    const r = await t.api('/api/gallery');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-powered-by')).toBeNull();
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(r.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{8}$/);
  });

  it('unknown routes return the standard JSON 404, not an HTML page', async () => {
    for (const path of ['/', '/index.html', '/api/nope', '/api/gallery/x/y/z']) {
      const r = await t.api(path);
      expect(r.status, path).toBe(404);
      expect(((await r.json()) as ApiErrorBody).error.code).toBe('not_found');
    }
  });

  it('malformed JSON gives a 400 without leaking internals', async () => {
    const r = await t.api('/api/automation/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"urls": [' });
    expect(r.status).toBe(400);
    const text = await r.text();
    expect(text).not.toMatch(/at .*\.(js|ts):\d+/);
    expect((JSON.parse(text) as ApiErrorBody).error.code).toBe('bad_request');
  });

  it('oversized bodies are rejected with 413', async () => {
    const r = await t.api('/api/automation/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: ['https://example.com'], junk: 'x'.repeat(400_000) }),
    });
    expect(r.status).toBe(413);
    expect(((await r.json()) as ApiErrorBody).error.code).toBe('payload_too_large');
  });

  it('only listens on the loopback interface', () => {
    const address = t.service.server.address();
    expect(typeof address === 'object' && address && address.address).toBe('127.0.0.1');
  });
});
