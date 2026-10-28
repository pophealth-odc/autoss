import { useEffect, useState } from 'react';
import type { ServiceClient } from '../api/client';

type Kind = 'image' | 'thumbnail';

/**
 * Images need the pairing token, which an <img src> cannot send. They are fetched with the Authorization header and shown
 * through blob: URLs. This small cache shares the (revoked-when-unused) blobs between the card and the preview.
 */
interface Entry {
  url: string | null;
  promise: Promise<string> | null;
  refs: number;
  failed: boolean;
}

const cache = new Map<string, Entry>();
const MAX_PARALLEL = 4;
let active = 0;
const waiting: Array<() => void> = [];

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await work();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

function keyOf(client: ServiceClient, id: string, kind: Kind): string {
  return `${client.baseUrl}|${kind}|${id}`;
}

function acquire(client: ServiceClient, id: string, kind: Kind): { entry: Entry; key: string } {
  const key = keyOf(client, id, kind);
  let entry = cache.get(key);
  if (!entry) {
    entry = { url: null, promise: null, refs: 0, failed: false };
    cache.set(key, entry);
  }
  entry.refs += 1;
  if (!entry.url && !entry.promise) {
    const fresh = entry;
    fresh.failed = false;
    fresh.promise = slot(() => client.imageBlob(id, kind)).then(
      (blob) => {
        fresh.url = URL.createObjectURL(blob);
        fresh.promise = null;
        return fresh.url;
      },
      (error: unknown) => {
        fresh.promise = null;
        fresh.failed = true;
        throw error;
      },
    );
  }
  return { entry, key };
}

function release(key: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    // Keep recently shown blobs for a moment: scrolling back and forth should not refetch.
    window.setTimeout(() => {
      const current = cache.get(key);
      if (current && current.refs <= 0) {
        if (current.url) URL.revokeObjectURL(current.url);
        cache.delete(key);
      }
    }, 15_000);
  }
}

export function clearBlobCache(): void {
  for (const entry of cache.values()) if (entry.url) URL.revokeObjectURL(entry.url);
  cache.clear();
}

export interface BlobState {
  url: string | null;
  loading: boolean;
  failed: boolean;
}

/** Loads an authenticated image and returns a blob: URL for it, or null while loading / after a failure. */
export function useBlobUrl(client: ServiceClient, id: string | null, kind: Kind, enabled = true): BlobState {
  const [state, setState] = useState<BlobState>({ url: null, loading: enabled && id !== null, failed: false });

  useEffect(() => {
    if (!enabled || id === null) {
      setState({ url: null, loading: false, failed: false });
      return;
    }
    let cancelled = false;
    const { entry, key } = acquire(client, id, kind);
    if (entry.url) setState({ url: entry.url, loading: false, failed: false });
    else setState({ url: null, loading: true, failed: false });
    entry.promise?.then(
      (url) => {
        if (!cancelled) setState({ url, loading: false, failed: false });
      },
      () => {
        if (!cancelled) setState({ url: null, loading: false, failed: true });
      },
    );
    return () => {
      cancelled = true;
      release(key);
    };
  }, [client, id, kind, enabled]);

  return state;
}
