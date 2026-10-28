import { ConnectionError, errorFromResponse, ServiceError, type ConnectionProblem } from './errors';
import { isPageOrigin } from './same-origin';
import {
  API_VERSION,
  SERVICE_ID,
  type AutomationStatus,
  type DeleteResult,
  type GalleryListResponse,
  type ProfileInfo,
  type ServiceHealth,
  type ServiceInfo,
  type StartAutomationRequest,
} from './contract';

export interface ClientConfig {
  /** Address of the local service, for example http://127.0.0.1:4577 (no trailing slash). */
  baseUrl: string;
  /** Pairing token; null before the user has entered one. */
  token: string | null;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Milliseconds before the request is abandoned. 0 disables the timeout (used for downloads and the first request, which may wait for a browser permission prompt). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Whether the address looks like a loopback address, which is what the local service uses. */
export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(url.hostname);
  } catch {
    return false;
  }
}

/** Normalises user input like "127.0.0.1:4577" or "http://localhost:4577/" to "http://127.0.0.1:4577". Returns null if unusable. */
export function normalizeServiceUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Reads the browser's decision about talking to this computer from a website. */
export async function readNetworkPermission(): Promise<'granted' | 'denied' | 'prompt' | 'unknown'> {
  try {
    if (!('permissions' in navigator)) return 'unknown';
    const status = await navigator.permissions.query({ name: 'local-network-access' as PermissionName });
    return status.state;
  } catch {
    return 'unknown';
  }
}

/**
 * Thin typed wrapper around fetch() for the local service. It never puts the token in a URL, and it turns the browser's
 * single "Failed to fetch" into a specific ConnectionError so the interface can say what is actually wrong.
 */
export class ServiceClient {
  constructor(private config: ClientConfig) {}

  update(config: ClientConfig): void {
    this.config = config;
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  get hasToken(): boolean {
    return this.config.token !== null && this.config.token !== '';
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Typed endpoints
  // ---------------------------------------------------------------------------------------------------------------

  async health(options: RequestOptions = {}): Promise<ServiceHealth> {
    const health = await this.json<ServiceHealth>('GET', '/api/health', undefined, { ...options, auth: false });
    if (health.service !== SERVICE_ID) {
      throw new ConnectionError('incompatible', 'Something answered at this address, but it is not the screenshot service.');
    }
    if (health.apiVersion !== API_VERSION) {
      throw new ConnectionError(
        'incompatible',
        `The service speaks API version ${health.apiVersion} but this page needs version ${API_VERSION}. Update the service and this page to the same release.`,
      );
    }
    return health;
  }

  info(options?: RequestOptions): Promise<ServiceInfo> {
    return this.json('GET', '/api/system/info', undefined, options);
  }
  status(options?: RequestOptions): Promise<AutomationStatus> {
    return this.json('GET', '/api/automation/status', undefined, options);
  }
  start(request: StartAutomationRequest, options?: RequestOptions): Promise<AutomationStatus> {
    return this.json('POST', '/api/automation/start', request, { timeoutMs: 60_000, ...options });
  }
  stop(options?: RequestOptions): Promise<AutomationStatus> {
    return this.json('POST', '/api/automation/stop', undefined, options);
  }
  continueRun(options?: RequestOptions): Promise<AutomationStatus> {
    return this.json('POST', '/api/automation/continue', undefined, options);
  }
  gallery(options?: RequestOptions): Promise<GalleryListResponse> {
    return this.json('GET', '/api/gallery', undefined, options);
  }
  deleteOne(id: string, options?: RequestOptions): Promise<DeleteResult> {
    return this.json('DELETE', `/api/gallery/${encodeURIComponent(id)}`, undefined, options);
  }
  deleteMany(ids: string[], options?: RequestOptions): Promise<DeleteResult> {
    return this.json('POST', '/api/gallery/delete', { ids }, options);
  }
  clearGallery(options?: RequestOptions): Promise<DeleteResult> {
    return this.json('DELETE', '/api/gallery?confirm=true', undefined, options);
  }
  profiles(options?: RequestOptions): Promise<{ profiles: ProfileInfo[] }> {
    return this.json('GET', '/api/profiles', undefined, options);
  }
  deleteProfile(name: string, options?: RequestOptions): Promise<{ deleted: boolean }> {
    return this.json('DELETE', `/api/profiles/${encodeURIComponent(name)}`, undefined, options);
  }

  /** Image bytes as a Blob. The token travels in a header, so images are shown through blob: URLs and never by URL. */
  imageBlob(id: string, kind: 'image' | 'thumbnail', options?: RequestOptions): Promise<Blob> {
    return this.blob('GET', `/api/gallery/${encodeURIComponent(id)}/${kind}`, undefined, { timeoutMs: 30_000, ...options }).then((r) => r.blob);
  }
  download(id: string, options?: RequestOptions): Promise<{ blob: Blob; filename: string | null }> {
    return this.blob('GET', `/api/gallery/${encodeURIComponent(id)}/download`, undefined, { timeoutMs: 0, ...options });
  }
  downloadZip(ids: string[] | null, options?: RequestOptions): Promise<{ blob: Blob; filename: string | null }> {
    return this.blob('POST', '/api/gallery/download-zip', ids && ids.length > 0 ? { ids } : {}, { timeoutMs: 0, ...options });
  }

  /** Opens the live event stream. The caller reads `response.body`; see sse.ts. */
  async openEventStream(signal: AbortSignal, lastEventId: string | null): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (lastEventId) headers['Last-Event-ID'] = lastEventId;
    return this.raw('GET', '/api/events', undefined, { signal, timeoutMs: 0, headers });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------------------------------------------

  private async json<T>(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions & { auth?: boolean; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const response = await this.raw(method, path, body, options);
    try {
      return (await response.json()) as T;
    } catch {
      throw new ConnectionError('incompatible', 'The service sent an answer this page cannot read.');
    }
  }

  private async blob(method: string, path: string, body: unknown, options: RequestOptions): Promise<{ blob: Blob; filename: string | null }> {
    const response = await this.raw(method, path, body, options);
    const blob = await response.blob();
    return { blob, filename: filenameFromDisposition(response.headers.get('content-disposition')) };
  }

  private async raw(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions & { auth?: boolean; headers?: Record<string, string> },
  ): Promise<Response> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.auth !== false) {
      if (!this.hasToken) throw new ServiceError(401, 'unauthorized', 'Enter the pairing token in Settings first.');
      headers['Authorization'] = `Bearer ${this.config.token}`;
    }
    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : undefined;
    const onOuterAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', onOuterAbort, { once: true });
    }

    let response: Response;
    try {
      const init: RequestInit & { targetAddressSpace?: string } = {
        method,
        headers,
        signal: controller.signal,
        cache: 'no-store',
        // The service's own address never needs the browser's cookies, so they are not sent. The one exception is a service
        // that shares this page's address (GitHub Codespaces): the forwarding layer in front of it may want its sign-in cookie.
        credentials: isPageOrigin(this.config.baseUrl) ? 'same-origin' : 'omit',
        referrerPolicy: 'no-referrer',
        mode: 'cors',
        ...(payload !== undefined ? { body: payload } : {}),
      };
      // Tells the browser up front that this request goes to this computer (Local Network Access).
      if (isLoopbackUrl(this.config.baseUrl)) init.targetAddressSpace = 'loopback';
      response = await fetch(`${this.config.baseUrl}${path}`, init);
    } catch (error) {
      if (options.signal?.aborted) throw new ConnectionError('aborted', 'The request was cancelled.');
      if (timedOut) throw new ConnectionError('timeout', 'The service did not answer in time.');
      throw await this.diagnose(error);
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onOuterAbort);
    }

    if (!response.ok) throw await errorFromResponse(response);
    return response;
  }

  /**
   * fetch() reports "Failed to fetch" for a stopped service, a wrong port, a blocked permission and a CORS refusal
   * alike. The only extra signal a page can get is the browser's permission state for local network access.
   */
  private async diagnose(error: unknown): Promise<ConnectionError> {
    if (error instanceof DOMException && error.name === 'AbortError') return new ConnectionError('aborted', 'The request was cancelled.');
    const permission = await readNetworkPermission();
    const hosted = typeof location !== 'undefined' && !isLoopbackUrl(location.href);
    if (hosted && isLoopbackUrl(this.config.baseUrl) && permission === 'denied') {
      return new ConnectionError('permission-denied', 'Your browser blocked this page from reaching a program on your computer.');
    }
    return new ConnectionError('unreachable', 'Could not reach the service.');
  }
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through to the plain name */
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"/i.exec(header) ?? /filename\s*=\s*([^;]+)/i.exec(header);
  return plain?.[1]?.trim() ?? null;
}

/** Maps a failed request to what the person should do next. Used by the connection panel and the notifications. */
export function problemAdvice(problem: ConnectionProblem): string {
  switch (problem) {
    case 'permission-denied':
      return 'Click the lock icon next to the address, open Site settings, and set "Local network access" to Allow. Then reload this page.';
    case 'origin-not-allowed':
      return 'Add this website\'s address to ALLOWED_ORIGINS in service/.env, then restart the service.';
    case 'unauthorized':
      return 'Copy the pairing token from the service window into Settings.';
    case 'bad-host':
      return 'Use http://127.0.0.1 or http://localhost as the service address, with the port the service printed.';
    case 'rate-limited':
      return 'Wait a minute, then try again with the correct pairing token.';
    case 'incompatible':
      return 'Make sure the service and this page come from the same release.';
    case 'timeout':
      return 'The service is slow to answer. If a permission prompt is showing in your browser, answer it.';
    case 'aborted':
      return '';
    case 'unreachable':
      return 'Start the service on your computer (double-click start-service.bat) and check the address in Settings.';
  }
}
