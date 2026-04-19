/**
 * In-memory sliding window rate limiter.
 *
 * Tracks request timestamps per user and enforces a configurable
 * maximum number of requests within a 60-second sliding window.
 *
 * @module rate-limiter
 */

/** Result of a rate limit check. */
export interface RateLimitResult {
  /** Whether the request is allowed. */
  allowed: boolean;
  /** Seconds until the user can retry (only present when `allowed` is false). */
  retryAfter?: number;
}

/** Configuration options for the rate limiter. */
export interface RateLimiterOptions {
  /** Maximum requests per window. Defaults to `RATE_LIMIT_PER_MIN` env or 30. */
  maxRequests?: number;
  /** Window size in milliseconds. Always 60 000 (1 minute). */
  windowMs?: number;
}

const DEFAULT_WINDOW_MS = 60_000;

/**
 * Resolve the per-minute rate limit from the environment or a provided value.
 */
function resolveMaxRequests(explicit?: number): number {
  if (explicit !== undefined && explicit > 0) {
    return explicit;
  }
  const env = process.env.RATE_LIMIT_PER_MIN;
  if (env !== undefined) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 30;
}

/**
 * Sliding-window rate limiter.
 *
 * Each user has an array of request timestamps. On every `check()`:
 * 1. Stale timestamps (older than the window) are pruned.
 * 2. If the remaining count >= limit → rejected with `retryAfter`.
 * 3. Otherwise the current timestamp is recorded and the request is allowed.
 * 4. Users whose windows are now empty are removed from the map entirely.
 */
export class RateLimiter {
  private readonly windows: Map<string, number[]> = new Map();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(options?: RateLimiterOptions) {
    this.maxRequests = resolveMaxRequests(options?.maxRequests);
    this.windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
  }

  /**
   * Check whether a request from `userId` is allowed.
   *
   * @param userId  Unique identifier for the requesting user.
   * @param now     Current timestamp in ms (injectable for testing).
   */
  check(userId: string, now: number = Date.now()): RateLimitResult {
    const timestamps = this.windows.get(userId) ?? [];

    // Filter to only timestamps within the current window.
    const recent = timestamps.filter((t) => now - t < this.windowMs);

    if (recent.length >= this.maxRequests) {
      // Oldest request in the window determines when the window slides enough.
      const oldestInWindow = recent[0];
      const retryAfter = Math.ceil((oldestInWindow + this.windowMs - now) / 1000);
      // Store the pruned array back (cleanup stale entries).
      this.windows.set(userId, recent);
      return { allowed: false, retryAfter: Math.max(retryAfter, 1) };
    }

    // Record this request.
    recent.push(now);
    this.windows.set(userId, recent);

    // Cleanup: remove users with empty windows (shouldn't happen here,
    // but defensive for consistency after external resets).
    this.cleanupStaleEntries();

    return { allowed: true };
  }

  /**
   * Clear the rate limit window for a specific user.
   */
  reset(userId: string): void {
    this.windows.delete(userId);
  }

  /**
   * Clear all rate limit windows.
   */
  resetAll(): void {
    this.windows.clear();
  }

  /**
   * Remove map entries where the timestamp array is empty.
   * Called internally after each check to keep memory tidy.
   */
  private cleanupStaleEntries(): void {
    for (const [userId, timestamps] of this.windows) {
      if (timestamps.length === 0) {
        this.windows.delete(userId);
      }
    }
  }
}
