/**
 * Integration tests for POST /brief endpoint.
 *
 * Validates:
 *  - POST /brief returns 200 with BriefResponse shape
 *  - POST /brief returns cacheHit: false on first call, cacheHit: true on second
 *  - POST /brief returns 401 when auth fails (invalid API key)
 *  - POST /brief returns 401 when credentials are missing
 *  - POST /brief returns 429 when rate limit is exceeded
 *  - POST /brief returns valid brief in fallback mode (isAiGenerated: false)
 *  - Response contains all required fields
 *
 * Validates: Requirements 2.4, 2.6, 6.4
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from '@jest/globals';
import express, { type Express, type Request, type Response } from 'express';
import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createServer, type ServerDependencies } from '../../src/server.js';
import { SessionManager } from '../../src/services/session-manager.js';
import { RateLimiter } from '../../src/services/rate-limiter.js';
import { PDFHandler } from '../../src/services/pdf-handler.js';
import type { MCPBridge } from '../../src/services/mcp-bridge.js';
import type {
  GeminiService,
  ChatParams,
  ChatResult,
} from '../../src/services/gemini-service.js';

// ────────────────────────────────────────────────────────────────
// Test user
// ────────────────────────────────────────────────────────────────

const TEST_USER = {
  apiKey: 'brief-test-valid-api-key-xyz789',
  userId: 'brief-test-user-id',
  userName: 'BriefTester',
};

// ────────────────────────────────────────────────────────────────
// Fake EspoCRM server
// ────────────────────────────────────────────────────────────────

let fakeEspoApp: Express;
let fakeEspoServer: http.Server;
let fakeEspoPort: number;

/**
 * Helper to extract where clause info from Express-parsed query params.
 * Express with qs parses `where[0][type]=in` into nested objects:
 * `req.query.where` = [{ type: 'in', attribute: 'status', value: [...] }]
 */
function getWhereClause(query: Record<string, unknown>): Array<{ type?: string; attribute?: string; value?: unknown }> {
  const where = query.where;
  if (Array.isArray(where)) {
    return where as Array<{ type?: string; attribute?: string; value?: unknown }>;
  }
  if (where && typeof where === 'object') {
    // qs may parse as object with numeric keys: { '0': {...}, '1': {...} }
    return Object.values(where) as Array<{ type?: string; attribute?: string; value?: unknown }>;
  }
  return [];
}

function setupFakeEspoCRM(): Express {
  const app = express();

  // Auth validation endpoint
  app.get('/api/v1/App/user', (req: Request, res: Response) => {
    const apiKey = req.headers['x-api-key'] as string | undefined;

    if (apiKey === TEST_USER.apiKey) {
      res.json({ userName: TEST_USER.userName, id: TEST_USER.userId });
    } else {
      res.status(401).json({ error: 'Unauthorized' });
    }
  });

  // Mock Meeting data
  app.get('/api/v1/Meeting', (_req: Request, res: Response) => {
    res.json({
      total: 1,
      list: [
        {
          id: 'meeting-1',
          parentType: 'Account',
          parentId: 'account-active-1',
          dateStart: new Date().toISOString(),
          status: 'Held',
        },
      ],
    });
  });

  // Mock Call data
  app.get('/api/v1/Call', (_req: Request, res: Response) => {
    res.json({
      total: 1,
      list: [
        {
          id: 'call-1',
          parentType: 'Account',
          parentId: 'account-active-1',
          dateStart: new Date().toISOString(),
          status: 'Held',
        },
      ],
    });
  });

  // Mock Task data (returns different data based on where clauses)
  app.get('/api/v1/Task', (req: Request, res: Response) => {
    const whereClauses = getWhereClause(req.query as Record<string, unknown>);
    const firstClause = whereClauses[0];

    // Overdue tasks query: where[0][type]=in (status IN [Not Started, Started])
    if (firstClause?.type === 'in') {
      res.json({
        total: 1,
        list: [
          {
            id: 'task-overdue-1',
            name: 'Send pitch deck',
            assignedUserName: 'Markus',
            dateEnd: '2025-01-01',
            status: 'Not Started',
          },
        ],
      });
      return;
    }

    // Activity summary: completed tasks (where[0][type]=equals, where[0][value]=Completed)
    if (firstClause?.type === 'equals' && firstClause?.value === 'Completed') {
      res.json({
        total: 1,
        list: [
          {
            id: 'task-completed-1',
            modifiedAt: new Date().toISOString(),
            status: 'Completed',
          },
        ],
      });
      return;
    }

    // Default: tasks for Active_Account_Set building (where[0][type]=after)
    res.json({
      total: 1,
      list: [
        {
          id: 'task-1',
          parentType: 'Account',
          parentId: 'account-active-1',
          modifiedAt: new Date().toISOString(),
        },
      ],
    });
  });

  // Mock Note data
  app.get('/api/v1/Note', (_req: Request, res: Response) => {
    res.json({
      total: 1,
      list: [
        {
          id: 'note-1',
          parentType: 'Account',
          parentId: 'account-active-1',
          createdAt: new Date().toISOString(),
        },
      ],
    });
  });

  // Mock Account data (includes one stalled account)
  app.get('/api/v1/Account', (_req: Request, res: Response) => {
    res.json({
      total: 2,
      list: [
        { id: 'account-active-1', name: 'Active Corp' },
        { id: 'account-stalled-1', name: 'Stalled Inc' },
      ],
    });
  });

  // Mock Contact data (for stalled account contact count)
  app.get('/api/v1/Contact', (_req: Request, res: Response) => {
    res.json({
      total: 1,
      list: [
        { id: 'contact-1', accountId: 'account-stalled-1' },
      ],
    });
  });

  // Mock Opportunity data (one overdue)
  app.get('/api/v1/Opportunity', (_req: Request, res: Response) => {
    res.json({
      total: 1,
      list: [
        {
          id: 'opp-1',
          name: 'Series A Deal',
          accountName: 'Delta Partners',
          stage: 'Proposal/Price Quote',
          closeDate: '2025-01-01',
        },
      ],
    });
  });

  // Catch-all for any other API routes — return empty list
  app.get('/api/v1/:entity', (_req: Request, res: Response) => {
    res.json({ total: 0, list: [] });
  });

  return app;
}

// ────────────────────────────────────────────────────────────────
// Mock services
// ────────────────────────────────────────────────────────────────

function createMockGeminiService(): GeminiService {
  return {
    chat: async (_params: ChatParams): Promise<ChatResult> => ({
      message: 'Mock response',
      toolsUsed: [],
      sources: [],
    }),
    getModel: () => 'gemini-3.1-flash-lite-preview',
    getAvailableModels: () => ['gemini-3.1-flash-lite-preview'],
    initialize: () => {},
  } as unknown as GeminiService;
}

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
let configDir: string;

async function postBrief(
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${appPort}/brief`, {
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

  // 2. Create temp directories
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'brief-test-'));
  configDir = path.join(tmpDir, 'user-configs');

  // 3. Set env var for user config path before creating server
  process.env.USER_CONFIG_PATH = configDir;

  // Ensure no GOOGLE_CLOUD_PROJECT so BriefGenerator uses fallback mode
  delete process.env.GOOGLE_CLOUD_PROJECT;

  // 4. Build the app with a low rate limit for testing (31 requests/min)
  const espocrmUrl = `http://127.0.0.1:${fakeEspoPort}`;

  const deps: ServerDependencies = {
    mcpBridge: createMockMCPBridge(),
    geminiService: createMockGeminiService(),
    sessionManager: new SessionManager(),
    rateLimiter: new RateLimiter({ maxRequests: 30 }),
    pdfHandler: new PDFHandler(tmpDir),
    espocrmUrl,
    uploadDir: tmpDir,
  };

  const app = createServer(deps);

  // 5. Start the app server
  await new Promise<void>((resolve) => {
    appServer = app.listen(0, () => {
      const addr = appServer.address();
      appPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    appServer.close((err) => (err ? reject(err) : resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    fakeEspoServer.close((err) => (err ? reject(err) : resolve()));
  });
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  delete process.env.USER_CONFIG_PATH;
});

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('Integration: POST /brief', () => {
  // ── Success cases ───────────────────────────────────────────

  it('returns 200 with BriefResponse shape', async () => {
    const { status, body } = await postBrief({
      userApiKey: TEST_USER.apiKey,
      userId: TEST_USER.userId,
    });

    expect(status).toBe(200);
    expect(body).toHaveProperty('recommendations');
    expect(body).toHaveProperty('isAiGenerated');
    expect(body).toHaveProperty('generatedAt');
    expect(body).toHaveProperty('cacheHit');
    expect(body.cacheHit).toBe(false);
  }, 15_000);

  it('returns cacheHit: true on second call (cache populated by first)', async () => {
    // The first call from the previous test already populated the cache.
    // Make another call — should be a cache hit.
    const { status, body } = await postBrief({
      userApiKey: TEST_USER.apiKey,
      userId: TEST_USER.userId,
    });

    expect(status).toBe(200);
    expect(body.cacheHit).toBe(true);
  }, 15_000);

  it('returns valid brief in fallback mode (isAiGenerated: false) when Gemini is unavailable', async () => {
    // Since GOOGLE_CLOUD_PROJECT is not set, BriefGenerator uses fallback mode.
    // The first test already confirmed this works — verify the field explicitly.
    const { status, body } = await postBrief({
      userApiKey: TEST_USER.apiKey,
      userId: TEST_USER.userId,
    });

    expect(status).toBe(200);
    // In fallback mode (no Gemini), isAiGenerated should be false
    expect(body.isAiGenerated).toBe(false);
  }, 15_000);

  it('response contains all required fields with correct types', async () => {
    const { status, body } = await postBrief({
      userApiKey: TEST_USER.apiKey,
      userId: TEST_USER.userId,
    });

    expect(status).toBe(200);

    // recommendations is an array
    expect(Array.isArray(body.recommendations)).toBe(true);

    // isAiGenerated is a boolean
    expect(typeof body.isAiGenerated).toBe('boolean');

    // generatedAt is a valid ISO string
    expect(typeof body.generatedAt).toBe('string');
    const parsedDate = new Date(body.generatedAt as string);
    expect(parsedDate.toISOString()).toBe(body.generatedAt);

    // cacheHit is a boolean
    expect(typeof body.cacheHit).toBe('boolean');
  }, 15_000);

  // ── Auth failure cases ──────────────────────────────────────

  it('returns 401 when auth fails (invalid API key)', async () => {
    const { status, body } = await postBrief({
      userApiKey: 'invalid-api-key-garbage',
      userId: 'some-user',
    });

    expect(status).toBe(401);
    expect(body).toHaveProperty('error');
    expect(typeof body.error).toBe('string');
  });

  it('returns 401 when credentials are missing', async () => {
    const { status, body } = await postBrief({});

    expect(status).toBe(401);
    expect(body).toHaveProperty('error');
  });

  // ── Rate limiting ───────────────────────────────────────────

  it('returns 429 when rate limit is exceeded', async () => {
    // The rate limiter is set to 30 requests/min.
    // Use a fresh user ID to get a clean rate limit window.
    const rateLimitUser = {
      apiKey: TEST_USER.apiKey,
      userId: 'rate-limit-test-user',
    };

    // Fire 31 requests rapidly to exhaust the limit
    const promises: Promise<{ status: number; body: Record<string, unknown> }>[] = [];
    for (let i = 0; i < 31; i++) {
      promises.push(
        postBrief({
          userApiKey: rateLimitUser.apiKey,
          userId: rateLimitUser.userId,
        }),
      );
    }

    const results = await Promise.all(promises);

    // At least one should be 429
    const rateLimited = results.filter((r) => r.status === 429);
    expect(rateLimited.length).toBeGreaterThan(0);

    // The 429 response should have the expected shape
    const firstRateLimited = rateLimited[0];
    expect(firstRateLimited.body).toHaveProperty('error');
    expect(firstRateLimited.body).toHaveProperty('retryAfter');
    expect(typeof firstRateLimited.body.retryAfter).toBe('number');
  }, 30_000);
});
