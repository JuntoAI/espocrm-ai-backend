/**
 * Integration tests for MCP reconnection and Gemini function calling.
 *
 * Validates:
 *  1. MCP process crash → health endpoint reflects disconnected/reconnected state
 *  2. Natural language request → correct tool called with correct args via Gemini function calling mock
 *  3. PDF upload → follow-up question → Gemini receives PDF context
 *
 * Uses createServer() factory with:
 *  - Fake EspoCRM server (Express) for API key validation
 *  - Mock GeminiService that simulates function call responses
 *  - Mock MCPBridge with controllable connected state
 *  - Real SessionManager, RateLimiter, CRMExecutor, PDFHandler
 *
 * Validates: Requirements 3.2, 3.7, 4.3, 8.3, 8.4
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
// Test user
// ────────────────────────────────────────────────────────────────

const TEST_USER = {
  apiKey: 'test-user-valid-api-key-mcp-gemini',
  userId: 'test-user-mcp-gemini',
  userName: 'TestUser',
};

// ────────────────────────────────────────────────────────────────
// Fake EspoCRM server
// ────────────────────────────────────────────────────────────────

let fakeEspoApp: Express;
let fakeEspoServer: http.Server;
let fakeEspoPort: number;

/** Track tool execution requests received by the fake EspoCRM server. */
let crmRequests: Array<{ method: string; path: string; apiKey: string; body?: unknown }> = [];

function setupFakeEspoCRM(): Express {
  const app = express();
  app.use(express.json());

  // Auth validation endpoint
  app.get('/api/v1/App/user', (req: Request, res: Response) => {
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (apiKey === TEST_USER.apiKey) {
      res.json({ userName: TEST_USER.userName, id: TEST_USER.userId });
    } else {
      res.status(401).json({ error: 'Unauthorized' });
    }
  });

  // Contact search endpoint (used by CRM executor when Gemini calls search_contacts)
  app.get('/api/v1/Contact', (req: Request, res: Response) => {
    const apiKey = req.headers['x-api-key'] as string | undefined;
    crmRequests.push({
      method: 'GET',
      path: '/api/v1/Contact',
      apiKey: apiKey ?? '',
      body: req.query,
    });
    res.json({
      total: 1,
      list: [
        {
          id: 'contact-001',
          firstName: 'Jane',
          lastName: 'Doe',
          emailAddress: 'jane@example.com',
        },
      ],
    });
  });

  // Contact creation endpoint
  app.post('/api/v1/Contact', (req: Request, res: Response) => {
    const apiKey = req.headers['x-api-key'] as string | undefined;
    crmRequests.push({
      method: 'POST',
      path: '/api/v1/Contact',
      apiKey: apiKey ?? '',
      body: req.body,
    });
    res.status(200).json({
      id: 'contact-new-001',
      ...req.body,
    });
  });

  return app;
}

// ────────────────────────────────────────────────────────────────
// Mock MCPBridge with controllable connection state
// ────────────────────────────────────────────────────────────────

class MockMCPBridge {
  private _connected = true;

  isConnected(): boolean {
    return this._connected;
  }

  getToolSchemas() {
    return [];
  }

  async connect() {}
  async disconnect() {}
  async reconnect() {
    this._connected = true;
  }
  async waitForConnection() {}
  getQueueSize() {
    return 0;
  }

  // Test helpers
  simulateDisconnect(): void {
    this._connected = false;
  }

  simulateReconnect(): void {
    this._connected = true;
  }
}

// ────────────────────────────────────────────────────────────────
// Mock GeminiService with configurable function calling behavior
// ────────────────────────────────────────────────────────────────

type ChatHandler = (params: ChatParams) => Promise<ChatResult>;

class MockGeminiService {
  /** Override this to control what the mock returns per test. */
  public chatHandler: ChatHandler;

  /** Track all chat() calls for assertions. */
  public chatCalls: ChatParams[] = [];

  constructor() {
    // Default: simple text response
    this.chatHandler = async (_params: ChatParams): Promise<ChatResult> => ({
      message: 'Default mock response.',
      toolsUsed: [],
      sources: [],
    });
  }

  async chat(params: ChatParams): Promise<ChatResult> {
    this.chatCalls.push(params);
    return this.chatHandler(params);
  }

  getModel(modelName?: string): string {
    return modelName ?? 'gemini-3.1-flash-lite-preview';
  }

  getAvailableModels(): string[] {
    return ['gemini-3.1-pro-preview', 'gemini-3.1-flash-lite-preview'];
  }

  initialize(): void {}

  reset(): void {
    this.chatCalls = [];
    this.chatHandler = async () => ({
      message: 'Default mock response.',
      toolsUsed: [],
      sources: [],
    });
  }
}

// ────────────────────────────────────────────────────────────────
// Test infrastructure
// ────────────────────────────────────────────────────────────────

let appServer: http.Server;
let appPort: number;
let tmpDir: string;
let sessionManager: SessionManager;
let rateLimiter: RateLimiter;
let mockMCPBridge: MockMCPBridge;
let mockGeminiService: MockGeminiService;

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

async function getHealth(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${appPort}/health`);
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body: json };
}

async function postUpload(
  fileBuffer: Buffer,
  filename: string,
  fields: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Build multipart form data manually using the Fetch API FormData
  const formData = new FormData();
  const blob = new Blob([fileBuffer], { type: 'application/pdf' });
  formData.append('file', blob, filename);

  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }

  const res = await fetch(`http://127.0.0.1:${appPort}/chat/upload`, {
    method: 'POST',
    body: formData,
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
      fakeEspoPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve();
    });
  });

  // 2. Create temp directory for PDF uploads
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-gemini-test-'));

  // 3. Build the app with mock + real dependencies
  sessionManager = new SessionManager({ timeoutMs: 30 * 60 * 1000, maxMessages: 20 });
  rateLimiter = new RateLimiter({ maxRequests: 30, windowMs: 60_000 });
  mockMCPBridge = new MockMCPBridge();
  mockGeminiService = new MockGeminiService();

  const espocrmUrl = `http://127.0.0.1:${fakeEspoPort}`;

  const deps: ServerDependencies = {
    mcpBridge: mockMCPBridge as unknown as MCPBridge,
    geminiService: mockGeminiService as unknown as GeminiService,
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
  await new Promise<void>((resolve, reject) => {
    appServer.close((err) => (err ? reject(err) : resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    fakeEspoServer.close((err) => (err ? reject(err) : resolve()));
  });
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  crmRequests = [];
  rateLimiter.resetAll();
  mockGeminiService.reset();
  mockMCPBridge.simulateReconnect(); // Start each test with MCP connected
  // Clear all sessions
  sessionManager.clear(TEST_USER.userId);
});

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('Integration: MCP reconnection and Gemini function calling', () => {
  // ── 1. MCP reconnection simulation ─────────────────────────
  // Validates: Requirements 3.2, 3.7

  describe('MCP reconnection', () => {
    it('health endpoint reports mcpConnected: true when MCP is connected', async () => {
      mockMCPBridge.simulateReconnect();

      const { status, body } = await getHealth();

      expect(status).toBe(200);
      expect(body.mcpConnected).toBe(true);
      expect(body.status).toBe('healthy');
    });

    it('health endpoint reports mcpConnected: false when MCP disconnects', async () => {
      mockMCPBridge.simulateDisconnect();

      const { status, body } = await getHealth();

      expect(status).toBe(200);
      expect(body.mcpConnected).toBe(false);
      expect(body.status).toBe('degraded');
    });

    it('health endpoint reports mcpConnected: true after MCP reconnects', async () => {
      // Start connected
      let health = await getHealth();
      expect(health.body.mcpConnected).toBe(true);

      // Simulate crash
      mockMCPBridge.simulateDisconnect();
      health = await getHealth();
      expect(health.body.mcpConnected).toBe(false);
      expect(health.body.status).toBe('degraded');

      // Simulate reconnection
      mockMCPBridge.simulateReconnect();
      health = await getHealth();
      expect(health.body.mcpConnected).toBe(true);
      expect(health.body.status).toBe('healthy');
    });

    it('chat requests still succeed while MCP is disconnected (schema already cached)', async () => {
      // MCP is only used for schema loading at startup.
      // Once schemas are cached, chat should work even if MCP is down.
      mockMCPBridge.simulateDisconnect();

      const { status, body } = await postChat({
        message: 'Hello, how are you?',
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
      });

      expect(status).toBe(200);
      expect(body).toHaveProperty('message');
      expect(typeof body.message).toBe('string');
    });
  });

  // ── 2. Gemini function calling flow ────────────────────────
  // Validates: Requirements 4.3

  describe('Gemini function calling', () => {
    it('routes a natural language request through Gemini and calls the correct CRM tool', async () => {
      // Configure mock Gemini to simulate a function call for search_contacts
      mockGeminiService.chatHandler = async (params: ChatParams): Promise<ChatResult> => {
        // Simulate Gemini deciding to call search_contacts
        const toolResult = await params.onToolCall('search_contacts', {
          searchTerm: 'Jane',
        });

        return {
          message: `I found a contact: Jane Doe (jane@example.com).`,
          toolsUsed: [
            {
              tool: 'search_contacts',
              success: true,
              summary: 'Searched contacts for "Jane"',
            },
          ],
          sources: [],
        };
      };

      const { status, body } = await postChat({
        message: 'Find contacts named Jane',
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
      });

      expect(status).toBe(200);
      expect(body.message).toContain('Jane Doe');

      // Verify toolsUsed is populated
      const toolsUsed = body.toolsUsed as Array<{ tool: string; success: boolean; summary: string }>;
      expect(toolsUsed).toBeDefined();
      expect(toolsUsed).toHaveLength(1);
      expect(toolsUsed[0].tool).toBe('search_contacts');
      expect(toolsUsed[0].success).toBe(true);

      // Verify the CRM executor actually called the fake EspoCRM server
      expect(crmRequests).toHaveLength(1);
      expect(crmRequests[0].method).toBe('GET');
      expect(crmRequests[0].path).toBe('/api/v1/Contact');
      expect(crmRequests[0].apiKey).toBe(TEST_USER.apiKey);
    });

    it('passes the correct args from Gemini function call to CRM executor', async () => {
      mockGeminiService.chatHandler = async (params: ChatParams): Promise<ChatResult> => {
        await params.onToolCall('create_contact', {
          firstName: 'Alice',
          lastName: 'Smith',
          emailAddress: 'alice@example.com',
          title: 'CTO',
        });

        return {
          message: 'Created contact Alice Smith.',
          toolsUsed: [
            {
              tool: 'create_contact',
              success: true,
              summary: 'Created contact Alice Smith',
            },
          ],
          sources: [],
        };
      };

      const { status, body } = await postChat({
        message: 'Create a contact for Alice Smith, CTO, alice@example.com',
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
      });

      expect(status).toBe(200);

      // Verify the CRM executor received the correct args
      expect(crmRequests).toHaveLength(1);
      expect(crmRequests[0].method).toBe('POST');
      expect(crmRequests[0].path).toBe('/api/v1/Contact');
      expect(crmRequests[0].body).toEqual(
        expect.objectContaining({
          firstName: 'Alice',
          lastName: 'Smith',
          emailAddress: 'alice@example.com',
          title: 'CTO',
        }),
      );
    });

    it('handles multiple sequential tool calls in a single turn', async () => {
      mockGeminiService.chatHandler = async (params: ChatParams): Promise<ChatResult> => {
        // Simulate Gemini calling two tools sequentially
        await params.onToolCall('search_contacts', { searchTerm: 'Jane' });
        await params.onToolCall('create_contact', {
          firstName: 'Bob',
          lastName: 'Jones',
        });

        return {
          message: 'Found Jane and created Bob Jones.',
          toolsUsed: [
            { tool: 'search_contacts', success: true, summary: 'Searched contacts' },
            { tool: 'create_contact', success: true, summary: 'Created Bob Jones' },
          ],
          sources: [],
        };
      };

      const { status, body } = await postChat({
        message: 'Find Jane and create a contact for Bob Jones',
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
      });

      expect(status).toBe(200);

      const toolsUsed = body.toolsUsed as Array<{ tool: string }>;
      expect(toolsUsed).toHaveLength(2);
      expect(toolsUsed[0].tool).toBe('search_contacts');
      expect(toolsUsed[1].tool).toBe('create_contact');

      // Both requests should have hit the fake EspoCRM
      expect(crmRequests).toHaveLength(2);
      expect(crmRequests[0].method).toBe('GET');
      expect(crmRequests[1].method).toBe('POST');
    });

    it('includes toolsUsed in the response when tools are called', async () => {
      mockGeminiService.chatHandler = async (params: ChatParams): Promise<ChatResult> => {
        await params.onToolCall('search_contacts', { searchTerm: 'test' });

        return {
          message: 'Found results.',
          toolsUsed: [
            { tool: 'search_contacts', success: true, summary: 'Searched contacts' },
          ],
          sources: [],
        };
      };

      const { body } = await postChat({
        message: 'Search for test contacts',
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
      });

      expect(body).toHaveProperty('toolsUsed');
      const toolsUsed = body.toolsUsed as Array<{ tool: string; success: boolean; summary: string }>;
      expect(toolsUsed[0]).toEqual({
        tool: 'search_contacts',
        success: true,
        summary: 'Searched contacts',
      });
    });

    it('Gemini receives the user message in chat params', async () => {
      const testMessage = 'Show me all investor accounts';

      mockGeminiService.chatHandler = async (params: ChatParams): Promise<ChatResult> => {
        // We'll verify params.message in the assertion below
        return {
          message: 'Here are the investor accounts.',
          toolsUsed: [],
          sources: [],
        };
      };

      await postChat({
        message: testMessage,
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
      });

      // Verify the mock Gemini service received the correct message
      expect(mockGeminiService.chatCalls).toHaveLength(1);
      expect(mockGeminiService.chatCalls[0].message).toBe(testMessage);
    });
  });

  // ── 3. PDF context in conversation ─────────────────────────
  // Validates: Requirements 8.3, 8.4

  describe('PDF context in conversation', () => {
    it('PDF upload stores extracted text and follow-up receives PDF context', async () => {
      const pdfExtractedText = 'This is the extracted text from the quarterly report PDF.';

      // Step 1: Configure Gemini mock to return extracted text on upload
      mockGeminiService.chatHandler = async (params: ChatParams): Promise<ChatResult> => {
        // On upload, the server calls gemini to extract text
        // On follow-up, it should include pdfContext
        return {
          message: pdfExtractedText,
          toolsUsed: [],
          sources: [],
        };
      };

      // Step 2: Upload a fake PDF
      const fakePdfBuffer = Buffer.from('%PDF-1.4 fake pdf content for testing');
      const uploadResult = await postUpload(fakePdfBuffer, 'quarterly-report.pdf', {
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
      });

      expect(uploadResult.status).toBe(200);
      expect(uploadResult.body).toHaveProperty('sessionId');

      // Step 3: Verify PDF context was stored in session
      const pdfContext = sessionManager.getPdfContext(TEST_USER.userId);
      expect(pdfContext).toBeDefined();
      expect(pdfContext!.filename).toBe('quarterly-report.pdf');
      expect(pdfContext!.extractedText).toBe(pdfExtractedText);

      // Step 4: Send a follow-up message and verify Gemini receives PDF context
      mockGeminiService.reset();
      mockGeminiService.chatHandler = async (params: ChatParams): Promise<ChatResult> => {
        return {
          message: 'The quarterly revenue was $5M based on the PDF.',
          toolsUsed: [],
          sources: [],
        };
      };

      const followUp = await postChat({
        message: 'What was the quarterly revenue?',
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
      });

      expect(followUp.status).toBe(200);
      expect(followUp.body.message).toContain('quarterly revenue');

      // Verify the Gemini service received the PDF context
      expect(mockGeminiService.chatCalls).toHaveLength(1);
      expect(mockGeminiService.chatCalls[0].pdfContext).toBe(pdfExtractedText);
    });

    it('follow-up messages without PDF upload do not include pdfContext', async () => {
      // No PDF uploaded — just send a regular message
      await postChat({
        message: 'Hello, just a regular question',
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
      });

      expect(mockGeminiService.chatCalls).toHaveLength(1);
      // pdfContext should be undefined since no PDF was uploaded
      expect(mockGeminiService.chatCalls[0].pdfContext).toBeUndefined();
    });

    it('PDF upload with a message processes both upload and question', async () => {
      const pdfExtractedText = 'Contract terms: 12 months, $100k annual.';

      // First call is for text extraction, second is for the user's question
      let callCount = 0;
      mockGeminiService.chatHandler = async (params: ChatParams): Promise<ChatResult> => {
        callCount++;
        if (callCount === 1) {
          // Text extraction call
          return {
            message: pdfExtractedText,
            toolsUsed: [],
            sources: [],
          };
        }
        // User question call — should have pdfContext
        return {
          message: 'The contract is for 12 months at $100k annually.',
          toolsUsed: [],
          sources: [],
        };
      };

      const fakePdfBuffer = Buffer.from('%PDF-1.4 contract document');
      const result = await postUpload(fakePdfBuffer, 'contract.pdf', {
        userApiKey: TEST_USER.apiKey,
        userId: TEST_USER.userId,
        message: 'What are the contract terms?',
      });

      expect(result.status).toBe(200);
      // The response should be from the question, not just the upload confirmation
      expect(result.body.message).toContain('contract');

      // Verify Gemini was called twice: once for extraction, once for the question
      expect(mockGeminiService.chatCalls.length).toBeGreaterThanOrEqual(2);

      // The second call (user question) should have pdfContext
      const questionCall = mockGeminiService.chatCalls[mockGeminiService.chatCalls.length - 1];
      expect(questionCall.pdfContext).toBe(pdfExtractedText);
      expect(questionCall.message).toBe('What are the contract terms?');
    });
  });
});
