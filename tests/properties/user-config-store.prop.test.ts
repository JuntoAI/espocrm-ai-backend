/**
 * Property-based tests for UserConfigStore.
 *
 * Feature: proactive-crm-agent
 *
 * **Validates: Requirements 5.1, 5.2, 5.3**
 */

import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import * as fc from 'fast-check';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { UserConfigStore, USER_CONFIG_DEFAULTS, UserConfig } from '../../src/services/user-config-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NUM_RUNS = 100;

/** Create a unique temp directory for each test run. */
function makeTempDir(): string {
  const suffix = randomBytes(8).toString('hex');
  return path.join(os.tmpdir(), `user-config-store-test-${suffix}`);
}

/** Track temp dirs for cleanup. */
let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
  tempDirs = [];
});

/** Create a fresh store with its own temp directory. */
function createStore(): UserConfigStore {
  const dir = makeTempDir();
  tempDirs.push(dir);
  return new UserConfigStore(dir);
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Valid engagementDecayDays: integer 1-90. */
const validDecayArb = fc.integer({ min: 1, max: 90 });

/** Valid activityWindowDays: integer 1-30. */
const validWindowArb = fc.integer({ min: 1, max: 30 });

/** A valid full UserConfig. */
const validConfigArb = fc.record({
  engagementDecayDays: validDecayArb,
  activityWindowDays: validWindowArb,
});

/** A valid partial UserConfig (at least one field present). */
const validPartialConfigArb = fc.oneof(
  // Only engagementDecayDays
  fc.record({ engagementDecayDays: validDecayArb }).map((r) => r as Partial<UserConfig>),
  // Only activityWindowDays
  fc.record({ activityWindowDays: validWindowArb }).map((r) => r as Partial<UserConfig>),
  // Both fields
  validConfigArb.map((r) => r as Partial<UserConfig>),
);

/** A simple alphanumeric userId. */
const userIdArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  { minLength: 1, maxLength: 20 },
);

/** Invalid engagementDecayDays values (outside 1-90 or non-integer). */
const invalidDecayArb = fc.oneof(
  fc.integer({ min: -1000, max: 0 }),       // too low
  fc.integer({ min: 91, max: 10000 }),      // too high
  fc.double({ min: 1.01, max: 89.99, noNaN: true, noDefaultInfinity: true })
    .filter((n) => !Number.isInteger(n)),   // non-integer within range
  fc.constant(NaN),
  fc.constant(Infinity),
  fc.constant(-Infinity),
);

/** Invalid activityWindowDays values (outside 1-30 or non-integer). */
const invalidWindowArb = fc.oneof(
  fc.integer({ min: -1000, max: 0 }),       // too low
  fc.integer({ min: 31, max: 10000 }),      // too high
  fc.double({ min: 1.01, max: 29.99, noNaN: true, noDefaultInfinity: true })
    .filter((n) => !Number.isInteger(n)),   // non-integer within range
  fc.constant(NaN),
  fc.constant(Infinity),
  fc.constant(-Infinity),
);

/** Generate an invalid partial config (at least one field invalid). */
const invalidPartialConfigArb = fc.oneof(
  // Invalid engagementDecayDays only
  invalidDecayArb.map((v) => ({ engagementDecayDays: v } as Partial<UserConfig>)),
  // Invalid activityWindowDays only
  invalidWindowArb.map((v) => ({ activityWindowDays: v } as Partial<UserConfig>)),
  // Both invalid
  fc.tuple(invalidDecayArb, invalidWindowArb).map(([d, w]) => ({
    engagementDecayDays: d,
    activityWindowDays: w,
  } as Partial<UserConfig>)),
);

// ---------------------------------------------------------------------------
// Property 12: Config merge with defaults
// ---------------------------------------------------------------------------

// Feature: proactive-crm-agent, Property 12: Config merge with defaults
describe('Property 12: Config merge with defaults', () => {
  it('partial update returns complete config with updated fields and defaults for non-updated fields', async () => {
    await fc.assert(
      fc.asyncProperty(userIdArb, validPartialConfigArb, async (userId, partial) => {
        const store = createStore();

        // Set partial config
        const result = await store.set(userId, partial);

        // Result must be a complete UserConfig (both fields present)
        expect(result).toHaveProperty('engagementDecayDays');
        expect(result).toHaveProperty('activityWindowDays');
        expect(typeof result.engagementDecayDays).toBe('number');
        expect(typeof result.activityWindowDays).toBe('number');

        // Updated fields reflect new values
        if (partial.engagementDecayDays !== undefined) {
          expect(result.engagementDecayDays).toBe(partial.engagementDecayDays);
        }
        if (partial.activityWindowDays !== undefined) {
          expect(result.activityWindowDays).toBe(partial.activityWindowDays);
        }

        // Non-updated fields retain defaults (since this is a fresh store)
        if (partial.engagementDecayDays === undefined) {
          expect(result.engagementDecayDays).toBe(USER_CONFIG_DEFAULTS.engagementDecayDays);
        }
        if (partial.activityWindowDays === undefined) {
          expect(result.activityWindowDays).toBe(USER_CONFIG_DEFAULTS.activityWindowDays);
        }

        // Reading back should produce the same complete config
        const readBack = await store.get(userId);
        expect(readBack).toEqual(result);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('sequential partial updates merge correctly — non-updated fields retain previous values', async () => {
    await fc.assert(
      fc.asyncProperty(
        userIdArb,
        validDecayArb,
        validWindowArb,
        validPartialConfigArb,
        async (userId, firstDecay, firstWindow, secondPartial) => {
          const store = createStore();

          // First: set both fields to known values
          await store.set(userId, {
            engagementDecayDays: firstDecay,
            activityWindowDays: firstWindow,
          });

          // Second: apply a partial update
          const result = await store.set(userId, secondPartial);

          // Updated fields reflect new values
          if (secondPartial.engagementDecayDays !== undefined) {
            expect(result.engagementDecayDays).toBe(secondPartial.engagementDecayDays);
          } else {
            // Non-updated field retains previous value
            expect(result.engagementDecayDays).toBe(firstDecay);
          }

          if (secondPartial.activityWindowDays !== undefined) {
            expect(result.activityWindowDays).toBe(secondPartial.activityWindowDays);
          } else {
            // Non-updated field retains previous value
            expect(result.activityWindowDays).toBe(firstWindow);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 13: Config round-trip persistence
// ---------------------------------------------------------------------------

// Feature: proactive-crm-agent, Property 13: Config round-trip persistence
describe('Property 13: Config round-trip persistence', () => {
  it('writing a full config and reading it back produces an equivalent object', async () => {
    await fc.assert(
      fc.asyncProperty(userIdArb, validConfigArb, async (userId, config) => {
        const store = createStore();

        // Write full config
        const written = await store.set(userId, config);

        // Written result matches input
        expect(written.engagementDecayDays).toBe(config.engagementDecayDays);
        expect(written.activityWindowDays).toBe(config.activityWindowDays);

        // Read back from a fresh store instance pointing to the same directory
        // (simulates restart — tests actual file persistence)
        const storePath = (store as any).storagePath;
        const freshStore = new UserConfigStore(storePath);
        const readBack = await freshStore.get(userId);

        expect(readBack).toEqual(config);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 14: Invalid config rejection preserves state
// ---------------------------------------------------------------------------

// Feature: proactive-crm-agent, Property 14: Invalid config rejection preserves state
describe('Property 14: Invalid config rejection preserves state', () => {
  it('invalid config update is rejected and stored config remains unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        userIdArb,
        validConfigArb,
        invalidPartialConfigArb,
        async (userId, validConfig, invalidPartial) => {
          const store = createStore();

          // First set a valid config
          await store.set(userId, validConfig);

          // Attempt invalid update — should throw
          await expect(store.set(userId, invalidPartial)).rejects.toThrow();

          // Config should remain unchanged
          const afterAttempt = await store.get(userId);
          expect(afterAttempt).toEqual(validConfig);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('invalid config on a fresh user is rejected and defaults are preserved', async () => {
    await fc.assert(
      fc.asyncProperty(userIdArb, invalidPartialConfigArb, async (userId, invalidPartial) => {
        const store = createStore();

        // Attempt invalid update on fresh user — should throw
        await expect(store.set(userId, invalidPartial)).rejects.toThrow();

        // Config should still be defaults
        const config = await store.get(userId);
        expect(config).toEqual(USER_CONFIG_DEFAULTS);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
