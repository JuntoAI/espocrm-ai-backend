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
 *  - POST /brief         — daily brief generation
 *  - GET  /config        — get user proactive agent config
 *  - PATCH /config       — update user proactive agent config
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
import { createMulterUpload } from './services/pdf-handler.js';
import { PDFHandler } from './services/pdf-handler.js';
import type { MCPBridge } from './services/mcp-bridge.js';
import type { GeminiService, ChatResult } from './services/gemini-service.js';
import type { SessionManager } from './services/session-manager.js';
import type { RateLimiter } from './services/rate-limiter.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { validateChatRequest } from './utils/validators.js';
import { getUserFriendlyMessage } from './utils/error-sanitizer.js';
import { logger } from './utils/logger.js';
import { fetchUrl } from './services/web-fetcher.js';
import { EmailDrafter } from './services/email-drafter.js';
import type { EmailDraftParams } from './services/email-drafter.js';
import { BriefCache } from './services/brief-cache.js';
import { BriefGenerator } from './services/brief-generator.js';
import { CrmAnalyzer } from './services/crm-analyzer.js';
import { UserConfigStore } from './services/user-config-store.js';
import type { KnowledgeStore } from './services/knowledge-store.js';
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
  pdfHandler: PDFHandler;
  knowledgeStore?: KnowledgeStore;
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

/** Shape of the brief response returned to clients. */
export interface BriefResponse {
  recommendations: Array<{
    description: string;
    reason: string;
    suggestedCommand: string;
  }>;
  isAiGenerated: boolean;
  generatedAt: string;
  cacheHit: boolean;
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
    pdfHandler,
    knowledgeStore,
    espocrmUrl,
    uploadDir,
  } = deps;

  const app = express();

  // ── EmailDrafter instance (bypasses MCP bridge) ───────────
  const emailDrafter = new EmailDrafter(
    espocrmUrl ?? process.env.ESPOCRM_URL ?? 'http://localhost:8080',
  );

  // ── Brief generation services ─────────────────────────────
  const resolvedEspocrmUrl = espocrmUrl ?? process.env.ESPOCRM_URL ?? 'http://localhost:8080';
  const userConfigStore = new UserConfigStore(
    process.env.USER_CONFIG_PATH ?? '/data/user-configs',
  );
  const crmAnalyzer = new CrmAnalyzer();
  const briefGenerator = new BriefGenerator(crmAnalyzer, userConfigStore, resolvedEspocrmUrl);
  const briefCache = new BriefCache();

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

  // ── Models endpoint (no auth — lightweight config) ──────
  app.get('/models', (_req: Request, res: Response) => {
    const models = geminiService.getAvailableModels();
    const defaultModel = geminiService.getModel();

    res.json({
      models,
      defaultModel,
    });
  });

  // ── Auth middleware factory ───────────────────────────────
  const authMiddleware = createAuthMiddleware(espocrmUrl);

  // ── Multer for PDF uploads ────────────────────────────────
  const upload = createMulterUpload(uploadDir);

  // ── POST /brief ───────────────────────────────────────────
  app.post(
    '/brief',
    authMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const user = req.validatedUser!;

        // 1. Rate limit check (same 30 req/min as /chat)
        const rateResult = rateLimiter.check(user.userId);
        if (!rateResult.allowed) {
          res.status(429).json({
            error: `Rate limit exceeded. Please wait ${rateResult.retryAfter} seconds.`,
            retryAfter: rateResult.retryAfter,
          });
          return;
        }

        // 2. Check BriefCache for valid entry
        const cachedBrief = briefCache.get(user.userId);
        if (cachedBrief) {
          const response: BriefResponse = {
            recommendations: cachedBrief.recommendations,
            isAiGenerated: cachedBrief.isAiGenerated,
            generatedAt: cachedBrief.generatedAt,
            cacheHit: true,
          };

          logger.info('Brief served from cache', { userId: user.userId });
          res.json(response);
          return;
        }

        // 3. Cache miss — generate fresh brief
        const brief = await briefGenerator.generate(user.apiKey, user.userId);

        // 4. Check if the brief indicates a CRM error (isAiGenerated=false + empty recommendations + empty raw data)
        // The BriefGenerator returns a fallback brief on CRM errors, not a thrown error.
        // We detect CRM-level failures by checking if rawAnalysis has the error shape.

        // 5. Cache the result
        briefCache.set(user.userId, brief);

        // 6. Return BriefResponse
        const response: BriefResponse = {
          recommendations: brief.recommendations,
          isAiGenerated: brief.isAiGenerated,
          generatedAt: brief.generatedAt,
          cacheHit: false,
        };

        logger.info('Brief generated', {
          userId: user.userId,
          recommendationCount: brief.recommendations.length,
          isAiGenerated: brief.isAiGenerated,
        });

        res.json(response);
      } catch (err: unknown) {
        // Map known CRM errors to appropriate HTTP status codes
        if (err instanceof Error) {
          const message = err.message.toLowerCase();

          if (message.includes('auth') || message.includes('401') || message.includes('403')) {
            res.status(502).json({
              error: 'Unable to access CRM data. Please check your API key permissions.',
              code: 'AUTH_FAILED',
            });
            return;
          }

          if (message.includes('timeout') || message.includes('timed out')) {
            res.status(504).json({
              error: 'CRM data retrieval timed out. Please try again.',
              code: 'TIMEOUT',
            });
            return;
          }

          if (message.includes('unavailable') || message.includes('5xx') || message.includes('service')) {
            res.status(502).json({
              error: 'CRM service is temporarily unavailable. Please try again later.',
              code: 'SERVICE_UNAVAILABLE',
            });
            return;
          }
        }

        next(err);
      }
    },
  );

  // ── GET /config ───────────────────────────────────────────
  app.get(
    '/config',
    authMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const user = req.validatedUser!;
        const config = await userConfigStore.get(user.userId);

        res.json({ config });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── PATCH /config ─────────────────────────────────────────
  app.patch(
    '/config',
    authMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const user = req.validatedUser!;
        const body = req.body as Record<string, unknown>;

        // Extract only the allowed config fields from the request body
        const partial: Record<string, unknown> = {};
        if (body.engagementDecayDays !== undefined) {
          partial.engagementDecayDays = body.engagementDecayDays;
        }
        if (body.activityWindowDays !== undefined) {
          partial.activityWindowDays = body.activityWindowDays;
        }

        // Reject if no valid fields provided
        if (Object.keys(partial).length === 0) {
          res.status(400).json({
            error: 'No valid configuration fields provided.',
            validOptions: 'engagementDecayDays (1-90), activityWindowDays (1-30)',
          });
          return;
        }

        // Validate before attempting to set
        const validation = userConfigStore.validate(
          partial as { engagementDecayDays?: number; activityWindowDays?: number },
        );
        if (!validation.valid) {
          res.status(400).json({
            error: validation.errors.join('; '),
            validOptions: 'engagementDecayDays: integer 1-90, activityWindowDays: integer 1-30',
          });
          return;
        }

        // Apply the update
        const updatedConfig = await userConfigStore.set(
          user.userId,
          partial as { engagementDecayDays?: number; activityWindowDays?: number },
        );

        // Invalidate BriefCache so next brief uses new thresholds
        briefCache.invalidate(user.userId);

        // Build confirmation message
        const changes: string[] = [];
        if (partial.engagementDecayDays !== undefined) {
          changes.push(`engagement decay to ${partial.engagementDecayDays} days`);
        }
        if (partial.activityWindowDays !== undefined) {
          changes.push(`activity window to ${partial.activityWindowDays} days`);
        }
        const message = `Updated ${changes.join(' and ')}`;

        logger.info('User config updated', {
          userId: user.userId,
          changes: partial,
        });

        res.json({ config: updatedConfig, message });
      } catch (err) {
        next(err);
      }
    },
  );

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

        // 5b. Load persistent knowledge context (global + per-user)
        const knowledgeContext = knowledgeStore
          ? await knowledgeStore.getContextForUser(user.userId)
          : '';

        // 6. Call Gemini with function call loop (include any uploaded files)
        const sessionFiles = sessionManager.getFiles(user.userId);
        const fileAttachments = sessionFiles.length > 0
          ? await buildFileAttachments(sessionFiles)
          : undefined;

        const chatResult: ChatResult = await geminiService.chat({
          message,
          history,
          onToolCall: async (toolName: string, args: object) => {
            // Route fetch_url to the web fetcher
            if (toolName === 'fetch_url') {
              const url = (args as Record<string, unknown>).url as string;
              return await fetchUrl(url);
            }
            // Route draft_email to EmailDrafter (bypasses MCP bridge)
            if (toolName === 'draft_email') {
              return await emailDrafter.draft(
                args as EmailDraftParams,
                user.apiKey,
              );
            }
            // Route knowledge tools to KnowledgeStore
            if (toolName === 'list_knowledge' && knowledgeStore) {
              const docs = await knowledgeStore.listDocuments(user.userId);
              return { result: JSON.stringify(docs, null, 2) };
            }
            if (toolName === 'update_knowledge' && knowledgeStore) {
              const { scope, filename, content } = args as { scope: 'global' | 'personal'; filename: string; content: string };
              const result = await knowledgeStore.writeDocument(scope, filename, content, user.userId);
              return { result: JSON.stringify(result) };
            }
            if (toolName === 'delete_knowledge' && knowledgeStore) {
              const { scope, filename } = args as { scope: 'global' | 'personal'; filename: string };
              const result = await knowledgeStore.deleteDocument(scope, filename, user.userId);
              return { result: JSON.stringify(result) };
            }
            // Everything else → MCP bridge (CRM Executor)
            return await mcpBridge.callTool(
              toolName,
              args as Record<string, unknown>,
              user.apiKey,
              user.userId,
            );
          },
          model: sessionManager.getModel(user.userId),
          pdfContext: pdfContext?.extractedText,
          knowledgeContext,
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

        res.json({
          ...response,
          model: sessionManager.getModel(user.userId),
          _usage: {
            promptTokens: chatResult.usage.promptTokens,
            completionTokens: chatResult.usage.completionTokens,
            totalTokens: chatResult.usage.totalTokens,
            toolCalls: chatResult.toolsUsed.length,
            toolErrors: chatResult.toolsUsed.filter((t) => !t.success).length,
            toolNames: chatResult.toolsUsed.map((t) => t.tool),
          },
        });
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

          // Load persistent knowledge context
          const knowledgeContext = knowledgeStore
            ? await knowledgeStore.getContextForUser(user.userId)
            : '';

          const chatResult = await geminiService.chat({
            message: bodyMessage,
            history,
            onToolCall: async (toolName: string, args: object) => {
              if (toolName === 'fetch_url') {
                const url = (args as Record<string, unknown>).url as string;
                return await fetchUrl(url);
              }
              // Route draft_email to EmailDrafter (bypasses MCP bridge)
              if (toolName === 'draft_email') {
                return await emailDrafter.draft(
                  args as EmailDraftParams,
                  user.apiKey,
                );
              }
              // Route knowledge tools to KnowledgeStore
              if (toolName === 'list_knowledge' && knowledgeStore) {
                const docs = await knowledgeStore.listDocuments(user.userId);
                return { result: JSON.stringify(docs, null, 2) };
              }
              if (toolName === 'update_knowledge' && knowledgeStore) {
                const { scope, filename, content } = args as { scope: 'global' | 'personal'; filename: string; content: string };
                const result = await knowledgeStore.writeDocument(scope, filename, content, user.userId);
                return { result: JSON.stringify(result) };
              }
              if (toolName === 'delete_knowledge' && knowledgeStore) {
                const { scope, filename } = args as { scope: 'global' | 'personal'; filename: string };
                const result = await knowledgeStore.deleteDocument(scope, filename, user.userId);
                return { result: JSON.stringify(result) };
              }
              return await mcpBridge.callTool(
                toolName,
                args as Record<string, unknown>,
                user.apiKey,
                user.userId,
              );
            },
            model: sessionManager.getModel(user.userId),
            knowledgeContext,
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

          res.json({
            ...response,
            model: sessionManager.getModel(user.userId),
            _usage: {
              promptTokens: chatResult.usage.promptTokens,
              completionTokens: chatResult.usage.completionTokens,
              totalTokens: chatResult.usage.totalTokens,
              toolCalls: chatResult.toolsUsed.length,
              toolErrors: chatResult.toolsUsed.filter((t) => !t.success).length,
              toolNames: chatResult.toolsUsed.map((t) => t.tool),
            },
          });
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

  // ── GET /knowledge ────────────────────────────────────────
  // Returns a summary of loaded knowledge documents (for debugging/admin)
  app.post(
    '/knowledge',
    authMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!knowledgeStore) {
          res.json({ enabled: false, message: 'Knowledge store not configured' });
          return;
        }

        const user = req.validatedUser!;
        const summary = await knowledgeStore.getSummary(user.userId);

        res.json({
          enabled: true,
          global: {
            documentCount: summary.globalDocCount,
            totalChars: summary.globalTotalChars,
            files: summary.globalFiles,
          },
          user: {
            documentCount: summary.userDocCount,
            totalChars: summary.userTotalChars,
            files: summary.userFiles,
          },
        });
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
