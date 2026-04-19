/**
 * Property-based tests for Gemini request assembly with context windowing.
 *
 * **Validates: Requirements 3.4, 4.6**
 *
 * Property 5: Gemini Request Assembly with Context Windowing
 * For any conversation history of length N and window size W, the assembled
 * request should contain min(N, W) most recent messages from history.
 * The function must not mutate the original history array.
 */

import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import { assembleContext } from '../../src/services/gemini-service.js';
import type { Content } from '@google-cloud/vertexai';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NUM_RUNS = 100;

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary role for a Content entry (Gemini uses 'user' and 'model'). */
const roleArb = fc.constantFrom('user', 'model');

/** Arbitrary text part content. */
const textArb = fc.string({ minLength: 1, maxLength: 200 });

/** Build a Content object with a single text part. */
function makeContent(role: string, text: string): Content {
  return { role, parts: [{ text }] };
}

/** Arbitrary Content object. */
const contentArb: fc.Arbitrary<Content> = fc
  .tuple(roleArb, textArb)
  .map(([role, text]) => makeContent(role, text));

/** Arbitrary conversation history (0 to 60 entries). */
const historyArb = fc.array(contentArb, { minLength: 0, maxLength: 60 });

/** Arbitrary non-empty conversation history. */
const nonEmptyHistoryArb = fc.array(contentArb, { minLength: 1, maxLength: 60 });

/** Arbitrary window size (positive). */
const windowSizeArb = fc.integer({ min: 1, max: 100 });

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('Property 5: Gemini Request Assembly with Context Windowing', () => {
  it('output length is min(N, W) for any history of length N and window size W', () => {
    fc.assert(
      fc.property(historyArb, windowSizeArb, (history, windowSize) => {
        const result = assembleContext(history, windowSize);
        const expected = Math.min(history.length, windowSize);

        expect(result).toHaveLength(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('output contains the most recent messages — the last min(N, W) entries from history', () => {
    fc.assert(
      fc.property(nonEmptyHistoryArb, windowSizeArb, (history, windowSize) => {
        const result = assembleContext(history, windowSize);
        const count = Math.min(history.length, windowSize);
        const expectedSlice = history.slice(history.length - count);

        expect(result).toHaveLength(expectedSlice.length);

        for (let i = 0; i < result.length; i++) {
          expect(result[i].role).toBe(expectedSlice[i].role);
          expect(result[i].parts).toEqual(expectedSlice[i].parts);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('empty history returns empty array for any window size', () => {
    fc.assert(
      fc.property(windowSizeArb, (windowSize) => {
        const result = assembleContext([], windowSize);

        expect(result).toEqual([]);
        expect(result).toHaveLength(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('window size 0 returns empty array for any history', () => {
    fc.assert(
      fc.property(historyArb, (history) => {
        const result = assembleContext(history, 0);

        expect(result).toEqual([]);
        expect(result).toHaveLength(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('window >= history returns all entries when W >= N', () => {
    fc.assert(
      fc.property(
        nonEmptyHistoryArb,
        fc.integer({ min: 0, max: 50 }),
        (history, extra) => {
          // Window size is at least as large as history
          const windowSize = history.length + extra;
          const result = assembleContext(history, windowSize);

          expect(result).toHaveLength(history.length);

          for (let i = 0; i < result.length; i++) {
            expect(result[i].role).toBe(history[i].role);
            expect(result[i].parts).toEqual(history[i].parts);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('original history is not mutated by assembleContext', () => {
    fc.assert(
      fc.property(nonEmptyHistoryArb, windowSizeArb, (history, windowSize) => {
        // Deep snapshot of the original history for comparison
        const originalLength = history.length;
        const originalSnapshot = history.map((c) => ({
          role: c.role,
          parts: c.parts.map((p) => ({ ...p })),
        }));

        assembleContext(history, windowSize);

        // Array length unchanged
        expect(history).toHaveLength(originalLength);

        // Each entry unchanged
        for (let i = 0; i < history.length; i++) {
          expect(history[i].role).toBe(originalSnapshot[i].role);
          expect(history[i].parts).toEqual(originalSnapshot[i].parts);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
