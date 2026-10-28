import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../src/logger.js';
import { writeFileAtomic } from '../src/storage/atomic-write.js';
import { makeScreenshotFilename, slugifyTitle } from '../src/storage/filename.js';
import { GalleryStore, type NewCapture } from '../src/storage/gallery-store.js';
import { readPngSize } from '../src/storage/png.js';
import { isReservedDeviceName, isSafeFileName, resolveInside, UnsafePathError, validateFolder } from '../src/storage/safe-path.js';
import { makePng, makeTempDir } from './helpers/tmp.js';

describe('validateFolder', () => {
  it.each(['', 'client-a', 'client-a/home pages', 'Ünïcode_ok (1)', 'a/b/c'])('accepts %j', (input) => {
    expect(validateFolder(input)).toBe(input.replace(/\\/g, '/'));
  });

  it('normalises backslashes, repeated and trailing separators, and trims', () => {
    expect(validateFolder('  a\\b  ')).toBe('a/b');
    expect(validateFolder('a//b')).toBe('a/b');
    expect(validateFolder('reports/')).toBe('reports');
    expect(validateFolder('a\\\\b\\')).toBe('a/b');
  });

  it('never returns an empty, "." or ".." segment', () => {
    for (const input of ['a//b', 'a/', 'a\\\\\\b', 'x/y/z/']) {
      const out = validateFolder(input);
      expect(out.split('/').every((s) => s !== '' && s !== '.' && s !== '..')).toBe(true);
    }
  });

  it.each([
    ['absolute drive path', 'C:\\Windows'],
    ['drive-relative path', 'C:foo'],
    ['rooted path', '\\\\server\\share'],
    ['leading slash', '/etc'],
    ['parent traversal', '../x'],
    ['embedded parent traversal', 'a/../../x'],
    ['trailing parent traversal', 'a/..'],
    ['dot segment', 'a/./b'],
    ['alternate data stream', 'a:stream'],
    ['reserved device', 'CON'],
    ['reserved device with extension', 'nul.txt'],
    ['reserved device nested', 'a/COM1'],
    ['trailing dot', 'abc.'],
    ['trailing space', 'abc /x'],
    ['too deep', 'a/b/c/d'],
    ['control character', 'a\u0007b'],
    ['wildcard', 'a*b'],
    ['angle brackets', 'a<b>'],
    ['pipe', 'a|b'],
    ['too long segment', 'x'.repeat(41)],
    ['too long overall', ('abcdefghij/'.repeat(20))],
  ])('rejects %s', (_label, input) => {
    expect(() => validateFolder(input)).toThrow(UnsafePathError);
  });
});

describe('file name rules', () => {
  it('recognises reserved device names', () => {
    for (const name of ['CON', 'con', 'Nul.txt', 'COM1', 'lpt9.png', 'AUX ']) expect(isReservedDeviceName(name)).toBe(true);
    for (const name of ['console', 'com10', 'my-con', 'a.con']) expect(isReservedDeviceName(name)).toBe(false);
  });

  it('isSafeFileName rejects separators, streams and trailing dots', () => {
    for (const name of ['a/b.png', 'a\\b.png', 'a:b.png', '..', 'x.png.', 'x.png ', 'a*.png', 'NUL.png', '']) {
      expect(isSafeFileName(name)).toBe(false);
    }
    expect(isSafeFileName('20261027-143005-123_example-domain_a1b2.png')).toBe(true);
  });

  it('slugifyTitle keeps letters of every script and strips the rest', () => {
    expect(slugifyTitle('Example Domain')).toBe('Example-Domain');
    expect(slugifyTitle('<>:"/\\|?* weird')).toBe('weird');
    expect(slugifyTitle('日本語のタイトル 🙂')).toBe('日本語のタイトル');
    expect(slugifyTitle('\u202Etxt.exe')).toBe('txt-exe');
    expect(slugifyTitle('   ')).toBe('');
    expect(Array.from(slugifyTitle('x'.repeat(400))).length).toBeLessThanOrEqual(60);
  });

  it('makeScreenshotFilename is unique, timestamped and short', () => {
    const at = new Date(2026, 9, 27, 14, 30, 5, 123);
    const a = makeScreenshotFilename({ title: 'Hello World', url: 'https://x.test', at, directoryLength: 40 });
    const b = makeScreenshotFilename({ title: 'Hello World', url: 'https://x.test', at, directoryLength: 40 });
    expect(a).toMatch(/^20261027-143005-123_Hello-World_[0-9a-f]{4}\.png$/);
    expect(isSafeFileName(a)).toBe(true);
    // Same millisecond and title still differ thanks to the random suffix (collision chance 1/65536 - retry once).
    const c = makeScreenshotFilename({ title: 'Hello World', url: 'https://x.test', at, directoryLength: 40 });
    expect(new Set([a, b, c]).size).toBeGreaterThan(1);
  });

  it('falls back to the host name when the title is empty or unusable', () => {
    const at = new Date(2026, 0, 2, 3, 4, 5, 6);
    expect(makeScreenshotFilename({ title: '', url: 'https://www.example.org/x', at, directoryLength: 30 })).toMatch(
      /^20260102-030405-006_www-example-org_[0-9a-f]{4}\.png$/,
    );
    expect(makeScreenshotFilename({ title: '???', url: 'not a url', at, directoryLength: 30 })).toMatch(
      /^20260102-030405-006_[0-9a-f]{4}\.png$/,
    );
  });

  it('keeps the full path under the limit for long directories', () => {
    const at = new Date();
    const name = makeScreenshotFilename({ title: 'y'.repeat(300), url: 'https://x.test', at, directoryLength: 200 });
    expect(200 + 1 + name.length).toBeLessThanOrEqual(240);
  });
});

describe('resolveInside', () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  beforeEach(async () => {
    tmp = await makeTempDir();
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it('resolves normal and not-yet-existing paths', async () => {
    const root = path.join(tmp.dir, 'root');
    await fs.mkdir(root);
    const p = await resolveInside(root, 'a', 'b.png');
    expect(p.startsWith(await fs.realpath(root))).toBe(true);
  });

  it('rejects traversal and absolute escapes', async () => {
    const root = path.join(tmp.dir, 'root');
    await fs.mkdir(root);
    await expect(resolveInside(root, '..', 'x')).rejects.toBeInstanceOf(UnsafePathError);
    // An absolute second segment replaces the root in path.resolve(); it must be caught as an escape.
    await expect(resolveInside(root, path.join(tmp.dir, 'outside.txt'))).rejects.toBeInstanceOf(UnsafePathError);
    await expect(resolveInside(root, 'a\0b')).rejects.toBeInstanceOf(UnsafePathError);
  });

  it('rejects a junction pointing outside the root', async () => {
    const root = path.join(tmp.dir, 'root');
    const outside = path.join(tmp.dir, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, 'link'), 'junction');
    await expect(resolveInside(root, 'link', 'file.png')).rejects.toBeInstanceOf(UnsafePathError);
  });
});

describe('writeFileAtomic', () => {
  it('replaces content and leaves no temp files behind', async () => {
    const tmp = await makeTempDir();
    try {
      const target = path.join(tmp.dir, 'f.json');
      await writeFileAtomic(target, 'one');
      await writeFileAtomic(target, 'two');
      expect(await fs.readFile(target, 'utf8')).toBe('two');
      expect(await fs.readdir(tmp.dir)).toEqual(['f.json']);
    } finally {
      await tmp.cleanup();
    }
  });

  it('survives many concurrent writers with a parseable result', async () => {
    const tmp = await makeTempDir();
    try {
      const target = path.join(tmp.dir, 'f.json');
      await Promise.all(Array.from({ length: 60 }, (_, i) => writeFileAtomic(target, JSON.stringify({ i }))));
      expect(() => JSON.parse(readFileSync(target, 'utf8'))).not.toThrow();
    } finally {
      await tmp.cleanup();
    }
  });
});

describe('png header', () => {
  it('reads the size of a PNG and rejects other data', () => {
    expect(readPngSize(makePng(37, 21))).toEqual({ width: 37, height: 21 });
    expect(readPngSize(Buffer.from('not a png at all, really not a png'))).toBeNull();
    expect(readPngSize(Buffer.alloc(10))).toBeNull();
  });
});

describe('GalleryStore', () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let dataDir: string;
  let screenshotsDir: string;

  beforeEach(async () => {
    tmp = await makeTempDir();
    dataDir = path.join(tmp.dir, 'data');
    screenshotsDir = path.join(tmp.dir, 'shots');
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  const open = () => GalleryStore.open({ dataDir, screenshotsDir, logger: silentLogger });

  const capture = (over: Partial<NewCapture> = {}): NewCapture => ({
    title: 'Example Domain',
    url: 'https://example.com/',
    finalUrl: 'https://example.com/',
    capturedAt: new Date(),
    screenshotMode: 'fullPage',
    httpStatus: 200,
    warnings: [],
    runId: 'run1',
    folder: '',
    png: makePng(40, 30),
    width: 40,
    height: 30,
    ...over,
  });

  it('starts empty and creates its folders', async () => {
    const store = await open();
    expect(store.list()).toEqual([]);
    expect((await fs.stat(screenshotsDir)).isDirectory()).toBe(true);
    expect((await fs.stat(dataDir)).isDirectory()).toBe(true);
  });

  it('adds a screenshot: file on disk, index entry, and survives a restart', async () => {
    const store = await open();
    const item = await store.add(capture());
    expect(item.status).toBe('success');
    expect(item.filename).toMatch(/Example-Domain.*\.png$/);
    expect(await fs.readFile(await store.imagePath(item))).toEqual(makePng(40, 30));

    const reopened = await open();
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.get(item.id)).toEqual(item);
  });

  it('marks captures with warnings and keeps sub-folders', async () => {
    const store = await open();
    const item = await store.add(capture({ folder: 'client-a/home', warnings: ['HTTP 404'], httpStatus: 404 }));
    expect(item.status).toBe('warning');
    expect(item.folder).toBe('client-a/home');
    expect((await fs.stat(await store.imagePath(item))).isFile()).toBe(true);
  });

  it('refuses an unsafe folder and writes nothing', async () => {
    const store = await open();
    await expect(store.add(capture({ folder: '../../evil' }))).rejects.toThrow();
    expect(store.list()).toHaveLength(0);
  });

  it('lists newest first', async () => {
    const store = await open();
    await store.add(capture({ title: 'old', capturedAt: new Date(2020, 0, 1) }));
    await store.add(capture({ title: 'new', capturedAt: new Date(2026, 0, 1) }));
    expect(store.list().map((i) => i.title)).toEqual(['new', 'old']);
  });

  it('removes items and their files; reports unknown ids', async () => {
    const store = await open();
    const a = await store.add(capture({ title: 'a' }));
    const b = await store.add(capture({ title: 'b' }));
    const file = await store.imagePath(a);
    const result = await store.remove([a.id, 'does-not-exist-1']);
    expect(result).toEqual({ deleted: 1, missing: ['does-not-exist-1'] });
    await expect(fs.access(file)).rejects.toThrow();
    expect(store.list().map((i) => i.id)).toEqual([b.id]);
    expect((await open()).list().map((i) => i.id)).toEqual([b.id]);
  });

  it('clear() removes everything', async () => {
    const store = await open();
    await store.add(capture({ title: 'a' }));
    await store.add(capture({ title: 'b' }));
    expect((await store.clear()).deleted).toBe(2);
    expect(store.list()).toEqual([]);
    expect((await open()).list()).toEqual([]);
    expect((await fs.readdir(screenshotsDir)).filter((n) => n.endsWith('.png'))).toEqual([]);
  });

  it('drops index entries whose file was deleted by hand', async () => {
    const store = await open();
    const a = await store.add(capture({ title: 'a' }));
    await store.add(capture({ title: 'b' }));
    await fs.rm(await store.imagePath(a));
    const reopened = await open();
    expect(reopened.list().map((i) => i.title)).toEqual(['b']);
  });

  it('quarantines a corrupt index and restores from the backup', async () => {
    const first = await open();
    await first.add(capture({ title: 'keep me' }));
    await open(); // a clean start writes index.json.bak
    await fs.writeFile(path.join(dataDir, 'index.json'), '{"version":1,"items":[ TRUNCATED');
    const recovered = await open();
    expect(recovered.list().map((i) => i.title)).toEqual(['keep me']);
    const names = await fs.readdir(dataDir);
    expect(names.some((n) => n.startsWith('index.corrupt-'))).toBe(true);
  });

  it('rebuilds from PNG files when the index and backup are both lost', async () => {
    const first = await open();
    await first.add(capture({ title: 'Lost Index Page' }));
    await fs.rm(path.join(dataDir, 'index.json'));
    await fs.rm(path.join(dataDir, 'index.json.bak'), { force: true });
    const rebuilt = await open();
    expect(rebuilt.list()).toHaveLength(1);
    const item = rebuilt.list()[0]!;
    expect(item.title).toBe('Lost Index Page'.replace(/ /g, ' '));
    expect(item.width).toBe(40);
    expect(item.status).toBe('warning');
  });

  it('ignores invalid entries (path traversal in a hand-edited index)', async () => {
    const store = await open();
    const good = await store.add(capture({ title: 'good' }));
    const evil = { ...good, id: 'evilevil1234', filename: '..\\..\\evil.png' };
    const evil2 = { ...good, id: 'evilevil5678', folder: '../outside' };
    await fs.writeFile(
      path.join(dataDir, 'index.json'),
      JSON.stringify({ version: 1, items: [good, evil, evil2] }),
    );
    const reopened = await open();
    expect(reopened.list().map((i) => i.id)).toEqual([good.id]);
  });

  it('serialises 50 concurrent adds into a consistent index', async () => {
    const store = await open();
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.add(capture({ title: `page ${i}` }))));
    expect(store.list()).toHaveLength(50);
    const onDisk = JSON.parse(await fs.readFile(path.join(dataDir, 'index.json'), 'utf8')) as { items: unknown[] };
    expect(onDisk.items).toHaveLength(50);
    expect((await open()).list()).toHaveLength(50);
  });
});
