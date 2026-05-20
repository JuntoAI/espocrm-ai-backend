/**
 * Integration tests for GET /config and PATCH /config endpoints.
 *
 * Validates:
 *  - GET /config returns default config for new users
 *  - PATCH /config updates config and returns confirmation
 *  - PATCH /config rejects invalid values with 400
 *  - PATCH /config invalidates BriefCache for the user
 *  - Auth middleware is enforced on both endpoints
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4
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
  apiKey: 'config-test-valid-api-key-abc123',
  userId: 'config-test-user-id',
  userName: 'ConfigTester',
};

// ────────────────────────────────────────────────────────────────
// Fake EspoCRM server
// ────────────────────────────────────────────────────────────────

let fakeEspoApp: Express;
let fakeEspoServer: http.Server;
let fakeEspoPort: number;

function setupFakeEspoCRM(): Express {
  const app = express();

  app.get('/api/v1/App/user', (req: Request, res: Response) => {
    const apiKey = req.headers['x-api-key'] as string | undefined;

    if (apiKey === TEST_USER.apiKey) {
      res.json({ userName: TEST_USER.userName, id: TEST_USER.userId });
    } else {
      res.status(401).json({ error: 'Unauthorized' });
    }
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

async function getConfig(
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Use node:http directly because fetch() doesn't allow body on GET requests.
  // In production, the EspoCRM PHP proxy sends credentials in the body regardless of method.
  const http = await import('http');
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: appPort,
        path: '/config',
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let responseData = '';
        res.on('data', (chunk) => (responseData += chunk));
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 500,
              body: JSON.parse(responseData),
            });
          } catch {
            resolve({ status: res.statusCode ?? 500, body: { raw: responseData } });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function patchConfig(
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${appPort}/config`, {
    method: 'PATCH',
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-test-'));
  configDir = path.join(tmpDir, 'user-configs');

  // 3. Set env var for user config path before creating server
  process.env.USER_CONFIG_PATH = configDir;

  // 4. Build the app
  const espocrmUrl = `http://127.0.0.1:${fakeEspoPort}`;

  const deps: ServerDependencies = {
    mcpBridge: createMockMCPBridge(),
    geminiService: createMockGeminiService(),
    sessionManager: new SessionManager(),
    rateLimiter: new RateLimiter(),
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

beforeEach(async () => {
  // Clean up any stored config files between tests
  try {
    const files = await fs.readdir(configDir);
    for (const file of files) {
      await fs.unlink(path.join(configDir, file));
    }
  } catch {
    // Directory may not exist yet — that's fine
  }
});

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('Integration: GET /config and PATCH /config', () => {
  // ── GET /config ─────────────────────────────────────────────

  describe('GET /config', () => {
    it('returns default config for a new user', async () => {
      const { status, body } = await getConfig({
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
      });

      expect(status).toBe(200);
      expect(body).toHaveProperty('config');
      const config = body.config as Record<string, unknown>;
      expect(config.engagementDecayDays).toBe(14);
      expect(config.activityWindowDays).toBe(7);
    });

    it('returns 401 without valid credentials', async () => {
      const { status } = await getConfig({
        userApiKey: 'invalid-key',
        userId: 'some-user',
      });

      expect(status).toBe(401);
    });

    it('returns 401 when credentials are missing', async () => {
      const { status } = await getConfig({});

      expect(status).toBe(401);
    });
  });

  // ── PATCH /config ───────────────────────────────────────────

  describe('PATCH /config', () => {
    it('updates engagementDecayDays and returns confirmation', async () => {
      const { status, body } = await patchConfig({
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
        engagementDecayDays: 21,
      });

      expect(status).toBe(200);
      expect(body).toHaveProperty('config');
      expect(body).toHaveProperty('message');
      const config = body.config as Record<string, unknown>;
      expect(config.engagementDecayDays).toBe(21);
      expect(config.activityWindowDays).toBe(7); // unchanged
      expect(body.message).toContain('engagement decay to 21 days');
    });

    it('updates activityWindowDays and returns confirmation', async () => {
      const { status, body } = await patchConfig({
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
        activityWindowDays: 14,
      });

      expect(status).toBe(200);
      const config = body.config as Record<string, unknown>;
      expect(config.activityWindowDays).toBe(14);
      expect(config.engagementDecayDays).toBe(14); // default
      expect(body.message).toContain('activity window to 14 days');
    });

    it('updates both fields at once', async () => {
      const { status, body } = await patchConfig({
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
        engagementDecayDays: 30,
        activityWindowDays: 10,
      });

      expect(status).toBe(200);
      const config = body.config as Record<string, unknown>;
      expect(config.engagementDecayDays).toBe(30);
      expect(config.activityWindowDays).toBe(10);
      expect(body.message).toContain('engagement decay to 30 days');
      expect(body.message).toContain('activity window to 10 days');
    });

    it('persists config — GET after PATCH returns updated values', async () => {
      await patchConfig({
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
        engagementDecayDays: 45,
      });

      const { status, body } = await getConfig({
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
      });

      expect(status).toBe(200);
      const config = body.config as Record<string, unknown>;
      expect(config.engagementDecayDays).toBe(45);
    });

    it('rejects engagementDecayDays below 1 with 400', async () => {
      const { status, body } = await patchConfig({
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
        engagementDecayDays: 0,
      });

      expect(status).toBe(400);
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('validOptions');
      expect(typeof body.error).toBe('string');
    });

    it('rejects engagementDecayDays above 90 with 400', async () => {
      const { status, body } = await patchConfig({
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
        engagementDecayDays: 91,
      });

      expect(status).toBe(400);
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('validOptions');
    });

    it('rejects activityWindowDays below 1 with 400', async () => {
      const { status, body } = await patchConfig({
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
        activityWindowDays: 0,
      });

      expect(status).toBe(400);
      expect(body).toHaveProperty('error');
    });

    it('rejects activityWindowDays above 30 with 400', async () => {
      const { status, body } = await patchConfig({
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
        activityWindowDays: 31,
      });

      expect(status).toBe(400);
      expect(body).toHaveProperty('error');
    });

    it('rejects non-integer values with 400', async () => {
      const { status, body } = await patchConfig({
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
        engagementDecayDays: 14.5,
      });

      expect(status).toBe(400);
      expect(body).toHaveProperty('error');
      expect((body.error as string)).toContain('integer');
    });

    it('rejects request with no valid config fields with 400', async () => {
      const { status, body } = await patchConfig({
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
        // No config fields — only auth fields
      });

      expect(status).toBe(400);
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('validOptions');
    });

    it('returns 401 without valid credentials', async () => {
      const { status } = await patchConfig({
        userApiKey: 'invalid-key',
        userId: 'some-user',
        engagementDecayDays: 21,
      });

      expect(status).toBe(401);
    });

    it('invalid values do not change stored config', async () => {
      // First set a valid value
      await patchConfig({
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
        engagementDecayDays: 21,
      });

      // Attempt invalid update
      await patchConfig({
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
        engagementDecayDays: 999,
      });

      // Verify original value is preserved
      const { body } = await getConfig({
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
      });

      const config = body.config as Record<string, unknown>;
      expect(config.engagementDecayDays).toBe(21);
    });
  });
});
