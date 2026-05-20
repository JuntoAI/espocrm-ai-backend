/**
 * Server-side LRU cache for generated daily briefs.
 *
 * Prevents redundant CRM queries and Gemini calls by caching brief
 * results per user with configurable TTL and size limits.
 *
 * Uses a Map<string, CacheEntry> with insertion-order iteration for
 * LRU eviction. Bounded to maxEntries (default 50) with per-entry
 * size limit of maxEntrySizeBytes (default 100 KB).
 *
 * @module brief-cache
 */

import type { DailyBrief } from './brief-generator.js';

// Re-export types so existing consumers don't break
export type { ActionRecommendation, DailyBrief } from './brief-generator.js';

// ─── Cache Interfaces ────────────────────────────────────────────────────────

/** Configuration options for the BriefCache. */
export interface BriefCacheOptions {
  /** Maximum number of cached briefs. Default: 50. */
  maxEntries: number;
  /** Time-to-live in milliseconds. Default: 3 600 000 (1 hour). */
  ttlMs: number;
  /** Maximum serialized size of a single cache entry in bytes. Default: 102 400 (100 KB). */
  maxEntrySizeBytes: number;
}

/** Internal cache entry wrapping a DailyBrief with metadata. */
export interface CacheEntry {
  brief: DailyBrief;
  /** Unix timestamp (ms) when the entry was cached. */
  cachedAt: number;
  /** Serialized size of the brief in bytes. */
  sizeBytes: number;
}

/** Cache statistics snapshot. */
export interface CacheStats {
  entries: number;
  totalSizeBytes: number;
  hitRate: number;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const BRIEF_CACHE_DEFAULTS: Readonly<BriefCacheOptions> = {
  maxEntries: 50,
  ttlMs: 3_600_000,
  maxEntrySizeBytes: 102_400,
};

// ─── Service Class ───────────────────────────────────────────────────────────

/**
 * Server-side LRU cache for daily briefs.
 *
 * - On `get()`: checks TTL expiry, deletes + returns null if expired.
 *   On hit, moves entry to end (delete + re-insert) for LRU freshness.
 * - On `set()`: enforces maxEntrySizeBytes (returns false if exceeded),
 *   evicts oldest entry (first key in Map iteration) if at capacity.
 * - Tracks hits/misses for hitRate calculation.
 */
export class BriefCache {
  private readonly options: BriefCacheOptions;
  private readonly cache: Map<string, CacheEntry>;
  private hits: number;
  private misses: number;

  constructor(options?: Partial<BriefCacheOptions>) {
    this.options = { ...BRIEF_CACHE_DEFAULTS, ...options };
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Retrieve a cached brief for a user.
   *
   * Returns null if:
   * - No entry exists for the userId
   * - The entry has expired (TTL exceeded)
   *
   * On hit, moves the entry to the end of the Map for LRU freshness.
   */
  get(userId: string): DailyBrief | null {
    const entry = this.cache.get(userId);

    if (!entry) {
      this.misses++;
      return null;
    }

    // Check TTL expiry
    const now = Date.now();
    if (now - entry.cachedAt >= this.options.ttlMs) {
      this.cache.delete(userId);
      this.misses++;
      return null;
    }

    // Move to end for LRU freshness (delete + re-insert)
    this.cache.delete(userId);
    this.cache.set(userId, entry);

    this.hits++;
    return entry.brief;
  }

  /**
   * Cache a brief for a user.
   *
   * Returns false if the serialized entry exceeds maxEntrySizeBytes.
   * Evicts the least-recently-used entry (first in Map iteration order)
   * if the cache is at capacity before inserting.
   */
  set(userId: string, brief: DailyBrief): boolean {
    // Calculate serialized size
    const serialized = JSON.stringify(brief);
    const sizeBytes = Buffer.byteLength(serialized, 'utf8');

    // Reject if entry exceeds size limit
    if (sizeBytes > this.options.maxEntrySizeBytes) {
      return false;
    }

    // If this userId already exists, remove it first (will be re-inserted at end)
    if (this.cache.has(userId)) {
      this.cache.delete(userId);
    }

    // Evict oldest entry if at capacity
    while (this.cache.size >= this.options.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      } else {
        break;
      }
    }

    // Insert new entry at end (most recently used position)
    const entry: CacheEntry = {
      brief,
      cachedAt: Date.now(),
      sizeBytes,
    };
    this.cache.set(userId, entry);

    return true;
  }

  /**
   * Remove a specific user's cached brief.
   */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  /**
   * Remove all cached briefs and reset statistics.
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Get cache statistics.
   *
   * hitRate is calculated as hits / (hits + misses).
   * Returns 0 if no gets have been performed.
   */
  getStats(): CacheStats {
    let totalSizeBytes = 0;
    for (const entry of this.cache.values()) {
      totalSizeBytes += entry.sizeBytes;
    }

    const totalRequests = this.hits + this.misses;
    const hitRate = totalRequests === 0 ? 0 : this.hits / totalRequests;

    return {
      entries: this.cache.size,
      totalSizeBytes,
      hitRate,
    };
  }
}
