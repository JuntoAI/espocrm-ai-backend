/**
 * Property-based tests for authentication validation middleware.
 *
 * **Validates: Requirements 3.3, 6.2**
 *
 * Property 8: Authentication Validation
 * For any incoming request to the chat endpoint, if the request contains an
 * invalid or missing API key, the backend should return a 401 status code and
 * not forward the message to Gemini. If the request contains a valid API key,
 * the backend should proceed with processing.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as fc from 'fast-check';
import express, { type Express, type Request, type Response } from 'express';
import http from 'http';
import { createAuthMiddleware } from '../../src/middleware/auth.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const NUM_RUNS = 100;

/**
 * The single valid API key accepted by the fake EspoCRM server.
 * Deliberately long and random-looking so fast-check is extremely
 * unlikely to generate it by accident.
 */
const VALID_API_KEY = 'prop-test-valid-key-a7b3c9d2e1f0';
const VALID_USER_NAME = 'prop-test-user';

// ────────────────────────────────────────────────────────────────
// Fake EspoCRM server
// ────────────────────────────────────────────────────────────────

let fakeEspoServer: http.Server;
let fakeEspoPort: number;

/** Tracks whether the fake EspoCRM server received a request. */
let espoRequestReceived: boolean;

beforeAll(async () => {
  const fakeApp = express();

  fakeApp.get('/api/v1/App/user', (req: Request, res: Response) => {
    espoRequestReceived = true;
    const apiKey = req.headers['x-api-key'] as string | undefined;

    if (apiKey === VALID_API_KEY) {
      res.json({ userName: VALID_USER_NAME, id: 'user-prop-001' });
    } else {
      res.status(401).json({ error: 'Unauthorized' });
    }
  });

  await new Promise<void>((resolve) => {
    fakeEspoServer = fakeApp.listen(0, () => {
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

// ────────────────────────────────────────────────────────────────
// Test app builder + request helper
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
// Arbitraries
// ────────────────────────────────────────────────────────────────

/** Non-empty, non-whitespace-only string for valid userId values. */
const nonEmptyStringArb = fc
  .string({ minLength: 1, maxLength: 80 })
  .filter((s) => s.trim().length > 0);

/**
 * Arbitrary API key that is guaranteed NOT to match VALID_API_KEY.
 * Uses printable ASCII strings and filters out the one valid key.
 */
const invalidApiKeyArb = fc
  .string({ minLength: 1, maxLength: 80 })
  .filter((s) => s.trim().length > 0 && s.trim() !== VALID_API_KEY);

/**
 * Values that represent "missing or empty" credentials:
 * undefined, null, empty string, whitespace-only strings, non-string types.
 */
const missingOrEmptyArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.constant(''),
  fc.constant('   '),
  fc.constant('\t'),
  fc.constant('\n'),
  fc.constant(' \t\n '),
  fc.integer(),
  fc.boolean(),
  fc.constant(0),
  fc.constant(false),
);

// ────────────────────────────────────────────────────────────────
// Property tests
// ────────────────────────────────────────────────────────────────

describe('Property 8: Authentication Validation', () => {
  let app: Express;

  beforeAll(() => {
    app = buildTestApp();
  });

  it('requests with missing/empty userApiKey always return 401', async () => {
    await fc.assert(
      fc.asyncProperty(
        missingOrEmptyArb,
        nonEmptyStringArb,
        async (badApiKey, userId) => {
          espoRequestReceived = false;

          const body: Record<string, unknown> = {
            message: 'hello',
            userId,
          };
          if (badApiKey !== undefined) {
            body.userApiKey = badApiKey;
          }

          const result = await postChat(app, body);

          expect(result.status).toBe(401);
          expect(result.body).toHaveProperty('error');
          expect(typeof result.body.error).toBe('string');
          // Must NOT have forwarded to EspoCRM (no Gemini path)
          expect(espoRequestReceived).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('requests with missing/empty userId always return 401', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmptyStringArb,
        missingOrEmptyArb,
        async (apiKey, badUserId) => {
          espoRequestReceived = false;

          const body: Record<string, unknown> = {
            message: 'hello',
            userApiKey: apiKey,
          };
          if (badUserId !== undefined) {
            body.userId = badUserId;
          }

          const result = await postChat(app, body);

          expect(result.status).toBe(401);
          expect(result.body).toHaveProperty('error');
          expect(typeof result.body.error).toBe('string');
          // Missing userId is caught before EspoCRM call
          expect(espoRequestReceived).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('requests with an API key that does not match the valid key always return 401', async () => {
    await fc.assert(
      fc.asyncProperty(
        invalidApiKeyArb,
        nonEmptyStringArb,
        async (badApiKey, userId) => {
          const result = await postChat(app, {
            message: 'hello',
            userApiKey: badApiKey,
            userId,
          });

          expect(result.status).toBe(401);
          expect(result.body).toHaveProperty('error');
          expect(typeof result.body.error).toBe('string');
          // Error message must not leak internal details
          const errorMsg = String(result.body.error);
          expect(errorMsg).not.toContain('127.0.0.1');
          expect(errorMsg).not.toContain(String(fakeEspoPort));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('requests with the valid API key and non-empty userId always return 200 with validatedUser', async () => {
    await fc.assert(
      fc.asyncProperty(nonEmptyStringArb, async (userId) => {
        const result = await postChat(app, {
          message: 'hello',
          userApiKey: VALID_API_KEY,
          userId,
        });

        expect(result.status).toBe(200);
        expect(result.body).toHaveProperty('ok', true);
        expect(result.body).toHaveProperty('validatedUser');

        const user = result.body.validatedUser as Record<string, unknown>;
        expect(user.userId).toBe(userId.trim());
        expect(user.apiKey).toBe(VALID_API_KEY);
        expect(user.userName).toBe(VALID_USER_NAME);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('401 error messages are always human-readable strings, never raw objects or stack traces', async () => {
    await fc.assert(
      fc.asyncProperty(invalidApiKeyArb, nonEmptyStringArb, async (badKey, userId) => {
        const result = await postChat(app, {
          message: 'test',
          userApiKey: badKey,
          userId,
        });

        expect(result.status).toBe(401);
        const errorMsg = String(result.body.error);
        // Must be a readable sentence, not a raw error object
        expect(errorMsg.length).toBeGreaterThan(5);
        expect(errorMsg).not.toMatch(/^\{/);
        expect(errorMsg).not.toMatch(/^\[/);
        expect(errorMsg).not.toContain('stack');
        expect(errorMsg).not.toContain('Error:');
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
