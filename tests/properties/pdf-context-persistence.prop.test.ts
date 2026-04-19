/**
 * Property-based tests for PDF context persistence across sessions.
 *
 * **Validates: Requirements 8.4**
 *
 * Property 11: PDF Context Persistence
 * For any session where a PDF has been uploaded, all subsequent Gemini requests
 * within that session should include the PDF content (or extracted text) in the
 * conversation context, until the session is cleared or expires.
 *
 * We test this at the SessionManager level: once setPdfContext is called,
 * getPdfContext must return the same content after arbitrary message sequences,
 * and must return undefined after clear() or cleanup() of expired sessions.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import * as fc from 'fast-check';
import {
  SessionManager,
  type ConversationMessage,
  type PdfContext,
} from '../../src/services/session-manager.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const NUM_RUNS = 100;

// ────────────────────────────────────────────────────────────────
// Arbitraries
// ────────────────────────────────────────────────────────────────

/** Non-empty user ID. */
const userIdArb = fc
  .string({ minLength: 1, maxLength: 60 })
  .filter((s) => s.trim().length > 0);

/** Arbitrary PDF filename. */
const filenameArb = fc
  .string({ minLength: 1, maxLength: 100 })
  .filter((s) => s.trim().length > 0);

/** Arbitrary extracted text content (non-empty). */
const extractedTextArb = fc
  .string({ minLength: 1, maxLength: 500 })
  .filter((s) => s.trim().length > 0);

/** Arbitrary PdfContext (without uploadedAt — we set that deterministically). */
const pdfContextArb = fc
  .tuple(filenameArb, extractedTextArb)
  .map(([filename, extractedText]): PdfContext => ({
    filename,
    extractedText,
    uploadedAt: new Date(),
  }));

/** Arbitrary message role. */
const roleArb = fc.constantFrom<'user' | 'assistant' | 'tool'>(
  'user',
  'assistant',
  'tool',
);

/** Arbitrary message content. */
const contentArb = fc.string({ minLength: 1, maxLength: 200 });

/** Build a ConversationMessage. */
function makeMessage(
  role: 'user' | 'assistant' | 'tool',
  content: string,
): ConversationMessage {
  return { role, content, timestamp: new Date() };
}

/** Arbitrary sequence of messages (1–30). */
const messageSeqArb = fc.array(fc.tuple(roleArb, contentArb), {
  minLength: 1,
  maxLength: 30,
});

/** Arbitrary timeout in ms. */
const timeoutArb = fc.integer({ min: 1000, max: 120_000 });

/** Arbitrary base timestamp. */
const baseTimeArb = fc.integer({ min: 1_000_000, max: 1_000_000_000 });

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const managers: SessionManager[] = [];

function createManager(opts?: {
  timeoutMs?: number;
  maxMessages?: number;
}): SessionManager {
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

// ────────────────────────────────────────────────────────────────
// Property tests
// ────────────────────────────────────────────────────────────────

describe('Property 11: PDF Context Persistence', () => {
  it('PDF context is retrievable immediately after being set', () => {
    fc.assert(
      fc.property(userIdArb, pdfContextArb, (userId, pdfCtx) => {
        const mgr = createManager();
        mgr.setPdfContext(userId, pdfCtx);

        const retrieved = mgr.getPdfContext(userId);
        expect(retrieved).toBeDefined();
        expect(retrieved!.filename).toBe(pdfCtx.filename);
        expect(retrieved!.extractedText).toBe(pdfCtx.extractedText);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('PDF context persists after arbitrary message sequences', () => {
    fc.assert(
      fc.property(
        userIdArb,
        pdfContextArb,
        messageSeqArb,
        (userId, pdfCtx, messages) => {
          const mgr = createManager({ maxMessages: messages.length + 10 });

          // Set PDF context
          mgr.setPdfContext(userId, pdfCtx);

          // Add arbitrary messages to the session
          for (const [role, content] of messages) {
            mgr.addMessage(userId, makeMessage(role, content));

            // After every single message, PDF context must still be present
            const ctx = mgr.getPdfContext(userId);
            expect(ctx).toBeDefined();
            expect(ctx!.filename).toBe(pdfCtx.filename);
            expect(ctx!.extractedText).toBe(pdfCtx.extractedText);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('PDF context is removed after session is cleared', () => {
    fc.assert(
      fc.property(
        userIdArb,
        pdfContextArb,
        messageSeqArb,
        (userId, pdfCtx, messages) => {
          const mgr = createManager({ maxMessages: messages.length + 10 });

          // Set PDF context and add some messages
          mgr.setPdfContext(userId, pdfCtx);
          for (const [role, content] of messages) {
            mgr.addMessage(userId, makeMessage(role, content));
          }

          // Verify it's there
          expect(mgr.getPdfContext(userId)).toBeDefined();

          // Clear the session
          mgr.clear(userId);

          // PDF context must be gone
          expect(mgr.getPdfContext(userId)).toBeUndefined();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('PDF context is removed after session expires and cleanup runs', () => {
    fc.assert(
      fc.property(
        userIdArb,
        pdfContextArb,
        timeoutArb,
        baseTimeArb,
        (userId, pdfCtx, timeoutMs, baseTime) => {
          const mgr = createManager({ timeoutMs });

          // Create session and set PDF context
          mgr.setPdfContext(userId, pdfCtx);

          // Pin lastActivity to a known time
          const session = mgr.getOrCreate(userId);
          session.lastActivity = new Date(baseTime);

          // Run cleanup at a time strictly past the timeout
          mgr.cleanup(baseTime + timeoutMs + 1);

          // Session is gone, so PDF context must be undefined
          expect(mgr.getPdfContext(userId)).toBeUndefined();
          expect(mgr.getSessionCount()).toBe(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('PDF context survives when session has not expired', () => {
    fc.assert(
      fc.property(
        userIdArb,
        pdfContextArb,
        timeoutArb,
        baseTimeArb,
        fc.integer({ min: 0, max: 100_000 }),
        (userId, pdfCtx, timeoutMs, baseTime, rawOffset) => {
          const offset = rawOffset % timeoutMs; // ensure offset < timeoutMs

          const mgr = createManager({ timeoutMs });

          // Create session and set PDF context
          mgr.setPdfContext(userId, pdfCtx);

          // Pin lastActivity
          const session = mgr.getOrCreate(userId);
          session.lastActivity = new Date(baseTime);

          // Cleanup within the timeout window — session should survive
          mgr.cleanup(baseTime + offset);

          const ctx = mgr.getPdfContext(userId);
          expect(ctx).toBeDefined();
          expect(ctx!.filename).toBe(pdfCtx.filename);
          expect(ctx!.extractedText).toBe(pdfCtx.extractedText);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('setting a new PDF context replaces the previous one', () => {
    fc.assert(
      fc.property(
        userIdArb,
        pdfContextArb,
        pdfContextArb,
        (userId, firstPdf, secondPdf) => {
          const mgr = createManager();

          mgr.setPdfContext(userId, firstPdf);
          expect(mgr.getPdfContext(userId)!.filename).toBe(firstPdf.filename);
          expect(mgr.getPdfContext(userId)!.extractedText).toBe(
            firstPdf.extractedText,
          );

          // Replace with second PDF
          mgr.setPdfContext(userId, secondPdf);
          expect(mgr.getPdfContext(userId)!.filename).toBe(secondPdf.filename);
          expect(mgr.getPdfContext(userId)!.extractedText).toBe(
            secondPdf.extractedText,
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('PDF context is isolated between different users', () => {
    fc.assert(
      fc.property(
        userIdArb,
        userIdArb,
        pdfContextArb,
        pdfContextArb,
        (userA, userB, pdfA, pdfB) => {
          // Ensure distinct user IDs
          fc.pre(userA !== userB);

          const mgr = createManager();

          mgr.setPdfContext(userA, pdfA);
          mgr.setPdfContext(userB, pdfB);

          // Each user sees only their own PDF context
          const ctxA = mgr.getPdfContext(userA);
          const ctxB = mgr.getPdfContext(userB);

          expect(ctxA).toBeDefined();
          expect(ctxB).toBeDefined();
          expect(ctxA!.filename).toBe(pdfA.filename);
          expect(ctxA!.extractedText).toBe(pdfA.extractedText);
          expect(ctxB!.filename).toBe(pdfB.filename);
          expect(ctxB!.extractedText).toBe(pdfB.extractedText);

          // Clearing one user doesn't affect the other
          mgr.clear(userA);
          expect(mgr.getPdfContext(userA)).toBeUndefined();
          expect(mgr.getPdfContext(userB)).toBeDefined();
          expect(mgr.getPdfContext(userB)!.extractedText).toBe(
            pdfB.extractedText,
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('getPdfContext returns undefined for users with no PDF uploaded', () => {
    fc.assert(
      fc.property(userIdArb, messageSeqArb, (userId, messages) => {
        const mgr = createManager({ maxMessages: messages.length + 10 });

        // Add messages but never set PDF context
        for (const [role, content] of messages) {
          mgr.addMessage(userId, makeMessage(role, content));
        }

        // No PDF context should exist
        expect(mgr.getPdfContext(userId)).toBeUndefined();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
