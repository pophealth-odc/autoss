import { ServiceClient, normalizeServiceUrl, problemAdvice } from '../api/client';
import { sameOriginServiceUrl } from '../api/same-origin';
import { ConnectionError, isConnectionError, isServiceError, type ConnectionProblem } from '../api/errors';
import {
  DEFAULT_SERVICE_URL,
  type AutomationStatus,
  type GalleryItem,
  type ServiceEvent,
  type ServiceHealth,
  type ServiceInfo,
} from '../api/contract';
import { readEventStream, reconnectDelay, SseParser } from '../api/sse';
import { KEYS, loadString, loadToken, saveString, saveToken } from '../lib/storage';

/**
 * What the interface may claim about the local service.
 *
 *  - "connected" is the ONLY state in which automation can be started.
 *  - Every other state carries the reason, so the interface can say what is wrong instead of pretending.
 */
export type ConnectionPhase =
  | 'idle' // nothing tried yet
  | 'connecting' // request in flight
  | 'waiting-for-permission' // slow first attempt: the browser may be showing its "allow access to your computer" prompt
  | 'needs-token' // the service is there, but no token has been entered
  | 'connected'
  | 'failed';

export interface ConnectionState {
  phase: ConnectionPhase;
  serviceUrl: string;
  hasToken: boolean;
  rememberToken: boolean;
  /** Why the last attempt failed (phase === "failed" or "needs-token"). */
  problem: ConnectionProblem | null;
  message: string;
  advice: string;
  health: ServiceHealth | null;
  info: ServiceInfo | null;
  /** True while the live event stream is open. */
  live: boolean;
  lastConnectedAt: number | null;
}

export type ConnectionListener = (state: ConnectionState) => void;

export interface EventHandlers {
  onState(status: AutomationStatus): void;
  onCapture(item: GalleryItem): void;
  onGallery(change: { reason: 'deleted' | 'cleared'; ids: string[] }): void;
  onNotice(notice: { level: 'info' | 'warning' | 'error'; message: string }): void;
  /** Called after the event stream (re)connects: the gallery must be reloaded because events may have been missed. */
  onResync(): void;
}

/** After this long without an answer the first attempt is reported as "waiting for the browser's permission prompt". */
const PERMISSION_HINT_AFTER_MS = 1_800;
/** Health checks run this often while connected, to notice a stopped service even when no event stream is open. */
const HEARTBEAT_MS = 20_000;

function initialState(): ConnectionState {
  const { token, remembered } = loadToken();
  return {
    phase: 'idle',
    // A page served together with its service always uses its own address: a saved address could only be a leftover from
    // another copy of the page.
    serviceUrl: sameOriginServiceUrl() ?? loadString(KEYS.serviceUrl) ?? DEFAULT_SERVICE_URL,
    hasToken: token !== null && token !== '',
    rememberToken: remembered,
    problem: null,
    message: '',
    advice: '',
    health: null,
    info: null,
    live: false,
    lastConnectedAt: null,
  };
}

export class ConnectionManager {
  readonly client: ServiceClient;
  private state: ConnectionState;
  private readonly listeners = new Set<ConnectionListener>();
  private handlers: EventHandlers | null = null;
  private streamAbort: AbortController | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private connectRun = 0;
  private disposed = false;

  constructor() {
    this.state = initialState();
    const { token } = loadToken();
    this.client = new ServiceClient({ baseUrl: this.state.serviceUrl, token });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------------------------------------------

  getState = (): ConnectionState => this.state;

  subscribe = (listener: ConnectionListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setEventHandlers(handlers: EventHandlers | null): void {
    this.handlers = handlers;
  }

  private set(patch: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Settings changes
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Saves the service address and token, then reconnects. Returns an error message if the input is unusable.
   * `token: undefined` keeps the token that is already saved (the settings form leaves the field empty in that case).
   */
  async configure(input: { serviceUrl: string; token: string | null | undefined; rememberToken: boolean }): Promise<string | null> {
    const url = normalizeServiceUrl(input.serviceUrl);
    if (url === null) return 'The service address is not valid. Use something like http://127.0.0.1:4577.';
    let token: string | null;
    if (input.token === undefined) {
      token = loadToken().token;
    } else {
      token = input.token?.trim() ? input.token.trim() : null;
      if (token !== null && !/^[A-Za-z0-9_\-.~+/=]{24,200}$/.test(token)) {
        return 'The pairing token looks wrong. Copy it again from the service window (letters, digits and - _ . ~ + / = only).';
      }
    }
    saveString(KEYS.serviceUrl, url);
    saveToken(token, input.rememberToken);
    this.client.update({ baseUrl: url, token });
    this.set({ serviceUrl: url, hasToken: token !== null, rememberToken: input.rememberToken });
    void this.connect();
    return null;
  }

  /** Forgets the token (for example after "Disconnect"). */
  forgetToken(): void {
    saveToken(null, false);
    this.client.update({ baseUrl: this.state.serviceUrl, token: null });
    this.stop();
    this.set({ hasToken: false, rememberToken: false, phase: 'needs-token', problem: 'unauthorized', message: 'No pairing token is set.', advice: problemAdvice('unauthorized'), live: false, info: null });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Connecting
  // ---------------------------------------------------------------------------------------------------------------

  /** Checks the service, authenticates, and opens the live event stream. Safe to call repeatedly. */
  async connect(): Promise<void> {
    if (this.disposed) return;
    const run = ++this.connectRun;
    this.stopStream();
    this.clearReconnect();
    this.set({ phase: 'connecting', problem: null, message: 'Looking for the local service…', advice: '', live: false });

    const permissionHint = setTimeout(() => {
      if (run === this.connectRun && this.state.phase === 'connecting') {
        this.set({ phase: 'waiting-for-permission', message: 'Waiting for your browser… If a prompt asks to allow access to devices on your computer, choose Allow.' });
      }
    }, PERMISSION_HINT_AFTER_MS);

    try {
      // The first request may wait on a browser permission prompt, so it has no short timeout of its own.
      const health = await this.client.health({ timeoutMs: 120_000 });
      if (run !== this.connectRun) return;
      if (!this.client.hasToken) {
        this.set({ phase: 'needs-token', health, problem: 'unauthorized', message: 'The service is running. Enter its pairing token to continue.', advice: problemAdvice('unauthorized') });
        return;
      }
      const info = await this.client.info({ timeoutMs: 20_000 });
      if (run !== this.connectRun) return;
      this.attempt = 0;
      this.set({ phase: 'connected', health, info, problem: null, message: 'Connected to the local service.', advice: '', lastConnectedAt: Date.now() });
      this.startStream();
      this.startHeartbeat();
    } catch (error) {
      if (run !== this.connectRun) return;
      this.fail(error);
    } finally {
      clearTimeout(permissionHint);
    }
  }

  /** Translates a failure into state. Distinguishes "no token", "wrong token", "site not allowed" and "service down". */
  private fail(error: unknown): void {
    if (isServiceError(error)) {
      const map: Partial<Record<string, ConnectionProblem>> = {
        unauthorized: 'unauthorized',
        origin_not_allowed: 'origin-not-allowed',
        bad_host: 'bad-host',
        rate_limited: 'rate-limited',
      };
      const problem = map[error.code] ?? 'incompatible';
      const message =
        problem === 'unauthorized' ? 'The pairing token was not accepted.' : problem === 'incompatible' ? error.message : error.message;
      this.set({
        phase: problem === 'unauthorized' ? 'needs-token' : 'failed',
        problem,
        message,
        advice: problemAdvice(problem),
        live: false,
        info: null,
      });
      return;
    }
    if (isConnectionError(error)) {
      this.set({
        phase: 'failed',
        problem: error.problem,
        message: error.message,
        advice: problemAdvice(error.problem),
        live: false,
        info: null,
      });
      if (error.problem === 'unreachable' || error.problem === 'timeout') this.scheduleReconnect();
      return;
    }
    this.set({ phase: 'failed', problem: 'unreachable', message: 'Could not reach the service.', advice: problemAdvice('unreachable'), live: false, info: null });
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    const delay = reconnectDelay(this.attempt++, null);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Live events
  // ---------------------------------------------------------------------------------------------------------------

  private startStream(): void {
    this.stopStream();
    const abort = new AbortController();
    this.streamAbort = abort;
    void this.streamLoop(abort);
  }

  private stopStream(): void {
    this.streamAbort?.abort();
    this.streamAbort = null;
  }

  private async streamLoop(abort: AbortController): Promise<void> {
    const parser = new SseParser();
    let attempt = 0;
    let serverRetry: number | null = null;
    let first = true;

    while (!abort.signal.aborted && !this.disposed) {
      try {
        const response = await this.client.openEventStream(abort.signal, parser.lastEventId);
        if (!response.body) throw new ConnectionError('incompatible', 'The service did not stream events.');
        attempt = 0;
        this.set({ live: true });
        if (!first) this.handlers?.onResync();
        first = false;
        await readEventStream(response.body, parser, {
          signal: abort.signal,
          onMessage: (message) => {
            if (message.retry !== null) serverRetry = message.retry;
            this.dispatch(message.event, message.data);
          },
        });
      } catch (error) {
        if (abort.signal.aborted) return;
        // A refusal (wrong token, origin removed) will not fix itself by retrying: re-run the full connection check.
        if (isServiceError(error) || (isConnectionError(error) && error.problem !== 'unreachable' && error.problem !== 'timeout')) {
          this.fail(error);
          return;
        }
      }
      if (abort.signal.aborted) return;
      this.set({ live: false });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, reconnectDelay(attempt++, serverRetry));
        abort.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      // The stream ended or failed; confirm the service is still there before reopening, so the status badge stays honest.
      if (abort.signal.aborted) return;
      try {
        await this.client.health({ timeoutMs: 5_000, signal: abort.signal });
      } catch (error) {
        if (abort.signal.aborted) return;
        this.fail(error);
        return;
      }
    }
  }

  private dispatch(type: string, data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // ignore a damaged event instead of breaking the stream
    }
    const handlers = this.handlers;
    if (!handlers || typeof parsed !== 'object' || parsed === null) return;
    const event = { type, data: parsed } as ServiceEvent;
    switch (event.type) {
      case 'state':
        handlers.onState(event.data);
        break;
      case 'capture':
        handlers.onCapture(event.data);
        break;
      case 'gallery':
        handlers.onGallery(event.data);
        break;
      case 'notice':
        handlers.onNotice(event.data);
        break;
      case 'hello':
        break;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Heartbeat and shutdown
  // ---------------------------------------------------------------------------------------------------------------

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.state.phase !== 'connected') return;
      this.client.health({ timeoutMs: 8_000 }).catch((error: unknown) => {
        if (this.state.phase === 'connected') this.fail(error);
      });
    }, HEARTBEAT_MS);
  }

  /** Stops the stream and timers without forgetting settings. */
  stop(): void {
    this.connectRun += 1;
    this.stopStream();
    this.clearReconnect();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.listeners.clear();
  }
}

/**
 * Reads `#/connect?service=…&token=…` from the address and removes the secret from the address bar and history by
 * replacing the entry (the browser never sends the fragment to a server, and the replace keeps it out of Back/History).
 * Returns null when the address is not a pairing link.
 */
export function consumePairingLink(): { serviceUrl: string | null; token: string | null } | null {
  const match = /^#\/connect(?:\?(.*))?$/.exec(window.location.hash);
  if (!match) return null;
  const params = new URLSearchParams(match[1] ?? '');
  const serviceUrl = params.get('service');
  const token = params.get('token');
  try {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/settings`);
  } catch {
    /* ignore */
  }
  return { serviceUrl, token };
}
