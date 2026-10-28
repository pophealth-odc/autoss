import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RunController } from './automation/run-controller.js';
import { createUrlPolicy } from './browser/url-policy.js';
import type { ServiceConfig } from './config.js';
import { EventHub } from './events/event-hub.js';
import { createApp } from './http/app.js';
import { loadOrCreateToken, type PairingToken } from './http/auth.js';
import type { Logger } from './logger.js';
import { GalleryStore } from './storage/gallery-store.js';
import { ThumbnailService } from './storage/thumbnails.js';

export interface RunningService {
  server: Server;
  port: number;
  token: PairingToken;
  store: GalleryStore;
  runs: RunController;
  hub: EventHub;
  stop(): Promise<void>;
}

export interface StartOptions {
  config: ServiceConfig;
  logger: Logger;
  /** Overrides the token (tests). */
  token?: PairingToken;
  /** Lets tests substitute the run controller (for example with a fake browser). */
  runs?: (deps: ConstructorParameters<typeof RunController>[0]) => RunController;
}

/** Builds the service and starts listening on the loopback interface only. */
export async function startService(options: StartOptions): Promise<RunningService> {
  const { config, logger } = options;
  const startedAt = Date.now();

  const token = options.token ?? (await loadOrCreateToken(config.dataDir, config.pairingToken, logger));
  const store = await GalleryStore.open({ dataDir: config.dataDir, screenshotsDir: config.screenshotsDir, logger });
  const hub = new EventHub();
  const policy = createUrlPolicy({ allowPrivate: config.allowPrivateTargets, allowedHosts: config.allowedTargetHosts });
  const runDeps = { config, store, hub, policy, logger };
  const runs = options.runs ? options.runs(runDeps) : new RunController(runDeps);
  const thumbnails = new ThumbnailService(logger);

  // The port is only known after listening (config.port may be 0 in tests), so the Host allow-list is built afterwards.
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  server.on('error', (error) => logger.error('HTTP server error', { error: error.message }));

  server.on('request', createApp({ config, store, runs, hub, thumbnails, logger, startedAt, token: token.value, port }));

  // Long-lived streams (events, ZIP downloads) must not be cut off by the default HTTP timeouts.
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.timeout = 0;

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      hub.closeAll();
      await runs.shutdown();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), 2_000).unref();
      });
    })();
    return stopping;
  };

  return { server, port, token, store, runs, hub, stop };
}
