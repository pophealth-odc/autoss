export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SENSITIVE_KEY = /token|authorization|cookie|secret|password|credential/i;

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export type LogSink = (level: Exclude<LogLevel, 'silent'>, line: string) => void;

const defaultSink: LogSink = (level, line) => {
  if (level === 'warn' || level === 'error') console.error(line);
  else console.log(line);
};

function redact(value: unknown, depth = 0): unknown {
  if (depth > 3 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) return '';
  try {
    return ' ' + JSON.stringify(redact(meta));
  } catch {
    return ' [unserializable meta]';
  }
}

export function createLogger(level: LogLevel, sink: LogSink = defaultSink): Logger {
  const threshold = ORDER[level];
  const emit = (lvl: Exclude<LogLevel, 'silent'>, message: string, meta?: Record<string, unknown>) => {
    if (ORDER[lvl] < threshold) return;
    const time = new Date().toISOString().slice(11, 23);
    sink(lvl, `${time} ${lvl.toUpperCase().padEnd(5)} ${message}${formatMeta(meta)}`);
  };
  return {
    level,
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
  };
}

export const silentLogger: Logger = createLogger('silent');
