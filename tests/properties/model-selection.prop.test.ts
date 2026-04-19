/**
 * Property-based tests for model selection persistence.
 *
 * **Validates: Requirements 4.1**
 *
 * Property 18: Model Selection Persistence
 * For any model selection made by a user, the selected model should be stored
 * in the session and used for all subsequent calls within that session until
 * the user changes it. If no model is specified, the default model should be used.
 * Clearing a session resets the model to default.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import * as fc from 'fast-check';
import { SessionManager, ConversationMessage } from '../../src/services/session-manager.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'gemini-3.1-flash-lite-preview';
const NUM_RUNS = 100;

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Non-empty user ID string. */
const userIdArb = fc.string({ minLength: 1, maxLength: 60 }).filter((s) => s.trim().length > 0);

/** Two distinct user IDs. */
const distinctUserIdsArb = fc
  .tuple(userIdArb, userIdArb)
  .filter(([a, b]) => a !== b);

/** Arbitrary non-empty model name string. */
const modelArb = fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s.trim().length > 0);

/** Arbitrary non-empty sequence of model names (for "last write wins" testing). */
const modelSeqArb = fc.array(modelArb, { minLength: 1, maxLength: 20 });

/** Arbitrary message role. */
const roleArb = fc.constantFrom<'user' | 'assistant' | 'tool'>('user', 'assistant', 'tool');

/** Arbitrary message content (non-empty). */
const contentArb = fc.string({ minLength: 1, maxLength: 200 });

/** Build a ConversationMessage. */
function makeMessage(role: 'user' | 'assistant' | 'tool', content: string): ConversationMessage {
  return { role, content, timestamp: new Date() };
}

/** Arbitrary message sequence. */
const messageSeqArb = fc.array(fc.tuple(roleArb, contentArb), { minLength: 1, maxLength: 20 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const managers: SessionManager[] = [];

function createManager(): SessionManager {
  const mgr = new SessionManager();
  managers.push(mgr);
  return mgr;
}

afterEach(() => {
  for (const m of managers) {
    m.stopCleanupInterval();
  }
  managers.length = 0;
});

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('Property 18: Model Selection Persistence', () => {
  it('setModel persists the selection — getModel returns the exact model set', () => {
    fc.assert(
      fc.property(userIdArb, modelArb, (userId, model) => {
        const mgr = createManager();
        mgr.setModel(userId, model);

        expect(mgr.getModel(userId)).toBe(model);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('default model used when no selection has been made', () => {
    fc.assert(
      fc.property(userIdArb, (userId) => {
        const mgr = createManager();

        // No setModel call — getModel should return default
        expect(mgr.getModel(userId)).toBe(DEFAULT_MODEL);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('last setModel wins — after a sequence of setModel calls, getModel returns the last one', () => {
    fc.assert(
      fc.property(userIdArb, modelSeqArb, (userId, models) => {
        const mgr = createManager();

        for (const model of models) {
          mgr.setModel(userId, model);
        }

        const lastModel = models[models.length - 1];
        expect(mgr.getModel(userId)).toBe(lastModel);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('model selection is per-user — setting model for one user does not affect another', () => {
    fc.assert(
      fc.property(distinctUserIdsArb, modelArb, modelArb, ([userA, userB], modelA, modelB) => {
        const mgr = createManager();

        mgr.setModel(userA, modelA);
        mgr.setModel(userB, modelB);

        expect(mgr.getModel(userA)).toBe(modelA);
        expect(mgr.getModel(userB)).toBe(modelB);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('model persists across addMessage calls — adding messages does not change the selected model', () => {
    fc.assert(
      fc.property(userIdArb, modelArb, messageSeqArb, (userId, model, messages) => {
        const mgr = createManager();
        mgr.setModel(userId, model);

        // Add a bunch of messages
        for (const [role, content] of messages) {
          mgr.addMessage(userId, makeMessage(role, content));
        }

        // Model should still be the one we set
        expect(mgr.getModel(userId)).toBe(model);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('clear resets model to default — after clear and getOrCreate, model is back to default', () => {
    fc.assert(
      fc.property(userIdArb, modelArb, (userId, model) => {
        const mgr = createManager();

        // Set a custom model
        mgr.setModel(userId, model);
        expect(mgr.getModel(userId)).toBe(model);

        // Clear the session
        mgr.clear(userId);

        // After clear, getModel should return default (no session exists)
        expect(mgr.getModel(userId)).toBe(DEFAULT_MODEL);

        // Re-create session — should also have default model
        const session = mgr.getOrCreate(userId);
        expect(session.selectedModel).toBe(DEFAULT_MODEL);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
