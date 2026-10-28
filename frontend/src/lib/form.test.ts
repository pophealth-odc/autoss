import { describe, expect, it } from 'vitest';
import { buildRequest, DEFAULT_FORM, FORM_VERSION, isFormState, mergeForm, toSavedForm, type FormState } from './form';

const form = (patch: Partial<FormState> = {}): FormState => ({ ...DEFAULT_FORM, urlText: 'https://example.com', ...patch });

describe('buildRequest', () => {
  it('turns a valid form into a request', () => {
    const { request, issues } = buildRequest(form({ initialUrl: 'example.org', urlText: 'https://example.com\nhttps://example.net/a', pageTimeoutSec: 20, extraWaitSec: 0.5, delayBetweenPagesSec: 0 }));
    expect(issues).toEqual([]);
    expect(request).toMatchObject({
      urls: ['https://example.org/', 'https://example.com/', 'https://example.net/a'],
      mode: 'headless',
      screenshotMode: 'fullPage',
      pageTimeoutMs: 20_000,
      extraWaitMs: 500,
      delayBetweenPagesMs: 0,
      followLinks: false,
      sameOrigin: true,
    });
  });

  it('combines the initial URL and the list, and removes duplicates', () => {
    const { urls, parse } = buildRequest(form({ initialUrl: 'https://example.com', urlText: 'https://example.com\n# comment\n\nhttps://example.com/' }));
    expect(urls).toEqual(['https://example.com/']);
    expect(parse.duplicates).toBe(2);
  });

  it('reports every bad line with its number, and still lists the good ones', () => {
    const { request, issues, urls } = buildRequest(form({ urlText: 'https://ok.test\nnot a url\njavascript:alert(1)\nftp://x.test' }));
    expect(request).toBeNull();
    expect(urls).toEqual(['https://ok.test/']);
    expect(issues.map((i) => i.message).join(' ')).toMatch(/Line 2.*Line 3.*Line 4/);
  });

  it('requires at least one address', () => {
    const { request, issues } = buildRequest(form({ urlText: '   \n# only a comment', initialUrl: '' }));
    expect(request).toBeNull();
    expect(issues[0]).toMatchObject({ field: 'urls', message: 'Add at least one web address.' });
  });

  it.each([
    ['timeout too small', { pageTimeoutSec: 0.1 }, 'pageTimeoutSec'],
    ['timeout too large', { pageTimeoutSec: 500 }, 'pageTimeoutSec'],
    ['timeout not a number', { pageTimeoutSec: Number.NaN }, 'pageTimeoutSec'],
    ['negative wait', { extraWaitSec: -1 }, 'extraWaitSec'],
    ['negative delay', { delayBetweenPagesSec: -1 }, 'delayBetweenPagesSec'],
    ['bad profile name', { persistentProfile: true, profileName: '..\\x' }, 'profileName'],
    ['manual login in headless mode', { manualLogin: true, mode: 'headless' as const }, 'manualLogin'],
    ['zero pages when following links', { followLinks: true, maxPages: 0 }, 'maxPages'],
    ['fractional pages when following links', { followLinks: true, maxPages: 2.5 }, 'maxPages'],
  ])('rejects: %s', (_label, patch, field) => {
    const { request, issues } = buildRequest(form(patch));
    expect(request).toBeNull();
    expect(issues.some((i) => i.field === field)).toBe(true);
  });

  it('ignores the page limit unless links are followed, and sizes it to the list', () => {
    const { request } = buildRequest(form({ urlText: 'https://a.test\nhttps://b.test', followLinks: false, maxPages: 0 }));
    expect(request?.maxPages).toBe(2);
  });

  it('keeps the page limit when links are followed', () => {
    const { request } = buildRequest(form({ followLinks: true, maxPages: 7 }));
    expect(request).toMatchObject({ followLinks: true, maxPages: 7 });
  });

  it('only sends a profile name when a profile is used', () => {
    expect(buildRequest(form({ persistentProfile: false, profileName: 'work' })).request?.profileName).toBe('default');
    expect(buildRequest(form({ persistentProfile: true, profileName: ' work ' })).request?.profileName).toBe('work');
  });

  it('caps the number of addresses', () => {
    const many = Array.from({ length: 501 }, (_, i) => `https://example.com/${i}`).join('\n');
    const { request, issues } = buildRequest(form({ urlText: many }));
    expect(request).toBeNull();
    expect(issues[0]?.message).toMatch(/At most 500/);
  });
});

describe('saved form state', () => {
  it('validates the saved shape', () => {
    expect(isFormState(DEFAULT_FORM)).toBe(true);
    expect(isFormState({ ...DEFAULT_FORM, mode: 'invisible' })).toBe(false);
    expect(isFormState(null)).toBe(false);
    expect(isFormState('x')).toBe(false);
  });

  it('merges a partial older form over the defaults', () => {
    expect(mergeForm({ urlText: 'https://x.test' })).toEqual({ ...DEFAULT_FORM, urlText: 'https://x.test' });
    expect(mergeForm(null)).toEqual(DEFAULT_FORM);
  });

  it('accepts a form saved before page scale existed', () => {
    const { pageScalePercent: _removed, ...old } = DEFAULT_FORM;
    expect(isFormState(old)).toBe(true);
    expect(mergeForm(old).pageScalePercent).toBe(100);
    expect(isFormState({ ...DEFAULT_FORM, pageScalePercent: 'wide' })).toBe(false);
  });
});

describe('default addresses', () => {
  const day = new Date(2026, 9, 28, 9, 30); // 28 October 2026, local time

  it('a new form starts with the two Dynatrace problem views, written with {$prevday}', () => {
    const lines = DEFAULT_FORM.urlText.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('https://aaj23525.live.dynatrace.com/ui/problems?gtf={$prevday}T00:00:00%2B08:00%20to%20{$prevday}T23:59:00%2B08:00&gf=3826532857493469977');
    expect(lines[1]).toBe(`${lines[0]}&status=CLOSED`);
  });

  it('the defaults become yesterday\'s addresses when the list is read', () => {
    const { request, issues, urls } = buildRequest(DEFAULT_FORM, day);
    expect(issues).toEqual([]);
    expect(urls).toEqual([
      'https://aaj23525.live.dynatrace.com/ui/problems?gtf=2026-10-27T00:00:00%2B08:00%20to%202026-10-27T23:59:00%2B08:00&gf=3826532857493469977',
      'https://aaj23525.live.dynatrace.com/ui/problems?gtf=2026-10-27T00:00:00%2B08:00%20to%202026-10-27T23:59:00%2B08:00&gf=3826532857493469977&status=CLOSED',
    ]);
    expect(request?.urls).toEqual(urls);
  });

  it('the date follows the day the list is read, not the day it was typed', () => {
    const tomorrow = new Date(2026, 9, 29, 0, 5);
    expect(buildRequest(DEFAULT_FORM, tomorrow).urls[0]).toContain('gtf=2026-10-28T00:00:00');
  });

  it('a form saved before the defaults existed gets them once if its list was empty', () => {
    expect(mergeForm({ urlText: '', initialUrl: '' }).urlText).toBe(DEFAULT_FORM.urlText);
    expect(mergeForm({}).urlText).toBe(DEFAULT_FORM.urlText);
  });

  it('...but never overwrites addresses the person already had', () => {
    expect(mergeForm({ urlText: 'https://mine.test' }).urlText).toBe('https://mine.test');
    expect(mergeForm({ urlText: '', initialUrl: 'https://mine.test' }).urlText).toBe('');
  });

  it('once the form has a version, an empty list stays empty (clearing it is respected)', () => {
    expect(mergeForm({ urlText: '', initialUrl: '', formVersion: FORM_VERSION }).urlText).toBe('');
    expect(mergeForm(toSavedForm({ ...DEFAULT_FORM, urlText: '' })).urlText).toBe('');
  });

  it('saving writes the current version, and the version never leaks into the form itself', () => {
    expect(toSavedForm(DEFAULT_FORM).formVersion).toBe(FORM_VERSION);
    expect('formVersion' in mergeForm(toSavedForm(DEFAULT_FORM))).toBe(false);
  });
});

describe('page scale', () => {
  it('is sent to the service as a whole number of percent', () => {
    expect(buildRequest(form({ pageScalePercent: 80 })).request?.pageScalePercent).toBe(80);
    expect(buildRequest(form()).request?.pageScalePercent).toBe(100);
  });

  it.each([25, 100, 500])('%s is accepted', (value) => {
    expect(buildRequest(form({ pageScalePercent: value })).issues).toEqual([]);
  });

  it.each([
    [24, 'below the minimum'],
    [501, 'above the maximum'],
    [0, 'zero'],
    [-50, 'negative'],
    [99.5, 'fractional'],
    [Number.NaN, 'empty'],
  ])('%s is rejected (%s)', (value) => {
    const { request, issues } = buildRequest(form({ pageScalePercent: value }));
    expect(request).toBeNull();
    expect(issues.some((i) => i.field === 'pageScalePercent')).toBe(true);
  });
});
