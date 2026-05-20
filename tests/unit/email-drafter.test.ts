/**
 * Unit tests for EmailDrafter service.
 *
 * Tests input validation, contact lookup, Gemini integration,
 * output formatting, and error handling.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { EmailDrafter } from '../../src/services/email-drafter.js';
import type {
  EmailDraftParams,
  EmailDraft,
  EmailDraftError,
  GeminiGenerateContentFn,
} from '../../src/services/email-drafter.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function validParams(overrides?: Partial<EmailDraftParams>): EmailDraftParams {
  return {
    contactId: 'abc123',
    purpose: 'Follow up on our partnership discussion',
    tone: 'formal',
    keyPoints: ['Discuss timeline', 'Confirm budget'],
    ...overrides,
  };
}

function isError(result: EmailDraft | EmailDraftError): result is EmailDraftError {
  return 'error' in result && result.error === true;
}

// Mock fetch globally
const mockFetch = jest.fn<typeof global.fetch>();
(global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('EmailDrafter', () => {
  let drafter: EmailDrafter;
  let mockGemini: jest.Mock<GeminiGenerateContentFn>;

  beforeEach(() => {
    mockGemini = jest.fn<GeminiGenerateContentFn>();
    drafter = new EmailDrafter('https://crm.example.com', mockGemini);
    mockFetch.mockReset();
  });

  // ─── Input Validation ──────────────────────────────────────────────────

  describe('input validation', () => {
    it('rejects empty contactId', async () => {
      const result = await drafter.draft(validParams({ contactId: '' }), 'api-key');
      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('INVALID_PARAMS');
        expect(result.details).toContain('contactId: must be a non-empty string');
      }
    });

    it('rejects whitespace-only contactId', async () => {
      const result = await drafter.draft(validParams({ contactId: '   ' }), 'api-key');
      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('INVALID_PARAMS');
        expect(result.details).toContain('contactId: must be a non-empty string');
      }
    });

    it('rejects purpose longer than 500 chars', async () => {
      const result = await drafter.draft(validParams({ purpose: 'x'.repeat(501) }), 'api-key');
      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('INVALID_PARAMS');
        expect(result.details).toContain('purpose: must be between 1 and 500 characters');
      }
    });

    it('rejects empty purpose', async () => {
      const result = await drafter.draft(validParams({ purpose: '' }), 'api-key');
      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('INVALID_PARAMS');
        expect(result.details).toContain('purpose: must be between 1 and 500 characters');
      }
    });

    it('rejects invalid tone', async () => {
      const result = await drafter.draft(
        validParams({ tone: 'aggressive' as 'formal' }),
        'api-key',
      );
      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('INVALID_PARAMS');
        expect(result.details).toContain('tone: must be "formal" or "casual"');
      }
    });

    it('rejects empty keyPoints array', async () => {
      const result = await drafter.draft(validParams({ keyPoints: [] }), 'api-key');
      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('INVALID_PARAMS');
        expect(result.details).toContain('keyPoints: must contain between 1 and 10 items');
      }
    });

    it('rejects keyPoints with more than 10 items', async () => {
      const result = await drafter.draft(
        validParams({ keyPoints: Array(11).fill('point') }),
        'api-key',
      );
      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('INVALID_PARAMS');
        expect(result.details).toContain('keyPoints: must contain between 1 and 10 items');
      }
    });

    it('rejects keyPoint longer than 200 chars', async () => {
      const result = await drafter.draft(
        validParams({ keyPoints: ['x'.repeat(201)] }),
        'api-key',
      );
      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('INVALID_PARAMS');
        expect(result.details!.some(d => d.includes('keyPoints[0]'))).toBe(true);
      }
    });

    it('rejects empty keyPoint string', async () => {
      const result = await drafter.draft(
        validParams({ keyPoints: ['valid', ''] }),
        'api-key',
      );
      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('INVALID_PARAMS');
        expect(result.details!.some(d => d.includes('keyPoints[1]'))).toBe(true);
      }
    });

    it('collects multiple validation errors at once', async () => {
      const result = await drafter.draft(
        {
          contactId: '',
          purpose: '',
          tone: 'angry' as 'formal',
          keyPoints: [],
        },
        'api-key',
      );
      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('INVALID_PARAMS');
        expect(result.details!.length).toBeGreaterThanOrEqual(4);
      }
    });

    it('does NOT call Gemini when validation fails', async () => {
      await drafter.draft(validParams({ contactId: '' }), 'api-key');
      expect(mockGemini).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('accepts valid params at boundary values', async () => {
      // Setup mock for successful contact lookup
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          firstName: 'Maria',
          lastName: 'Test',
          emailAddress: 'maria@test.com',
          accountName: 'TestCo',
          cRole: 'Partner',
        }),
      } as Response);

      mockGemini.mockResolvedValueOnce('SUBJECT: Hello\nBODY:\nHi there');

      const result = await drafter.draft(
        validParams({
          purpose: 'x'.repeat(500), // exactly 500 chars
          keyPoints: Array(10).fill('y'.repeat(200)), // exactly 10 items, each 200 chars
        }),
        'api-key',
      );
      expect(isError(result)).toBe(false);
    });
  });

  // ─── Contact Lookup ────────────────────────────────────────────────────

  describe('contact lookup', () => {
    it('returns CONTACT_NOT_FOUND on 404', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({}),
      } as Response);

      const result = await drafter.draft(validParams(), 'api-key');
      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('CONTACT_NOT_FOUND');
      }
    });

    it('returns CONTACT_NOT_FOUND on 403', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({}),
      } as Response);

      const result = await drafter.draft(validParams(), 'api-key');
      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('CONTACT_NOT_FOUND');
      }
    });

    it('passes user API key in X-Api-Key header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          firstName: 'Maria',
          lastName: 'Test',
          emailAddress: 'maria@test.com',
          accountName: null,
          cRole: null,
        }),
      } as Response);

      mockGemini.mockResolvedValueOnce('SUBJECT: Hi\nBODY:\nHello');

      await drafter.draft(validParams(), 'my-secret-key');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/Contact/abc123'),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Api-Key': 'my-secret-key',
          }),
        }),
      );
    });

    it('uses correct URL with select fields', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          firstName: 'Maria',
          lastName: 'Test',
          emailAddress: 'maria@test.com',
          accountName: null,
          cRole: null,
        }),
      } as Response);

      mockGemini.mockResolvedValueOnce('SUBJECT: Hi\nBODY:\nHello');

      await drafter.draft(validParams(), 'api-key');

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('https://crm.example.com/api/v1/Contact/abc123');
      expect(calledUrl).toContain('select=');
    });
  });

  // ─── Gemini Integration ────────────────────────────────────────────────

  describe('Gemini integration', () => {
    beforeEach(() => {
      // Setup successful contact lookup
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          firstName: 'Maria',
          lastName: 'Mc Menamin',
          emailAddress: 'maria@deltapartners.com',
          accountName: 'Delta Partners',
          cRole: 'Managing Partner',
        }),
      } as Response);
    });

    it('returns GEMINI_FAILED when geminiGenerateContent is not provided', async () => {
      const drafterNoGemini = new EmailDrafter('https://crm.example.com');
      const result = await drafterNoGemini.draft(validParams(), 'api-key');
      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('GEMINI_FAILED');
      }
    });

    it('returns GEMINI_FAILED when Gemini returns null', async () => {
      mockGemini.mockResolvedValueOnce(null);
      const result = await drafter.draft(validParams(), 'api-key');
      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('GEMINI_FAILED');
      }
    });

    it('returns GEMINI_FAILED when Gemini throws', async () => {
      mockGemini.mockRejectedValueOnce(new Error('Gemini unavailable'));
      const result = await drafter.draft(validParams(), 'api-key');
      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('GEMINI_FAILED');
      }
    });

    it('parses subject and body from Gemini response', async () => {
      mockGemini.mockResolvedValueOnce(
        'SUBJECT: Partnership Follow-up\nBODY:\nDear Maria,\n\nI wanted to follow up on our discussion.\n\nBest regards',
      );

      const result = await drafter.draft(validParams(), 'api-key');
      expect(isError(result)).toBe(false);
      if (!isError(result)) {
        expect(result.subject).toBe('Partnership Follow-up');
        expect(result.body).toContain('Dear Maria');
        expect(result.body).toContain('follow up');
      }
    });

    it('truncates subject to 100 chars', async () => {
      const longSubject = 'A'.repeat(150);
      mockGemini.mockResolvedValueOnce(`SUBJECT: ${longSubject}\nBODY:\nHello`);

      const result = await drafter.draft(validParams(), 'api-key');
      expect(isError(result)).toBe(false);
      if (!isError(result)) {
        expect(result.subject.length).toBeLessThanOrEqual(100);
      }
    });

    it('truncates body to 2000 chars', async () => {
      const longBody = 'B'.repeat(2500);
      mockGemini.mockResolvedValueOnce(`SUBJECT: Hi\nBODY:\n${longBody}`);

      const result = await drafter.draft(validParams(), 'api-key');
      expect(isError(result)).toBe(false);
      if (!isError(result)) {
        expect(result.body.length).toBeLessThanOrEqual(2000);
      }
    });

    it('includes recipient email in response', async () => {
      mockGemini.mockResolvedValueOnce('SUBJECT: Hi\nBODY:\nHello');

      const result = await drafter.draft(validParams(), 'api-key');
      expect(isError(result)).toBe(false);
      if (!isError(result)) {
        expect(result.recipientEmail).toBe('maria@deltapartners.com');
        expect(result.recipientName).toBe('Maria Mc Menamin');
      }
    });

    it('sets warning when contact has no email', async () => {
      mockFetch.mockReset();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          firstName: 'John',
          lastName: 'Doe',
          emailAddress: null,
          accountName: 'TestCo',
          cRole: 'CEO',
        }),
      } as Response);

      mockGemini.mockResolvedValueOnce('SUBJECT: Hi\nBODY:\nHello John');

      const result = await drafter.draft(validParams(), 'api-key');
      expect(isError(result)).toBe(false);
      if (!isError(result)) {
        expect(result.recipientEmail).toBeNull();
        expect(result.warning).toBe('No email address on record for this contact.');
      }
    });

    it('does not set warning when contact has email', async () => {
      mockGemini.mockResolvedValueOnce('SUBJECT: Hi\nBODY:\nHello');

      const result = await drafter.draft(validParams(), 'api-key');
      expect(isError(result)).toBe(false);
      if (!isError(result)) {
        expect(result.warning).toBeUndefined();
      }
    });
  });

  // ─── Response Parsing ──────────────────────────────────────────────────

  describe('parseGeminiResponse', () => {
    it('parses standard format correctly', () => {
      const result = drafter.parseGeminiResponse(
        'SUBJECT: Hello World\nBODY:\nThis is the body.',
      );
      expect(result.subject).toBe('Hello World');
      expect(result.body).toBe('This is the body.');
    });

    it('handles multiline body', () => {
      const result = drafter.parseGeminiResponse(
        'SUBJECT: Test\nBODY:\nLine 1\nLine 2\nLine 3',
      );
      expect(result.subject).toBe('Test');
      expect(result.body).toBe('Line 1\nLine 2\nLine 3');
    });

    it('falls back to "Follow-up" subject when not found', () => {
      const result = drafter.parseGeminiResponse('Just some text without markers');
      expect(result.subject).toBe('Follow-up');
    });

    it('handles case-insensitive markers', () => {
      const result = drafter.parseGeminiResponse(
        'subject: My Subject\nbody:\nMy body text',
      );
      expect(result.subject).toBe('My Subject');
      expect(result.body).toBe('My body text');
    });

    it('handles inline body after BODY: marker', () => {
      const result = drafter.parseGeminiResponse(
        'SUBJECT: Test\nBODY: Inline body content here',
      );
      expect(result.subject).toBe('Test');
      expect(result.body).toBe('Inline body content here');
    });
  });

  // ─── Never Sends Email ─────────────────────────────────────────────────

  describe('safety', () => {
    it('never makes POST/PUT/PATCH requests (no email sending)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          firstName: 'Maria',
          lastName: 'Test',
          emailAddress: 'maria@test.com',
          accountName: 'TestCo',
          cRole: 'Partner',
        }),
      } as Response);

      mockGemini.mockResolvedValueOnce('SUBJECT: Hi\nBODY:\nHello');

      await drafter.draft(validParams(), 'api-key');

      // All fetch calls should be GET (contact lookup only)
      for (const call of mockFetch.mock.calls) {
        const options = call[1] as RequestInit;
        expect(options.method).toBe('GET');
      }
    });
  });
});
