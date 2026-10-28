import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ApiError, describeFsError, errnoCode } from '../errors.js';
import type { Logger } from '../logger.js';
import type { DeleteResult, GalleryItem, ScreenshotMode } from '../shared/contract.js';
import { removeFile, removeStaleTempFiles, retryTransient, writeFileAtomic } from './atomic-write.js';
import { makeScreenshotFilename } from './filename.js';
import { readPngSize } from './png.js';
import { isSafeFileName, resolveInside, UnsafePathError, validateFolder } from './safe-path.js';

const INDEX_VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9_-]{8,32}$/;
/** Names produced by makeScreenshotFilename(); used to recognise our own files when rebuilding a lost index. */
const OWN_FILE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})(?:_(.*?))?(?:_[0-9a-f]{4})?\.png$/;
const MAX_SCAN_DEPTH = 3;

export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a date');

const itemSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  filename: z.string().refine(isSafeFileName, 'unsafe file name'),
  folder: z.string().refine((f) => {
    try {
      return validateFolder(f) === f;
    } catch {
      return false;
    }
  }, 'unsafe folder'),
  title: z.string().max(2_000),
  url: z.string().max(4_096),
  finalUrl: z.string().max(4_096),
  capturedAt: isoDate,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
  screenshotMode: z.enum(['fullPage', 'viewport']),
  status: z.enum(['success', 'warning']),
  httpStatus: z.number().int().nullable(),
  warnings: z.array(z.string().max(500)).max(20),
  runId: z.string().max(64),
});

const envelopeSchema = z.object({ version: z.number().int(), items: z.array(z.unknown()) });

export interface NewCapture {
  title: string;
  url: string;
  finalUrl: string;
  capturedAt: Date;
  screenshotMode: ScreenshotMode;
  httpStatus: number | null;
  warnings: string[];
  runId: string;
  /** Validated output sub-folder ('' = root of the screenshots directory). */
  folder: string;
  png: Buffer;
  width: number;
  height: number;
}

export interface GalleryStoreOptions {
  dataDir: string;
  screenshotsDir: string;
  logger: Logger;
}

export class GalleryStore {
  private readonly indexPath: string;
  private readonly backupPath: string;
  private readonly thumbsDir: string;
  private readonly items = new Map<string, GalleryItem>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly options: GalleryStoreOptions) {
    this.indexPath = path.join(options.dataDir, 'index.json');
    this.backupPath = path.join(options.dataDir, 'index.json.bak');
    this.thumbsDir = path.join(options.dataDir, 'thumbs');
  }

  static async open(options: GalleryStoreOptions): Promise<GalleryStore> {
    const store = new GalleryStore(options);
    await store.load();
    return store;
  }

  get screenshotsDir(): string {
    return this.options.screenshotsDir;
  }

  get thumbnailsDir(): string {
    return this.thumbsDir;
  }

  /** Newest first. */
  list(): GalleryItem[] {
    return [...this.items.values()].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  }

  get(id: string): GalleryItem | undefined {
    return this.items.get(id);
  }

  get count(): number {
    return this.items.size;
  }

  totalBytes(): number {
    let sum = 0;
    for (const item of this.items.values()) sum += item.bytes;
    return sum;
  }

  /** Absolute path of an item's PNG. Always inside the screenshots directory, also after following links. */
  async imagePath(item: GalleryItem): Promise<string> {
    try {
      return await resolveInside(this.options.screenshotsDir, item.folder, item.filename);
    } catch (error) {
      if (error instanceof UnsafePathError) throw new ApiError(404, 'not_found', 'The screenshot file is not available.');
      throw error;
    }
  }

  thumbnailPath(id: string): string {
    return path.join(this.thumbsDir, `${id}.jpg`);
  }

  /** Writes the PNG, then registers it in the index. Rolls the file back when the index cannot be saved. */
  async add(capture: NewCapture): Promise<GalleryItem> {
    const folder = validateFolder(capture.folder);
    try {
      await fs.mkdir(path.join(this.options.screenshotsDir, folder), { recursive: true });
      const dir = await resolveInside(this.options.screenshotsDir, folder);
      const filename = makeScreenshotFilename({
        title: capture.title,
        url: capture.finalUrl || capture.url,
        at: capture.capturedAt,
        directoryLength: dir.length,
      });
      await writeFileAtomic(path.join(dir, filename), capture.png);

      const item: GalleryItem = Object.freeze({
        id: randomBytes(9).toString('base64url'),
        filename,
        folder,
        title: capture.title,
        url: capture.url,
        finalUrl: capture.finalUrl,
        capturedAt: capture.capturedAt.toISOString(),
        width: capture.width,
        height: capture.height,
        bytes: capture.png.length,
        screenshotMode: capture.screenshotMode,
        status: capture.warnings.length > 0 ? ('warning' as const) : ('success' as const),
        httpStatus: capture.httpStatus,
        warnings: capture.warnings.slice(0, 20),
        runId: capture.runId,
      });

      try {
        await this.mutate(() => {
          this.items.set(item.id, item);
        });
      } catch (error) {
        await removeFile(path.join(dir, filename)).catch(() => undefined);
        throw error;
      }
      return item;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, 'storage_error', describeFsError(error, 'Could not save the screenshot'));
    }
  }

  /** Removes the given screenshots from the index and deletes their files. Unknown IDs are reported, not fatal. */
  async remove(ids: string[]): Promise<DeleteResult> {
    const wanted = [...new Set(ids)];
    const removed: GalleryItem[] = [];
    const missing: string[] = [];
    await this.mutate(() => {
      for (const id of wanted) {
        const item = this.items.get(id);
        if (item) {
          removed.push(item);
          this.items.delete(id);
        } else {
          missing.push(id);
        }
      }
    });
    await this.deleteFiles(removed);
    return { deleted: removed.length, missing };
  }

  async clear(): Promise<DeleteResult> {
    const removed: GalleryItem[] = [];
    await this.mutate(() => {
      removed.push(...this.items.values());
      this.items.clear();
    });
    await this.deleteFiles(removed);
    return { deleted: removed.length, missing: [] };
  }

  /** Runs `change` and persists the index. All changes are serialised, so concurrent callers never interleave. */
  private mutate(change: () => void): Promise<void> {
    const run = async () => {
      const snapshot = new Map(this.items);
      try {
        change();
        await this.save();
      } catch (error) {
        this.items.clear();
        for (const [id, item] of snapshot) this.items.set(id, item);
        throw error instanceof ApiError
          ? error
          : new ApiError(500, 'storage_error', describeFsError(error, 'Could not update the screenshot index'));
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async save(): Promise<void> {
    const body = JSON.stringify({ version: INDEX_VERSION, items: [...this.items.values()] }, null, 2);
    await writeFileAtomic(this.indexPath, body);
  }

  private async deleteFiles(items: GalleryItem[]): Promise<void> {
    for (const item of items) {
      try {
        await removeFile(await this.imagePath(item));
      } catch (error) {
        // The entry is already gone from the index; a leftover file is harmless and is only worth a warning.
        this.options.logger.warn(`Could not delete ${item.folder ? item.folder + '/' : ''}${item.filename}`, {
          error: describeFsError(error, 'delete'),
        });
      }
      await removeFile(this.thumbnailPath(item.id)).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Loading and recovery
  // ---------------------------------------------------------------------------------------------------------------

  private async load(): Promise<void> {
    await fs.mkdir(this.options.dataDir, { recursive: true });
    await fs.mkdir(this.options.screenshotsDir, { recursive: true });
    await fs.mkdir(this.thumbsDir, { recursive: true });
    await removeStaleTempFiles(this.options.dataDir);

    const primary = await this.readIndexFile(this.indexPath);
    let loaded = primary.items;
    let needsSave = false;

    if (primary.status === 'corrupt') {
      const quarantine = path.join(this.options.dataDir, `index.corrupt-${Date.now()}.json`);
      await retryTransient(() => fs.rename(this.indexPath, quarantine)).catch(() => undefined);
      this.options.logger.error(`The screenshot index was damaged. It was kept as ${path.basename(quarantine)}.`);
      const backup = await this.readIndexFile(this.backupPath);
      if (backup.status === 'ok') {
        this.options.logger.warn(`Restored ${backup.items.length} entries from the backup index.`);
        loaded = backup.items;
        needsSave = true;
      }
    }

    if (primary.status !== 'ok' && loaded.length === 0) {
      const recovered = await this.rebuildFromDisk();
      if (recovered.length > 0) {
        this.options.logger.warn(`Rebuilt ${recovered.length} gallery entries from the screenshot files on disk.`);
        loaded = recovered;
        needsSave = true;
      }
    }

    // Drop entries whose file has disappeared (deleted by hand).
    let dropped = 0;
    for (const item of loaded) {
      try {
        await fs.access(path.join(this.options.screenshotsDir, item.folder, item.filename));
        this.items.set(item.id, Object.freeze(item));
      } catch {
        dropped += 1;
      }
    }
    if (dropped > 0) {
      this.options.logger.warn(`${dropped} gallery entries were removed because their image file no longer exists.`);
      needsSave = true;
    }

    if (needsSave || primary.status === 'missing') await this.save();
    if (primary.status === 'ok' && !needsSave) {
      await fs.copyFile(this.indexPath, this.backupPath).catch(() => undefined);
    }
  }

  private async readIndexFile(file: string): Promise<{ status: 'ok' | 'missing' | 'corrupt'; items: GalleryItem[] }> {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return { status: 'missing', items: [] };
      throw error;
    }
    let envelope: z.infer<typeof envelopeSchema>;
    try {
      envelope = envelopeSchema.parse(JSON.parse(text.replace(/^﻿/, '')));
    } catch {
      return { status: 'corrupt', items: [] };
    }
    if (envelope.version > INDEX_VERSION) {
      throw new ApiError(
        500,
        'storage_error',
        `The screenshot index was written by a newer version of this program (index version ${envelope.version}).`,
      );
    }
    const items: GalleryItem[] = [];
    let invalid = 0;
    const seen = new Set<string>();
    for (const raw of envelope.items) {
      const parsed = itemSchema.safeParse(raw);
      if (parsed.success && !seen.has(parsed.data.id)) {
        seen.add(parsed.data.id);
        items.push(parsed.data);
      } else {
        invalid += 1;
      }
    }
    if (invalid > 0) this.options.logger.warn(`${invalid} invalid entries in ${path.basename(file)} were ignored.`);
    return { status: 'ok', items };
  }

  /** Builds minimal gallery entries from PNG files that look like ours. Used only when the index is lost. */
  private async rebuildFromDisk(): Promise<GalleryItem[]> {
    const found: GalleryItem[] = [];
    const walk = async (relativeDir: string, depth: number): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(path.join(this.options.screenshotsDir, relativeDir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
        if (entry.isDirectory() && depth < MAX_SCAN_DEPTH) {
          await walk(relative, depth + 1);
          continue;
        }
        const match = entry.isFile() ? OWN_FILE.exec(entry.name) : null;
        if (!match) continue;
        try {
          validateFolder(relativeDir);
          const full = path.join(this.options.screenshotsDir, relativeDir, entry.name);
          const stat = await fs.stat(full);
          const handle = await fs.open(full, 'r');
          let size;
          try {
            const head = Buffer.alloc(24);
            await handle.read(head, 0, 24, 0);
            size = readPngSize(head);
          } finally {
            await handle.close();
          }
          if (!size) continue;
          const [, y, mo, d, h, mi, s, ms, slug] = match;
          const stamped = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms));
          const title = (slug ?? '').replace(/-/g, ' ').trim();
          found.push({
            id: randomBytes(9).toString('base64url'),
            filename: entry.name,
            folder: relativeDir,
            title,
            url: '',
            finalUrl: '',
            capturedAt: (Number.isNaN(stamped.getTime()) ? stat.mtime : stamped).toISOString(),
            width: size.width,
            height: size.height,
            bytes: stat.size,
            screenshotMode: 'fullPage',
            status: 'warning',
            httpStatus: null,
            warnings: ['Recovered from the image file: the original address and details were lost.'],
            runId: 'recovered',
          });
        } catch {
          /* skip files that cannot be read */
        }
      }
    };
    await walk('', 0);
    return found;
  }
}
