/**
 * BriefGenerator — orchestrates CRM analysis + Gemini summarization
 * to produce the Daily Brief with prioritized action recommendations.
 *
 * Flow:
 *  1. Read user config (custom thresholds) from UserConfigStore
 *  2. Invoke CrmAnalyzer with user's API key and config thresholds
 *  3. If CRM data is empty → return "healthy pipeline" brief
 *  4. Send structured data to Gemini with proactive advisor system prompt
 *  5. Parse response into ActionRecommendation[] (clamped to max 5)
 *  6. On Gemini failure/timeout → fallback with raw data, isAiGenerated: false
 *
 * @module brief-generator
 */

import {
  VertexAI,
  type GenerativeModel,
} from '@google-cloud/vertexai';
import { CrmAnalyzer, type CrmAnalysisResult, type CrmAnalysisError } from './crm-analyzer.js';
import { UserConfigStore } from './user-config-store.js';
import { logger } from '../utils/logger.js';

// ─── Public Types ────────────────────────────────────────────────────────────

/** A single action recommendation within a daily brief. */
export interface ActionRecommendation {
  description: string;
  reason: string;
  suggestedCommand: string;
}

/** The complete daily brief returned to users. */
export interface DailyBrief {
  recommendations: ActionRecommendation[];
  rawAnalysis: CrmAnalysisResult;
  generatedAt: string;
  /** false if Gemini was unavailable and raw data was returned as fallback. */
  isAiGenerated: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum recommendations to return (clamp Gemini output). */
const MAX_RECOMMENDATIONS = 5;

/** Timeout for Gemini generateContent call in milliseconds. */
const GEMINI_TIMEOUT_MS = 10_000;

/** System prompt instructing Gemini to act as a proactive CRM advisor. */
const PROACTIVE_ADVISOR_PROMPT = `You are a proactive CRM advisor for JuntoAI. Given structured CRM analysis data,
generate 3-5 prioritized action recommendations. Each recommendation must include:
1. A clear description of what to do
2. A reason explaining why it matters (urgency, revenue impact, relationship risk)
3. A suggested chat command the user can execute

Rules for variety and freshness:
- VARY your recommendations each time. Don't always lead with the same item.
- If multiple items are overdue, rotate which one you highlight first based on the current date.
- Use DIFFERENT suggested commands each time (e.g., alternate between "draft email", "search opportunities", "show contacts for").
- Reference specific numbers (days overdue, contact counts) to make each brief feel current.
- For stalled accounts with many contacts, suggest re-engaging specific contacts rather than the account generically.

Prioritize by: revenue at risk > relationship decay > task overdue duration.
If the data shows no issues, return a positive summary indicating healthy pipeline.

You MUST respond with valid JSON only. No markdown, no code fences, no explanation outside the JSON.
Respond with a JSON array of objects, each with these exact keys:
- "description": string (what to do — be specific and actionable)
- "reason": string (why it matters — include numbers)
- "suggestedCommand": string (a chat command like "draft email to [contact] about [topic]" or "search opportunities stage Prospecting")

Example response:
[
  {
    "description": "Follow up with Delta Partners about the Series A deal",
    "reason": "Opportunity is 14 days overdue at Proposal stage — $2M revenue at risk",
    "suggestedCommand": "draft email to Maria at Delta Partners about partnership next steps"
  }
]`;

// ─── Service Class ───────────────────────────────────────────────────────────

/**
 * Orchestrates CRM analysis and Gemini summarization to produce daily briefs.
 *
 * Falls back gracefully when Gemini is unavailable — returns raw CRM data
 * with `isAiGenerated: false` so the frontend can still display useful info.
 */
export class BriefGenerator {
  private readonly crmAnalyzer: CrmAnalyzer;
  private readonly userConfigStore: UserConfigStore;
  private readonly espocrmUrl: string;
  private readonly geminiModel: GenerativeModel | null;

  constructor(
    crmAnalyzer: CrmAnalyzer,
    userConfigStore: UserConfigStore,
    espocrmUrl: string,
    _geminiApiKey?: string,
  ) {
    this.crmAnalyzer = crmAnalyzer;
    this.userConfigStore = userConfigStore;
    this.espocrmUrl = espocrmUrl;

    // Initialize Vertex AI model for brief generation (if credentials available)
    this.geminiModel = this.initializeGeminiModel();

    if (!this.geminiModel) {
      logger.warn('BriefGenerator: No Gemini model available — briefs will use fallback mode');
    }
  }

  /**
   * Generate a daily brief for a user.
   *
   * 1. Reads user config for custom thresholds
   * 2. Runs CRM analysis with those thresholds
   * 3. If CRM data is empty → healthy pipeline brief
   * 4. Sends to Gemini for AI recommendations (with 10s timeout)
   * 5. Falls back to raw data if Gemini fails
   *
   * @param userApiKey The user's EspoCRM API key for ACL-scoped queries.
   * @param userId     The user's ID for config lookup.
   * @returns          Complete DailyBrief with recommendations and raw analysis.
   */
  async generate(userApiKey: string, userId: string): Promise<DailyBrief> {
    const generatedAt = new Date().toISOString();

    // 1. Read user config for custom thresholds
    const userConfig = await this.userConfigStore.get(userId);

    // 2. Run CRM analysis with user's thresholds
    const analysisResult = await this.crmAnalyzer.analyze(
      userApiKey,
      this.espocrmUrl,
      {
        engagementDecayDays: userConfig.engagementDecayDays,
        activityWindowDays: userConfig.activityWindowDays,
      },
    );

    // If CRM analysis returned an error, build a fallback brief with empty data
    if (this.isCrmError(analysisResult)) {
      logger.warn('BriefGenerator: CRM analysis failed', {
        userId,
        code: analysisResult.code,
      });

      const emptyAnalysis: CrmAnalysisResult = {
        overdueOpportunities: [],
        stalledAccounts: [],
        overdueTasks: [],
        activitySummary: [],
        generatedAt,
      };

      return {
        recommendations: [],
        rawAnalysis: emptyAnalysis,
        generatedAt,
        isAiGenerated: false,
      };
    }

    // 3. Check if CRM data is empty (no issues found)
    if (this.isEmptyCrmData(analysisResult)) {
      return this.buildHealthyPipelineBrief(analysisResult, generatedAt);
    }

    // 4. Attempt Gemini summarization with 10s timeout
    const recommendations = await this.callGemini(analysisResult);

    if (recommendations === null) {
      // Gemini failed/timed out → fallback
      logger.warn('BriefGenerator: Gemini unavailable, returning fallback brief', { userId });
      return {
        recommendations: [],
        rawAnalysis: analysisResult,
        generatedAt,
        isAiGenerated: false,
      };
    }

    // 5. Clamp recommendations to max 5
    const clamped = recommendations.slice(0, MAX_RECOMMENDATIONS);

    return {
      recommendations: clamped,
      rawAnalysis: analysisResult,
      generatedAt,
      isAiGenerated: true,
    };
  }

  // ─── Private: Gemini Integration ─────────────────────────────────────────

  /**
   * Call Gemini with CRM analysis data and parse recommendations.
   *
   * Returns null if:
   * - No Gemini model is configured
   * - Gemini times out (10s)
   * - Gemini returns unparseable response
   * - Any other error occurs
   */
  private async callGemini(analysis: CrmAnalysisResult): Promise<ActionRecommendation[] | null> {
    if (!this.geminiModel) {
      return null;
    }

    try {
      // Build the user message with structured CRM data
      const userMessage = this.buildGeminiPrompt(analysis);

      // Race between Gemini call and timeout
      const result = await Promise.race([
        this.geminiModel.generateContent({
          contents: [{ role: 'user', parts: [{ text: userMessage }] }],
          systemInstruction: { role: 'system', parts: [{ text: PROACTIVE_ADVISOR_PROMPT }] },
        }),
        rejectAfterTimeout(GEMINI_TIMEOUT_MS),
      ]);

      // Extract text from response
      const responseText = result.response?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!responseText) {
        logger.warn('BriefGenerator: Gemini returned empty response');
        return null;
      }

      // Parse JSON response
      return this.parseRecommendations(responseText);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.warn('BriefGenerator: Gemini call failed', { error: message });
      return null;
    }
  }

  /**
   * Build the user prompt containing structured CRM data for Gemini.
   */
  private buildGeminiPrompt(analysis: CrmAnalysisResult): string {
    const sections: string[] = [];

    // Include current date for temporal awareness
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];
    const dayOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][today.getDay()];
    sections.push(`## CRM Analysis Data (${dayOfWeek}, ${dateStr})\n`);

    // Overdue opportunities
    if (analysis.overdueOpportunities.length > 0) {
      sections.push(`### Overdue Opportunities (${analysis.overdueOpportunities.length})`);
      for (const opp of analysis.overdueOpportunities) {
        sections.push(`- "${opp.name}" at ${opp.accountName} — Stage: ${opp.stage}, ${opp.daysOverdue} days overdue (close date: ${opp.closeDate})`);
      }
      sections.push('');
    }

    // Stalled accounts
    if (analysis.stalledAccounts.length > 0) {
      sections.push(`### Stalled Accounts (${analysis.stalledAccounts.length})`);
      for (const acc of analysis.stalledAccounts) {
        sections.push(`- "${acc.name}" — ${acc.daysSinceActivity} days since last activity, ${acc.contactCount} contacts`);
      }
      sections.push('');
    }

    // Overdue tasks
    if (analysis.overdueTasks.length > 0) {
      sections.push(`### Overdue Tasks (${analysis.overdueTasks.length})`);
      for (const task of analysis.overdueTasks) {
        sections.push(`- "${task.name}" assigned to ${task.assigneeName} — ${task.daysOverdue} days overdue (due: ${task.dateEnd})`);
      }
      sections.push('');
    }

    // Activity summary
    if (analysis.activitySummary.length > 0) {
      sections.push('### Recent Activity Summary');
      for (const day of analysis.activitySummary) {
        sections.push(`- ${day.date}: ${day.calls} calls, ${day.meetings} meetings, ${day.tasksCompleted} tasks completed, ${day.notesPosted} notes`);
      }
      sections.push('');
    }

    sections.push('Based on this data, generate prioritized action recommendations as a JSON array. Today is ' + dateStr + ' (' + dayOfWeek + '). Vary your focus — pick different items to lead with than yesterday would have.');

    return sections.join('\n');
  }

  /**
   * Parse Gemini's text response into ActionRecommendation[].
   *
   * Handles common response quirks:
   * - JSON wrapped in markdown code fences
   * - Extra whitespace or newlines
   * - Partial/malformed entries (filtered out)
   */
  private parseRecommendations(responseText: string): ActionRecommendation[] | null {
    try {
      // Strip markdown code fences if present
      let cleaned = responseText.trim();
      if (cleaned.startsWith('```json')) {
        cleaned = cleaned.slice(7);
      } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.slice(3);
      }
      if (cleaned.endsWith('```')) {
        cleaned = cleaned.slice(0, -3);
      }
      cleaned = cleaned.trim();

      const parsed = JSON.parse(cleaned);

      if (!Array.isArray(parsed)) {
        logger.warn('BriefGenerator: Gemini response is not an array');
        return null;
      }

      // Validate and filter each recommendation
      const recommendations: ActionRecommendation[] = [];
      for (const item of parsed) {
        if (this.isValidRecommendation(item)) {
          recommendations.push({
            description: String(item.description).trim(),
            reason: String(item.reason).trim(),
            suggestedCommand: String(item.suggestedCommand).trim(),
          });
        }
      }

      if (recommendations.length === 0) {
        logger.warn('BriefGenerator: No valid recommendations parsed from Gemini response');
        return null;
      }

      return recommendations;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown parse error';
      logger.warn('BriefGenerator: Failed to parse Gemini response as JSON', { error: message });
      return null;
    }
  }

  /**
   * Validate that an object has the required recommendation fields.
   */
  private isValidRecommendation(item: unknown): boolean {
    if (!item || typeof item !== 'object') return false;
    const obj = item as Record<string, unknown>;
    return (
      typeof obj.description === 'string' && obj.description.trim().length > 0 &&
      typeof obj.reason === 'string' && obj.reason.trim().length > 0 &&
      typeof obj.suggestedCommand === 'string' && obj.suggestedCommand.trim().length > 0
    );
  }

  // ─── Private: Helpers ────────────────────────────────────────────────────

  /**
   * Check if the CRM analysis result is an error response.
   */
  private isCrmError(result: CrmAnalysisResult | CrmAnalysisError): result is CrmAnalysisError {
    return 'error' in result && result.error === true;
  }

  /**
   * Check if CRM data is empty (no overdue items, no stalled accounts).
   */
  private isEmptyCrmData(analysis: CrmAnalysisResult): boolean {
    return (
      analysis.overdueOpportunities.length === 0 &&
      analysis.stalledAccounts.length === 0 &&
      analysis.overdueTasks.length === 0
    );
  }

  /**
   * Build a "healthy pipeline" brief when no issues are found.
   */
  private buildHealthyPipelineBrief(analysis: CrmAnalysisResult, generatedAt: string): DailyBrief {
    return {
      recommendations: [
        {
          description: 'Your pipeline is healthy — no overdue opportunities, stalled accounts, or overdue tasks detected.',
          reason: 'All opportunities are on track, accounts are engaged, and tasks are up to date.',
          suggestedCommand: 'search opportunities stage Prospecting',
        },
      ],
      rawAnalysis: analysis,
      generatedAt,
      isAiGenerated: false,
    };
  }

  /**
   * Initialize the Vertex AI GenerativeModel for brief generation.
   * Returns null if required environment variables are missing.
   */
  private initializeGeminiModel(): GenerativeModel | null {
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    const location = process.env.GOOGLE_CLOUD_REGION ?? 'us-central1';

    if (!project) {
      return null;
    }

    try {
      const vertexOpts: { project: string; location: string; apiEndpoint?: string } = {
        project,
        location,
      };
      if (location === 'global') {
        vertexOpts.apiEndpoint = 'aiplatform.googleapis.com';
      }

      const vertexAI = new VertexAI(vertexOpts);

      const modelName = process.env.GEMINI_DEFAULT_MODEL ?? 'gemini-2.0-flash';

      return vertexAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048,
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error('BriefGenerator: Failed to initialize Gemini model', { error: message });
      return null;
    }
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Returns a promise that rejects after the specified timeout.
 * Used with Promise.race() to enforce Gemini call timeout.
 */
function rejectAfterTimeout(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`Gemini call timed out after ${ms}ms`)), ms);
  });
}
