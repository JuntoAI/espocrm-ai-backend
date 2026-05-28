/**
 * AI Backend entry point.
 *
 * Initializes all services (MCP bridge, Gemini service, session manager,
 * rate limiter, CRM executor, PDF handler), loads MCP schemas at startup,
 * creates and starts the Express server, and sets up graceful shutdown.
 *
 * @module index
 */

import http from 'http';
import { MCPBridge } from './services/mcp-bridge.js';
import { GeminiService } from './services/gemini-service.js';
import { SessionManager } from './services/session-manager.js';
import { RateLimiter } from './services/rate-limiter.js';
import { PDFHandler } from './services/pdf-handler.js';
import { KnowledgeStore } from './services/knowledge-store.js';
import { convertAllSchemas } from './utils/schema-converter.js';
import { HARDCODED_TOOL_SCHEMAS } from './utils/tool-schemas.js';
import { createServer } from './server.js';
import { logger } from './utils/logger.js';
import type { FunctionDeclaration } from '@google-cloud/vertexai';

// ────────────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? '/tmp/uploads';
const KNOWLEDGE_PATH = process.env.KNOWLEDGE_PATH ?? '/data/knowledge';
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;

// ────────────────────────────────────────────────────────────────
// Bootstrap
// ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info('AI Backend starting…', { port: PORT });

  // 1. Initialize services
  const sessionManager = new SessionManager();
  const rateLimiter = new RateLimiter();
  const pdfHandler = new PDFHandler(UPLOAD_DIR);
  const knowledgeStore = new KnowledgeStore(KNOWLEDGE_PATH);

  // 2. Ensure upload directory exists
  await pdfHandler.ensureUploadDir();

  // 2b. Initialize knowledge store (loads global docs)
  await knowledgeStore.initialize();
  knowledgeStore.startRefresh();

  // 3. Load tool schemas — try MCP server first, fall back to hardcoded
  const mcpBridge = new MCPBridge();
  let toolSchemas: typeof HARDCODED_TOOL_SCHEMAS;

  // Backend-only tools (not in MCP server) that must always be registered with Gemini
  const BACKEND_ONLY_TOOLS = HARDCODED_TOOL_SCHEMAS.filter((t) =>
    ['fetch_url', 'draft_email', 'list_knowledge', 'update_knowledge', 'delete_knowledge'].includes(t.name),
  );

  const mcpServerPath = process.env.MCP_SERVER_PATH;
  if (mcpServerPath) {
    try {
      await mcpBridge.connect();
      const mcpSchemas = mcpBridge.getToolSchemas();
      // Merge MCP tools + backend-only tools
      toolSchemas = [...mcpSchemas, ...BACKEND_ONLY_TOOLS] as typeof HARDCODED_TOOL_SCHEMAS;
      logger.info('Tool schemas loaded from MCP server + backend tools', {
        mcpTools: mcpSchemas.length,
        backendTools: BACKEND_ONLY_TOOLS.length,
        total: toolSchemas.length,
      });
    } catch (err) {
      logger.warn('MCP server unavailable, using hardcoded tool schemas', {
        error: err instanceof Error ? err.message : String(err),
      });
      toolSchemas = HARDCODED_TOOL_SCHEMAS;
    }
  } else {
    logger.info('No MCP_SERVER_PATH set, using hardcoded tool schemas', {
      count: HARDCODED_TOOL_SCHEMAS.length,
    });
    toolSchemas = HARDCODED_TOOL_SCHEMAS;
  }

  try {
    // 4. Initialize Gemini service with converted tool declarations
    const geminiService = new GeminiService();
    const toolDeclarations = convertAllSchemas(toolSchemas) as unknown as FunctionDeclaration[];
    geminiService.initialize(toolDeclarations);

    // 5. Start session cleanup interval
    sessionManager.startCleanupInterval();

    // 6. Start PDF cleanup interval
    pdfHandler.startCleanup();

    // 7. Create Express app
    const app = createServer({
      mcpBridge,
      geminiService,
      sessionManager,
      rateLimiter,
      pdfHandler,
      knowledgeStore,
      uploadDir: UPLOAD_DIR,
    });

    // 8. Start HTTP server
    const server = http.createServer(app);
    server.listen(PORT, () => {
      logger.info('AI Backend listening', { port: PORT });
    });

    // 9. Graceful shutdown
    setupGracefulShutdown(server, {
      mcpBridge,
      sessionManager,
      pdfHandler,
      knowledgeStore,
    });
  } catch (err) {
    logger.error('Failed to start AI Backend', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

// ────────────────────────────────────────────────────────────────
// Graceful shutdown
// ────────────────────────────────────────────────────────────────

interface ShutdownDeps {
  mcpBridge: MCPBridge;
  sessionManager: SessionManager;
  pdfHandler: PDFHandler;
  knowledgeStore: KnowledgeStore;
}

function setupGracefulShutdown(
  server: http.Server,
  deps: ShutdownDeps,
): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`Received ${signal}, starting graceful shutdown…`);

    // Stop accepting new connections
    server.close(() => {
      logger.info('HTTP server closed');
    });

    // Wait for in-flight requests (max 10s)
    const forceExit = setTimeout(() => {
      logger.warn('Graceful shutdown timeout — forcing exit');
      process.exit(1);
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      // Cleanup services
      deps.sessionManager.stopCleanupInterval();
      deps.pdfHandler.shutdown();
      deps.knowledgeStore.stopRefresh();
      await deps.mcpBridge.disconnect();

      logger.info('Graceful shutdown complete');
      clearTimeout(forceExit);
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown', {
        error: err instanceof Error ? err.message : String(err),
      });
      clearTimeout(forceExit);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// ────────────────────────────────────────────────────────────────
// Run
// ────────────────────────────────────────────────────────────────

main().catch((err) => {
  logger.error('Unhandled startup error', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
