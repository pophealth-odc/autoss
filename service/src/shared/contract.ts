/**
 * API contract shared by the local automation service and the web UI.
 *
 * IMPORTANT: `service/src/shared/contract.ts` and `frontend/src/api/contract.ts` must stay byte-identical.
 * `service/test/contract-sync.test.ts` fails when they drift apart.
 * This file holds types and plain constants only (no imports), so both projects can use it unchanged.
 *
 * Endpoints (all JSON unless noted; everything except /api/health needs `Authorization: Bearer <pairing token>`):
 *   GET    /api/health                    -> ServiceHealth            (no token; Origin and Host are still checked)
 *   GET    /api/system/info               -> ServiceInfo
 *   GET    /api/events                    -> text/event-stream of ServiceEvent
 *   POST   /api/automation/start          -> 202 AutomationStatus     (body: StartAutomationRequest)
 *   POST   /api/automation/stop           -> AutomationStatus
 *   POST   /api/automation/continue       -> AutomationStatus         (resume after manual login)
 *   GET    /api/automation/status         -> AutomationStatus
 *   GET    /api/gallery                   -> GalleryListResponse
 *   GET    /api/gallery/:id/image         -> image/png
 *   GET    /api/gallery/:id/thumbnail     -> image/jpeg (or the PNG when thumbnails are unavailable)
 *   GET    /api/gallery/:id/download      -> image/png attachment
 *   POST   /api/gallery/download-zip      -> application/zip          (body: ZipRequest)
 *   POST   /api/gallery/delete            -> DeleteResult             (body: DeleteManyRequest)
 *   DELETE /api/gallery/:id               -> DeleteResult
 *   DELETE /api/gallery?confirm=true      -> DeleteResult
 *   GET    /api/profiles                  -> { profiles: ProfileInfo[] }
 *   DELETE /api/profiles/:name            -> { deleted: boolean }
 */

/** Bump when a breaking change is made to request/response shapes. The UI refuses to talk to a different major. */
export const API_VERSION = 1;
export const SERVICE_ID = 'screenshot-gallery-service';
export const DEFAULT_SERVICE_PORT = 4577;
export const DEFAULT_SERVICE_URL = `http://127.0.0.1:${DEFAULT_SERVICE_PORT}`;

export const LIMITS = {
  maxUrls: 500,
  maxUrlLength: 2048,
  maxPagesCap: 500,
  defaultMaxPages: 20,
  pageTimeoutMs: { min: 1_000, max: 120_000, default: 30_000 },
  extraWaitMs: { min: 0, max: 60_000, default: 1_000 },
  delayBetweenPagesMs: { min: 0, max: 60_000, default: 500 },
  viewportWidth: { min: 320, max: 3840, default: 1280 },
  viewportHeight: { min: 240, max: 2160, default: 720 },
  /** Page scale in percent, like the browser's zoom (Edge allows 25 - 500). */
  pageScalePercent: { min: 25, max: 500, default: 100 },
  folderMaxLength: 120,
  profileNameMax: 32,
  maxFailuresKept: 100,
  maxZipEntries: 5_000,
  maxDeleteIds: 5_000,
} as const;

export type BrowserId = 'msedge';
export type BrowserMode = 'headed' | 'headless';
export type ScreenshotMode = 'fullPage' | 'viewport';

/** Fully resolved settings of a run (defaults applied by the service). */
export interface AutomationSettings {
  browser: BrowserId;
  mode: BrowserMode;
  screenshotMode: ScreenshotMode;
  /** Initial URL list, already de-duplicated. */
  urls: string[];
  followLinks: boolean;
  /**
   * Maximum number of pages captured in total, seed URLs included. Only applies when followLinks is on.
   * Seed URLs are always captured; link-following only fills whatever budget is left.
   */
  maxPages: number;
  /** When following links, only follow links whose origin equals the origin of the page they were found on. */
  sameOrigin: boolean;
  pageTimeoutMs: number;
  extraWaitMs: number;
  delayBetweenPagesMs: number;
  viewportWidth: number;
  viewportHeight: number;
  /**
   * Page scale in percent, applied when the browser opens (headless and headed). It works like the browser's zoom:
   * 50 fits twice as much of the page on screen, 200 shows half as much, larger.
   */
  pageScalePercent: number;
  /** Scroll through the page before a full-page capture so lazy-loaded content is rendered. */
  autoScroll: boolean;
  /** Capture pages whose TLS certificate is invalid (self-signed intranet sites). Off by default. */
  ignoreCertificateErrors: boolean;
  /** Sub-folder of the screenshots directory ('' = the directory itself). Never an absolute path. */
  outputFolder: string;
  persistentProfile: boolean;
  profileName: string;
  /** Headed only: open the first page, then wait until the user presses Continue. */
  manualLogin: boolean;
}

/** Body of POST /api/automation/start. Everything except `urls` is optional. */
export type StartAutomationRequest = { urls: string[] } & Partial<Omit<AutomationSettings, 'urls'>>;

/** Settings as echoed in the run status. The URL list is replaced by its length to keep progress events small. */
export type RunSettingsSummary = Omit<AutomationSettings, 'urls'> & { urlCount: number };

export type RunState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting-for-login'
  | 'stopping'
  | 'completed'
  | 'stopped'
  | 'failed';

export type RunStep = 'launching' | 'navigating' | 'waiting' | 'scrolling' | 'capturing' | 'saving' | 'pausing';

export type PageErrorKind =
  | 'invalid-url'
  | 'blocked'
  | 'timeout'
  | 'dns'
  | 'connection'
  | 'certificate'
  | 'auth-required'
  | 'download'
  | 'navigation'
  | 'screenshot'
  | 'browser-closed'
  | 'aborted'
  | 'storage'
  | 'unknown';

export interface PageFailure {
  url: string;
  kind: PageErrorKind;
  message: string;
  at: string;
}

export interface AutomationStatus {
  state: RunState;
  /** True while a run is in progress (starting, running, waiting-for-login, stopping). */
  active: boolean;
  runId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Human-readable status line. */
  message: string;
  settings: RunSettingsSummary | null;
  /** Pages known so far (grows while link-following discovers pages). */
  total: number;
  /** succeeded + failed */
  completed: number;
  succeeded: number;
  failed: number;
  /** 0-100, integer. */
  percent: number;
  currentUrl: string | null;
  currentStep: RunStep | null;
  /** True while link-following may still add pages to `total`. */
  discovering: boolean;
  failures: PageFailure[];
  browserVersion: string | null;
}

/** 'warning' = captured, but something was off (HTTP error status, load timeout, truncated height...). */
export type CaptureStatus = 'success' | 'warning';

export interface GalleryItem {
  id: string;
  filename: string;
  /** Sub-folder inside the screenshots directory ('' = root). */
  folder: string;
  title: string;
  /** URL that was requested. */
  url: string;
  /** URL after redirects. */
  finalUrl: string;
  /** ISO-8601 capture time. */
  capturedAt: string;
  width: number;
  height: number;
  bytes: number;
  screenshotMode: ScreenshotMode;
  /** Failed pages are never stored as gallery items; they are reported in the run status. */
  status: CaptureStatus;
  httpStatus: number | null;
  warnings: string[];
  runId: string;
}

export interface GalleryListResponse {
  items: GalleryItem[];
  total: number;
  totalBytes: number;
}

export interface DeleteManyRequest {
  ids: string[];
}
export interface DeleteResult {
  deleted: number;
  /** IDs that were not in the gallery. */
  missing: string[];
}

export interface ZipRequest {
  /** Omit (or send an empty array) to download the entire gallery. */
  ids?: string[];
}

/**
 * Optional abilities of the service. A newer web page can be opened against an older service that is still running, so the
 * page asks which of these exist instead of assuming; an ability is only ever ADDED to this list, never renamed.
 *
 *  - pageScale: the start request accepts `pageScalePercent`
 *  - datePlaceholder: web addresses may contain `{$prevday}` (the service expands it as well as the page)
 */
export const SERVICE_FEATURES = ['pageScale', 'datePlaceholder'] as const;
export type ServiceFeature = (typeof SERVICE_FEATURES)[number];

export interface ServiceHealth {
  ok: true;
  service: typeof SERVICE_ID;
  version: string;
  apiVersion: number;
  /**
   * Abilities this service has. A service built before this field existed does not send it; read it with
   * `serviceHas()`, which treats a missing list as "none of the optional abilities".
   */
  features?: ServiceFeature[];
  authRequired: true;
  time: string;
}

/** True when the service advertises `feature`. A service that sends no list (an older build) has none. */
export function serviceHas(health: Pick<ServiceHealth, 'features'> | null | undefined, feature: ServiceFeature): boolean {
  return Array.isArray(health?.features) && health.features.includes(feature);
}

export interface EdgeInfo {
  found: boolean;
  executablePath: string | null;
  version: string | null;
  source: 'env' | 'registry' | 'standard-path' | 'none';
  hint?: string;
}

export interface ProfileInfo {
  name: string;
  bytes: number;
  modifiedAt: string | null;
}

export interface ServiceInfo {
  version: string;
  apiVersion: number;
  platform: string;
  nodeVersion: string;
  uptimeSec: number;
  edge: EdgeInfo;
  screenshotsDir: string;
  profilesDir: string;
  /** Whether navigation to localhost / private-network addresses is permitted (ALLOW_PRIVATE_TARGETS). */
  privateTargetsAllowed: boolean;
  /** Host names exempted from the private-network block (ALLOWED_TARGET_HOSTS). */
  allowedTargetHosts: string[];
  /** False when the optional `sharp` module is unavailable: thumbnails then fall back to the full image. */
  thumbnailsAvailable: boolean;
  maxFullPageHeight: number;
  allowedOrigins: string[];
  allowLocalhostOrigins: boolean;
  limits: typeof LIMITS;
}

export const ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'unauthorized',
  'forbidden',
  'origin_not_allowed',
  'bad_host',
  'not_found',
  'method_not_allowed',
  'conflict',
  'payload_too_large',
  'rate_limited',
  'edge_not_found',
  'browser_launch_failed',
  'profile_in_use',
  'storage_error',
  'not_running',
  'confirmation_required',
  'too_many_streams',
  'internal_error',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

/** Server-Sent Events published on GET /api/events. */
export type ServiceEvent =
  | { type: 'hello'; data: { serverTime: string; version: string; apiVersion: number } }
  | { type: 'state'; data: AutomationStatus }
  | { type: 'capture'; data: GalleryItem }
  | { type: 'gallery'; data: { reason: 'deleted' | 'cleared'; ids: string[] } }
  | { type: 'notice'; data: { level: 'info' | 'warning' | 'error'; message: string } };

export type ServiceEventType = ServiceEvent['type'];
