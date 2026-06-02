/**
 * Property-based tests for per-request tool subsetting.
 *
 * Property: Tool Selection Safety
 * For ANY user message, selectToolsForMessage must:
 *   1. Always include every CORE tool (the high-frequency workhorses the model
 *      relies on regardless of keywords — dropping these breaks conversations).
 *   2. Only ever return tool names drawn from the known tool universe
 *      (never invent a tool).
 *   3. Be deterministic (same message → same set).
 *   4. Return a non-empty set.
 *
 * This guards the cost optimization (sending ~10-15 relevant schemas instead of
 * all 46) against silently hiding tools the assistant needs.
 */

import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import { selectToolsForMessage } from '../../src/services/gemini-service.js';

const NUM_RUNS = 200;

// The core tools that must ALWAYS be present (mirrors CORE_TOOLS in the source).
const CORE_TOOLS = [
  'search_contacts',
  'search_accounts',
  'search_entity',
  'get_entity',
  'update_entity',
  'search_notes',
  'add_note',
  'search_tasks',
  'get_task',
  'get_contact',
];

// The full universe of MCP + backend tool names the selector may emit.
const ALL_KNOWN_TOOLS = new Set<string>([
  ...CORE_TOOLS,
  'create_contact',
  'create_account',
  'create_opportunity',
  'search_opportunities',
  'create_meeting',
  'search_meetings',
  'get_meeting',
  'update_meeting',
  'search_users',
  'get_user_by_email',
  'create_task',
  'update_task',
  'assign_task',
  'create_lead',
  'search_leads',
  'update_lead',
  'convert_lead',
  'assign_lead',
  'add_user_to_team',
  'remove_user_from_team',
  'assign_role_to_user',
  'get_user_teams',
  'get_team_members',
  'search_teams',
  'get_user_permissions',
  'create_entity',
  'delete_entity',
  'link_entities',
  'unlink_entities',
  'get_entity_relationships',
  'create_call',
  'search_calls',
  'create_case',
  'search_cases',
  'update_case',
  'health_check',
  'fetch_url',
  'draft_email',
  'list_knowledge',
  'update_knowledge',
  'delete_knowledge',
]);

// Realistic-ish message arbitrary: free text plus occasional domain keywords.
const keywordArb = fc.constantFrom(
  'contact', 'account', 'deal', 'lead', 'meeting', 'task', 'call',
  'case', 'note', 'team', 'user', 'email', 'draft', 'website',
  'knowledge', 'delete', 'update', 'opportunity', '',
);
const messageArb = fc
  .tuple(fc.string({ maxLength: 120 }), fc.array(keywordArb, { maxLength: 5 }))
  .map(([free, kws]) => `${free} ${kws.join(' ')}`.trim());

describe('Property: selectToolsForMessage safety', () => {
  it('always includes every core tool', () => {
    fc.assert(
      fc.property(messageArb, (msg) => {
        const selected = selectToolsForMessage(msg);
        for (const core of CORE_TOOLS) {
          expect(selected.has(core)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never emits an unknown tool name', () => {
    fc.assert(
      fc.property(messageArb, (msg) => {
        const selected = selectToolsForMessage(msg);
        for (const tool of selected) {
          expect(ALL_KNOWN_TOOLS.has(tool)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is deterministic for the same message', () => {
    fc.assert(
      fc.property(messageArb, (msg) => {
        const a = [...selectToolsForMessage(msg)].sort();
        const b = [...selectToolsForMessage(msg)].sort();
        expect(a).toEqual(b);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('always returns a non-empty set', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (msg) => {
        expect(selectToolsForMessage(msg).size).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('adds email tools when the message mentions email/draft', () => {
    const selected = selectToolsForMessage('please draft an email to the investor');
    expect(selected.has('draft_email')).toBe(true);
  });

  it('adds meeting tools when the message mentions a meeting', () => {
    const selected = selectToolsForMessage('schedule a meeting next week');
    expect(selected.has('create_meeting')).toBe(true);
    expect(selected.has('search_meetings')).toBe(true);
  });
});
