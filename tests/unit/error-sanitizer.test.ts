import { describe, it, expect } from '@jest/globals';
import {
  sanitizeError,
  categorizeError,
  getUserFriendlyMessage,
} from '../../src/utils/error-sanitizer.js';
import type { ErrorCategory } from '../../src/utils/error-sanitizer.js';

// ---------------------------------------------------------------------------
// sanitizeError
// ---------------------------------------------------------------------------

describe('sanitizeError', () => {
  // --- Stack trace stripping ---

  it('strips Node.js-style stack traces', () => {
    const error = new Error('Something broke');
    error.stack =
      'Error: Something broke\n' +
      '    at Object.<anonymous> (/app/src/index.ts:10:5)\n' +
      '    at Module._compile (node:internal/modules/cjs/loader:1376:14)\n' +
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)';
    const result = sanitizeError(error);
    expect(result).not.toMatch(/at\s+/);
    expect(result).not.toMatch(/\.ts:\d+:\d+/);
    expect(result).toContain('Something broke');
  });

  it('strips stack traces embedded in string errors', () => {
    const msg =
      'Error: fail at doStuff (/app/src/service.ts:42:10) at main (/app/src/index.ts:5:3)';
    const result = sanitizeError(msg);
    expect(result).not.toMatch(/at\s+doStuff/);
    expect(result).not.toMatch(/\.ts:\d+:\d+/);
  });

  // --- API key stripping ---

  it('strips apiKey query parameters', () => {
    const msg = 'Request failed: url=http://example.com?apiKey=sk-abc123xyz456 status=500';
    const result = sanitizeError(msg);
    expect(result).not.toContain('sk-abc123xyz456');
  });

  it('strips X-Api-Key headers', () => {
    const msg = 'Headers: X-Api-Key: my-super-secret-key-12345678901234567890';
    const result = sanitizeError(msg);
    expect(result).not.toContain('my-super-secret-key');
  });

  it('strips Authorization headers', () => {
    const msg = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature';
    const result = sanitizeError(msg);
    expect(result).not.toContain('eyJhbGciOiJ');
  });

  it('strips long hex strings that look like API keys', () => {
    const key = 'a'.repeat(40);
    const msg = `Failed with key ${key} in request`;
    const result = sanitizeError(msg);
    expect(result).not.toContain(key);
  });

  // --- Internal URL stripping ---

  it('strips localhost URLs', () => {
    const msg = 'Connection refused: http://localhost:3001/chat';
    const result = sanitizeError(msg);
    expect(result).not.toContain('localhost');
    expect(result).not.toContain('3001');
    expect(result).toContain('[internal service]');
  });

  it('strips espocrm-app internal URLs', () => {
    const msg = 'Failed to reach http://espocrm-app:8080/api/v1/Contact';
    const result = sanitizeError(msg);
    expect(result).not.toContain('espocrm-app');
    expect(result).not.toContain('8080');
  });

  it('strips ai-backend internal URLs', () => {
    const msg = 'Error calling http://ai-backend:3001/health';
    const result = sanitizeError(msg);
    expect(result).not.toContain('ai-backend');
  });

  it('strips 127.0.0.1 URLs', () => {
    const msg = 'ECONNREFUSED http://127.0.0.1:5000/api';
    const result = sanitizeError(msg);
    expect(result).not.toContain('127.0.0.1');
  });

  // --- Raw error object stripping ---

  it('strips large JSON blobs from messages', () => {
    const blob = JSON.stringify({ code: 500, details: { stack: 'x'.repeat(50) } });
    const msg = `Tool failed with response: ${blob}`;
    const result = sanitizeError(msg);
    expect(result).not.toContain('"code":500');
    expect(result).toContain('[details removed]');
  });

  // --- Non-Error inputs ---

  it('handles string input', () => {
    const result = sanitizeError('simple error message');
    expect(result).toBe('simple error message');
  });

  it('handles object with message field', () => {
    const result = sanitizeError({ message: 'object error' });
    expect(result).toBe('object error');
  });

  it('handles object with error field', () => {
    const result = sanitizeError({ error: 'something failed' });
    expect(result).toBe('something failed');
  });

  it('handles null input', () => {
    const result = sanitizeError(null);
    expect(result).toBe('An error occurred.');
  });

  it('handles undefined input', () => {
    const result = sanitizeError(undefined);
    expect(result).toBe('An error occurred.');
  });

  it('handles number input', () => {
    const result = sanitizeError(42);
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });

  it('handles boolean input', () => {
    const result = sanitizeError(false);
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });

  it('handles empty string input', () => {
    const result = sanitizeError('');
    expect(result).toBe('An error occurred.');
  });

  // --- Never returns empty string ---

  it('never returns an empty string for whitespace-only input', () => {
    const result = sanitizeError('   ');
    expect(result.length).toBeGreaterThan(0);
  });

  it('never returns an empty string for empty object', () => {
    const result = sanitizeError({});
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// categorizeError
// ---------------------------------------------------------------------------

describe('categorizeError', () => {
  // --- Gemini timeout ---

  it('categorizes Gemini API timeout', () => {
    expect(categorizeError(new Error('Gemini API timeout after 30s'))).toBe('gemini_timeout');
  });

  it('categorizes ETIMEDOUT as gemini_timeout', () => {
    expect(categorizeError(new Error('ETIMEDOUT'))).toBe('gemini_timeout');
  });

  it('categorizes deadline exceeded as gemini_timeout', () => {
    expect(categorizeError(new Error('Deadline exceeded'))).toBe('gemini_timeout');
  });

  it('categorizes Vertex AI timeout', () => {
    expect(categorizeError(new Error('Vertex AI request timeout'))).toBe('gemini_timeout');
  });

  // --- Gemini unavailable ---

  it('categorizes ECONNREFUSED as gemini_unavailable', () => {
    expect(categorizeError(new Error('ECONNREFUSED'))).toBe('gemini_unavailable');
  });

  it('categorizes ENOTFOUND as gemini_unavailable', () => {
    expect(categorizeError(new Error('ENOTFOUND'))).toBe('gemini_unavailable');
  });

  it('categorizes service unavailable as gemini_unavailable', () => {
    expect(categorizeError(new Error('Service unavailable'))).toBe('gemini_unavailable');
  });

  it('categorizes 503 status code as gemini_unavailable', () => {
    expect(categorizeError({ message: 'error', status: 503 })).toBe('gemini_unavailable');
  });

  it('categorizes axios-style 503 as gemini_unavailable', () => {
    expect(
      categorizeError({ message: 'error', response: { status: 503 } }),
    ).toBe('gemini_unavailable');
  });

  // --- Permission denied ---

  it('categorizes 403 status code as permission_denied', () => {
    expect(categorizeError({ message: 'Forbidden', status: 403 })).toBe('permission_denied');
  });

  it('categorizes "permission denied" message as permission_denied', () => {
    expect(categorizeError(new Error('Permission denied for create_contact'))).toBe(
      'permission_denied',
    );
  });

  it('categorizes "forbidden" message as permission_denied', () => {
    expect(categorizeError(new Error('Forbidden: cannot delete Account'))).toBe(
      'permission_denied',
    );
  });

  it('categorizes "access denied" message as permission_denied', () => {
    expect(categorizeError(new Error('Access denied'))).toBe('permission_denied');
  });

  // --- Tool failure ---

  it('categorizes tool execution failure', () => {
    expect(categorizeError(new Error('Tool execution failed: create_contact'))).toBe(
      'tool_failure',
    );
  });

  it('categorizes MCP tool error', () => {
    expect(categorizeError(new Error('MCP tool error: search_accounts'))).toBe('tool_failure');
  });

  it('categorizes function call failure', () => {
    expect(categorizeError(new Error('Function call failed for search_contacts'))).toBe(
      'tool_failure',
    );
  });

  // --- Search grounding unavailable ---

  it('categorizes search grounding unavailable', () => {
    expect(categorizeError(new Error('Search grounding is unavailable'))).toBe(
      'search_grounding_unavailable',
    );
  });

  it('categorizes grounding unavailable', () => {
    expect(categorizeError(new Error('Grounding unavailable for this request'))).toBe(
      'search_grounding_unavailable',
    );
  });

  // --- Unknown ---

  it('categorizes unrecognized errors as unknown', () => {
    expect(categorizeError(new Error('Something weird happened'))).toBe('unknown');
  });

  it('categorizes null as unknown', () => {
    expect(categorizeError(null)).toBe('unknown');
  });

  it('categorizes undefined as unknown', () => {
    expect(categorizeError(undefined)).toBe('unknown');
  });

  it('categorizes empty string as unknown', () => {
    expect(categorizeError('')).toBe('unknown');
  });

  it('categorizes plain objects without recognizable patterns as unknown', () => {
    expect(categorizeError({ code: 'SOMETHING' })).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// getUserFriendlyMessage
// ---------------------------------------------------------------------------

describe('getUserFriendlyMessage', () => {
  it('returns timeout message for Gemini timeout', () => {
    const msg = getUserFriendlyMessage(new Error('Gemini API timeout'));
    expect(msg).toContain('trouble processing');
    expect(msg).toContain('try again');
  });

  it('returns unavailable message for Gemini unreachable', () => {
    const msg = getUserFriendlyMessage(new Error('ECONNREFUSED'));
    expect(msg).toContain('temporarily unavailable');
  });

  it('returns permission message for 403 errors', () => {
    const msg = getUserFriendlyMessage({ message: 'Forbidden', status: 403 });
    expect(msg).toContain("don't have permission");
    expect(msg).toContain('administrator');
  });

  it('includes extracted action in permission message when available', () => {
    const msg = getUserFriendlyMessage(
      new Error('Permission denied for delete contacts'),
    );
    expect(msg).toContain("don't have permission to delete contacts");
    expect(msg).toContain('administrator');
  });

  it('returns generic permission message when action cannot be extracted', () => {
    const msg = getUserFriendlyMessage({ message: 'nope', status: 403 });
    expect(msg).toContain("don't have permission");
    expect(msg).toContain('administrator');
  });

  it('returns tool failure message for MCP errors', () => {
    const msg = getUserFriendlyMessage(new Error('Tool execution failed'));
    expect(msg).toContain('went wrong');
  });

  it('returns search grounding message when unavailable', () => {
    const msg = getUserFriendlyMessage(new Error('Search grounding is unavailable'));
    expect(msg).toContain('search results');
    expect(msg).toContain('unavailable');
  });

  it('returns generic message for unknown errors', () => {
    const msg = getUserFriendlyMessage(new Error('wat'));
    expect(msg).toContain('unexpected');
  });

  it('returns a non-empty string for null input', () => {
    const msg = getUserFriendlyMessage(null);
    expect(msg.length).toBeGreaterThan(0);
  });

  it('returns a non-empty string for undefined input', () => {
    const msg = getUserFriendlyMessage(undefined);
    expect(msg.length).toBeGreaterThan(0);
  });

  // --- Messages never contain sensitive data ---

  it('does not leak stack traces in user-facing messages', () => {
    const error = new Error('Gemini API timeout');
    error.stack = 'Error: timeout\n    at foo (/app/src/bar.ts:10:5)';
    const msg = getUserFriendlyMessage(error);
    expect(msg).not.toMatch(/at\s+foo/);
    expect(msg).not.toMatch(/\.ts:\d+/);
  });

  it('does not leak internal URLs in user-facing messages', () => {
    const msg = getUserFriendlyMessage(
      new Error('ECONNREFUSED http://ai-backend:3001/chat'),
    );
    expect(msg).not.toContain('ai-backend');
    expect(msg).not.toContain('3001');
  });
});
