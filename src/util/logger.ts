import pino, { type Logger, type LoggerOptions } from 'pino';

export interface CreateLoggerOpts {
  runId: string;
  level?: LoggerOptions['level'];
  destination?: NodeJS.WritableStream;
}

export function createLogger({ runId, level = 'info', destination }: CreateLoggerOpts): Logger {
  const opts: LoggerOptions = { level, base: { runId } };
  return destination ? pino(opts, destination) : pino(opts);
}

export function makeRunId(tag: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = now.getUTCFullYear();
  const mm = pad(now.getUTCMonth() + 1);
  const dd = pad(now.getUTCDate());
  const HH = pad(now.getUTCHours());
  const MM = pad(now.getUTCMinutes());
  const SS = pad(now.getUTCSeconds());
  return `${yyyy}${mm}${dd}-${HH}${MM}${SS}-${tag}`;
}

export type { Logger };
