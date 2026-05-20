/**
 * Unit tests for CrmAnalyzer error handling and analyze() orchestration.
 *
 * Validates:
 * - Requirements 1.8: AUTH_FAILED on 401/403
 * - Requirements 1.9: SERVICE_UNAVAILABLE with partial results on 5xx/timeout
 * - Requirements 1.10: CONNECTION_FAILED on network errors
 * - Requirements 6.6: No internal details leak in error messages
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  CrmAnalyzer,
  CRM_ANALYZER_DEFAULTS,
  CrmApiError,
  BudgetExceededError,
} from '../../src/services/crm-analyzer.js';
import type {
  CrmAnalysisError,
  CrmAnalysisResult,
  CrmAnalyzerConfig,
} from '../../src/services/crm-analyzer.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

const TEST_API_KEY = 'test-api-key-secret-123';
const TEST_BASE_URL = 'https://crm.internal.example.com';

/** Create a mock fetch response with a list of records. */
function mockListResponse(list: Record<string, unknown>[], total?: number): Response {
  const body = JSON.stringify({ total: total ?? list.length, list });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Create a mock fetch error response. */
function mockErrorResponse(status: number, body = '{}'): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Type guard for CrmAnalysisError. */
function isError(result: CrmAnalysisResult | CrmAnalysisError): result is CrmAnalysisError {
  return 'error' in result && result.error === true;
}

// ─── Tests: analyze() error handling ─────────────────────────────────────────

describe('CrmAnalyzer - analyze() error handling', () => {
  let analyzer: CrmAnalyzer;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    analyzer = new CrmAnalyzer();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('AUTH_FAILED (401/403)', () => {
    it('returns AUTH_FAILED immediately on 401 response', async () => {
      globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(mockErrorResponse(401));

      const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('AUTH_FAILED');
        expect(result.error).toBe(true);
      }
    });

    it('returns AUTH_FAILED immediately on 403 response', async () => {
      globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(mockErrorResponse(403));

      const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('AUTH_FAILED');
      }
    });

    it('does not leak API key in AUTH_FAILED error message', async () => {
      globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(mockErrorResponse(401));

      const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.message).not.toContain(TEST_API_KEY);
        expect(result.message).not.toContain('test-api-key');
      }
    });

    it('does not leak base URL in AUTH_FAILED error message', async () => {
      globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(mockErrorResponse(401));

      const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.message).not.toContain(TEST_BASE_URL);
        expect(result.message).not.toContain('crm.internal');
      }
    });
  });

  describe('SERVICE_UNAVAILABLE (5xx)', () => {
    it('returns SERVICE_UNAVAILABLE on 500 response', async () => {
      // First 4 calls succeed (buildActiveAccountSet), then 500 on stalled accounts query
      const fetchMock = jest.fn<typeof fetch>()
        .mockResolvedValueOnce(mockListResponse([])) // Meetings
        .mockResolvedValueOnce(mockListResponse([])) // Calls
        .mockResolvedValueOnce(mockListResponse([])) // Tasks
        .mockResolvedValueOnce(mockListResponse([])) // Notes
        .mockResolvedValueOnce(mockErrorResponse(500)); // Account fetch fails

      globalThis.fetch = fetchMock;

      const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('SERVICE_UNAVAILABLE');
      }
    });

    it('returns SERVICE_UNAVAILABLE on 503 response', async () => {
      globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(mockErrorResponse(503));

      const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('SERVICE_UNAVAILABLE');
      }
    });
  });

  describe('CONNECTION_FAILED (network errors)', () => {
    it('returns CONNECTION_FAILED on network error', async () => {
      globalThis.fetch = jest.fn<typeof fetch>().mockRejectedValue(
        new TypeError('fetch failed: ECONNREFUSED'),
      );

      const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('CONNECTION_FAILED');
      }
    });

    it('does not leak internal error details in CONNECTION_FAILED message', async () => {
      globalThis.fetch = jest.fn<typeof fetch>().mockRejectedValue(
        new TypeError('fetch failed: ECONNREFUSED 192.168.1.100:443'),
      );

      const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.message).not.toContain('ECONNREFUSED');
        expect(result.message).not.toContain('192.168');
        expect(result.message).not.toContain('443');
      }
    });
  });

  describe('TIMEOUT', () => {
    it('returns TIMEOUT on AbortError (per-call timeout)', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      globalThis.fetch = jest.fn<typeof fetch>().mockRejectedValue(abortError);

      const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('TIMEOUT');
      }
    });

    it('returns TIMEOUT when total analysis time exceeds totalTimeoutMs', async () => {
      // Use a very short total timeout to trigger budget exceeded
      const shortConfig: Partial<CrmAnalyzerConfig> = { totalTimeoutMs: 1 };

      // Add a small delay to ensure timeout triggers
      globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return mockListResponse([]);
      });

      const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL, shortConfig);

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('TIMEOUT');
      }
    });
  });

  describe('Partial results preservation', () => {
    it('preserves stalledAccounts when failure occurs after stalled detection', async () => {
      const fetchMock = jest.fn<typeof fetch>()
        // buildActiveAccountSet (4 calls - all return empty)
        .mockResolvedValueOnce(mockListResponse([])) // Meetings
        .mockResolvedValueOnce(mockListResponse([])) // Calls
        .mockResolvedValueOnce(mockListResponse([])) // Tasks
        .mockResolvedValueOnce(mockListResponse([])) // Notes
        // findStalledAccounts - accounts query returns 1 account
        .mockResolvedValueOnce(mockListResponse([{ id: 'acc-1', name: 'Stalled Corp' }]))
        // findStalledAccounts - contacts query
        .mockResolvedValueOnce(mockListResponse([]))
        // findOverdueOpportunities - fails with 500
        .mockResolvedValueOnce(mockErrorResponse(500));

      globalThis.fetch = fetchMock;

      const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('SERVICE_UNAVAILABLE');
        expect(result.partialResults).toBeDefined();
        expect(result.partialResults?.stalledAccounts).toBeDefined();
        expect(result.partialResults!.stalledAccounts!.length).toBe(1);
        expect(result.partialResults!.stalledAccounts![0].name).toBe('Stalled Corp');
      }
    });

    it('preserves multiple partial results when failure occurs late in the pipeline', async () => {
      const today = new Date().toISOString().split('T')[0];
      const pastDate = '2025-01-01';

      const fetchMock = jest.fn<typeof fetch>()
        // buildActiveAccountSet (4 calls)
        .mockResolvedValueOnce(mockListResponse([])) // Meetings
        .mockResolvedValueOnce(mockListResponse([])) // Calls
        .mockResolvedValueOnce(mockListResponse([])) // Tasks
        .mockResolvedValueOnce(mockListResponse([])) // Notes
        // findStalledAccounts - no accounts
        .mockResolvedValueOnce(mockListResponse([]))
        // findOverdueOpportunities - returns 1 opportunity
        .mockResolvedValueOnce(mockListResponse([
          { id: 'opp-1', name: 'Big Deal', accountName: 'Acme', stage: 'Proposal', closeDate: pastDate },
        ]))
        // findOverdueTasks - returns 1 task
        .mockResolvedValueOnce(mockListResponse([
          { id: 'task-1', name: 'Follow up', assignedUserName: 'Markus', dateEnd: pastDate, status: 'Not Started' },
        ]))
        // buildActivitySummary - fails with network error
        .mockRejectedValueOnce(new TypeError('fetch failed'));

      globalThis.fetch = fetchMock;

      const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.partialResults).toBeDefined();
        expect(result.partialResults?.stalledAccounts).toEqual([]);
        expect(result.partialResults?.overdueOpportunities).toHaveLength(1);
        expect(result.partialResults?.overdueTasks).toHaveLength(1);
        // activitySummary should NOT be present (failed before completion)
        expect(result.partialResults?.activitySummary).toBeUndefined();
      }
    });

    it('returns no partialResults when failure occurs on first API call', async () => {
      globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(mockErrorResponse(401));

      const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        // No data was retrieved before the failure
        expect(result.partialResults).toBeUndefined();
      }
    });
  });

  describe('Sanitized error messages', () => {
    it('AUTH_FAILED message is user-friendly', async () => {
      globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(mockErrorResponse(401));

      const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.message).toBe('Unable to access CRM data. Please check your API key permissions.');
      }
    });

    it('SERVICE_UNAVAILABLE message is user-friendly', async () => {
      globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(mockErrorResponse(500));

      const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.message).toBe('CRM service is temporarily unavailable. Please try again later.');
      }
    });

    it('CONNECTION_FAILED message is user-friendly', async () => {
      globalThis.fetch = jest.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));

      const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.message).toBe('Unable to connect to CRM. Please check your network connection.');
      }
    });

    it('TIMEOUT message is user-friendly', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      globalThis.fetch = jest.fn<typeof fetch>().mockRejectedValue(abortError);

      const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.message).toBe('CRM data retrieval timed out. Please try again.');
      }
    });

    it('no error message contains stack traces', async () => {
      const errorWithStack = new Error('Something went wrong');
      errorWithStack.stack = 'Error: Something went wrong\n    at CrmAnalyzer.analyze (src/services/crm-analyzer.ts:42:11)';
      globalThis.fetch = jest.fn<typeof fetch>().mockRejectedValue(errorWithStack);

      const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.message).not.toContain('at CrmAnalyzer');
        expect(result.message).not.toContain('.ts:');
        expect(result.message).not.toContain('src/services');
      }
    });

    it('unknown errors produce CONNECTION_FAILED with safe message', async () => {
      // Throw something that's not an Error instance — fetchWithTimeout classifies
      // all non-CrmApiError/non-AbortError exceptions as CONNECTION_FAILED
      globalThis.fetch = jest.fn<typeof fetch>().mockRejectedValue('raw string error');

      const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.code).toBe('CONNECTION_FAILED');
        expect(result.message).toBe('Unable to connect to CRM. Please check your network connection.');
        // Ensure the raw error string doesn't leak
        expect(result.message).not.toContain('raw string error');
      }
    });
  });

  describe('Successful analysis (happy path)', () => {
    it('returns complete CrmAnalysisResult when all queries succeed', async () => {
      const fetchMock = jest.fn<typeof fetch>()
        // buildActiveAccountSet (4 calls)
        .mockResolvedValueOnce(mockListResponse([])) // Meetings
        .mockResolvedValueOnce(mockListResponse([])) // Calls
        .mockResolvedValueOnce(mockListResponse([])) // Tasks
        .mockResolvedValueOnce(mockListResponse([])) // Notes
        // findStalledAccounts - no accounts
        .mockResolvedValueOnce(mockListResponse([]))
        // findOverdueOpportunities - empty
        .mockResolvedValueOnce(mockListResponse([]))
        // findOverdueTasks - empty
        .mockResolvedValueOnce(mockListResponse([]))
        // buildActivitySummary (4 calls)
        .mockResolvedValueOnce(mockListResponse([])) // Completed tasks
        .mockResolvedValueOnce(mockListResponse([])) // Meetings
        .mockResolvedValueOnce(mockListResponse([])) // Calls
        .mockResolvedValueOnce(mockListResponse([])); // Notes

      globalThis.fetch = fetchMock;

      const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

      expect(isError(result)).toBe(false);
      if (!isError(result)) {
        expect(result.overdueOpportunities).toEqual([]);
        expect(result.stalledAccounts).toEqual([]);
        expect(result.overdueTasks).toEqual([]);
        expect(result.activitySummary).toEqual([]);
        expect(result.generatedAt).toBeDefined();
        // Verify generatedAt is a valid ISO timestamp
        expect(new Date(result.generatedAt).toISOString()).toBe(result.generatedAt);
      }
    });
  });
});
