import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createLogger, logger } from '../../src/utils/logger.js';
import type { LogEntry } from '../../src/utils/logger.js';
import { Writable } from 'node:stream';
import Transport from 'winston-transport';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture log output as parsed JSON objects via a custom Winston transport. */
class CaptureTransport extends Transport {
  public entries: Record<string, unknown>[] = [];

  log(info: Record<string, unknown>, callback: () => void): void {
    // Winston's `info` object already contains the merged JSON fields.
    // We serialise and re-parse to simulate what stdout would receive.
    const serialised = JSON.stringify(info);
    this.entries.push(JSON.parse(serialised) as Record<string, unknown>);
    callback();
  }
}

/** ISO 8601 regex — matches formats like 2025-07-15T10:30:00.000+00:00 */
const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

// ---------------------------------------------------------------------------
// createLogger
// ---------------------------------------------------------------------------

describe('createLogger', () => {
  let originalLogLevel: string | undefined;

  beforeEach(() => {
    originalLogLevel = process.env.LOG_LEVEL;
  });

  afterEach(() => {
    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
  });

  it('creates a logger instance successfully', () => {
    const log = createLogger();
    expect(log).toBeDefined();
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.debug).toBe('function');
  });

  it('defaults to info level when LOG_LEVEL is not set', () => {
    delete process.env.LOG_LEVEL;
    const log = createLogger();
    expect(log.level).toBe('info');
  });

  it('respects LOG_LEVEL env var set to debug', () => {
    process.env.LOG_LEVEL = 'debug';
    const log = createLogger();
    expect(log.level).toBe('debug');
  });

  it('respects LOG_LEVEL env var set to error', () => {
    process.env.LOG_LEVEL = 'error';
    const log = createLogger();
    expect(log.level).toBe('error');
  });

  it('respects LOG_LEVEL env var set to warn', () => {
    process.env.LOG_LEVEL = 'warn';
    const log = createLogger();
    expect(log.level).toBe('warn');
  });

  it('falls back to info for invalid LOG_LEVEL values', () => {
    process.env.LOG_LEVEL = 'verbose';
    const log = createLogger();
    expect(log.level).toBe('info');
  });

  it('falls back to info for empty LOG_LEVEL', () => {
    process.env.LOG_LEVEL = '';
    const log = createLogger();
    expect(log.level).toBe('info');
  });

  it('handles LOG_LEVEL with extra whitespace', () => {
    process.env.LOG_LEVEL = '  debug  ';
    const log = createLogger();
    expect(log.level).toBe('debug');
  });

  it('handles LOG_LEVEL case-insensitively', () => {
    process.env.LOG_LEVEL = 'DEBUG';
    const log = createLogger();
    expect(log.level).toBe('debug');
  });

  it('accepts an explicit level parameter that overrides env var', () => {
    process.env.LOG_LEVEL = 'error';
    const log = createLogger('debug');
    expect(log.level).toBe('debug');
  });
});

// ---------------------------------------------------------------------------
// Log output format
// ---------------------------------------------------------------------------

describe('log output format', () => {
  let capture: CaptureTransport;
  let log: ReturnType<typeof createLogger>;

  beforeEach(() => {
    capture = new CaptureTransport();
    log = createLogger('debug');
    // Replace transports with our capture transport
    log.clear();
    log.add(capture);
  });

  it('outputs valid JSON for an info message', () => {
    log.info('Request received');
    expect(capture.entries).toHaveLength(1);
    // If we got here, JSON.parse succeeded in the transport
    const entry = capture.entries[0];
    expect(entry).toBeDefined();
  });

  it('includes timestamp field in ISO 8601 format', () => {
    log.info('test');
    const entry = capture.entries[0];
    expect(entry.timestamp).toBeDefined();
    expect(typeof entry.timestamp).toBe('string');
    expect(entry.timestamp as string).toMatch(ISO_8601_RE);
  });

  it('includes level field', () => {
    log.warn('something');
    const entry = capture.entries[0];
    expect(entry.level).toBe('warn');
  });

  it('includes message field', () => {
    log.info('Hello world');
    const entry = capture.entries[0];
    expect(entry.message).toBe('Hello world');
  });

  it('contains timestamp, level, and message in every entry', () => {
    log.error('boom');
    const entry = capture.entries[0];
    expect(entry).toHaveProperty('timestamp');
    expect(entry).toHaveProperty('level');
    expect(entry).toHaveProperty('message');
  });

  it('merges custom metadata fields into the JSON output', () => {
    log.info('Tool executed', {
      userId: 'user-001',
      toolName: 'create_contact',
      durationMs: 150,
      requestId: 'req-abc',
    });
    const entry = capture.entries[0];
    expect(entry.userId).toBe('user-001');
    expect(entry.toolName).toBe('create_contact');
    expect(entry.durationMs).toBe(150);
    expect(entry.requestId).toBe('req-abc');
  });

  it('handles error level with metadata', () => {
    log.error('Gemini timeout', { durationMs: 30000, error: 'ETIMEDOUT' });
    const entry = capture.entries[0];
    expect(entry.level).toBe('error');
    expect(entry.message).toBe('Gemini timeout');
    expect(entry.durationMs).toBe(30000);
  });

  it('handles debug level messages', () => {
    log.debug('Verbose detail', { sessionId: 'sess-123' });
    const entry = capture.entries[0];
    expect(entry.level).toBe('debug');
    expect(entry.sessionId).toBe('sess-123');
  });

  it('respects log level filtering — debug messages suppressed at info level', () => {
    const infoLog = createLogger('info');
    infoLog.clear();
    const infoCapture = new CaptureTransport({ level: 'info' });
    infoLog.add(infoCapture);

    infoLog.debug('should be suppressed');
    infoLog.info('should appear');

    expect(infoCapture.entries).toHaveLength(1);
    expect(infoCapture.entries[0].message).toBe('should appear');
  });
});

// ---------------------------------------------------------------------------
// Default logger export
// ---------------------------------------------------------------------------

describe('default logger export', () => {
  it('exports a logger instance', () => {
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });
});
