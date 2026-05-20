/**
 * Property-based tests for BriefCache TTL and size invariants.
 *
 * Feature: proactive-crm-agent, Property 8: Brief cache TTL validity
 * Feature: proactive-crm-agent, Property 16: Cache size invariants
 *
 * **Validates: Requirements 3.4, 3.5, 6.3**
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fc from 'fast-check';
import { BriefCache } from '../../src/services/brief-cache.js';
import type { DailyBrief } from '../../src/services/brief-cache.js';
import type { CrmAnalysisResult } from '../../src/services/crm-analyzer.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal valid CrmAnalysisResult for testing. */
function makeMinimalAnalysis(): CrmAnalysisResult {
  return {
    overdueOpportunities: [],
    stalledAccounts: [],
    overdueTasks: [],
    activitySummary: [],
    generatedAt: new Date().toISOString(),
  };
}

/** Create a small DailyBrief that fits within default size limits. */
function makeSmallBrief(): DailyBrief {
  return {
    recommendations: [
      {
        description: 'Follow up with contact',
        reason: 'No activity in 14 days',
        suggestedCommand: 'draft email to Maria',
      },
    ],
    rawAnalysis: makeMinimalAnalysis(),
    generatedAt: new Date().toISOString(),
    isAiGenerated: true,
  };
}

/**
 * Create a DailyBrief of approximately the given size in bytes.
 * Uses a padded description field to reach the target size.
 */
function makeBriefOfSize(targetBytes: number): DailyBrief {
  const base: DailyBrief = {
    recommendations: [
      {
        description: '',
        reason: 'test',
        suggestedCommand: 'test',
      },
    ],
    rawAnalysis: makeMinimalAnalysis(),
    generatedAt: new Date().toISOString(),
    isAiGenerated: true,
  };

  // Measure base size and pad description to reach target
  const baseSize = Buffer.byteLength(JSON.stringify(base), 'utf8');
  const padding = targetBytes - baseSize;
  if (padding > 0) {
    base.recommendations[0].description = 'x'.repeat(padding);
  }
  return base;
}

/** Arbitrary for a valid userId (non-empty alphanumeric string). */
const userIdArb = fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
  minLength: 1,
  maxLength: 20,
});

/** Arbitrary for TTL values in a testable range (100ms - 10000ms). */
const ttlArb = fc.integer({ min: 100, max: 10_000 });

/** Arbitrary for time deltas (0 to 20000ms to test both expired and valid). */
const timeDeltaArb = fc.integer({ min: 0, max: 20_000 });

/** Arbitrary for maxEntries (small values for fast testing). */
const maxEntriesArb = fc.integer({ min: 1, max: 20 });

const NUM_RUNS = 100;

// ─── Date.now mocking ────────────────────────────────────────────────────────

let originalDateNow: () => number;
let mockedNow: number;

function mockDateNow(value: number): void {
  mockedNow = value;
  Date.now = () => mockedNow;
}

function restoreDateNow(): void {
  Date.now = originalDateNow;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 8: Brief cache TTL validity', () => {
  beforeEach(() => {
    originalDateNow = Date.now;
  });

  afterEach(() => {
    restoreDateNow();
  });

  // Feature: proactive-crm-agent, Property 8: Brief cache TTL validity
  it('cache returns entry if and only if elapsed time < ttlMs', () => {
    fc.assert(
      fc.property(
        userIdArb,
        ttlArb,
        timeDeltaArb,
        fc.integer({ min: 1_000_000, max: 100_000_000 }),
        (userId, ttlMs, elapsed, baseTime) => {
          const cache = new BriefCache({ ttlMs, maxEntries: 50, maxEntrySizeBytes: 102_400 });
          const brief = makeSmallBrief();

          // Set the brief at baseTime
          mockDateNow(baseTime);
          cache.set(userId, brief);

          // Query at baseTime + elapsed
          mockDateNow(baseTime + elapsed);
          const result = cache.get(userId);

          if (elapsed < ttlMs) {
            // Entry should be returned (not expired)
            expect(result).not.toBeNull();
            expect(result!.generatedAt).toBe(brief.generatedAt);
          } else {
            // Entry should be expired (return null)
            expect(result).toBeNull();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: proactive-crm-agent, Property 8: Brief cache TTL validity
  it('expired entries are removed from cache (getStats reflects removal)', () => {
    fc.assert(
      fc.property(
        userIdArb,
        ttlArb,
        fc.integer({ min: 1_000_000, max: 100_000_000 }),
        (userId, ttlMs, baseTime) => {
          const cache = new BriefCache({ ttlMs, maxEntries: 50, maxEntrySizeBytes: 102_400 });
          const brief = makeSmallBrief();

          // Set the brief at baseTime
          mockDateNow(baseTime);
          cache.set(userId, brief);
          expect(cache.getStats().entries).toBe(1);

          // Query after TTL has expired
          mockDateNow(baseTime + ttlMs);
          const result = cache.get(userId);
          expect(result).toBeNull();

          // Entry should be removed from cache
          expect(cache.getStats().entries).toBe(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: proactive-crm-agent, Property 8: Brief cache TTL validity
  it('entry at exactly ttlMs - 1 is still valid, at exactly ttlMs is expired', () => {
    fc.assert(
      fc.property(
        userIdArb,
        ttlArb,
        fc.integer({ min: 1_000_000, max: 100_000_000 }),
        (userId, ttlMs, baseTime) => {
          const cache = new BriefCache({ ttlMs, maxEntries: 50, maxEntrySizeBytes: 102_400 });
          const brief = makeSmallBrief();

          mockDateNow(baseTime);
          cache.set(userId, brief);

          // At ttlMs - 1: still valid
          mockDateNow(baseTime + ttlMs - 1);
          expect(cache.get(userId)).not.toBeNull();

          // Re-set because the previous get moved it to end (LRU)
          mockDateNow(baseTime);
          cache.set(userId, brief);

          // At exactly ttlMs: expired (>= comparison in implementation)
          mockDateNow(baseTime + ttlMs);
          expect(cache.get(userId)).toBeNull();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('Property 16: Cache size invariants', () => {
  beforeEach(() => {
    originalDateNow = Date.now;
  });

  afterEach(() => {
    restoreDateNow();
  });

  // Feature: proactive-crm-agent, Property 16: Cache size invariants
  it('cache never exceeds maxEntries after any sequence of set operations', () => {
    fc.assert(
      fc.property(
        maxEntriesArb,
        fc.array(userIdArb, { minLength: 1, maxLength: 60 }),
        fc.integer({ min: 1_000_000, max: 100_000_000 }),
        (maxEntries, userIds, baseTime) => {
          const cache = new BriefCache({ maxEntries, ttlMs: 3_600_000, maxEntrySizeBytes: 102_400 });
          const brief = makeSmallBrief();

          for (let i = 0; i < userIds.length; i++) {
            mockDateNow(baseTime + i);
            cache.set(userIds[i], brief);

            // Invariant: entries never exceed maxEntries
            expect(cache.getStats().entries).toBeLessThanOrEqual(maxEntries);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: proactive-crm-agent, Property 16: Cache size invariants
  it('oversized entries are rejected (set returns false)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1024, max: 50_000 }),
        userIdArb,
        fc.integer({ min: 1_000_000, max: 100_000_000 }),
        (maxEntrySizeBytes, userId, baseTime) => {
          const cache = new BriefCache({
            maxEntries: 50,
            ttlMs: 3_600_000,
            maxEntrySizeBytes,
          });

          // Create a brief that exceeds the size limit
          const oversizedBrief = makeBriefOfSize(maxEntrySizeBytes + 100);

          mockDateNow(baseTime);
          const result = cache.set(userId, oversizedBrief);

          // Must be rejected
          expect(result).toBe(false);

          // Cache should remain empty
          expect(cache.getStats().entries).toBe(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: proactive-crm-agent, Property 16: Cache size invariants
  it('entries within size limit are accepted (set returns true)', () => {
    fc.assert(
      fc.property(
        userIdArb,
        fc.integer({ min: 1_000_000, max: 100_000_000 }),
        (userId, baseTime) => {
          const cache = new BriefCache({
            maxEntries: 50,
            ttlMs: 3_600_000,
            maxEntrySizeBytes: 102_400, // 100KB — small brief is well under this
          });

          const brief = makeSmallBrief();

          mockDateNow(baseTime);
          const result = cache.set(userId, brief);

          expect(result).toBe(true);
          expect(cache.getStats().entries).toBe(1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: proactive-crm-agent, Property 16: Cache size invariants
  it('when cache is full, LRU entry is evicted on new insert', () => {
    fc.assert(
      fc.property(
        maxEntriesArb,
        fc.integer({ min: 1_000_000, max: 100_000_000 }),
        (maxEntries, baseTime) => {
          const cache = new BriefCache({ maxEntries, ttlMs: 3_600_000, maxEntrySizeBytes: 102_400 });
          const brief = makeSmallBrief();

          // Fill cache to capacity with distinct user IDs
          for (let i = 0; i < maxEntries; i++) {
            mockDateNow(baseTime + i);
            cache.set(`user_${i}`, brief);
          }
          expect(cache.getStats().entries).toBe(maxEntries);

          // Insert one more — should evict the oldest (user_0)
          mockDateNow(baseTime + maxEntries);
          cache.set('new_user', brief);

          // Size should still be maxEntries (not maxEntries + 1)
          expect(cache.getStats().entries).toBe(maxEntries);

          // The oldest entry (user_0) should be gone
          mockDateNow(baseTime + maxEntries + 1);
          expect(cache.get('user_0')).toBeNull();

          // The newest entry should still be present
          expect(cache.get('new_user')).not.toBeNull();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: proactive-crm-agent, Property 16: Cache size invariants
  it('invalidate reduces entry count and get returns null for invalidated key', () => {
    fc.assert(
      fc.property(
        fc.array(userIdArb, { minLength: 2, maxLength: 20 }),
        fc.integer({ min: 1_000_000, max: 100_000_000 }),
        (userIds, baseTime) => {
          // Deduplicate user IDs
          const uniqueIds = [...new Set(userIds)];
          if (uniqueIds.length < 2) return; // Need at least 2 distinct IDs

          const cache = new BriefCache({ maxEntries: 50, ttlMs: 3_600_000, maxEntrySizeBytes: 102_400 });
          const brief = makeSmallBrief();

          // Insert all
          for (let i = 0; i < uniqueIds.length; i++) {
            mockDateNow(baseTime + i);
            cache.set(uniqueIds[i], brief);
          }
          const countBefore = cache.getStats().entries;
          expect(countBefore).toBe(uniqueIds.length);

          // Invalidate the first one
          cache.invalidate(uniqueIds[0]);

          // Count should decrease by 1
          expect(cache.getStats().entries).toBe(countBefore - 1);

          // Get should return null for invalidated key
          mockDateNow(baseTime + uniqueIds.length);
          expect(cache.get(uniqueIds[0])).toBeNull();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: proactive-crm-agent, Property 16: Cache size invariants
  it('mixed operations (set, get, invalidate) never violate maxEntries', () => {
    // Operation type: 0=set, 1=get, 2=invalidate
    const operationArb = fc.record({
      type: fc.integer({ min: 0, max: 2 }),
      userId: userIdArb,
    });

    fc.assert(
      fc.property(
        maxEntriesArb,
        fc.array(operationArb, { minLength: 5, maxLength: 80 }),
        fc.integer({ min: 1_000_000, max: 100_000_000 }),
        (maxEntries, operations, baseTime) => {
          const cache = new BriefCache({ maxEntries, ttlMs: 3_600_000, maxEntrySizeBytes: 102_400 });
          const brief = makeSmallBrief();

          for (let i = 0; i < operations.length; i++) {
            const op = operations[i];
            mockDateNow(baseTime + i);

            switch (op.type) {
              case 0: // set
                cache.set(op.userId, brief);
                break;
              case 1: // get
                cache.get(op.userId);
                break;
              case 2: // invalidate
                cache.invalidate(op.userId);
                break;
            }

            // INVARIANT: cache size never exceeds maxEntries
            const stats = cache.getStats();
            expect(stats.entries).toBeLessThanOrEqual(maxEntries);
            expect(stats.entries).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
