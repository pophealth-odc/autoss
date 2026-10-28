import fs from 'node:fs/promises';
import path from 'node:path';
import { LIMITS } from '../shared/contract.js';

/**
 * "Page scale" works like the zoom of the browser itself (Ctrl + / Ctrl -): at 50 % twice as much of a page fits on screen,
 * at 200 % half as much, drawn larger.
 *
 *  - Headless has no window, so the scale is emulated: the page is laid out in a viewport of `size / scale` CSS pixels and
 *    drawn at `scale` device pixels per CSS pixel. Layout, media queries and screenshots then behave as they do in a zoomed
 *    browser.
 *  - Headed runs use Edge's own zoom. Emulating it inside a real window would leave empty space or clip the page.
 *    Playwright has no zoom API, so the zoom is set the way Edge stores it: the default zoom level of the profile.
 */

/** Edge/Chromium zoom levels are exponents: scale = 1.2 ^ level. */
const ZOOM_BASE = 1.2;

export function clampScale(percent: number): number {
  const { min, max } = LIMITS.pageScalePercent;
  if (!Number.isFinite(percent)) return LIMITS.pageScalePercent.default;
  return Math.min(max, Math.max(min, Math.round(percent)));
}

export function scaleFactor(percent: number): number {
  return clampScale(percent) / 100;
}

/** The zoom level Chromium stores for a scale factor (0 = 100 %). */
export function zoomLevelFor(percent: number): number {
  return Math.log(scaleFactor(percent)) / Math.log(ZOOM_BASE);
}

export interface EmulatedViewport {
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
}

/** Viewport and device scale factor that make a headless page behave like a browser zoomed to `percent`. */
export function emulatedViewport(base: { width: number; height: number }, percent: number): EmulatedViewport {
  const factor = scaleFactor(percent);
  return {
    viewport: {
      width: Math.max(1, Math.round(base.width / factor)),
      height: Math.max(1, Math.round(base.height / factor)),
    },
    deviceScaleFactor: factor,
  };
}

export interface ZoomGeometry {
  /** The page's layout size in CSS pixels (`innerWidth` x `innerHeight`). */
  layoutWidth: number;
  layoutHeight: number;
  /** `devicePixelRatio` now, and the ratio of the same screen at 100 % zoom. Their quotient is the zoom factor Edge applied. */
  currentRatio: number;
  nominalRatio: number;
}

export type ZoomCapturePlan =
  /** Plain `scale: 'css'` capture is already exact. */
  | { kind: 'plain' }
  /** Ask for a region of `layout x zoom` so Playwright's own conversion lands on the layout size (zoomed out only). */
  | { kind: 'clip'; zoom: number }
  /** No exact method exists; capture plainly and tell the user the image is not at the layout size. */
  | { kind: 'inexact'; zoom: number };

/**
 * Playwright converts a "CSS pixel" screenshot with the screen's nominal pixel ratio, not with the ratio of the zoomed page, so
 * in a zoomed real window the image is off by exactly the zoom factor. Measured in Edge: a clip of `layout x zoom` corrects it
 * when zoomed out; zoomed in, the clip is clamped to the visible region and no cheap exact method exists.
 */
export function planZoomCapture(g: ZoomGeometry): ZoomCapturePlan {
  // devicePixelRatio scales WITH the zoom, not against it: zoomed to 50 % a 2.5 screen reports 1.25, zoomed to 200 % it
  // reports 5. The page's zoom is therefore simply current / nominal (measured in Edge 155).
  const zoom = g.nominalRatio > 0 && g.currentRatio > 0 ? g.currentRatio / g.nominalRatio : 1;
  if (Math.abs(zoom - 1) < 0.01) return { kind: 'plain' };
  return zoom < 1 ? { kind: 'clip', zoom } : { kind: 'inexact', zoom };
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Sets Edge's default zoom for a profile by editing `<profile>/Default/Preferences` BEFORE the browser starts, keeping every
 * other preference. A missing or unreadable file is replaced. Only call this while no browser uses the profile: a running
 * Edge rewrites the file when it exits.
 */
export async function writeDefaultZoom(profileDir: string, percent: number): Promise<void> {
  const dir = path.join(profileDir, 'Default');
  const file = path.join(dir, 'Preferences');
  await fs.mkdir(dir, { recursive: true });

  let prefs: JsonObject = {};
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (isObject(parsed)) prefs = parsed;
  } catch {
    /* no preferences yet, or damaged: start from an empty set */
  }

  const partition = isObject(prefs['partition']) ? prefs['partition'] : {};
  const zoom = isObject(partition['default_zoom_level']) ? partition['default_zoom_level'] : {};
  // Chromium keeps a level per partition; "x" is the default one. 100 % is stored as an absent/zero level.
  const level = zoomLevelFor(percent);
  // A zoom Edge remembered for one website OVERRIDES the default (measured: with a saved 80 % for a site, a requested 50 % or
  // 100 % still gave the 80 % layout). Edge keeps those under "partition.per_host_zoom_levels"; older Chromium builds used
  // "profile.per_host_zoom_levels". Both are emptied so this run asks for one scale everywhere.
  prefs['partition'] = { ...partition, default_zoom_level: { ...zoom, x: Math.abs(level) < 1e-9 ? 0 : level }, per_host_zoom_levels: {} };
  const legacy = isObject(prefs['profile']) ? prefs['profile'] : {};
  prefs['profile'] = { ...legacy, per_host_zoom_levels: {} };

  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(prefs), 'utf8');
  await fs.rename(temp, file);
}
