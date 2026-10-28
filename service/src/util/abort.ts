/** Thrown when an operation was cancelled through an AbortSignal (for example the user pressed Stop). */
export class AbortedError extends Error {
  constructor(message = 'Operation aborted') {
    super(message);
    this.name = 'AbortedError';
  }
}

/** Thrown by withDeadline() when the time budget is exhausted. */
export class DeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadlineError';
  }
}

export function isAbortedError(error: unknown): boolean {
  return error instanceof AbortedError || (error instanceof Error && error.name === 'AbortError');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError();
}

/** Resolves after `ms`; rejects with AbortedError as soon as the signal aborts. Never leaves a timer behind. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Races `work` against a time budget. When the budget is exhausted `onTimeout` runs (for example closing a stuck page)
 * and the returned promise rejects with DeadlineError. A late rejection of `work` is swallowed.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void | Promise<void>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new DeadlineError(`${label} did not finish within ${Math.round(ms / 1000)} s`));
    }, ms);
    // A pending deadline alone must never keep the process alive; the work it guards holds its own handles.
    timer.unref();
  });
  try {
    return await Promise.race([work, deadline]);
  } catch (error) {
    if (error instanceof DeadlineError) {
      work.catch(() => undefined);
      try {
        await onTimeout?.();
      } catch {
        /* the stuck resource may already be gone */
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Rejects with AbortedError when `signal` aborts before `work` settles. */
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(new AbortedError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      work.catch(() => undefined);
      reject(new AbortedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
