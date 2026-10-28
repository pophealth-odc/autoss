/**
 * Parsing of user-typed web addresses. Pure functions without Node or DOM dependencies beyond the global `URL`.
 *
 * IMPORTANT: `service/src/shared/url-input.ts` and `frontend/src/api/url-input.ts` must stay byte-identical
 * (checked by `service/test/contract-sync.test.ts`). The service re-validates everything it receives.
 */

export type UrlParseResult = { ok: true; url: string } | { ok: false; error: string };

export interface UrlListLineError {
  /** 1-based line number in the text the user typed. */
  line: number;
  text: string;
  error: string;
}

export interface UrlListParseResult {
  urls: string[];
  errors: UrlListLineError[];
  /** Number of lines that repeated an address that was already in the list. */
  duplicates: number;
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
/** host[:port][/path?query#hash] without a scheme. Deliberately rejects "javascript:x", "mailto:x", "C:\x" and "user@host". */
const SCHEMELESS = /^[^\s/?#:@\\]+(:\d{1,5})?([/?#]\S*)?$/;

export function parseUrlInput(raw: string, maxLength = 2048, now: Date = new Date()): UrlParseResult {
  // The placeholder is replaced first: "{" and "$" are not allowed in many parts of an address, so a check run before the
  // replacement would reject a perfectly good "…?from={$prevday}".
  const input = expandUrlPlaceholders(raw, now).trim();
  if (input === '') return { ok: false, error: 'The address is empty.' };
  if (input.length > maxLength) return { ok: false, error: `The address is longer than ${maxLength} characters.` };

  let candidate = input;
  if (!HAS_SCHEME.test(candidate)) {
    if (!SCHEMELESS.test(candidate)) {
      return { ok: false, error: 'Not a valid web address. Use a full address such as https://example.com/page.' };
    }
    candidate = `https://${candidate}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, error: 'Not a valid web address. Use a full address such as https://example.com/page.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only http:// and https:// addresses are supported.' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: 'Addresses containing a user name or password are not allowed.' };
  }
  if (url.hostname === '') return { ok: false, error: 'The address has no host name.' };
  return { ok: true, url: url.href };
}

/**
 * One address per line. Blank lines and lines starting with "#" are ignored. Duplicates are dropped. `{$prevday}` is replaced
 * with yesterday's date (yyyy-MM-dd) before each address is checked, so the same list stays current from day to day.
 * `now` is the moment the list is read, not when it was written.
 */
export function parseUrlList(text: string, maxLength = 2048, now: Date = new Date()): UrlListParseResult {
  const urls: string[] = [];
  const errors: UrlListLineError[] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  text.split(/\r\n|\r|\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) return;
    const parsed = parseUrlInput(line, maxLength, now);
    if (!parsed.ok) {
      errors.push({ line: index + 1, text: line, error: parsed.error });
      return;
    }
    if (seen.has(parsed.url)) {
      duplicates += 1;
      return;
    }
    seen.add(parsed.url);
    urls.push(parsed.url);
  });

  return { urls, errors, duplicates };
}

/**
 * The placeholder that stands for yesterday's date inside a web address. Case does not matter, and the percent-encoded
 * spelling is accepted too because that is how a browser copies it out of an address bar.
 */
const PREVDAY_PLACEHOLDER = /\{\$prevday\}|%7B%24prevday%7D/gi;

/**
 * The calendar date of the day before `now` as yyyy-MM-dd, in the computer's own time zone.
 * UTC would be wrong here: in a zone such as UTC+8 the UTC date is still "yesterday" for the first eight hours of every day.
 */
export function previousDay(now: Date = new Date()): string {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(day.getFullYear(), 4)}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/** True when the text contains the {$prevday} placeholder. */
export function hasUrlPlaceholder(text: string): boolean {
  return new RegExp(PREVDAY_PLACEHOLDER.source, 'i').test(text);
}

/** Replaces every {$prevday} with yesterday's date (yyyy-MM-dd). Text without the placeholder is returned unchanged. */
export function expandUrlPlaceholders(text: string, now: Date = new Date()): string {
  return text.replace(PREVDAY_PLACEHOLDER, previousDay(now));
}
