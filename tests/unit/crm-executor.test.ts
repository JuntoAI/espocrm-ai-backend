import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  CRMExecutor,
  CRMExecutorError,
  TOOL_REST_MAP,
  type ToolRestConfig,
} from '../../src/services/crm-executor.js';

// ────────────────────────────────────────────────────────────────
// TOOL_REST_MAP completeness
// ────────────────────────────────────────────────────────────────

describe('TOOL_REST_MAP', () => {
  const ALL_EXPECTED_TOOLS: string[] = [
    // Contacts (3)
    'create_contact', 'search_contacts', 'get_contact',
    // Accounts (2)
    'create_account', 'search_accounts',
    // Opportunities (2)
    'create_opportunity', 'search_opportunities',
    // Leads (5)
    'create_lead', 'search_leads', 'update_lead', 'convert_lead', 'assign_lead',
    // Meetings (4)
    'create_meeting', 'search_meetings', 'get_meeting', 'update_meeting',
    // Tasks (5)
    'create_task', 'search_tasks', 'get_task', 'update_task', 'assign_task',
    // Calls (2)
    'create_call', 'search_calls',
    // Cases (3)
    'create_case', 'search_cases', 'update_case',
    // Notes (2)
    'add_note', 'search_notes',
    // Teams (4)
    'search_teams', 'get_team_members', 'add_user_to_team', 'remove_user_from_team',
    // Roles (1)
    'assign_role_to_user',
    // Users (4)
    'search_users', 'get_user_by_email', 'get_user_teams', 'get_user_permissions',
    // Generic entities (5)
    'create_entity', 'search_entity', 'get_entity', 'update_entity', 'delete_entity',
    // Relationships (3)
    'link_entities', 'unlink_entities', 'get_entity_relationships',
    // Health (1)
    'health_check',
  ];

  it('contains exactly 46 tool mappings (all MCP server tools)', () => {
    expect(Object.keys(TOOL_REST_MAP)).toHaveLength(46);
  });

  it('maps every expected MCP tool name', () => {
    for (const tool of ALL_EXPECTED_TOOLS) {
      expect(TOOL_REST_MAP).toHaveProperty(tool);
    }
  });

  it('expected tools list has exactly 46 entries', () => {
    expect(ALL_EXPECTED_TOOLS).toHaveLength(46);
  });

  it('every mapping has a valid HTTP method', () => {
    const validMethods = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);
    for (const [tool, config] of Object.entries(TOOL_REST_MAP)) {
      expect(validMethods).toContain(config.method.toUpperCase());
    }
  });

  it('every mapping has a path starting with /api/v1/', () => {
    for (const [tool, config] of Object.entries(TOOL_REST_MAP)) {
      expect(config.path).toMatch(/^\/api\/v1\//);
    }
  });

  it('create_ tools use POST method', () => {
    const createTools = Object.entries(TOOL_REST_MAP).filter(
      ([name]) => name.startsWith('create_'),
    );
    for (const [name, config] of createTools) {
      expect(config.method).toBe('POST');
    }
  });

  it('search_ tools use GET method', () => {
    const searchTools = Object.entries(TOOL_REST_MAP).filter(
      ([name]) => name.startsWith('search_'),
    );
    for (const [name, config] of searchTools) {
      expect(config.method).toBe('GET');
    }
  });

  it('get_ tools use GET method', () => {
    const getTools = Object.entries(TOOL_REST_MAP).filter(
      ([name]) => name.startsWith('get_'),
    );
    for (const [name, config] of getTools) {
      expect(config.method).toBe('GET');
    }
  });

  it('update_ and assign_ tools use PATCH method (except assign_role_to_user which is POST)', () => {
    const patchTools = Object.entries(TOOL_REST_MAP).filter(
      ([name]) =>
        (name.startsWith('update_') || name.startsWith('assign_')) &&
        name !== 'assign_role_to_user',
    );
    for (const [name, config] of patchTools) {
      expect(config.method).toBe('PATCH');
    }
    // assign_role_to_user is a POST (creates a role link, not a partial update)
    expect(TOOL_REST_MAP['assign_role_to_user'].method).toBe('POST');
  });

  it('delete_entity uses DELETE method', () => {
    expect(TOOL_REST_MAP['delete_entity'].method).toBe('DELETE');
  });
});

// ────────────────────────────────────────────────────────────────
// CRMExecutor
// ────────────────────────────────────────────────────────────────

describe('CRMExecutor', () => {
  let executor: CRMExecutor;

  beforeEach(() => {
    executor = new CRMExecutor('http://test-espocrm:8080');
  });

  // ── Constructor ───────────────────────────────────────────

  describe('constructor', () => {
    it('uses provided URL', () => {
      const e = new CRMExecutor('http://custom:9090');
      const client = e.getClientForKey('test-key');
      expect(client.defaults.baseURL).toBe('http://custom:9090');
    });

    it('strips trailing slashes from URL', () => {
      const e = new CRMExecutor('http://custom:9090///');
      const client = e.getClientForKey('test-key');
      expect(client.defaults.baseURL).toBe('http://custom:9090');
    });

    it('falls back to ESPOCRM_URL env var', () => {
      const original = process.env.ESPOCRM_URL;
      try {
        process.env.ESPOCRM_URL = 'http://env-espocrm:8080';
        const e = new CRMExecutor();
        const client = e.getClientForKey('test-key');
        expect(client.defaults.baseURL).toBe('http://env-espocrm:8080');
      } finally {
        if (original === undefined) delete process.env.ESPOCRM_URL;
        else process.env.ESPOCRM_URL = original;
      }
    });

    it('falls back to localhost:8080 when no URL provided', () => {
      const original = process.env.ESPOCRM_URL;
      try {
        delete process.env.ESPOCRM_URL;
        const e = new CRMExecutor();
        const client = e.getClientForKey('test-key');
        expect(client.defaults.baseURL).toBe('http://localhost:8080');
      } finally {
        if (original === undefined) delete process.env.ESPOCRM_URL;
        else process.env.ESPOCRM_URL = original;
      }
    });
  });

  // ── getClientForKey / caching ─────────────────────────────

  describe('getClientForKey', () => {
    it('sets X-Api-Key header on the axios instance', () => {
      const client = executor.getClientForKey('my-secret-key');
      expect(client.defaults.headers['X-Api-Key']).toBe('my-secret-key');
    });

    it('sets Content-Type to application/json', () => {
      const client = executor.getClientForKey('key-1');
      expect(client.defaults.headers['Content-Type']).toBe('application/json');
    });

    it('returns the same instance for the same API key', () => {
      const first = executor.getClientForKey('key-1');
      const second = executor.getClientForKey('key-1');
      expect(first).toBe(second);
    });

    it('returns different instances for different API keys', () => {
      const a = executor.getClientForKey('key-a');
      const b = executor.getClientForKey('key-b');
      expect(a).not.toBe(b);
    });

    it('each instance has its own API key', () => {
      const a = executor.getClientForKey('key-a');
      const b = executor.getClientForKey('key-b');
      expect(a.defaults.headers['X-Api-Key']).toBe('key-a');
      expect(b.defaults.headers['X-Api-Key']).toBe('key-b');
    });

    it('increments cache size for new keys', () => {
      expect(executor.getCacheSize()).toBe(0);
      executor.getClientForKey('key-1');
      expect(executor.getCacheSize()).toBe(1);
      executor.getClientForKey('key-2');
      expect(executor.getCacheSize()).toBe(2);
      executor.getClientForKey('key-1'); // reuse
      expect(executor.getCacheSize()).toBe(2);
    });

    it('clearCache removes all cached instances', () => {
      executor.getClientForKey('key-1');
      executor.getClientForKey('key-2');
      expect(executor.getCacheSize()).toBe(2);
      executor.clearCache();
      expect(executor.getCacheSize()).toBe(0);
    });
  });

  // ── execute — unknown tool ────────────────────────────────

  describe('execute — error handling', () => {
    it('throws CRMExecutorError for unknown tool name', async () => {
      await expect(
        executor.execute('nonexistent_tool', {}, 'key'),
      ).rejects.toThrow(CRMExecutorError);

      try {
        await executor.execute('nonexistent_tool', {}, 'key');
      } catch (err) {
        const e = err as CRMExecutorError;
        expect(e.status).toBe(400);
        expect(e.toolName).toBe('nonexistent_tool');
        expect(e.message).toContain('Unknown tool');
      }
    });

    it('throws CRMExecutorError when path parameter is missing', async () => {
      // get_contact requires contactId
      await expect(
        executor.execute('get_contact', {}, 'key'),
      ).rejects.toThrow(CRMExecutorError);

      try {
        await executor.execute('get_contact', {}, 'key');
      } catch (err) {
        const e = err as CRMExecutorError;
        expect(e.status).toBe(400);
        expect(e.message).toContain('Missing required path parameter');
      }
    });
  });

  // ── Path parameter substitution ───────────────────────────

  describe('path parameter substitution', () => {
    // We test substitution indirectly through the client's request config.
    // Since we can't easily intercept axios without mocking, we test the
    // public getClientForKey and verify the mapping logic via TOOL_REST_MAP.

    it('get_contact path contains {contactId} placeholder', () => {
      expect(TOOL_REST_MAP['get_contact'].path).toBe('/api/v1/Contact/{contactId}');
    });

    it('update_lead path contains {leadId} placeholder', () => {
      expect(TOOL_REST_MAP['update_lead'].path).toBe('/api/v1/Lead/{leadId}');
    });

    it('get_entity path contains {entityType} and {entityId} placeholders', () => {
      expect(TOOL_REST_MAP['get_entity'].path).toBe('/api/v1/{entityType}/{entityId}');
    });

    it('link_entities path contains three placeholders', () => {
      const path = TOOL_REST_MAP['link_entities'].path;
      expect(path).toContain('{entityType}');
      expect(path).toContain('{entityId}');
      expect(path).toContain('{relationshipName}');
    });

    it('get_team_members path contains {teamId}', () => {
      expect(TOOL_REST_MAP['get_team_members'].path).toBe('/api/v1/Team/{teamId}/users');
    });

    it('assign_role_to_user path contains {userId}', () => {
      expect(TOOL_REST_MAP['assign_role_to_user'].path).toBe('/api/v1/User/{userId}/roles');
    });
  });

  // ── CRMExecutorError ─────────────────────────────────────

  describe('CRMExecutorError', () => {
    it('has correct name', () => {
      const err = new CRMExecutorError('test', 404, 'get_contact');
      expect(err.name).toBe('CRMExecutorError');
    });

    it('stores status, toolName, and responseData', () => {
      const err = new CRMExecutorError('msg', 403, 'create_contact', { error: 'forbidden' });
      expect(err.status).toBe(403);
      expect(err.toolName).toBe('create_contact');
      expect(err.responseData).toEqual({ error: 'forbidden' });
      expect(err.message).toBe('msg');
    });

    it('is an instance of Error', () => {
      const err = new CRMExecutorError('test', 500, 'health_check');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(CRMExecutorError);
    });
  });

  // ── Tool category coverage ────────────────────────────────

  describe('tool category coverage', () => {
    it('has 3 contact tools', () => {
      const tools = Object.keys(TOOL_REST_MAP).filter(
        (t) => t.includes('contact'),
      );
      expect(tools).toHaveLength(3);
    });

    it('has 2 account tools', () => {
      const tools = Object.keys(TOOL_REST_MAP).filter(
        (t) => t.includes('account'),
      );
      expect(tools).toHaveLength(2);
    });

    it('has 2 opportunity tools', () => {
      const tools = Object.keys(TOOL_REST_MAP).filter(
        (t) => t.includes('opportunit'),
      );
      expect(tools).toHaveLength(2);
    });

    it('has 5 lead tools', () => {
      const tools = Object.keys(TOOL_REST_MAP).filter(
        (t) => t.includes('lead'),
      );
      expect(tools).toHaveLength(5);
    });

    it('has 4 meeting tools', () => {
      const tools = Object.keys(TOOL_REST_MAP).filter(
        (t) => t.includes('meeting'),
      );
      expect(tools).toHaveLength(4);
    });

    it('has 5 task tools', () => {
      const tools = Object.keys(TOOL_REST_MAP).filter(
        (t) => t.includes('task'),
      );
      expect(tools).toHaveLength(5);
    });

    it('has 2 call tools', () => {
      const tools = Object.keys(TOOL_REST_MAP).filter(
        (t) => t.includes('call'),
      );
      expect(tools).toHaveLength(2);
    });

    it('has 3 case tools', () => {
      const tools = Object.keys(TOOL_REST_MAP).filter(
        (t) => t.includes('case'),
      );
      expect(tools).toHaveLength(3);
    });

    it('has 2 note tools', () => {
      const tools = Object.keys(TOOL_REST_MAP).filter(
        (t) => t.includes('note'),
      );
      expect(tools).toHaveLength(2);
    });

    it('has 4 team-specific tools (search_teams, get_team_members, add/remove_user_to/from_team)', () => {
      const teamTools = [
        'search_teams', 'get_team_members', 'add_user_to_team', 'remove_user_from_team',
      ];
      for (const t of teamTools) {
        expect(TOOL_REST_MAP).toHaveProperty(t);
      }
    });

    it('has 1 role tool', () => {
      const tools = Object.keys(TOOL_REST_MAP).filter(
        (t) => t.includes('role'),
      );
      expect(tools).toHaveLength(1);
    });

    it('has 4 user tools (search_users, get_user_by_email, get_user_teams, get_user_permissions)', () => {
      const userTools = [
        'search_users', 'get_user_by_email', 'get_user_teams', 'get_user_permissions',
      ];
      for (const t of userTools) {
        expect(TOOL_REST_MAP).toHaveProperty(t);
      }
    });

    it('has 5 generic entity tools', () => {
      const tools = Object.keys(TOOL_REST_MAP).filter(
        (t) => t.includes('entity') && !t.includes('relationship'),
      );
      expect(tools).toHaveLength(5);
    });

    it('has 3 relationship tools', () => {
      const tools = Object.keys(TOOL_REST_MAP).filter(
        (t) => t.includes('entities') || t.includes('relationship'),
      );
      expect(tools).toHaveLength(3);
    });

    it('has 1 health check tool', () => {
      expect(TOOL_REST_MAP).toHaveProperty('health_check');
    });
  });
});

// ────────────────────────────────────────────────────────────────
// unwrapNestedArgs
// ────────────────────────────────────────────────────────────────

describe('CRMExecutor.unwrapNestedArgs', () => {
  it('unwraps data for update_entity', () => {
    const result = CRMExecutor.unwrapNestedArgs('update_entity', {
      data: { billingAddressCity: 'Ljubljana', billingAddressCountry: 'Slovenia' },
    });
    expect(result).toEqual({
      billingAddressCity: 'Ljubljana',
      billingAddressCountry: 'Slovenia',
    });
  });

  it('unwraps data for create_entity', () => {
    const result = CRMExecutor.unwrapNestedArgs('create_entity', {
      data: { name: 'Test Account', type: 'Customer' },
    });
    expect(result).toEqual({ name: 'Test Account', type: 'Customer' });
  });

  it('preserves sibling keys when unwrapping data', () => {
    const result = CRMExecutor.unwrapNestedArgs('update_entity', {
      data: { name: 'Updated' },
      select: ['id', 'name'],
    });
    expect(result).toEqual({ name: 'Updated', select: ['id', 'name'] });
  });

  it('unwraps filters for search_entity', () => {
    const result = CRMExecutor.unwrapNestedArgs('search_entity', {
      filters: { status: 'Active', industry: 'Technology' },
      limit: 10,
    });
    expect(result).toEqual({ status: 'Active', industry: 'Technology', limit: 10 });
  });

  it('returns args unchanged for non-generic tools', () => {
    const args = { firstName: 'John', lastName: 'Doe' };
    const result = CRMExecutor.unwrapNestedArgs('create_contact', args);
    expect(result).toEqual(args);
  });

  it('returns args unchanged when data is not an object', () => {
    const args = { data: 'not-an-object' };
    const result = CRMExecutor.unwrapNestedArgs('update_entity', args);
    expect(result).toEqual({ data: 'not-an-object' });
  });

  it('returns args unchanged when data is null', () => {
    const args = { data: null };
    const result = CRMExecutor.unwrapNestedArgs('update_entity', args);
    expect(result).toEqual({ data: null });
  });

  it('returns args unchanged when data is an array', () => {
    const args = { data: [1, 2, 3] };
    const result = CRMExecutor.unwrapNestedArgs('update_entity', args);
    expect(result).toEqual({ data: [1, 2, 3] });
  });

  it('returns args unchanged when filters is missing for search_entity', () => {
    const args = { limit: 20, offset: 0 };
    const result = CRMExecutor.unwrapNestedArgs('search_entity', args);
    expect(result).toEqual({ limit: 20, offset: 0 });
  });
});
