/**
 * Authentication middleware for the AI Backend.
 *
 * Validates that the request contains a valid EspoCRM API key by making
 * a lightweight call to the EspoCRM API. Attaches validated user info
 * to the request context on success.
 *
 * @module auth
 */

import type { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { sanitizeError } from '../utils/error-sanitizer.js';
import { logger } from '../utils/logger.js';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** Validated user information attached to the request after auth. */
export interface ValidatedUser {
  userId: string;
  userName: string;
  apiKey: string;
}

/**
 * Extend Express Request to carry validated user info.
 * Consumers should check `req.validatedUser` after the auth middleware.
 */
declare global {
  namespace Express {
    interface Request {
      validatedUser?: ValidatedUser;
    }
  }
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const ESPOCRM_URL = (
  process.env.ESPOCRM_URL ?? 'http://localhost:8080'
).replace(/\/+$/, '');

/**
 * Verify an API key against the EspoCRM instance.
 *
 * Makes a lightweight `GET /api/v1/App/user` call — this endpoint
 * returns the authenticated user's basic info and is the cheapest
 * way to confirm the key is valid.
 *
 * @returns The user's name from EspoCRM on success, or `null` on failure.
 */
async function verifyApiKey(
  apiKey: string,
  baseUrl: string = ESPOCRM_URL,
): Promise<string | null> {
  try {
    const response = await axios.get(`${baseUrl}/api/v1/App/user`, {
      headers: { 'X-Api-Key': apiKey },
      timeout: 10_000,
    });
    // EspoCRM returns user data; extract the userName if available
    const data = response.data as Record<string, unknown>;
    const userName =
      typeof data?.userName === 'string' ? data.userName : '';
    return userName;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// Middleware
// ────────────────────────────────────────────────────────────────

/**
 * Express middleware that authenticates requests against EspoCRM.
 *
 * Expects `userApiKey` and `userId` as non-empty strings in the
 * request body. Makes a lightweight EspoCRM API call to verify the
 * key, then attaches `req.validatedUser` on success.
 *
 * @param espocrmBaseUrl  Override the EspoCRM base URL (useful for testing).
 */
export function createAuthMiddleware(espocrmBaseUrl?: string) {
  const baseUrl = espocrmBaseUrl ?? ESPOCRM_URL;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const body = req.body as Record<string, unknown> | undefined;

    const userApiKey = body?.userApiKey;
    const userId = body?.userId;

    // ── Check presence ────────────────────────────────────────
    if (
      typeof userApiKey !== 'string' ||
      userApiKey.trim().length === 0 ||
      typeof userId !== 'string' ||
      userId.trim().length === 0
    ) {
      logger.warn('Auth: missing or empty credentials', {
        hasApiKey: typeof userApiKey === 'string' && userApiKey.trim().length > 0,
        hasUserId: typeof userId === 'string' && userId.trim().length > 0,
      });

      res.status(401).json({
        error: 'Authentication required. Please provide valid credentials.',
      });
      return;
    }

    // ── Verify against EspoCRM ────────────────────────────────
    const userName = await verifyApiKey(userApiKey.trim(), baseUrl);

    if (userName === null) {
      logger.warn('Auth: invalid API key', { userId: userId.trim() });

      res.status(401).json({
        error: sanitizeError('Invalid or expired API key. Please check your credentials.'),
      });
      return;
    }

    // ── Attach validated user to request ──────────────────────
    req.validatedUser = {
      userId: userId.trim(),
      userName: userName || (typeof body?.userName === 'string' ? body.userName : ''),
      apiKey: userApiKey.trim(),
    };

    logger.debug('Auth: user authenticated', {
      userId: req.validatedUser.userId,
      userName: req.validatedUser.userName,
    });

    next();
  };
}

/**
 * Default auth middleware instance using ESPOCRM_URL env var.
 */
export const authMiddleware = createAuthMiddleware();
