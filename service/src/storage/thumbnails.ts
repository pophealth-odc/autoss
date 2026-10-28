import fs from 'node:fs/promises';
import type { Logger } from '../logger.js';
import { errorMessage } from '../errors.js';
import { writeFileAtomic } from './atomic-write.js';

/** Card thumbnails are the top of the page, cropped to a 16:10 box, so a tall page does not become an unreadable sliver. */
const THUMB_WIDTH = 480;
const THUMB_HEIGHT = 300;
const MAX_INPUT_PIXELS = 400_000_000; // ~ 1280 x 300 000

type Sharp = typeof import('sharp');

export class ThumbnailService {
  private sharp: Sharp['default'] | null = null;
  private loadAttempted = false;
  private readonly inflight = new Map<string, Promise<Buffer | null>>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly logger: Logger,
    private readonly maxParallel = 2,
  ) {}

  /** `sharp` is an optional dependency with a native binary. Without it the UI falls back to the full image. */
  async isAvailable(): Promise<boolean> {
    return (await this.load()) !== null;
  }

  private async load(): Promise<Sharp['default'] | null> {
    if (this.loadAttempted) return this.sharp;
    this.loadAttempted = true;
    try {
      const mod = await import('sharp');
      const sharp = mod.default;
      // Windows keeps files open while sharp caches them, which would block deleting a screenshot right after viewing it.
      sharp.cache(false);
      sharp.concurrency(2);
      this.sharp = sharp;
    } catch (error) {
      this.logger.warn('Thumbnails are unavailable (the optional "sharp" module could not be loaded). Full images are used instead.', {
        error: errorMessage(error).split('\n')[0],
      });
      this.sharp = null;
    }
    return this.sharp;
  }

  /**
   * Returns the JPEG thumbnail for a screenshot, creating and caching it on first use. Returns null if thumbnails are
   * unavailable or the image cannot be processed.
   */
  async get(id: string, sourcePng: string, cacheFile: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(cacheFile);
    } catch {
      /* not cached yet */
    }
    const existing = this.inflight.get(id);
    if (existing) return existing;
    const work = this.limited(() => this.create(sourcePng, cacheFile)).finally(() => this.inflight.delete(id));
    this.inflight.set(id, work);
    return work;
  }

  private async create(sourcePng: string, cacheFile: string): Promise<Buffer | null> {
    const sharp = await this.load();
    if (!sharp) return null;
    try {
      // Read into memory first, so no file handle stays open on the source after this call.
      const input = await fs.readFile(sourcePng);
      const jpeg = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
        // 'left top' keeps the start of the page (its title and navigation) in the crop; the default centres it horizontally.
        .resize({ width: THUMB_WIDTH, height: THUMB_HEIGHT, fit: 'cover', position: 'left top' })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 72, mozjpeg: false })
        .toBuffer();
      await writeFileAtomic(cacheFile, jpeg).catch(() => undefined);
      return jpeg;
    } catch (error) {
      this.logger.warn('Could not create a thumbnail', { error: errorMessage(error).split('\n')[0] });
      return null;
    }
  }

  private async limited<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxParallel) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}
