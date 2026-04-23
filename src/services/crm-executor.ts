/**
 * CRM Executor — translates MCP tool calls to EspoCRM REST API calls.
 *
 * The MCP server is used only at startup for schema loading. Actual CRM
 * operations go through this executor, which makes direct REST calls
 * with the requesting user's API key for per-user permission scoping.
 *
 * @module crm-executor
 */

import axios, { type AxiosInstance, type AxiosError, type Method } from 'axios';
import { logger } from '../utils/logger.js';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** REST endpoint configuration for a single MCP tool. */
export interface ToolRestConfig {
  method: Method;
  path: string;
}

/** Structured result from a CRM executor call. */
export interface CRMExecutorResult {
  success: boolean;
  data: unknown;
  status: number;
}

/** Error thrown by the CRM executor with HTTP status context. */
export class CRMExecutorError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly toolName: string,
    public readonly responseData?: unknown,
  ) {
    super(message);
    this.name = 'CRMExecutorError';
  }
}

// ────────────────────────────────────────────────────────────────
// Tool-to-REST mapping — all 47 MCP tools
// ────────────────────────────────────────────────────────────────

export const TOOL_REST_MAP: Record<string, ToolRestConfig> = {
  // ── Contacts (3) ──────────────────────────────────────────
  create_contact:       { method: 'POST',   path: '/api/v1/Contact' },
  search_contacts:      { method: 'GET',    path: '/api/v1/Contact' },
  get_contact:          { method: 'GET',    path: '/api/v1/Contact/{contactId}' },

  // ── Accounts (2) ──────────────────────────────────────────
  create_account:       { method: 'POST',   path: '/api/v1/Account' },
  search_accounts:      { method: 'GET',    path: '/api/v1/Account' },

  // ── Opportunities (2) ─────────────────────────────────────
  create_opportunity:   { method: 'POST',   path: '/api/v1/Opportunity' },
  search_opportunities: { method: 'GET',    path: '/api/v1/Opportunity' },

  // ── Leads (5) ─────────────────────────────────────────────
  create_lead:          { method: 'POST',   path: '/api/v1/Lead' },
  search_leads:         { method: 'GET',    path: '/api/v1/Lead' },
  update_lead:          { method: 'PATCH',  path: '/api/v1/Lead/{leadId}' },
  convert_lead:         { method: 'POST',   path: '/api/v1/LeadCapture/convert/{leadId}' },
  assign_lead:          { method: 'PATCH',  path: '/api/v1/Lead/{leadId}' },

  // ── Meetings (4) ──────────────────────────────────────────
  create_meeting:       { method: 'POST',   path: '/api/v1/Meeting' },
  search_meetings:      { method: 'GET',    path: '/api/v1/Meeting' },
  get_meeting:          { method: 'GET',    path: '/api/v1/Meeting/{meetingId}' },
  update_meeting:       { method: 'PATCH',  path: '/api/v1/Meeting/{meetingId}' },

  // ── Tasks (5) ─────────────────────────────────────────────
  create_task:          { method: 'POST',   path: '/api/v1/Task' },
  search_tasks:         { method: 'GET',    path: '/api/v1/Task' },
  get_task:             { method: 'GET',    path: '/api/v1/Task/{taskId}' },
  update_task:          { method: 'PATCH',  path: '/api/v1/Task/{taskId}' },
  assign_task:          { method: 'PATCH',  path: '/api/v1/Task/{taskId}' },

  // ── Calls (2) ─────────────────────────────────────────────
  create_call:          { method: 'POST',   path: '/api/v1/Call' },
  search_calls:         { method: 'GET',    path: '/api/v1/Call' },

  // ── Cases (3) ─────────────────────────────────────────────
  create_case:          { method: 'POST',   path: '/api/v1/Case' },
  search_cases:         { method: 'GET',    path: '/api/v1/Case' },
  update_case:          { method: 'PATCH',  path: '/api/v1/Case/{caseId}' },

  // ── Notes (2) ─────────────────────────────────────────────
  add_note:             { method: 'POST',   path: '/api/v1/Note' },
  search_notes:         { method: 'GET',    path: '/api/v1/Note' },

  // ── Teams (4) ─────────────────────────────────────────────
  search_teams:         { method: 'GET',    path: '/api/v1/Team' },
  get_team_members:     { method: 'GET',    path: '/api/v1/Team/{teamId}/users' },
  add_user_to_team:     { method: 'POST',   path: '/api/v1/Team/{teamId}/users' },
  remove_user_from_team:{ method: 'DELETE',  path: '/api/v1/Team/{teamId}/users' },

  // ── Roles (1) ─────────────────────────────────────────────
  assign_role_to_user:  { method: 'POST',   path: '/api/v1/User/{userId}/roles' },

  // ── Users (4) ─────────────────────────────────────────────
  search_users:         { method: 'GET',    path: '/api/v1/User' },
  get_user_by_email:    { method: 'GET',    path: '/api/v1/User' },
  get_user_teams:       { method: 'GET',    path: '/api/v1/User/{userId}/teams' },
  get_user_permissions: { method: 'GET',    path: '/api/v1/User/{userId}' },

  // ── Generic entities (5) ──────────────────────────────────
  create_entity:        { method: 'POST',   path: '/api/v1/{entityType}' },
  search_entity:        { method: 'GET',    path: '/api/v1/{entityType}' },
  get_entity:           { method: 'GET',    path: '/api/v1/{entityType}/{entityId}' },
  update_entity:        { method: 'PATCH',  path: '/api/v1/{entityType}/{entityId}' },
  delete_entity:        { method: 'DELETE',  path: '/api/v1/{entityType}/{entityId}' },

  // ── Relationships (3) ─────────────────────────────────────
  link_entities:        { method: 'POST',   path: '/api/v1/{entityType}/{entityId}/{relationshipName}' },
  unlink_entities:      { method: 'DELETE',  path: '/api/v1/{entityType}/{entityId}/{relationshipName}' },
  get_entity_relationships: { method: 'GET', path: '/api/v1/{entityType}/{entityId}/{relationshipName}' },

  // ── Health (1) ────────────────────────────────────────────
  health_check:         { method: 'GET',    path: '/api/v1/App/user' },
};

// ────────────────────────────────────────────────────────────────
// Path parameter keys that get substituted into URL paths
// ────────────────────────────────────────────────────────────────

/**
 * Set of arg keys that are used as path parameters and should NOT
 * be sent in the query string or request body.
 *
 * Retained for documentation — path params are extracted dynamically
 * from the URL template in `extractRemainingArgs()`.
 */
// const PATH_PARAM_KEYS: ReadonlySet<string> = new Set([
//   'contactId',
//   'leadId',
//   'meetingId',
//   'taskId',
//   'caseId',
//   'teamId',
//   'userId',
//   'entityType',
//   'entityId',
//   'relationshipName',
// ]);

/**
 * Keys that control pagination / ordering and should be sent as
 * query parameters even on POST/PUT requests.
 */
const QUERY_PARAM_KEYS: ReadonlySet<string> = new Set([
  'offset',
  'limit',
  'orderBy',
  'order',
  'select',
  'maxSize',
]);

// ────────────────────────────────────────────────────────────────
// CRMExecutor
// ────────────────────────────────────────────────────────────────

/**
 * Translates MCP tool calls to EspoCRM REST API calls using the
 * requesting user's API key for per-user permission scoping.
 */
export class CRMExecutor {
  private readonly baseUrl: string;
  private readonly clientCache: Map<string, AxiosInstance> = new Map();

  /**
   * @param espocrmUrl  Base URL of the EspoCRM instance.
   *                    Falls back to `ESPOCRM_URL` env var,
   *                    then `http://localhost:8080`.
   */
  constructor(espocrmUrl?: string) {
    this.baseUrl = (
      espocrmUrl ??
      process.env.ESPOCRM_URL ??
      'http://localhost:8080'
    ).replace(/\/+$/, ''); // strip trailing slashes
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Execute an MCP tool call as an EspoCRM REST request.
   *
   * @param toolName    MCP tool name (e.g. `create_contact`)
   * @param args        Tool arguments from Gemini function call
   * @param userApiKey  The requesting user's EspoCRM API key
   * @returns           Structured result with data and HTTP status
   * @throws {CRMExecutorError} on unknown tool or HTTP error
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
    userApiKey: string,
  ): Promise<CRMExecutorResult> {
    const config = TOOL_REST_MAP[toolName];
    if (!config) {
      throw new CRMExecutorError(
        `Unknown tool: ${toolName}`,
        400,
        toolName,
      );
    }

    const client = this.getClientForKey(userApiKey);
    const resolvedPath = this.substitutePath(config.path, args);
    const method = config.method.toUpperCase() as Method;

    // Separate path params from the rest
    const remainingArgs = this.extractRemainingArgs(args, config.path);

    try {
      let response;

      if (method === 'GET' || method === 'DELETE') {
        // GET/DELETE: all remaining args go as query params
        const params = this.buildQueryParams(toolName, remainingArgs);
        response = await client.request({
          method,
          url: resolvedPath,
          params,
        });
      } else {
        // POST/PUT/PATCH: separate query params from body
        const queryParams: Record<string, unknown> = {};
        const bodyArgs: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(remainingArgs)) {
          if (QUERY_PARAM_KEYS.has(key)) {
            queryParams[key] = value;
          } else {
            bodyArgs[key] = value;
          }
        }

        response = await client.request({
          method,
          url: resolvedPath,
          data: bodyArgs,
          params: Object.keys(queryParams).length > 0 ? queryParams : undefined,
        });
      }

      logger.debug('CRM Executor: tool executed', {
        toolName,
        method,
        path: resolvedPath,
        status: response.status,
      });

      return {
        success: true,
        data: response.data,
        status: response.status,
      };
    } catch (err) {
      return this.handleAxiosError(err, toolName, method, resolvedPath);
    }
  }

  // ── Client cache ────────────────────────────────────────────

  /**
   * Return a cached axios instance for the given API key.
   * Creates one if it doesn't exist yet.
   */
  getClientForKey(apiKey: string): AxiosInstance {
    const existing = this.clientCache.get(apiKey);
    if (existing) return existing;

    const instance = axios.create({
      baseURL: this.baseUrl,
      timeout: 30_000,
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/json',
      },
    });

    this.clientCache.set(apiKey, instance);
    return instance;
  }

  /** Number of cached axios instances (for testing). */
  getCacheSize(): number {
    return this.clientCache.size;
  }

  /** Clear the client cache (for testing / shutdown). */
  clearCache(): void {
    this.clientCache.clear();
  }

  // ── Path substitution ───────────────────────────────────────

  /**
   * Replace `{paramName}` placeholders in the path template with
   * values from the tool args.
   */
  private substitutePath(
    pathTemplate: string,
    args: Record<string, unknown>,
  ): string {
    return pathTemplate.replace(/\{(\w+)\}/g, (_match, paramName: string) => {
      const value = args[paramName];
      if (value === undefined || value === null) {
        throw new CRMExecutorError(
          `Missing required path parameter: ${paramName}`,
          400,
          'unknown',
        );
      }
      return encodeURIComponent(String(value));
    });
  }

  /**
   * Return args with path parameter keys removed (they've already
   * been substituted into the URL).
   */
  private extractRemainingArgs(
    args: Record<string, unknown>,
    pathTemplate: string,
  ): Record<string, unknown> {
    // Extract param names from the path template
    const pathParams = new Set<string>();
    const regex = /\{(\w+)\}/g;
    let match;
    while ((match = regex.exec(pathTemplate)) !== null) {
      pathParams.add(match[1]);
    }

    const remaining: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (!pathParams.has(key)) {
        remaining[key] = value;
      }
    }
    return remaining;
  }

  // ── Query parameter building ────────────────────────────────

  /**
   * Build query parameters for GET/search requests.
   *
   * For search tools, maps filter args to EspoCRM `where` clauses.
   * For non-search tools, passes args through directly.
   */
  private buildQueryParams(
    toolName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const isSearch = toolName.startsWith('search_');
    const params: Record<string, unknown> = {};

    // Pass through pagination/ordering params directly
    for (const key of QUERY_PARAM_KEYS) {
      if (args[key] !== undefined) {
        params[key] = args[key];
      }
    }

    // Handle select as comma-separated string
    if (Array.isArray(args['select'])) {
      params['select'] = (args['select'] as string[]).join(',');
    }

    if (isSearch) {
      // Build EspoCRM where clauses from filter args
      const where = this.buildWhereClause(args);
      if (where.length > 0) {
        where.forEach((clause, index) => {
          params[`where[${index}][type]`] = clause.type;
          params[`where[${index}][attribute]`] = clause.attribute;
          params[`where[${index}][value]`] = clause.value;
        });
      }
    } else {
      // Non-search GET: pass remaining args as query params
      for (const [key, value] of Object.entries(args)) {
        if (!QUERY_PARAM_KEYS.has(key) && value !== undefined) {
          params[key] = value;
        }
      }
    }

    return params;
  }

  /**
   * Convert filter arguments to EspoCRM `where` clause array.
   *
   * EspoCRM uses a structured where format:
   *   where[0][type]=equals&where[0][attribute]=status&where[0][value]=Active
   */
  private buildWhereClause(
    args: Record<string, unknown>,
  ): Array<{ type: string; attribute: string; value: unknown }> {
    const clauses: Array<{ type: string; attribute: string; value: unknown }> = [];

    for (const [key, value] of Object.entries(args)) {
      if (QUERY_PARAM_KEYS.has(key) || value === undefined || value === null) {
        continue;
      }

      // Special handling for common search patterns
      if (key === 'searchTerm' || key === 'name') {
        clauses.push({ type: 'textFilter', attribute: 'textFilter', value });
      } else if (key === 'dateFrom' || key === 'createdFrom' || key === 'modifiedFrom' || key === 'dueDateFrom') {
        const attr = this.mapDateAttribute(key);
        clauses.push({ type: 'after', attribute: attr, value });
      } else if (key === 'dateTo' || key === 'createdTo' || key === 'modifiedTo' || key === 'dueDateTo') {
        const attr = this.mapDateAttribute(key);
        clauses.push({ type: 'before', attribute: attr, value });
      } else if (key === 'minAmount') {
        clauses.push({ type: 'greaterThanOrEquals', attribute: 'amount', value });
      } else if (key === 'maxAmount') {
        clauses.push({ type: 'lessThanOrEquals', attribute: 'amount', value });
      } else if (key === 'isActive') {
        clauses.push({ type: 'equals', attribute: 'isActive', value });
      } else {
        // Default: exact match
        clauses.push({ type: 'equals', attribute: key, value });
      }
    }

    return clauses;
  }

  /**
   * Map date filter arg names to EspoCRM attribute names.
   */
  private mapDateAttribute(key: string): string {
    switch (key) {
      case 'dateFrom':
      case 'dateTo':
        return 'dateStart';
      case 'createdFrom':
      case 'createdTo':
        return 'createdAt';
      case 'modifiedFrom':
      case 'modifiedTo':
        return 'modifiedAt';
      case 'dueDateFrom':
      case 'dueDateTo':
        return 'dateEnd';
      default:
        return key;
    }
  }

  // ── Error handling ──────────────────────────────────────────

  /**
   * Convert an axios error into a structured CRMExecutorResult or
   * throw a CRMExecutorError for non-HTTP errors.
   */
  private handleAxiosError(
    err: unknown,
    toolName: string,
    method: string,
    path: string,
  ): never {
    const axiosErr = err as AxiosError;

    if (axiosErr.response) {
      const status = axiosErr.response.status;
      const data = axiosErr.response.data;

      logger.warn('CRM Executor: HTTP error', {
        toolName,
        method,
        path,
        status,
      });

      throw new CRMExecutorError(
        `EspoCRM API error: ${status}`,
        status,
        toolName,
        data,
      );
    }

    if (axiosErr.code === 'ECONNABORTED') {
      logger.error('CRM Executor: request timeout', { toolName, method, path });
      throw new CRMExecutorError(
        'EspoCRM API request timed out',
        504,
        toolName,
      );
    }

    logger.error('CRM Executor: network error', {
      toolName,
      method,
      path,
      error: axiosErr.message ?? String(err),
    });

    throw new CRMExecutorError(
      `Network error calling EspoCRM: ${axiosErr.message ?? 'unknown'}`,
      503,
      toolName,
    );
  }
}
