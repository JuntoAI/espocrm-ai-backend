/**
 * Request payload validation for the AI Backend chat endpoint.
 *
 * Validates incoming ChatRequest payloads, collecting all errors
 * rather than short-circuiting on the first failure.
 *
 * @module validators
 */

export interface ChatRequest {
  message: string;
  sessionId?: string;
  userApiKey: string;
  userId: string;
  userName: string;
  model?: string;
}

export interface ValidationError {
  field: string;
  message: string;
}

export type ValidationResult =
  | { valid: true; data: ChatRequest }
  | { valid: false; errors: ValidationError[] };

/**
 * Returns the list of allowed Gemini model identifiers,
 * sourced from the GEMINI_AVAILABLE_MODELS env var.
 */
export function getAvailableModels(): string[] {
  const raw = process.env.GEMINI_AVAILABLE_MODELS
    ?? 'gemini-3.5-flash:thinking-low,gemini-3.5-flash:thinking-default,gemini-3.1-pro-preview,gemini-3.1-flash-lite-preview';
  return raw
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
}

/**
 * Validate an unknown payload as a ChatRequest.
 *
 * Rules:
 *  - `message`, `userApiKey`, `userId` must be present, string-typed, and non-empty after trimming.
 *  - `model`, if present, must be one of the configured available models.
 *  - `sessionId`, if present, must be a string.
 *  - All validation errors are collected — the function never short-circuits.
 *  - null, undefined, and non-object payloads are handled gracefully.
 */
export function validateChatRequest(payload: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  // Guard: payload must be a non-null object
  if (payload === null || payload === undefined || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      valid: false,
      errors: [{ field: 'payload', message: 'Request body must be a JSON object' }],
    };
  }

  const body = payload as Record<string, unknown>;

  // --- Required string fields (must be non-empty after trim) ---
  const requiredStringFields: Array<{ field: keyof ChatRequest; label: string }> = [
    { field: 'message', label: 'message' },
    { field: 'userApiKey', label: 'userApiKey' },
    { field: 'userId', label: 'userId' },
  ];

  for (const { field, label } of requiredStringFields) {
    const value = body[field];
    if (value === undefined || value === null) {
      errors.push({ field: label, message: `${label} is required` });
    } else if (typeof value !== 'string') {
      errors.push({ field: label, message: `${label} must be a string` });
    } else if (value.trim().length === 0) {
      errors.push({ field: label, message: `${label} must not be empty` });
    }
  }

  // --- Optional: model (must be in allowed list when present) ---
  if (body.model !== undefined && body.model !== null) {
    if (typeof body.model !== 'string') {
      errors.push({ field: 'model', message: 'model must be a string' });
    } else {
      const allowed = getAvailableModels();
      if (!allowed.includes(body.model)) {
        errors.push({
          field: 'model',
          message: `model must be one of: ${allowed.join(', ')}`,
        });
      }
    }
  }

  // --- Optional: sessionId (must be a string when present) ---
  if (body.sessionId !== undefined && body.sessionId !== null) {
    if (typeof body.sessionId !== 'string') {
      errors.push({ field: 'sessionId', message: 'sessionId must be a string' });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // All checks passed — build the validated ChatRequest
  const data: ChatRequest = {
    message: (body.message as string).trim(),
    userApiKey: (body.userApiKey as string).trim(),
    userId: (body.userId as string).trim(),
    userName: typeof body.userName === 'string' ? body.userName : '',
    ...(typeof body.model === 'string' ? { model: body.model } : {}),
    ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
  };

  return { valid: true, data };
}
