import fs from 'node:fs/promises';
import path from 'node:path';
import { ApiError, errnoCode } from '../errors.js';
import { LIMITS, type ProfileInfo } from '../shared/contract.js';
import { isInside, isReservedDeviceName } from '../storage/safe-path.js';

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/;

export function validateProfileName(name: string): string {
  const trimmed = name.trim();
  if (!PROFILE_NAME.test(trimmed) || trimmed.length > LIMITS.profileNameMax || isReservedDeviceName(trimmed) || /[ ]$/.test(trimmed)) {
    throw new ApiError(
      400,
      'validation_failed',
      `The profile name must start with a letter or digit and contain at most ${LIMITS.profileNameMax} letters, digits, spaces, "_" or "-".`,
    );
  }
  return trimmed;
}

/** Directory of a named profile. The name is validated first, so the result is always directly inside `profilesDir`. */
export function profileDir(profilesDir: string, name: string): string {
  const dir = path.join(profilesDir, validateProfileName(name));
  if (!isInside(profilesDir, dir) || path.dirname(dir) !== path.resolve(profilesDir)) {
    throw new ApiError(400, 'validation_failed', 'Invalid profile name.');
  }
  return dir;
}

/** Edge keeps `lockfile` open exclusively while a browser uses the profile; opening it then fails with EBUSY. */
export async function isProfileInUse(dir: string): Promise<boolean> {
  try {
    const handle = await fs.open(path.join(dir, 'lockfile'), 'r+');
    await handle.close();
    return false;
  } catch (error) {
    return errnoCode(error) === 'EBUSY' || errnoCode(error) === 'EPERM' || errnoCode(error) === 'EACCES';
  }
}

async function directorySize(dir: string, depth = 0): Promise<number> {
  if (depth > 8) return 0;
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) total += await directorySize(full, depth + 1);
      else if (entry.isFile()) total += (await fs.stat(full)).size;
    } catch {
      /* file vanished or is locked */
    }
  }
  return total;
}

export async function listProfiles(profilesDir: string): Promise<ProfileInfo[]> {
  let entries;
  try {
    entries = await fs.readdir(profilesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const profiles: ProfileInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !PROFILE_NAME.test(entry.name)) continue;
    const dir = path.join(profilesDir, entry.name);
    const stat = await fs.stat(dir).catch(() => null);
    profiles.push({
      name: entry.name,
      bytes: await directorySize(dir),
      modifiedAt: stat ? stat.mtime.toISOString() : null,
    });
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

export async function deleteProfile(profilesDir: string, name: string): Promise<boolean> {
  const dir = profileDir(profilesDir, name);
  const exists = await fs.stat(dir).then(() => true, () => false);
  if (!exists) return false;
  if (await isProfileInUse(dir)) {
    throw new ApiError(409, 'profile_in_use', `The profile "${name}" is in use by a running browser. Stop the run first.`);
  }
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return true;
}
