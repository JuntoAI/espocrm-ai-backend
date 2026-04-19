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
import { CRMExecutor } from './services/crm-executor.js';
import { PDFHandler } from './services/pdf-handler.js';
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
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;

// ────────────────────────────────────────────────────────────────
// Bootstrap
// ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info('AI Backend starting…', { port: PORT });

  // 1. Initialize services
  const sessionManager = new SessionManager();
  const rateLimiter = new RateLimiter();
  const crmExecutor = new CRMExecutor();
  const pdfHandler = new PDFHandler(UPLOAD_DIR);

  // 2. Ensure upload directory exists
  await pdfHandler.ensureUploadDir();

  // 3. Load tool schemas — try MCP server first, fall back to hardcoded
  const mcpBridge = new MCPBridge();
  let toolSchemas: typeof HARDCODED_TOOL_SCHEMAS;

  const mcpServerPath = process.env.MCP_SERVER_PATH;
  if (mcpServerPath) {
    try {
      await mcpBridge.connect();
      const mcpSchemas = mcpBridge.getToolSchemas();
      toolSchemas = mcpSchemas as typeof HARDCODED_TOOL_SCHEMAS;
      logger.info('Tool schemas loaded from MCP server', { count: toolSchemas.length });
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
      crmExecutor,
      pdfHandler,
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
