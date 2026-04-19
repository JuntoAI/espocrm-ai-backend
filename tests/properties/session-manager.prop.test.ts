/**
 * Property-based tests for the session manager lifecycle.
 *
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.5**
 *
 * Property 7: Session Lifecycle
 * For any user ID, sending a first message should create a new session.
 * For any message added to an existing session, the session's message history
 * should contain that message. For any session whose lastActivity timestamp is
 * older than the configured timeout, the cleanup function should remove it.
 * Cleared sessions should be removed from the store.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import * as fc from 'fast-check';
import { SessionManager, ConversationMessage } from '../../src/services/session-manager.js';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Non-empty user ID string. */
const userIdArb = fc.string({ minLength: 1, maxLength: 60 }).filter((s) => s.trim().length > 0);

/** Arbitrary message role. */
const roleArb = fc.constantFrom<'user' | 'assistant' | 'tool'>('user', 'assistant', 'tool');

/** Arbitrary message content (non-empty). */
const contentArb = fc.string({ minLength: 1, maxLength: 200 });

/** Build a ConversationMessage from role + content. */
function makeMessage(role: 'user' | 'assistant' | 'tool', content: string): ConversationMessage {
  return { role, content, timestamp: new Date() };
}

/** Arbitrary for a list of (role, content) pairs representing a message sequence. */
const messageSeqArb = fc.array(
  fc.tuple(roleArb, contentArb),
  { minLength: 1, maxLength: 40 },
);

/** Arbitrary for a reasonable maxMessages cap. */
const maxMessagesArb = fc.integer({ min: 1, max: 50 });

/** Arbitrary for a timeout in ms (small for testing). */
const timeoutArb = fc.integer({ min: 1000, max: 120_000 });

/** Arbitrary for a base timestamp. */
const baseTimeArb = fc.integer({ min: 1_000_000, max: 1_000_000_000 });

const NUM_RUNS = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Track managers so we can stop cleanup intervals in afterEach. */
const managers: SessionManager[] = [];

function createManager(opts?: { timeoutMs?: number; maxMessages?: number }): SessionManager {
  const mgr = new SessionManager(opts);
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

describe('Property 7: Session Lifecycle', () => {
  it('first message creates a session with valid UUID, correct userId, and empty messages', () => {
    const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    fc.assert(
      fc.property(userIdArb, (userId) => {
        const mgr = createManager();
        const session = mgr.getOrCreate(userId);

        // Session has a valid UUID
        expect(session.id).toMatch(uuidV4Regex);
        // Correct userId
        expect(session.userId).toBe(userId);
        // Empty messages on creation
        expect(session.messages).toEqual([]);
        // Session count is 1
        expect(mgr.getSessionCount()).toBe(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('messages are stored in insertion order', () => {
    fc.assert(
      fc.property(userIdArb, messageSeqArb, (userId, seq) => {
        const mgr = createManager({ maxMessages: seq.length + 10 }); // ensure no capping
        for (const [role, content] of seq) {
          mgr.addMessage(userId, makeMessage(role, content));
        }

        const history = mgr.getHistory(userId);
        expect(history).toHaveLength(seq.length);

        for (let i = 0; i < seq.length; i++) {
          expect(history[i].role).toBe(seq[i][0]);
          expect(history[i].content).toBe(seq[i][1]);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('history is capped at maxMessages, keeping the N most recent', () => {
    fc.assert(
      fc.property(
        userIdArb,
        maxMessagesArb,
        // Generate more messages than maxMessages
        fc.integer({ min: 1, max: 30 }),
        messageSeqArb,
        (userId, maxMessages, extra, baseMsgs) => {
          // Ensure we have more messages than the cap
          const totalCount = maxMessages + extra;
          const allMessages: [string, string][] = [];
          for (let i = 0; i < totalCount; i++) {
            const idx = i % baseMsgs.length;
            allMessages.push([baseMsgs[idx][0], `msg-${i}-${baseMsgs[idx][1]}`]);
          }

          const mgr = createManager({ maxMessages });
          for (const [role, content] of allMessages) {
            mgr.addMessage(userId, makeMessage(role as 'user' | 'assistant' | 'tool', content));
          }

          const history = mgr.getHistory(userId);
          // Length must equal maxMessages
          expect(history).toHaveLength(maxMessages);

          // Must contain the most recent maxMessages messages
          const expectedSlice = allMessages.slice(allMessages.length - maxMessages);
          for (let i = 0; i < maxMessages; i++) {
            expect(history[i].role).toBe(expectedSlice[i][0]);
            expect(history[i].content).toBe(expectedSlice[i][1]);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('expired sessions are cleaned up', () => {
    fc.assert(
      fc.property(userIdArb, timeoutArb, baseTimeArb, (userId, timeoutMs, baseTime) => {
        const mgr = createManager({ timeoutMs });
        const session = mgr.getOrCreate(userId);

        // Pin lastActivity to a known time
        session.lastActivity = new Date(baseTime);

        // Cleanup at a time strictly past the timeout
        mgr.cleanup(baseTime + timeoutMs + 1);

        expect(mgr.getSessionCount()).toBe(0);
        expect(mgr.getHistory(userId)).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('active sessions survive cleanup', () => {
    fc.assert(
      fc.property(
        userIdArb,
        timeoutArb,
        baseTimeArb,
        // Offset within the timeout window (0 to timeoutMs - 1)
        fc.integer({ min: 0, max: 100_000 }),
        (userId, timeoutMs, baseTime, rawOffset) => {
          const offset = rawOffset % timeoutMs; // ensure offset < timeoutMs

          const mgr = createManager({ timeoutMs });
          const session = mgr.getOrCreate(userId);

          // Pin lastActivity to a known time
          session.lastActivity = new Date(baseTime);

          // Cleanup at a time within the timeout window
          mgr.cleanup(baseTime + offset);

          expect(mgr.getSessionCount()).toBe(1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('cleared sessions are removed and getHistory returns empty', () => {
    fc.assert(
      fc.property(userIdArb, messageSeqArb, (userId, seq) => {
        const mgr = createManager({ maxMessages: seq.length + 10 });

        // Add messages to create a session with history
        for (const [role, content] of seq) {
          mgr.addMessage(userId, makeMessage(role, content));
        }

        const countBefore = mgr.getSessionCount();
        expect(countBefore).toBe(1);

        // Clear the session
        mgr.clear(userId);

        // Session count decreases
        expect(mgr.getSessionCount()).toBe(countBefore - 1);
        // History is empty
        expect(mgr.getHistory(userId)).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
