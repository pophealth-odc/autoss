import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessGate, GATE_LOGIN_PATH, validateAccessPassword } from '../src/gateway/access-gate.js';
import { gatewaySettingsFromEnv, SAME_ORIGIN_MARKER, startGateway, type RunningGateway } from '../src/gateway/gateway.js';
import { silentLogger } from '../src/logger.js';
import type { ApiErrorBody } from '../src/shared/contract.js';
import { startTestService, TEST_TOKEN, type TestService } from './helpers/service.js';
import { makeTempDir } from './helpers/tmp.js';

const PASSWORD = 'correct horse battery staple';
const RENDER_HOST = 'screenshots-abcd.onrender.com';

describe('access password rules', () => {
  it('needs 16 to 200 characters and no control characters', () => {
    expect(validateAccessPassword(PASSWORD)).toBeNull();
    expect(validateAccessPassword('a'.repeat(15))).toMatch(/at least 16/);
    expect(validateAccessPassword('a'.repeat(16))).toBeNull();
    expect(validateAccessPassword('a'.repeat(200))).toBeNull();
    expect(validateAccessPassword('a'.repeat(201))).toMatch(/at most 200/);
    expect(validateAccessPassword(`${'a'.repeat(20)}\n`)).toMatch(/control characters/);
  });

  it('never repeats the password in its message', () => {
    const secret = 'short-secret';
    expect(validateAccessPassword(secret)).not.toContain(secret);
  });
});

describe('public gateway settings', () => {
  const root = path.resolve('some', 'service');
  const publicEnv = {
    GATEWAY_ENABLED: 'true',
    GATEWAY_HOST: '0.0.0.0',
    GATEWAY_ACCESS_PASSWORD: PASSWORD,
    PAIRING_TOKEN: 'pairing-token-0123456789abcdefghij',
  };

  it('listens on this computer only by default', () => {
    const s = gatewaySettingsFromEnv({ GATEWAY_ENABLED: 'true' }, root);
    expect(s?.host).toBe('127.0.0.1');
    expect(s?.accessPassword).toBeNull();
    expect(s?.secureCookie).toBe(false);
  });

  it('refuses to listen on every interface without an access password', () => {
    expect(() => gatewaySettingsFromEnv({ ...publicEnv, GATEWAY_ACCESS_PASSWORD: '' }, root)).toThrow(/GATEWAY_ACCESS_PASSWORD must be set/);
    expect(() => gatewaySettingsFromEnv({ GATEWAY_ENABLED: 'true', GATEWAY_HOST: '0.0.0.0' }, root)).toThrow(/GATEWAY_ACCESS_PASSWORD must be set/);
  });

  it('refuses to listen on every interface with a token that would have to be printed', () => {
    expect(() => gatewaySettingsFromEnv({ ...publicEnv, PAIRING_TOKEN: '' }, root)).toThrow(/PAIRING_TOKEN/);
  });

  it('refuses a weak access password and any host other than the two it knows', () => {
    expect(() => gatewaySettingsFromEnv({ ...publicEnv, GATEWAY_ACCESS_PASSWORD: 'short' }, root)).toThrow(/at least 16/);
    expect(() => gatewaySettingsFromEnv({ ...publicEnv, GATEWAY_HOST: '192.168.1.5' }, root)).toThrow(/GATEWAY_HOST/);
    expect(() => gatewaySettingsFromEnv({ ...publicEnv, GATEWAY_HOST: '::' }, root)).toThrow(/GATEWAY_HOST/);
  });

  it('accepts a password on a local gateway too, and keeps the cookie usable over plain http', () => {
    const s = gatewaySettingsFromEnv({ GATEWAY_ENABLED: 'true', GATEWAY_ACCESS_PASSWORD: PASSWORD }, root);
    expect(s?.host).toBe('127.0.0.1');
    expect(s?.accessPassword).toBe(PASSWORD);
    expect(s?.secureCookie).toBe(false);
  });

  it('accepts exactly this service\'s own onrender.com name, and marks the cookie secure', () => {
    const s = gatewaySettingsFromEnv({ ...publicEnv, RENDER_EXTERNAL_HOSTNAME: RENDER_HOST.toUpperCase() }, root);
    expect(s?.host).toBe('0.0.0.0');
    expect(s?.allowedHosts).toEqual([RENDER_HOST]);
    expect(s?.secureCookie).toBe(true);
  });

  it('marks the cookie secure on ANY public address, behind whatever TLS proxy (not only on the two known platforms)', () => {
    const s = gatewaySettingsFromEnv({ ...publicEnv, GATEWAY_ALLOWED_HOSTS: 'gallery.example.com' }, root);
    expect(s?.host).toBe('0.0.0.0');
    expect(s?.allowedHosts).toEqual(['gallery.example.com']);
    expect(s?.secureCookie).toBe(true);
  });

  it('ignores a Render hostname that does not look like a host name', () => {
    for (const bad of ['a/b', 'a b', 'https://x.onrender.com', '-x.com', '']) {
      expect(gatewaySettingsFromEnv({ ...publicEnv, RENDER_EXTERNAL_HOSTNAME: bad }, root)?.allowedHosts, bad).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A real gateway with the wall on, in front of a real service
// ---------------------------------------------------------------------------------------------------------------------

let t: TestService;
let gateway: RunningGateway;
let cleanup: () => Promise<void>;
let now = Date.now();

function request(options: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
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

const form = (password: string) => ({ method: 'POST', path: GATE_LOGIN_PATH, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `password=${encodeURIComponent(password)}` });
const cookieOf = (setCookie: string | string[] | undefined): string => String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0] as string;
const auth = { Authorization: `Bearer ${TEST_TOKEN}` };

async function signIn(): Promise<string> {
  const r = await request(form(PASSWORD));
  expect(r.status).toBe(303);
  return cookieOf(r.headers['set-cookie']);
}

beforeAll(async () => {
  t = await startTestService();
  const scratch = await makeTempDir('ss3-gate-web-');
  cleanup = scratch.cleanup;
  const webRoot = path.join(scratch.dir, 'web');
  await fs.mkdir(webRoot, { recursive: true });
  await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html>\n<html><head><title>Fixture page</title></head><body>SECRET PAGE CONTENT</body></html>');
  const gate = new AccessGate({ password: PASSWORD, secureCookie: false, logger: silentLogger, wrongDelayMs: 40, maxPendingWrong: 3, now: () => now });
  gateway = await startGateway({ port: 0, upstreamPort: t.service.port, webRoot, allowedHosts: [RENDER_HOST], logger: silentLogger, gate });
});

afterAll(async () => {
  await gateway?.stop();
  await t?.cleanup();
  await cleanup?.();
});

describe('sign-in wall: before signing in', () => {
  it('shows only the sign-in form for the page, and no page content', async () => {
    for (const p of ['/', '/index.html', '/assets/app.js', '/anything/else', '/favicon.svg']) {
      const r = await request({ path: p });
      expect(r.status, p).toBe(200);
      expect(r.body, p).toContain('Access password');
      expect(r.body, p).not.toContain('SECRET PAGE CONTENT');
      expect(r.body, p).not.toContain(SAME_ORIGIN_MARKER);
    }
  });

  it('serves the form with no script, no caching and a strict policy', async () => {
    const r = await request({ path: '/' });
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['content-security-policy']).toContain("form-action 'self'");
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.body).not.toMatch(/<script/i);
    expect(r.body).toContain('noindex');
  });

  it('lets the browser tell this site who is posting the form (a "no-referrer" policy would make it send "Origin: null")', async () => {
    // Found with a real browser: with "no-referrer" Edge posts the sign-in form with "Origin: null", which is refused, so nobody
    // could sign in. Node's own client sends no Origin at all, so only a policy check can keep this from coming back.
    const r = await request({ path: '/' });
    expect(r.headers['referrer-policy']).toBe('same-origin');
  });

  it('accepts a form post from the site\'s own origin, which is what a browser sends once the policy allows it', async () => {
    const own = `http://127.0.0.1:${gateway.port}`;
    const r = await request({ ...form('not the password at all'), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: own } });
    expect(r.status).toBe(401); // reached the gate and was judged: a wrong password, not "origin_not_allowed"
    expect(r.body).toContain('That password is not correct.');
    const ok = await request({ ...form(PASSWORD), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: own } });
    expect(ok.status).toBe(303);
  });

  it('still refuses a sign-in post that claims to come from nowhere or from another website', async () => {
    for (const origin of ['null', 'https://evil.example.com']) {
      const r = await request({ ...form(PASSWORD), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin } });
      expect(r.status, origin).toBe(403);
      expect(r.headers['set-cookie'], origin).toBeUndefined();
    }
  });

  it('answers the API with a JSON 401 the page can read, and never reaches the service', async () => {
    const r = await request({ path: '/api/gallery', headers: auth });
    expect(r.status).toBe(401);
    // Its own code, so the page can tell "signed out" from "wrong pairing token" without reading the wording.
    expect((JSON.parse(r.body) as ApiErrorBody).error.code).toBe('sign_in_required');
    expect((JSON.parse(r.body) as ApiErrorBody).error.message).toMatch(/access password/);
    // Even the open health endpoint of the service is behind the wall.
    expect((await request({ path: '/api/health' })).status).toBe(401);
  });

  it('keeps strangers away from the service\'s own limit on wrong pairing tokens', async () => {
    for (let i = 0; i < 25; i += 1) {
      const r = await request({ path: '/api/gallery', headers: { Authorization: `Bearer wrong-token-${i}-0123456789abcdef` } });
      expect(r.status).toBe(401);
      expect((JSON.parse(r.body) as ApiErrorBody).error.code).toBe('sign_in_required');
    }
    // The service saw none of that, so the owner's real token is not rate limited.
    const cookie = await signIn();
    const ok = await request({ path: '/api/gallery', headers: { ...auth, Cookie: cookie } });
    expect(ok.status).toBe(200);
  });

  it('refuses writes without a sign-in too', async () => {
    for (const method of ['POST', 'DELETE']) {
      const r = await request({ method, path: '/api/gallery?confirm=true', headers: auth });
      expect(r.status, method).toBe(401);
    }
    const r = await request({ method: 'POST', path: '/', body: '{}' });
    expect(r.status).toBe(401);
  });

  it('lets the hosting platform check that the process is up without signing in', async () => {
    const r = await request({ path: '/healthz' });
    expect(r.status).toBe(200);
    expect(r.body).toBe('ok');
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect((await request({ path: '/healthz?x=1' })).status).toBe(200);
    expect((await request({ method: 'HEAD', path: '/healthz' })).status).toBe(200);
    expect((await request({ method: 'POST', path: '/healthz' })).status).toBe(405);
    // Only that exact path: look-alikes are behind the wall.
    for (const p of ['/healthz/', '/healthz2', '/Healthz', '/healthz/../api/gallery']) {
      expect((await request({ path: p, headers: auth })).body, p).not.toBe('ok');
    }
  });

  it('answers the health check even when the Host header is one it does not know (a custom domain)', async () => {
    const r = await request({ path: '/healthz', headers: { Host: 'www.my-custom-domain.example' } });
    expect(r.status).toBe(200);
    expect(r.body).toBe('ok');
    // ...but nothing else is answered for an unknown Host.
    expect((await request({ path: '/', headers: { Host: 'www.my-custom-domain.example' } })).status).toBe(421);
  });
});

describe('sign-in wall: signing in', () => {
  it('accepts the right password, sets a locked-down cookie and sends the visitor to the page', async () => {
    const r = await request(form(PASSWORD));
    expect(r.status).toBe(303);
    expect(r.headers['location']).toBe('/');
    const setCookie = String(r.headers['set-cookie']);
    expect(setCookie).toMatch(/^ssg_gate=v1\.\d+\.[A-Za-z0-9_-]{43};/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Secure'); // this gateway is plain http
    expect(setCookie).not.toContain(PASSWORD);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('shows the page, the files and the API after signing in, and the API still needs the pairing token', async () => {
    const cookie = await signIn();
    const page = await request({ path: '/', headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    expect(page.body).toContain('SECRET PAGE CONTENT');
    expect(page.body).toContain(SAME_ORIGIN_MARKER);
    expect((await request({ path: '/api/health', headers: { Cookie: cookie } })).status).toBe(200);
    const noToken = await request({ path: '/api/gallery', headers: { Cookie: cookie } });
    expect(noToken.status).toBe(401);
    expect((JSON.parse(noToken.body) as ApiErrorBody).error.code).toBe('unauthorized'); // the service's own refusal, not the wall's
    expect((JSON.parse(noToken.body) as ApiErrorBody).error.message).toMatch(/pairing token/);
    expect((await request({ path: '/api/gallery', headers: { Cookie: cookie, ...auth } })).status).toBe(200);
  });

  it('treats the sign-in address like the form when it is opened with GET', async () => {
    const r = await request({ path: GATE_LOGIN_PATH });
    expect(r.status).toBe(200);
    expect(r.body).toContain('Access password');
  });

  it('refuses a wrong password, says so plainly, and never echoes what was typed', async () => {
    const typed = 'my-secret-guess-<script>alert(1)</script>';
    const r = await request(form(typed));
    expect(r.status).toBe(401);
    expect(r.body).toContain('That password is not correct.');
    expect(r.body).not.toContain('my-secret-guess');
    expect(r.body).not.toContain('<script>alert');
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('refuses an empty password, a password with extra text, and one of a different length', async () => {
    // 3000 characters fit in the form but are far longer than any allowed password: refused like any other wrong one.
    for (const attempt of ['', PASSWORD + ' ', ' ' + PASSWORD, PASSWORD.toUpperCase(), PASSWORD.slice(0, -1), 'x'.repeat(3000)]) {
      const r = await request(form(attempt));
      expect(r.status, JSON.stringify(attempt.slice(0, 20))).toBe(401);
      expect(r.headers['set-cookie']).toBeUndefined();
    }
  });

  it('refuses sign-in requests that are not a plain form post', async () => {
    expect((await request({ method: 'POST', path: GATE_LOGIN_PATH, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })).status).toBe(415);
    expect((await request({ method: 'PUT', path: GATE_LOGIN_PATH, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `password=${PASSWORD}` })).status).toBe(405);
    const tooBig = await request({ method: 'POST', path: GATE_LOGIN_PATH, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `password=${'a'.repeat(10_000)}` }).catch((error: NodeJS.ErrnoException) => ({ status: error.code === 'ECONNRESET' || error.code === 'EPIPE' ? 413 : 0 }));
    expect(tooBig.status).toBe(413);
  });
});

describe('sign-in wall: the cookie', () => {
  const sign = (expiry: number, password = PASSWORD) => {
    const key = createHmac('sha256', password).update('ssg-gate-session-key-v1').digest();
    return createHmac('sha256', key).update(`v1.${expiry}`).digest('base64url');
  };
  const forged = (expiry: number, password = PASSWORD) => `ssg_gate=v1.${expiry}.${sign(expiry, password)}`;
  const opens = async (cookie: string) => (await request({ path: '/', headers: { Cookie: cookie } })).body.includes('SECRET PAGE CONTENT');

  it('accepts a cookie that was signed with the password (checks the test\'s own signing against the real one)', async () => {
    expect(await opens(forged(now + 3_600_000))).toBe(true);
  });

  it('rejects a cookie signed with another password', async () => {
    expect(await opens(forged(now + 3_600_000, 'a different password entirely'))).toBe(false);
  });

  it('rejects a cookie whose expiry was changed, or that has expired', async () => {
    const good = await signIn();
    const [, expiry, signature] = (good.split('=')[1] as string).split('.');
    expect(await opens(good)).toBe(true);
    expect(await opens(`ssg_gate=v1.${Number(expiry) + 1_000_000}.${signature}`)).toBe(false);
    expect(await opens(forged(now - 1))).toBe(false);
    expect(await opens(forged(now))).toBe(false);
  });

  it('rejects a cookie that claims to last far longer than any sign-in could', async () => {
    expect(await opens(forged(now + 400 * 24 * 3_600_000))).toBe(false);
  });

  it('rejects malformed and hostile cookie values without crashing', async () => {
    for (const bad of ['ssg_gate=', 'ssg_gate=v1', 'ssg_gate=v1..', 'ssg_gate=v1.1.x', 'ssg_gate=v2.9999999999999.abc', `ssg_gate=${'a'.repeat(5000)}`, 'ssg_gate=v1.99999999999999999999.' + 'a'.repeat(43), 'other=1']) {
      expect(await opens(bad), bad.slice(0, 40)).toBe(false);
    }
    // The server is still fine afterwards.
    expect((await request({ path: '/healthz' })).status).toBe(200);
  });

  it('finds its cookie among others', async () => {
    const good = await signIn();
    expect(await opens(`a=1; ${good}; b=2`)).toBe(true);
    expect(await opens(`fake_ssg_gate=${good.split('=')[1]}`)).toBe(false);
  });

  it('still finds its cookie when the browser sends a great many others (a long Cookie header)', async () => {
    const good = await signIn();
    const others = Array.from({ length: 120 }, (_, i) => `other_cookie_${i}=${'x'.repeat(40)}`).join('; ');
    expect(others.length).toBeGreaterThan(4_096); // longer than the limit an earlier version put on the header
    expect(await opens(`${others}; ${good}`)).toBe(true);
    expect(await opens(`${good}; ${others}`)).toBe(true);
  });

  it('renews a sign-in once it is more than half used, and not before', async () => {
    const start = now;
    const cookie = await signIn();
    const fresh = await request({ path: '/', headers: { Cookie: cookie } });
    expect(fresh.headers['set-cookie']).toBeUndefined();
    now = start + 7 * 3_600_000; // 7 of 12 hours
    try {
      const later = await request({ path: '/', headers: { Cookie: cookie } });
      expect(later.status).toBe(200);
      expect(later.body).toContain('SECRET PAGE CONTENT');
      expect(String(later.headers['set-cookie'])).toMatch(/^ssg_gate=v1\./);
      now = start + 13 * 3_600_000; // the old one has run out
      expect(await opens(cookie)).toBe(false);
    } finally {
      now = start;
    }
  });
});

describe('sign-in wall: guessing', () => {
  it('slows a wrong password down and turns excess guesses away at once', async () => {
    const started = Date.now();
    const wrong = await request(form('wrong password number one'));
    expect(wrong.status).toBe(401);
    expect(Date.now() - started).toBeGreaterThanOrEqual(35); // held for the configured delay (40 ms in this test)
    const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => request(form(`wrong password burst ${i}`))));
    const codes = burst.map((r) => r.status);
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(4); // at most 3 held at once, plus any that finished meanwhile
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(8);
    for (const r of burst.filter((x) => x.status === 429)) expect(r.headers['retry-after']).toBe('2');
  });

  it('never makes the owner wait behind wrong guesses', async () => {
    const flood = Array.from({ length: 30 }, (_, i) => request(form(`flooding password ${i}`)));
    const started = Date.now();
    const mine = await request(form(PASSWORD));
    const took = Date.now() - started;
    expect(mine.status).toBe(303);
    expect(took).toBeLessThan(2_000);
    await Promise.all(flood);
  });
});

describe('a public gateway will not start without its protections', () => {
  it('refuses to listen on every interface without the wall', async () => {
    const root = await makeTempDir('ss3-gate-refuse-');
    try {
      await expect(startGateway({ port: 0, host: '0.0.0.0', upstreamPort: t.service.port, webRoot: root.dir, logger: silentLogger })).rejects.toThrow(/without an access password/);
    } finally {
      await root.cleanup();
    }
  });

  it('listens on every interface when the wall is on', async () => {
    const root = await makeTempDir('ss3-gate-public-');
    const g = await startGateway({
      port: 0,
      host: '0.0.0.0',
      upstreamPort: t.service.port,
      webRoot: root.dir,
      logger: silentLogger,
      gate: new AccessGate({ password: PASSWORD, secureCookie: true, logger: silentLogger }),
    });
    try {
      const address = g.server.address();
      expect(typeof address === 'object' && address?.address).toBe('0.0.0.0');
    } finally {
      await g.stop();
      await root.cleanup();
    }
  });

  it('puts a "__Host-" prefix and the Secure flag on the cookie of a public address', async () => {
    const gate = new AccessGate({ password: PASSWORD, secureCookie: true, logger: silentLogger });
    expect(gate.cookieName).toBe('__Host-ssg_gate');
    const cookie = gate.sessionCookie();
    expect(cookie).toMatch(/^__Host-ssg_gate=v1\./);
    expect(cookie).toContain('; Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toMatch(/Domain=/i); // "__Host-" cookies must not carry one
  });

  it('will not be built with a weak password', () => {
    expect(() => new AccessGate({ password: 'too short', secureCookie: false, logger: silentLogger })).toThrow(/at least 16/);
  });
});
