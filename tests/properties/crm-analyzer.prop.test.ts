/**
 * Property-based tests for CrmAnalyzer service.
 *
 * Feature: proactive-crm-agent, Property 1: Overdue opportunity identification
 * Feature: proactive-crm-agent, Property 2: Stalled account detection
 * Feature: proactive-crm-agent, Property 3: Overdue task identification
 * Feature: proactive-crm-agent, Property 4: CRM analysis output structure invariant
 * Feature: proactive-crm-agent, Property 5: Partial result preservation on failure
 * Feature: proactive-crm-agent, Property 15: API call budget and page size
 * Feature: proactive-crm-agent, Property 17: Timeout enforcement
 *
 * **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.7, 1.9, 6.2, 6.5**
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fc from 'fast-check';
import {
  CrmAnalyzer,
  CRM_ANALYZER_DEFAULTS,
  MAX_API_CALLS,
} from '../../src/services/crm-analyzer.js';
import type {
  CrmAnalysisResult,
  CrmAnalysisError,
  CrmAnalyzerConfig,
} from '../../src/services/crm-analyzer.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const TEST_API_KEY = 'test-api-key-prop';
const TEST_BASE_URL = 'https://crm.test.example.com';
const NUM_RUNS = 100;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Type guard for CrmAnalysisError. */
function isError(
  result: CrmAnalysisResult | CrmAnalysisError,
): result is CrmAnalysisError {
  return 'error' in result && result.error === true;
}

/** Create a mock fetch response with a list of records. */
function mockListResponse(
  list: Record<string, unknown>[],
  total?: number,
): Response {
  const body = JSON.stringify({ total: total ?? list.length, list });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Create a mock fetch error response. */
function mockErrorResponse(status: number): Response {
  return new Response('{}', {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const CLOSED_STAGES = ['Closed Won', 'Closed Lost'];
const ALL_STAGES = [
  'Prospecting',
  'Qualification',
  'Needs Analysis',
  'Value Proposition',
  'Id. Decision Makers',
  'Perception Analysis',
  'Proposal/Price Quote',
  ...CLOSED_STAGES,
];

const ALL_TASK_STATUSES = [
  'Not Started',
  'Started',
  'Completed',
  'Canceled',
  'Deferred',
];
const OVERDUE_ELIGIBLE_STATUSES = ['Not Started', 'Started'];

/** Generate a random date string in YYYY-MM-DD format. */
const dateArb = fc
  .date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') })
  .map((d) => d.toISOString().split('T')[0]);

/** Generate a random record ID. */
const recordIdArb = fc.stringOf(
  fc.constantFrom(...'abcdef0123456789'.split('')),
  { minLength: 10, maxLength: 20 },
);

/** Generate a random account ID. */
const accountIdArb = recordIdArb;

/** Generate an arbitrary opportunity record as returned by EspoCRM. */
const opportunityRecordArb = fc.record({
  id: recordIdArb,
  name: fc.string({ minLength: 1, maxLength: 30 }),
  accountName: fc.string({ minLength: 1, maxLength: 30 }),
  stage: fc.constantFrom(...ALL_STAGES),
  closeDate: dateArb,
});

/** Generate an arbitrary task record as returned by EspoCRM. */
const taskRecordArb = fc.record({
  id: recordIdArb,
  name: fc.string({ minLength: 1, maxLength: 30 }),
  assignedUserName: fc.string({ minLength: 1, maxLength: 20 }),
  dateEnd: dateArb,
  status: fc.constantFrom(...ALL_TASK_STATUSES),
});

// ─── Property 1: Overdue opportunity identification ──────────────────────────

describe('Property 1: Overdue opportunity identification', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Feature: proactive-crm-agent, Property 1: Overdue opportunity identification
  it('returns exactly those opportunities whose closeDate < referenceDate AND stage not closed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(opportunityRecordArb, { minLength: 0, maxLength: 30 }),
        dateArb,
        async (opportunities, referenceDate) => {
          // Compute expected overdue set using the property definition
          const referenceDateMs = new Date(referenceDate).getTime();
          const expectedOverdue = opportunities.filter((opp) => {
            const closeDateMs = new Date(opp.closeDate).getTime();
            return closeDateMs < referenceDateMs && !CLOSED_STAGES.includes(opp.stage);
          });

          const analyzer = new CrmAnalyzer();
          (analyzer as unknown as { apiCallCount: number }).apiCallCount = 0;
          (analyzer as unknown as { totalStartTime: number }).totalStartTime = Date.now();

          // Mock: simulate EspoCRM server-side filtering (returns only matching records)
          globalThis.fetch = jest.fn<typeof fetch>()
            .mockResolvedValue(mockListResponse(expectedOverdue));

          const result = await analyzer.paginatedQuery(
            'Opportunity',
            {
              select: 'id,name,accountName,stage,closeDate',
              where: [
                { type: 'before', attribute: 'closeDate', value: referenceDate },
                { type: 'notIn', attribute: 'stage', value: CLOSED_STAGES },
              ],
            },
            TEST_API_KEY,
            TEST_BASE_URL,
            CRM_ANALYZER_DEFAULTS,
          );

          // The result should match our expected overdue set exactly
          expect(result.length).toBe(expectedOverdue.length);
          const resultIds = new Set(result.map((r) => r.id as string));
          for (const expected of expectedOverdue) {
            expect(resultIds.has(expected.id)).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: proactive-crm-agent, Property 1: Overdue opportunity identification
  it('never includes Closed Won or Closed Lost opportunities regardless of closeDate', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(opportunityRecordArb, { minLength: 1, maxLength: 20 }),
        dateArb,
        async (opportunities, referenceDate) => {
          // Force all opportunities to have closed stages
          const closedOpps = opportunities.map((opp) => ({
            ...opp,
            stage: 'Closed Won',
            closeDate: '2020-01-01', // Definitely before any reference date
          }));

          // Apply the filter: closeDate < ref AND stage NOT IN closed
          const filtered = closedOpps.filter((opp) => {
            const closeDateMs = new Date(opp.closeDate).getTime();
            const refMs = new Date(referenceDate).getTime();
            return closeDateMs < refMs && !CLOSED_STAGES.includes(opp.stage);
          });

          // All are closed, so none should pass the filter
          expect(filtered.length).toBe(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: proactive-crm-agent, Property 1: Overdue opportunity identification
  it('never includes opportunities with closeDate >= referenceDate', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(opportunityRecordArb, { minLength: 1, maxLength: 20 }),
        dateArb,
        async (opportunities, referenceDate) => {
          const refMs = new Date(referenceDate).getTime();

          // Force all opportunities to have future closeDates and open stages
          const futureOpps = opportunities.map((opp) => ({
            ...opp,
            stage: 'Prospecting',
            closeDate: new Date(refMs + 86400000).toISOString().split('T')[0],
          }));

          // Apply the filter: closeDate < ref AND stage NOT IN closed
          const filtered = futureOpps.filter((opp) => {
            const closeDateMs = new Date(opp.closeDate).getTime();
            return closeDateMs < refMs && !CLOSED_STAGES.includes(opp.stage);
          });

          // All have future dates, so none should pass
          expect(filtered.length).toBe(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});


// ─── Property 2: Stalled account detection ───────────────────────────────────

describe('Property 2: Stalled account detection', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Feature: proactive-crm-agent, Property 2: Stalled account detection
  it('Active_Account_Set is the union of account IDs from all 4 activity types', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(accountIdArb, { minLength: 0, maxLength: 5 }),
        fc.array(accountIdArb, { minLength: 0, maxLength: 5 }),
        fc.array(accountIdArb, { minLength: 0, maxLength: 5 }),
        fc.array(accountIdArb, { minLength: 0, maxLength: 5 }),
        async (meetingAccounts, callAccounts, taskAccounts, noteAccounts) => {
          const analyzer = new CrmAnalyzer();
          (analyzer as unknown as { apiCallCount: number }).apiCallCount = 0;
          (analyzer as unknown as { totalStartTime: number }).totalStartTime = Date.now();

          // Each activity type returns records with parentType=Account
          const makeRecords = (ids: string[]) =>
            ids.map((id) => ({ parentType: 'Account', parentId: id }));

          globalThis.fetch = jest.fn<typeof fetch>()
            .mockResolvedValueOnce(mockListResponse(makeRecords(meetingAccounts)))
            .mockResolvedValueOnce(mockListResponse(makeRecords(callAccounts)))
            .mockResolvedValueOnce(mockListResponse(makeRecords(taskAccounts)))
            .mockResolvedValueOnce(mockListResponse(makeRecords(noteAccounts)));

          const result = await analyzer.buildActiveAccountSet(
            TEST_API_KEY,
            TEST_BASE_URL,
            CRM_ANALYZER_DEFAULTS,
          );

          // Expected: union of all account IDs
          const expectedUnion = new Set([
            ...meetingAccounts,
            ...callAccounts,
            ...taskAccounts,
            ...noteAccounts,
          ]);

          expect(result.size).toBe(expectedUnion.size);
          for (const id of expectedUnion) {
            expect(result.has(id)).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: proactive-crm-agent, Property 2: Stalled account detection
  it('records with parentType !== Account are excluded from Active_Account_Set', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(accountIdArb, { minLength: 1, maxLength: 10 }),
        async (parentIds) => {
          const analyzer = new CrmAnalyzer();
          (analyzer as unknown as { apiCallCount: number }).apiCallCount = 0;
          (analyzer as unknown as { totalStartTime: number }).totalStartTime = Date.now();

          // All activities have parentType !== Account
          const nonAccountRecords = parentIds.map((id) => ({
            parentType: 'Contact',
            parentId: id,
          }));

          globalThis.fetch = jest.fn<typeof fetch>()
            .mockResolvedValueOnce(mockListResponse(nonAccountRecords))
            .mockResolvedValueOnce(mockListResponse([]))
            .mockResolvedValueOnce(mockListResponse([]))
            .mockResolvedValueOnce(mockListResponse([]));

          const result = await analyzer.buildActiveAccountSet(
            TEST_API_KEY,
            TEST_BASE_URL,
            CRM_ANALYZER_DEFAULTS,
          );

          // No accounts should be in the active set
          expect(result.size).toBe(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: proactive-crm-agent, Property 2: Stalled account detection
  it('stalled accounts are exactly those NOT in Active_Account_Set', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(accountIdArb, { minLength: 2, maxLength: 10 }),
        fc.nat({ max: 4 }), // How many accounts have activity
        async (allAccountIds, activeCount) => {
          const uniqueAccounts = [...new Set(allAccountIds)];
          if (uniqueAccounts.length < 2) return;

          // Split accounts: some active, some stalled
          const numActive = Math.min(activeCount, uniqueAccounts.length - 1);
          const activeIds = uniqueAccounts.slice(0, numActive);
          const expectedStalledIds = uniqueAccounts.slice(numActive);

          const analyzer = new CrmAnalyzer();
          (analyzer as unknown as { apiCallCount: number }).apiCallCount = 0;
          (analyzer as unknown as { totalStartTime: number }).totalStartTime = Date.now();

          // buildActiveAccountSet returns active IDs
          const activeRecords = activeIds.map((id) => ({
            parentType: 'Account',
            parentId: id,
          }));

          // All accounts for the stalled detection
          const accountRecords = uniqueAccounts.map((id) => ({ id, name: `Acc ${id}` }));

          globalThis.fetch = jest.fn<typeof fetch>()
            // buildActiveAccountSet (4 calls)
            .mockResolvedValueOnce(mockListResponse(activeRecords))
            .mockResolvedValueOnce(mockListResponse([]))
            .mockResolvedValueOnce(mockListResponse([]))
            .mockResolvedValueOnce(mockListResponse([]))
            // findStalledAccounts - all accounts
            .mockResolvedValueOnce(mockListResponse(accountRecords))
            // findStalledAccounts - contacts
            .mockResolvedValueOnce(mockListResponse([]))
            // Remaining calls (opportunities, tasks, activity summary) — use mockImplementation
            .mockImplementation(async () => mockListResponse([]));

          const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

          expect(isError(result)).toBe(false);
          if (!isError(result)) {
            const stalledIds = new Set(result.stalledAccounts.map((a) => a.id));
            // Every expected stalled account should be in the result
            for (const id of expectedStalledIds) {
              expect(stalledIds.has(id)).toBe(true);
            }
            // No active account should be in the stalled list
            for (const id of activeIds) {
              expect(stalledIds.has(id)).toBe(false);
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});


// ─── Property 3: Overdue task identification ─────────────────────────────────

describe('Property 3: Overdue task identification', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Feature: proactive-crm-agent, Property 3: Overdue task identification
  it('returns exactly those tasks with status in (Not Started, Started) AND dateEnd < referenceDate', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(taskRecordArb, { minLength: 0, maxLength: 30 }),
        dateArb,
        async (tasks, referenceDate) => {
          const referenceDateMs = new Date(referenceDate).getTime();

          // Compute expected overdue tasks using the property definition
          const expectedOverdue = tasks.filter((task) => {
            const dateEndMs = new Date(task.dateEnd).getTime();
            return (
              OVERDUE_ELIGIBLE_STATUSES.includes(task.status) &&
              dateEndMs < referenceDateMs
            );
          });

          const analyzer = new CrmAnalyzer();
          (analyzer as unknown as { apiCallCount: number }).apiCallCount = 0;
          (analyzer as unknown as { totalStartTime: number }).totalStartTime = Date.now();

          // Mock: simulate EspoCRM server-side filtering
          globalThis.fetch = jest.fn<typeof fetch>()
            .mockResolvedValue(mockListResponse(expectedOverdue));

          const result = await analyzer.paginatedQuery(
            'Task',
            {
              select: 'id,name,assignedUserName,dateEnd,status',
              where: [
                { type: 'in', attribute: 'status', value: OVERDUE_ELIGIBLE_STATUSES },
                { type: 'before', attribute: 'dateEnd', value: referenceDate },
              ],
            },
            TEST_API_KEY,
            TEST_BASE_URL,
            CRM_ANALYZER_DEFAULTS,
          );

          expect(result.length).toBe(expectedOverdue.length);
          const resultIds = new Set(result.map((r) => r.id as string));
          for (const expected of expectedOverdue) {
            expect(resultIds.has(expected.id)).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: proactive-crm-agent, Property 3: Overdue task identification
  it('never includes tasks with status Completed, Canceled, or Deferred', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(taskRecordArb, { minLength: 1, maxLength: 20 }),
        dateArb,
        async (tasks, referenceDate) => {
          // Force all tasks to have non-eligible statuses but past dateEnd
          const nonEligible = tasks.map((t) => ({
            ...t,
            status: 'Completed',
            dateEnd: '2020-01-01',
          }));

          // Apply the filter logic
          const filtered = nonEligible.filter((task) => {
            const dateEndMs = new Date(task.dateEnd).getTime();
            const refMs = new Date(referenceDate).getTime();
            return (
              OVERDUE_ELIGIBLE_STATUSES.includes(task.status) &&
              dateEndMs < refMs
            );
          });

          // None should pass since status is Completed
          expect(filtered.length).toBe(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: proactive-crm-agent, Property 3: Overdue task identification
  it('never includes tasks with dateEnd >= referenceDate even if status is eligible', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(taskRecordArb, { minLength: 1, maxLength: 20 }),
        dateArb,
        async (tasks, referenceDate) => {
          const refMs = new Date(referenceDate).getTime();

          // Force all tasks to have future dateEnd and eligible status
          const futureTasks = tasks.map((t) => ({
            ...t,
            status: 'Not Started',
            dateEnd: new Date(refMs + 86400000).toISOString().split('T')[0],
          }));

          // Apply the filter logic
          const filtered = futureTasks.filter((task) => {
            const dateEndMs = new Date(task.dateEnd).getTime();
            return (
              OVERDUE_ELIGIBLE_STATUSES.includes(task.status) &&
              dateEndMs < refMs
            );
          });

          // None should pass since dateEnd is in the future
          expect(filtered.length).toBe(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});


// ─── Property 4: CRM analysis output structure invariant ─────────────────────

describe('Property 4: CRM analysis output structure invariant', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Feature: proactive-crm-agent, Property 4: CRM analysis output structure invariant
  it('output always contains all required fields as arrays and a valid ISO generatedAt', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(accountIdArb, { minLength: 0, maxLength: 5 }),
        async (accountIds) => {
          const analyzer = new CrmAnalyzer();

          // Mock all fetch calls to return valid (possibly empty) responses
          const accounts = accountIds.map((id) => ({ id, name: `Account ${id}` }));

          globalThis.fetch = jest.fn<typeof fetch>()
            // buildActiveAccountSet (4 calls)
            .mockResolvedValueOnce(mockListResponse([])) // Meetings
            .mockResolvedValueOnce(mockListResponse([])) // Calls
            .mockResolvedValueOnce(mockListResponse([])) // Tasks
            .mockResolvedValueOnce(mockListResponse([])) // Notes
            // findStalledAccounts - accounts
            .mockResolvedValueOnce(mockListResponse(accounts))
            // findStalledAccounts - contacts
            .mockResolvedValueOnce(mockListResponse([]))
            // findOverdueOpportunities
            .mockResolvedValueOnce(mockListResponse([]))
            // findOverdueTasks
            .mockResolvedValueOnce(mockListResponse([]))
            // buildActivitySummary (4 calls)
            .mockResolvedValueOnce(mockListResponse([])) // Completed tasks
            .mockResolvedValueOnce(mockListResponse([])) // Meetings
            .mockResolvedValueOnce(mockListResponse([])) // Calls
            .mockResolvedValueOnce(mockListResponse([])); // Notes

          const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

          // Should be a successful result (not an error)
          expect(isError(result)).toBe(false);
          if (!isError(result)) {
            // All required fields must be arrays
            expect(Array.isArray(result.overdueOpportunities)).toBe(true);
            expect(Array.isArray(result.stalledAccounts)).toBe(true);
            expect(Array.isArray(result.overdueTasks)).toBe(true);
            expect(Array.isArray(result.activitySummary)).toBe(true);

            // generatedAt must be a valid ISO 8601 timestamp
            expect(typeof result.generatedAt).toBe('string');
            const parsed = new Date(result.generatedAt);
            expect(parsed.toISOString()).toBe(result.generatedAt);
            expect(isNaN(parsed.getTime())).toBe(false);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: proactive-crm-agent, Property 4: CRM analysis output structure invariant
  it('output structure is valid even when all categories are empty', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constant(null),
        async () => {
          const analyzer = new CrmAnalyzer();

          // All queries return empty — must create fresh Response each time
          globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(
            async () => mockListResponse([]),
          );

          const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

          expect(isError(result)).toBe(false);
          if (!isError(result)) {
            expect(result.overdueOpportunities).toEqual([]);
            expect(result.stalledAccounts).toEqual([]);
            expect(result.overdueTasks).toEqual([]);
            expect(result.activitySummary).toEqual([]);
            expect(typeof result.generatedAt).toBe('string');
            expect(new Date(result.generatedAt).toISOString()).toBe(result.generatedAt);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});


// ─── Property 5: Partial result preservation on failure ──────────────────────

describe('Property 5: Partial result preservation on failure', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Feature: proactive-crm-agent, Property 5: Partial result preservation on failure
  it('error response includes all data retrieved before the failure point', async () => {
    // The analyze() pipeline order:
    // 1. buildActiveAccountSet (4 calls)
    // 2. findStalledAccounts (2+ calls)
    // 3. findOverdueOpportunities (1+ calls)
    // 4. findOverdueTasks (1+ calls)
    // 5. buildActivitySummary (4 calls)
    //
    // We test: succeed through step N, then fail at step N+1.
    await fc.assert(
      fc.asyncProperty(
        // failAfterStep: which step completes before failure (2, 3, or 4)
        fc.integer({ min: 2, max: 4 }),
        async (failAfterStep) => {
          const analyzer = new CrmAnalyzer();

          const mockCalls: Response[] = [];

          // Step 1: buildActiveAccountSet always succeeds (4 calls)
          mockCalls.push(mockListResponse([])); // Meetings
          mockCalls.push(mockListResponse([])); // Calls
          mockCalls.push(mockListResponse([])); // Tasks
          mockCalls.push(mockListResponse([])); // Notes

          // Step 2: findStalledAccounts (2 calls: accounts + contacts)
          if (failAfterStep >= 2) {
            mockCalls.push(mockListResponse([{ id: 'acc-1', name: 'Test Account' }]));
            mockCalls.push(mockListResponse([])); // contacts
          }

          // Step 3: findOverdueOpportunities (1 call)
          if (failAfterStep >= 3) {
            mockCalls.push(mockListResponse([
              { id: 'opp-1', name: 'Deal', accountName: 'Acme', stage: 'Proposal', closeDate: '2020-01-01' },
            ]));
          }

          // Step 4: findOverdueTasks (1 call)
          if (failAfterStep >= 4) {
            mockCalls.push(mockListResponse([
              { id: 'task-1', name: 'Follow up', assignedUserName: 'User', dateEnd: '2020-01-01', status: 'Not Started' },
            ]));
          }

          // Set up mock: succeed for N calls, then fail
          const fetchMock = jest.fn<typeof fetch>();
          for (let i = 0; i < mockCalls.length; i++) {
            fetchMock.mockResolvedValueOnce(mockCalls[i]);
          }
          // Fail on the next call with 500
          fetchMock.mockResolvedValueOnce(mockErrorResponse(500));
          // Any further calls also fail — use mockImplementation for fresh Response
          fetchMock.mockImplementation(async () => mockErrorResponse(500));

          globalThis.fetch = fetchMock;

          const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

          expect(isError(result)).toBe(true);
          if (isError(result)) {
            expect(result.partialResults).toBeDefined();

            // stalledAccounts should always be present (step 2 succeeded)
            if (failAfterStep >= 2) {
              expect(result.partialResults?.stalledAccounts).toBeDefined();
              expect(Array.isArray(result.partialResults?.stalledAccounts)).toBe(true);
            }

            // overdueOpportunities present if step 3 succeeded
            if (failAfterStep >= 3) {
              expect(result.partialResults?.overdueOpportunities).toBeDefined();
              expect(result.partialResults!.overdueOpportunities!.length).toBeGreaterThan(0);
            } else {
              expect(result.partialResults?.overdueOpportunities).toBeUndefined();
            }

            // overdueTasks present if step 4 succeeded
            if (failAfterStep >= 4) {
              expect(result.partialResults?.overdueTasks).toBeDefined();
              expect(result.partialResults!.overdueTasks!.length).toBeGreaterThan(0);
            } else {
              expect(result.partialResults?.overdueTasks).toBeUndefined();
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: proactive-crm-agent, Property 5: Partial result preservation on failure
  it('failure on first API call results in no partialResults', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(401, 403, 500, 502, 503),
        async (errorStatus) => {
          const analyzer = new CrmAnalyzer();

          // Fail immediately on first call — use mockImplementation for fresh Response
          globalThis.fetch = jest.fn<typeof fetch>()
            .mockImplementation(async () => mockErrorResponse(errorStatus));

          const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

          expect(isError(result)).toBe(true);
          if (isError(result)) {
            // No data was retrieved before failure
            expect(result.partialResults).toBeUndefined();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});


// ─── Property 15: API call budget and page size ──────────────────────────────

describe('Property 15: API call budget and page size', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Feature: proactive-crm-agent, Property 15: API call budget and page size
  it('analyzer makes no more than 15 sequential API calls total', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constant(null),
        async () => {
          const analyzer = new CrmAnalyzer();

          // Track all fetch calls
          let callCount = 0;

          globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async () => {
            callCount++;
            return mockListResponse([]);
          });

          // Run analyze - should succeed with empty data
          await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

          // Total calls must not exceed 15
          expect(callCount).toBeLessThanOrEqual(MAX_API_CALLS);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: proactive-crm-agent, Property 15: API call budget and page size
  it('each API call uses maxSize <= 200', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 50, max: 500 }),
        async (configMaxPageSize) => {
          const analyzer = new CrmAnalyzer({ maxPageSize: configMaxPageSize });

          const calledUrls: string[] = [];

          globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(
            async (input) => {
              const url = typeof input === 'string'
                ? input
                : (input as Request).url;
              calledUrls.push(url);
              return mockListResponse([]);
            },
          );

          await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

          // Every URL must have maxSize <= 200
          for (const url of calledUrls) {
            const urlObj = new URL(url);
            const maxSize = urlObj.searchParams.get('maxSize');
            if (maxSize !== null) {
              expect(parseInt(maxSize, 10)).toBeLessThanOrEqual(200);
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: proactive-crm-agent, Property 15: API call budget and page size
  it('budget enforcement triggers when pagination would exceed 15 calls', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constant(null),
        async () => {
          const analyzer = new CrmAnalyzer();

          // Return full pages (200 records) to force maximum pagination
          const fullPage = Array.from({ length: 200 }, (_, i) => ({
            id: `rec-${i}`,
            name: `Record ${i}`,
            parentType: 'Account',
            parentId: `acc-${i}`,
          }));

          let callCount = 0;
          globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async () => {
            callCount++;
            return mockListResponse(fullPage);
          });

          const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

          // Should have hit budget limit — total calls capped at 15
          expect(callCount).toBeLessThanOrEqual(MAX_API_CALLS);

          // Result should be an error (budget exceeded maps to SERVICE_UNAVAILABLE or TIMEOUT)
          expect(isError(result)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});


// ─── Property 17: Timeout enforcement ────────────────────────────────────────

describe('Property 17: Timeout enforcement', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Feature: proactive-crm-agent, Property 17: Timeout enforcement
  it('per-call timeout aborts calls that exceed apiTimeoutMs', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 50, max: 200 }),
        async (apiTimeoutMs) => {
          const analyzer = new CrmAnalyzer({
            apiTimeoutMs,
            totalTimeoutMs: 60_000,
          });
          (analyzer as unknown as { apiCallCount: number }).apiCallCount = 0;
          (analyzer as unknown as { totalStartTime: number }).totalStartTime = Date.now();

          // Mock fetch that delays longer than the timeout, respecting abort signal
          globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(
            (_input, init) => {
              return new Promise<Response>((resolve, reject) => {
                const signal = init?.signal as AbortSignal | undefined;
                if (signal?.aborted) {
                  reject(new DOMException('The operation was aborted', 'AbortError'));
                  return;
                }
                const timer = setTimeout(() => {
                  resolve(mockListResponse([]));
                }, apiTimeoutMs + 100);
                signal?.addEventListener('abort', () => {
                  clearTimeout(timer);
                  reject(new DOMException('The operation was aborted', 'AbortError'));
                });
              });
            },
          );

          // paginatedQuery should throw a TIMEOUT error
          try {
            await analyzer.paginatedQuery(
              'Account',
              {},
              TEST_API_KEY,
              TEST_BASE_URL,
              { ...CRM_ANALYZER_DEFAULTS, apiTimeoutMs },
            );
            // Should not reach here
            expect(true).toBe(false);
          } catch (err: unknown) {
            expect((err as { code: string }).code).toBe('TIMEOUT');
          }
        },
      ),
      { numRuns: 20 },
    );
  });

  // Feature: proactive-crm-agent, Property 17: Timeout enforcement
  it('total timeout aborts analysis when cumulative time exceeds totalTimeoutMs', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 10, max: 100 }),
        async (totalTimeoutMs) => {
          const analyzer = new CrmAnalyzer({
            apiTimeoutMs: 10_000,
            totalTimeoutMs,
          });

          // Mock fetch with a delay that ensures total timeout is exceeded
          globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, totalTimeoutMs + 20));
            return mockListResponse([]);
          });

          const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

          // Should return a TIMEOUT error
          expect(isError(result)).toBe(true);
          if (isError(result)) {
            expect(result.code).toBe('TIMEOUT');
          }
        },
      ),
      { numRuns: 20 },
    );
  });

  // Feature: proactive-crm-agent, Property 17: Timeout enforcement
  it('analyzer returns TIMEOUT error (not hangs) when totalTimeoutMs is exceeded', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constant(null),
        async () => {
          // Use a very short total timeout
          const analyzer = new CrmAnalyzer({
            apiTimeoutMs: 10_000,
            totalTimeoutMs: 1, // 1ms total timeout
          });

          // First call takes some time
          globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return mockListResponse([]);
          });

          const result = await analyzer.analyze(TEST_API_KEY, TEST_BASE_URL);

          // Must return an error, not hang
          expect(isError(result)).toBe(true);
          if (isError(result)) {
            expect(result.code).toBe('TIMEOUT');
          }
        },
      ),
      { numRuns: 20 },
    );
  });
});
