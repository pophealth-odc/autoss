import { randomBytes } from 'node:crypto';

const MAX_SLUG_CHARS = 60;
const FIXED_PART = 'YYYYMMDD-HHmmss-SSS'.length + 1 + 1 + 4 + '.png'.length; // stamp _ ... _ rand .png
/** Stay well below the classic 260 character Windows path limit. */
const MAX_FULL_PATH = 240;

/** Local time stamp "20261027-143005-123". */
export function timestampForFilename(date: Date): string {
  const p = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}-${p(date.getMilliseconds(), 3)}`
  );
}

/**
 * Turns a page title into a safe file name fragment: letters, marks and digits of any script survive, everything else
 * (path characters, emoji, bidirectional control characters, punctuation) becomes a single hyphen.
 */
export function slugifyTitle(title: string, maxChars = MAX_SLUG_CHARS): string {
  const slug = title
    .normalize('NFKC')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return Array.from(slug).slice(0, Math.max(0, maxChars)).join('').replace(/-+$/, '');
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export interface FilenameInput {
  title: string;
  url: string;
  at: Date;
  /** Absolute length of the directory the file will be placed in; used to keep the full path short enough. */
  directoryLength: number;
}

/** "20261027-143005-123_example-domain_a1b2.png", unique thanks to the millisecond stamp plus a random suffix. */
export function makeScreenshotFilename(input: FilenameInput): string {
  const budget = Math.min(MAX_SLUG_CHARS, MAX_FULL_PATH - input.directoryLength - 1 - FIXED_PART);
  let slug = slugifyTitle(input.title, budget);
  if (slug === '') slug = slugifyTitle(hostnameOf(input.url), budget);
  const stamp = timestampForFilename(input.at);
  const random = randomBytes(2).toString('hex');
  return slug === '' ? `${stamp}_${random}.png` : `${stamp}_${slug}_${random}.png`;
}
