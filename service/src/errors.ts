import type { ErrorCode } from './shared/contract.js';

/** An error that is safe to show to the API client: it carries the HTTP status and a stable machine-readable code. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) => new ApiError(400, 'bad_request', message, details);
export const validationFailed = (message: string, details?: unknown) =>
  new ApiError(400, 'validation_failed', message, details);
export const notFound = (message: string) => new ApiError(404, 'not_found', message);
export const conflict = (message: string) => new ApiError(409, 'conflict', message);

/** errno-style error code of a Node.js error, if any. */
export function errnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Unknown error';
}

/** Translate low-level filesystem errors into something a person can act on. */
export function describeFsError(error: unknown, action: string): string {
  switch (errnoCode(error)) {
    case 'ENOSPC':
      return `${action}: the disk is full.`;
    case 'EACCES':
    case 'EPERM':
      return `${action}: permission denied. Check that the folder is writable and not locked by another program.`;
    case 'EBUSY':
      return `${action}: the file is in use by another program.`;
    case 'ENOENT':
      return `${action}: the file or folder no longer exists.`;
    case 'ENAMETOOLONG':
      return `${action}: the path is too long.`;
    case 'EROFS':
      return `${action}: the location is read-only.`;
    default:
      return `${action}: ${errorMessage(error)}`;
  }
}
