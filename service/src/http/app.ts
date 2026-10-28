import express, { type Express, type RequestHandler } from 'express';
import type { ServiceConfig } from '../config.js';
import { FailureLimiter, requireAuth } from './auth.js';
import { errorHandler, notFoundHandler, requestId } from './errors.js';
import { corsPolicy, hostGuard } from './origin-host.js';
import { createApiRouter, type RouteDeps } from './routes.js';

export interface AppOptions extends RouteDeps {
  token: string;
  /** Listening port used for the Host allow-list. Tests pass the ephemeral port they bound. */
  port: number;
  limiter?: FailureLimiter;
}

const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); // pages on other origins must be able to read it (CORS still applies)
  // Nothing served here is ever meant to run as a page.
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  next();
};

const noStoreForJson: RequestHandler = (_req, res, next) => {
  const original = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (!res.hasHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
    return original(body);
  }) as typeof res.json;
  next();
};

export function createApp(options: AppOptions): Express {
  const { config, logger } = options;
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', false);

  app.use(requestId);
  app.use(securityHeaders);
  app.use(hostGuard({ port: options.port, allowedOrigins: config.allowedOrigins, allowLocalhostOrigins: config.allowLocalhostOrigins }));
  app.use(corsPolicy({ port: options.port, allowedOrigins: config.allowedOrigins, allowLocalhostOrigins: config.allowLocalhostOrigins }));
  app.use(noStoreForJson);

  const { open, authed } = createApiRouter(options);
  const api = express.Router();
  api.use(open);
  api.use(
    requireAuth({ token: options.token, limiter: options.limiter ?? new FailureLimiter(), logger }),
  );
  api.use(express.json({ limit: '256kb', strict: true, type: ['application/json'] }));
  api.use(authed);
  app.use('/api', api);

  // Everything else (including "/") is not a page this service provides.
  app.use(notFoundHandler());
  app.use(errorHandler(logger));
  return app;
}

export function describeAllowedOrigins(config: ServiceConfig): string {
  const parts = [...config.allowedOrigins];
  if (config.allowLocalhostOrigins) parts.push('http://localhost:* and http://127.0.0.1:* (local development)');
  return parts.length > 0 ? parts.join(', ') : '(none)';
}
