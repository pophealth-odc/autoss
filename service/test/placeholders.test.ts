import { describe, expect, it } from 'vitest';
import { expandUrlPlaceholders, hasUrlPlaceholder, parseUrlInput, parseUrlList, previousDay } from '../src/shared/url-input.js';

/** A local-time date, so the tests do not depend on the time zone of the machine that runs them. */
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);

describe('previousDay', () => {
  it.each([
    ['an ordinary day', at(2026, 10, 28), '2026-10-27'],
    ['the first of a month', at(2026, 11, 1), '2026-10-31'],
    ['the first of March (short February)', at(2026, 3, 1), '2026-02-28'],
    ['the first of March in a leap year', at(2028, 3, 1), '2028-02-29'],
    ['the first of January (year rollover)', at(2027, 1, 1), '2026-12-31'],
    ['one minute past midnight', at(2026, 10, 28, 0, 1), '2026-10-27'],
    ['one minute before midnight', at(2026, 10, 28, 23, 59), '2026-10-27'],
    ['single-digit month and day are zero-padded', at(2026, 2, 10), '2026-02-09'],
    ['a day that makes both parts single digit', at(2026, 1, 2), '2026-01-01'],
  ])('%s', (_label, now, expected) => {
    expect(previousDay(now)).toBe(expected);
  });

  it('always matches yyyy-MM-dd', () => {
    for (let i = 0; i < 400; i += 1) {
      const now = new Date(2026, 0, 1 + i, 3, 30);
      expect(previousDay(now)).toMatch(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
    }
  });

  it('is the local calendar day before, not the UTC one', () => {
    // 00:30 local time on the 28th is still the 27th in UTC for any zone ahead of UTC (such as UTC+8); yesterday is the 27th
    // either way, and the day before in UTC would be the 26th. The local calendar is what a person means by "yesterday".
    const justAfterMidnight = at(2026, 10, 28, 0, 30);
    expect(previousDay(justAfterMidnight)).toBe('2026-10-27');
    expect(previousDay(justAfterMidnight)).toBe(
      `${justAfterMidnight.getFullYear()}-${String(justAfterMidnight.getMonth() + 1).padStart(2, '0')}-${String(justAfterMidnight.getDate() - 1).padStart(2, '0')}`,
    );
  });
});

describe('expandUrlPlaceholders', () => {
  const now = at(2026, 10, 28);

  it('replaces the placeholder with yesterday', () => {
    expect(expandUrlPlaceholders('https://x.test/?d={$prevday}', now)).toBe('https://x.test/?d=2026-10-27');
  });

  it('replaces every occurrence, wherever it is', () => {
    expect(expandUrlPlaceholders('https://x.test/{$prevday}/a?from={$prevday}T00:00&to={$prevday}T23:59', now)).toBe(
      'https://x.test/2026-10-27/a?from=2026-10-27T00:00&to=2026-10-27T23:59',
    );
  });

  it('accepts any letter case, and the percent-encoded spelling a browser produces', () => {
    expect(expandUrlPlaceholders('{$PrevDay} {$PREVDAY} %7B%24prevday%7D %7b%24PrevDay%7d', now)).toBe('2026-10-27 2026-10-27 2026-10-27 2026-10-27');
  });

  it('leaves text without the placeholder untouched, and similar-looking text too', () => {
    for (const text of ['https://x.test/?d=2026-10-27', '{$today}', '{prevday}', '$prevday', '{$prevday', '{$prev day}', '{ $prevday }', '']) {
      expect(expandUrlPlaceholders(text, now)).toBe(text);
    }
  });

  it('does not treat the replacement as a pattern (no accidental $ expansion)', () => {
    expect(expandUrlPlaceholders('a{$prevday}b', now)).toBe('a2026-10-27b');
  });

  it('can be called repeatedly (no leftover regex state)', () => {
    for (let i = 0; i < 5; i += 1) expect(expandUrlPlaceholders('{$prevday}', now)).toBe('2026-10-27');
    expect(hasUrlPlaceholder('{$prevday}')).toBe(true);
    expect(hasUrlPlaceholder('{$prevday}')).toBe(true);
    expect(hasUrlPlaceholder('nothing here')).toBe(false);
  });
});

describe('placeholders in parsed addresses', () => {
  const now = at(2026, 10, 28);

  it('parseUrlInput accepts an address that is only valid after the replacement', () => {
    const r = parseUrlInput('https://x.test/report/{$prevday}', 2048, now);
    expect(r).toEqual({ ok: true, url: 'https://x.test/report/2026-10-27' });
  });

  it('a placeholder in the host name is replaced before validation', () => {
    expect(parseUrlInput('https://{$prevday}.x.test/', 2048, now)).toEqual({ ok: true, url: 'https://2026-10-27.x.test/' });
  });

  it('text that merely looks like a placeholder is not replaced', () => {
    expect(parseUrlInput('https://x.test/{$today}', 2048, now)).toEqual({ ok: true, url: 'https://x.test/%7B$today%7D' });
  });

  it('parseUrlList applies it to every line and to duplicates after the replacement', () => {
    const result = parseUrlList(['https://x.test/?d={$prevday}', 'https://x.test/?d=2026-10-27', '# https://x.test/?d={$prevday}&skip=1', 'https://x.test/b?d={$prevday}'].join('\n'), 2048, now);
    expect(result.urls).toEqual(['https://x.test/?d=2026-10-27', 'https://x.test/b?d=2026-10-27']);
    expect(result.duplicates).toBe(1); // the second line is the same address once the placeholder is replaced
    expect(result.errors).toEqual([]);
  });

  it('the length limit applies to the address AFTER the replacement', () => {
    const result = parseUrlInput('https://x.test/{$prevday}', 24, now); // "https://x.test/2026-10-27" is 25 characters
    expect(result.ok).toBe(false);
  });
});

describe('the two Dynatrace default addresses', () => {
  const now = at(2026, 10, 28);
  const base = 'https://aaj23525.live.dynatrace.com/ui/problems?gtf={$prevday}T00:00:00%2B08:00%20to%20{$prevday}T23:59:00%2B08:00&gf=3826532857493469977';

  it('reproduces the addresses from the request when run on 2026-10-28', () => {
    const open = parseUrlInput(base, 2048, now);
    const closed = parseUrlInput(`${base}&status=CLOSED`, 2048, now);
    expect(open).toEqual({
      ok: true,
      url: 'https://aaj23525.live.dynatrace.com/ui/problems?gtf=2026-10-27T00:00:00%2B08:00%20to%202026-10-27T23:59:00%2B08:00&gf=3826532857493469977',
    });
    expect(closed).toEqual({
      ok: true,
      url: 'https://aaj23525.live.dynatrace.com/ui/problems?gtf=2026-10-27T00:00:00%2B08:00%20to%202026-10-27T23:59:00%2B08:00&gf=3826532857493469977&status=CLOSED',
    });
  });

  it('keeps the encoded plus sign and the encoded spaces exactly as written', () => {
    const r = parseUrlInput(base, 2048, now);
    expect(r.ok && r.url).toContain('%2B08:00');
    expect(r.ok && r.url).toContain('%20to%20');
    expect(r.ok && r.url).not.toMatch(/[ +]/);
  });

  it('follows the calendar: the next day the same list asks for the new yesterday', () => {
    const next = parseUrlInput(base, 2048, at(2026, 10, 29));
    expect(next.ok && next.url).toContain('gtf=2026-10-28T00:00:00%2B08:00%20to%202026-10-28T23:59:00%2B08:00');
  });

  it('the two addresses are different from each other and both survive de-duplication', () => {
    const result = parseUrlList(`${base}\n${base}&status=CLOSED`, 2048, now);
    expect(result.urls).toHaveLength(2);
    expect(result.duplicates).toBe(0);
  });
});
