/**
 * Property-based tests for error sanitization.
 *
 * **Validates: Requirements 4.7, 6.4, 7.4**
 *
 * Property 6: Error Sanitization
 * For any error originating from Gemini API failures, EspoCRM permission
 * denials (403), tool execution failures, or search grounding unavailability,
 * the user-facing response message should not contain stack traces, API keys,
 * internal URLs, or raw error objects. The message should be a human-readable
 * sentence.
 */

import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import {
  sanitizeError,
  getUserFriendlyMessage,
} from '../../src/utils/error-sanitizer.js';

// ---------------------------------------------------------------------------
// Custom arbitraries — generate realistic sensitive data
// ---------------------------------------------------------------------------

/** Generates realistic Node.js-style stack trace lines. */
const stackTraceLineArb = fc.tuple(
  fc.constantFrom(
    'Object.<anonymous>',
    'Module._compile',
    'processTicksAndRejections',
    'GeminiService.chat',
    'CRMExecutor.execute',
    'SessionManager.getOrCreate',
    'RateLimiter.check',
    'async Promise.all',
  ),
  fc.constantFrom(
    '/app/src/index.ts',
    '/app/src/services/gemini-service.ts',
    '/app/src/services/crm-executor.ts',
    '/app/node_modules/express/lib/router/index.js',
    'node:internal/modules/cjs/loader',
    '/home/user/project/dist/server.js',
  ),
  fc.integer({ min: 1, max: 500 }),
  fc.integer({ min: 1, max: 80 }),
).map(([fn, file, line, col]) => `    at ${fn} (${file}:${line}:${col})`);

/** Generates a multi-line stack trace string. */
const stackTraceArb = fc
  .array(stackTraceLineArb, { minLength: 1, maxLength: 8 })
  .map((lines) => lines.join('\n'));

/** Generates strings that look like API keys / secrets. */
const apiKeyPatternArb = fc.oneof(
  // apiKey=VALUE
  fc.tuple(
    fc.constantFrom('apiKey', 'api_key', 'key', 'token', 'secret', 'password', 'credential'),
    fc.constantFrom('=', ': '),
    fc.hexaString({ minLength: 16, maxLength: 64 }),
  ).map(([k, sep, v]) => `${k}${sep}${v}`),
  // X-Api-Key: VALUE
  fc.tuple(
    fc.constantFrom('X-Api-Key', 'Authorization', 'Bearer'),
    fc.hexaString({ minLength: 20, maxLength: 64 }),
  ).map(([header, val]) => `${header}: ${val}`),
  // Long hex strings (32+ chars) that look like keys
  fc.hexaString({ minLength: 32, maxLength: 64 }),
  // Bearer token pattern
  fc.tuple(
    fc.constant('Authorization: Bearer'),
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-'.split('')), { minLength: 32, maxLength: 80 }),
  ).map(([prefix, token]) => `${prefix} ${token}`),
);

/** Generates internal/infrastructure URLs that should never leak. */
const internalUrlArb = fc.tuple(
  fc.constantFrom('http'),
  fc.constantFrom(
    'localhost',
    '127.0.0.1',
    'espocrm-app',
    'ai-backend',
    'mcp-server',
    '0.0.0.0',
    'host.docker.internal',
    'internal',
  ),
  fc.integer({ min: 1000, max: 65535 }),
  fc.constantFrom(
    '/chat',
    '/health',
    '/api/v1/Contact',
    '/api/v1/Account',
    '/api/v1/App/user',
    '',
  ),
).map(([proto, host, port, path]) => `${proto}://${host}:${port}${path}`);

/** Generates error messages with embedded stack traces. */
const errorWithStackTraceArb = fc.tuple(
  fc.constantFrom(
    'Error: Connection failed',
    'TypeError: Cannot read property',
    'Error: Gemini API timeout',
    'RangeError: Maximum call stack size exceeded',
    'Error: Tool execution failed',
  ),
  stackTraceArb,
).map(([msg, stack]) => `${msg}\n${stack}`);

/** Generates error messages with embedded API key patterns. */
const errorWithApiKeyArb = fc.tuple(
  fc.constantFrom(
    'Request failed with',
    'Error calling API:',
    'Authentication error:',
    'Headers sent:',
    'Config dump:',
  ),
  apiKeyPatternArb,
).map(([prefix, key]) => `${prefix} ${key}`);

/** Generates error messages with embedded internal URLs. */
const errorWithInternalUrlArb = fc.tuple(
  fc.constantFrom(
    'ECONNREFUSED',
    'Failed to reach',
    'Connection refused:',
    'Error calling',
    'Timeout connecting to',
  ),
  internalUrlArb,
).map(([prefix, url]) => `${prefix} ${url}`);

/** Generates error objects (not just strings) with sensitive data. */
const errorObjectArb = fc.oneof(
  // Error instance with stack
  fc.tuple(
    fc.constantFrom('Something broke', 'Timeout', 'Permission denied', 'Tool failed'),
    stackTraceArb,
  ).map(([msg, stack]) => {
    const err = new Error(msg);
    err.stack = `Error: ${msg}\n${stack}`;
    return err;
  }),
  // Plain object with message containing sensitive data
  fc.tuple(
    errorWithStackTraceArb,
    fc.constantFrom(200, 403, 500, 503),
  ).map(([message, status]) => ({ message, status })),
  // Object with internal URL in error field
  errorWithInternalUrlArb.map((msg) => ({ error: msg })),
  // Object with API key in msg field
  errorWithApiKeyArb.map((msg) => ({ msg })),
);

/**
 * Generates a "kitchen sink" error — an error string that contains
 * ALL types of sensitive data at once.
 */
const kitchenSinkErrorArb = fc.tuple(
  fc.constantFrom('Error: something failed', 'Critical failure'),
  stackTraceArb,
  apiKeyPatternArb,
  internalUrlArb,
).map(([msg, stack, key, url]) =>
  `${msg}\n${stack}\nRequest to ${url} with ${key}`,
);

/** Generates any possible input value (for robustness testing). */
const anyInputArb = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(''),
  fc.constant('   '),
  fc.constant('\t\n'),
  fc.string(),
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.constant({}),
  fc.constant([]),
  fc.array(fc.anything()),
  fc.dictionary(fc.string(), fc.anything()),
  errorObjectArb,
  errorWithStackTraceArb,
  errorWithApiKeyArb,
  errorWithInternalUrlArb,
  kitchenSinkErrorArb,
);

// ---------------------------------------------------------------------------
// Detection regexes — used to assert sensitive data is absent
// ---------------------------------------------------------------------------

/** Matches stack trace patterns in output. */
const STACK_TRACE_DETECT =
  /\bat\s+[\w.<>[\]]+\s*\([\w/\\.:@-]+:\d+:\d+\)/;

/** Matches common API key patterns in output. */
const API_KEY_DETECT_PATTERNS = [
  /(?:api[_-]?key|key|token|secret|password|credential)\s*[=:]\s*[A-Za-z0-9_\-]{8,}/i,
  /(?:X-Api-Key|Authorization|Bearer)\s*[:=]\s*[A-Za-z0-9_\-.]{8,}/i,
  /\b[A-Fa-f0-9]{32,}\b/,
];

/** Matches internal URLs in output. */
const INTERNAL_URL_DETECT =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|espocrm-app|ai-backend|mcp-server|internal|host\.docker\.internal)(?::\d+)/i;

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('Property 6: Error Sanitization', () => {
  const NUM_RUNS = 100;

  it('no stack traces in output', () => {
    fc.assert(
      fc.property(errorWithStackTraceArb, (errorMsg) => {
        const result = sanitizeError(errorMsg);
        expect(result).not.toMatch(STACK_TRACE_DETECT);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('no API keys in output', () => {
    fc.assert(
      fc.property(errorWithApiKeyArb, (errorMsg) => {
        const result = sanitizeError(errorMsg);
        for (const pattern of API_KEY_DETECT_PATTERNS) {
          expect(result).not.toMatch(pattern);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('no internal URLs in output', () => {
    fc.assert(
      fc.property(errorWithInternalUrlArb, (errorMsg) => {
        const result = sanitizeError(errorMsg);
        expect(result).not.toMatch(INTERNAL_URL_DETECT);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('output is always non-empty', () => {
    fc.assert(
      fc.property(anyInputArb, (input) => {
        const result = sanitizeError(input);
        expect(result.length).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('output is always a string', () => {
    fc.assert(
      fc.property(anyInputArb, (input) => {
        const result = sanitizeError(input);
        expect(typeof result).toBe('string');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('getUserFriendlyMessage never contains sensitive data', () => {
    fc.assert(
      fc.property(errorObjectArb, (errorInput) => {
        const msg = getUserFriendlyMessage(errorInput);

        // Must be a non-empty string
        expect(typeof msg).toBe('string');
        expect(msg.length).toBeGreaterThan(0);

        // Must not contain stack traces
        expect(msg).not.toMatch(STACK_TRACE_DETECT);

        // Must not contain API keys
        for (const pattern of API_KEY_DETECT_PATTERNS) {
          expect(msg).not.toMatch(pattern);
        }

        // Must not contain internal URLs
        expect(msg).not.toMatch(INTERNAL_URL_DETECT);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('kitchen-sink errors with all sensitive data types are fully sanitized', () => {
    fc.assert(
      fc.property(kitchenSinkErrorArb, (errorMsg) => {
        const result = sanitizeError(errorMsg);

        // No stack traces
        expect(result).not.toMatch(STACK_TRACE_DETECT);

        // No API keys
        for (const pattern of API_KEY_DETECT_PATTERNS) {
          expect(result).not.toMatch(pattern);
        }

        // No internal URLs
        expect(result).not.toMatch(INTERNAL_URL_DETECT);

        // Non-empty string
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
