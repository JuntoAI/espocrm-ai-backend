/**
 * In-memory conversation session manager.
 *
 * Maintains per-user conversation sessions with message history,
 * model selection, and optional PDF context. Sessions expire after
 * a configurable timeout (default 30 minutes) and are cleaned up
 * by a periodic interval.
 *
 * @module session-manager
 */

import { v4 as uuidv4 } from 'uuid';

/** Record of a single tool invocation within a conversation turn. */
export interface ToolCallRecord {
  toolName: string;
  args: object;
  result: any;
  success: boolean;
  durationMs: number;
}

/** A single message in a conversation. */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: Date;
  toolCalls?: ToolCallRecord[];
}

/** Uploaded file context attached to a session. */
export interface FileContext {
  filename: string;
  mimeType: string;
  filePath: string;
  size: number;
  uploadedAt: Date;
}

/** @deprecated Use FileContext instead */
export type PdfContext = FileContext & { extractedText: string };

/** A per-user conversation session stored in memory. */
export interface ConversationSession {
  id: string;
  userId: string;
  messages: ConversationMessage[];
  createdAt: Date;
  lastActivity: Date;
  selectedModel: string;
  pdfContext?: PdfContext;
  /** Uploaded files available for Gemini multimodal. */
  files: FileContext[];
}

/** Configuration options for the session manager. */
export interface SessionManagerOptions {
  /** Session timeout in milliseconds. Defaults to `SESSION_TIMEOUT_MS` env or 30 minutes. */
  timeoutMs?: number;
  /** Maximum messages kept in history. Defaults to `MAX_CONTEXT_MESSAGES` env or 20. */
  maxMessages?: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_MESSAGES = 20;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Resolve session timeout from an explicit value, env var, or default.
 */
function resolveTimeout(explicit?: number): number {
  if (explicit !== undefined && explicit > 0) {
    return explicit;
  }
  const env = process.env.SESSION_TIMEOUT_MS;
  if (env !== undefined) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Resolve max messages from an explicit value, env var, or default.
 */
function resolveMaxMessages(explicit?: number): number {
  if (explicit !== undefined && explicit > 0) {
    return explicit;
  }
  const env = process.env.MAX_CONTEXT_MESSAGES;
  if (env !== undefined) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_MAX_MESSAGES;
}

/**
 * Resolve the default Gemini model from env or hardcoded fallback.
 */
function resolveDefaultModel(): string {
  const env = process.env.GEMINI_DEFAULT_MODEL?.trim();
  if (env && env.length > 0) {
    return env;
  }
  return 'gemini-3.5-flash:thinking-low';
}

/**
 * Per-user conversation session manager.
 *
 * Sessions are stored in an in-memory Map keyed by userId.
 * A periodic cleanup removes sessions that have been inactive
 * longer than the configured timeout.
 */
export class SessionManager {
  private readonly sessions: Map<string, ConversationSession> = new Map();
  private readonly timeoutMs: number;
  private readonly maxMessages: number;
  private readonly defaultModel: string;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: SessionManagerOptions) {
    this.timeoutMs = resolveTimeout(options?.timeoutMs);
    this.maxMessages = resolveMaxMessages(options?.maxMessages);
    this.defaultModel = resolveDefaultModel();
  }

  /**
   * Return the existing session for a user, or create a new one.
   */
  getOrCreate(userId: string): ConversationSession {
    const existing = this.sessions.get(userId);
    if (existing) {
      existing.lastActivity = new Date();
      return existing;
    }

    const session: ConversationSession = {
      id: uuidv4(),
      userId,
      messages: [],
      createdAt: new Date(),
      lastActivity: new Date(),
      selectedModel: this.defaultModel,
      files: [],
    };
    this.sessions.set(userId, session);
    return session;
  }

  /**
   * Append a message to a user's conversation history.
   * Creates a session if one doesn't exist.
   * Drops the oldest messages when the history exceeds maxMessages.
   */
  addMessage(userId: string, message: ConversationMessage): void {
    const session = this.getOrCreate(userId);
    session.messages.push(message);

    // Cap history: drop oldest messages beyond the limit.
    if (session.messages.length > this.maxMessages) {
      session.messages = session.messages.slice(
        session.messages.length - this.maxMessages,
      );
    }

    session.lastActivity = new Date();
  }

  /**
   * Return the message history for a user, or an empty array if no session exists.
   */
  getHistory(userId: string): ConversationMessage[] {
    return this.sessions.get(userId)?.messages ?? [];
  }

  /**
   * Update the selected model for a user's session.
   */
  setModel(userId: string, model: string): void {
    const session = this.getOrCreate(userId);
    session.selectedModel = model;
    session.lastActivity = new Date();
  }

  /**
   * Return the selected model for a user, or the default if no session exists.
   */
  getModel(userId: string): string {
    return this.sessions.get(userId)?.selectedModel ?? this.defaultModel;
  }

  /**
   * Store PDF context for a user's session.
   */
  setPdfContext(userId: string, context: PdfContext): void {
    const session = this.getOrCreate(userId);
    session.pdfContext = context;
    session.lastActivity = new Date();
  }

  /**
   * Return the PDF context for a user, or undefined if none is set.
   */
  getPdfContext(userId: string): PdfContext | undefined {
    return this.sessions.get(userId)?.pdfContext;
  }

  /**
   * Add an uploaded file to the user's session for Gemini multimodal.
   */
  addFile(userId: string, file: FileContext): void {
    const session = this.getOrCreate(userId);
    session.files.push(file);
    session.lastActivity = new Date();
  }

  /**
   * Return all uploaded files for a user's session.
   */
  getFiles(userId: string): FileContext[] {
    return this.sessions.get(userId)?.files ?? [];
  }

  /**
   * Delete a user's session and release memory.
   */
  clear(userId: string): void {
    this.sessions.delete(userId);
  }

  /**
   * Remove sessions that have been inactive longer than the timeout.
   *
   * @param now  Current timestamp in ms (injectable for testing).
   */
  cleanup(now: number = Date.now()): void {
    for (const [userId, session] of this.sessions) {
      if (now - session.lastActivity.getTime() > this.timeoutMs) {
        this.sessions.delete(userId);
      }
    }
  }

  /**
   * Start the periodic cleanup interval (every 5 minutes).
   * Does NOT start automatically — the caller must invoke this explicitly.
   */
  startCleanupInterval(): void {
    if (this.cleanupTimer !== null) {
      return; // Already running
    }
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Allow the Node.js process to exit even if the interval is still active.
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Stop the periodic cleanup interval (for graceful shutdown).
   */
  stopCleanupInterval(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Return the number of active sessions.
   */
  getSessionCount(): number {
    return this.sessions.size;
  }
}
