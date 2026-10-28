import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { errnoCode } from '../errors.js';
import { sleep } from '../util/abort.js';

/** Windows reports EPERM/EBUSY/EACCES while antivirus, search indexing or a reader holds a file for a few milliseconds. */
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

export async function retryTransient<T>(operation: () => Promise<T>, attempts = 6, baseDelayMs = 25): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = errnoCode(error);
      if (attempt >= attempts - 1 || code === undefined || !TRANSIENT.has(code)) throw error;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
}

/** Concurrent renames onto one destination fail with EPERM on Windows, so writers to the same file take turns. */
const targetLocks = new Map<string, Promise<unknown>>();

function withTargetLock<T>(target: string, work: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(target);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const previous = targetLocks.get(key) ?? Promise.resolve();
  const run = previous.then(work, work);
  const tail = run.catch(() => undefined);
  targetLocks.set(key, tail);
  void tail.then(() => {
    if (targetLocks.get(key) === tail) targetLocks.delete(key);
  });
  return run;
}

/**
 * Writes `data` to a temporary file next to `target`, flushes it to disk and renames it over `target`.
 * Readers therefore see either the complete old file or the complete new file, never a partial one.
 * Calls for the same `target` run one after another.
 */
export function writeFileAtomic(target: string, data: Buffer | string, options: { mode?: number } = {}): Promise<void> {
  return withTargetLock(target, () => writeFileAtomicNow(target, data, options));
}

async function writeFileAtomicNow(target: string, data: Buffer | string, options: { mode?: number }): Promise<void> {
  const dir = path.dirname(target);
  const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const handle = await fs.open(temp, 'wx', options.mode ?? 0o644);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await retryTransient(() => fs.rename(temp, target));
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Deletes a file; a missing file counts as success. Retries while Windows reports it as busy. */
export async function removeFile(target: string): Promise<void> {
  try {
    await retryTransient(() => fs.unlink(target));
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') throw error;
  }
}

/** Removes leftovers of interrupted atomic writes (".name.123.abcd.tmp") older than `olderThanMs`. */
export async function removeStaleTempFiles(dir: string, olderThanMs = 60 * 60 * 1000): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - olderThanMs;
  for (const name of entries) {
    if (!/^\..+\.\d+\.[0-9a-f]{8}\.tmp$/.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const stat = await fs.stat(full);
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        await fs.rm(full, { force: true });
        removed += 1;
      }
    } catch {
      /* already gone */
    }
  }
  return removed;
}
