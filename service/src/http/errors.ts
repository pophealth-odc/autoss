import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { ApiError, errorMessage } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ApiErrorBody, ErrorCode } from '../shared/contract.js';

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  429: 'rate_limited',
};

/** Gives every request an id that appears in both the response and the log, so problems can be correlated. */
export const requestId: RequestHandler = (req, res, next) => {
  const id = randomUUID().slice(0, 8);
  res.locals['requestId'] = id;
  res.setHeader('X-Request-Id', id);
  void req;
  next();
};

export function notFoundHandler(): RequestHandler {
  return (req, _res, next) => {
    next(new ApiError(404, 'not_found', `No such endpoint: ${req.method} ${req.path.slice(0, 120)}`));
  };
}

/** Maps every kind of error to the single `{ error: { code, message } }` response shape. No stack traces leave the process. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (res.headersSent) {
      // A stream is already under way (ZIP, event stream): the only honest signal left is to cut the connection.
      res.destroy();
      void next;
      return;
    }
    const id = typeof res.locals['requestId'] === 'string' ? (res.locals['requestId'] as string) : undefined;
    let status = 500;
    let code: ErrorCode = 'internal_error';
    let message = 'Something went wrong inside the service.';
    let details: unknown;

    if (error instanceof ApiError) {
      status = error.status;
      code = error.code;
      message = error.message;
      details = error.details;
    } else if (error instanceof ZodError) {
      status = 400;
      code = 'validation_failed';
      message = error.issues[0]?.message ?? 'The request is not valid.';
      details = error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    } else if (typeof error === 'object' && error !== null && 'type' in error && (error as { type: unknown }).type === 'entity.too.large') {
      status = 413;
      code = 'payload_too_large';
      message = 'The request body is too large.';
    } else if (typeof error === 'object' && error !== null && 'type' in error && (error as { type: unknown }).type === 'entity.parse.failed') {
      status = 400;
      code = 'bad_request';
      message = 'The request body is not valid JSON.';
    } else if (typeof error === 'object' && error !== null && 'status' in error && typeof (error as { status: unknown }).status === 'number') {
      const s = (error as { status: number }).status;
      if (s >= 400 && s < 500) {
        status = s;
        code = STATUS_TO_CODE[s] ?? 'bad_request';
        message = 'The request could not be processed.';
      }
    }

    if (status >= 500) {
      logger.error('Request failed', { requestId: id, method: req.method, path: req.path, error: error instanceof Error ? (error.stack ?? error.message) : errorMessage(error) });
    } else {
      logger.debug('Request rejected', { requestId: id, status, code, path: req.path });
    }

    const body: ApiErrorBody = { error: { code, message, ...(details !== undefined ? { details } : {}), ...(id ? { requestId: id } : {}) } };
    res.status(status).json(body);
  };
}
