import { describe, expect, it } from 'vitest';
import { clampScale, emulatedViewport, planZoomCapture, scaleFactor, zoomLevelFor } from '../src/browser/page-scale.js';

describe('clampScale', () => {
  it.each([
    [100, 100],
    [50, 50],
    [24, 25],
    [501, 500],
    [99.6, 100],
    [Number.NaN, 100],
    [Number.POSITIVE_INFINITY, 100],
    [-5, 25],
  ])('%s -> %s', (input, expected) => {
    expect(clampScale(input)).toBe(expected);
  });
});

describe('zoom maths', () => {
  it('100 % is level 0 and the factor is 1', () => {
    expect(zoomLevelFor(100)).toBeCloseTo(0, 10);
    expect(scaleFactor(100)).toBe(1);
  });

  it('uses the 1.2 ^ level scale that Chromium stores', () => {
    expect(1.2 ** zoomLevelFor(50)).toBeCloseTo(0.5, 10);
    expect(1.2 ** zoomLevelFor(200)).toBeCloseTo(2, 10);
    expect(zoomLevelFor(50)).toBeLessThan(0);
    expect(zoomLevelFor(200)).toBeGreaterThan(0);
  });
});

describe('emulatedViewport (headless)', () => {
  it.each([
    [50, 2560, 1440, 0.5],
    [100, 1280, 720, 1],
    [125, 1024, 576, 1.25],
    [200, 640, 360, 2],
    [25, 5120, 2880, 0.25],
    [500, 256, 144, 5],
  ])('%s %% of 1280x720 -> viewport %sx%s at ratio %s', (percent, w, h, dsf) => {
    expect(emulatedViewport({ width: 1280, height: 720 }, percent)).toEqual({ viewport: { width: w, height: h }, deviceScaleFactor: dsf });
  });

  it('keeps the viewport at least one pixel in each direction', () => {
    const v = emulatedViewport({ width: 1, height: 1 }, 500);
    expect(v.viewport.width).toBeGreaterThanOrEqual(1);
    expect(v.viewport.height).toBeGreaterThanOrEqual(1);
  });
});

/**
 * The numbers below were measured in Edge 155 on a display scaled to 250 % (nominal devicePixelRatio 2.5), maximized:
 *   zoom 100 % -> layout 1528x685, dpr 2.5
 *   zoom  50 % -> layout 3056x1370, dpr 1.25      (plain css screenshot: 6111x2739, a clip of layout*zoom: 3055x1370)
 *   zoom 200 % -> layout 764x342,  dpr 5          (plain css screenshot: 382x171)
 */
describe('planZoomCapture (headed)', () => {
  const at = (layoutWidth: number, layoutHeight: number, currentRatio: number) => ({ layoutWidth, layoutHeight, currentRatio, nominalRatio: 2.5 });

  it('100 %: the plain capture is already exact', () => {
    expect(planZoomCapture(at(1528, 685, 2.5))).toEqual({ kind: 'plain' });
  });

  it('50 % (zoomed out): clip to layout x 0.5', () => {
    const plan = planZoomCapture(at(3056, 1370, 1.25));
    expect(plan.kind).toBe('clip');
    if (plan.kind === 'clip') expect(plan.zoom).toBeCloseTo(0.5, 6);
  });

  it('75 % (zoomed out): clip to layout x 0.75', () => {
    const plan = planZoomCapture(at(2037, 913, 1.875));
    expect(plan.kind).toBe('clip');
    if (plan.kind === 'clip') expect(plan.zoom).toBeCloseTo(0.75, 6);
  });

  it('200 % (zoomed in): no exact method, reported as inexact with the true factor', () => {
    const plan = planZoomCapture(at(764, 342, 5));
    expect(plan.kind).toBe('inexact');
    if (plan.kind === 'inexact') expect(plan.zoom).toBeCloseTo(2, 6);
  });

  it('a tiny difference from 100 % (rounding) is treated as 100 %', () => {
    expect(planZoomCapture(at(1528, 685, 2.5 * 1.004))).toEqual({ kind: 'plain' });
  });

  it('survives nonsense input', () => {
    expect(planZoomCapture({ layoutWidth: 0, layoutHeight: 0, currentRatio: 0, nominalRatio: 0 })).toEqual({ kind: 'plain' });
    expect(planZoomCapture({ layoutWidth: 100, layoutHeight: 100, currentRatio: 1, nominalRatio: 0 })).toEqual({ kind: 'plain' });
  });
});
