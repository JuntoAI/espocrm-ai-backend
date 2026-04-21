/**
 * Express application factory for the AI Backend.
 *
 * Exports `createServer()` which accepts all dependencies and returns
 * a configured Express app. This factory pattern keeps the server
 * testable — integration tests can inject mocks for every service.
 *
 * Routes:
 *  - POST /chat          — main chat endpoint
 *  - POST /chat/upload   — PDF upload + optional chat
 *  - GET  /health        — liveness / readiness probe
 *
 * @module server
 */

import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { createMulterUpload, type UploadedFile } from './services/pdf-handler.js';
import { PDFHandler } from './services/pdf-handler.js';
import type { MCPBridge } from './services/mcp-bridge.js';
import type { GeminiService, ChatResult } from './services/gemini-service.js';
import type { SessionManager } from './services/session-manager.js';
import type { RateLimiter } from './services/rate-limiter.js';
import type { CRMExecutor } from './services/crm-executor.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { validateChatRequest } from './utils/validators.js';
import { getUserFriendlyMessage } from './utils/error-sanitizer.js';
import { logger } from './utils/logger.js';
import { fetchUrl } from './services/web-fetcher.js';
import type { Content } from '@google-cloud/vertexai';
import type { FileAttachment } from './services/gemini-service.js';
import type { FileContext } from './services/session-manager.js';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** Dependencies injected into the server factory. */
export interface ServerDependencies {
  mcpBridge: MCPBridge;
  geminiService: GeminiService;
  sessionManager: SessionManager;
  rateLimiter: RateLimiter;
  crmExecutor: CRMExecutor;
  pdfHandler: PDFHandler;
  espocrmUrl?: string;
  uploadDir?: string;
}

/** Shape of the chat response returned to clients. */
export interface ChatResponse {
  message: string;
  sessionId: string;
  toolsUsed?: Array<{ tool: string; success: boolean; summary: string }>;
  sources?: Array<{ title: string; url: string }>;
}

// ────────────────────────────────────────────────────────────────
// Server factory
// ────────────────────────────────────────────────────────────────

/**
 * Create and configure the Express application with all routes
 * and middleware wired to the provided dependencies.
 */
export function createServer(deps: ServerDependencies): Express {
  const {
    mcpBridge,
    geminiService,
    sessionManager,
    rateLimiter,
    crmExecutor,
    pdfHandler,
    espocrmUrl,
    uploadDir,
  } = deps;

  const app = express();

  // ── Global middleware ─────────────────────────────────────
  app.use(express.json({ limit: '50mb' }));

  // ── Health endpoint (no auth) ─────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    const mcpConnected = mcpBridge.isConnected();

    res.json({
      status: mcpConnected ? 'healthy' : 'degraded',
      mcpConnected,
      geminiReachable: true, // Gemini reachability is best-effort; true unless proven otherwise
      uptime: Math.floor(process.uptime()),
    });
  });

  // ── Auth middleware factory ───────────────────────────────
  const authMiddleware = createAuthMiddleware(espocrmUrl);

  // ── Multer for PDF uploads ────────────────────────────────
  const upload = createMulterUpload(uploadDir);

  // ── POST /chat ────────────────────────────────────────────
  app.post(
    '/chat',
    authMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // 1. Validate request payload
        const validation = validateChatRequest(req.body);
        if (!validation.valid) {
          res.status(400).json({
            error: 'Invalid request payload',
            details: validation.errors,
          });
          return;
        }

        const { message, model } = validation.data;
        const user = req.validatedUser!;

        // 2. Rate limit check
        const rateResult = rateLimiter.check(user.userId);
        if (!rateResult.allowed) {
          res.status(429).json({
            error: `Rate limit exceeded. Please wait ${rateResult.retryAfter} seconds.`,
            retryAfter: rateResult.retryAfter,
          });
          return;
        }

        // 3. Get or create session
        const session = sessionManager.getOrCreate(user.userId);

        // 4. Update model if specified
        if (model) {
          sessionManager.setModel(user.userId, model);
        }

        // 5. Build conversation context
        const history = buildHistory(sessionManager.getHistory(user.userId));
        const pdfContext = sessionManager.getPdfContext(user.userId);

        // 6. Call Gemini with function call loop (include any uploaded files)
        const sessionFiles = sessionManager.getFiles(user.userId);
        const fileAttachments = sessionFiles.length > 0
          ? await buildFileAttachments(sessionFiles)
          : undefined;

        const chatResult: ChatResult = await geminiService.chat({
          message,
          history,
          onToolCall: async (toolName: string, args: object) => {
            // Route fetch_url to the web fetcher, everything else to CRM
            if (toolName === 'fetch_url') {
              const url = (args as Record<string, unknown>).url as string;
              return await fetchUrl(url);
            }
            const result = await crmExecutor.execute(
              toolName,
              args as Record<string, unknown>,
              user.apiKey,
            );
            return result.data;
          },
          model: sessionManager.getModel(user.userId),
          pdfContext: pdfContext?.extractedText,
          files: fileAttachments,
        });

        // 7. Store messages in session
        sessionManager.addMessage(user.userId, {
          role: 'user',
          content: message,
          timestamp: new Date(),
        });
        sessionManager.addMessage(user.userId, {
          role: 'assistant',
          content: chatResult.message,
          timestamp: new Date(),
          toolCalls: chatResult.toolsUsed.map((t) => ({
            toolName: t.tool,
            args: {},
            result: t.summary,
            success: t.success,
            durationMs: 0,
          })),
        });

        // 8. Return response
        const response: ChatResponse = {
          message: chatResult.message,
          sessionId: session.id,
        };
        if (chatResult.toolsUsed.length > 0) {
          response.toolsUsed = chatResult.toolsUsed;
        }
        if (chatResult.sources.length > 0) {
          response.sources = chatResult.sources;
        }

        logger.info('Chat request processed', {
          userId: user.userId,
          sessionId: session.id,
          toolsUsed: chatResult.toolsUsed.length,
        });

        res.json(response);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST /chat/upload ─────────────────────────────────────
  app.post(
    '/chat/upload',
    upload.single('file'),
    authMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const user = req.validatedUser!;

        // 1. Rate limit check
        const rateResult = rateLimiter.check(user.userId);
        if (!rateResult.allowed) {
          res.status(429).json({
            error: `Rate limit exceeded. Please wait ${rateResult.retryAfter} seconds.`,
            retryAfter: rateResult.retryAfter,
          });
          return;
        }

        // 2. Validate file presence
        const file = req.file as Express.Multer.File | undefined;
        if (!file) {
          res.status(400).json({
            error: 'No file uploaded. Please upload a supported file (PDF, PNG, JPEG, GIF, WebP, TXT, CSV, HTML).',
          });
          return;
        }

        // 3. Store file reference in session (no text extraction — Gemini reads files natively)
        const { readFile } = await import('fs/promises');
        const fileBuffer = await readFile(file.path);
        const base64Data = fileBuffer.toString('base64');

        sessionManager.addFile(user.userId, {
          filename: file.originalname,
          mimeType: file.mimetype,
          filePath: file.path,
          size: file.size,
          uploadedAt: new Date(),
        });

        // Schedule file cleanup after 5 minutes
        pdfHandler.scheduleFileDeletionPublic(file.path);

        logger.info('File uploaded', {
          userId: user.userId,
          filename: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
        });

        // 4. Get or create session
        const session = sessionManager.getOrCreate(user.userId);

        // 5. If a message was included, process it with Gemini (with file as inline data)
        const bodyMessage = typeof req.body?.message === 'string'
          ? req.body.message.trim()
          : '';

        if (bodyMessage.length > 0) {
          const history = buildHistory(sessionManager.getHistory(user.userId));

          // Build file attachments from all session files
          const allFiles = sessionManager.getFiles(user.userId);
          const fileAttachments = await buildFileAttachments(allFiles);

          const chatResult = await geminiService.chat({
            message: bodyMessage,
            history,
            onToolCall: async (toolName: string, args: object) => {
              if (toolName === 'fetch_url') {
                const url = (args as Record<string, unknown>).url as string;
                return await fetchUrl(url);
              }
              const result = await crmExecutor.execute(
                toolName,
                args as Record<string, unknown>,
                user.apiKey,
              );
              return result.data;
            },
            model: sessionManager.getModel(user.userId),
            files: fileAttachments,
          });

          sessionManager.addMessage(user.userId, {
            role: 'user',
            content: bodyMessage,
            timestamp: new Date(),
          });
          sessionManager.addMessage(user.userId, {
            role: 'assistant',
            content: chatResult.message,
            timestamp: new Date(),
          });

          const response: ChatResponse = {
            message: chatResult.message,
            sessionId: session.id,
          };
          if (chatResult.toolsUsed.length > 0) {
            response.toolsUsed = chatResult.toolsUsed;
          }
          if (chatResult.sources.length > 0) {
            response.sources = chatResult.sources;
          }

          res.json(response);
          return;
        }

        // No message — just return upload confirmation
        const fileCount = sessionManager.getFiles(user.userId).length;
        res.json({
          message: `"${file.originalname}" uploaded successfully (${fileCount} file${fileCount > 1 ? 's' : ''} in session). You can now ask questions about ${fileCount > 1 ? 'them' : 'it'}.`,
          sessionId: session.id,
        } satisfies ChatResponse);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Global error handler ──────────────────────────────────
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    // Multer file size / type errors
    if (err.message?.includes('File too large') || err.message?.includes('LIMIT_FILE_SIZE')) {
      res.status(400).json({
        error: 'File too large. Please upload a PDF under 20 MB.',
      });
      return;
    }
    if (err.message?.includes('Invalid file type')) {
      res.status(400).json({
        error: err.message,
      });
      return;
    }

    // Log the full error internally
    logger.error('Unhandled error', {
      error: err.message,
      stack: err.stack,
    });

    // Return sanitized error to client
    const userMessage = getUserFriendlyMessage(err);
    res.status(500).json({
      error: userMessage,
    });
  });

  return app;
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/**
 * Convert session message history to Gemini Content[] format.
 */
function buildHistory(
  messages: Array<{ role: string; content: string }>,
): Content[] {
  return messages.map((msg) => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }],
  }));
}

/**
 * Read session files from disk and convert to Gemini FileAttachment format.
 * Silently skips files that no longer exist on disk.
 */
async function buildFileAttachments(files: FileContext[]): Promise<FileAttachment[]> {
  const { readFile } = await import('fs/promises');
  const attachments: FileAttachment[] = [];

  for (const file of files) {
    try {
      const buffer = await readFile(file.filePath);
      attachments.push({
        mimeType: file.mimeType,
        data: buffer.toString('base64'),
        filename: file.filename,
      });
    } catch {
      // File may have been cleaned up — skip silently
      logger.debug('buildFileAttachments: file not found, skipping', {
        filename: file.filename,
        path: file.filePath,
      });
    }
  }

  return attachments;
}
