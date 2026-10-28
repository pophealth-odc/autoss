import path from 'node:path';
import type { LogLevel } from './logger.js';
import { DEFAULT_SERVICE_PORT } from './shared/contract.js';

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export interface ServiceConfig {
  version: string;
  /** Always a loopback address. The service is never reachable from other computers. */
  host: '127.0.0.1' | '::1';
  port: number;
  rootDir: string;
  dataDir: string;
  screenshotsDir: string;
  profilesDir: string;
  /** Exact origins (scheme + host + port) that may call the API from a browser. */
  allowedOrigins: string[];
  /** Also accept http://localhost:*, http://127.0.0.1:* and http://[::1]:* (local development of the UI). */
  allowLocalhostOrigins: boolean;
  /** Optional fixed pairing token (otherwise a random one is generated once and stored in dataDir). */
  pairingToken: string | null;
  allowPrivateTargets: boolean;
  allowedTargetHosts: string[];
  maxFullPageHeight: number;
  edgePath: string | null;
  /** Used only to print a ready-made pairing link in the start-up banner. */
  frontendUrl: string | null;
  logLevel: LogLevel;
}

type Env = Record<string, string | undefined>;

const TRUE = /^(1|true|yes|on)$/i;
const FALSE = /^(0|false|no|off)$/i;

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function loadConfig(env: Env, rootDir: string, version: string): ServiceConfig {
  const problems: string[] = [];

  const bool = (name: string, fallback: boolean): boolean => {
    const raw = clean(env[name]);
    if (raw === undefined) return fallback;
    if (TRUE.test(raw)) return true;
    if (FALSE.test(raw)) return false;
    problems.push(`${name} must be true or false (got "${raw}")`);
    return fallback;
  };

  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = clean(env[name]);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
      return fallback;
    }
    return n;
  };

  const dir = (name: string, fallback: string): string => {
    const raw = clean(env[name]);
    return path.resolve(rootDir, raw ?? fallback);
  };

  const list = (name: string): string[] =>
    (clean(env[name]) ?? '')
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  // Host: loopback only.
  let host: ServiceConfig['host'] = '127.0.0.1';
  const rawHost = clean(env['HOST'])?.toLowerCase();
  if (rawHost !== undefined) {
    if (rawHost === '127.0.0.1' || rawHost === 'localhost') host = '127.0.0.1';
    else if (rawHost === '::1' || rawHost === '[::1]') host = '::1';
    else {
      problems.push(
        `HOST must be a loopback address (127.0.0.1 or ::1), got "${rawHost}". ` +
          'The service is designed to be reachable only from this computer and refuses to listen on other interfaces.',
      );
    }
  }

  const port = int('PORT', DEFAULT_SERVICE_PORT, 0, 65_535);

  // Origins.
  const allowedOrigins: string[] = [];
  for (const entry of list('ALLOWED_ORIGINS')) {
    try {
      const url = new URL(entry);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme');
      if (!allowedOrigins.includes(url.origin)) allowedOrigins.push(url.origin);
    } catch {
      problems.push(`ALLOWED_ORIGINS entry "${entry}" is not a valid http(s) origin such as https://yourname.github.io`);
    }
  }

  let frontendUrl: string | null = null;
  const rawFrontend = clean(env['FRONTEND_URL']);
  if (rawFrontend !== undefined) {
    try {
      const url = new URL(rawFrontend);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme');
      url.hash = '';
      url.search = '';
      frontendUrl = url.toString();
    } catch {
      problems.push(`FRONTEND_URL "${rawFrontend}" is not a valid http(s) URL`);
    }
  }

  const rawLevel = (clean(env['LOG_LEVEL']) ?? 'info').toLowerCase();
  const logLevel: LogLevel = (['debug', 'info', 'warn', 'error', 'silent'] as const).includes(rawLevel as LogLevel)
    ? (rawLevel as LogLevel)
    : 'info';
  if (logLevel !== rawLevel) problems.push(`LOG_LEVEL must be one of debug, info, warn, error, silent (got "${rawLevel}")`);

  const pairingToken = clean(env['PAIRING_TOKEN']) ?? null;
  if (pairingToken !== null && !/^[A-Za-z0-9_\-.~+/=]{24,200}$/.test(pairingToken)) {
    problems.push('PAIRING_TOKEN must be 24-200 URL-safe characters. Leave it empty to generate a random token automatically.');
  }

  const dataDir = dir('DATA_DIR', 'data');
  const config: ServiceConfig = {
    version,
    host,
    port,
    rootDir,
    dataDir,
    screenshotsDir: dir('SCREENSHOTS_DIR', 'screenshots'),
    profilesDir: path.join(dataDir, 'profiles'),
    allowedOrigins,
    allowLocalhostOrigins: bool('ALLOW_LOCALHOST_ORIGINS', true),
    pairingToken,
    allowPrivateTargets: bool('ALLOW_PRIVATE_TARGETS', false),
    allowedTargetHosts: list('ALLOWED_TARGET_HOSTS').map((h) => h.toLowerCase()),
    maxFullPageHeight: int('MAX_FULLPAGE_HEIGHT', 30_000, 1_000, 100_000),
    edgePath: clean(env['EDGE_PATH']) ?? null,
    frontendUrl,
    logLevel,
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
