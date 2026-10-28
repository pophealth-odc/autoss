import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, AutomationStatus, GalleryItem, GalleryListResponse } from '../src/shared/contract.js';
import { okCapture, startTestService, untilAborted, waitFor, type FakeBrowser, type TestService } from './helpers/service.js';
import { makePng } from './helpers/tmp.js';

let t: TestService & { fake: FakeBrowser };

beforeEach(async () => {
  t = await startTestService();
});
afterEach(async () => {
  await t.cleanup();
});

const json = { 'Content-Type': 'application/json' };
const sha = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');

async function seed(n: number, title = (i: number) => `Page ${i}`): Promise<GalleryItem[]> {
  const items: GalleryItem[] = [];
  for (let i = 0; i < n; i += 1) {
    items.push(
      await t.service.store.add({
        title: title(i),
        url: `https://example.com/p${i}`,
        finalUrl: `https://example.com/p${i}`,
        capturedAt: new Date(2026, 0, 1, 12, 0, i),
        screenshotMode: 'fullPage',
        httpStatus: 200,
        warnings: [],
        runId: 'seed',
        folder: '',
        png: makePng(20 + i, 10 + i, [i * 20 % 255, 100, 200]),
        width: 20 + i,
        height: 10 + i,
      }),
    );
  }
  return items;
}

async function runToEnd(body: object): Promise<AutomationStatus> {
  const start = await t.api('/api/automation/start', { method: 'POST', headers: json, body: JSON.stringify(body) });
  expect(start.status).toBe(202);
  return waitFor(async () => {
    const s = (await (await t.api('/api/automation/status')).json()) as AutomationStatus;
    return s.active ? false : s;
  }, 8_000, 'run to finish');
}

describe('gallery endpoints', () => {
  it('lists, serves, downloads and deletes screenshots', async () => {
    const [a, b] = await seed(2);
    const list = (await (await t.api('/api/gallery')).json()) as GalleryListResponse;
    expect(list.total).toBe(2);
    expect(list.items.map((i) => i.id)).toEqual([b!.id, a!.id]); // newest first
    expect(list.totalBytes).toBe(a!.bytes + b!.bytes);

    const img = await t.api(`/api/gallery/${a!.id}/image`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(sha(Buffer.from(await img.arrayBuffer()))).toBe(sha(makePng(20, 10, [0, 100, 200])));

    const dl = await t.api(`/api/gallery/${a!.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment; filename="[^"]+\.png"; filename\*=UTF-8''/);
    expect(dl.headers.get('cache-control')).toBe('no-store');
    await dl.arrayBuffer();

    const del = await t.api(`/api/gallery/${a!.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(((await (await t.api('/api/gallery')).json()) as GalleryListResponse).total).toBe(1);
    expect((await t.api(`/api/gallery/${a!.id}/image`)).status).toBe(404);
    expect((await t.api(`/api/gallery/${a!.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('rejects ids that are not valid, without touching the filesystem', async () => {
    for (const id of ['..', '..%2F..%2Fwindows', 'a b', 'x'.repeat(100), '%00']) {
      const r = await t.api(`/api/gallery/${id}/image`);
      expect(r.status, id).toBe(404);
    }
  });

  it('serves a thumbnail (JPEG when sharp is available) and caches it', async () => {
    const [a] = await seed(1);
    const r = await t.api(`/api/gallery/${a!.id}/thumbnail`);
    expect(r.status).toBe(200);
    const type = r.headers.get('content-type');
    expect(['image/jpeg', 'image/png']).toContain(type);
    const bytes = Buffer.from(await r.arrayBuffer());
    if (type === 'image/jpeg') {
      expect(bytes.subarray(0, 2).toString('hex')).toBe('ffd8');
      await fs.access(t.service.store.thumbnailPath(a!.id));
    }
  });

  it('deletes several at once and reports unknown ids', async () => {
    const items = await seed(3);
    const r = await t.api('/api/gallery/delete', { method: 'POST', headers: json, body: JSON.stringify({ ids: [items[0]!.id, items[1]!.id, 'unknownid123'] }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ deleted: 2, missing: ['unknownid123'] });
    expect(t.service.store.count).toBe(1);
    const bad = await t.api('/api/gallery/delete', { method: 'POST', headers: json, body: JSON.stringify({ ids: [] }) });
    expect(bad.status).toBe(400);
  });

  it('refuses to clear the gallery without confirmation, and clears it with it', async () => {
    await seed(2);
    const refused = await t.api('/api/gallery', { method: 'DELETE' });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as ApiErrorBody).error.code).toBe('confirmation_required');
    expect(t.service.store.count).toBe(2);

    const ok = await t.api('/api/gallery?confirm=true', { method: 'DELETE' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ deleted: 2, missing: [] });
    expect(t.service.store.count).toBe(0);
  });

  it('survives a restart of the service', async () => {
    const [a] = await seed(1, () => 'Persistent');
    await t.service.stop();
    const again = await startTestService();
    try {
      // A second service on a fresh directory is empty; re-open the original data to prove persistence.
      expect(again.service.store.count).toBe(0);
    } finally {
      await again.cleanup();
    }
    const { GalleryStore } = await import('../src/storage/gallery-store.js');
    const { silentLogger } = await import('../src/logger.js');
    const reopened = await GalleryStore.open({ dataDir: t.config.dataDir, screenshotsDir: t.config.screenshotsDir, logger: silentLogger });
    expect(reopened.get(a!.id)?.title).toBe('Persistent');
    t = { ...t, service: { ...t.service, stop: async () => undefined } };
  });
});

describe('ZIP download', () => {
  it('downloads the whole gallery as a ZIP that extracts to identical files plus index.csv', async () => {
    const items = await seed(4, (i) => (i === 2 ? '日本語のタイトル 🙂' : `Café Ünï ${i}`));
    const r = await t.api('/api/gallery/download-zip', { method: 'POST', headers: json, body: '{}' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/zip');
    expect(r.headers.get('content-disposition')).toMatch(/screenshots-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.zip/);
    const zip = Buffer.from(await r.arrayBuffer());
    expect(zip.subarray(0, 4).toString('hex')).toBe('504b0304');

    const zipPath = path.join(t.dir, 'out.zip');
    await fs.writeFile(zipPath, zip);
    const extractDir = path.join(t.dir, 'extracted');
    await fs.mkdir(extractDir);
    // Windows' built-in tar is the least forgiving extractor; if it can read every name, the archive is portable.
    execFileSync('tar', ['-xf', zipPath, '-C', extractDir]);

    const names = (await fs.readdir(extractDir)).sort();
    expect(names).toHaveLength(5);
    expect(names).toContain('index.csv');
    const pngs = names.filter((n) => n.endsWith('.png'));
    expect(pngs.every((n) => /^[\x20-\x7e]+$/.test(n))).toBe(true);

    const originals = new Map<string, string>();
    for (const item of items) originals.set(sha(await fs.readFile(await t.service.store.imagePath(item))), item.title);
    for (const name of pngs) expect(originals.has(sha(await fs.readFile(path.join(extractDir, name)))), name).toBe(true);

    const csv = await fs.readFile(path.join(extractDir, 'index.csv'), 'utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('日本語のタイトル 🙂');
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(5);
  });

  it('downloads only the selected screenshots', async () => {
    const items = await seed(4);
    const r = await t.api('/api/gallery/download-zip', { method: 'POST', headers: json, body: JSON.stringify({ ids: [items[1]!.id, items[3]!.id] }) });
    expect(r.status).toBe(200);
    const zipPath = path.join(t.dir, 'sel.zip');
    await fs.writeFile(zipPath, Buffer.from(await r.arrayBuffer()));
    const out = execFileSync('tar', ['-tf', zipPath], { encoding: 'utf8' });
    expect(out.split(/\r?\n/).filter((l) => l.endsWith('.png'))).toHaveLength(2);
  });

  it('gives colliding titles distinct names', async () => {
    await seed(3, () => 'Same Title');
    const r = await t.api('/api/gallery/download-zip', { method: 'POST', headers: json, body: '{}' });
    const zipPath = path.join(t.dir, 'dup.zip');
    await fs.writeFile(zipPath, Buffer.from(await r.arrayBuffer()));
    const names = execFileSync('tar', ['-tf', zipPath], { encoding: 'utf8' }).split(/\r?\n/).filter((l) => l.endsWith('.png'));
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(3);
  });

  it('errors clearly for an empty gallery and for unknown selections', async () => {
    const empty = await t.api('/api/gallery/download-zip', { method: 'POST', headers: json, body: '{}' });
    expect(empty.status).toBe(404);
    await seed(1);
    const unknown = await t.api('/api/gallery/download-zip', { method: 'POST', headers: json, body: JSON.stringify({ ids: ['nonexistent1'] }) });
    expect(unknown.status).toBe(404);
    const invalid = await t.api('/api/gallery/download-zip', { method: 'POST', headers: json, body: JSON.stringify({ ids: 'all' }) });
    expect(invalid.status).toBe(400);
  });

  it('leaves out files that disappeared, instead of failing', async () => {
    const items = await seed(3);
    await fs.rm(await t.service.store.imagePath(items[1]!));
    const r = await t.api('/api/gallery/download-zip', { method: 'POST', headers: json, body: '{}' });
    expect(r.status).toBe(200);
    const zipPath = path.join(t.dir, 'gone.zip');
    await fs.writeFile(zipPath, Buffer.from(await r.arrayBuffer()));
    const names = execFileSync('tar', ['-tf', zipPath], { encoding: 'utf8' }).split(/\r?\n/).filter((l) => l.endsWith('.png'));
    expect(names).toHaveLength(2);
  });
});

describe('automation start validation', () => {
  const start = (body: unknown) => t.api('/api/automation/start', { method: 'POST', headers: json, body: JSON.stringify(body) });

  it('rejects bad input with field-level details', async () => {
    const r = await start({ urls: ['not a url', 'javascript:alert(1)', 'ftp://x.test', 'https://u:p@x.test/'], pageTimeoutMs: 5 });
    expect(r.status).toBe(400);
    const body = (await r.json()) as ApiErrorBody;
    expect(body.error.code).toBe('validation_failed');
    expect(JSON.stringify(body.error.details)).toContain('urls.1');
    expect(t.fake.launched).toHaveLength(0);
  });

  it.each([
    ['no urls', { urls: [] }],
    ['unknown field', { urls: ['https://example.com'], evil: true }],
    ['wrong browser', { urls: ['https://example.com'], browser: 'chrome' }],
    ['timeout too small', { urls: ['https://example.com'], pageTimeoutMs: 10 }],
    ['maxPages zero', { urls: ['https://example.com'], maxPages: 0 }],
    ['absolute output folder', { urls: ['https://example.com'], outputFolder: 'C:\\Windows' }],
    ['traversal output folder', { urls: ['https://example.com'], outputFolder: '..\\..\\x' }],
    ['manual login headless', { urls: ['https://example.com'], mode: 'headless', manualLogin: true }],
    ['bad profile name', { urls: ['https://example.com'], persistentProfile: true, profileName: '..\\x' }],
  ])('rejects: %s', async (_label, body) => {
    const r = await start(body);
    expect(r.status).toBe(400);
  });
});

describe('automation lifecycle (fake browser)', () => {
  it('runs URLs sequentially, saves screenshots, reports progress and finishes', async () => {
    const status = await runToEnd({
      urls: ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'],
      delayBetweenPagesMs: 0,
      extraWaitMs: 0,
    });
    expect(status.state).toBe('completed');
    expect(status).toMatchObject({ total: 3, completed: 3, succeeded: 3, failed: 0, percent: 100, active: false });
    expect(t.fake.pages).toEqual(['https://example.com/a', 'https://example.com/b', 'https://example.com/c']);
    expect(t.fake.closed).toBe(1);
    expect(t.service.store.count).toBe(3);
  });

  it('passes the chosen settings to the browser', async () => {
    await runToEnd({ urls: ['https://example.com/a'], mode: 'headed', persistentProfile: true, profileName: 'work', ignoreCertificateErrors: true, viewportWidth: 1000, viewportHeight: 600, extraWaitMs: 0 });
    const launched = t.fake.launched[0]!;
    expect(launched.mode).toBe('headed');
    // The requested size is still passed along; the real browser ignores it for headed runs (its window is maximized).
    expect(launched.viewport).toEqual({ width: 1000, height: 600 });
    expect(launched.ignoreCertificateErrors).toBe(true);
    expect(launched.profileDir).toBe(path.join(t.config.profilesDir, 'work'));
  });

  it('uses a temporary profile by default', async () => {
    await runToEnd({ urls: ['https://example.com/a'], extraWaitMs: 0 });
    expect(t.fake.launched[0]!.profileDir).toBeNull();
  });

  it('records failures, keeps going, and counts them accurately', async () => {
    t.fake.behave = (url) => (url.endsWith('/bad') ? { ok: false, kind: 'dns', message: 'The web address could not be found.' } : undefined);
    const status = await runToEnd({ urls: ['https://example.com/a', 'https://example.com/bad', 'https://example.com/c'], delayBetweenPagesMs: 0, extraWaitMs: 0 });
    expect(status.state).toBe('completed');
    expect(status).toMatchObject({ total: 3, completed: 3, succeeded: 2, failed: 1, percent: 100 });
    expect(status.failures).toHaveLength(1);
    expect(status.failures[0]).toMatchObject({ url: 'https://example.com/bad', kind: 'dns' });
    expect(t.service.store.count).toBe(2);
  });

  it('stores captures with warnings as "warning" items', async () => {
    t.fake.behave = (url) => okCapture(url, { httpStatus: 404, warnings: ['The server answered with HTTP status 404.'] });
    await runToEnd({ urls: ['https://example.com/missing'], extraWaitMs: 0 });
    const item = t.service.store.list()[0]!;
    expect(item.status).toBe('warning');
    expect(item.httpStatus).toBe(404);
  });

  it('stop keeps screenshots already captured and ends as "stopped"', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    t.fake.gate = async (url, signal) => {
      if (!url.endsWith('/b')) return;
      await Promise.race([blocked, untilAborted(signal)]);
    };
    await t.api('/api/automation/start', { method: 'POST', headers: json, body: JSON.stringify({ urls: ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'], delayBetweenPagesMs: 0, extraWaitMs: 0 }) });
    await waitFor(() => t.fake.pages.includes('https://example.com/b'), 5_000, 'second page to start');
    expect(t.service.store.count).toBe(1);

    const stop = await t.api('/api/automation/stop', { method: 'POST' });
    expect(stop.status).toBe(200);
    expect(((await stop.json()) as AutomationStatus).state).toBe('stopping');

    const final = await waitFor(async () => {
      const s = (await (await t.api('/api/automation/status')).json()) as AutomationStatus;
      return s.active ? false : s;
    });
    release();
    expect(final.state).toBe('stopped');
    expect(final.succeeded).toBe(1);
    expect(final.message).toMatch(/1 screenshot saved/);
    expect(t.service.store.count).toBe(1);
    expect(t.fake.pages).not.toContain('https://example.com/c');
    expect(t.fake.closed).toBe(1);
  });

  it('refuses a second start while running, and stop when idle', async () => {
    const idleStop = await t.api('/api/automation/stop', { method: 'POST' });
    expect(idleStop.status).toBe(409);
    expect(((await idleStop.json()) as ApiErrorBody).error.code).toBe('not_running');

    let release!: () => void;
    t.fake.gate = () => new Promise<void>((r) => (release = r));
    await t.api('/api/automation/start', { method: 'POST', headers: json, body: JSON.stringify({ urls: ['https://example.com/a'], extraWaitMs: 0 }) });
    const second = await t.api('/api/automation/start', { method: 'POST', headers: json, body: JSON.stringify({ urls: ['https://example.com/b'] }) });
    expect(second.status).toBe(409);
    release();
    await waitFor(async () => !((await (await t.api('/api/automation/status')).json()) as AutomationStatus).active || undefined);
  });

  it('reports an Edge launch failure as an error and stays idle', async () => {
    const { ApiError } = await import('../src/errors.js');
    t.fake.failLaunchWith = new ApiError(400, 'edge_not_found', 'Microsoft Edge was not found.');
    const r = await t.api('/api/automation/start', { method: 'POST', headers: json, body: JSON.stringify({ urls: ['https://example.com/a'] }) });
    expect(r.status).toBe(400);
    expect(((await r.json()) as ApiErrorBody).error.code).toBe('edge_not_found');
    const status = (await (await t.api('/api/automation/status')).json()) as AutomationStatus;
    expect(status.active).toBe(false);
    expect(status.state).toBe('failed');
    expect(status.message).toMatch(/Edge was not found/);
    // And a new run can start afterwards.
    t.fake.failLaunchWith = undefined;
    expect((await runToEnd({ urls: ['https://example.com/a'], extraWaitMs: 0 })).state).toBe('completed');
  });

  it('ends cleanly when the browser disappears mid-run', async () => {
    t.fake.gate = async (url, signal) => {
      if (!url.endsWith('/b')) return;
      t.fake.triggerBrowserLoss();
      await untilAborted(signal);
    };
    const status = await runToEnd({ urls: ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'], mode: 'headed', delayBetweenPagesMs: 0, extraWaitMs: 0 });
    expect(status.state).toBe('stopped');
    expect(status.message).toMatch(/window was closed/);
    expect(status.succeeded).toBe(1);
    expect(t.service.store.count).toBe(1);
  });

  it('blocks local addresses when private targets are not allowed', async () => {
    const own = await startTestService({ env: { ALLOW_PRIVATE_TARGETS: 'false' } });
    try {
      const status = await (async () => {
        await own.api('/api/automation/start', { method: 'POST', headers: json, body: JSON.stringify({ urls: ['http://127.0.0.1:8080/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://localhost/', 'http://192.168.1.1/'], extraWaitMs: 0, delayBetweenPagesMs: 0 }) });
        return waitFor(async () => {
          const s = (await (await own.api('/api/automation/status')).json()) as AutomationStatus;
          return s.active ? false : s;
        });
      })();
      expect(status.failed).toBe(5);
      expect(status.failures.every((f) => f.kind === 'blocked')).toBe(true);
      expect(own.fake.pages).toEqual([]);
    } finally {
      await own.cleanup();
    }
  });

  it('follows links within the page budget and the same-origin rule', async () => {
    t.fake.behave = (url) => {
      if (url === 'https://example.com/') {
        return okCapture(url, { links: ['https://example.com/one', 'https://example.com/two', 'https://other.test/x', 'https://example.com/three', 'https://example.com/#frag'] });
      }
      return undefined;
    };
    const status = await runToEnd({ urls: ['https://example.com/'], followLinks: true, maxPages: 3, sameOrigin: true, delayBetweenPagesMs: 0, extraWaitMs: 0 });
    expect(t.fake.pages).toEqual(['https://example.com/', 'https://example.com/one', 'https://example.com/two']);
    expect(status).toMatchObject({ total: 3, completed: 3, percent: 100 });
  });

  it('can follow cross-origin links when same-origin is switched off', async () => {
    t.fake.behave = (url) => (url === 'https://example.com/' ? okCapture(url, { links: ['https://other.test/x'] }) : undefined);
    await runToEnd({ urls: ['https://example.com/'], followLinks: true, maxPages: 5, sameOrigin: false, delayBetweenPagesMs: 0, extraWaitMs: 0 });
    expect(t.fake.pages).toContain('https://other.test/x');
  });

  it('never captures a page twice', async () => {
    t.fake.behave = (url) => okCapture(url, { links: ['https://example.com/', 'https://example.com/a', 'https://example.com/b#x', 'https://example.com/b'] });
    await runToEnd({ urls: ['https://example.com/', 'https://example.com/a'], followLinks: true, maxPages: 10, delayBetweenPagesMs: 0, extraWaitMs: 0 });
    expect(new Set(t.fake.pages).size).toBe(t.fake.pages.length);
    expect(t.fake.pages.sort()).toEqual(['https://example.com/', 'https://example.com/a', 'https://example.com/b']);
  });

  it('manual login waits for Continue', async () => {
    const start = await t.api('/api/automation/start', { method: 'POST', headers: json, body: JSON.stringify({ urls: ['https://example.com/a'], mode: 'headed', manualLogin: true, extraWaitMs: 0 }) });
    expect(start.status).toBe(202);
    await waitFor(async () => ((await (await t.api('/api/automation/status')).json()) as AutomationStatus).state === 'waiting-for-login' || undefined);
    expect(t.fake.pages).toEqual([]);
    const cont = await t.api('/api/automation/continue', { method: 'POST' });
    expect(cont.status).toBe(200);
    const final = await waitFor(async () => {
      const s = (await (await t.api('/api/automation/status')).json()) as AutomationStatus;
      return s.active ? false : s;
    });
    expect(final.state).toBe('completed');
    expect(t.fake.pages).toEqual(['https://example.com/a']);
  });

  it('manual login can be stopped while waiting', async () => {
    await t.api('/api/automation/start', { method: 'POST', headers: json, body: JSON.stringify({ urls: ['https://example.com/a'], mode: 'headed', manualLogin: true }) });
    await waitFor(async () => ((await (await t.api('/api/automation/status')).json()) as AutomationStatus).state === 'waiting-for-login' || undefined);
    await t.api('/api/automation/stop', { method: 'POST' });
    const final = await waitFor(async () => {
      const s = (await (await t.api('/api/automation/status')).json()) as AutomationStatus;
      return s.active ? false : s;
    });
    expect(final.state).toBe('stopped');
    expect(t.fake.closed).toBe(1);
  });
});

describe('event stream (SSE)', () => {
  async function openStream(headers: Record<string, string> = {}) {
    const controller = new AbortController();
    const res = await t.api('/api/events', { headers, signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events: Array<{ id: string | null; type: string; data: unknown }> = [];
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let id: string | null = null;
            let type = 'message';
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('id: ')) id = line.slice(4);
              else if (line.startsWith('event: ')) type = line.slice(7);
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (data) events.push({ id, type, data: JSON.parse(data) });
          }
        }
      } catch {
        /* aborted */
      }
    })();
    return { res, events, close: () => { controller.abort(); return pump; } };
  }

  it('sends hello and the current state first, with the right headers', async () => {
    const s = await openStream();
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get('content-type')).toContain('text/event-stream');
    expect(s.res.headers.get('cache-control')).toContain('no-cache');
    await waitFor(() => s.events.length >= 2 || undefined);
    expect(s.events.map((e) => e.type)).toEqual(['hello', 'state']);
    await s.close();
  });

  it('streams state and capture events during a run, and gallery events on delete', async () => {
    const s = await openStream();
    await waitFor(() => s.events.length >= 2 || undefined);
    await runToEnd({ urls: ['https://example.com/a', 'https://example.com/b'], delayBetweenPagesMs: 0, extraWaitMs: 0 });
    await waitFor(() => s.events.filter((e) => e.type === 'capture').length === 2 || undefined, 5_000, 'two capture events');
    const states = s.events.filter((e) => e.type === 'state').map((e) => (e.data as AutomationStatus).state);
    expect(states).toContain('starting');
    expect(states).toContain('running');
    expect(states.at(-1)).toBe('completed');
    const captures = s.events.filter((e) => e.type === 'capture').map((e) => (e.data as GalleryItem).url);
    expect(captures).toEqual(['https://example.com/a', 'https://example.com/b']);

    const first = t.service.store.list()[0]!;
    await t.api(`/api/gallery/${first.id}`, { method: 'DELETE' });
    const del = await waitFor(() => s.events.find((e) => e.type === 'gallery') || undefined);
    expect(del.data).toMatchObject({ reason: 'deleted', ids: [first.id] });
    await s.close();
  });

  it('replays missed captures after a reconnect with Last-Event-ID', async () => {
    const first = await openStream();
    await waitFor(() => first.events.length >= 2 || undefined);
    await first.close();
    await runToEnd({ urls: ['https://example.com/a', 'https://example.com/b'], delayBetweenPagesMs: 0, extraWaitMs: 0 });
    const second = await openStream({ 'Last-Event-ID': '0' });
    await waitFor(() => second.events.filter((e) => e.type === 'capture').length === 2 || undefined, 5_000, 'replayed captures');
    await second.close();
  });

  it('frees the client slot when the browser tab disconnects', async () => {
    const streams = await Promise.all(Array.from({ length: 5 }, () => openStream()));
    await waitFor(() => t.service.hub.clientCount === 5 || undefined);
    await Promise.all(streams.map((s) => s.close()));
    await waitFor(() => t.service.hub.clientCount === 0 || undefined, 5_000, 'streams to be released');
  });
});
