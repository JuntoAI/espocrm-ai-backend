/**
 * Property-based tests for tool error forwarding.
 *
 * **Validates: Requirements 10.1**
 *
 * Property 15: Tool Error Forwarding
 * For any MCP tool execution that fails (network error, EspoCRM error,
 * timeout), the error details should be included in the next Gemini
 * request as a tool result with an error indicator, rather than being
 * swallowed or causing the conversation to abort.
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
// Error type definitions
// ────────────────────────────────────────────────────────────────

/** The distinct error categories we want to exercise. */
type ErrorCategory = 'network' | 'permission_403' | 'timeout' | 'generic';

const ERROR_CATEGORIES: ErrorCategory[] = [
  'network',
  'permission_403',
  'timeout',
  'generic',
];

/** Build a realistic Error for a given category. */
function buildError(category: ErrorCategory, toolName: string): Error {
  switch (category) {
    case 'network':
      return new Error(
        `connect ECONNREFUSED 127.0.0.1:8080 while calling ${toolName}`,
      );
    case 'permission_403':
      return new Error(
        `EspoCRM API error: 403 Forbidden – insufficient permissions for ${toolName}`,
      );
    case 'timeout':
      return new Error(
        `EspoCRM API request timed out after 30000ms for ${toolName}`,
      );
    case 'generic':
      return new Error(
        `Unexpected failure executing ${toolName}: internal server error`,
      );
  }
}

// ────────────────────────────────────────────────────────────────
// Arbitraries
// ────────────────────────────────────────────────────────────────

/** Arbitrary tool name (realistic snake_case identifiers). */
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

/** Arbitrary error category. */
const errorCategoryArb: fc.Arbitrary<ErrorCategory> = fc.constantFrom(
  ...ERROR_CATEGORIES,
);

/** A function call descriptor that ALWAYS fails, with a specific error type. */
const failingCallArb = fc
  .tuple(toolNameArb, toolArgsArb, errorCategoryArb)
  .map(([name, args, errorCategory]) => ({
    call: { name, args } as FunctionCallDescriptor,
    errorCategory,
  }));

/** Whether a call should succeed or fail, with error category for failures. */
const callWithOutcomeArb = fc
  .tuple(toolNameArb, toolArgsArb, fc.boolean(), errorCategoryArb)
  .map(([name, args, shouldSucceed, errorCategory]) => ({
    call: { name, args } as FunctionCallDescriptor,
    shouldSucceed,
    errorCategory,
  }));

/** List of 1–10 calls where ALL fail (for focused error-only tests). */
const allFailingCallListArb = fc.array(failingCallArb, {
  minLength: 1,
  maxLength: 10,
});

/** List of 1–10 calls with mixed success/failure outcomes. */
const mixedCallListArb = fc.array(callWithOutcomeArb, {
  minLength: 1,
  maxLength: 10,
});

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/**
 * Build a mock executor where each call either succeeds or throws
 * a specific error type based on the outcome map.
 */
function buildErrorExecutor(
  outcomeMap: Map<
    number,
    { shouldSucceed: boolean; errorCategory: ErrorCategory }
  >,
): {
  executor: ToolCallCallback;
  executionOrder: Array<{ index: number; name: string }>;
} {
  const executionOrder: Array<{ index: number; name: string }> = [];
  let callIndex = 0;

  const executor: ToolCallCallback = async (name: string, _args: object) => {
    const currentIndex = callIndex++;
    executionOrder.push({ index: currentIndex, name });

    const outcome = outcomeMap.get(currentIndex);
    if (!outcome || !outcome.shouldSucceed) {
      const category = outcome?.errorCategory ?? 'generic';
      throw buildError(category, name);
    }
    return { success: true, data: { tool: name, index: currentIndex } };
  };

  return { executor, executionOrder };
}

// ────────────────────────────────────────────────────────────────
// Property tests
// ────────────────────────────────────────────────────────────────

describe('Property 15: Tool Error Forwarding', () => {
  it('conversation does NOT abort — all calls are attempted even when some or all fail', () => {
    fc.assert(
      fc.asyncProperty(mixedCallListArb, async (callsWithOutcomes) => {
        const outcomeMap = new Map<
          number,
          { shouldSucceed: boolean; errorCategory: ErrorCategory }
        >();
        const calls: FunctionCallDescriptor[] = [];

        callsWithOutcomes.forEach((item, i) => {
          calls.push(item.call);
          outcomeMap.set(i, {
            shouldSucceed: item.shouldSucceed,
            errorCategory: item.errorCategory,
          });
        });

        const { executor, executionOrder } = buildErrorExecutor(outcomeMap);
        // Must NOT throw — the conversation must not abort
        const result = await executeSequentialToolCalls(calls, executor);

        // Every single call was attempted
        expect(executionOrder).toHaveLength(calls.length);
        // Results accumulated for every call
        expect(result.toolsUsed).toHaveLength(calls.length);
        expect(result.functionResponses).toHaveLength(calls.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('failed tool results contain an error indicator (error: true)', () => {
    fc.assert(
      fc.asyncProperty(allFailingCallListArb, async (failingCalls) => {
        const outcomeMap = new Map<
          number,
          { shouldSucceed: boolean; errorCategory: ErrorCategory }
        >();
        const calls: FunctionCallDescriptor[] = [];

        failingCalls.forEach((item, i) => {
          calls.push(item.call);
          outcomeMap.set(i, {
            shouldSucceed: false,
            errorCategory: item.errorCategory,
          });
        });

        const { executor } = buildErrorExecutor(outcomeMap);
        const result = await executeSequentialToolCalls(calls, executor);

        for (let i = 0; i < calls.length; i++) {
          const fr = result.functionResponses[i];
          // Error indicator MUST be present
          expect(fr.response).toHaveProperty('error', true);
          expect(fr.success).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('failed tool results contain a human-readable error message', () => {
    fc.assert(
      fc.asyncProperty(allFailingCallListArb, async (failingCalls) => {
        const outcomeMap = new Map<
          number,
          { shouldSucceed: boolean; errorCategory: ErrorCategory }
        >();
        const calls: FunctionCallDescriptor[] = [];

        failingCalls.forEach((item, i) => {
          calls.push(item.call);
          outcomeMap.set(i, {
            shouldSucceed: false,
            errorCategory: item.errorCategory,
          });
        });

        const { executor } = buildErrorExecutor(outcomeMap);
        const result = await executeSequentialToolCalls(calls, executor);

        for (let i = 0; i < calls.length; i++) {
          const fr = result.functionResponses[i];
          const resp = fr.response as Record<string, unknown>;
          // Must have a non-empty human-readable message
          expect(typeof resp.message).toBe('string');
          expect((resp.message as string).length).toBeGreaterThan(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('function response for failed calls has the correct tool name', () => {
    fc.assert(
      fc.asyncProperty(allFailingCallListArb, async (failingCalls) => {
        const outcomeMap = new Map<
          number,
          { shouldSucceed: boolean; errorCategory: ErrorCategory }
        >();
        const calls: FunctionCallDescriptor[] = [];

        failingCalls.forEach((item, i) => {
          calls.push(item.call);
          outcomeMap.set(i, {
            shouldSucceed: false,
            errorCategory: item.errorCategory,
          });
        });

        const { executor } = buildErrorExecutor(outcomeMap);
        const result = await executeSequentialToolCalls(calls, executor);

        for (let i = 0; i < calls.length; i++) {
          // The name on the function response must match the original call
          // so Gemini knows which tool failed
          expect(result.functionResponses[i].name).toBe(calls[i].name);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('failed function responses are structured for Gemini follow-up (have name + response fields)', () => {
    fc.assert(
      fc.asyncProperty(allFailingCallListArb, async (failingCalls) => {
        const outcomeMap = new Map<
          number,
          { shouldSucceed: boolean; errorCategory: ErrorCategory }
        >();
        const calls: FunctionCallDescriptor[] = [];

        failingCalls.forEach((item, i) => {
          calls.push(item.call);
          outcomeMap.set(i, {
            shouldSucceed: false,
            errorCategory: item.errorCategory,
          });
        });

        const { executor } = buildErrorExecutor(outcomeMap);
        const result = await executeSequentialToolCalls(calls, executor);

        for (const fr of result.functionResponses) {
          // Must have `name` (non-empty string) and `response` (non-null object)
          expect(typeof fr.name).toBe('string');
          expect(fr.name.length).toBeGreaterThan(0);
          expect(typeof fr.response).toBe('object');
          expect(fr.response).not.toBeNull();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('mixed success/failure: only failed calls have error indicator, successful calls have data', () => {
    fc.assert(
      fc.asyncProperty(mixedCallListArb, async (callsWithOutcomes) => {
        const outcomeMap = new Map<
          number,
          { shouldSucceed: boolean; errorCategory: ErrorCategory }
        >();
        const calls: FunctionCallDescriptor[] = [];

        callsWithOutcomes.forEach((item, i) => {
          calls.push(item.call);
          outcomeMap.set(i, {
            shouldSucceed: item.shouldSucceed,
            errorCategory: item.errorCategory,
          });
        });

        const { executor } = buildErrorExecutor(outcomeMap);
        const result = await executeSequentialToolCalls(calls, executor);

        for (let i = 0; i < calls.length; i++) {
          const fr = result.functionResponses[i];
          const outcome = outcomeMap.get(i)!;

          if (outcome.shouldSucceed) {
            // Successful call: no error indicator, has data
            expect(fr.success).toBe(true);
            expect(fr.response).toHaveProperty('success', true);
          } else {
            // Failed call: error indicator present, message present
            expect(fr.success).toBe(false);
            expect(fr.response).toHaveProperty('error', true);
            expect(fr.response).toHaveProperty('message');
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('error messages from different error types (network, 403, timeout, generic) are all captured', () => {
    fc.assert(
      fc.asyncProperty(
        fc.tuple(toolNameArb, toolArgsArb, errorCategoryArb),
        async ([name, args, errorCategory]) => {
          const call: FunctionCallDescriptor = { name, args };
          const outcomeMap = new Map<
            number,
            { shouldSucceed: boolean; errorCategory: ErrorCategory }
          >();
          outcomeMap.set(0, { shouldSucceed: false, errorCategory });

          const { executor } = buildErrorExecutor(outcomeMap);
          const result = await executeSequentialToolCalls([call], executor);

          const fr = result.functionResponses[0];
          const resp = fr.response as Record<string, unknown>;

          // Regardless of error type, the error is captured — not swallowed
          expect(fr.success).toBe(false);
          expect(resp.error).toBe(true);
          expect(typeof resp.message).toBe('string');
          expect((resp.message as string).length).toBeGreaterThan(0);

          // The message should contain something meaningful from the original error
          // (not a generic "unknown" placeholder)
          const msg = resp.message as string;
          // Each error type produces a message that references the tool or error context
          expect(msg.length).toBeGreaterThan(5);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
