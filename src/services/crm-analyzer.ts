/**
 * Deterministic CRM state analysis service.
 *
 * Queries EspoCRM REST API using a user's API key, identifies overdue
 * opportunities, stalled accounts, overdue tasks, and aggregates recent
 * activity — returning structured JSON with no AI involvement.
 *
 * @module crm-analyzer
 */

// ─── Configuration ───────────────────────────────────────────────────────────

/** Configuration for the CRM analysis process. */
export interface CrmAnalyzerConfig {
  /** Number of days to look back for recent activity summary. Default: 7. */
  activityWindowDays: number;
  /** Days without activity before an account is considered stalled. Default: 14. */
  engagementDecayDays: number;
  /** Timeout in ms for each individual EspoCRM API call. Default: 10 000. */
  apiTimeoutMs: number;
  /** Total timeout in ms for the entire analysis process. Default: 60 000. */
  totalTimeoutMs: number;
  /** Maximum records per paginated API request. Default: 200. */
  maxPageSize: number;
}

/** Default configuration values. */
export const CRM_ANALYZER_DEFAULTS: Readonly<CrmAnalyzerConfig> = {
  activityWindowDays: 7,
  engagementDecayDays: 14,
  apiTimeoutMs: 10_000,
  totalTimeoutMs: 60_000,
  maxPageSize: 200,
};

/** Maximum sequential API calls allowed per analysis run. */
export const MAX_API_CALLS = 15;

// ─── Result Types ────────────────────────────────────────────────────────────

/** An opportunity whose close date has passed without being closed. */
export interface OverdueOpportunity {
  id: string;
  name: string;
  accountName: string;
  stage: string;
  closeDate: string;
  daysOverdue: number;
}

/** An account with no recent activity within the engagement decay window. */
export interface StalledAccount {
  id: string;
  name: string;
  lastActivityDate: string | null;
  contactCount: number;
  daysSinceActivity: number;
}

/** A task that is past its due date and not yet completed or cancelled. */
export interface OverdueTask {
  id: string;
  name: string;
  assigneeName: string;
  dateEnd: string;
  daysOverdue: number;
}

/** Daily activity counts for a single date within the activity window. */
export interface ActivitySummary {
  date: string;
  calls: number;
  meetings: number;
  tasksCompleted: number;
  notesPosted: number;
}

/** Structured output of a successful CRM analysis. */
export interface CrmAnalysisResult {
  overdueOpportunities: OverdueOpportunity[];
  stalledAccounts: StalledAccount[];
  overdueTasks: OverdueTask[];
  activitySummary: ActivitySummary[];
  /** ISO 8601 timestamp of when the analysis was generated. */
  generatedAt: string;
}

// ─── Error Types ─────────────────────────────────────────────────────────────

/** Error codes returned when CRM analysis fails. */
export type CrmAnalysisErrorCode =
  | 'AUTH_FAILED'
  | 'SERVICE_UNAVAILABLE'
  | 'CONNECTION_FAILED'
  | 'TIMEOUT';

/** Structured error returned when CRM analysis cannot complete. */
export interface CrmAnalysisError {
  error: true;
  code: CrmAnalysisErrorCode;
  message: string;
  /** Any data successfully retrieved before the failure occurred. */
  partialResults?: Partial<CrmAnalysisResult>;
}

// ─── Internal Types ──────────────────────────────────────────────────────────

/** Query parameters for EspoCRM REST API list endpoints. */
export interface EspoQueryParams {
  maxSize?: number;
  offset?: number;
  orderBy?: string;
  order?: 'asc' | 'desc';
  select?: string;
  where?: EspoWhereClause[];
}

/** A single where clause for EspoCRM REST API filtering. */
export interface EspoWhereClause {
  type: string;
  attribute?: string;
  value?: string | string[] | number | boolean;
  field?: string;
}

/** Raw response shape from EspoCRM list endpoints. */
export interface EspoListResponse {
  total: number;
  list: Record<string, unknown>[];
}

// ─── Budget Error ────────────────────────────────────────────────────────────

/** Thrown internally when API call budget or total timeout is exceeded. */
export class BudgetExceededError extends Error {
  constructor(
    message: string,
    public readonly code: CrmAnalysisErrorCode,
  ) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

// ─── Service Class ───────────────────────────────────────────────────────────

/**
 * Deterministic CRM state analyzer.
 *
 * Makes paginated REST API calls to EspoCRM using the requesting user's
 * API key (ACL enforcement). Identifies overdue opportunities, stalled
 * accounts, overdue tasks, and aggregates recent activity into a
 * structured result.
 *
 * Runs within the existing AI Backend Node.js process — no new containers.
 */
export class CrmAnalyzer {
  private readonly config: CrmAnalyzerConfig;

  /** Sequential API call counter for the current analysis run. */
  private apiCallCount = 0;

  /** Timestamp (ms) when the current analysis run started. */
  private totalStartTime = 0;

  constructor(config?: Partial<CrmAnalyzerConfig>) {
    this.config = { ...CRM_ANALYZER_DEFAULTS, ...config };
  }

  /**
   * Analyze CRM state for a given user.
   *
   * Makes paginated REST API calls using the user's API key.
   * Returns structured analysis or a typed error.
   *
   * @param userApiKey     The user's EspoCRM API key for ACL-scoped queries.
   * @param espocrmBaseUrl Base URL of the EspoCRM instance (e.g. "https://crm.juntoai.org").
   * @param config         Optional per-call config overrides.
   */
  async analyze(
    userApiKey: string,
    espocrmBaseUrl: string,
    config?: Partial<CrmAnalyzerConfig>,
  ): Promise<CrmAnalysisResult | CrmAnalysisError> {
    // Merge per-call overrides with instance defaults
    const resolvedConfig = { ...this.config, ...config };

    // Reset budget trackers at the start of each analysis run
    this.apiCallCount = 0;
    this.totalStartTime = Date.now();

    // Partial results accumulator — preserves data retrieved before any failure
    const partialResults: Partial<CrmAnalysisResult> = {};

    try {
      // 1. Build Active Account Set (4 API calls)
      const activeAccountSet = await this.buildActiveAccountSet(userApiKey, espocrmBaseUrl, resolvedConfig);

      // 2. Find stalled accounts (2-6 API calls)
      partialResults.stalledAccounts = await this.findStalledAccounts(activeAccountSet, userApiKey, espocrmBaseUrl, resolvedConfig);

      // 3. Find overdue opportunities (1-2 API calls)
      partialResults.overdueOpportunities = await this.findOverdueOpportunities(userApiKey, espocrmBaseUrl, resolvedConfig);

      // 4. Find overdue tasks (1-2 API calls)
      partialResults.overdueTasks = await this.findOverdueTasks(userApiKey, espocrmBaseUrl, resolvedConfig);

      // 5. Build activity summary (4 API calls)
      partialResults.activitySummary = await this.buildActivitySummary(userApiKey, espocrmBaseUrl, resolvedConfig);

      // All succeeded — return complete result
      return {
        overdueOpportunities: partialResults.overdueOpportunities,
        stalledAccounts: partialResults.stalledAccounts,
        overdueTasks: partialResults.overdueTasks,
        activitySummary: partialResults.activitySummary,
        generatedAt: new Date().toISOString(),
      };
    } catch (err: unknown) {
      return this.handleAnalysisError(err, partialResults);
    }
  }

  // ─── Error Handling ─────────────────────────────────────────────────────────

  /**
   * Classify a caught error and return a structured CrmAnalysisError.
   * Preserves any partial results retrieved before the failure.
   * Never leaks internal details (URLs, API keys, stack traces).
   */
  private handleAnalysisError(err: unknown, partialResults: Partial<CrmAnalysisResult>): CrmAnalysisError {
    const partial = Object.keys(partialResults).length > 0 ? partialResults : undefined;

    // Known CRM API errors (auth, server, network, timeout)
    if (err instanceof CrmApiError) {
      return {
        error: true,
        code: err.code,
        message: this.sanitizeErrorMessage(err.code),
        partialResults: partial,
      };
    }

    // Budget/timeout exceeded
    if (err instanceof BudgetExceededError) {
      return {
        error: true,
        code: err.code,
        message: this.sanitizeErrorMessage(err.code),
        partialResults: partial,
      };
    }

    // Unknown error → CONNECTION_FAILED (safe fallback, no internal details)
    return {
      error: true,
      code: 'CONNECTION_FAILED',
      message: 'An unexpected error occurred during CRM analysis.',
      partialResults: partial,
    };
  }

  /**
   * Return a user-safe error message for a given error code.
   * These messages intentionally contain NO URLs, API keys, or stack traces.
   */
  private sanitizeErrorMessage(code: CrmAnalysisErrorCode): string {
    switch (code) {
      case 'AUTH_FAILED':
        return 'Unable to access CRM data. Please check your API key permissions.';
      case 'SERVICE_UNAVAILABLE':
        return 'CRM service is temporarily unavailable. Please try again later.';
      case 'CONNECTION_FAILED':
        return 'Unable to connect to CRM. Please check your network connection.';
      case 'TIMEOUT':
        return 'CRM data retrieval timed out. Please try again.';
    }
  }

  // ─── Stalled Account Detection (via Active_Account_Set) ─────────────────────

  // ─── Active Account Set ────────────────────────────────────────────────────

  /**
   * Build the Active_Account_Set by querying recent activities within the
   * engagement decay window and extracting distinct Account IDs.
   *
   * Queries 4 entity types (Meetings, Calls, Tasks, Notes) and unions all
   * parentId values where parentType === 'Account'.
   *
   * @param userApiKey      The user's EspoCRM API key.
   * @param espocrmBaseUrl  Base URL of the EspoCRM instance.
   * @param resolvedConfig  Resolved configuration for this analysis run.
   * @returns               Set of account IDs that have recent activity.
   */
  async buildActiveAccountSet(
    userApiKey: string,
    espocrmBaseUrl: string,
    resolvedConfig: CrmAnalyzerConfig,
  ): Promise<Set<string>> {
    const activeAccountIds = new Set<string>();

    // Calculate decay window start date (today - engagementDecayDays) in YYYY-MM-DD format
    const now = new Date();
    const decayWindowStart = new Date(now.getTime() - resolvedConfig.engagementDecayDays * 24 * 60 * 60 * 1000);
    const decayDateStr = decayWindowStart.toISOString().split('T')[0];

    // Helper to extract account IDs from activity records
    const extractAccountIds = (records: Record<string, unknown>[]): void => {
      for (const record of records) {
        if (record.parentType === 'Account' && typeof record.parentId === 'string' && record.parentId) {
          activeAccountIds.add(record.parentId);
        }
      }
    };

    // 1. Query Meetings within decay window (filter by dateStart)
    const meetings = await this.paginatedQuery(
      'Meeting',
      {
        select: 'parentId,parentType',
        where: [{ type: 'after', attribute: 'dateStart', value: decayDateStr }],
      },
      userApiKey,
      espocrmBaseUrl,
      resolvedConfig,
    );
    extractAccountIds(meetings);

    // 2. Query Calls within decay window (filter by dateStart)
    const calls = await this.paginatedQuery(
      'Call',
      {
        select: 'parentId,parentType',
        where: [{ type: 'after', attribute: 'dateStart', value: decayDateStr }],
      },
      userApiKey,
      espocrmBaseUrl,
      resolvedConfig,
    );
    extractAccountIds(calls);

    // 3. Query Tasks within decay window (filter by modifiedAt)
    const tasks = await this.paginatedQuery(
      'Task',
      {
        select: 'parentId,parentType',
        where: [{ type: 'after', attribute: 'modifiedAt', value: decayDateStr }],
      },
      userApiKey,
      espocrmBaseUrl,
      resolvedConfig,
    );
    extractAccountIds(tasks);

    // 4. Query Notes within decay window (filter by createdAt)
    const notes = await this.paginatedQuery(
      'Note',
      {
        select: 'parentId,parentType',
        where: [{ type: 'after', attribute: 'createdAt', value: decayDateStr }],
      },
      userApiKey,
      espocrmBaseUrl,
      resolvedConfig,
    );
    extractAccountIds(notes);

    return activeAccountIds;
  }

  // ─── Stalled Account Identification ─────────────────────────────────────

  /**
   * Identify stalled accounts by diffing all accounts against the Active_Account_Set.
   *
   * A stalled account is one whose ID is NOT present in the Active_Account_Set
   * (i.e., no recent Meetings, Calls, Tasks, or Notes within the engagement decay window).
   *
   * For each stalled account, the contact count is determined by batch-querying
   * all Contacts and counting those linked to each stalled account ID.
   *
   * @param activeAccountSet Set of account IDs with recent activity.
   * @param userApiKey       The user's EspoCRM API key.
   * @param espocrmBaseUrl   Base URL of the EspoCRM instance.
   * @param resolvedConfig   Resolved configuration for this analysis run.
   * @returns                Array of stalled accounts with contact counts.
   */
  private async findStalledAccounts(
    activeAccountSet: Set<string>,
    userApiKey: string,
    espocrmBaseUrl: string,
    resolvedConfig: CrmAnalyzerConfig,
  ): Promise<StalledAccount[]> {
    // 1. Fetch all accounts (paginated, 1-3 calls for up to 500 accounts)
    const allAccounts = await this.paginatedQuery(
      'Account',
      { select: 'id,name' },
      userApiKey,
      espocrmBaseUrl,
      resolvedConfig,
    );

    // 2. Filter: stalled accounts = those NOT in the Active_Account_Set
    const stalledAccountRecords = allAccounts.filter(
      (account) => !activeAccountSet.has(account.id as string),
    );

    // If no stalled accounts, skip the contact query entirely
    if (stalledAccountRecords.length === 0) {
      return [];
    }

    // 3. Batch-query ALL contacts to count per stalled account (1-3 paginated calls)
    const allContacts = await this.paginatedQuery(
      'Contact',
      { select: 'id,accountId' },
      userApiKey,
      espocrmBaseUrl,
      resolvedConfig,
    );

    // Build a map of accountId → contact count (only for stalled accounts)
    const stalledAccountIdSet = new Set(
      stalledAccountRecords.map((a) => a.id as string),
    );
    const contactCountMap = new Map<string, number>();

    for (const contact of allContacts) {
      const accountId = contact.accountId as string;
      if (accountId && stalledAccountIdSet.has(accountId)) {
        contactCountMap.set(accountId, (contactCountMap.get(accountId) ?? 0) + 1);
      }
    }

    // 4. Map results to StalledAccount[]
    return stalledAccountRecords.map((account) => {
      const accountId = account.id as string;
      return {
        id: accountId,
        name: (account.name as string) || '',
        lastActivityDate: null, // Not available without per-account activity queries
        contactCount: contactCountMap.get(accountId) ?? 0,
        daysSinceActivity: resolvedConfig.engagementDecayDays, // Minimum guaranteed
      };
    });
  }

  // ─── Overdue Opportunity Detection ───────────────────────────────────────

  /**
   * Find all opportunities whose close date has passed without being closed.
   *
   * Queries EspoCRM for Opportunities where:
   * - closeDate is before today (UTC)
   * - stage is NOT 'Closed Won' or 'Closed Lost'
   *
   * Computes `daysOverdue` as the number of full days between closeDate and today.
   *
   * @param userApiKey     The user's EspoCRM API key.
   * @param espocrmBaseUrl Base URL of the EspoCRM instance.
   * @param resolvedConfig Resolved configuration for this analysis run.
   * @returns              Array of overdue opportunities with computed daysOverdue.
   */
  private async findOverdueOpportunities(
    userApiKey: string,
    espocrmBaseUrl: string,
    resolvedConfig: CrmAnalyzerConfig,
  ): Promise<OverdueOpportunity[]> {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0]; // YYYY-MM-DD in UTC

    const records = await this.paginatedQuery(
      'Opportunity',
      {
        select: 'id,name,accountName,stage,closeDate',
        where: [
          { type: 'before', attribute: 'closeDate', value: todayStr },
          { type: 'notIn', attribute: 'stage', value: ['Closed Won', 'Closed Lost'] },
        ],
      },
      userApiKey,
      espocrmBaseUrl,
      resolvedConfig,
    );

    const todayMs = new Date(todayStr).getTime();

    return records.map((record) => {
      const closeDate = (record.closeDate as string) || todayStr;
      const closeDateMs = new Date(closeDate).getTime();
      const daysOverdue = Math.floor((todayMs - closeDateMs) / (1000 * 60 * 60 * 24));

      return {
        id: record.id as string,
        name: record.name as string,
        accountName: (record.accountName as string) || '',
        stage: record.stage as string,
        closeDate,
        daysOverdue,
      };
    });
  }

  // ─── Activity Summary Aggregation ─────────────────────────────────────────

  /**
   * Aggregate recent activity counts per day within the Activity_Window.
   *
   * Queries 4 entity types within the activityWindowDays window:
   * - Completed Tasks (status=Completed, modifiedAt within window)
   * - Held Meetings (status=Held, dateStart within window)
   * - Held Calls (status=Held, dateStart within window)
   * - Notes (createdAt within window)
   *
   * Groups counts by date (YYYY-MM-DD) and returns sorted descending.
   *
   * @param userApiKey      The user's EspoCRM API key.
   * @param espocrmBaseUrl  Base URL of the EspoCRM instance.
   * @param resolvedConfig  Resolved configuration for this analysis run.
   * @returns               Array of daily activity summaries, sorted by date descending.
   */
  private async buildActivitySummary(
    userApiKey: string,
    espocrmBaseUrl: string,
    resolvedConfig: CrmAnalyzerConfig,
  ): Promise<ActivitySummary[]> {
    // Calculate activity window start date (today - activityWindowDays) in YYYY-MM-DD (UTC)
    const now = new Date();
    const windowStart = new Date(now.getTime() - resolvedConfig.activityWindowDays * 24 * 60 * 60 * 1000);
    const windowStartStr = windowStart.toISOString().split('T')[0];

    // Map keyed by date string (YYYY-MM-DD) → ActivitySummary
    const summaryMap = new Map<string, ActivitySummary>();

    /** Get or create an ActivitySummary entry for a given date. */
    const getEntry = (date: string): ActivitySummary => {
      let entry = summaryMap.get(date);
      if (!entry) {
        entry = { date, calls: 0, meetings: 0, tasksCompleted: 0, notesPosted: 0 };
        summaryMap.set(date, entry);
      }
      return entry;
    };

    // 1. Query completed Tasks within activity window
    const completedTasks = await this.paginatedQuery(
      'Task',
      {
        select: 'id,modifiedAt',
        where: [
          { type: 'equals', attribute: 'status', value: 'Completed' },
          { type: 'after', attribute: 'modifiedAt', value: windowStartStr },
        ],
      },
      userApiKey,
      espocrmBaseUrl,
      resolvedConfig,
    );

    for (const task of completedTasks) {
      const modifiedAt = task.modifiedAt as string;
      if (modifiedAt) {
        const date = modifiedAt.split('T')[0].split(' ')[0]; // Handle both ISO and space-separated formats
        getEntry(date).tasksCompleted++;
      }
    }

    // 2. Query Held Meetings within activity window
    const meetings = await this.paginatedQuery(
      'Meeting',
      {
        select: 'id,dateStart',
        where: [
          { type: 'after', attribute: 'dateStart', value: windowStartStr },
          { type: 'equals', attribute: 'status', value: 'Held' },
        ],
      },
      userApiKey,
      espocrmBaseUrl,
      resolvedConfig,
    );

    for (const meeting of meetings) {
      const dateStart = meeting.dateStart as string;
      if (dateStart) {
        const date = dateStart.split('T')[0].split(' ')[0];
        getEntry(date).meetings++;
      }
    }

    // 3. Query Held Calls within activity window
    const calls = await this.paginatedQuery(
      'Call',
      {
        select: 'id,dateStart',
        where: [
          { type: 'after', attribute: 'dateStart', value: windowStartStr },
          { type: 'equals', attribute: 'status', value: 'Held' },
        ],
      },
      userApiKey,
      espocrmBaseUrl,
      resolvedConfig,
    );

    for (const call of calls) {
      const dateStart = call.dateStart as string;
      if (dateStart) {
        const date = dateStart.split('T')[0].split(' ')[0];
        getEntry(date).calls++;
      }
    }

    // 4. Query Notes within activity window
    const notes = await this.paginatedQuery(
      'Note',
      {
        select: 'id,createdAt',
        where: [
          { type: 'after', attribute: 'createdAt', value: windowStartStr },
        ],
      },
      userApiKey,
      espocrmBaseUrl,
      resolvedConfig,
    );

    for (const note of notes) {
      const createdAt = note.createdAt as string;
      if (createdAt) {
        const date = createdAt.split('T')[0].split(' ')[0];
        getEntry(date).notesPosted++;
      }
    }

    // Convert map to array sorted by date descending
    return Array.from(summaryMap.values()).sort((a, b) => b.date.localeCompare(a.date));
  }

  // ─── Budget Enforcement ──────────────────────────────────────────────────

  /**
   * Check whether the API call budget or total timeout has been exceeded.
   * Throws BudgetExceededError if either limit is breached.
   *
   * Must be called before each API request.
   */
  private checkBudget(resolvedConfig: CrmAnalyzerConfig): void {
    if (this.apiCallCount >= MAX_API_CALLS) {
      throw new BudgetExceededError(
        `API call budget exceeded: ${this.apiCallCount} calls made (max ${MAX_API_CALLS})`,
        'SERVICE_UNAVAILABLE',
      );
    }

    const elapsed = Date.now() - this.totalStartTime;
    if (elapsed >= resolvedConfig.totalTimeoutMs) {
      throw new BudgetExceededError(
        `Total analysis timeout exceeded: ${elapsed}ms elapsed (max ${resolvedConfig.totalTimeoutMs}ms)`,
        'TIMEOUT',
      );
    }
  }

  // ─── Paginated Query Helper ──────────────────────────────────────────────

  /**
   * Fetch all matching records from an EspoCRM entity type using pagination.
   *
   * Makes sequential GET requests to `{baseUrl}/api/v1/{entityType}` with
   * `maxSize` (capped at 200) and incrementing `offset` until all records
   * are retrieved or a budget/timeout limit is hit.
   *
   * @param entityType     EspoCRM entity type (e.g. "Opportunity", "Account").
   * @param params         Query parameters including `where` clauses.
   * @param userApiKey     The user's API key for X-Api-Key header.
   * @param espocrmBaseUrl Base URL of the EspoCRM instance.
   * @param resolvedConfig Resolved configuration for this analysis run.
   * @returns              All records collected across pages.
   * @throws BudgetExceededError if call count or total timeout is exceeded.
   */
  async paginatedQuery(
    entityType: string,
    params: EspoQueryParams,
    userApiKey: string,
    espocrmBaseUrl: string,
    resolvedConfig: CrmAnalyzerConfig,
  ): Promise<Record<string, unknown>[]> {
    const allRecords: Record<string, unknown>[] = [];
    const pageSize = Math.min(resolvedConfig.maxPageSize, 200);
    let offset = params.offset ?? 0;

    while (true) {
      // Check budget before each request
      this.checkBudget(resolvedConfig);

      // Build query URL
      const url = this.buildQueryUrl(entityType, { ...params, maxSize: pageSize, offset }, espocrmBaseUrl);

      // Make the request with per-call timeout
      const response = await this.fetchWithTimeout(url, userApiKey, resolvedConfig.apiTimeoutMs);

      // Increment call counter after successful request
      this.apiCallCount++;

      // Parse response
      const data = response as EspoListResponse;
      const records = data.list ?? [];

      allRecords.push(...records);

      // Stop paginating when: fewer records returned than page size (last page)
      if (records.length < pageSize) {
        break;
      }

      offset += pageSize;
    }

    return allRecords;
  }

  // ─── HTTP Helper ─────────────────────────────────────────────────────────

  /**
   * Make a GET request to EspoCRM with timeout via AbortController.
   *
   * @param url        Full URL to fetch.
   * @param apiKey     User's API key for authentication.
   * @param timeoutMs  Per-request timeout in milliseconds.
   * @returns          Parsed JSON response.
   * @throws           Typed errors for auth failures, server errors, timeouts, and network issues.
   */
  private async fetchWithTimeout(
    url: string,
    apiKey: string,
    timeoutMs: number,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'X-Api-Key': apiKey,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw this.classifyHttpError(response.status);
      }

      return await response.json();
    } catch (err: unknown) {
      if (err instanceof BudgetExceededError) {
        throw err;
      }

      // Re-throw already-classified errors
      if (err instanceof CrmApiError) {
        throw err;
      }

      // Abort signal → timeout (DOMException or Error with name 'AbortError')
      if (
        (err instanceof Error && err.name === 'AbortError') ||
        (err instanceof DOMException && err.name === 'AbortError')
      ) {
        throw new CrmApiError('Request timed out', 'TIMEOUT');
      }

      // Also check if the abort controller was triggered (belt and suspenders)
      if (controller.signal.aborted) {
        throw new CrmApiError('Request timed out', 'TIMEOUT');
      }

      // Network errors (ECONNREFUSED, ENOTFOUND, fetch failures, etc.)
      throw new CrmApiError('Network error connecting to CRM', 'CONNECTION_FAILED');
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Classify an HTTP status code into a CrmAnalysisErrorCode.
   */
  private classifyHttpError(status: number): CrmApiError {
    if (status === 401 || status === 403) {
      return new CrmApiError(
        'Authentication failed or insufficient permissions',
        'AUTH_FAILED',
      );
    }

    if (status >= 500) {
      return new CrmApiError(
        'CRM service returned a server error',
        'SERVICE_UNAVAILABLE',
      );
    }

    // Other client errors (4xx except 401/403) → connection failed (per req 1.10)
    return new CrmApiError(
      'CRM request failed',
      'CONNECTION_FAILED',
    );
  }

  // ─── URL Builder ─────────────────────────────────────────────────────────

  /**
   * Build a full URL for an EspoCRM list query with query parameters.
   */
  private buildQueryUrl(
    entityType: string,
    params: EspoQueryParams,
    baseUrl: string,
  ): string {
    const url = new URL(`/api/v1/${entityType}`, baseUrl);

    if (params.maxSize !== undefined) {
      url.searchParams.set('maxSize', String(params.maxSize));
    }
    if (params.offset !== undefined && params.offset > 0) {
      url.searchParams.set('offset', String(params.offset));
    }
    if (params.orderBy) {
      url.searchParams.set('orderBy', params.orderBy);
    }
    if (params.order) {
      url.searchParams.set('order', params.order);
    }
    if (params.select) {
      url.searchParams.set('select', params.select);
    }

    // Encode where clauses as indexed query params
    if (params.where) {
      for (let i = 0; i < params.where.length; i++) {
        const clause = params.where[i];
        url.searchParams.set(`where[${i}][type]`, clause.type);
        if (clause.attribute !== undefined) {
          url.searchParams.set(`where[${i}][attribute]`, clause.attribute);
        }
        if (clause.field !== undefined) {
          url.searchParams.set(`where[${i}][field]`, clause.field);
        }
        if (clause.value !== undefined) {
          if (Array.isArray(clause.value)) {
            // Array values encoded as comma-separated or indexed
            for (let j = 0; j < clause.value.length; j++) {
              url.searchParams.set(`where[${i}][value][]`, clause.value[j]);
            }
          } else {
            url.searchParams.set(`where[${i}][value]`, String(clause.value));
          }
        }
      }
    }

    return url.toString();
  }

  // ─── Accessors (for testing) ─────────────────────────────────────────────

  /** Get the current API call count (useful for testing budget enforcement). */
  getApiCallCount(): number {
    return this.apiCallCount;
  }

  /** Get the resolved config. */
  getConfig(): CrmAnalyzerConfig {
    return { ...this.config };
  }

  // ─── Overdue Task Detection ────────────────────────────────────────────────

  /**
   * Find all tasks that are past their due date and not yet completed/cancelled.
   *
   * Queries Tasks with status IN (Not Started, Started) AND dateEnd < today (UTC).
   * Computes daysOverdue for each result.
   *
   * @param userApiKey     The user's EspoCRM API key for ACL-scoped queries.
   * @param espocrmBaseUrl Base URL of the EspoCRM instance.
   * @param resolvedConfig Resolved configuration for this analysis run.
   * @returns              Array of overdue tasks with computed daysOverdue.
   */
  private async findOverdueTasks(
    userApiKey: string,
    espocrmBaseUrl: string,
    resolvedConfig: CrmAnalyzerConfig,
  ): Promise<OverdueTask[]> {
    // Get today's date in YYYY-MM-DD format (UTC)
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    // Query tasks: status IN (Not Started, Started) AND dateEnd < today
    const records = await this.paginatedQuery(
      'Task',
      {
        select: 'id,name,assignedUserName,dateEnd,status',
        where: [
          {
            type: 'in',
            attribute: 'status',
            value: ['Not Started', 'Started'],
          },
          {
            type: 'before',
            attribute: 'dateEnd',
            value: today,
          },
        ],
      },
      userApiKey,
      espocrmBaseUrl,
      resolvedConfig,
    );

    // Map raw records to OverdueTask[]
    const todayMs = new Date(today).getTime();

    return records.map((record) => {
      const dateEnd = record.dateEnd as string;
      const dateEndMs = new Date(dateEnd).getTime();
      const daysOverdue = Math.floor((todayMs - dateEndMs) / (1000 * 60 * 60 * 24));

      return {
        id: record.id as string,
        name: record.name as string,
        assigneeName: (record.assignedUserName as string) || 'Unassigned',
        dateEnd,
        daysOverdue,
      };
    });
  }
}

// ─── Internal Error Class ────────────────────────────────────────────────────

/**
 * Internal error thrown during EspoCRM API calls.
 * Carries a classified error code for structured error responses.
 */
export class CrmApiError extends Error {
  constructor(
    message: string,
    public readonly code: CrmAnalysisErrorCode,
  ) {
    super(message);
    this.name = 'CrmApiError';
  }
}
