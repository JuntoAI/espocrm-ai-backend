/**
 * Property-based tests for the sliding window rate limiter.
 *
 * **Validates: Requirements 10.4, 10.5**
 *
 * Property 16: Rate Limiting
 * For any user, the rate limiter should accept the first N requests within a
 * 60-second sliding window. The (N+1)th request within the same window should
 * be rejected with a valid `retryAfter` value. After the window slides past
 * the oldest request, new requests should be accepted again.
 */

import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import { RateLimiter } from '../../src/services/rate-limiter.js';

/** Arbitrary for a valid user ID (non-empty string). */
const userIdArb = fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0);

/** Arbitrary for a reasonable rate limit (small enough to test quickly). */
const limitArb = fc.integer({ min: 1, max: 50 });

/** Arbitrary for a base timestamp in ms (positive, realistic range). */
const baseTimeArb = fc.integer({ min: 1_000_000, max: 1_000_000_000 });

const NUM_RUNS = 100;
const WINDOW_MS = 60_000;

describe('Property 16: Rate Limiting', () => {
  it('first N requests within window are always accepted', () => {
    fc.assert(
      fc.property(userIdArb, limitArb, baseTimeArb, (userId, limit, baseTime) => {
        const limiter = new RateLimiter({ maxRequests: limit, windowMs: WINDOW_MS });

        for (let i = 0; i < limit; i++) {
          // All requests within the window, each 1ms apart
          const result = limiter.check(userId, baseTime + i);
          expect(result.allowed).toBe(true);
          expect(result.retryAfter).toBeUndefined();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('request N+1 within window is always rejected', () => {
    fc.assert(
      fc.property(userIdArb, limitArb, baseTimeArb, (userId, limit, baseTime) => {
        const limiter = new RateLimiter({ maxRequests: limit, windowMs: WINDOW_MS });

        // Fill the window
        for (let i = 0; i < limit; i++) {
          limiter.check(userId, baseTime + i);
        }

        // The (N+1)th request within the same window must be rejected
        const result = limiter.check(userId, baseTime + limit);
        expect(result.allowed).toBe(false);
        expect(result.retryAfter).toBeDefined();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejected requests always have valid retryAfter (positive integer >= 1)', () => {
    fc.assert(
      fc.property(
        userIdArb,
        limitArb,
        baseTimeArb,
        // Extra offset within the window for the rejected request
        fc.integer({ min: 0, max: 59_999 }),
        (userId, limit, baseTime, offsetMs) => {
          const limiter = new RateLimiter({ maxRequests: limit, windowMs: WINDOW_MS });

          // Fill the window at baseTime
          for (let i = 0; i < limit; i++) {
            limiter.check(userId, baseTime);
          }

          // Try again at some point within the window
          const result = limiter.check(userId, baseTime + offsetMs);
          expect(result.allowed).toBe(false);
          expect(result.retryAfter).toBeDefined();
          expect(Number.isInteger(result.retryAfter)).toBe(true);
          expect(result.retryAfter!).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('window sliding restores access after oldest request expires', () => {
    fc.assert(
      fc.property(userIdArb, limitArb, baseTimeArb, (userId, limit, baseTime) => {
        const limiter = new RateLimiter({ maxRequests: limit, windowMs: WINDOW_MS });

        // Fill the window: all requests at baseTime
        for (let i = 0; i < limit; i++) {
          limiter.check(userId, baseTime);
        }

        // Confirm rejected within window
        expect(limiter.check(userId, baseTime + 1).allowed).toBe(false);

        // After the full window has elapsed, all old entries expire
        const result = limiter.check(userId, baseTime + WINDOW_MS);
        expect(result.allowed).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('per-user isolation: requests from different users do not affect each other', () => {
    fc.assert(
      fc.property(
        userIdArb,
        userIdArb.filter((s) => s.length > 0),
        limitArb,
        baseTimeArb,
        (userA, userBSuffix, limit, baseTime) => {
          // Ensure distinct user IDs
          const userB = userA + '_' + userBSuffix;
          const limiter = new RateLimiter({ maxRequests: limit, windowMs: WINDOW_MS });

          // Exhaust userA's limit
          for (let i = 0; i < limit; i++) {
            limiter.check(userA, baseTime + i);
          }
          expect(limiter.check(userA, baseTime + limit).allowed).toBe(false);

          // userB should be completely unaffected — first request allowed
          const resultB = limiter.check(userB, baseTime);
          expect(resultB.allowed).toBe(true);

          // userB can also exhaust their own limit independently
          for (let i = 1; i < limit; i++) {
            expect(limiter.check(userB, baseTime + i).allowed).toBe(true);
          }
          expect(limiter.check(userB, baseTime + limit).allowed).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('reset clears the window so the user can make N requests again', () => {
    fc.assert(
      fc.property(userIdArb, limitArb, baseTimeArb, (userId, limit, baseTime) => {
        const limiter = new RateLimiter({ maxRequests: limit, windowMs: WINDOW_MS });

        // Exhaust the limit
        for (let i = 0; i < limit; i++) {
          limiter.check(userId, baseTime + i);
        }
        expect(limiter.check(userId, baseTime + limit).allowed).toBe(false);

        // Reset the user
        limiter.reset(userId);

        // User should be able to make N requests again
        for (let i = 0; i < limit; i++) {
          const result = limiter.check(userId, baseTime + limit + 1 + i);
          expect(result.allowed).toBe(true);
        }

        // And the (N+1)th should be rejected again
        expect(limiter.check(userId, baseTime + limit + 1 + limit).allowed).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
