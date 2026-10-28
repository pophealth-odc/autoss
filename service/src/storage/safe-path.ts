import fs from 'node:fs/promises';
import path from 'node:path';
import { errnoCode } from '../errors.js';
import { LIMITS } from '../shared/contract.js';

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

/** Windows device names are reserved with or without an extension ("CON", "con.txt", "COM1.png"). */
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;
/** Letters, digits, marks, space, dot, underscore, hyphen and round brackets. */
const FOLDER_SEGMENT = /^[\p{L}\p{M}\p{N} ._\-()]+$/u;
const MAX_FOLDER_DEPTH = 3;
const MAX_SEGMENT_LENGTH = 40;

export function isReservedDeviceName(name: string): boolean {
  return RESERVED_DEVICE.test((name.split('.')[0] ?? '').trimEnd());
}

/**
 * Validates a user-supplied output sub-folder ("" or "client-a/home-pages") and returns its normalised form with
 * forward slashes. Rejects absolute paths, drive letters, "..", alternate data streams, device names and odd characters.
 */
export function validateFolder(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') return '';
  if (trimmed.length > LIMITS.folderMaxLength) {
    throw new UnsafePathError(`The folder name is longer than ${LIMITS.folderMaxLength} characters.`);
  }
  if (/[\u0000-\u001f]/.test(trimmed)) throw new UnsafePathError('The folder name contains control characters.');
  if (/^[\\/]|^[a-z]:/i.test(trimmed)) {
    throw new UnsafePathError('Use a folder name relative to the screenshots folder, not an absolute path.');
  }

  // Repeated separators collapse ("a//b" -> "a/b", as Windows does) and a trailing one is ignored ("reports/").
  const segments = trimmed.replace(/[\\/]+$/, '').split(/[\\/]+/);
  if (segments.length > MAX_FOLDER_DEPTH) {
    throw new UnsafePathError(`Use at most ${MAX_FOLDER_DEPTH} nested folder levels.`);
  }
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new UnsafePathError('The folder name must not contain empty, "." or ".." parts.');
    }
    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw new UnsafePathError(`Each folder name part may have at most ${MAX_SEGMENT_LENGTH} characters.`);
    }
    if (!FOLDER_SEGMENT.test(segment)) {
      throw new UnsafePathError('Folder names may only contain letters, digits, spaces and . _ - ( ).');
    }
    if (/[ .]$/.test(segment) || /^ /.test(segment)) {
      throw new UnsafePathError('Folder names must not start with a space or end with a space or dot.');
    }
    if (isReservedDeviceName(segment)) {
      throw new UnsafePathError(`"${segment}" is a reserved Windows device name.`);
    }
  }
  return segments.join('/');
}

/** A file name as stored in the index: no separators, no drive/stream colon, no wildcards, no control characters. */
export function isSafeFileName(name: string): boolean {
  if (name.length === 0 || name.length > 200) return false;
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) return false;
  if (name === '.' || name === '..') return false;
  if (/[ .]$/.test(name)) return false;
  return !isReservedDeviceName(name);
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false; // different drive
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/**
 * Resolves `segments` below `root` and guarantees the result is inside `root`, also after following symbolic links
 * and junctions of every path component that already exists. The target itself does not have to exist.
 */
export async function resolveInside(root: string, ...segments: string[]): Promise<string> {
  for (const segment of segments) {
    if (segment.includes('\0')) throw new UnsafePathError('The path contains a NUL byte.');
  }
  const rootReal = await fs.realpath(root);
  const candidate = path.resolve(rootReal, ...segments);
  if (!isInside(rootReal, candidate)) throw new UnsafePathError('The path escapes the storage folder.');

  let probe = candidate;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (!isInside(rootReal, real)) throw new UnsafePathError('The path resolves outside the storage folder.');
      break;
    } catch (error) {
      if (error instanceof UnsafePathError) throw error;
      if (errnoCode(error) !== 'ENOENT') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
    }
  }
  return candidate;
}
