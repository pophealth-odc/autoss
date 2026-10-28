import type { ApiErrorBody, ErrorCode } from './contract';

/** Why a request to the local service did not produce a normal answer. */
export type ConnectionProblem =
  /** Nothing answered: the service is not running, the address/port is wrong, or the browser blocked the request. */
  | 'unreachable'
  /** The browser is asking (or has been refused) permission to reach this computer from a website. */
  | 'permission-denied'
  /** The service answered but refuses this website (its origin is not in ALLOWED_ORIGINS). */
  | 'origin-not-allowed'
  /** The service answered 401: no token, or the wrong one. */
  | 'unauthorized'
  /** The service answered 421: the address in the settings does not match what the service expects. */
  | 'bad-host'
  /** The service is too busy with failed logins. */
  | 'rate-limited'
  /** The thing at the address is not this service, or speaks a different API version. */
  | 'incompatible'
  /** The request took too long. */
  | 'timeout'
  /** The user cancelled. */
  | 'aborted';

/** Error returned by the service in its standard JSON shape. */
export class ServiceError extends Error {
  readonly status: number;
  readonly code: ErrorCode | 'unknown';
  readonly details: unknown;
  readonly requestId: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, code: ErrorCode | 'unknown', message: string, details?: unknown, requestId?: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The request never produced an HTTP answer. */
export class ConnectionError extends Error {
  readonly problem: ConnectionProblem;

  constructor(problem: ConnectionProblem, message: string) {
    super(message);
    this.name = 'ConnectionError';
    this.problem = problem;
  }
}

export function isServiceError(error: unknown): error is ServiceError {
  return error instanceof ServiceError;
}

export function isConnectionError(error: unknown): error is ConnectionError {
  return error instanceof ConnectionError;
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const e = (value as { error: unknown }).error;
  return typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string';
}

/** Builds a ServiceError from a non-2xx response, tolerating bodies that are not the standard JSON shape. */
export async function errorFromResponse(response: Response): Promise<ServiceError> {
  const retry = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
  const retryAfterSeconds = Number.isFinite(retry) ? retry : undefined;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (isErrorBody(body)) {
    return new ServiceError(response.status, body.error.code, body.error.message, body.error.details, body.error.requestId, retryAfterSeconds);
  }
  return new ServiceError(response.status, 'unknown', `The service answered with HTTP ${response.status}.`, undefined, undefined, retryAfterSeconds);
}

/** A short, human explanation for any error, suitable for a notification. */
export function describeError(error: unknown): string {
  if (error instanceof ServiceError || error instanceof ConnectionError) return error.message;
  if (error instanceof DOMException && error.name === 'AbortError') return 'The request was cancelled.';
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
