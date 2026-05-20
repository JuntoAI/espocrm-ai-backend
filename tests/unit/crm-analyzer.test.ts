/**
 * Unit tests for CrmAnalyzer paginated query helper, budget enforcement,
 * and error classification.
 *
 * Tests the paginatedQuery() method, checkBudget(), and fetchWithTimeout()
 * behavior using mocked fetch responses.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  CrmAnalyzer,
  CRM_ANALYZER_DEFAULTS,
  MAX_API_CALLS,
  BudgetExceededError,
  CrmApiError,
} from '../../src/services/crm-analyzer.js';
import type { CrmAnalyzerConfig } from '../../src/services/crm-analyzer.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

const TEST_API_KEY = 'test-api-key-123';
const TEST_BASE_URL = 'https://crm.example.com';

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

/** Generate N dummy records. */
function generateRecords(count: number, prefix = 'rec'): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    name: `Record ${i}`,
  }));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CrmAnalyzer - paginatedQuery', () => {
  let analyzer: CrmAnalyzer;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    analyzer = new CrmAnalyzer();
    originalFetch = globalThis.fetch;
    // Initialize budget trackers by calling analyze setup
    // We access paginatedQuery directly, so we need to manually init the budget
    (analyzer as unknown as { apiCallCount: number }).apiCallCount = 0;
    (analyzer as unknown as { totalStartTime: number }).totalStartTime = Date.now();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetches all records in a single page when count < maxSize', async () => {
    const records = generateRecords(50);
    globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(mockListResponse(records));

    const result = await analyzer.paginatedQuery(
      'Account',
      {},
      TEST_API_KEY,
      TEST_BASE_URL,
      CRM_ANALYZER_DEFAULTS,
    );

    expect(result).toHaveLength(50);
    expect(result[0]).toEqual({ id: 'rec-0', name: 'Record 0' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('paginates across multiple pages until fewer records than maxSize returned', async () => {
    const page1 = generateRecords(200, 'p1');
    const page2 = generateRecords(200, 'p2');
    const page3 = generateRecords(50, 'p3'); // Last page (< 200)

    const fetchMock = jest.fn<typeof fetch>()
      .mockResolvedValueOnce(mockListResponse(page1, 450))
      .mockResolvedValueOnce(mockListResponse(page2, 450))
      .mockResolvedValueOnce(mockListResponse(page3, 450));

    globalThis.fetch = fetchMock;

    const result = await analyzer.paginatedQuery(
      'Opportunity',
      {},
      TEST_API_KEY,
      TEST_BASE_URL,
      CRM_ANALYZER_DEFAULTS,
    );

    expect(result).toHaveLength(450);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(analyzer.getApiCallCount()).toBe(3);
  });

  it('caps maxSize at 200 even if config specifies higher', async () => {
    const records = generateRecords(100);
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(mockListResponse(records));
    globalThis.fetch = fetchMock;

    const config: CrmAnalyzerConfig = { ...CRM_ANALYZER_DEFAULTS, maxPageSize: 500 };

    await analyzer.paginatedQuery('Account', {}, TEST_API_KEY, TEST_BASE_URL, config);

    // Verify the URL contains maxSize=200 (capped)
    const calledUrl = (fetchMock.mock.calls[0] as [string])[0];
    expect(calledUrl).toContain('maxSize=200');
  });

  it('uses X-Api-Key header with the provided API key', async () => {
    globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(mockListResponse([]));

    await analyzer.paginatedQuery('Contact', {}, TEST_API_KEY, TEST_BASE_URL, CRM_ANALYZER_DEFAULTS);

    const callArgs = (globalThis.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers['X-Api-Key']).toBe(TEST_API_KEY);
  });

  it('builds correct URL with where clauses', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(mockListResponse([]));
    globalThis.fetch = fetchMock;

    await analyzer.paginatedQuery(
      'Opportunity',
      {
        where: [
          { type: 'before', attribute: 'closeDate', value: '2025-07-15' },
          { type: 'notIn', attribute: 'stage', value: ['Closed Won', 'Closed Lost'] },
        ],
        select: 'id,name,accountName,stage,closeDate',
        orderBy: 'closeDate',
        order: 'asc',
      },
      TEST_API_KEY,
      TEST_BASE_URL,
      CRM_ANALYZER_DEFAULTS,
    );

    const calledUrl = (fetchMock.mock.calls[0] as [string])[0];
    expect(calledUrl).toContain('/api/v1/Opportunity');
    expect(calledUrl).toContain('where%5B0%5D%5Btype%5D=before');
    expect(calledUrl).toContain('where%5B0%5D%5Battribute%5D=closeDate');
    expect(calledUrl).toContain('orderBy=closeDate');
    expect(calledUrl).toContain('order=asc');
    expect(calledUrl).toContain('select=id%2Cname%2CaccountName%2Cstage%2CcloseDate');
  });

  it('stops paginating when an empty list is returned', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(mockListResponse([]));
    globalThis.fetch = fetchMock;

    const result = await analyzer.paginatedQuery(
      'Meeting',
      {},
      TEST_API_KEY,
      TEST_BASE_URL,
      CRM_ANALYZER_DEFAULTS,
    );

    expect(result).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('CrmAnalyzer - budget enforcement', () => {
  let analyzer: CrmAnalyzer;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    analyzer = new CrmAnalyzer();
    originalFetch = globalThis.fetch;
    (analyzer as unknown as { apiCallCount: number }).apiCallCount = 0;
    (analyzer as unknown as { totalStartTime: number }).totalStartTime = Date.now();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('throws BudgetExceededError when API call count exceeds MAX_API_CALLS', async () => {
    // Set call count to the limit
    (analyzer as unknown as { apiCallCount: number }).apiCallCount = MAX_API_CALLS;

    globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(mockListResponse([]));

    await expect(
      analyzer.paginatedQuery('Account', {}, TEST_API_KEY, TEST_BASE_URL, CRM_ANALYZER_DEFAULTS),
    ).rejects.toThrow(BudgetExceededError);

    // fetch should NOT have been called since budget check happens first
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('throws BudgetExceededError with TIMEOUT code when total time exceeds totalTimeoutMs', async () => {
    // Set start time far in the past to simulate timeout
    (analyzer as unknown as { totalStartTime: number }).totalStartTime = Date.now() - 61_000;

    globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(mockListResponse([]));

    await expect(
      analyzer.paginatedQuery('Account', {}, TEST_API_KEY, TEST_BASE_URL, CRM_ANALYZER_DEFAULTS),
    ).rejects.toThrow(BudgetExceededError);

    try {
      await analyzer.paginatedQuery('Account', {}, TEST_API_KEY, TEST_BASE_URL, CRM_ANALYZER_DEFAULTS);
    } catch (err) {
      expect((err as BudgetExceededError).code).toBe('TIMEOUT');
    }
  });

  it('increments apiCallCount with each successful request', async () => {
    const page1 = generateRecords(200);
    const page2 = generateRecords(50);

    globalThis.fetch = jest.fn<typeof fetch>()
      .mockResolvedValueOnce(mockListResponse(page1))
      .mockResolvedValueOnce(mockListResponse(page2));

    await analyzer.paginatedQuery('Task', {}, TEST_API_KEY, TEST_BASE_URL, CRM_ANALYZER_DEFAULTS);

    expect(analyzer.getApiCallCount()).toBe(2);
  });

  it('aborts mid-pagination when budget is exceeded', async () => {
    // Set call count to 14 (one below limit)
    (analyzer as unknown as { apiCallCount: number }).apiCallCount = 14;

    // First page returns full 200 records (would trigger another page)
    const fullPage = generateRecords(200);
    globalThis.fetch = jest.fn<typeof fetch>()
      .mockResolvedValueOnce(mockListResponse(fullPage))
      .mockResolvedValueOnce(mockListResponse(fullPage));

    // After first call, count becomes 15, second call should fail budget check
    await expect(
      analyzer.paginatedQuery('Account', {}, TEST_API_KEY, TEST_BASE_URL, CRM_ANALYZER_DEFAULTS),
    ).rejects.toThrow(BudgetExceededError);

    // Only one fetch call should have been made
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('CrmAnalyzer - error classification', () => {
  let analyzer: CrmAnalyzer;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    analyzer = new CrmAnalyzer();
    originalFetch = globalThis.fetch;
    (analyzer as unknown as { apiCallCount: number }).apiCallCount = 0;
    (analyzer as unknown as { totalStartTime: number }).totalStartTime = Date.now();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('classifies 401 as AUTH_FAILED', async () => {
    globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(mockErrorResponse(401));

    await expect(
      analyzer.paginatedQuery('Account', {}, TEST_API_KEY, TEST_BASE_URL, CRM_ANALYZER_DEFAULTS),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('classifies 403 as AUTH_FAILED', async () => {
    globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(mockErrorResponse(403));

    await expect(
      analyzer.paginatedQuery('Account', {}, TEST_API_KEY, TEST_BASE_URL, CRM_ANALYZER_DEFAULTS),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('classifies 500 as SERVICE_UNAVAILABLE', async () => {
    globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(mockErrorResponse(500));

    await expect(
      analyzer.paginatedQuery('Account', {}, TEST_API_KEY, TEST_BASE_URL, CRM_ANALYZER_DEFAULTS),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('classifies 502 as SERVICE_UNAVAILABLE', async () => {
    globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(mockErrorResponse(502));

    await expect(
      analyzer.paginatedQuery('Account', {}, TEST_API_KEY, TEST_BASE_URL, CRM_ANALYZER_DEFAULTS),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('classifies 503 as SERVICE_UNAVAILABLE', async () => {
    globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(mockErrorResponse(503));

    await expect(
      analyzer.paginatedQuery('Account', {}, TEST_API_KEY, TEST_BASE_URL, CRM_ANALYZER_DEFAULTS),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('classifies network errors as CONNECTION_FAILED', async () => {
    globalThis.fetch = jest.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      analyzer.paginatedQuery('Account', {}, TEST_API_KEY, TEST_BASE_URL, CRM_ANALYZER_DEFAULTS),
    ).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
  });

  it('classifies AbortError (timeout) as TIMEOUT', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    globalThis.fetch = jest.fn<typeof fetch>().mockRejectedValue(abortError);

    await expect(
      analyzer.paginatedQuery('Account', {}, TEST_API_KEY, TEST_BASE_URL, CRM_ANALYZER_DEFAULTS),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('classifies 404 (non-auth client error) as CONNECTION_FAILED', async () => {
    globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(mockErrorResponse(404));

    await expect(
      analyzer.paginatedQuery('Account', {}, TEST_API_KEY, TEST_BASE_URL, CRM_ANALYZER_DEFAULTS),
    ).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
  });
});

describe('CrmAnalyzer - analyze() budget initialization', () => {
  it('resets apiCallCount and totalStartTime on each analyze() call', async () => {
    const analyzer = new CrmAnalyzer();

    // Manually set counters to non-zero
    (analyzer as unknown as { apiCallCount: number }).apiCallCount = 10;
    (analyzer as unknown as { totalStartTime: number }).totalStartTime = 1000;

    // analyze() will throw "Not implemented" but should reset counters first
    try {
      await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);
    } catch {
      // Expected: "Not implemented"
    }

    expect(analyzer.getApiCallCount()).toBe(0);
    // totalStartTime should be recent (within last second)
    const startTime = (analyzer as unknown as { totalStartTime: number }).totalStartTime;
    expect(Date.now() - startTime).toBeLessThan(1000);
  });
});
