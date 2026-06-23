/**
 * Gemini Service — Vertex AI integration for the AI Backend.
 *
 * Manages Gemini model instances, builds requests with system prompt
 * and context-windowed history, handles the function call loop
 * (execute via callback → return results → repeat until text),
 * and extracts search grounding sources.
 *
 * @module gemini-service
 */

import {
  VertexAI,
  type GenerativeModel,
  type Content,
  type Part,
  type FunctionDeclaration,
  type FunctionDeclarationsTool,
  type Tool,
  type GenerateContentRequest,
  type GenerateContentResult,
  type FunctionCall,
  FunctionCallingMode,
} from '@google-cloud/vertexai';
import { logger } from '../utils/logger.js';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

/** Callback invoked when Gemini requests a function call. */
export type ToolCallCallback = (name: string, args: object) => Promise<unknown>;

/** Parameters for the chat method. */
/** A file to send to Gemini as inline data. */
export interface FileAttachment {
  mimeType: string;
  data: string; // base64-encoded
  filename: string;
}

export interface ChatParams {
  message: string;
  history: Content[];
  onToolCall: ToolCallCallback;
  model?: string;
  pdfContext?: string;
  /** Persistent knowledge context (global + per-user) to inject into system prompt. */
  knowledgeContext?: string;
  /** Files to include as inline data in the Gemini request. */
  files?: FileAttachment[];
}

/** Record of a single tool execution during a chat turn. */
export interface ToolExecution {
  tool: string;
  success: boolean;
  summary: string;
}

/** Search source extracted from Gemini grounding metadata. */
export interface SearchSource {
  title: string;
  url: string;
}

/** Result returned from the chat method. */
export interface ChatResult {
  message: string;
  toolsUsed: ToolExecution[];
  sources: SearchSource[];
  /** Token usage metadata from Gemini API. */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** Portion of promptTokens served from Vertex implicit cache (90% cheaper). */
    cachedTokens: number;
  };
}

// ────────────────────────────────────────────────────────────────
// Thinking-level model variant support
// ────────────────────────────────────────────────────────────────

/**
 * Parse a model identifier that may include a `:thinking-X` suffix.
 *
 * Examples:
 *   "gemini-3.5-flash:thinking-low"     → { baseModel: "gemini-3.5-flash", thinkingLevel: "LOW" }
 *   "gemini-3.5-flash:thinking-default" → { baseModel: "gemini-3.5-flash", thinkingLevel: undefined }
 *   "gemini-3.1-pro-preview"            → { baseModel: "gemini-3.1-pro-preview", thinkingLevel: "LOW" }
 *
 * When no suffix is present, we default to LOW to prevent unbounded thinking.
 */
function parseModelVariant(modelId: string): { baseModel: string; thinkingLevel: string | undefined } {
  const suffixMatch = modelId.match(/^(.+):thinking-(low|medium|high|default)$/i);
  if (suffixMatch) {
    const baseModel = suffixMatch[1];
    const level = suffixMatch[2].toLowerCase();
    // 'default' means no thinkingConfig override (let the model use its default thinking)
    return {
      baseModel,
      thinkingLevel: level === 'default' ? undefined : level.toUpperCase(),
    };
  }
  // No suffix — default to LOW for all models to prevent 60s+ thinking delays
  return { baseModel: modelId, thinkingLevel: 'LOW' };
}

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'gemini-3.5-flash:thinking-low';
const TEMPERATURE = 0.3;
const MAX_OUTPUT_TOKENS = 16384;
const API_TIMEOUT_MS = 120_000;
const RETRY_BACKOFF_MS = 2_000;
/** Base backoff for 429 rate-limit errors (longer than generic retries). */
const RATE_LIMIT_BACKOFF_MS = 3_000;
/** Maximum backoff cap for exponential retry. */
const MAX_BACKOFF_MS = 12_000;
/** Maximum number of retries on transient/retryable errors. */
const MAX_RETRIES = 3;
const MAX_FUNCTION_CALL_ROUNDS = 25;
/** Round at which we inject a wind-down instruction to force Gemini to conclude. */
const WIND_DOWN_ROUND = 20;
/** Extended round limit when user explicitly asks to continue. */
const CONTINUE_MAX_ROUNDS = 40;
/** Extended wind-down round for continue requests. */
const CONTINUE_WIND_DOWN_ROUND = 35;
/** Maximum total tool calls before forcing wind-down (regardless of round). */
const MAX_TOOL_CALLS = 30;
/** Extended tool call budget for continue requests. */
const CONTINUE_MAX_TOOL_CALLS = 60;
/** Maximum size (in characters) for a single tool response before truncation. */
const MAX_TOOL_RESPONSE_SIZE = 50_000;
/** Consecutive identical tool failures before forcing wind-down (circuit breaker). */
const MAX_REPEATED_FAILURES = 2;

/** Detect if a message is a "continue" request. */
const CONTINUE_PATTERN = /^(go on|continue|keep going|more|weiter|weitermachen|mach weiter)\s*[.!?]?\s*$/i;

// ────────────────────────────────────────────────────────────────
// System prompt
// ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an AI assistant for JuntoAI's EspoCRM instance. You help users manage their CRM data through natural language.

## Available CRM Operations
You have access to tools for managing:
- **Contacts**: Create, search, get, update contacts with names, emails, phone numbers, titles, departments
- **Accounts**: Create, search accounts/companies with industry, type (Customer, Investor, Partner, Reseller), website
- **Opportunities**: Create, search sales opportunities with stages, amounts, close dates, probability
- **Leads**: Create, search, update, convert, assign leads with sources, statuses, industry
- **Meetings**: Create, search, get, update meetings with dates, locations, attendees
- **Tasks**: Create, search, get, update, assign tasks with priorities, statuses, due dates
- **Calls**: Create, search call logs with direction, duration, participants
- **Cases**: Create, search, update support cases with types, priorities, statuses
- **Notes**: Add and search notes/comments on any entity
- **Teams & Roles**: Search teams, get members, add/remove users, assign roles, get permissions
- **Generic Entities**: Create, search, get, update, delete any entity type; link/unlink relationships
- **Users**: Search users, find by email
- **Health**: Check system connectivity

## JuntoAI Data Model
- **Accounts** have types: Investor, Customer, Partner, Reseller
- **Contacts** belong to Accounts and have titles, departments, email addresses, and phone numbers
- **Opportunities** are linked to Accounts with stages: Prospecting → Qualification → Needs Analysis → Value Proposition → Id. Decision Makers → Perception Analysis → Proposal/Price Quote → Closed Won / Closed Lost
- **Leads** can be converted to Contacts + Accounts + Opportunities

## CRITICAL: Field Value Constraints
When creating or updating records, you MUST use ONLY these exact values for enum fields. Using any other value will cause a validation error.

### Account fields
- **type**: Customer, Investor, Partner, Reseller (ONLY these 4 values)
- **industry**: Use ONLY standard values: Apparel, Banking, Biotechnology, Chemicals, Communications, Construction, Consulting, Education, Electronics, Energy, Engineering, Entertainment, Environmental, Finance, Food & Beverage, Government, Healthcare, Hospitality, Insurance, Legal, Machinery, Manufacturing, Media, Not For Profit, Recreation, Retail, Shipping, Technology, Telecommunications, Transportation, Utilities, Venture Capital (do NOT invent values like "Venture Capital / Private Equity")
- **cStatus**: Backlog, Waiting for Intro, Meeting Requested, In Discussion, Interested, Closed, Declined, Unresponsive, For 2nd round
- **cRating**: 0 (unrated), 1, 2, 3, 4, or 5

### Contact fields
- Use **cRole** for job title (NOT the "title" field — it does not persist)
- **cLinkedIn**: LinkedIn profile URL

### Lead fields
- **status**: New, Assigned, In Process, Converted, Recycled, Dead
- **source**: Call, Email, Existing Customer, Partner, Public Relations, Web Site, Campaign, Other

### Opportunity fields
- **stage**: Prospecting, Qualification, Needs Analysis, Value Proposition, Id. Decision Makers, Perception Analysis, Proposal/Price Quote, Closed Won, Closed Lost

### Task fields
- **status**: Not Started, Started, Completed, Canceled, Deferred
- **priority**: Low, Normal, High, Urgent

### Case fields
- **status**: New, Assigned, Pending, Closed, Rejected, Duplicate
- **priority**: Low, Normal, High, Urgent
- **type**: Question, Incident, Problem, Feature Request

### Meeting fields
- **status**: Planned, Held, Not Held
- **dateStart/dateEnd format**: YYYY-MM-DD HH:mm:ss (space-separated, NOT ISO format with T)

### General rules
- Always search before creating to avoid duplicates
- When updating entities, use update_entity with entityType, entityId, and a data object containing ONLY the fields to change
- For contacts, always try to link them to an existing account using accountId

## Safety Instructions
- Always confirm before executing delete or bulk update operations
- When a user asks to delete something, describe what will be deleted and ask for confirmation before proceeding
- Never execute destructive operations without explicit user approval

## Knowledge Base
You have a persistent knowledge base that stores information across conversations. This includes:
- **Global knowledge** (shared): Company info, pitch deck, investment criteria — available to all users
- **Personal knowledge** (per-user): Communication style, personal DNA, email preferences — unique to each user

You can manage the knowledge base with these tools:
- **list_knowledge**: Show what's stored (use when user asks "what do you know about me/us?")
- **update_knowledge**: Add or update a document (use when user says "remember this", "add to my personal DNA", "update the pitch deck info")
- **delete_knowledge**: Remove a document (use when user says "forget this", "remove the old...")

### When to proactively mention the knowledge base:
- If the user asks you to write an email but you have no personal context → suggest: "I can write better emails if you tell me about your communication style. Want me to save it to your personal knowledge base?"
- If the user asks about VC matching but there's no company info → suggest: "I'd be more helpful with your pitch deck or investment criteria in the knowledge base. Want to add it?"
- If the user asks "what do you know about me?" → use list_knowledge to show them

### Knowledge base rules:
- When updating knowledge, use clear descriptive filenames (e.g., "personal-dna", "investment-criteria", "pitch-deck")
- For personal scope: communication style, values, email preferences, personal background
- For global scope: company overview, product details, investment criteria, team info
- Always confirm with the user before deleting knowledge documents

## Response Formatting
- Use markdown formatting in responses
- Use **bold** for emphasis and entity names
- Use bullet lists for multiple items
- Use code blocks for IDs or technical values
- Keep responses concise and actionable
- When showing search results, format them as readable lists with key fields
- When drafting emails for the user, present the subject and body as plain text — do NOT use blockquote syntax (> prefix). Just write the email content directly.
- IMPORTANT: Do NOT call add_note to log the full content of a drafted or sent email. EspoCRM's built-in email tracking already creates a stream entry when an email is sent. Adding a note with the email content creates a duplicate. Only use add_note for brief action summaries (e.g., "Sent follow-up bump email to Gautam regarding the Digital ops deal") — never paste the email body into a note.
- IMPORTANT: When referencing CRM records (contacts, accounts, leads, opportunities, meetings, tasks, cases), ALWAYS include a clickable link using this exact format: [Record Name](#EntityType/view/RECORD_ID)
  - Examples: [Maria Mc Menamin](#Contact/view/abc123), [Sure Valley Ventures](#Account/view/def456), [Series A Deal](#Opportunity/view/ghi789)
  - Use the entity type with capital first letter: Contact, Account, Lead, Opportunity, Meeting, Task, Case, Call
  - Always use the record ID returned by the CRM tools
  - For search results, include a link for each record found

## Efficiency Rules — CRITICAL (violating these causes timeouts and errors)
- HARD LIMIT: You have a maximum of 20 tool calls per user message. After that, the system will terminate your response. Plan your tool usage carefully.
- Before making any tool call, ask yourself: "Do I already have enough information to answer?" If yes, STOP calling tools and compose your response immediately.
- NEVER retry a tool call that returned an error with the same or similar arguments. If a tool fails (e.g., "Resource not found", "validation error"), do NOT call it again — inform the user about the failure and suggest alternatives.
- If a search returns no results for a given entity, do NOT repeatedly search with minor variations. Report that no results were found and move on.
- Use search_entity with broad filters (e.g., search tasks with status filter) instead of fetching individual records one by one with get_entity.
- NEVER call get_entity or get_contact in a loop for more than 4 records. If you need details on many records, tell the user what you found from the search results and offer to drill into specific ones.
- Do NOT exhaustively search every entity type unless the user explicitly asks for a comprehensive overview.
- When searching for notes, make at most 2 search_notes calls. If you don't find relevant notes in 2 tries, report what you found and move on.
- Prefer targeted searches (with specific filters) over broad unfiltered searches.
- If a search returns empty results, do NOT retry with slightly different parameters — report that no results were found.
- For analytical questions ("which accounts should we...", "what tasks need..."), fetch ONE broad search result set, analyze it in your response, and present your recommendation. Do NOT fetch every related entity.
- Compose your response as soon as you have enough information to answer the user's question. Do not keep searching for more data "just in case".`;

// ────────────────────────────────────────────────────────────────
// Pure utility functions (exported for testing)
// ────────────────────────────────────────────────────────────────

/**
 * Window conversation history to the most recent `maxMessages` entries.
 *
 * This is a pure function: given a full history and a window size,
 * it returns the most recent entries without mutating the input.
 */
export function assembleContext(
  history: Content[],
  maxMessages: number,
): Content[] {
  if (maxMessages <= 0) {
    return [];
  }
  if (history.length <= maxMessages) {
    return [...history];
  }
  return history.slice(history.length - maxMessages);
}

/**
 * Return the system prompt used for Gemini requests.
 * Exported for testing.
 */
export function getSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

// ────────────────────────────────────────────────────────────────
// Retry helper
// ────────────────────────────────────────────────────────────────

/**
 * Determine whether an error is retryable (5xx or network error).
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // Network errors
    if (
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('enotfound') ||
      msg.includes('socket hang up') ||
      msg.includes('network')
    ) {
      return true;
    }
    // 5xx status codes
    if (/\b5\d{2}\b/.test(msg)) {
      return true;
    }
    // 429 rate limit / quota exhaustion — Vertex burst limits are often
    // transient and succeed on a backed-off retry.
    if (
      msg.includes('429') ||
      msg.includes('too many requests') ||
      msg.includes('resource_exhausted') ||
      msg.includes('resource has been exhausted') ||
      msg.includes('quota')
    ) {
      return true;
    }
    // "Internal" or "unavailable" server errors
    if (msg.includes('internal') || msg.includes('unavailable')) {
      return true;
    }
  }
  // Check for status code on error-like objects
  const obj = error as Record<string, unknown>;
  if (typeof obj?.status === 'number' && (obj.status >= 500 || obj.status === 429)) {
    return true;
  }
  if (typeof obj?.statusCode === 'number' && (obj.statusCode >= 500 || obj.statusCode === 429)) {
    return true;
  }
  return false;
}

/**
 * Sleep for the given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer.unref) {
      timer.unref();
    }
  });
}

// ────────────────────────────────────────────────────────────────
// Sequential tool call execution (extracted for testability)
// ────────────────────────────────────────────────────────────────

/** A function call descriptor as returned by Gemini. */
export interface FunctionCallDescriptor {
  name: string;
  args: Record<string, unknown>;
}

/** Result of executing a single function call. */
export interface FunctionCallResult {
  name: string;
  success: boolean;
  summary: string;
  response: object;
}

/** Result of executing a batch of sequential function calls. */
export interface SequentialExecutionResult {
  toolsUsed: ToolExecution[];
  functionResponses: FunctionCallResult[];
}

/**
 * Execute an ordered list of function calls sequentially, accumulating
 * all results (both successes and failures). A failure does NOT abort
 * the sequence — every call is attempted.
 *
 * This is a pure orchestration function: it takes a list of calls and
 * an executor callback, and returns the accumulated results.
 *
 * Exported for property-based testing (Property 4).
 */
export async function executeSequentialToolCalls(
  calls: FunctionCallDescriptor[],
  executor: ToolCallCallback,
): Promise<SequentialExecutionResult> {
  const toolsUsed: ToolExecution[] = [];
  const functionResponses: FunctionCallResult[] = [];

  for (const call of calls) {
    let toolResult: unknown;
    let success = true;
    let summary: string;

    try {
      toolResult = await executor(call.name, call.args);
      summary = `Executed ${call.name} successfully`;
    } catch (err) {
      success = false;
      toolResult = {
        error: true,
        message: err instanceof Error ? err.message : 'Tool execution failed',
      };
      summary = `${call.name} failed: ${err instanceof Error ? err.message : 'unknown error'}`;
    }

    toolsUsed.push({ tool: call.name, success, summary });

    const response =
      typeof toolResult === 'object' && toolResult !== null
        ? (toolResult as object)
        : { result: toolResult };

    functionResponses.push({
      name: call.name,
      success,
      summary,
      response,
    });
  }

  return { toolsUsed, functionResponses };
}

// ────────────────────────────────────────────────────────────────
// Tool filtering — send only relevant tools per request
// ────────────────────────────────────────────────────────────────

/** Tool categories with keyword triggers. */
const TOOL_CATEGORIES: Record<string, { keywords: RegExp; tools: string[] }> = {
  contacts: {
    keywords: /\b(contact|person|people|email|phone|department)\b/i,
    tools: ['create_contact', 'search_contacts', 'get_contact', 'update_entity'],
  },
  accounts: {
    keywords: /\b(account|company|companies|organization|business|customer|investor|partner|reseller)\b/i,
    tools: ['create_account', 'search_accounts', 'update_entity', 'get_entity'],
  },
  opportunities: {
    keywords: /\b(opportunit|deal|pipeline|revenue|sales|close date|proposal|won|lost)\b/i,
    tools: ['create_opportunity', 'search_opportunities', 'update_entity'],
  },
  leads: {
    keywords: /\b(lead|prospect|convert|assign.*lead)\b/i,
    tools: ['create_lead', 'search_leads', 'update_lead', 'convert_lead', 'assign_lead'],
  },
  meetings: {
    keywords: /\b(meeting|schedule|calendar|appointment|agenda)\b/i,
    tools: ['create_meeting', 'search_meetings', 'get_meeting', 'update_meeting'],
  },
  tasks: {
    keywords: /\b(task|todo|to-do|assign.*task|due date|priority)\b/i,
    tools: ['create_task', 'search_tasks', 'get_task', 'update_task', 'assign_task'],
  },
  calls: {
    keywords: /\b(call|phone call|dial|rang|inbound|outbound)\b/i,
    tools: ['create_call', 'search_calls'],
  },
  cases: {
    keywords: /\b(case|ticket|support|incident|issue|bug|feature request)\b/i,
    tools: ['create_case', 'search_cases', 'update_case'],
  },
  notes: {
    keywords: /\b(note|comment|remark|annotation|latest|update|status|history|what.s.*(new|happening|going on|the latest))\b/i,
    tools: ['add_note', 'search_notes'],
  },
  teams: {
    keywords: /\b(team|role|permission|member|group)\b/i,
    tools: ['search_teams', 'get_team_members', 'add_user_to_team', 'remove_user_from_team', 'assign_role_to_user', 'get_user_teams', 'get_user_permissions'],
  },
  users: {
    keywords: /\b(user|admin|who am i|staff|employee)\b/i,
    tools: ['search_users', 'get_user_by_email'],
  },
  entities: {
    keywords: /\b(entity|entities|link|unlink|relationship|delete|generic|custom|update|edit|modify|change|enrich|add.*field|set.*field|fill.*in)\b/i,
    tools: ['create_entity', 'search_entity', 'get_entity', 'update_entity', 'delete_entity', 'link_entities', 'unlink_entities', 'get_entity_relationships'],
  },
  health: {
    keywords: /\b(health|status|connectivity|system check)\b/i,
    tools: ['health_check'],
  },
  web: {
    keywords: /\b(website|webpage|url|http|https|fetch|browse|visit|check.*site|look.*at|analyze.*page|investor.*site|portfolio.*page|linkedin|crunchbase|enrich|research)\b/i,
    tools: ['fetch_url'],
  },
  email: {
    keywords: /\b(email|draft|compose|write.*email|send.*email|message.*to|reach.*out)\b/i,
    tools: ['draft_email'],
  },
  knowledge: {
    keywords: /\b(knowledge|know about|personal dna|my style|my tone|pitch deck|remember|forget|update.*context|what do you know)\b/i,
    tools: ['list_knowledge', 'update_knowledge', 'delete_knowledge'],
  },
};

/**
 * Core tools that are ALWAYS included regardless of message keywords.
 *
 * These are the essential CRM query tools needed for almost any question.
 * Note: search_notes was removed from core tools because the model over-uses
 * it (16+ calls per request). It's now keyword-gated via the 'notes' category
 * and a broader keyword pattern that catches "what's the latest" type queries.
 *
 * Backend-only tools (fetch_url, draft_email, knowledge tools) are NOT here —
 * they are reliably keyword-gated and rarely needed, so they stay opt-in.
 */
const CORE_TOOLS: readonly string[] = [
  'search_contacts',
  'search_accounts',
  'search_entity',
  'get_entity',
  'update_entity',
  'search_tasks',
  'get_task',
  'get_contact',
];

/**
 * Select relevant tool NAMES based on the user message.
 *
 * Always includes CORE_TOOLS, then adds category tools whose keyword
 * pattern matches the message. The result is intentionally a subset of
 * the full tool list to reduce the per-request schema payload (~10.7K
 * tokens for all 46 tools) — the largest single contributor to prompt
 * token usage.
 *
 * Returns deduplicated tool names.
 */
export function selectToolsForMessage(message: string): Set<string> {
  const selected = new Set<string>(CORE_TOOLS);

  // Match categories based on message keywords
  for (const category of Object.values(TOOL_CATEGORIES)) {
    if (category.keywords.test(message)) {
      for (const tool of category.tools) {
        selected.add(tool);
      }
    }
  }

  return selected;
}

// ────────────────────────────────────────────────────────────────
// GeminiService
// ────────────────────────────────────────────────────────────────

/**
 * Manages Gemini model instances and orchestrates the chat loop
 * including function calling, retries, and search grounding.
 */
export class GeminiService {
  private readonly vertexAI: VertexAI;
  private readonly models: Map<string, GenerativeModel> = new Map();
  private readonly availableModels: string[];
  private readonly defaultModel: string;
  private toolDeclarations: FunctionDeclaration[] = [];

  constructor() {
    const project =
      process.env.GOOGLE_CLOUD_PROJECT ?? '';
    const location =
      process.env.GOOGLE_CLOUD_REGION ?? 'us-central1';

    if (!project) {
      throw new Error(
        'GOOGLE_CLOUD_PROJECT environment variable is required.',
      );
    }

    // The Vertex AI SDK builds URLs as https://{location}-aiplatform.googleapis.com
    // but the "global" endpoint uses https://aiplatform.googleapis.com (no prefix).
    // We must override the apiEndpoint when using the global location.
    const vertexOpts: { project: string; location: string; apiEndpoint?: string } = {
      project,
      location,
    };
    if (location === 'global') {
      vertexOpts.apiEndpoint = 'aiplatform.googleapis.com';
    }

    this.vertexAI = new VertexAI(vertexOpts);

    // Parse available models from env
    const modelsEnv =
      process.env.GEMINI_AVAILABLE_MODELS ?? DEFAULT_MODEL;
    this.availableModels = modelsEnv
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m.length > 0);

    if (this.availableModels.length === 0) {
      this.availableModels.push(DEFAULT_MODEL);
    }

    this.defaultModel =
      process.env.GEMINI_DEFAULT_MODEL?.trim() || DEFAULT_MODEL;

    // Ensure default model is in the available list
    if (!this.availableModels.includes(this.defaultModel)) {
      this.availableModels.push(this.defaultModel);
    }

    // Pre-initialize GenerativeModel instances for each available model.
    // Models with a `:thinking-X` suffix get different thinkingConfig.
    for (const modelId of this.availableModels) {
      const { baseModel, thinkingLevel } = parseModelVariant(modelId);

      const genConfig: Record<string, unknown> = {
        temperature: TEMPERATURE,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      };

      // Apply thinkingConfig if a level is specified (undefined = model default)
      if (thinkingLevel) {
        genConfig.thinkingConfig = { thinkingLevel };
      }

      this.models.set(
        modelId,
        this.vertexAI.getGenerativeModel({
          model: baseModel,
          generationConfig: genConfig,
        }),
      );
    }

    logger.info('GeminiService: initialized', {
      project,
      location,
      availableModels: this.availableModels,
      defaultModel: this.defaultModel,
    });
  }

  /**
   * Register tool declarations (called after MCP schema loading).
   */
  initialize(toolDeclarations: FunctionDeclaration[]): void {
    this.toolDeclarations = toolDeclarations;
    logger.info('GeminiService: tool declarations registered', {
      count: toolDeclarations.length,
    });
  }

  /**
   * Return the model name validated against the available list, or the default.
   */
  getModel(modelName?: string): string {
    if (modelName && this.availableModels.includes(modelName)) {
      return modelName;
    }
    return this.defaultModel;
  }

  /**
   * Return the list of available model names.
   */
  getAvailableModels(): string[] {
    return [...this.availableModels];
  }

  /**
   * Main chat method.
   *
   * 1. Builds the request with system prompt + context-windowed history
   *    + current message + tool declarations
   * 2. Sends to Gemini with 30s timeout
   * 3. If function calls returned: execute via onToolCall callback,
   *    send results back, repeat until text
   * 4. Extract search grounding sources if present
   * 5. Return final text + sources + tools used
   */
  async chat(params: ChatParams): Promise<ChatResult> {
    const { message, history, onToolCall, pdfContext, knowledgeContext, files } = params;
    const modelName = this.getModel(params.model);
    const model = this.models.get(modelName);

    if (!model) {
      throw new Error(`Model "${modelName}" is not initialized.`);
    }

    // Detect "continue" requests — allow more rounds for follow-up exploration
    const isContinuation = CONTINUE_PATTERN.test(message.trim());
    const maxRounds = isContinuation ? CONTINUE_MAX_ROUNDS : MAX_FUNCTION_CALL_ROUNDS;
    const windDownRound = isContinuation ? CONTINUE_WIND_DOWN_ROUND : WIND_DOWN_ROUND;
    const maxToolCalls = isContinuation ? CONTINUE_MAX_TOOL_CALLS : MAX_TOOL_CALLS;

    if (isContinuation) {
      logger.info('GeminiService: continuation detected, extending round limits', {
        maxRounds,
        windDownRound,
        maxToolCalls,
      });
    }

    // Build tools array: relevant function declarations + search grounding.
    //
    // Tool subsetting: instead of sending all 46+ schemas (~10.7K tokens) on
    // every request, select only the tools relevant to this message plus a
    // core always-on set. This is computed ONCE per request and reused across
    // all function-call rounds so the request prefix stays byte-identical,
    // which maximizes Vertex implicit cache hits on rounds 2..N.
    //
    // Set DISABLE_TOOL_SUBSETTING=true to fall back to sending all tools.
    const tools: Tool[] = [];
    if (this.toolDeclarations.length > 0) {
      let activeDeclarations = this.toolDeclarations;

      if (process.env.DISABLE_TOOL_SUBSETTING !== 'true') {
        const selectedNames = selectToolsForMessage(message);
        const filtered = this.toolDeclarations.filter((d) =>
          selectedNames.has(d.name),
        );
        // Safety: never send an empty tool list — fall back to all tools.
        activeDeclarations = filtered.length > 0 ? filtered : this.toolDeclarations;

        logger.info('GeminiService: tools selected for request', {
          selected: activeDeclarations.length,
          total: this.toolDeclarations.length,
        });
      } else {
        logger.info('GeminiService: tool subsetting disabled, sending all tools', {
          total: this.toolDeclarations.length,
        });
      }

      const fnTool: FunctionDeclarationsTool = {
        functionDeclarations: activeDeclarations,
      };
      tools.push(fnTool);
    }
    const searchTool = {
      googleSearch: {},
    } as Tool;
    tools.push(searchTool);

    // Build system instruction with optional knowledge context and PDF context
    let systemInstruction = SYSTEM_PROMPT;
    if (knowledgeContext) {
      systemInstruction += `\n\n${knowledgeContext}`;
    }
    if (pdfContext) {
      systemInstruction += `\n\n## Uploaded PDF Content\nThe user has uploaded a PDF document. Here is the extracted text:\n\n${pdfContext}`;
    }

    // Assemble context-windowed history
    const maxMessages = parseInt(
      process.env.MAX_CONTEXT_MESSAGES ?? '20',
      10,
    );
    const windowedHistory = assembleContext(history, maxMessages);

    // Build the current user message with optional file attachments
    const userParts: Part[] = [];

    // Add file inline data parts first (Gemini processes them before text)
    if (files && files.length > 0) {
      for (const file of files) {
        userParts.push({
          inlineData: {
            mimeType: file.mimeType,
            data: file.data,
          },
        });
      }
      logger.info('GeminiService: files attached to request', {
        count: files.length,
        types: files.map((f) => f.mimeType),
        names: files.map((f) => f.filename),
      });
    }

    // Add the text message
    userParts.push({ text: message });

    const userContent: Content = {
      role: 'user',
      parts: userParts,
    };

    // Conversation contents = windowed history + current message
    const contents: Content[] = [...windowedHistory, userContent];

    // Track tool executions and accumulated sources
    const toolsUsed: ToolExecution[] = [];
    const sources: SearchSource[] = [];

    // Circuit breaker: track repeated identical tool failures across rounds.
    // If the model keeps calling the same tool with the same error N times
    // (even interleaved with successful calls), we force wind-down.
    const failureCountBySignature = new Map<string, number>();
    let circuitBreakerTripped = false;

    // Track accumulated token usage across all Gemini rounds
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCachedTokens = 0;

    // Function call loop: keep going until we get a text response
    let round = 0;
    while (round < maxRounds) {
      round++;

      // Wind-down: force text response when we've used too many rounds OR
      // too many total tool calls. This prevents infinite spirals where the
      // model makes 4 parallel calls per round and burns 80+ calls in 20 rounds.
      let roundToolConfig = {
        functionCallingConfig: {
          mode: FunctionCallingMode.AUTO,
        },
      };

      const totalToolCallsSoFar = toolsUsed.length;
      if (round > windDownRound || totalToolCallsSoFar >= maxToolCalls) {
        logger.warn('GeminiService: wind-down active, forcing text response', {
          round,
          windDownRound,
          totalToolCalls: totalToolCallsSoFar,
          maxToolCalls,
        });
        roundToolConfig = {
          functionCallingConfig: {
            mode: FunctionCallingMode.NONE,
          },
        };
      }

      // Circuit breaker: if tripped, force text response immediately
      if (circuitBreakerTripped) {
        logger.warn('GeminiService: circuit breaker active, forcing text response', {
          round,
          failureCounts: Object.fromEntries(failureCountBySignature),
        });
        roundToolConfig = {
          functionCallingConfig: {
            mode: FunctionCallingMode.NONE,
          },
        };
      }

      const request: GenerateContentRequest = {
        contents,
        systemInstruction,
        tools,
        toolConfig: roundToolConfig,
      };

      // Send to Gemini with timeout + retry
      let result: GenerateContentResult;
      try {
        result = await this.callWithRetry(model, request);
      } catch (err) {
        // Handle thought_signature errors gracefully — Gemini 3.x models
        // require thought signatures to be echoed back perfectly. If the
        // conversation history gets corrupted, we recover by trimming the
        // problematic history and returning what we have so far.
        const errMsg = err instanceof Error ? err.message : String(err);

        // Handle input token limit exceeded — tool responses made context too large
        if (errMsg.includes('input token count exceeds') || errMsg.includes('token count exceeds the maximum')) {
          logger.warn('GeminiService: input token limit exceeded, returning partial results', {
            round,
            toolsUsedCount: toolsUsed.length,
            error: errMsg,
          });

          if (toolsUsed.length > 0) {
            const successfulTools = toolsUsed.filter((t) => t.success);
            const toolSummary = successfulTools
              .slice(-10)
              .map((t) => `- **${t.tool}**: ${t.summary}`)
              .join('\n');
            return {
              message: `I gathered too much data and hit a processing limit. Here's what I found so far:\n\n${toolSummary}\n\nPlease ask a more specific question so I can give you a focused answer.`,
              toolsUsed,
              sources,
              usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens, cachedTokens: totalCachedTokens },
            };
          }

          return {
            message: 'Your request generated too much data for me to process at once. Please try a more specific question.',
            toolsUsed: [],
            sources: [],
            usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens, cachedTokens: totalCachedTokens },
          };
        }

        if (errMsg.includes('thought_signature')) {
          logger.warn('GeminiService: thought_signature error, recovering gracefully', {
            round,
            error: errMsg,
            toolsUsedSoFar: toolsUsed.length,
          });

          // If we already executed some tools, return partial results
          if (toolsUsed.length > 0) {
            const toolSummary = toolsUsed
              .map((t) => `- ${t.tool}: ${t.success ? '✓' : '✗'} ${t.summary}`)
              .join('\n');
            return {
              message: `I encountered a technical issue mid-conversation but completed some operations:\n\n${toolSummary}\n\nPlease try your request again if more actions are needed.`,
              toolsUsed,
              sources,
              usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens, cachedTokens: totalCachedTokens },
            };
          }

          // No tools executed yet — return a clean error message
          return {
            message: 'I encountered a technical issue processing this request. Please try again — starting a new message usually resolves this.',
            toolsUsed: [],
            sources: [],
            usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens, cachedTokens: totalCachedTokens },
          };
        }

        // Handle 429 quota exhaustion that survived all retries — give a clear
        // message instead of bubbling up to a generic "unexpected error".
        const isRateLimit =
          errMsg.toLowerCase().includes('429') ||
          errMsg.toLowerCase().includes('too many requests') ||
          errMsg.toLowerCase().includes('resource_exhausted') ||
          errMsg.toLowerCase().includes('resource has been exhausted') ||
          errMsg.toLowerCase().includes('quota');

        if (isRateLimit) {
          logger.warn('GeminiService: rate limit exhausted after retries', {
            round,
            toolsUsedCount: toolsUsed.length,
            error: errMsg,
          });

          if (toolsUsed.length > 0) {
            const successfulTools = toolsUsed.filter((t) => t.success);
            const toolSummary = successfulTools
              .slice(-10)
              .map((t) => `- **${t.tool}**: ${t.summary}`)
              .join('\n');
            return {
              message: `The AI service is handling a lot of requests right now and hit a rate limit. I gathered some data before that happened:\n\n${toolSummary}\n\nPlease wait a few seconds and say **"go on"** to continue.`,
              toolsUsed,
              sources,
              usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens, cachedTokens: totalCachedTokens },
            };
          }

          return {
            message: 'The AI service is busy right now (rate limit reached). Please wait a few seconds and try again.',
            toolsUsed: [],
            sources: [],
            usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens, cachedTokens: totalCachedTokens },
          };
        }
        // Re-throw non-thought_signature errors
        throw err;
      }
      const response = result.response;

      // Accumulate token usage from this round
      const usageMetadata = response.usageMetadata;
      if (usageMetadata) {
        totalPromptTokens += usageMetadata.promptTokenCount ?? 0;
        totalCompletionTokens += usageMetadata.candidatesTokenCount ?? 0;
        totalCachedTokens += usageMetadata.cachedContentTokenCount ?? 0;

        if (usageMetadata.cachedContentTokenCount) {
          logger.info('GeminiService: implicit cache hit', {
            round,
            cachedTokens: usageMetadata.cachedContentTokenCount,
            promptTokens: usageMetadata.promptTokenCount,
            cacheHitPct: Math.round(((usageMetadata.cachedContentTokenCount ?? 0) / (usageMetadata.promptTokenCount ?? 1)) * 100),
          });
        }
      }

      // Extract grounding sources from the response
      const candidate = response.candidates?.[0];
      if (candidate?.groundingMetadata?.groundingChunks) {
        for (const chunk of candidate.groundingMetadata.groundingChunks) {
          const web = chunk.web;
          if (web?.uri && web?.title) {
            // Deduplicate by URL
            if (!sources.some((s) => s.url === web.uri)) {
              sources.push({ title: web.title, url: web.uri });
            }
          }
        }
      }

      // Check if the response contains function calls
      const parts = candidate?.content?.parts ?? [];
      const functionCalls = parts.filter(
        (p): p is { functionCall: FunctionCall } & Part =>
          p.functionCall !== undefined,
      );

      if (functionCalls.length === 0) {
        // No function calls — extract text and return
        const textParts = parts
          .filter((p) => p.text !== undefined)
          .map((p) => p.text as string);
        let finalMessage = textParts.join('');

        if (!finalMessage) {
          // No text at all — check if this is a MAX_TOKENS issue
          const finishReason = candidate?.finishReason;

          if (finishReason === 'MAX_TOKENS') {
            logger.warn('GeminiService: MAX_TOKENS hit with no text output', {
              round,
              toolsUsedCount: toolsUsed.length,
            });

            // If we executed tools, provide a summary of what was done
            if (toolsUsed.length > 0) {
              const successfulTools = toolsUsed.filter((t) => t.success);
              const toolSummary = successfulTools
                .slice(-10) // Last 10 tool calls
                .map((t) => `- **${t.tool}**: ${t.summary}`)
                .join('\n');
              finalMessage = `I gathered the information but ran into a processing limit while composing my response. Here's a summary of what I found:\n\n${toolSummary}\n\nPlease try asking a more specific question so I can give you a focused answer.`;
            } else {
              finalMessage = 'Your request was too complex for me to process in one go. Please try breaking it into smaller, more specific questions.';
            }
          } else {
            logger.warn('GeminiService: no text in final response', {
              round,
              partsCount: parts.length,
              partTypes: parts.map((p) => Object.keys(p).filter(k => k !== '_meta')),
              hasCandidate: !!candidate,
              finishReason,
            });
            finalMessage = 'I was unable to generate a response. Please try rephrasing your question.';
          }
        }

        return { message: finalMessage, toolsUsed, sources, usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens, cachedTokens: totalCachedTokens } };
      }

      // Execute function calls sequentially using the extracted helper
      // Preserve the ENTIRE model response content including thought_signature
      // fields. Gemini 3.x models require thought signatures to be echoed back
      // for function calling to work correctly.
      const assistantContent = candidate!.content;
      contents.push(assistantContent);

      const callDescriptors: FunctionCallDescriptor[] = functionCalls.map(
        (fc) => ({
          name: fc.functionCall.name,
          args: (fc.functionCall.args ?? {}) as Record<string, unknown>,
        }),
      );

      const execResult = await executeSequentialToolCalls(
        callDescriptors,
        onToolCall,
      );

      // Accumulate tool execution records
      for (const te of execResult.toolsUsed) {
        toolsUsed.push(te);
        logger.info('GeminiService: tool executed', {
          tool: te.tool,
          success: te.success,
          ...(te.success ? {} : { error: te.summary }),
        });
      }

      // Circuit breaker: detect repeated identical failures.
      // Track every individual tool failure by tool name alone.
      // If ANY single tool fails MAX_REPEATED_FAILURES times (regardless of
      // the exact error message), trip the breaker. This catches models that
      // vary arguments slightly each retry (e.g., "Contact/new" → "Contact/new_contact").
      const roundFailures = execResult.toolsUsed.filter((te) => !te.success);
      for (const failure of roundFailures) {
        const sig = failure.tool;
        const count = (failureCountBySignature.get(sig) ?? 0) + 1;
        failureCountBySignature.set(sig, count);

        if (count >= MAX_REPEATED_FAILURES && !circuitBreakerTripped) {
          circuitBreakerTripped = true;
          logger.warn('GeminiService: circuit breaker tripped — repeated tool failure', {
            round,
            failureCount: count,
            tool: failure.tool,
            lastError: failure.summary,
          });
        }
      }

      // Build function response parts for Gemini (with size cap to prevent context overflow)
      const functionResponseParts: Part[] = execResult.functionResponses.map(
        (fr) => {
          let response = fr.response;
          const serialized = JSON.stringify(response);

          if (serialized.length > MAX_TOOL_RESPONSE_SIZE) {
            logger.warn('GeminiService: truncating oversized tool response', {
              tool: fr.name,
              originalSize: serialized.length,
              maxSize: MAX_TOOL_RESPONSE_SIZE,
            });
            response = {
              _truncated: true,
              _originalSize: serialized.length,
              message: `Response from ${fr.name} was too large (${Math.round(serialized.length / 1024)}KB). Only the first portion is shown. Please use more specific filters to narrow results.`,
              data: serialized.slice(0, MAX_TOOL_RESPONSE_SIZE),
            };
          }

          return {
            functionResponse: {
              name: fr.name,
              response,
            },
          };
        },
      );

      // Add function responses to the conversation
      const toolResponseContent: Content = {
        role: 'function',
        parts: functionResponseParts,
      };
      contents.push(toolResponseContent);

      logger.info('GeminiService: sending function responses back to Gemini', {
        round,
        responseCount: functionResponseParts.length,
        responseNames: execResult.functionResponses.map((fr) => fr.name),
        responseSizes: execResult.functionResponses.map((fr) => JSON.stringify(fr.response).length),
      });

      // Loop continues — Gemini will process the tool results
    }

    // Safety: if we exhausted the function call loop (should rarely happen
    // now that wind-down forces NONE after round 20)
    logger.warn('GeminiService: max function call rounds reached', {
      rounds: maxRounds,
      toolsUsedCount: toolsUsed.length,
    });

    // Build a useful summary from the tools that were executed
    const successfulTools = toolsUsed.filter((t) => t.success);
    const toolSummary = successfulTools.length > 0
      ? successfulTools
          .slice(-15)
          .map((t) => `- **${t.tool}**: ${t.summary}`)
          .join('\n')
      : 'No tools were successfully executed.';

    return {
      message:
        `I gathered data but reached my processing limit before composing a full answer. Here's what I looked at:\n\n${toolSummary}\n\nYou can say **"go on"** and I'll continue where I left off, or ask a more focused question for a complete answer.`,
      toolsUsed,
      sources,
      usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens, cachedTokens: totalCachedTokens },
    };
  }

  // ── Private helpers ─────────────────────────────────────────

  /**
   * Call Gemini with a timeout and multiple retries on 5xx/429/network
   * errors using exponential backoff. 429 (quota) errors in particular
   * benefit from backed-off retries since Vertex burst limits are transient.
   */
  private async callWithRetry(
    model: GenerativeModel,
    request: GenerateContentRequest,
  ): Promise<GenerateContentResult> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.callWithTimeout(model, request);
      } catch (err) {
        lastError = err;

        if (!isRetryableError(err) || attempt === MAX_RETRIES) {
          throw err;
        }

        // Exponential backoff: 2s, 4s, 8s (capped). 429s need longer waits.
        const errMsg = err instanceof Error ? err.message.toLowerCase() : '';
        const isRateLimit =
          errMsg.includes('429') ||
          errMsg.includes('too many requests') ||
          errMsg.includes('resource_exhausted') ||
          errMsg.includes('resource has been exhausted') ||
          errMsg.includes('quota');

        const baseBackoff = isRateLimit ? RATE_LIMIT_BACKOFF_MS : RETRY_BACKOFF_MS;
        const backoff = Math.min(baseBackoff * Math.pow(2, attempt), MAX_BACKOFF_MS);

        logger.warn('GeminiService: retrying after transient error', {
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          backoffMs: backoff,
          isRateLimit,
          error: err instanceof Error ? err.message : String(err),
        });

        await sleep(backoff);
      }
    }

    throw lastError;
  }

  /**
   * Call generateContent with a 30-second timeout.
   */
  private async callWithTimeout(
    model: GenerativeModel,
    request: GenerateContentRequest,
  ): Promise<GenerateContentResult> {
    return await Promise.race([
      model.generateContent(request),
      rejectAfter(
        API_TIMEOUT_MS,
        'Gemini API call timed out after 120 seconds',
      ),
    ]);
  }
}

// ────────────────────────────────────────────────────────────────
// Utility
// ────────────────────────────────────────────────────────────────

/** Return a promise that rejects after `ms` milliseconds. */
function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    if (timer.unref) {
      timer.unref();
    }
  });
}
