import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { validateChatRequest, getAvailableModels } from '../../src/utils/validators.js';

describe('validateChatRequest', () => {
  const validPayload = {
    message: 'Find all contacts',
    userApiKey: 'abc-123-key',
    userId: 'user-001',
    userName: 'Test User',
  };

  // --- Happy path ---

  it('accepts a valid payload with all required fields', () => {
    const result = validateChatRequest(validPayload);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.message).toBe('Find all contacts');
      expect(result.data.userApiKey).toBe('abc-123-key');
      expect(result.data.userId).toBe('user-001');
    }
  });

  it('accepts a valid payload with optional model', () => {
    const result = validateChatRequest({
      ...validPayload,
      model: 'gemini-3.1-pro-preview',
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.model).toBe('gemini-3.1-pro-preview');
    }
  });

  it('accepts a valid payload with optional sessionId', () => {
    const result = validateChatRequest({
      ...validPayload,
      sessionId: 'sess-abc',
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.sessionId).toBe('sess-abc');
    }
  });

  it('trims whitespace from required string fields', () => {
    const result = validateChatRequest({
      message: '  hello  ',
      userApiKey: '  key  ',
      userId: '  uid  ',
      userName: 'User',
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.message).toBe('hello');
      expect(result.data.userApiKey).toBe('key');
      expect(result.data.userId).toBe('uid');
    }
  });

  // --- Non-object payloads ---

  it('rejects null payload', () => {
    const result = validateChatRequest(null);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].field).toBe('payload');
    }
  });

  it('rejects undefined payload', () => {
    const result = validateChatRequest(undefined);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].field).toBe('payload');
    }
  });

  it('rejects a string payload', () => {
    const result = validateChatRequest('not an object');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].field).toBe('payload');
    }
  });

  it('rejects an array payload', () => {
    const result = validateChatRequest([1, 2, 3]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].field).toBe('payload');
    }
  });

  it('rejects a number payload', () => {
    const result = validateChatRequest(42);
    expect(result.valid).toBe(false);
  });

  // --- Missing required fields ---

  it('rejects when message is missing', () => {
    const { message, ...rest } = validPayload;
    const result = validateChatRequest(rest);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.field === 'message')).toBe(true);
    }
  });

  it('rejects when userApiKey is missing', () => {
    const { userApiKey, ...rest } = validPayload;
    const result = validateChatRequest(rest);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.field === 'userApiKey')).toBe(true);
    }
  });

  it('rejects when userId is missing', () => {
    const { userId, ...rest } = validPayload;
    const result = validateChatRequest(rest);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.field === 'userId')).toBe(true);
    }
  });

  // --- Collects ALL errors (no short-circuit) ---

  it('collects all errors when multiple required fields are missing', () => {
    const result = validateChatRequest({});
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const fields = result.errors.map((e) => e.field);
      expect(fields).toContain('message');
      expect(fields).toContain('userApiKey');
      expect(fields).toContain('userId');
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    }
  });

  // --- Wrong types for required fields ---

  it('rejects non-string message', () => {
    const result = validateChatRequest({ ...validPayload, message: 123 });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.field === 'message' && e.message.includes('string'))).toBe(true);
    }
  });

  it('rejects non-string userApiKey', () => {
    const result = validateChatRequest({ ...validPayload, userApiKey: true });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.field === 'userApiKey')).toBe(true);
    }
  });

  // --- Empty strings (after trim) ---

  it('rejects empty message', () => {
    const result = validateChatRequest({ ...validPayload, message: '' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.field === 'message')).toBe(true);
    }
  });

  it('rejects whitespace-only message', () => {
    const result = validateChatRequest({ ...validPayload, message: '   ' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.field === 'message')).toBe(true);
    }
  });

  // --- Invalid model ---

  it('rejects an unknown model string', () => {
    const result = validateChatRequest({ ...validPayload, model: 'gpt-4' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.field === 'model')).toBe(true);
    }
  });

  it('rejects non-string model', () => {
    const result = validateChatRequest({ ...validPayload, model: 99 });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.field === 'model')).toBe(true);
    }
  });

  // --- Invalid sessionId ---

  it('rejects non-string sessionId', () => {
    const result = validateChatRequest({ ...validPayload, sessionId: 42 });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.field === 'sessionId')).toBe(true);
    }
  });
});

describe('getAvailableModels', () => {
  const originalEnv = process.env.GEMINI_AVAILABLE_MODELS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GEMINI_AVAILABLE_MODELS;
    } else {
      process.env.GEMINI_AVAILABLE_MODELS = originalEnv;
    }
  });

  it('returns default models when env var is not set', () => {
    delete process.env.GEMINI_AVAILABLE_MODELS;
    const models = getAvailableModels();
    expect(models).toEqual(['gemini-3.1-pro-preview', 'gemini-3.1-flash-lite-preview']);
  });

  it('parses custom models from env var', () => {
    process.env.GEMINI_AVAILABLE_MODELS = 'model-a,model-b,model-c';
    const models = getAvailableModels();
    expect(models).toEqual(['model-a', 'model-b', 'model-c']);
  });

  it('trims whitespace around model names', () => {
    process.env.GEMINI_AVAILABLE_MODELS = ' model-a , model-b ';
    const models = getAvailableModels();
    expect(models).toEqual(['model-a', 'model-b']);
  });

  it('filters out empty entries from trailing commas', () => {
    process.env.GEMINI_AVAILABLE_MODELS = 'model-a,,model-b,';
    const models = getAvailableModels();
    expect(models).toEqual(['model-a', 'model-b']);
  });
});
