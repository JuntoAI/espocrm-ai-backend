/**
 * Property-based tests for sequential function call execution.
 *
 * **Validates: Requirements 4.4**
 *
 * Property 4: Sequential Function Call Execution
 * For any ordered list of function calls returned by Gemini, the AI Backend
 * should execute them in the same order, accumulate all results (both
 * successes and failures), and include all results in the follow-up request
 * to Gemini before requesting the final text response.
 */

import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import {
  executeSequentialToolCalls,
  type FunctionCallDescriptor,
  type ToolCallCallback,
} from '../../src/services/gemini-service.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const NUM_RUNS = 100;

// ────────────────────────────────────────────────────────────────
// Arbitraries
// ────────────────────────────────────────────────────────────────

/** Arbitrary tool name (realistic: snake_case identifiers). */
const toolNameArb = fc
  .stringMatching(/^[a-z][a-z0-9_]*$/)
  .filter((s) => s.length >= 2 && s.length <= 40);

/** Arbitrary tool args (simple key-value objects). */
const toolArgsArb: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc.stringMatching(/^[a-zA-Z]\w*$/).filter((s) => s.length >= 1 && s.length <= 20),
  fc.oneof(
    fc.string({ minLength: 0, maxLength: 50 }),
    fc.integer(),
    fc.boolean(),
  ),
);

/** Whether a call should succeed or fail. */
const outcomeArb = fc.boolean();

/** A function call descriptor with a predetermined outcome. */
const callWithOutcomeArb = fc.tuple(toolNameArb, toolArgsArb, outcomeArb).map(
  ([name, args, shouldSucceed]) => ({
    call: { name, args } as FunctionCallDescriptor,
    shouldSucceed,
  }),
);

/** List of 1–10 function calls with predetermined outcomes. */
const callListArb = fc.array(callWithOutcomeArb, {
  minLength: 1,
  maxLength: 10,
});

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/**
 * Build a mock executor that records execution order and returns
 * predetermined results based on the outcome map.
 */
function buildMockExecutor(
  outcomeMap: Map<number, boolean>,
): {
  executor: ToolCallCallback;
  executionOrder: Array<{ index: number; name: string; args: object }>;
} {
  const executionOrder: Array<{ index: number; name: string; args: object }> = [];
  let callIndex = 0;

  const executor: ToolCallCallback = async (name: string, args: object) => {
    const currentIndex = callIndex++;
    executionOrder.push({ index: currentIndex, name, args });

    const shouldSucceed = outcomeMap.get(currentIndex) ?? true;
    if (!shouldSucceed) {
      throw new Error(`Simulated failure for call #${currentIndex}: ${name}`);
    }
    return { success: true, data: { tool: name, index: currentIndex } };
  };

  return { executor, executionOrder };
}

// ────────────────────────────────────────────────────────────────
// Property tests
// ────────────────────────────────────────────────────────────────

describe('Property 4: Sequential Function Call Execution', () => {
  it('calls are executed in the exact order they were listed', () => {
    fc.assert(
      fc.asyncProperty(callListArb, async (callsWithOutcomes) => {
        const outcomeMap = new Map<number, boolean>();
        const calls: FunctionCallDescriptor[] = [];

        callsWithOutcomes.forEach((item, i) => {
          calls.push(item.call);
          outcomeMap.set(i, item.shouldSucceed);
        });

        const { executor, executionOrder } = buildMockExecutor(outcomeMap);
        await executeSequentialToolCalls(calls, executor);

        // Verify execution order matches input order
        expect(executionOrder).toHaveLength(calls.length);
        for (let i = 0; i < calls.length; i++) {
          expect(executionOrder[i].index).toBe(i);
          expect(executionOrder[i].name).toBe(calls[i].name);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('all results (successes and failures) are accumulated — result count equals input count', () => {
    fc.assert(
      fc.asyncProperty(callListArb, async (callsWithOutcomes) => {
        const outcomeMap = new Map<number, boolean>();
        const calls: FunctionCallDescriptor[] = [];

        callsWithOutcomes.forEach((item, i) => {
          calls.push(item.call);
          outcomeMap.set(i, item.shouldSucceed);
        });

        const { executor } = buildMockExecutor(outcomeMap);
        const result = await executeSequentialToolCalls(calls, executor);

        // toolsUsed and functionResponses must have same length as input
        expect(result.toolsUsed).toHaveLength(calls.length);
        expect(result.functionResponses).toHaveLength(calls.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('each result corresponds to the correct function call by name and index', () => {
    fc.assert(
      fc.asyncProperty(callListArb, async (callsWithOutcomes) => {
        const outcomeMap = new Map<number, boolean>();
        const calls: FunctionCallDescriptor[] = [];

        callsWithOutcomes.forEach((item, i) => {
          calls.push(item.call);
          outcomeMap.set(i, item.shouldSucceed);
        });

        const { executor } = buildMockExecutor(outcomeMap);
        const result = await executeSequentialToolCalls(calls, executor);

        for (let i = 0; i < calls.length; i++) {
          // toolsUsed[i] matches calls[i]
          expect(result.toolsUsed[i].tool).toBe(calls[i].name);

          // functionResponses[i] matches calls[i]
          expect(result.functionResponses[i].name).toBe(calls[i].name);

          // Success/failure matches the predetermined outcome
          expect(result.toolsUsed[i].success).toBe(
            outcomeMap.get(i) ?? true,
          );
          expect(result.functionResponses[i].success).toBe(
            outcomeMap.get(i) ?? true,
          );
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('a failure does not abort the sequence — all subsequent calls still execute', () => {
    fc.assert(
      fc.asyncProperty(callListArb, async (callsWithOutcomes) => {
        const outcomeMap = new Map<number, boolean>();
        const calls: FunctionCallDescriptor[] = [];

        callsWithOutcomes.forEach((item, i) => {
          calls.push(item.call);
          outcomeMap.set(i, item.shouldSucceed);
        });

        const { executor, executionOrder } = buildMockExecutor(outcomeMap);
        await executeSequentialToolCalls(calls, executor);

        // Every call was attempted regardless of prior failures
        expect(executionOrder).toHaveLength(calls.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('failed calls produce error responses with error indicator, successful calls produce data responses', () => {
    fc.assert(
      fc.asyncProperty(callListArb, async (callsWithOutcomes) => {
        const outcomeMap = new Map<number, boolean>();
        const calls: FunctionCallDescriptor[] = [];

        callsWithOutcomes.forEach((item, i) => {
          calls.push(item.call);
          outcomeMap.set(i, item.shouldSucceed);
        });

        const { executor } = buildMockExecutor(outcomeMap);
        const result = await executeSequentialToolCalls(calls, executor);

        for (let i = 0; i < calls.length; i++) {
          const fr = result.functionResponses[i];
          if (outcomeMap.get(i)) {
            // Successful: response contains data, not error
            expect(fr.response).toHaveProperty('success', true);
          } else {
            // Failed: response contains error indicator
            expect(fr.response).toHaveProperty('error', true);
            expect(fr.response).toHaveProperty('message');
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('function responses are suitable for inclusion in a follow-up Gemini request (all have name + response)', () => {
    fc.assert(
      fc.asyncProperty(callListArb, async (callsWithOutcomes) => {
        const outcomeMap = new Map<number, boolean>();
        const calls: FunctionCallDescriptor[] = [];

        callsWithOutcomes.forEach((item, i) => {
          calls.push(item.call);
          outcomeMap.set(i, item.shouldSucceed);
        });

        const { executor } = buildMockExecutor(outcomeMap);
        const result = await executeSequentialToolCalls(calls, executor);

        // Every function response has the fields needed for Gemini follow-up
        for (const fr of result.functionResponses) {
          expect(typeof fr.name).toBe('string');
          expect(fr.name.length).toBeGreaterThan(0);
          expect(typeof fr.response).toBe('object');
          expect(fr.response).not.toBeNull();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
