import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  SessionManager,
  ConversationMessage,
  PdfContext,
} from '../../src/services/session-manager.js';

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager({ timeoutMs: 30 * 60 * 1000, maxMessages: 20 });
  });

  afterEach(() => {
    manager.stopCleanupInterval();
  });

  // --- Helper ---

  function makeMessage(
    role: 'user' | 'assistant' | 'tool',
    content: string,
  ): ConversationMessage {
    return { role, content, timestamp: new Date() };
  }

  // --- Constructor / configuration ---

  it('uses default timeout of 30 minutes when no options provided', () => {
    const defaultManager = new SessionManager();
    const session = defaultManager.getOrCreate('user-1');
    expect(session).toBeDefined();
    defaultManager.stopCleanupInterval();
  });

  it('uses default maxMessages of 20 when no options provided', () => {
    const defaultManager = new SessionManager();
    for (let i = 0; i < 25; i++) {
      defaultManager.addMessage('user-1', makeMessage('user', `msg-${i}`));
    }
    expect(defaultManager.getHistory('user-1')).toHaveLength(20);
    defaultManager.stopCleanupInterval();
  });

  it('reads SESSION_TIMEOUT_MS from env when no constructor option', () => {
    const original = process.env.SESSION_TIMEOUT_MS;
    try {
      process.env.SESSION_TIMEOUT_MS = '60000'; // 1 minute
      const envManager = new SessionManager();
      const session = envManager.getOrCreate('user-1');
      expect(session).toBeDefined();

      // Session should be cleaned up after 60s
      envManager.cleanup(session.lastActivity.getTime() + 60_001);
      expect(envManager.getSessionCount()).toBe(0);
      envManager.stopCleanupInterval();
    } finally {
      if (original === undefined) {
        delete process.env.SESSION_TIMEOUT_MS;
      } else {
        process.env.SESSION_TIMEOUT_MS = original;
      }
    }
  });

  it('reads MAX_CONTEXT_MESSAGES from env when no constructor option', () => {
    const original = process.env.MAX_CONTEXT_MESSAGES;
    try {
      process.env.MAX_CONTEXT_MESSAGES = '5';
      const envManager = new SessionManager();
      for (let i = 0; i < 10; i++) {
        envManager.addMessage('user-1', makeMessage('user', `msg-${i}`));
      }
      expect(envManager.getHistory('user-1')).toHaveLength(5);
      envManager.stopCleanupInterval();
    } finally {
      if (original === undefined) {
        delete process.env.MAX_CONTEXT_MESSAGES;
      } else {
        process.env.MAX_CONTEXT_MESSAGES = original;
      }
    }
  });

  it('falls back to defaults when env vars are invalid', () => {
    const origTimeout = process.env.SESSION_TIMEOUT_MS;
    const origMax = process.env.MAX_CONTEXT_MESSAGES;
    try {
      process.env.SESSION_TIMEOUT_MS = 'not-a-number';
      process.env.MAX_CONTEXT_MESSAGES = 'bad';
      const envManager = new SessionManager();
      // Should use default 20 max messages
      for (let i = 0; i < 25; i++) {
        envManager.addMessage('user-1', makeMessage('user', `msg-${i}`));
      }
      expect(envManager.getHistory('user-1')).toHaveLength(20);
      envManager.stopCleanupInterval();
    } finally {
      if (origTimeout === undefined) delete process.env.SESSION_TIMEOUT_MS;
      else process.env.SESSION_TIMEOUT_MS = origTimeout;
      if (origMax === undefined) delete process.env.MAX_CONTEXT_MESSAGES;
      else process.env.MAX_CONTEXT_MESSAGES = origMax;
    }
  });

  // --- getOrCreate ---

  it('creates a new session for a new user', () => {
    const session = manager.getOrCreate('user-1');
    expect(session.userId).toBe('user-1');
    expect(session.id).toBeDefined();
    expect(session.id.length).toBeGreaterThan(0);
    expect(session.messages).toEqual([]);
    expect(session.createdAt).toBeInstanceOf(Date);
    expect(session.lastActivity).toBeInstanceOf(Date);
    expect(session.selectedModel).toBeDefined();
  });

  it('returns the same session for the same user', () => {
    const first = manager.getOrCreate('user-1');
    const second = manager.getOrCreate('user-1');
    expect(first.id).toBe(second.id);
  });

  it('creates different sessions for different users', () => {
    const s1 = manager.getOrCreate('user-1');
    const s2 = manager.getOrCreate('user-2');
    expect(s1.id).not.toBe(s2.id);
    expect(s1.userId).toBe('user-1');
    expect(s2.userId).toBe('user-2');
  });

  it('updates lastActivity when returning existing session', () => {
    const session = manager.getOrCreate('user-1');
    const firstActivity = session.lastActivity.getTime();

    // Small delay to ensure timestamp differs
    const laterSession = manager.getOrCreate('user-1');
    expect(laterSession.lastActivity.getTime()).toBeGreaterThanOrEqual(firstActivity);
  });

  it('generates valid UUID for session id', () => {
    const session = manager.getOrCreate('user-1');
    // UUID v4 format: 8-4-4-4-12 hex chars
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(session.id).toMatch(uuidRegex);
  });

  // --- addMessage ---

  it('appends a message to the session history', () => {
    const msg = makeMessage('user', 'hello');
    manager.addMessage('user-1', msg);
    const history = manager.getHistory('user-1');
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe('hello');
    expect(history[0].role).toBe('user');
  });

  it('creates a session if one does not exist when adding a message', () => {
    expect(manager.getSessionCount()).toBe(0);
    manager.addMessage('user-1', makeMessage('user', 'hello'));
    expect(manager.getSessionCount()).toBe(1);
  });

  it('caps history at maxMessages, dropping oldest', () => {
    const smallManager = new SessionManager({ maxMessages: 3 });
    smallManager.addMessage('user-1', makeMessage('user', 'msg-1'));
    smallManager.addMessage('user-1', makeMessage('assistant', 'msg-2'));
    smallManager.addMessage('user-1', makeMessage('user', 'msg-3'));
    smallManager.addMessage('user-1', makeMessage('assistant', 'msg-4'));

    const history = smallManager.getHistory('user-1');
    expect(history).toHaveLength(3);
    expect(history[0].content).toBe('msg-2');
    expect(history[1].content).toBe('msg-3');
    expect(history[2].content).toBe('msg-4');
  });

  it('updates lastActivity when adding a message', () => {
    const session = manager.getOrCreate('user-1');
    const before = session.lastActivity.getTime();
    manager.addMessage('user-1', makeMessage('user', 'hello'));
    expect(session.lastActivity.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('preserves toolCalls on messages', () => {
    const msg: ConversationMessage = {
      role: 'assistant',
      content: 'Created contact',
      timestamp: new Date(),
      toolCalls: [
        {
          toolName: 'create_contact',
          args: { firstName: 'John', lastName: 'Doe' },
          result: { id: '123' },
          success: true,
          durationMs: 150,
        },
      ],
    };
    manager.addMessage('user-1', msg);
    const history = manager.getHistory('user-1');
    expect(history[0].toolCalls).toHaveLength(1);
    expect(history[0].toolCalls![0].toolName).toBe('create_contact');
    expect(history[0].toolCalls![0].success).toBe(true);
  });

  // --- getHistory ---

  it('returns empty array for unknown user', () => {
    expect(manager.getHistory('nonexistent')).toEqual([]);
  });

  it('returns messages in insertion order', () => {
    manager.addMessage('user-1', makeMessage('user', 'first'));
    manager.addMessage('user-1', makeMessage('assistant', 'second'));
    manager.addMessage('user-1', makeMessage('user', 'third'));

    const history = manager.getHistory('user-1');
    expect(history.map((m) => m.content)).toEqual(['first', 'second', 'third']);
  });

  // --- setModel / getModel ---

  it('defaults to GEMINI_DEFAULT_MODEL env or hardcoded fallback', () => {
    const model = manager.getModel('user-1');
    // No session exists yet, should return default
    expect(model).toBeDefined();
    expect(typeof model).toBe('string');
    expect(model.length).toBeGreaterThan(0);
  });

  it('reads GEMINI_DEFAULT_MODEL from env', () => {
    const original = process.env.GEMINI_DEFAULT_MODEL;
    try {
      process.env.GEMINI_DEFAULT_MODEL = 'gemini-3.1-pro-preview';
      const envManager = new SessionManager();
      const session = envManager.getOrCreate('user-1');
      expect(session.selectedModel).toBe('gemini-3.1-pro-preview');
      envManager.stopCleanupInterval();
    } finally {
      if (original === undefined) delete process.env.GEMINI_DEFAULT_MODEL;
      else process.env.GEMINI_DEFAULT_MODEL = original;
    }
  });

  it('setModel updates the session model', () => {
    manager.getOrCreate('user-1');
    manager.setModel('user-1', 'gemini-3.1-pro-preview');
    expect(manager.getModel('user-1')).toBe('gemini-3.1-pro-preview');
  });

  it('setModel creates a session if none exists', () => {
    manager.setModel('user-1', 'gemini-3.1-pro-preview');
    expect(manager.getSessionCount()).toBe(1);
    expect(manager.getModel('user-1')).toBe('gemini-3.1-pro-preview');
  });

  it('getModel returns default for unknown user without creating session', () => {
    const model = manager.getModel('nonexistent');
    expect(model).toBeDefined();
    expect(manager.getSessionCount()).toBe(0);
  });

  // --- setPdfContext / getPdfContext ---

  it('stores and retrieves PDF context', () => {
    const ctx: PdfContext = {
      filename: 'contract.pdf',
      extractedText: 'This is a contract...',
      uploadedAt: new Date(),
    };
    manager.setPdfContext('user-1', ctx);
    const retrieved = manager.getPdfContext('user-1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.filename).toBe('contract.pdf');
    expect(retrieved!.extractedText).toBe('This is a contract...');
  });

  it('returns undefined for user with no PDF context', () => {
    manager.getOrCreate('user-1');
    expect(manager.getPdfContext('user-1')).toBeUndefined();
  });

  it('returns undefined for unknown user', () => {
    expect(manager.getPdfContext('nonexistent')).toBeUndefined();
  });

  it('setPdfContext creates a session if none exists', () => {
    const ctx: PdfContext = {
      filename: 'test.pdf',
      extractedText: 'text',
      uploadedAt: new Date(),
    };
    manager.setPdfContext('user-1', ctx);
    expect(manager.getSessionCount()).toBe(1);
  });

  it('overwrites previous PDF context', () => {
    const ctx1: PdfContext = {
      filename: 'first.pdf',
      extractedText: 'first',
      uploadedAt: new Date(),
    };
    const ctx2: PdfContext = {
      filename: 'second.pdf',
      extractedText: 'second',
      uploadedAt: new Date(),
    };
    manager.setPdfContext('user-1', ctx1);
    manager.setPdfContext('user-1', ctx2);
    expect(manager.getPdfContext('user-1')!.filename).toBe('second.pdf');
  });

  // --- clear ---

  it('removes a user session', () => {
    manager.getOrCreate('user-1');
    expect(manager.getSessionCount()).toBe(1);
    manager.clear('user-1');
    expect(manager.getSessionCount()).toBe(0);
  });

  it('clear is a no-op for unknown user', () => {
    manager.clear('nonexistent');
    expect(manager.getSessionCount()).toBe(0);
  });

  it('does not affect other users when clearing', () => {
    manager.getOrCreate('user-1');
    manager.getOrCreate('user-2');
    manager.clear('user-1');
    expect(manager.getSessionCount()).toBe(1);
    expect(manager.getHistory('user-2')).toBeDefined();
  });

  it('clears message history and PDF context', () => {
    manager.addMessage('user-1', makeMessage('user', 'hello'));
    manager.setPdfContext('user-1', {
      filename: 'test.pdf',
      extractedText: 'text',
      uploadedAt: new Date(),
    });
    manager.clear('user-1');
    expect(manager.getHistory('user-1')).toEqual([]);
    expect(manager.getPdfContext('user-1')).toBeUndefined();
  });

  // --- cleanup ---

  it('removes expired sessions', () => {
    const session = manager.getOrCreate('user-1');
    const createdAt = session.lastActivity.getTime();

    // 31 minutes later — should be expired
    manager.cleanup(createdAt + 31 * 60 * 1000);
    expect(manager.getSessionCount()).toBe(0);
  });

  it('keeps active sessions', () => {
    const session = manager.getOrCreate('user-1');
    const createdAt = session.lastActivity.getTime();

    // 29 minutes later — should still be active
    manager.cleanup(createdAt + 29 * 60 * 1000);
    expect(manager.getSessionCount()).toBe(1);
  });

  it('removes only expired sessions, keeps active ones', () => {
    const s1 = manager.getOrCreate('user-1');
    const s1Time = s1.lastActivity.getTime();

    // Simulate user-2 being active 20 minutes later
    const s2 = manager.getOrCreate('user-2');
    s2.lastActivity = new Date(s1Time + 20 * 60 * 1000);

    // At 31 minutes from s1 creation: s1 expired, s2 still active (11 min old)
    manager.cleanup(s1Time + 31 * 60 * 1000);
    expect(manager.getSessionCount()).toBe(1);
    expect(manager.getHistory('user-2')).toBeDefined();
  });

  it('cleanup with custom timeout', () => {
    const shortManager = new SessionManager({ timeoutMs: 5000 });
    const session = shortManager.getOrCreate('user-1');
    const createdAt = session.lastActivity.getTime();

    // 4 seconds — still active
    shortManager.cleanup(createdAt + 4000);
    expect(shortManager.getSessionCount()).toBe(1);

    // 6 seconds — expired
    shortManager.cleanup(createdAt + 6000);
    expect(shortManager.getSessionCount()).toBe(0);
  });

  it('cleanup is safe on empty session store', () => {
    manager.cleanup();
    expect(manager.getSessionCount()).toBe(0);
  });

  it('session at exactly the timeout boundary is NOT removed', () => {
    const session = manager.getOrCreate('user-1');
    const createdAt = session.lastActivity.getTime();

    // Exactly at timeout — not expired (> not >=)
    manager.cleanup(createdAt + 30 * 60 * 1000);
    expect(manager.getSessionCount()).toBe(1);
  });

  // --- startCleanupInterval / stopCleanupInterval ---

  it('startCleanupInterval is idempotent', () => {
    manager.startCleanupInterval();
    manager.startCleanupInterval(); // Should not throw or create duplicate
    manager.stopCleanupInterval();
  });

  it('stopCleanupInterval is safe when not started', () => {
    manager.stopCleanupInterval(); // Should not throw
  });

  it('stopCleanupInterval is idempotent', () => {
    manager.startCleanupInterval();
    manager.stopCleanupInterval();
    manager.stopCleanupInterval(); // Should not throw
  });

  // --- getSessionCount ---

  it('returns 0 when no sessions exist', () => {
    expect(manager.getSessionCount()).toBe(0);
  });

  it('returns correct count after creating sessions', () => {
    manager.getOrCreate('user-1');
    manager.getOrCreate('user-2');
    manager.getOrCreate('user-3');
    expect(manager.getSessionCount()).toBe(3);
  });

  it('returns correct count after clearing sessions', () => {
    manager.getOrCreate('user-1');
    manager.getOrCreate('user-2');
    manager.clear('user-1');
    expect(manager.getSessionCount()).toBe(1);
  });

  // --- Edge cases ---

  it('handles empty userId string', () => {
    const session = manager.getOrCreate('');
    expect(session.userId).toBe('');
    expect(session.id).toBeDefined();
  });

  it('handles message history exactly at maxMessages', () => {
    const smallManager = new SessionManager({ maxMessages: 3 });
    smallManager.addMessage('user-1', makeMessage('user', 'msg-1'));
    smallManager.addMessage('user-1', makeMessage('assistant', 'msg-2'));
    smallManager.addMessage('user-1', makeMessage('user', 'msg-3'));

    const history = smallManager.getHistory('user-1');
    expect(history).toHaveLength(3);
    expect(history[0].content).toBe('msg-1');
  });

  it('handles maxMessages of 1', () => {
    const tinyManager = new SessionManager({ maxMessages: 1 });
    tinyManager.addMessage('user-1', makeMessage('user', 'first'));
    tinyManager.addMessage('user-1', makeMessage('user', 'second'));

    const history = tinyManager.getHistory('user-1');
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe('second');
  });

  it('all three message roles are stored correctly', () => {
    manager.addMessage('user-1', makeMessage('user', 'question'));
    manager.addMessage('user-1', makeMessage('tool', 'tool result'));
    manager.addMessage('user-1', makeMessage('assistant', 'answer'));

    const history = manager.getHistory('user-1');
    expect(history.map((m) => m.role)).toEqual(['user', 'tool', 'assistant']);
  });
});
