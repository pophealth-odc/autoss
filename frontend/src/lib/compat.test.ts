import { describe, expect, it } from 'vitest';
import type { ServiceHealth, StartAutomationRequest } from '../api/contract';
import { adaptRequest, explainUnknownSetting, isUnknownSettingError, RESTART_HINT, unknownSettingName } from './compat';

const health = (features?: ServiceHealth['features']): ServiceHealth => ({
  ok: true,
  service: 'screenshot-gallery-service',
  version: '1.0.0',
  apiVersion: 1,
  ...(features ? { features } : {}),
  authRequired: true,
  time: '2026-10-28T00:00:00.000Z',
});

const request = (pageScalePercent?: number): StartAutomationRequest => ({
  urls: ['https://example.com/'],
  mode: 'headless',
  ...(pageScalePercent === undefined ? {} : { pageScalePercent }),
});

describe('adaptRequest', () => {
  it('passes the request through unchanged to a current service', () => {
    const r = request(50);
    expect(adaptRequest(r, health(['pageScale', 'datePlaceholder']))).toEqual({ request: r, blocked: null, notice: null });
  });

  it('passes the request through before the first answer from the service', () => {
    const r = request(50);
    expect(adaptRequest(r, null)).toEqual({ request: r, blocked: null, notice: null });
  });

  it('leaves out a default page scale for an older service, so the run still works', () => {
    const adapted = adaptRequest(request(100), health()); // an older service sends no feature list at all
    expect(adapted.blocked).toBeNull();
    expect('pageScalePercent' in adapted.request).toBe(false);
    expect(adapted.request.urls).toEqual(['https://example.com/']);
  });

  it('also treats an old service with an empty feature list as having none', () => {
    expect('pageScalePercent' in adaptRequest(request(100), health([])).request).toBe(false);
  });

  it('refuses a non-default scale on an older service instead of quietly capturing at 100 %', () => {
    const adapted = adaptRequest(request(50), health());
    expect(adapted.blocked).toMatch(/older version/);
    expect(adapted.blocked).toContain('50%');
    expect(adapted.blocked).toContain(RESTART_HINT);
  });

  it('a request without any scale is fine for an older service', () => {
    const adapted = adaptRequest(request(), health());
    expect(adapted.blocked).toBeNull();
  });

  it('does not modify the object it was given', () => {
    const r = request(100);
    adaptRequest(r, health());
    expect(r.pageScalePercent).toBe(100);
  });
});

describe('recognising a service that does not know a setting', () => {
  it('matches the validation error the older service sent', () => {
    expect(isUnknownSettingError('validation_failed', 'Unrecognized key: "pageScalePercent"')).toBe(true);
    expect(isUnknownSettingError('validation_failed', 'Unrecognized keys: "a", "b"')).toBe(true);
  });

  it('does not match other validation errors or other codes', () => {
    expect(isUnknownSettingError('validation_failed', 'The page load timeout must be at least 1000.')).toBe(false);
    expect(isUnknownSettingError('bad_request', 'Unrecognized key: "x"')).toBe(false);
    expect(isUnknownSettingError('unauthorized', '')).toBe(false);
  });

  it('extracts the setting name', () => {
    expect(unknownSettingName('Unrecognized key: "pageScalePercent"')).toBe('pageScalePercent');
    expect(unknownSettingName('Unrecognized keys: "first", "second"')).toBe('first');
    expect(unknownSettingName('something else')).toBeNull();
  });

  it('explains page scale in plain words, and tells the person what to do', () => {
    const text = explainUnknownSetting('Unrecognized key: "pageScalePercent"');
    expect(text).toMatch(/older version/);
    expect(text).toMatch(/page scale/);
    expect(text).toContain(RESTART_HINT);
    expect(text).not.toContain('pageScalePercent');
  });

  it('still gives a useful message for a setting it does not know by name', () => {
    expect(explainUnknownSetting('Unrecognized key: "futureThing"')).toContain('"futureThing"');
    expect(explainUnknownSetting('Unrecognized key')).toMatch(/one of these settings/);
  });
});
