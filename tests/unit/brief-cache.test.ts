/**
 * Unit tests for BriefCache service.
 *
 * Tests LRU eviction, TTL expiry, size limits, and statistics tracking.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { BriefCache } from '../../src/services/brief-cache.js';
import type { DailyBrief } from '../../src/services/brief-cache.js';
import type { CrmAnalysisResult } from '../../src/services/crm-analyzer.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeBrief(overrides?: Partial<DailyBrief>): DailyBrief {
  const rawAnalysis: CrmAnalysisResult = {
    overdueOpportunities: [],
    stalledAccounts: [],
    overdueTasks: [],
    activitySummary: [],
    generatedAt: new Date().toISOString(),
  };

  return {
    recommendations: [
      {
        description: 'Follow up with Delta Partners',
        reason: 'No activity in 18 days',
        suggestedCommand: 'draft email to Maria',
      },
    ],
    rawAnalysis,
    generatedAt: new Date().toISOString(),
    isAiGenerated: true,
    ...overrides,
  };
}

function makeLargeBrief(sizeApproxBytes: number): DailyBrief {
  // Create a brief with a large description to exceed size limits
  const padding = 'x'.repeat(sizeApproxBytes);
  return makeBrief({
    recommendations: [
      {
        description: padding,
        reason: 'test',
        suggestedCommand: 'test',
      },
    ],
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('BriefCache', () => {
  let cache: BriefCache;

  beforeEach(() => {
    cache = new BriefCache();
  });

  describe('constructor', () => {
    it('uses default options when none provided', () => {
      const stats = cache.getStats();
      expect(stats.entries).toBe(0);
      expect(stats.totalSizeBytes).toBe(0);
      expect(stats.hitRate).toBe(0);
    });

    it('accepts partial options', () => {
      const customCache = new BriefCache({ maxEntries: 10 });
      // Fill to capacity
      for (let i = 0; i < 11; i++) {
        customCache.set(`user-${i}`, makeBrief());
      }
      expect(customCache.getStats().entries).toBe(10);
    });
  });

  describe('get()', () => {
    it('returns null for non-existent key', () => {
      expect(cache.get('nonexistent')).toBeNull();
    });

    it('returns cached brief for valid entry', () => {
      const brief = makeBrief();
      cache.set('user-1', brief);
      const result = cache.get('user-1');
      expect(result).toEqual(brief);
    });

    it('returns null and removes entry when TTL expired', () => {
      const shortTtlCache = new BriefCache({ ttlMs: 100 });
      const brief = makeBrief();
      shortTtlCache.set('user-1', brief);

      // Mock Date.now to simulate time passing
      const originalNow = Date.now;
      Date.now = () => originalNow() + 200;

      expect(shortTtlCache.get('user-1')).toBeNull();
      expect(shortTtlCache.getStats().entries).toBe(0);

      Date.now = originalNow;
    });

    it('moves accessed entry to end for LRU freshness', () => {
      cache.set('user-1', makeBrief());
      cache.set('user-2', makeBrief());
      cache.set('user-3', makeBrief());

      // Access user-1, making it most recently used
      cache.get('user-1');

      // Fill cache to capacity to trigger eviction
      const fullCache = new BriefCache({ maxEntries: 3 });
      fullCache.set('user-1', makeBrief());
      fullCache.set('user-2', makeBrief());
      fullCache.set('user-3', makeBrief());

      // Access user-1 (moves to end)
      fullCache.get('user-1');

      // Add new entry — should evict user-2 (oldest after user-1 was moved)
      fullCache.set('user-4', makeBrief());

      expect(fullCache.get('user-1')).not.toBeNull();
      expect(fullCache.get('user-2')).toBeNull(); // evicted
      expect(fullCache.get('user-3')).not.toBeNull();
    });

    it('tracks misses correctly', () => {
      cache.get('nonexistent-1');
      cache.get('nonexistent-2');
      expect(cache.getStats().hitRate).toBe(0);
    });

    it('tracks hits correctly', () => {
      cache.set('user-1', makeBrief());
      cache.get('user-1');
      cache.get('user-1');
      // 2 hits, 0 misses
      expect(cache.getStats().hitRate).toBe(1);
    });
  });

  describe('set()', () => {
    it('stores a brief and returns true', () => {
      const brief = makeBrief();
      const result = cache.set('user-1', brief);
      expect(result).toBe(true);
      expect(cache.get('user-1')).toEqual(brief);
    });

    it('returns false when entry exceeds maxEntrySizeBytes', () => {
      const largeBrief = makeLargeBrief(110_000); // > 100KB
      const result = cache.set('user-1', largeBrief);
      expect(result).toBe(false);
      expect(cache.get('user-1')).toBeNull();
    });

    it('evicts oldest entry when at maxEntries capacity', () => {
      const smallCache = new BriefCache({ maxEntries: 3 });

      smallCache.set('user-1', makeBrief());
      smallCache.set('user-2', makeBrief());
      smallCache.set('user-3', makeBrief());

      // This should evict user-1 (oldest)
      smallCache.set('user-4', makeBrief());

      expect(smallCache.getStats().entries).toBe(3);
      expect(smallCache.get('user-1')).toBeNull(); // evicted
      expect(smallCache.get('user-4')).not.toBeNull(); // present
    });

    it('updates existing entry without increasing count', () => {
      cache.set('user-1', makeBrief());
      cache.set('user-1', makeBrief()); // update same key

      expect(cache.getStats().entries).toBe(1);
    });

    it('enforces maxEntries of 50 by default', () => {
      for (let i = 0; i < 60; i++) {
        cache.set(`user-${i}`, makeBrief());
      }
      expect(cache.getStats().entries).toBe(50);
    });
  });

  describe('invalidate()', () => {
    it('removes a specific entry', () => {
      cache.set('user-1', makeBrief());
      cache.set('user-2', makeBrief());

      cache.invalidate('user-1');

      expect(cache.get('user-1')).toBeNull();
      expect(cache.get('user-2')).not.toBeNull();
    });

    it('does nothing for non-existent key', () => {
      cache.set('user-1', makeBrief());
      cache.invalidate('nonexistent');
      expect(cache.getStats().entries).toBe(1);
    });
  });

  describe('clear()', () => {
    it('removes all entries', () => {
      cache.set('user-1', makeBrief());
      cache.set('user-2', makeBrief());
      cache.set('user-3', makeBrief());

      cache.clear();

      expect(cache.getStats().entries).toBe(0);
      expect(cache.getStats().totalSizeBytes).toBe(0);
    });

    it('resets hit/miss statistics', () => {
      cache.set('user-1', makeBrief());
      cache.get('user-1'); // hit
      cache.get('nonexistent'); // miss

      cache.clear();

      expect(cache.getStats().hitRate).toBe(0);
    });
  });

  describe('getStats()', () => {
    it('returns correct entry count', () => {
      cache.set('user-1', makeBrief());
      cache.set('user-2', makeBrief());
      expect(cache.getStats().entries).toBe(2);
    });

    it('returns correct totalSizeBytes', () => {
      const brief = makeBrief();
      cache.set('user-1', brief);

      const expectedSize = Buffer.byteLength(JSON.stringify(brief), 'utf8');
      expect(cache.getStats().totalSizeBytes).toBe(expectedSize);
    });

    it('calculates hitRate correctly with mixed hits and misses', () => {
      cache.set('user-1', makeBrief());

      cache.get('user-1'); // hit
      cache.get('user-1'); // hit
      cache.get('nonexistent'); // miss

      // 2 hits / 3 total = 0.666...
      expect(cache.getStats().hitRate).toBeCloseTo(2 / 3);
    });

    it('returns hitRate 0 when no gets performed', () => {
      cache.set('user-1', makeBrief());
      expect(cache.getStats().hitRate).toBe(0);
    });
  });
});
