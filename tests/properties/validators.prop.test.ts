/**
 * Property-based tests for request payload validation.
 *
 * **Validates: Requirements 10.6**
 *
 * Property 17: Request Payload Validation
 * For any incoming request payload, the validator should accept it iff it contains
 * non-empty `message`, `userApiKey`, `userId` strings. If `model` is present,
 * it must be in the allowed list. All other payloads must be rejected with
 * non-empty errors containing field + message strings.
 */

import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import {
  validateChatRequest,
  getAvailableModels,
} from '../../src/utils/validators.js';

/** Arbitrary that produces non-empty, non-whitespace-only strings. */
const nonEmptyStringArb = fc
  .string({ minLength: 1 })
  .filter((s) => s.trim().length > 0);

/** Arbitrary that picks from the actual allowed model list. */
const allowedModelArb = fc.constantFrom(...getAvailableModels());

/** Arbitrary for a fully valid payload (all required fields present, optional model from allowed list). */
const validPayloadArb = fc.record({
  message: nonEmptyStringArb,
  userApiKey: nonEmptyStringArb,
  userId: nonEmptyStringArb,
  userName: fc.string(),
  model: fc.option(allowedModelArb, { nil: undefined }),
  sessionId: fc.option(fc.string(), { nil: undefined }),
});

describe('Property 17: Request Payload Validation', () => {
  const NUM_RUNS = 100;

  it('valid payloads are always accepted', () => {
    fc.assert(
      fc.property(validPayloadArb, (payload) => {
        // Strip undefined optional keys so they don't appear in the object
        const clean: Record<string, unknown> = {
          message: payload.message,
          userApiKey: payload.userApiKey,
          userId: payload.userId,
          userName: payload.userName,
        };
        if (payload.model !== undefined) clean.model = payload.model;
        if (payload.sessionId !== undefined) clean.sessionId = payload.sessionId;

        const result = validateChatRequest(clean);
        expect(result.valid).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('payloads missing any required field are always rejected', () => {
    const requiredFields = ['message', 'userApiKey', 'userId'] as const;

    fc.assert(
      fc.property(
        validPayloadArb,
        fc.constantFrom(...requiredFields),
        (payload, fieldToRemove) => {
          const clean: Record<string, unknown> = {
            message: payload.message,
            userApiKey: payload.userApiKey,
            userId: payload.userId,
            userName: payload.userName,
          };
          delete clean[fieldToRemove];

          const result = validateChatRequest(clean);
          expect(result.valid).toBe(false);
          if (!result.valid) {
            expect(
              result.errors.some((e) => e.field === fieldToRemove),
            ).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('payloads with empty-string required fields are always rejected', () => {
    const requiredFields = ['message', 'userApiKey', 'userId'] as const;
    const emptyStringArb = fc.constantFrom('', '   ', '\t', '\n', ' \t\n ');

    fc.assert(
      fc.property(
        validPayloadArb,
        fc.constantFrom(...requiredFields),
        emptyStringArb,
        (payload, fieldToEmpty, emptyValue) => {
          const clean: Record<string, unknown> = {
            message: payload.message,
            userApiKey: payload.userApiKey,
            userId: payload.userId,
            userName: payload.userName,
          };
          clean[fieldToEmpty] = emptyValue;

          const result = validateChatRequest(clean);
          expect(result.valid).toBe(false);
          if (!result.valid) {
            expect(
              result.errors.some((e) => e.field === fieldToEmpty),
            ).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('payloads with invalid model are always rejected', () => {
    const allowedModels = getAvailableModels();
    const invalidModelArb = fc
      .string({ minLength: 1 })
      .filter((s) => !allowedModels.includes(s));

    fc.assert(
      fc.property(validPayloadArb, invalidModelArb, (payload, badModel) => {
        const clean: Record<string, unknown> = {
          message: payload.message,
          userApiKey: payload.userApiKey,
          userId: payload.userId,
          userName: payload.userName,
          model: badModel,
        };

        const result = validateChatRequest(clean);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.errors.some((e) => e.field === 'model')).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('non-object payloads are always rejected', () => {
    const nonObjectArb = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.integer(),
      fc.double(),
      fc.string(),
      fc.boolean(),
      fc.array(fc.anything()),
    );

    fc.assert(
      fc.property(nonObjectArb, (payload) => {
        const result = validateChatRequest(payload);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.errors.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejected payloads always have non-empty errors with field and message strings', () => {
    // Generate payloads that are likely invalid: mix of valid objects with
    // random mutations, non-objects, and empty objects.
    const brokenPayloadArb = fc.oneof(
      // Completely random anything
      fc.anything(),
      // Empty object
      fc.constant({}),
      // Object with wrong types for required fields
      fc.record({
        message: fc.oneof(fc.integer(), fc.boolean(), fc.constant(null)),
        userApiKey: fc.oneof(fc.integer(), fc.boolean(), fc.constant(null)),
        userId: fc.oneof(fc.integer(), fc.boolean(), fc.constant(null)),
      }),
      // Object with empty strings
      fc.record({
        message: fc.constantFrom('', '  '),
        userApiKey: fc.constantFrom('', '  '),
        userId: fc.constantFrom('', '  '),
      }),
    );

    fc.assert(
      fc.property(brokenPayloadArb, (payload) => {
        const result = validateChatRequest(payload);
        // We only assert on the structure when the result is invalid
        if (!result.valid) {
          expect(result.errors.length).toBeGreaterThan(0);
          for (const error of result.errors) {
            expect(typeof error.field).toBe('string');
            expect(error.field.length).toBeGreaterThan(0);
            expect(typeof error.message).toBe('string');
            expect(error.message.length).toBeGreaterThan(0);
          }
        }
        // If it happens to be valid (fc.anything() can produce valid objects),
        // that's fine — we only care about the error structure when rejected.
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
