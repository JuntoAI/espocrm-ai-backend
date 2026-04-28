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
}

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'gemini-3.1-flash-lite-preview';
const TEMPERATURE = 0.3;
const MAX_OUTPUT_TOKENS = 2048;
const API_TIMEOUT_MS = 120_000;
const RETRY_BACKOFF_MS = 2_000;
const MAX_FUNCTION_CALL_ROUNDS = 20;

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

## Response Formatting
- Use markdown formatting in responses
- Use **bold** for emphasis and entity names
- Use bullet lists for multiple items
- Use code blocks for IDs or technical values
- Keep responses concise and actionable
- When showing search results, format them as readable lists with key fields
- IMPORTANT: When referencing CRM records (contacts, accounts, leads, opportunities, meetings, tasks, cases), ALWAYS include a clickable link using this exact format: [Record Name](#EntityType/view/RECORD_ID)
  - Examples: [Maria Mc Menamin](#Contact/view/abc123), [Sure Valley Ventures](#Account/view/def456), [Series A Deal](#Opportunity/view/ghi789)
  - Use the entity type with capital first letter: Contact, Account, Lead, Opportunity, Meeting, Task, Case, Call
  - Always use the record ID returned by the CRM tools
  - For search results, include a link for each record found`;

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
    // "Internal" or "unavailable" server errors
    if (msg.includes('internal') || msg.includes('unavailable')) {
      return true;
    }
  }
  // Check for status code on error-like objects
  const obj = error as Record<string, unknown>;
  if (typeof obj?.status === 'number' && obj.status >= 500) {
    return true;
  }
  if (typeof obj?.statusCode === 'number' && obj.statusCode >= 500) {
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
    keywords: /\b(note|comment|remark|annotation)\b/i,
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
};

/**
 * Select relevant tools based on the user message.
 * Always includes a core set (search_contacts, search_accounts) as fallback.
 * Returns deduplicated tool names.
 */
export function selectToolsForMessage(message: string): Set<string> {
  const selected = new Set<string>();

  // Always include core search tools — the model often needs these
  selected.add('search_contacts');
  selected.add('search_accounts');

  // Match categories based on message keywords
  for (const category of Object.values(TOOL_CATEGORIES)) {
    if (category.keywords.test(message)) {
      for (const tool of category.tools) {
        selected.add(tool);
      }
    }
  }

  // If nothing matched beyond defaults, include all search tools
  // so the model can still discover data
  if (selected.size <= 2) {
    selected.add('search_opportunities');
    selected.add('search_leads');
    selected.add('search_meetings');
    selected.add('search_tasks');
    selected.add('search_users');
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

    // Pre-initialize GenerativeModel instances for each available model
    for (const modelName of this.availableModels) {
      this.models.set(
        modelName,
        this.vertexAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            temperature: TEMPERATURE,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
          },
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
    const { message, history, onToolCall, pdfContext, files } = params;
    const modelName = this.getModel(params.model);
    const model = this.models.get(modelName);

    if (!model) {
      throw new Error(`Model "${modelName}" is not initialized.`);
    }

    // Build tools array: all function declarations + search grounding
    const tools: Tool[] = [];
    if (this.toolDeclarations.length > 0) {
      const fnTool: FunctionDeclarationsTool = {
        functionDeclarations: this.toolDeclarations,
      };
      tools.push(fnTool);
      logger.info('GeminiService: all tools included in request', {
        total: this.toolDeclarations.length,
      });
    }
    const searchTool = {
      googleSearch: {},
    } as Tool;
    tools.push(searchTool);

    // Build system instruction with optional PDF context
    let systemInstruction = SYSTEM_PROMPT;
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

    // Function call loop: keep going until we get a text response
    let round = 0;
    while (round < MAX_FUNCTION_CALL_ROUNDS) {
      round++;

      const request: GenerateContentRequest = {
        contents,
        systemInstruction,
        tools,
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingMode.AUTO,
          },
        },
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
            };
          }

          // No tools executed yet — return a clean error message
          return {
            message: 'I encountered a technical issue processing this request. Please try again — starting a new message usually resolves this.',
            toolsUsed: [],
            sources: [],
          };
        }
        // Re-throw non-thought_signature errors
        throw err;
      }
      const response = result.response;

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
        const finalMessage =
          textParts.join('') || 'I was unable to generate a response.';

        if (!textParts.length) {
          logger.warn('GeminiService: no text in final response', {
            round,
            partsCount: parts.length,
            partTypes: parts.map((p) => Object.keys(p).filter(k => k !== '_meta')),
            hasCandidate: !!candidate,
            finishReason: candidate?.finishReason,
          });
        }

        return { message: finalMessage, toolsUsed, sources };
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

      // Build function response parts for Gemini
      const functionResponseParts: Part[] = execResult.functionResponses.map(
        (fr) => ({
          functionResponse: {
            name: fr.name,
            response: fr.response,
          },
        }),
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

    // Safety: if we exhausted the function call loop
    logger.warn('GeminiService: max function call rounds reached', {
      rounds: MAX_FUNCTION_CALL_ROUNDS,
    });
    return {
      message:
        'I completed several operations but reached the maximum number of steps. Here is what I did so far.',
      toolsUsed,
      sources,
    };
  }

  // ── Private helpers ─────────────────────────────────────────

  /**
   * Call Gemini with a 30-second timeout and single retry on
   * 5xx/network errors with 2s backoff.
   */
  private async callWithRetry(
    model: GenerativeModel,
    request: GenerateContentRequest,
  ): Promise<GenerateContentResult> {
    try {
      return await this.callWithTimeout(model, request);
    } catch (firstError) {
      if (isRetryableError(firstError)) {
        logger.warn('GeminiService: retrying after transient error', {
          error:
            firstError instanceof Error
              ? firstError.message
              : String(firstError),
        });
        await sleep(RETRY_BACKOFF_MS);
        return await this.callWithTimeout(model, request);
      }
      throw firstError;
    }
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
