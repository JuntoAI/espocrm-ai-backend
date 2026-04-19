/**
 * Property-based tests for structured JSON logging.
 *
 * **Validates: Requirements 9.6**
 *
 * Property 14: Structured JSON Logging
 * For any logged event (request received, tool executed, error occurred),
 * the log output should be valid JSON containing at minimum: `timestamp`
 * (ISO 8601), `level` (error/warn/info/debug), and `message` (non-empty string).
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import * as fc from 'fast-check';
import { createLogger } from '../../src/utils/logger.js';
import Transport from 'winston-transport';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture log output as parsed JSON objects via a custom Winston transport. */
class CaptureTransport extends Transport {
  public entries: Record<string, unknown>[] = [];

  log(info: Record<string, unknown>, callback: () => void): void {
    const serialised = JSON.stringify(info);
    this.entries.push(JSON.parse(serialised) as Record<string, unknown>);
    callback();
  }
}

/** ISO 8601 regex — matches formats like 2025-07-15T10:30:00.000+00:00 */
const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

const VALID_LEVELS = ['error', 'warn', 'info', 'debug'] as const;

/** Arbitrary that produces non-empty, non-whitespace-only strings for log messages.
 *  Excludes '%' to avoid Winston's printf-style splat formatting consuming metadata. */
const nonEmptyMessageArb = fc
  .string({ minLength: 1 })
  .filter((s) => s.trim().length > 0 && !s.includes('%'));

/** Arbitrary that picks from valid Winston log levels. */
const logLevelArb = fc.constantFrom(...VALID_LEVELS);

/** Arbitrary for metadata values — simple JSON-safe primitives.
 *  Excludes -0 because JSON.stringify(-0) === "0", so round-trip loses sign. */
const metadataValueArb = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }).filter((n) => !Object.is(n, -0)),
  fc.boolean(),
);

/**
 * Arbitrary for metadata objects with safe keys.
 * Keys must be valid JS identifiers and must not collide with
 * Winston's built-in fields (level, message, timestamp).
 */
const metadataArb = fc
  .dictionary(
    fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,19}$/).filter(
      (k) => !['level', 'message', 'timestamp', 'Symbol(level)', 'Symbol(splat)'].includes(k),
    ),
    metadataValueArb,
    { minKeys: 1, maxKeys: 5 },
  );

// ---------------------------------------------------------------------------
// Test setup helper
// ---------------------------------------------------------------------------

function createTestLogger(): { log: ReturnType<typeof createLogger>; capture: CaptureTransport } {
  const capture = new CaptureTransport();
  const log = createLogger('debug');
  log.clear();
  log.add(capture);
  return { log, capture };
}

// ---------------------------------------------------------------------------
// Property 14: Structured JSON Logging
// ---------------------------------------------------------------------------

describe('Property 14: Structured JSON Logging', () => {
  const NUM_RUNS = 100;

  it('every log entry is valid JSON with required fields (timestamp, level, message)', () => {
    fc.assert(
      fc.property(logLevelArb, nonEmptyMessageArb, (level, message) => {
        const { log, capture } = createTestLogger();

        log[level](message);

        expect(capture.entries).toHaveLength(1);
        const entry = capture.entries[0];

        // Must have all three required fields
        expect(entry).toHaveProperty('timestamp');
        expect(entry).toHaveProperty('level');
        expect(entry).toHaveProperty('message');

        // Types must be correct
        expect(typeof entry.timestamp).toBe('string');
        expect(typeof entry.level).toBe('string');
        expect(typeof entry.message).toBe('string');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('timestamp is always ISO 8601 format', () => {
    fc.assert(
      fc.property(logLevelArb, nonEmptyMessageArb, (level, message) => {
        const { log, capture } = createTestLogger();

        log[level](message);

        const entry = capture.entries[0];
        const timestamp = entry.timestamp as string;

        // Must match ISO 8601 pattern
        expect(timestamp).toMatch(ISO_8601_RE);

        // Must be parseable as a valid date
        const parsed = new Date(timestamp);
        expect(parsed.getTime()).not.toBeNaN();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('level is always one of the valid levels (error/warn/info/debug)', () => {
    fc.assert(
      fc.property(logLevelArb, nonEmptyMessageArb, (level, message) => {
        const { log, capture } = createTestLogger();

        log[level](message);

        const entry = capture.entries[0];
        expect(VALID_LEVELS).toContain(entry.level);
        // The output level must match the level we logged at
        expect(entry.level).toBe(level);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('message is always a non-empty string matching the input', () => {
    fc.assert(
      fc.property(logLevelArb, nonEmptyMessageArb, (level, message) => {
        const { log, capture } = createTestLogger();

        log[level](message);

        const entry = capture.entries[0];
        const outputMessage = entry.message as string;

        expect(outputMessage.length).toBeGreaterThan(0);
        expect(outputMessage).toBe(message);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('custom metadata is preserved in the log output', () => {
    fc.assert(
      fc.property(logLevelArb, nonEmptyMessageArb, metadataArb, (level, message, metadata) => {
        const { log, capture } = createTestLogger();

        log[level](message, metadata);

        const entry = capture.entries[0];

        // Every key-value pair from metadata must appear in the output
        for (const [key, value] of Object.entries(metadata)) {
          expect(entry).toHaveProperty(key);
          expect(entry[key]).toEqual(value);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
