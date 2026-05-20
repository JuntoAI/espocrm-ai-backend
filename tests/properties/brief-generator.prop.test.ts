/**
 * Property-based tests for BriefGenerator service.
 *
 * Feature: proactive-crm-agent, Property 6: Recommendation structure completeness
 * Feature: proactive-crm-agent, Property 7: Recommendation count clamping
 *
 * **Validates: Requirements 2.3, 2.10**
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fc from 'fast-check';
import { BriefGenerator } from '../../src/services/brief-generator.js';
import type { ActionRecommendation, DailyBrief } from '../../src/services/brief-generator.js';
import type { CrmAnalysisResult } from '../../src/services/crm-analyzer.js';
import type { CrmAnalyzer } from '../../src/services/crm-analyzer.js';
import type { UserConfigStore, UserConfig } from '../../src/services/user-config-store.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const NUM_RUNS = 100;
const TEST_API_KEY = 'test-api-key-brief';
const TEST_USER_ID = 'test-user-123';
const TEST_ESPOCRM_URL = 'https://crm.test.example.com';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal valid CrmAnalysisResult with some data (so Gemini is called). */
function makeNonEmptyAnalysis(): CrmAnalysisResult {
  return {
    overdueOpportunities: [
      {
        id: 'opp1',
        name: 'Test Deal',
        accountName: 'Test Corp',
        stage: 'Proposal/Price Quote',
        closeDate: '2025-06-01',
        daysOverdue: 14,
      },
    ],
    stalledAccounts: [],
    overdueTasks: [],
    activitySummary: [],
    generatedAt: new Date().toISOString(),
  };
}

/** Create a mock CrmAnalyzer that returns non-empty analysis. */
function createMockCrmAnalyzer(): CrmAnalyzer {
  return {
    analyze: jest.fn<() => Promise<CrmAnalysisResult>>().mockResolvedValue(makeNonEmptyAnalysis()),
  } as unknown as CrmAnalyzer;
}

/** Create a mock UserConfigStore that returns defaults. */
function createMockUserConfigStore(): UserConfigStore {
  const defaults: UserConfig = { engagementDecayDays: 14, activityWindowDays: 7 };
  return {
    get: jest.fn<() => Promise<UserConfig>>().mockResolvedValue(defaults),
    set: jest.fn<() => Promise<UserConfig>>().mockResolvedValue(defaults),
    validate: jest.fn().mockReturnValue({ valid: true, errors: [] }),
  } as unknown as UserConfigStore;
}

/**
 * Build a JSON string representing an array of recommendation objects.
 * Each recommendation has the given fields (some may be empty/missing).
 */
function buildRecommendationsJson(recs: Array<{
  description?: string;
  reason?: string;
  suggestedCommand?: string;
}>): string {
  return JSON.stringify(recs);
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Arbitrary for a non-empty trimmed string (valid recommendation field). */
const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 200 })
  .filter((s) => s.trim().length > 0);

/** Arbitrary for a valid ActionRecommendation object. */
const validRecommendationArb = fc.record({
  description: nonEmptyStringArb,
  reason: nonEmptyStringArb,
  suggestedCommand: nonEmptyStringArb,
});

/** Arbitrary for an invalid recommendation (at least one field empty or missing). */
const invalidRecommendationArb = fc.oneof(
  // Missing description
  fc.record({
    reason: nonEmptyStringArb,
    suggestedCommand: nonEmptyStringArb,
  }),
  // Empty description
  fc.record({
    description: fc.constant(''),
    reason: nonEmptyStringArb,
    suggestedCommand: nonEmptyStringArb,
  }),
  // Whitespace-only description
  fc.record({
    description: fc.constant('   '),
    reason: nonEmptyStringArb,
    suggestedCommand: nonEmptyStringArb,
  }),
  // Missing reason
  fc.record({
    description: nonEmptyStringArb,
    suggestedCommand: nonEmptyStringArb,
  }),
  // Empty reason
  fc.record({
    description: nonEmptyStringArb,
    reason: fc.constant(''),
    suggestedCommand: nonEmptyStringArb,
  }),
  // Missing suggestedCommand
  fc.record({
    description: nonEmptyStringArb,
    reason: nonEmptyStringArb,
  }),
  // Empty suggestedCommand
  fc.record({
    description: nonEmptyStringArb,
    reason: nonEmptyStringArb,
    suggestedCommand: fc.constant(''),
  }),
);

/** Arbitrary for a count of recommendations (0 to 20). */
const recommendationCountArb = fc.integer({ min: 0, max: 20 });

// ─── Environment Mocking ─────────────────────────────────────────────────────

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  // Set required env vars for Gemini model initialization
  process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
  process.env.GOOGLE_CLOUD_REGION = 'us-central1';
});

afterEach(() => {
  process.env = originalEnv;
  jest.restoreAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

// Feature: proactive-crm-agent, Property 6: Recommendation structure completeness
describe('Property 6: Recommendation structure completeness', () => {
  it('every recommendation in a Daily Brief has non-empty description, reason, and suggestedCommand', () => {
    fc.assert(
      fc.property(
        fc.array(validRecommendationArb, { minLength: 1, maxLength: 5 }),
        (validRecs) => {
          // Access parseRecommendations directly to test the parsing logic
          const mockAnalyzer = createMockCrmAnalyzer();
          const mockConfigStore = createMockUserConfigStore();
          const generator = new BriefGenerator(
            mockAnalyzer,
            mockConfigStore,
            TEST_ESPOCRM_URL,
          );

          const jsonText = buildRecommendationsJson(validRecs);
          const parsed = (generator as any).parseRecommendations(jsonText) as ActionRecommendation[] | null;

          // If parsing succeeds, every recommendation must have non-empty fields
          if (parsed !== null) {
            for (const rec of parsed) {
              expect(typeof rec.description).toBe('string');
              expect(rec.description.trim().length).toBeGreaterThan(0);

              expect(typeof rec.reason).toBe('string');
              expect(rec.reason.trim().length).toBeGreaterThan(0);

              expect(typeof rec.suggestedCommand).toBe('string');
              expect(rec.suggestedCommand.trim().length).toBeGreaterThan(0);
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('invalid recommendations (empty/missing fields) are filtered out — only valid ones remain', () => {
    fc.assert(
      fc.property(
        fc.array(validRecommendationArb, { minLength: 1, maxLength: 3 }),
        fc.array(invalidRecommendationArb, { minLength: 1, maxLength: 3 }),
        (validRecs, invalidRecs) => {
          const mockAnalyzer = createMockCrmAnalyzer();
          const mockConfigStore = createMockUserConfigStore();
          const generator = new BriefGenerator(
            mockAnalyzer,
            mockConfigStore,
            TEST_ESPOCRM_URL,
          );

          // Mix valid and invalid recommendations
          const mixed = [...validRecs, ...invalidRecs];
          const jsonText = buildRecommendationsJson(mixed);
          const parsed = (generator as any).parseRecommendations(jsonText) as ActionRecommendation[] | null;

          if (parsed !== null) {
            // Every parsed recommendation must have non-empty fields
            for (const rec of parsed) {
              expect(typeof rec.description).toBe('string');
              expect(rec.description.trim().length).toBeGreaterThan(0);

              expect(typeof rec.reason).toBe('string');
              expect(rec.reason.trim().length).toBeGreaterThan(0);

              expect(typeof rec.suggestedCommand).toBe('string');
              expect(rec.suggestedCommand.trim().length).toBeGreaterThan(0);
            }

            // The count of valid parsed recs should be exactly the number of valid inputs
            expect(parsed.length).toBe(validRecs.length);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('recommendations with markdown code fences wrapping are still parsed correctly', () => {
    fc.assert(
      fc.property(
        fc.array(validRecommendationArb, { minLength: 1, maxLength: 5 }),
        fc.constantFrom('```json\n', '```\n', ''),
        (validRecs, prefix) => {
          const mockAnalyzer = createMockCrmAnalyzer();
          const mockConfigStore = createMockUserConfigStore();
          const generator = new BriefGenerator(
            mockAnalyzer,
            mockConfigStore,
            TEST_ESPOCRM_URL,
          );

          const jsonBody = JSON.stringify(validRecs);
          const suffix = prefix ? '\n```' : '';
          const wrappedText = `${prefix}${jsonBody}${suffix}`;

          const parsed = (generator as any).parseRecommendations(wrappedText) as ActionRecommendation[] | null;

          if (parsed !== null) {
            for (const rec of parsed) {
              expect(rec.description.trim().length).toBeGreaterThan(0);
              expect(rec.reason.trim().length).toBeGreaterThan(0);
              expect(rec.suggestedCommand.trim().length).toBeGreaterThan(0);
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// Feature: proactive-crm-agent, Property 7: Recommendation count clamping
describe('Property 7: Recommendation count clamping', () => {
  it('output contains at most 5 recommendations regardless of how many Gemini returns', async () => {
    await fc.assert(
      fc.asyncProperty(
        recommendationCountArb,
        async (count) => {
          const mockAnalyzer = createMockCrmAnalyzer();
          const mockConfigStore = createMockUserConfigStore();
          const generator = new BriefGenerator(
            mockAnalyzer,
            mockConfigStore,
            TEST_ESPOCRM_URL,
          );

          // Generate N valid recommendations
          const recs: ActionRecommendation[] = [];
          for (let i = 0; i < count; i++) {
            recs.push({
              description: `Action ${i + 1}: Follow up with contact ${i}`,
              reason: `Reason ${i + 1}: No activity in ${i + 10} days`,
              suggestedCommand: `draft email to contact-${i}`,
            });
          }

          // Mock the Gemini model to return these recommendations
          const jsonResponse = JSON.stringify(recs);
          const mockGeminiModel = {
            generateContent: jest.fn<() => Promise<any>>().mockResolvedValue({
              response: {
                candidates: [
                  {
                    content: {
                      parts: [{ text: jsonResponse }],
                    },
                  },
                ],
              },
            }),
          };

          // Inject the mock Gemini model
          (generator as any).geminiModel = mockGeminiModel;

          const brief = await generator.generate(TEST_API_KEY, TEST_USER_ID);

          // Core property: at most 5 recommendations
          expect(brief.recommendations.length).toBeLessThanOrEqual(5);

          if (count === 0) {
            // When Gemini returns 0 valid recs, parseRecommendations returns null → fallback
            // The brief will have 0 recommendations with isAiGenerated: false
            expect(brief.recommendations.length).toBe(0);
            expect(brief.isAiGenerated).toBe(false);
          } else if (count <= 5) {
            // All recommendations are included
            expect(brief.recommendations.length).toBe(count);
            expect(brief.isAiGenerated).toBe(true);
          } else {
            // Clamped to first 5
            expect(brief.recommendations.length).toBe(5);
            expect(brief.isAiGenerated).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('when Gemini returns more than 5, only the first 5 are included (order preserved)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 6, max: 20 }),
        async (count) => {
          const mockAnalyzer = createMockCrmAnalyzer();
          const mockConfigStore = createMockUserConfigStore();
          const generator = new BriefGenerator(
            mockAnalyzer,
            mockConfigStore,
            TEST_ESPOCRM_URL,
          );

          // Generate N recommendations with identifiable descriptions
          const recs: ActionRecommendation[] = [];
          for (let i = 0; i < count; i++) {
            recs.push({
              description: `Action-${i}`,
              reason: `Reason-${i}`,
              suggestedCommand: `command-${i}`,
            });
          }

          const jsonResponse = JSON.stringify(recs);
          const mockGeminiModel = {
            generateContent: jest.fn<() => Promise<any>>().mockResolvedValue({
              response: {
                candidates: [
                  {
                    content: {
                      parts: [{ text: jsonResponse }],
                    },
                  },
                ],
              },
            }),
          };

          (generator as any).geminiModel = mockGeminiModel;

          const brief = await generator.generate(TEST_API_KEY, TEST_USER_ID);

          // Exactly 5 recommendations
          expect(brief.recommendations.length).toBe(5);

          // They are the FIRST 5 (order preserved)
          for (let i = 0; i < 5; i++) {
            expect(brief.recommendations[i].description).toBe(`Action-${i}`);
            expect(brief.recommendations[i].reason).toBe(`Reason-${i}`);
            expect(brief.recommendations[i].suggestedCommand).toBe(`command-${i}`);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('when Gemini returns fewer than 3, all are included without padding', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 2 }),
        async (count) => {
          const mockAnalyzer = createMockCrmAnalyzer();
          const mockConfigStore = createMockUserConfigStore();
          const generator = new BriefGenerator(
            mockAnalyzer,
            mockConfigStore,
            TEST_ESPOCRM_URL,
          );

          const recs: ActionRecommendation[] = [];
          for (let i = 0; i < count; i++) {
            recs.push({
              description: `Action-${i}`,
              reason: `Reason-${i}`,
              suggestedCommand: `command-${i}`,
            });
          }

          const jsonResponse = JSON.stringify(recs);
          const mockGeminiModel = {
            generateContent: jest.fn<() => Promise<any>>().mockResolvedValue({
              response: {
                candidates: [
                  {
                    content: {
                      parts: [{ text: jsonResponse }],
                    },
                  },
                ],
              },
            }),
          };

          (generator as any).geminiModel = mockGeminiModel;

          const brief = await generator.generate(TEST_API_KEY, TEST_USER_ID);

          // All recommendations included (no padding to 3)
          expect(brief.recommendations.length).toBe(count);
          expect(brief.isAiGenerated).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
