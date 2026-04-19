/**
 * Property-based tests for per-user credential forwarding in CRMExecutor.
 *
 * **Validates: Requirements 6.3**
 *
 * Property 9: Per-User Credential Forwarding
 * For any tool execution triggered by a user request, the outgoing REST call
 * to the EspoCRM API should use the requesting user's API key (from the
 * request context), not a hardcoded admin API key or any other user's key.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import * as fc from 'fast-check';
import { CRMExecutor, TOOL_REST_MAP } from '../../src/services/crm-executor.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const NUM_RUNS = 100;

// ────────────────────────────────────────────────────────────────
// Arbitraries
// ────────────────────────────────────────────────────────────────

/** Non-empty API key string (realistic: alphanumeric + dashes). */
const apiKeyArb = fc
  .stringMatching(/^[a-zA-Z0-9\-_]+$/)
  .filter((s) => s.length >= 1 && s.length <= 120);

/**
 * Generate a pair of distinct API keys.
 * We filter to guarantee they are different.
 */
const distinctApiKeyPairArb = fc
  .tuple(apiKeyArb, apiKeyArb)
  .filter(([a, b]) => a !== b);

/**
 * Generate an array of 2–10 unique API keys representing different users.
 */
const multipleApiKeysArb = fc
  .uniqueArray(apiKeyArb, { minLength: 2, maxLength: 10 });

// ────────────────────────────────────────────────────────────────
// Property tests
// ────────────────────────────────────────────────────────────────

describe('Property 9: Per-User Credential Forwarding', () => {
  let executor: CRMExecutor;

  beforeEach(() => {
    executor = new CRMExecutor('http://test-espocrm:8080');
  });

  it('axios instance for any API key has that exact key in X-Api-Key header', () => {
    fc.assert(
      fc.property(apiKeyArb, (apiKey) => {
        const client = executor.getClientForKey(apiKey);
        expect(client.defaults.headers['X-Api-Key']).toBe(apiKey);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('two different API keys produce distinct axios instances with their respective keys', () => {
    fc.assert(
      fc.property(distinctApiKeyPairArb, ([keyA, keyB]) => {
        const clientA = executor.getClientForKey(keyA);
        const clientB = executor.getClientForKey(keyB);

        // Different instances
        expect(clientA).not.toBe(clientB);

        // Each carries its own key — not the other's
        expect(clientA.defaults.headers['X-Api-Key']).toBe(keyA);
        expect(clientB.defaults.headers['X-Api-Key']).toBe(keyB);

        // Explicitly verify no cross-contamination
        expect(clientA.defaults.headers['X-Api-Key']).not.toBe(keyB);
        expect(clientB.defaults.headers['X-Api-Key']).not.toBe(keyA);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('cached client for a key always returns the same instance with the correct key', () => {
    fc.assert(
      fc.property(apiKeyArb, (apiKey) => {
        const first = executor.getClientForKey(apiKey);
        const second = executor.getClientForKey(apiKey);

        // Same cached instance
        expect(first).toBe(second);

        // Key is still correct after cache hit
        expect(second.defaults.headers['X-Api-Key']).toBe(apiKey);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('N distinct users each get a client with their own key, no key reuse across users', () => {
    fc.assert(
      fc.property(multipleApiKeysArb, (keys) => {
        // Fresh executor per iteration to isolate cache state
        const freshExecutor = new CRMExecutor('http://test-espocrm:8080');
        const clients = keys.map((k) => freshExecutor.getClientForKey(k));

        // Each client carries exactly its owner's key
        for (let i = 0; i < keys.length; i++) {
          expect(clients[i].defaults.headers['X-Api-Key']).toBe(keys[i]);
        }

        // No two clients share the same instance
        const instanceSet = new Set(clients);
        expect(instanceSet.size).toBe(keys.length);

        // Cache size matches the number of unique keys
        expect(freshExecutor.getCacheSize()).toBe(keys.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('clearing cache and re-creating client still uses the correct key, not a stale one', () => {
    fc.assert(
      fc.property(distinctApiKeyPairArb, ([keyA, keyB]) => {
        // Populate cache with both keys
        executor.getClientForKey(keyA);
        executor.getClientForKey(keyB);

        // Clear cache
        executor.clearCache();
        expect(executor.getCacheSize()).toBe(0);

        // Re-create client for keyA — must use keyA, not keyB
        const freshClient = executor.getClientForKey(keyA);
        expect(freshClient.defaults.headers['X-Api-Key']).toBe(keyA);
        expect(freshClient.defaults.headers['X-Api-Key']).not.toBe(keyB);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
