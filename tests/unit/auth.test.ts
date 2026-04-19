import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import express, { type Express, type Request, type Response } from 'express';
import http from 'http';
import { createAuthMiddleware } from '../../src/middleware/auth.js';

// ────────────────────────────────────────────────────────────────
// Fake EspoCRM server for API key verification
// ────────────────────────────────────────────────────────────────

const VALID_API_KEY = 'valid-test-api-key-1234567890';
const VALID_USER_NAME = 'testuser';

let fakeEspoApp: Express;
let fakeEspoServer: http.Server;
let fakeEspoPort: number;

/** Tracks the last X-Api-Key header received by the fake server. */
let lastReceivedApiKey: string | undefined;

beforeAll(async () => {
  fakeEspoApp = express();

  fakeEspoApp.get('/api/v1/App/user', (req: Request, res: Response) => {
    lastReceivedApiKey = req.headers['x-api-key'] as string | undefined;

    if (lastReceivedApiKey === VALID_API_KEY) {
      res.json({ userName: VALID_USER_NAME, id: 'user-001' });
    } else {
      res.status(401).json({ error: 'Unauthorized' });
    }
  });

  await new Promise<void>((resolve) => {
    fakeEspoServer = fakeEspoApp.listen(0, () => {
      const addr = fakeEspoServer.address();
      fakeEspoPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    fakeEspoServer.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(() => {
  lastReceivedApiKey = undefined;
});

// ────────────────────────────────────────────────────────────────
// Helper: build a test Express app with the auth middleware
// ────────────────────────────────────────────────────────────────

function buildTestApp(): Express {
  const app = express();
  app.use(express.json());

  const authMw = createAuthMiddleware(`http://127.0.0.1:${fakeEspoPort}`);

  app.post('/chat', authMw, (req: Request, res: Response) => {
    res.json({
      ok: true,
      validatedUser: req.validatedUser,
    });
  });

  return app;
}

/**
 * Make a POST /chat request to the test app.
 */
async function postChat(
  app: Express,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, body: json };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('Auth Middleware', () => {
  let app: Express;

  beforeEach(() => {
    app = buildTestApp();
  });

  // ── Missing credentials ─────────────────────────────────────

  describe('missing credentials', () => {
    it('returns 401 when userApiKey is missing', async () => {
      const { status, body } = await postChat(app, {
        message: 'hello',
        userId: 'user-001',
      });

      expect(status).toBe(401);
      expect(body).toHaveProperty('error');
      expect(typeof body.error).toBe('string');
    });

    it('returns 401 when userId is missing', async () => {
      const { status, body } = await postChat(app, {
        message: 'hello',
        userApiKey: VALID_API_KEY,
      });

      expect(status).toBe(401);
      expect(body).toHaveProperty('error');
      expect(typeof body.error).toBe('string');
    });

    it('returns 401 when both userApiKey and userId are missing', async () => {
      const { status, body } = await postChat(app, {
        message: 'hello',
      });

      expect(status).toBe(401);
      expect(body).toHaveProperty('error');
    });

    it('returns 401 when userApiKey is empty string', async () => {
      const { status } = await postChat(app, {
        message: 'hello',
        userApiKey: '',
        userId: 'user-001',
      });

      expect(status).toBe(401);
    });

    it('returns 401 when userId is empty string', async () => {
      const { status } = await postChat(app, {
        message: 'hello',
        userApiKey: VALID_API_KEY,
        userId: '',
      });

      expect(status).toBe(401);
    });

    it('returns 401 when userApiKey is whitespace only', async () => {
      const { status } = await postChat(app, {
        message: 'hello',
        userApiKey: '   ',
        userId: 'user-001',
      });

      expect(status).toBe(401);
    });

    it('does not call EspoCRM API when credentials are missing', async () => {
      await postChat(app, { message: 'hello' });

      // The fake server should not have received any request
      expect(lastReceivedApiKey).toBeUndefined();
    });
  });

  // ── Invalid API key ─────────────────────────────────────────

  describe('invalid API key', () => {
    it('returns 401 when EspoCRM rejects the API key', async () => {
      const { status, body } = await postChat(app, {
        message: 'hello',
        userApiKey: 'invalid-key-that-does-not-exist',
        userId: 'user-001',
      });

      expect(status).toBe(401);
      expect(body).toHaveProperty('error');
      expect(typeof body.error).toBe('string');
    });

    it('forwards the provided API key to EspoCRM for verification', async () => {
      await postChat(app, {
        message: 'hello',
        userApiKey: 'some-key-to-check',
        userId: 'user-001',
      });

      expect(lastReceivedApiKey).toBe('some-key-to-check');
    });
  });

  // ── Valid API key ───────────────────────────────────────────

  describe('valid API key', () => {
    it('proceeds to next middleware and returns 200', async () => {
      const { status, body } = await postChat(app, {
        message: 'hello',
        userApiKey: VALID_API_KEY,
        userId: 'user-001',
      });

      expect(status).toBe(200);
      expect(body).toHaveProperty('ok', true);
    });

    it('attaches validatedUser to request with correct userId', async () => {
      const { body } = await postChat(app, {
        message: 'hello',
        userApiKey: VALID_API_KEY,
        userId: 'user-001',
      });

      const user = body.validatedUser as Record<string, unknown>;
      expect(user.userId).toBe('user-001');
    });

    it('attaches validatedUser with userName from EspoCRM response', async () => {
      const { body } = await postChat(app, {
        message: 'hello',
        userApiKey: VALID_API_KEY,
        userId: 'user-001',
      });

      const user = body.validatedUser as Record<string, unknown>;
      expect(user.userName).toBe(VALID_USER_NAME);
    });

    it('attaches validatedUser with the API key', async () => {
      const { body } = await postChat(app, {
        message: 'hello',
        userApiKey: VALID_API_KEY,
        userId: 'user-001',
      });

      const user = body.validatedUser as Record<string, unknown>;
      expect(user.apiKey).toBe(VALID_API_KEY);
    });

    it('trims whitespace from userId and apiKey', async () => {
      const { status, body } = await postChat(app, {
        message: 'hello',
        userApiKey: `  ${VALID_API_KEY}  `,
        userId: '  user-001  ',
      });

      expect(status).toBe(200);
      const user = body.validatedUser as Record<string, unknown>;
      expect(user.userId).toBe('user-001');
      expect(user.apiKey).toBe(VALID_API_KEY);
    });
  });

  // ── Error message sanitization ──────────────────────────────

  describe('error response sanitization', () => {
    it('does not leak internal URLs in error responses', async () => {
      const { body } = await postChat(app, {
        message: 'hello',
        userApiKey: 'bad-key',
        userId: 'user-001',
      });

      const errorMsg = String(body.error);
      expect(errorMsg).not.toContain('127.0.0.1');
      expect(errorMsg).not.toContain('localhost');
      expect(errorMsg).not.toContain(String(fakeEspoPort));
    });

    it('returns a human-readable error message', async () => {
      const { body } = await postChat(app, {
        message: 'hello',
        userApiKey: 'bad-key',
        userId: 'user-001',
      });

      const errorMsg = String(body.error);
      expect(errorMsg.length).toBeGreaterThan(5);
      // Should be a readable sentence, not a raw error object
      expect(errorMsg).not.toMatch(/^\{/);
    });
  });
});
