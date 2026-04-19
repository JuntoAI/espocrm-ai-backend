/**
 * Integration tests for auth flow and permission scoping.
 *
 * Validates the full request flow through the Express app:
 *  - Valid EspoCRM session → successful chat response
 *  - Invalid session → 401 rejection
 *  - Missing auth → 401 rejection
 *  - Two users with different API keys → each user's key used for their requests
 *  - Rate limiting → 31st request returns 429
 *
 * Uses createServer() factory with:
 *  - Fake EspoCRM server (Express) for API key validation
 *  - Mock GeminiService (canned response)
 *  - Mock MCPBridge (reports connected)
 *  - Real SessionManager, RateLimiter, CRMExecutor, PDFHandler
 *
 * Validates: Requirements 3.3, 6.2, 6.3, 6.4, 6.5
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from '@jest/globals';
import express, { type Express, type Request, type Response } from 'express';
import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createServer, type ServerDependencies } from '../../src/server.js';
import { SessionManager } from '../../src/services/session-manager.js';
import { RateLimiter } from '../../src/services/rate-limiter.js';
import { CRMExecutor } from '../../src/services/crm-executor.js';
import { PDFHandler } from '../../src/services/pdf-handler.js';
import type { MCPBridge } from '../../src/services/mcp-bridge.js';
import type {
  GeminiService,
  ChatParams,
  ChatResult,
} from '../../src/services/gemini-service.js';

// ────────────────────────────────────────────────────────────────
// Test users
// ────────────────────────────────────────────────────────────────

const USER_A = {
  apiKey: 'user-a-valid-api-key-abc123',
  userId: 'user-a-id',
  userName: 'Alice',
};

const USER_B = {
  apiKey: 'user-b-valid-api-key-xyz789',
  userId: 'user-b-id',
  userName: 'Bob',
};

// ────────────────────────────────────────────────────────────────
// Fake EspoCRM server
// ────────────────────────────────────────────────────────────────

let fakeEspoApp: Express;
let fakeEspoServer: http.Server;
let fakeEspoPort: number;

/** Track all API keys received by the fake EspoCRM server. */
let receivedApiKeys: string[] = [];

function setupFakeEspoCRM(): Express {
  const app = express();

  app.get('/api/v1/App/user', (req: Request, res: Response) => {
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (apiKey) {
      receivedApiKeys.push(apiKey);
    }

    if (apiKey === USER_A.apiKey) {
      res.json({ userName: USER_A.userName, id: USER_A.userId });
    } else if (apiKey === USER_B.apiKey) {
      res.json({ userName: USER_B.userName, id: USER_B.userId });
    } else {
      res.status(401).json({ error: 'Unauthorized' });
    }
  });

  return app;
}

// ────────────────────────────────────────────────────────────────
// Mock GeminiService
// ────────────────────────────────────────────────────────────────

function createMockGeminiService(): GeminiService {
  return {
    chat: async (_params: ChatParams): Promise<ChatResult> => {
      return {
        message: 'Mock AI response: I can help you with that.',
        toolsUsed: [],
        sources: [],
      };
    },
    getModel: (modelName?: string) =>
      modelName ?? 'gemini-3.1-flash-lite-preview',
    getAvailableModels: () => [
      'gemini-3.1-pro-preview',
      'gemini-3.1-flash-lite-preview',
    ],
    initialize: () => {},
  } as unknown as GeminiService;
}

// ────────────────────────────────────────────────────────────────
// Mock MCPBridge
// ────────────────────────────────────────────────────────────────

function createMockMCPBridge(): MCPBridge {
  return {
    isConnected: () => true,
    getToolSchemas: () => [],
    connect: async () => {},
    disconnect: async () => {},
    reconnect: async () => {},
    waitForConnection: async () => {},
    getQueueSize: () => 0,
  } as unknown as MCPBridge;
}

// ────────────────────────────────────────────────────────────────
// Test infrastructure
// ────────────────────────────────────────────────────────────────

let appServer: http.Server;
let appPort: number;
let tmpDir: string;
let sessionManager: SessionManager;
let rateLimiter: RateLimiter;

/**
 * POST to the app server and return status + parsed JSON body.
 */
async function postChat(
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${appPort}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body: json };
}

// ────────────────────────────────────────────────────────────────
// Setup / Teardown
// ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Start fake EspoCRM server
  fakeEspoApp = setupFakeEspoCRM();
  await new Promise<void>((resolve) => {
    fakeEspoServer = fakeEspoApp.listen(0, () => {
      const addr = fakeEspoServer.address();
      fakeEspoPort =
        typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve();
    });
  });

  // 2. Create temp directory for PDF uploads
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-flow-test-'));

  // 3. Build the real app with mock + real dependencies
  sessionManager = new SessionManager({ timeoutMs: 30 * 60 * 1000, maxMessages: 20 });
  rateLimiter = new RateLimiter({ maxRequests: 30, windowMs: 60_000 });

  const espocrmUrl = `http://127.0.0.1:${fakeEspoPort}`;

  const deps: ServerDependencies = {
    mcpBridge: createMockMCPBridge(),
    geminiService: createMockGeminiService(),
    sessionManager,
    rateLimiter,
    crmExecutor: new CRMExecutor(espocrmUrl),
    pdfHandler: new PDFHandler(tmpDir),
    espocrmUrl,
    uploadDir: tmpDir,
  };

  const app = createServer(deps);

  // 4. Start the app server
  await new Promise<void>((resolve) => {
    appServer = app.listen(0, () => {
      const addr = appServer.address();
      appPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve();
    });
  });
});

afterAll(async () => {
  // Shutdown app server
  await new Promise<void>((resolve, reject) => {
    appServer.close((err) => (err ? reject(err) : resolve()));
  });

  // Shutdown fake EspoCRM server
  await new Promise<void>((resolve, reject) => {
    fakeEspoServer.close((err) => (err ? reject(err) : resolve()));
  });

  // Clean up temp directory
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  receivedApiKeys = [];
  rateLimiter.resetAll();
});

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('Integration: Auth flow and permission scoping', () => {
  // ── 1. Valid auth ───────────────────────────────────────────

  describe('valid authentication', () => {
    it('returns 200 with chat response for a valid API key', async () => {
      const { status, body } = await postChat({
        message: 'Show me all contacts',
        userApiKey: USER_A.apiKey,
        userId: USER_A.userId,
        userName: USER_A.userName,
      });

      expect(status).toBe(200);
      expect(body).toHaveProperty('message');
      expect(typeof body.message).toBe('string');
      expect((body.message as string).length).toBeGreaterThan(0);
      expect(body).toHaveProperty('sessionId');
      expect(typeof body.sessionId).toBe('string');
    });

    it('validates the API key against the fake EspoCRM server', async () => {
      await postChat({
        message: 'Hello',
        userApiKey: USER_A.apiKey,
        userId: USER_A.userId,
      });

      expect(receivedApiKeys).toContain(USER_A.apiKey);
    });
  });

  // ── 2. Invalid auth ─────────────────────────────────────────

  describe('invalid authentication', () => {
    it('returns 401 for an invalid API key', async () => {
      const { status, body } = await postChat({
        message: 'Show me all contacts',
        userApiKey: 'totally-bogus-key',
        userId: 'some-user',
      });

      expect(status).toBe(401);
      expect(body).toHaveProperty('error');
      expect(typeof body.error).toBe('string');
    });

    it('does not return a chat message on invalid auth', async () => {
      const { body } = await postChat({
        message: 'Show me all contacts',
        userApiKey: 'invalid-key',
        userId: 'some-user',
      });

      // Should not have a sessionId or AI message
      expect(body).not.toHaveProperty('sessionId');
    });
  });

  // ── 3. Missing auth ─────────────────────────────────────────

  describe('missing authentication', () => {
    it('returns 401 when userApiKey is missing', async () => {
      const { status } = await postChat({
        message: 'Hello',
        userId: 'user-001',
      });

      expect(status).toBe(401);
    });

    it('returns 401 when userId is missing', async () => {
      const { status } = await postChat({
        message: 'Hello',
        userApiKey: USER_A.apiKey,
      });

      expect(status).toBe(401);
    });

    it('returns 401 when body is empty', async () => {
      const { status } = await postChat({});

      expect(status).toBe(401);
    });

    it('does not call EspoCRM when credentials are absent', async () => {
      await postChat({ message: 'Hello' });

      // No API key should have been sent to the fake server
      expect(receivedApiKeys).toHaveLength(0);
    });
  });

  // ── 4. Two users — per-user credential scoping ──────────────

  describe('two users with different API keys', () => {
    it('User A and User B both get successful responses', async () => {
      const resA = await postChat({
        message: 'User A message',
        userApiKey: USER_A.apiKey,
        userId: USER_A.userId,
        userName: USER_A.userName,
      });

      const resB = await postChat({
        message: 'User B message',
        userApiKey: USER_B.apiKey,
        userId: USER_B.userId,
        userName: USER_B.userName,
      });

      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      expect(resA.body).toHaveProperty('message');
      expect(resB.body).toHaveProperty('message');
    });

    it('each user API key is forwarded to EspoCRM for validation', async () => {
      await postChat({
        message: 'Alice says hi',
        userApiKey: USER_A.apiKey,
        userId: USER_A.userId,
      });

      await postChat({
        message: 'Bob says hi',
        userApiKey: USER_B.apiKey,
        userId: USER_B.userId,
      });

      // Both keys should have been received by the fake EspoCRM server
      expect(receivedApiKeys).toContain(USER_A.apiKey);
      expect(receivedApiKeys).toContain(USER_B.apiKey);
    });

    it('each user gets their own session', async () => {
      const resA = await postChat({
        message: 'Session test A',
        userApiKey: USER_A.apiKey,
        userId: USER_A.userId,
      });

      const resB = await postChat({
        message: 'Session test B',
        userApiKey: USER_B.apiKey,
        userId: USER_B.userId,
      });

      const sessionA = resA.body.sessionId as string;
      const sessionB = resB.body.sessionId as string;

      expect(sessionA).toBeDefined();
      expect(sessionB).toBeDefined();
      // Different users should get different sessions
      expect(sessionA).not.toBe(sessionB);
    });
  });

  // ── 5. Rate limiting ────────────────────────────────────────

  describe('rate limiting', () => {
    it('allows 30 requests then rejects the 31st with 429', async () => {
      const userId = 'rate-limit-test-user';
      const apiKey = USER_A.apiKey;

      // Send 30 requests — all should succeed
      for (let i = 0; i < 30; i++) {
        const { status } = await postChat({
          message: `Request ${i + 1}`,
          userApiKey: apiKey,
          userId,
        });
        expect(status).toBe(200);
      }

      // 31st request should be rate limited
      const { status, body } = await postChat({
        message: 'Request 31 — should be rejected',
        userApiKey: apiKey,
        userId,
      });

      expect(status).toBe(429);
      expect(body).toHaveProperty('error');
      expect(typeof body.error).toBe('string');
      expect(body).toHaveProperty('retryAfter');
      expect(typeof body.retryAfter).toBe('number');
      expect(body.retryAfter as number).toBeGreaterThan(0);
    });

    it('rate limits are per-user — User B is not affected by User A', async () => {
      // Exhaust User A's rate limit
      for (let i = 0; i < 30; i++) {
        await postChat({
          message: `A-${i}`,
          userApiKey: USER_A.apiKey,
          userId: USER_A.userId,
        });
      }

      // User A should be rate limited
      const resA = await postChat({
        message: 'A-31',
        userApiKey: USER_A.apiKey,
        userId: USER_A.userId,
      });
      expect(resA.status).toBe(429);

      // User B should still be allowed
      const resB = await postChat({
        message: 'B-1',
        userApiKey: USER_B.apiKey,
        userId: USER_B.userId,
      });
      expect(resB.status).toBe(200);
    });
  });

  // ── Health endpoint (no auth required) ──────────────────────

  describe('health endpoint', () => {
    it('returns healthy status without authentication', async () => {
      const res = await fetch(`http://127.0.0.1:${appPort}/health`);
      const body = (await res.json()) as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect(body).toHaveProperty('status', 'healthy');
      expect(body).toHaveProperty('mcpConnected', true);
      expect(body).toHaveProperty('uptime');
    });
  });
});
