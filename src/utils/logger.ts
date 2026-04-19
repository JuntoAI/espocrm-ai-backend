/**
 * Structured JSON logger for the AI Backend.
 *
 * Outputs one valid JSON object per line to stdout, designed for
 * Docker / Cloud Logging collection. Each entry contains at minimum:
 * `timestamp` (ISO 8601), `level`, and `message`.
 *
 * @module logger
 */

import winston from 'winston';

/** Optional metadata fields that can be attached to any log entry. */
export interface LogEntry {
  userId?: string;
  toolName?: string;
  durationMs?: number;
  requestId?: string;
  sessionId?: string;
  error?: string;
  [key: string]: unknown;
}

/**
 * Valid log levels supported by the logger.
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const VALID_LOG_LEVELS: ReadonlySet<string> = new Set([
  'error',
  'warn',
  'info',
  'debug',
]);

/**
 * Resolve the log level from the `LOG_LEVEL` environment variable.
 * Falls back to `'info'` if the env var is unset or contains an
 * unrecognised value.
 */
function resolveLogLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (raw && VALID_LOG_LEVELS.has(raw)) {
    return raw as LogLevel;
  }
  return 'info';
}

/**
 * Create a Winston logger configured for structured JSON output.
 *
 * - JSON format with ISO 8601 timestamps
 * - Console transport (stdout) for Docker / Cloud Logging
 * - Log level sourced from `LOG_LEVEL` env var (default: `'info'`)
 */
export function createLogger(level?: LogLevel): winston.Logger {
  const effectiveLevel = level ?? resolveLogLevel();

  return winston.createLogger({
    level: effectiveLevel,
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
      winston.format.splat(),
      winston.format.json(),
    ),
    transports: [
      new winston.transports.Console({
        stderrLevels: [], // everything goes to stdout
      }),
    ],
    // Prevent Winston from exiting on uncaught exceptions — let the
    // process manager (Docker) handle restarts.
    exitOnError: false,
  });
}

/**
 * Default logger instance for the AI Backend.
 *
 * Usage:
 * ```ts
 * import { logger } from './utils/logger.js';
 * logger.info('Request received', { userId: 'user-001', requestId: 'abc' });
 * ```
 */
export const logger: winston.Logger = createLogger();
