/**
 * MCP Bridge — persistent stdio connection to the MCP server.
 *
 * Spawns the MCP server as a child process using the
 * `@modelcontextprotocol/sdk` client library over stdio transport.
 * Calls `tools/list` at startup to fetch all tool schemas, then
 * routes tool calls through `tools/call` at runtime.
 *
 * All CRM logic (validation, PATCH vs PUT, field unwrapping, etc.)
 * lives in the MCP server. The bridge is a thin pass-through that
 * injects the per-user API key into each tool call.
 *
 * @module mcp-bridge
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { logger } from '../utils/logger.js';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

/** Simplified MCP tool schema stored in memory after `tools/list`. */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required: string[];
  };
}

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const RECONNECT_TIMEOUT_MS = 5_000;
const MAX_QUEUED_REQUESTS = 10;
const CLIENT_NAME = 'espocrm-ai-backend';
const CLIENT_VERSION = '1.0.0';

// ────────────────────────────────────────────────────────────────
// Queued request helper
// ────────────────────────────────────────────────────────────────

interface QueuedRequest {
  resolve: () => void;
  reject: (err: Error) => void;
}

// ────────────────────────────────────────────────────────────────
// MCPBridge
// ────────────────────────────────────────────────────────────────

/**
 * Manages a single persistent MCP server child process.
 *
 * Lifecycle:
 *  1. `connect(serverPath)` — spawn process, handshake, fetch schemas.
 *  2. `getToolSchemas()`    — return cached schemas (synchronous).
 *  3. `reconnect()`         — re-establish within 5 s, queue callers.
 *  4. `disconnect()`        — kill child, release resources.
 */
export class MCPBridge {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connected = false;
  private reconnecting = false;
  private toolSchemas: ToolSchema[] = [];
  private serverPath: string | null = null;
  private requestQueue: QueuedRequest[] = [];

  // ── Connection ──────────────────────────────────────────────

  /**
   * Spawn the MCP server as a child process, perform the MCP
   * handshake, and call `tools/list` to cache all tool schemas.
   *
   * @param serverPath  Path to the MCP server entry point
   *                    (e.g. `./node_modules/.bin/espocrm-mcp`).
   *                    Falls back to `MCP_SERVER_PATH` env var.
   */
  async connect(serverPath?: string): Promise<void> {
    const resolvedPath =
      serverPath ?? process.env.MCP_SERVER_PATH ?? '';

    if (!resolvedPath) {
      throw new Error(
        'MCP server path is required. Provide it as an argument or set MCP_SERVER_PATH.',
      );
    }

    this.serverPath = resolvedPath;

    logger.info('MCP Bridge: connecting to MCP server', {
      serverPath: resolvedPath,
    });

    await this.establishConnection(resolvedPath);
    await this.loadToolSchemas();

    logger.info('MCP Bridge: connected and schemas loaded', {
      toolCount: this.toolSchemas.length,
    });
  }

  // ── Schema access ───────────────────────────────────────────

  /** Return the cached tool schemas loaded at startup. */
  getToolSchemas(): ToolSchema[] {
    return this.toolSchemas;
  }

  // ── Tool execution ──────────────────────────────────────────

  /**
   * Execute a tool call via the MCP server.
   *
   * Injects the user's API key as `_apiKeyOverride` so the MCP
   * server uses per-user permissions. The MCP server strips this
   * field before passing args to the tool handler.
   *
   * @param toolName    MCP tool name (e.g. `create_contact`)
   * @param args        Tool arguments from Gemini function call
   * @param userApiKey  The requesting user's EspoCRM API key
   * @returns           The text content from the MCP tool result
   * @throws            Error if the bridge is disconnected or the
   *                    MCP server returns an error
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    userApiKey: string,
    userId?: string,
  ): Promise<unknown> {
    if (!this.client || !this.connected) {
      // Try to wait for reconnection if one is in progress
      if (this.reconnecting) {
        await this.waitForConnection();
      } else {
        throw new Error('MCP Bridge: not connected');
      }
    }

    const result = await this.client!.callTool({
      name: toolName,
      arguments: {
        ...args,
        _apiKeyOverride: userApiKey,
        ...(userId ? { _userIdOverride: userId } : {}),
      },
    });

    // Check for MCP-level errors
    if (result.isError) {
      const errorText = Array.isArray(result.content)
        ? result.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n')
        : String(result.content);
      throw new Error(`MCP tool error (${toolName}): ${errorText}`);
    }

    // Extract text content from the MCP result and wrap
    // in a structured object. Gemini function calling expects
    // tool results to be objects, not plain strings.
    if (Array.isArray(result.content)) {
      const textParts = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text);
      return { result: textParts.join('\n') };
    }

    return { result: result.content };
  }

  // ── Reconnection ────────────────────────────────────────────

  /**
   * Re-establish the MCP connection within 5 seconds.
   *
   * Incoming callers that invoke `waitForConnection()` while a
   * reconnect is in progress are queued (max 10). Once the
   * connection is restored the queue is drained. If reconnection
   * fails, all queued callers are rejected.
   */
  async reconnect(): Promise<void> {
    if (this.reconnecting) {
      // Already reconnecting — callers should use waitForConnection().
      return;
    }

    if (!this.serverPath) {
      throw new Error('MCP Bridge: cannot reconnect — no server path configured.');
    }

    this.reconnecting = true;
    this.connected = false;

    logger.warn('MCP Bridge: reconnecting…');

    try {
      // Clean up old transport silently.
      await this.closeTransport();

      // Race the reconnection against a 5-second deadline.
      await Promise.race([
        this.establishConnection(this.serverPath),
        rejectAfter(RECONNECT_TIMEOUT_MS, 'MCP reconnection timed out'),
      ]);

      await this.loadToolSchemas();

      logger.info('MCP Bridge: reconnected successfully', {
        toolCount: this.toolSchemas.length,
      });

      // Drain the queue — all waiters succeed.
      this.drainQueue(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown reconnection error';
      logger.error('MCP Bridge: reconnection failed', { error: message });

      // Reject all queued callers.
      this.drainQueue(new Error(`MCP reconnection failed: ${message}`));
      throw err;
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * Wait for an in-progress reconnection to complete.
   *
   * If the queue is full (≥ MAX_QUEUED_REQUESTS), the returned
   * promise rejects immediately.
   */
  waitForConnection(): Promise<void> {
    if (this.connected && !this.reconnecting) {
      return Promise.resolve();
    }

    if (this.requestQueue.length >= MAX_QUEUED_REQUESTS) {
      return Promise.reject(
        new Error(
          'MCP Bridge: request queue full — too many requests during reconnection.',
        ),
      );
    }

    return new Promise<void>((resolve, reject) => {
      this.requestQueue.push({ resolve, reject });
    });
  }

  // ── Disconnect ──────────────────────────────────────────────

  /** Kill the child process and release all resources. */
  async disconnect(): Promise<void> {
    logger.info('MCP Bridge: disconnecting');
    this.drainQueue(new Error('MCP Bridge: disconnected'));
    await this.closeTransport();
    this.client = null;
    this.connected = false;
    this.serverPath = null;
  }

  // ── Status ──────────────────────────────────────────────────

  /** Whether the MCP client is currently connected. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Number of requests queued while reconnecting. */
  getQueueSize(): number {
    return this.requestQueue.length;
  }

  // ── Private helpers ─────────────────────────────────────────

  /**
   * Spawn the child process, create the MCP client, and connect.
   */
  private async establishConnection(serverPath: string): Promise<void> {
    const serverParams: StdioServerParameters = {
      command: 'node',
      args: [serverPath],
      stderr: 'pipe',
      env: {
        ...process.env,
        // Schema-only mode skips the connection test at startup (no API key
        // needed). Actual tool calls use per-user API keys injected via
        // _apiKeyOverride, so the default client is never used at runtime.
        SCHEMA_ONLY: 'true',
        ESPOCRM_URL: process.env.ESPOCRM_URL ?? 'http://localhost:8080',
        ESPOCRM_API_KEY: process.env.ESPOCRM_API_KEY ?? 'schema-only',
        // Suppress all logging — the stdio transport expects only JSON-RPC
        // on stdout. Any console.log or Winston output breaks the protocol.
        LOG_LEVEL: 'error',
        // Disable colored output which also breaks JSON-RPC parsing
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
    };

    this.transport = new StdioClientTransport(serverParams);

    // Detect child process crash via the transport's onclose callback.
    this.transport.onclose = () => {
      if (this.connected) {
        logger.error('MCP Bridge: child process closed unexpectedly');
        this.connected = false;
        // Fire-and-forget reconnection attempt.
        this.reconnect().catch((err) => {
          logger.error('MCP Bridge: auto-reconnect failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    };

    this.transport.onerror = (error: Error) => {
      logger.error('MCP Bridge: transport error', {
        error: error.message,
      });
    };

    this.client = new Client(
      { name: CLIENT_NAME, version: CLIENT_VERSION },
      { capabilities: {} },
    );

    await this.client.connect(this.transport);
    this.connected = true;
  }

  /**
   * Fetch tool schemas from the MCP server via `tools/list` and
   * cache them in memory.
   */
  private async loadToolSchemas(): Promise<void> {
    if (!this.client) {
      throw new Error('MCP Bridge: client not initialised');
    }

    const result = await this.client.listTools();

    this.toolSchemas = result.tools.map((tool): ToolSchema => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: {
        type: 'object',
        properties: (tool.inputSchema.properties as Record<string, any>) ?? {},
        required: (tool.inputSchema.required as string[]) ?? [],
      },
    }));
  }

  /**
   * Gracefully close the transport (kills the child process).
   */
  private async closeTransport(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // Swallow — the process may already be dead.
      }
      this.transport = null;
    }
  }

  /**
   * Resolve or reject every queued request, then clear the queue.
   */
  private drainQueue(error: Error | null): void {
    const queue = this.requestQueue.splice(0);
    for (const req of queue) {
      if (error) {
        req.reject(error);
      } else {
        req.resolve();
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────
// Utility
// ────────────────────────────────────────────────────────────────

/** Return a promise that rejects after `ms` milliseconds. */
function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    // Don't keep the process alive just for this timer.
    if (timer.unref) {
      timer.unref();
    }
  });
}
