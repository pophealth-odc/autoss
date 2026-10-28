import { describe, expect, it } from 'vitest';
import { formatBytes, formatDimensions, formatDuration, hostOf, plural, safeFileName, shortUrl } from './format';

describe('formatting', () => {
  it('formats byte sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(20_971_520)).toBe('20.0 MB');
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });

  it('formats pixel dimensions with grouping', () => {
    expect(formatDimensions(1280, 20_000)).toBe('1,280 × 20,000 px');
  });

  it('formats durations', () => {
    expect(formatDuration(4_200)).toBe('4 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
  });

  it('shortens URLs without the scheme and tolerates garbage', () => {
    expect(shortUrl('https://example.com/')).toBe('example.com');
    expect(shortUrl('https://example.com/a/b?x=1')).toBe('example.com/a/b?x=1');
    expect(shortUrl('https://example.com/' + 'a'.repeat(200), 30)).toHaveLength(30);
    expect(shortUrl('not a url')).toBe('not a url');
    expect(hostOf('https://sub.example.com:8080/x')).toBe('sub.example.com:8080');
    expect(hostOf('nope')).toBe('nope');
  });

  it('pluralises', () => {
    expect(plural(1, 'screenshot')).toBe('1 screenshot');
    expect(plural(0, 'screenshot')).toBe('0 screenshots');
    expect(plural(1234, 'page')).toBe('1,234 pages');
    expect(plural(2, 'duplicate address', 'duplicate addresses')).toBe('2 duplicate addresses');
  });

  it('makes safe file names', () => {
    expect(safeFileName('a<b>:"c"/d\\e|f?g*')).toBe('a-b-c-d-e-f-g-');
    expect(safeFileName('  trailing dots...  ')).toBe('trailing dots');
    expect(safeFileName('', 'fallback')).toBe('fallback');
    expect(safeFileName('x'.repeat(300))).toHaveLength(120);
  });
});
