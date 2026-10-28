import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectEdge } from './browser/edge.js';
import { ConfigError, loadConfig } from './config.js';
import { buildPairingLink, gatewaySettingsFromEnv, publicOrigin, startGateway, type RunningGateway } from './gateway/gateway.js';
import { describeAllowedOrigins } from './http/app.js';
import { createLogger } from './logger.js';
import { startService } from './server.js';

/** The service folder, whether running from src/ (tsx) or dist/ (compiled). */
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function loadEnvFile(): void {
  const file = path.join(rootDir, '.env');
  if (!existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch (error) {
    console.error(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function bar(text: string): string {
  return `  ${text}`;
}

async function main(): Promise<void> {
  loadEnvFile();

  let config;
  let gatewaySettings;
  try {
    config = loadConfig(process.env, rootDir, readVersion());
    gatewaySettings = gatewaySettingsFromEnv(process.env, rootDir);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      console.error('\nFix service/.env (see service/.env.example) and start again.');
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger(config.logLevel);
  const edge = await detectEdge({ explicitPath: config.edgePath });

  let service;
  try {
    service = await startService({ config, logger });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      console.error(`\nPort ${config.port} is already in use. Another copy of the service may be running.`);
      console.error('Close it, or set PORT in service/.env to a different number.');
    } else {
      console.error(`\nThe service could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }

  const url = `http://${config.host === '::1' ? '[::1]' : config.host}:${service.port}`;
  const lines = [
    '',
    '  Screenshot Gallery - local automation service',
    '  ---------------------------------------------',
    bar(`Listening on   ${url}  (this computer only)`),
    bar(`Screenshots    ${config.screenshotsDir}`),
    bar(`Browser        ${edge.found ? `Microsoft Edge ${edge.version ?? ''}`.trim() : 'Microsoft Edge NOT FOUND'}`),
    bar(`Allowed sites  ${describeAllowedOrigins(config)}`),
    '',
    bar('PAIRING TOKEN (paste it into the web page under Settings):'),
    bar(service.token.value),
  ];
  if (config.frontendUrl) {
    const link = `${config.frontendUrl.replace(/\/$/, '')}/#/connect?service=${encodeURIComponent(url)}&token=${encodeURIComponent(service.token.value)}`;
    lines.push('', bar('One-click pairing link (open it in Edge):'), bar(link));
  }
  if (!edge.found) lines.push('', bar(`WARNING: ${edge.hint ?? 'Microsoft Edge was not found.'}`));
  if (service.token.source === 'generated' && service.token.file) lines.push('', bar(`The token is stored in ${service.token.file}`));

  // Optional: serve the built web page and the API from one address (used in GitHub Codespaces).
  let gateway: RunningGateway | null = null;
  if (gatewaySettings) {
    try {
      gateway = await startGateway({ ...gatewaySettings, upstreamPort: service.port, logger });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      console.error(
        code === 'EADDRINUSE'
          ? `\nGateway port ${gatewaySettings.port} is already in use. Set GATEWAY_PORT to a different number.`
          : `\nThe gateway could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
      await service.stop().catch(() => undefined);
      process.exit(1);
    }
    const origin = publicOrigin(process.env, gateway.port);
    lines.push(
      '',
      bar('Web page + service on one address (GATEWAY_ENABLED):'),
      bar(origin),
      bar('Open this link once to pair this browser:'),
      bar(buildPairingLink(origin, service.token.value)),
    );
  }

  lines.push('', bar('Keep this window open while you use the gallery. Press Ctrl+C to stop.'), '');
  console.log(lines.join('\n'));

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down…`);
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref();
    // The gateway stops first so no new request reaches a service that is closing.
    (gateway ? gateway.stop() : Promise.resolve()).then(() => service.stop()).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason) });
  });
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: error.stack ?? error.message });
    shutdown('uncaughtException');
  });
}

void main();
