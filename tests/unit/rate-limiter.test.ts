import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { RateLimiter } from '../../src/services/rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ maxRequests: 30, windowMs: 60_000 });
  });

  // --- Constructor / configuration ---

  it('uses default limit of 30 when no options provided', () => {
    const defaultLimiter = new RateLimiter();
    const baseTime = 1_000_000;
    // Should allow 30 requests
    for (let i = 0; i < 30; i++) {
      expect(defaultLimiter.check('user-1', baseTime + i).allowed).toBe(true);
    }
    // 31st should be rejected
    expect(defaultLimiter.check('user-1', baseTime + 30).allowed).toBe(false);
  });

  it('respects custom maxRequests from constructor', () => {
    const customLimiter = new RateLimiter({ maxRequests: 5 });
    const baseTime = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(customLimiter.check('user-1', baseTime + i).allowed).toBe(true);
    }
    expect(customLimiter.check('user-1', baseTime + 5).allowed).toBe(false);
  });

  it('reads RATE_LIMIT_PER_MIN from env when no constructor option', () => {
    const original = process.env.RATE_LIMIT_PER_MIN;
    try {
      process.env.RATE_LIMIT_PER_MIN = '3';
      const envLimiter = new RateLimiter();
      const baseTime = 1_000_000;
      for (let i = 0; i < 3; i++) {
        expect(envLimiter.check('user-1', baseTime + i).allowed).toBe(true);
      }
      expect(envLimiter.check('user-1', baseTime + 3).allowed).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env.RATE_LIMIT_PER_MIN;
      } else {
        process.env.RATE_LIMIT_PER_MIN = original;
      }
    }
  });

  it('falls back to 30 when RATE_LIMIT_PER_MIN is invalid', () => {
    const original = process.env.RATE_LIMIT_PER_MIN;
    try {
      process.env.RATE_LIMIT_PER_MIN = 'not-a-number';
      const envLimiter = new RateLimiter();
      const baseTime = 1_000_000;
      for (let i = 0; i < 30; i++) {
        expect(envLimiter.check('user-1', baseTime + i).allowed).toBe(true);
      }
      expect(envLimiter.check('user-1', baseTime + 30).allowed).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env.RATE_LIMIT_PER_MIN;
      } else {
        process.env.RATE_LIMIT_PER_MIN = original;
      }
    }
  });

  // --- Basic allow / reject ---

  it('allows the first request for a new user', () => {
    const result = limiter.check('user-1', 1_000_000);
    expect(result.allowed).toBe(true);
    expect(result.retryAfter).toBeUndefined();
  });

  it('allows up to 30 requests within the window', () => {
    const baseTime = 1_000_000;
    for (let i = 0; i < 30; i++) {
      const result = limiter.check('user-1', baseTime + i);
      expect(result.allowed).toBe(true);
    }
  });

  it('rejects the 31st request within the window', () => {
    const baseTime = 1_000_000;
    for (let i = 0; i < 30; i++) {
      limiter.check('user-1', baseTime + i);
    }
    const result = limiter.check('user-1', baseTime + 30);
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeDefined();
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  // --- retryAfter calculation ---

  it('returns correct retryAfter when rejected', () => {
    const baseTime = 1_000_000;
    // Fill the window: all 30 requests at baseTime
    for (let i = 0; i < 30; i++) {
      limiter.check('user-1', baseTime);
    }
    // Try 10 seconds later
    const result = limiter.check('user-1', baseTime + 10_000);
    expect(result.allowed).toBe(false);
    // Oldest request at baseTime, expires at baseTime + 60000
    // retryAfter = ceil((baseTime + 60000 - (baseTime + 10000)) / 1000) = ceil(50) = 50
    expect(result.retryAfter).toBe(50);
  });

  it('retryAfter is at least 1 second', () => {
    const baseTime = 1_000_000;
    for (let i = 0; i < 30; i++) {
      limiter.check('user-1', baseTime);
    }
    // Try at baseTime + 59999 (just 1ms before window expires)
    const result = limiter.check('user-1', baseTime + 59_999);
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThanOrEqual(1);
  });

  // --- Sliding window behavior ---

  it('allows requests again after the window slides past oldest entry', () => {
    const baseTime = 1_000_000;
    // Fill the window at baseTime
    for (let i = 0; i < 30; i++) {
      limiter.check('user-1', baseTime);
    }
    // Rejected at baseTime + 30000
    expect(limiter.check('user-1', baseTime + 30_000).allowed).toBe(false);

    // After 60 seconds, all old entries expire
    const result = limiter.check('user-1', baseTime + 60_000);
    expect(result.allowed).toBe(true);
  });

  it('slides correctly when requests are spread across the window', () => {
    const baseTime = 1_000_000;
    // 30 requests, each 1 second apart (0s, 1s, 2s, ..., 29s)
    for (let i = 0; i < 30; i++) {
      limiter.check('user-1', baseTime + i * 1000);
    }
    // At 30s: all 30 are still in window → rejected
    expect(limiter.check('user-1', baseTime + 30_000).allowed).toBe(false);

    // At 60s: the first request (at 0s) has expired → 29 in window → allowed
    expect(limiter.check('user-1', baseTime + 60_000).allowed).toBe(true);

    // At 60.5s: the second request (at 1s) still in window → 30 in window → rejected
    expect(limiter.check('user-1', baseTime + 60_500).allowed).toBe(false);
  });

  // --- Per-user isolation ---

  it('tracks users independently', () => {
    const baseTime = 1_000_000;
    // Fill user-1's window
    for (let i = 0; i < 30; i++) {
      limiter.check('user-1', baseTime);
    }
    expect(limiter.check('user-1', baseTime + 1).allowed).toBe(false);

    // user-2 should still be allowed
    expect(limiter.check('user-2', baseTime + 1).allowed).toBe(true);
  });

  // --- reset() ---

  it('reset() clears a specific user window', () => {
    const baseTime = 1_000_000;
    for (let i = 0; i < 30; i++) {
      limiter.check('user-1', baseTime);
    }
    expect(limiter.check('user-1', baseTime + 1).allowed).toBe(false);

    limiter.reset('user-1');
    expect(limiter.check('user-1', baseTime + 2).allowed).toBe(true);
  });

  it('reset() does not affect other users', () => {
    const baseTime = 1_000_000;
    for (let i = 0; i < 30; i++) {
      limiter.check('user-1', baseTime);
      limiter.check('user-2', baseTime);
    }
    limiter.reset('user-1');

    expect(limiter.check('user-1', baseTime + 1).allowed).toBe(true);
    expect(limiter.check('user-2', baseTime + 1).allowed).toBe(false);
  });

  // --- resetAll() ---

  it('resetAll() clears all user windows', () => {
    const baseTime = 1_000_000;
    for (let i = 0; i < 30; i++) {
      limiter.check('user-1', baseTime);
      limiter.check('user-2', baseTime);
    }
    limiter.resetAll();

    expect(limiter.check('user-1', baseTime + 1).allowed).toBe(true);
    expect(limiter.check('user-2', baseTime + 1).allowed).toBe(true);
  });

  // --- Stale entry cleanup ---

  it('prunes stale timestamps on each check', () => {
    const baseTime = 1_000_000;
    // Add 30 requests at baseTime
    for (let i = 0; i < 30; i++) {
      limiter.check('user-1', baseTime);
    }
    // After window expires, check should prune old entries and allow
    const result = limiter.check('user-1', baseTime + 60_001);
    expect(result.allowed).toBe(true);

    // Should be able to add 29 more (total 30 in new window)
    for (let i = 1; i < 30; i++) {
      expect(limiter.check('user-1', baseTime + 60_001 + i).allowed).toBe(true);
    }
    // 31st in new window should be rejected
    expect(limiter.check('user-1', baseTime + 60_031).allowed).toBe(false);
  });

  // --- Edge cases ---

  it('handles check with now = 0', () => {
    const result = limiter.check('user-1', 0);
    expect(result.allowed).toBe(true);
  });

  it('handles rapid-fire requests at the exact same timestamp', () => {
    const baseTime = 1_000_000;
    for (let i = 0; i < 30; i++) {
      expect(limiter.check('user-1', baseTime).allowed).toBe(true);
    }
    expect(limiter.check('user-1', baseTime).allowed).toBe(false);
  });

  it('handles empty userId string', () => {
    const result = limiter.check('', 1_000_000);
    expect(result.allowed).toBe(true);
  });
});
