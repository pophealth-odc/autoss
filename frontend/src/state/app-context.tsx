import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { describeError, isConnectionError, isServiceError } from '../api/errors';
import type { AutomationStatus, GalleryItem } from '../api/contract';
import { saveJson, loadJson, KEYS } from '../lib/storage';
import { ConnectionManager, consumePairingLink, type ConnectionState } from './connection';

export type SortKey = 'newest' | 'oldest' | 'title';

export interface Toast {
  id: number;
  level: 'success' | 'error' | 'info' | 'warning';
  message: string;
}

interface GalleryState {
  items: GalleryItem[];
  totalBytes: number;
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

export interface AppContextValue {
  connection: ConnectionState;
  manager: ConnectionManager;
  status: AutomationStatus | null;
  gallery: GalleryState;
  toasts: Toast[];
  notify: (level: Toast['level'], message: string) => void;
  dismissToast: (id: number) => void;
  /** Removes every notification (for example when a new run starts, so old results do not linger). */
  clearToasts: () => void;
  refreshGallery: () => Promise<void>;
  /** Items removed locally right away; the service confirms through events. */
  removeFromGallery: (ids: string[]) => void;
  reportError: (error: unknown, fallback?: string) => void;
  /** Pairing link received in the address bar, to be shown for confirmation. */
  pendingPairing: { serviceUrl: string | null; token: string | null } | null;
  clearPendingPairing: () => void;
  /** Shows the pairing confirmation for a link that arrived while the page was already open. */
  offerPairing: (link: { serviceUrl: string | null; token: string | null }) => void;
  /**
   * Applies a status the service returned from a request (for example Start), so the run is visible at once even if the live
   * event stream is slow or briefly down. It never replaces newer information the stream already delivered.
   */
  applyStatus: (next: AutomationStatus) => void;
}

/** True when `candidate` describes the same run as `current` but an EARLIER moment of it (so it must not overwrite it). */
export function isStaleStatus(current: AutomationStatus | null, candidate: AutomationStatus): boolean {
  if (current === null || current.runId === null || candidate.runId === null) return false;
  if (current.runId !== candidate.runId) return false; // a different run: the newer one is whichever was applied last
  // Within one run progress only moves forward: counts rise and a finished run never returns to "running".
  if (!current.active && candidate.active) return true;
  return candidate.completed < current.completed || candidate.succeeded < current.succeeded || candidate.failed < current.failed;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProvider>.');
  return value;
}

export function isSortKey(value: unknown): value is SortKey {
  return value === 'newest' || value === 'oldest' || value === 'title';
}

export function loadSort(): SortKey {
  return loadJson<SortKey>(KEYS.sort, 'newest', isSortKey);
}
export function saveSort(sort: SortKey): void {
  saveJson(KEYS.sort, sort);
}

let toastCounter = 0;

/**
 * A pairing link is consumed once per page load, before the router starts (see main.tsx). Reading it also removes the token
 * from the address bar, and React may run state initialisers twice in development, so the result is kept here.
 */
let initialPairing: AppContextValue['pendingPairing'] | undefined;

export function captureInitialPairing(): void {
  if (initialPairing === undefined) initialPairing = consumePairingLink();
}

function takeInitialPairing(): AppContextValue['pendingPairing'] {
  captureInitialPairing();
  return initialPairing ?? null;
}

/** Forgets the remembered link so a test can simulate a fresh page load. */
export function resetInitialPairingForTests(): void {
  initialPairing = undefined;
}

export function AppProvider({ children, manager: injected }: { children: ReactNode; manager?: ConnectionManager }) {
  const [manager] = useState(() => injected ?? new ConnectionManager());
  const connection = useSyncExternalStore(manager.subscribe, manager.getState, manager.getState);

  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [gallery, setGallery] = useState<GalleryState>({ items: [], totalBytes: 0, loaded: false, loading: false, error: null });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pendingPairing, setPendingPairing] = useState<AppContextValue['pendingPairing']>(takeInitialPairing);
  const lastRunState = useRef<string | null>(null);
  const galleryRequest = useRef(0);

  const dismissToast = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const notify = useCallback((level: Toast['level'], message: string) => {
    const id = ++toastCounter;
    // An identical message replaces the earlier one instead of stacking a duplicate; at most three are shown at once.
    setToasts((list) => [...list.filter((t) => !(t.level === level && t.message === message)).slice(-2), { id, level, message }]);
    const lifetime = level === 'error' ? 9000 : 5000;
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), lifetime);
  }, []);
  const clearToasts = useCallback(() => setToasts([]), []);

  const reportError = useCallback(
    (error: unknown, fallback = 'Something went wrong.') => {
      if (isConnectionError(error) && error.problem === 'aborted') return;
      notify('error', describeError(error) || fallback);
    },
    [notify],
  );

  const refreshGallery = useCallback(async () => {
    const request = ++galleryRequest.current;
    setGallery((g) => ({ ...g, loading: true, error: null }));
    try {
      const response = await manager.client.gallery();
      if (request !== galleryRequest.current) return;
      setGallery({ items: response.items, totalBytes: response.totalBytes, loaded: true, loading: false, error: null });
    } catch (error) {
      if (request !== galleryRequest.current) return;
      if (isServiceError(error) || isConnectionError(error)) {
        setGallery((g) => ({ ...g, loading: false, error: describeError(error) }));
      } else {
        setGallery((g) => ({ ...g, loading: false, error: 'The gallery could not be loaded.' }));
      }
    }
  }, [manager]);

  const removeFromGallery = useCallback((ids: string[]) => {
    const gone = new Set(ids);
    setGallery((g) => {
      const items = g.items.filter((i) => !gone.has(i.id));
      return { ...g, items, totalBytes: items.reduce((sum, i) => sum + i.bytes, 0) };
    });
  }, []);

  // Wire the live events into state.
  useEffect(() => {
    manager.setEventHandlers({
      onState: (next) => {
        setStatus(next);
        const previous = lastRunState.current;
        lastRunState.current = next.state;
        if (previous !== null && previous !== next.state && !next.active) {
          if (next.state === 'completed') notify(next.failed > 0 ? 'warning' : 'success', next.message);
          else if (next.state === 'stopped') notify('info', next.message);
          else if (next.state === 'failed') notify('error', next.message);
        }
      },
      onCapture: (item) => {
        setGallery((g) =>
          g.items.some((i) => i.id === item.id)
            ? g
            : { ...g, items: [item, ...g.items], totalBytes: g.totalBytes + item.bytes, loaded: true },
        );
      },
      onGallery: (change) => removeFromGallery(change.ids),
      onNotice: (notice) => notify(notice.level === 'error' ? 'error' : notice.level === 'warning' ? 'warning' : 'info', notice.message),
      onResync: () => {
        void refreshGallery();
        manager.client.status().then(setStatus, () => undefined);
      },
    });
    return () => manager.setEventHandlers(null);
  }, [manager, notify, refreshGallery, removeFromGallery]);

  // Connect on start, load the gallery once connected, and forget live data when the connection is lost.
  useEffect(() => {
    if (pendingPairing === null) void manager.connect();
    return () => manager.stop();
  }, [manager, pendingPairing]);

  useEffect(() => {
    if (connection.phase === 'connected') {
      void refreshGallery();
      manager.client.status().then((s) => {
        lastRunState.current = s.state;
        setStatus(s);
      }, () => undefined);
    } else if (connection.phase === 'failed' || connection.phase === 'needs-token') {
      setStatus(null);
    }
  }, [connection.phase, manager, refreshGallery]);

  const clearPendingPairing = useCallback(() => setPendingPairing(null), []);
  const offerPairing = useCallback((link: { serviceUrl: string | null; token: string | null }) => setPendingPairing(link), []);
  const applyStatus = useCallback((next: AutomationStatus) => {
    setStatus((current) => {
      if (isStaleStatus(current, next)) return current;
      lastRunState.current = next.state;
      return next;
    });
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({ connection, manager, status, gallery, toasts, notify, dismissToast, clearToasts, refreshGallery, removeFromGallery, reportError, pendingPairing, clearPendingPairing, offerPairing, applyStatus }),
    [connection, manager, status, gallery, toasts, notify, dismissToast, clearToasts, refreshGallery, removeFromGallery, reportError, pendingPairing, clearPendingPairing, offerPairing, applyStatus],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
