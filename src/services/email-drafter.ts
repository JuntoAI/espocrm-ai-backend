/**
 * Email Drafter Service — generates email drafts using contact context + Gemini.
 *
 * Registered as a Gemini function declaration so users can invoke it via chat.
 * Handled directly in the `onToolCall` handler in `server.ts` — NOT routed
 * through the CRM Executor / MCP bridge.
 *
 * NEVER sends email — returns draft for user review only.
 *
 * @module email-drafter
 */

import { logger } from '../utils/logger.js';

// ─── Public Interfaces ───────────────────────────────────────────────────────

/** Parameters for generating an email draft. */
export interface EmailDraftParams {
  /** EspoCRM Contact ID. Must be non-empty. */
  contactId: string;
  /** Purpose/context for the email. 1-500 characters. */
  purpose: string;
  /** Tone of the email. Must be exactly 'formal' or 'casual'. */
  tone: 'formal' | 'casual';
  /** Key points to include. 1-10 items, each 1-200 characters. */
  keyPoints: string[];
}

/** A successfully generated email draft. */
export interface EmailDraft {
  /** Email subject line. Max 100 characters. */
  subject: string;
  /** Email body text. Max 2000 characters. */
  body: string;
  /** Recipient's primary email address, or null if none on record. */
  recipientEmail: string | null;
  /** Recipient's full name. */
  recipientName: string;
  /** Warning message if no email address is available. */
  warning?: string;
}

/** Error returned when email draft generation fails. */
export interface EmailDraftError {
  error: true;
  code: 'INVALID_PARAMS' | 'CONTACT_NOT_FOUND' | 'GEMINI_FAILED';
  message: string;
  /** Field-level validation details (only for INVALID_PARAMS). */
  details?: string[];
}

// ─── Internal Types ──────────────────────────────────────────────────────────

/** Contact details retrieved from EspoCRM. */
interface ContactDetails {
  firstName: string;
  lastName: string;
  emailAddress: string | null;
  accountName: string | null;
  cRole: string | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum subject line length. */
const MAX_SUBJECT_LENGTH = 100;

/** Maximum body length. */
const MAX_BODY_LENGTH = 2000;

/** Timeout for Gemini API call in milliseconds. */
const GEMINI_TIMEOUT_MS = 30_000;

/** Timeout for EspoCRM contact lookup in milliseconds. */
const ESPO_TIMEOUT_MS = 10_000;

// ─── Gemini Generate Content Function Type ───────────────────────────────────

/**
 * Function signature for Gemini content generation.
 * Accepts a prompt and system prompt, returns generated text or null on failure.
 * Injected as a constructor dependency for testability.
 */
export type GeminiGenerateContentFn = (
  prompt: string,
  systemPrompt: string,
) => Promise<string | null>;

// ─── Service Class ───────────────────────────────────────────────────────────

/**
 * Generates email drafts using contact context from EspoCRM and Gemini AI.
 *
 * Flow:
 * 1. Validate input parameters (fail fast, no API calls)
 * 2. Look up contact details from EspoCRM REST API
 * 3. Call Gemini to generate subject + body
 * 4. Truncate if needed, format response
 *
 * NEVER sends, queues, or schedules any email.
 */
export class EmailDrafter {
  constructor(
    private readonly espocrmUrl: string,
    private readonly geminiGenerateContent?: GeminiGenerateContentFn,
  ) {}

  /**
   * Generate an email draft for a contact.
   *
   * @param params     Draft parameters (contactId, purpose, tone, keyPoints).
   * @param userApiKey The user's EspoCRM API key for contact lookup.
   * @returns          EmailDraft on success, EmailDraftError on failure.
   */
  async draft(
    params: EmailDraftParams,
    userApiKey: string,
  ): Promise<EmailDraft | EmailDraftError> {
    // 1. Input validation (before any API calls)
    const validationErrors = this.validateParams(params);
    if (validationErrors.length > 0) {
      return {
        error: true,
        code: 'INVALID_PARAMS',
        message: 'Invalid parameters provided.',
        details: validationErrors,
      };
    }

    // 2. Contact lookup via EspoCRM REST API
    const contactResult = await this.lookupContact(params.contactId, userApiKey);
    if ('error' in contactResult) {
      return contactResult;
    }

    // 3. Generate email via Gemini
    const draftResult = await this.generateDraft(params, contactResult);
    if ('error' in draftResult) {
      return draftResult;
    }

    return draftResult;
  }

  // ─── Input Validation ────────────────────────────────────────────────────

  /**
   * Validate all input parameters. Returns an array of field-level error messages.
   * Empty array means all params are valid.
   */
  validateParams(params: EmailDraftParams): string[] {
    const errors: string[] = [];

    // contactId: must be non-empty string
    if (typeof params.contactId !== 'string' || params.contactId.trim().length === 0) {
      errors.push('contactId: must be a non-empty string');
    }

    // purpose: must be string, 1-500 chars
    if (typeof params.purpose !== 'string') {
      errors.push('purpose: must be a string');
    } else if (params.purpose.length < 1 || params.purpose.length > 500) {
      errors.push('purpose: must be between 1 and 500 characters');
    }

    // tone: must be exactly 'formal' or 'casual'
    if (params.tone !== 'formal' && params.tone !== 'casual') {
      errors.push('tone: must be "formal" or "casual"');
    }

    // keyPoints: must be array, 1-10 items, each string 1-200 chars
    if (!Array.isArray(params.keyPoints)) {
      errors.push('keyPoints: must be an array');
    } else {
      if (params.keyPoints.length < 1 || params.keyPoints.length > 10) {
        errors.push('keyPoints: must contain between 1 and 10 items');
      }
      for (let i = 0; i < params.keyPoints.length; i++) {
        const point = params.keyPoints[i];
        if (typeof point !== 'string') {
          errors.push(`keyPoints[${i}]: must be a string`);
        } else if (point.length < 1 || point.length > 200) {
          errors.push(`keyPoints[${i}]: must be between 1 and 200 characters`);
        }
      }
    }

    return errors;
  }

  // ─── Contact Lookup ──────────────────────────────────────────────────────

  /**
   * Look up contact details from EspoCRM REST API.
   *
   * GET {espocrmUrl}/api/v1/Contact/{contactId}?select=firstName,lastName,emailAddress,accountName,cRole
   *
   * Returns ContactDetails on success, or EmailDraftError if contact not found
   * or user lacks access.
   */
  private async lookupContact(
    contactId: string,
    userApiKey: string,
  ): Promise<ContactDetails | EmailDraftError> {
    const url = `${this.espocrmUrl}/api/v1/Contact/${encodeURIComponent(contactId)}?select=firstName,lastName,emailAddress,accountName,cRole`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ESPO_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'X-Api-Key': userApiKey,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      if (response.status === 404 || response.status === 403) {
        return {
          error: true,
          code: 'CONTACT_NOT_FOUND',
          message: 'Contact not found or not accessible.',
        };
      }

      if (!response.ok) {
        logger.warn('EmailDrafter: unexpected HTTP status from EspoCRM', {
          status: response.status,
          contactId,
        });
        return {
          error: true,
          code: 'CONTACT_NOT_FOUND',
          message: 'Contact not found or not accessible.',
        };
      }

      const data = await response.json() as Record<string, unknown>;

      const firstName = (data.firstName as string) || '';
      const lastName = (data.lastName as string) || '';
      const emailAddress = (data.emailAddress as string) || null;
      const accountName = (data.accountName as string) || null;
      const cRole = (data.cRole as string) || null;

      return { firstName, lastName, emailAddress, accountName, cRole };
    } catch (err: unknown) {
      // Abort signal → timeout
      if (
        (err instanceof Error && err.name === 'AbortError') ||
        (err instanceof DOMException && err.name === 'AbortError')
      ) {
        logger.warn('EmailDrafter: EspoCRM contact lookup timed out', { contactId });
        return {
          error: true,
          code: 'CONTACT_NOT_FOUND',
          message: 'Contact not found or not accessible.',
        };
      }

      // Network errors
      logger.warn('EmailDrafter: EspoCRM contact lookup failed', {
        contactId,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
      return {
        error: true,
        code: 'CONTACT_NOT_FOUND',
        message: 'Contact not found or not accessible.',
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ─── Gemini Draft Generation ─────────────────────────────────────────────

  /**
   * Call Gemini to generate email subject and body.
   *
   * Builds a prompt with contact context, purpose, tone, and key points.
   * Parses the response to extract subject and body.
   * Truncates if Gemini exceeds length limits.
   * Enforces a 30-second timeout.
   */
  private async generateDraft(
    params: EmailDraftParams,
    contact: ContactDetails,
  ): Promise<EmailDraft | EmailDraftError> {
    if (!this.geminiGenerateContent) {
      return {
        error: true,
        code: 'GEMINI_FAILED',
        message: 'Draft generation failed. Please try again.',
      };
    }

    const recipientName = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Unknown';
    const prompt = this.buildPrompt(params, contact, recipientName);
    const systemPrompt = this.buildSystemPrompt(params.tone);

    // Call Gemini with 30s timeout
    let generatedText: string | null;
    try {
      generatedText = await Promise.race([
        this.geminiGenerateContent(prompt, systemPrompt),
        this.rejectAfterTimeout(GEMINI_TIMEOUT_MS),
      ]);
    } catch {
      logger.warn('EmailDrafter: Gemini call failed or timed out');
      return {
        error: true,
        code: 'GEMINI_FAILED',
        message: 'Draft generation failed. Please try again.',
      };
    }

    if (!generatedText) {
      return {
        error: true,
        code: 'GEMINI_FAILED',
        message: 'Draft generation failed. Please try again.',
      };
    }

    // Parse subject and body from Gemini response
    const { subject, body } = this.parseGeminiResponse(generatedText);

    // Truncate if needed
    const truncatedSubject = subject.length > MAX_SUBJECT_LENGTH
      ? subject.slice(0, MAX_SUBJECT_LENGTH)
      : subject;
    const truncatedBody = body.length > MAX_BODY_LENGTH
      ? body.slice(0, MAX_BODY_LENGTH)
      : body;

    // Build response
    const draft: EmailDraft = {
      subject: truncatedSubject,
      body: truncatedBody,
      recipientEmail: contact.emailAddress,
      recipientName,
    };

    // Add warning if no email on record
    if (!contact.emailAddress) {
      draft.warning = 'No email address on record for this contact.';
    }

    return draft;
  }

  // ─── Prompt Construction ─────────────────────────────────────────────────

  /**
   * Build the user prompt for Gemini with contact context and draft parameters.
   */
  private buildPrompt(
    params: EmailDraftParams,
    contact: ContactDetails,
    recipientName: string,
  ): string {
    const contextParts: string[] = [
      `Recipient: ${recipientName}`,
    ];

    if (contact.accountName) {
      contextParts.push(`Company: ${contact.accountName}`);
    }
    if (contact.cRole) {
      contextParts.push(`Role: ${contact.cRole}`);
    }

    const keyPointsList = params.keyPoints
      .map((point, i) => `  ${i + 1}. ${point}`)
      .join('\n');

    return [
      '## Contact Context',
      contextParts.join('\n'),
      '',
      '## Email Purpose',
      params.purpose,
      '',
      '## Key Points to Include',
      keyPointsList,
      '',
      '## Instructions',
      'Generate an email with:',
      '- A subject line (max 100 characters)',
      '- A body (max 2000 characters)',
      '',
      'Format your response exactly as:',
      'SUBJECT: <subject line>',
      'BODY:',
      '<email body>',
    ].join('\n');
  }

  /**
   * Build the system prompt for Gemini based on tone.
   */
  private buildSystemPrompt(tone: 'formal' | 'casual'): string {
    const toneGuidance = tone === 'formal'
      ? 'Use a professional, formal tone. Address the recipient respectfully. Use proper salutations and sign-offs.'
      : 'Use a friendly, casual tone. Be warm and approachable while remaining professional. Use relaxed language.';

    return [
      'You are an expert email writer for a CRM system.',
      toneGuidance,
      'Write clear, concise emails that achieve the stated purpose.',
      'Include all specified key points naturally in the email body.',
      'Do NOT include placeholder signatures — the user will add their own.',
      'NEVER include the literal text "SUBJECT:" or "BODY:" labels in the actual email content.',
      'Format your response exactly as:',
      'SUBJECT: <the subject line>',
      'BODY:',
      '<the email body text>',
    ].join('\n');
  }

  // ─── Response Parsing ────────────────────────────────────────────────────

  /**
   * Parse Gemini's response to extract subject and body.
   *
   * Expected format:
   * SUBJECT: <subject line>
   * BODY:
   * <email body>
   *
   * Falls back to using the entire response as body if parsing fails.
   */
  parseGeminiResponse(text: string): { subject: string; body: string } {
    const lines = text.trim().split('\n');

    // Try to find SUBJECT: line
    let subjectLine = '';
    let bodyStartIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.toUpperCase().startsWith('SUBJECT:')) {
        subjectLine = line.slice('SUBJECT:'.length).trim();
        bodyStartIndex = i + 1;
        break;
      }
    }

    // Try to find BODY: marker
    for (let i = bodyStartIndex; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.toUpperCase() === 'BODY:' || line.toUpperCase().startsWith('BODY:')) {
        const inlineBody = line.slice('BODY:'.length).trim();
        if (inlineBody) {
          // Body content is on the same line as BODY:
          const remainingLines = [inlineBody, ...lines.slice(i + 1)];
          return {
            subject: subjectLine || 'Follow-up',
            body: remainingLines.join('\n').trim(),
          };
        }
        bodyStartIndex = i + 1;
        break;
      }
    }

    // Extract body from bodyStartIndex onwards
    const body = lines.slice(bodyStartIndex).join('\n').trim();

    // Fallback: if no subject found, use first line as subject
    if (!subjectLine && body) {
      return {
        subject: 'Follow-up',
        body,
      };
    }

    // Fallback: if no body found, use entire text
    if (!body) {
      return {
        subject: subjectLine || 'Follow-up',
        body: text.trim(),
      };
    }

    return {
      subject: subjectLine,
      body,
    };
  }

  // ─── Utilities ───────────────────────────────────────────────────────────

  /**
   * Returns a promise that rejects after the specified timeout.
   * Used to enforce the 30-second Gemini timeout.
   */
  private rejectAfterTimeout(ms: number): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Gemini call timed out after ${ms}ms`));
      }, ms);
      // Allow Node.js to exit even if this timer is pending
      if (timer.unref) {
        timer.unref();
      }
    });
  }
}
