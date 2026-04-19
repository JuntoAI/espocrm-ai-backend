/**
 * Error sanitization utility for the AI Backend.
 *
 * Strips sensitive information (stack traces, API keys, internal URLs,
 * raw error objects) from error messages and returns human-readable
 * responses categorized by error source.
 *
 * @module error-sanitizer
 */

/** All recognized error categories. */
export type ErrorCategory =
  | 'gemini_timeout'
  | 'gemini_unavailable'
  | 'permission_denied'
  | 'tool_failure'
  | 'search_grounding_unavailable'
  | 'unknown';

/**
 * User-facing messages per error category, matching the design doc table.
 *
 * Note: `permission_denied` uses a template — the `{action}` placeholder
 * is replaced at runtime when context is available, otherwise a generic
 * version is returned.
 */
const USER_MESSAGES: Record<ErrorCategory, string> = {
  gemini_timeout:
    "I'm having trouble processing your request. Please try again in a moment.",
  gemini_unavailable:
    'The AI service is temporarily unavailable.',
  permission_denied:
    "You don't have permission to perform this action. Contact your administrator.",
  tool_failure:
    'Something went wrong while executing the CRM operation. Please try again.',
  search_grounding_unavailable:
    'Internet search results are currently unavailable. Try rephrasing your question or asking about CRM data instead.',
  unknown:
    'Something unexpected happened. Please try again.',
};

// ---------------------------------------------------------------------------
// Regex patterns for sensitive content
// ---------------------------------------------------------------------------

/** Stack trace lines: "at Foo (file:1:2)" or "at file:1:2" or "at Object.<anonymous>" */
const STACK_TRACE_RE =
  /\s*at\s+(?:[\w.<>[\]\s]+\s+)?\(?(?:[\w/\\.:@-]+:\d+:\d+|<anonymous>|native)\)?\s*/g;

/**
 * API key patterns:
 *  - query params:  apiKey=..., api_key=..., key=...
 *  - headers:       X-Api-Key: ..., Authorization: ..., Bearer ...
 *  - long hex/base64 strings that look like keys (32+ chars)
 */
const API_KEY_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|key|token|secret|password|credential)\s*[=:]\s*\S+/gi,
  /(?:X-Api-Key|Authorization|Bearer)\s*[:=]\s*\S+/gi,
  /\b[A-Za-z0-9_\-]{32,}\b/g,
];

/** Internal / infrastructure URLs that should never leak to users. */
const INTERNAL_URL_RE =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|espocrm-app|ai-backend|mcp-server|internal|host\.docker\.internal)(?::\d+)?[^\s)"]*/gi;

/** Matches JSON-like blobs: { ... } or stringified objects. */
const JSON_BLOB_RE = /\{[\s\S]{20,}\}/g;

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Extract a raw string from any error-shaped value.
 */
function extractMessage(error: unknown): string {
  if (error === null || error === undefined) {
    return '';
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    // Use only the message, never the stack
    return error.message;
  }
  if (typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    // Try common message fields
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.error === 'string') return obj.error;
    if (typeof obj.msg === 'string') return obj.msg;
    // Last resort: safe stringify (but it will be stripped of JSON blobs later)
    try {
      return JSON.stringify(error);
    } catch {
      return '';
    }
  }
  return String(error);
}

/**
 * Sanitize an error value, stripping all sensitive content.
 *
 * Guarantees:
 *  - No stack traces
 *  - No API keys / auth headers
 *  - No internal URLs
 *  - No raw JSON object dumps
 *  - Never returns an empty string
 */
export function sanitizeError(error: unknown): string {
  let msg = extractMessage(error);

  // 1. Strip stack traces
  msg = msg.replace(STACK_TRACE_RE, ' ');

  // 2. Strip internal URLs
  msg = msg.replace(INTERNAL_URL_RE, '[internal service]');

  // 3. Strip API key patterns
  for (const pattern of API_KEY_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    msg = msg.replace(pattern, '[redacted]');
  }

  // 4. Strip large JSON blobs
  msg = msg.replace(JSON_BLOB_RE, '[details removed]');

  // 5. Collapse whitespace
  msg = msg.replace(/\s+/g, ' ').trim();

  // 6. Never return empty
  if (msg.length === 0) {
    return 'An error occurred.';
  }

  return msg;
}

/**
 * Categorize an error into one of the known error types.
 */
export function categorizeError(error: unknown): ErrorCategory {
  const msg = extractMessage(error).toLowerCase();
  const code = extractStatusCode(error);

  // Gemini timeout
  if (
    msg.includes('timeout') &&
    (msg.includes('gemini') || msg.includes('vertex') || msg.includes('api'))
  ) {
    return 'gemini_timeout';
  }
  if (msg.includes('etimedout') || msg.includes('deadline exceeded')) {
    return 'gemini_timeout';
  }

  // Gemini unreachable
  if (
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('unreachable') ||
    msg.includes('service unavailable')
  ) {
    return 'gemini_unavailable';
  }
  if (code === 503) {
    return 'gemini_unavailable';
  }

  // Permission denied (403 from EspoCRM)
  if (code === 403 || msg.includes('permission denied') || msg.includes('forbidden') || msg.includes('access denied')) {
    return 'permission_denied';
  }

  // Search grounding unavailable
  if (
    msg.includes('search grounding') ||
    msg.includes('grounding') && msg.includes('unavailable')
  ) {
    return 'search_grounding_unavailable';
  }

  // Tool / MCP failure
  if (
    msg.includes('tool') && (msg.includes('fail') || msg.includes('error')) ||
    msg.includes('mcp') && (msg.includes('fail') || msg.includes('error')) ||
    msg.includes('tool execution') ||
    msg.includes('function call') && msg.includes('fail')
  ) {
    return 'tool_failure';
  }

  return 'unknown';
}

/**
 * Combine categorization + sanitization to produce the appropriate
 * user-facing message per the design doc error table.
 *
 * For `permission_denied`, attempts to extract the action from the error
 * to fill the `{action}` placeholder.
 */
export function getUserFriendlyMessage(error: unknown): string {
  const category = categorizeError(error);

  if (category === 'permission_denied') {
    const action = extractAction(error);
    if (action) {
      return `You don't have permission to ${action}. Contact your administrator.`;
    }
  }

  return USER_MESSAGES[category];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Try to extract an HTTP status code from an error-like object.
 */
function extractStatusCode(error: unknown): number | undefined {
  if (error === null || error === undefined || typeof error !== 'object') {
    return undefined;
  }
  const obj = error as Record<string, unknown>;

  // Axios-style: error.response.status
  if (obj.response && typeof obj.response === 'object') {
    const resp = obj.response as Record<string, unknown>;
    if (typeof resp.status === 'number') return resp.status;
  }
  // Direct status / statusCode
  if (typeof obj.status === 'number') return obj.status;
  if (typeof obj.statusCode === 'number') return obj.statusCode;
  if (typeof obj.code === 'number') return obj.code;

  return undefined;
}

/**
 * Try to extract the action name from a permission error for the
 * "You don't have permission to {action}" template.
 */
function extractAction(error: unknown): string | undefined {
  const msg = extractMessage(error).toLowerCase();

  // Common patterns: "permission denied for create_contact"
  //                  "forbidden: cannot delete Account"
  const actionPatterns = [
    /permission denied (?:for|to|:)\s*(\w[\w\s]*\w)/i,
    /forbidden:?\s*(?:cannot|can't|unable to)\s+(\w[\w\s]*\w)/i,
    /access denied:?\s*(\w[\w\s]*\w)/i,
  ];

  for (const pattern of actionPatterns) {
    const match = msg.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return undefined;
}
