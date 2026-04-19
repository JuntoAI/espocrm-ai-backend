import { describe, it, expect } from '@jest/globals';
import {
  convertToolSchema,
  convertAllSchemas,
} from '../../src/utils/schema-converter.js';
import type {
  GeminiFunctionDeclaration,
  GeminiParameterSchema,
} from '../../src/utils/schema-converter.js';
import type { ToolSchema } from '../../src/services/mcp-bridge.js';

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/** Build a minimal valid ToolSchema for testing. */
function makeSchema(overrides: Partial<ToolSchema> = {}): ToolSchema {
  return {
    name: overrides.name ?? 'test_tool',
    description: overrides.description ?? 'A test tool',
    inputSchema: overrides.inputSchema ?? {
      type: 'object',
      properties: {},
      required: [],
    },
  };
}

// ────────────────────────────────────────────────────────────────
// convertToolSchema — name and description preservation
// ────────────────────────────────────────────────────────────────

describe('convertToolSchema — name and description', () => {
  it('preserves the tool name exactly', () => {
    const result = convertToolSchema(makeSchema({ name: 'create_contact' }));
    expect(result.name).toBe('create_contact');
  });

  it('preserves the tool description exactly', () => {
    const result = convertToolSchema(
      makeSchema({ description: 'Create a new contact in EspoCRM with validation' }),
    );
    expect(result.description).toBe('Create a new contact in EspoCRM with validation');
  });

  it('preserves empty description', () => {
    const result = convertToolSchema(makeSchema({ description: '' }));
    expect(result.description).toBe('');
  });
});

// ────────────────────────────────────────────────────────────────
// convertToolSchema — basic type mapping
// ────────────────────────────────────────────────────────────────

describe('convertToolSchema — type mapping', () => {
  it('maps string → STRING', () => {
    const result = convertToolSchema(
      makeSchema({
        inputSchema: {
          type: 'object',
          properties: { firstName: { type: 'string', description: 'First name' } },
          required: ['firstName'],
        },
      }),
    );
    expect(result.parameters.properties.firstName.type).toBe('STRING');
  });

  it('maps number → NUMBER', () => {
    const result = convertToolSchema(
      makeSchema({
        inputSchema: {
          type: 'object',
          properties: { amount: { type: 'number', description: 'Amount' } },
          required: [],
        },
      }),
    );
    expect(result.parameters.properties.amount.type).toBe('NUMBER');
  });

  it('maps integer → INTEGER', () => {
    const result = convertToolSchema(
      makeSchema({
        inputSchema: {
          type: 'object',
          properties: { limit: { type: 'integer', description: 'Max results' } },
          required: [],
        },
      }),
    );
    expect(result.parameters.properties.limit.type).toBe('INTEGER');
  });

  it('maps boolean → BOOLEAN', () => {
    const result = convertToolSchema(
      makeSchema({
        inputSchema: {
          type: 'object',
          properties: { isActive: { type: 'boolean', description: 'Active flag' } },
          required: [],
        },
      }),
    );
    expect(result.parameters.properties.isActive.type).toBe('BOOLEAN');
  });

  it('maps array → ARRAY', () => {
    const result = convertToolSchema(
      makeSchema({
        inputSchema: {
          type: 'object',
          properties: {
            tags: { type: 'array', items: { type: 'string' }, description: 'Tags' },
          },
          required: [],
        },
      }),
    );
    expect(result.parameters.properties.tags.type).toBe('ARRAY');
  });

  it('maps object → OBJECT', () => {
    const result = convertToolSchema(
      makeSchema({
        inputSchema: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: { key: { type: 'string' } },
              description: 'Data payload',
            },
          },
          required: [],
        },
      }),
    );
    expect(result.parameters.properties.data.type).toBe('OBJECT');
  });

  it('falls back to STRING for unknown type', () => {
    const result = convertToolSchema(
      makeSchema({
        inputSchema: {
          type: 'object',
          properties: { weird: { type: 'foobar', description: 'Unknown' } },
          required: [],
        },
      }),
    );
    expect(result.parameters.properties.weird.type).toBe('STRING');
  });

  it('falls back to STRING for missing type', () => {
    const result = convertToolSchema(
      makeSchema({
        inputSchema: {
          type: 'object',
          properties: { noType: { description: 'No type field' } },
          required: [],
        },
      }),
    );
    expect(result.parameters.properties.noType.type).toBe('STRING');
  });
});

// ────────────────────────────────────────────────────────────────
// convertToolSchema — parameter descriptions
// ────────────────────────────────────────────────────────────────

describe('convertToolSchema — parameter descriptions', () => {
  it('preserves parameter descriptions', () => {
    const result = convertToolSchema(
      makeSchema({
        inputSchema: {
          type: 'object',
          properties: {
            email: { type: 'string', description: "Contact's email address" },
          },
          required: [],
        },
      }),
    );
    expect(result.parameters.properties.email.description).toBe(
      "Contact's email address",
    );
  });

  it('omits description when not present', () => {
    const result = convertToolSchema(
      makeSchema({
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: [],
        },
      }),
    );
    expect(result.parameters.properties.id.description).toBeUndefined();
  });

  it('omits description when empty string', () => {
    const result = convertToolSchema(
      makeSchema({
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: '' } },
          required: [],
        },
      }),
    );
    expect(result.parameters.properties.id.description).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// convertToolSchema — required fields
// ────────────────────────────────────────────────────────────────

describe('convertToolSchema — required fields', () => {
  it('preserves required field list', () => {
    const result = convertToolSchema(
      makeSchema({
        inputSchema: {
          type: 'object',
          properties: {
            firstName: { type: 'string' },
            lastName: { type: 'string' },
            email: { type: 'string' },
          },
          required: ['firstName', 'lastName'],
        },
      }),
    );
    expect(result.parameters.required).toEqual(['firstName', 'lastName']);
  });

  it('preserves empty required list', () => {
    const result = convertToolSchema(
      makeSchema({
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: [],
        },
      }),
    );
    expect(result.parameters.required).toEqual([]);
  });

  it('sets top-level parameters type to OBJECT', () => {
    const result = convertToolSchema(makeSchema());
    expect(result.parameters.type).toBe('OBJECT');
  });
});

// ────────────────────────────────────────────────────────────────
// convertToolSchema — enum values
// ────────────────────────────────────────────────────────────────

describe('convertToolSchema — enum values', () => {
  it('preserves enum values on string parameters', () => {
    const result = convertToolSchema(
      makeSchema({
        inputSchema: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              description: 'Lead status',
              enum: ['New', 'Assigned', 'In Process', 'Converted'],
            },
          },
          required: [],
        },
      }),
    );
    expect(result.parameters.properties.status.enum).toEqual([
      'New',
      'Assigned',
      'In Process',
      'Converted',
    ]);
  });

  it('omits enum when not present', () => {
    const result = convertToolSchema(
      makeSchema({
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: [],
        },
      }),
    );
    expect(result.parameters.properties.name.enum).toBeUndefined();
  });

  it('omits enum when empty array', () => {
    const result = convertToolSchema(
      makeSchema({
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', enum: [] } },
          required: [],
        },
      }),
    );
    expect(result.parameters.properties.name.enum).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// convertToolSchema — array with items
// ────────────────────────────────────────────────────────────────

describe('convertToolSchema — array with items', () => {
  it('includes items schema for array types', () => {
    const result = convertToolSchema(
      makeSchema({
        inputSchema: {
          type: 'object',
          properties: {
            contactsIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of contact IDs',
            },
          },
          required: [],
        },
      }),
    );
    const param = result.parameters.properties.contactsIds;
    expect(param.type).toBe('ARRAY');
    expect(param.items).toBeDefined();
    expect(param.items!.type).toBe('STRING');
  });

  it('handles array of objects with nested properties', () => {
    const result = convertToolSchema(
      makeSchema({
        inputSchema: {
          type: 'object',
          properties: {
            records: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  value: { type: 'number' },
                },
              },
              description: 'List of records',
            },
          },
          required: [],
        },
      }),
    );
    const items = result.parameters.properties.records.items!;
    expect(items.type).toBe('OBJECT');
    expect(items.properties).toBeDefined();
    expect(items.properties!.id.type).toBe('STRING');
    expect(items.properties!.value.type).toBe('NUMBER');
  });

  it('omits items when not present on array', () => {
    const result = convertToolSchema(
      makeSchema({
        inputSchema: {
          type: 'object',
          properties: {
            tags: { type: 'array', description: 'Tags' },
          },
          required: [],
        },
      }),
    );
    expect(result.parameters.properties.tags.items).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// convertToolSchema — nested object properties
// ────────────────────────────────────────────────────────────────

describe('convertToolSchema — nested object properties', () => {
  it('converts nested object properties recursively', () => {
    const result = convertToolSchema(
      makeSchema({
        inputSchema: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              description: 'Entity data',
              properties: {
                name: { type: 'string', description: 'Entity name' },
                count: { type: 'integer', description: 'Count' },
                active: { type: 'boolean' },
              },
              required: ['name'],
            },
          },
          required: ['data'],
        },
      }),
    );

    const data = result.parameters.properties.data;
    expect(data.type).toBe('OBJECT');
    expect(data.description).toBe('Entity data');
    expect(data.properties).toBeDefined();
    expect(data.properties!.name.type).toBe('STRING');
    expect(data.properties!.name.description).toBe('Entity name');
    expect(data.properties!.count.type).toBe('INTEGER');
    expect(data.properties!.active.type).toBe('BOOLEAN');
    expect(data.required).toEqual(['name']);
  });

  it('handles deeply nested objects (3 levels)', () => {
    const result = convertToolSchema(
      makeSchema({
        inputSchema: {
          type: 'object',
          properties: {
            level1: {
              type: 'object',
              properties: {
                level2: {
                  type: 'object',
                  properties: {
                    level3: { type: 'string', description: 'Deep value' },
                  },
                },
              },
            },
          },
          required: [],
        },
      }),
    );

    const l1 = result.parameters.properties.level1;
    expect(l1.type).toBe('OBJECT');
    const l2 = l1.properties!.level2;
    expect(l2.type).toBe('OBJECT');
    const l3 = l2.properties!.level3;
    expect(l3.type).toBe('STRING');
    expect(l3.description).toBe('Deep value');
  });

  it('handles object without nested properties', () => {
    const result = convertToolSchema(
      makeSchema({
        inputSchema: {
          type: 'object',
          properties: {
            filters: { type: 'object', description: 'Search filters' },
          },
          required: [],
        },
      }),
    );
    const filters = result.parameters.properties.filters;
    expect(filters.type).toBe('OBJECT');
    expect(filters.properties).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// convertToolSchema — realistic MCP tool schema
// ────────────────────────────────────────────────────────────────

describe('convertToolSchema — realistic MCP tool', () => {
  it('converts a realistic create_contact schema', () => {
    const schema: ToolSchema = {
      name: 'create_contact',
      description: 'Create a new contact in EspoCRM with validation',
      inputSchema: {
        type: 'object',
        properties: {
          firstName: { type: 'string', description: "Contact's first name" },
          lastName: { type: 'string', description: "Contact's last name" },
          emailAddress: { type: 'string', description: "Contact's email address" },
          phoneNumber: { type: 'string', description: "Contact's phone number" },
          accountId: {
            type: 'string',
            description: 'ID of the account this contact belongs to',
          },
          title: { type: 'string', description: 'Job title or position' },
          department: {
            type: 'string',
            description: 'Department within the organization',
          },
          description: {
            type: 'string',
            description: 'Additional notes about the contact',
          },
        },
        required: ['firstName', 'lastName'],
      },
    };

    const result = convertToolSchema(schema);

    expect(result.name).toBe('create_contact');
    expect(result.description).toBe(
      'Create a new contact in EspoCRM with validation',
    );
    expect(result.parameters.type).toBe('OBJECT');
    expect(result.parameters.required).toEqual(['firstName', 'lastName']);
    expect(Object.keys(result.parameters.properties)).toHaveLength(8);
    expect(result.parameters.properties.firstName.type).toBe('STRING');
    expect(result.parameters.properties.firstName.description).toBe(
      "Contact's first name",
    );
    expect(result.parameters.properties.accountId.type).toBe('STRING');
  });

  it('converts a create_lead schema with enums', () => {
    const schema: ToolSchema = {
      name: 'create_lead',
      description: 'Create a new lead with full field support',
      inputSchema: {
        type: 'object',
        properties: {
          firstName: { type: 'string', description: "Lead's first name" },
          lastName: { type: 'string', description: "Lead's last name" },
          source: {
            type: 'string',
            description: 'Lead source',
            enum: [
              'Call',
              'Email',
              'Existing Customer',
              'Partner',
              'Public Relations',
              'Web Site',
              'Campaign',
              'Other',
            ],
          },
          status: {
            type: 'string',
            description: 'Lead status',
            enum: ['New', 'Assigned', 'In Process', 'Converted', 'Recycled', 'Dead'],
          },
        },
        required: ['firstName', 'lastName', 'source'],
      },
    };

    const result = convertToolSchema(schema);

    expect(result.parameters.properties.source.enum).toEqual([
      'Call',
      'Email',
      'Existing Customer',
      'Partner',
      'Public Relations',
      'Web Site',
      'Campaign',
      'Other',
    ]);
    expect(result.parameters.properties.status.enum).toEqual([
      'New',
      'Assigned',
      'In Process',
      'Converted',
      'Recycled',
      'Dead',
    ]);
    expect(result.parameters.required).toEqual([
      'firstName',
      'lastName',
      'source',
    ]);
  });

  it('converts a create_meeting schema with array fields', () => {
    const schema: ToolSchema = {
      name: 'create_meeting',
      description: 'Create a new meeting in EspoCRM',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Meeting name/title' },
          dateStart: {
            type: 'string',
            description: 'Start date and time in ISO format',
          },
          dateEnd: {
            type: 'string',
            description: 'End date and time in ISO format',
          },
          contactsIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of contact IDs to invite',
          },
          usersIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of user IDs to invite',
          },
          status: {
            type: 'string',
            description: 'Meeting status',
            enum: ['Planned', 'Held', 'Not Held'],
          },
        },
        required: ['name', 'dateStart', 'dateEnd'],
      },
    };

    const result = convertToolSchema(schema);

    expect(result.parameters.properties.contactsIds.type).toBe('ARRAY');
    expect(result.parameters.properties.contactsIds.items!.type).toBe('STRING');
    expect(result.parameters.properties.usersIds.type).toBe('ARRAY');
    expect(result.parameters.properties.status.enum).toEqual([
      'Planned',
      'Held',
      'Not Held',
    ]);
  });

  it('converts a create_entity schema with nested object data', () => {
    const schema: ToolSchema = {
      name: 'create_entity',
      description: 'Create a record for any entity type with validation',
      inputSchema: {
        type: 'object',
        properties: {
          entityType: {
            type: 'string',
            description: "The entity type to create (e.g., 'Contact')",
          },
          data: {
            type: 'object',
            description: 'The entity data as key-value pairs',
          },
        },
        required: ['entityType', 'data'],
      },
    };

    const result = convertToolSchema(schema);

    expect(result.parameters.properties.entityType.type).toBe('STRING');
    expect(result.parameters.properties.data.type).toBe('OBJECT');
    // data has no nested properties defined — should not have properties key
    expect(result.parameters.properties.data.properties).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// convertAllSchemas
// ────────────────────────────────────────────────────────────────

describe('convertAllSchemas', () => {
  it('converts an empty array', () => {
    const result = convertAllSchemas([]);
    expect(result).toEqual([]);
  });

  it('converts a single schema', () => {
    const result = convertAllSchemas([makeSchema({ name: 'health_check' })]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('health_check');
  });

  it('converts multiple schemas preserving order', () => {
    const schemas: ToolSchema[] = [
      makeSchema({ name: 'create_contact', description: 'Create contact' }),
      makeSchema({ name: 'search_contacts', description: 'Search contacts' }),
      makeSchema({ name: 'get_contact', description: 'Get contact' }),
      makeSchema({ name: 'create_account', description: 'Create account' }),
      makeSchema({ name: 'search_accounts', description: 'Search accounts' }),
    ];

    const result = convertAllSchemas(schemas);

    expect(result).toHaveLength(5);
    expect(result[0].name).toBe('create_contact');
    expect(result[1].name).toBe('search_contacts');
    expect(result[2].name).toBe('get_contact');
    expect(result[3].name).toBe('create_account');
    expect(result[4].name).toBe('search_accounts');
  });

  it('each converted schema has OBJECT parameters type', () => {
    const schemas = [
      makeSchema({ name: 'tool_a' }),
      makeSchema({ name: 'tool_b' }),
    ];
    const result = convertAllSchemas(schemas);
    for (const decl of result) {
      expect(decl.parameters.type).toBe('OBJECT');
    }
  });

  it('preserves all properties across multiple schemas', () => {
    const schemas: ToolSchema[] = [
      makeSchema({
        name: 'search_contacts',
        inputSchema: {
          type: 'object',
          properties: {
            searchTerm: { type: 'string', description: 'Search term' },
            limit: { type: 'number', description: 'Max results' },
          },
          required: [],
        },
      }),
      makeSchema({
        name: 'create_opportunity',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Opportunity name' },
            amount: { type: 'number', description: 'Expected revenue' },
            stage: {
              type: 'string',
              enum: ['Prospecting', 'Qualification', 'Closed Won'],
            },
          },
          required: ['name', 'accountId', 'stage', 'closeDate'],
        },
      }),
    ];

    const result = convertAllSchemas(schemas);

    expect(result[0].parameters.properties.searchTerm.type).toBe('STRING');
    expect(result[0].parameters.properties.limit.type).toBe('NUMBER');
    expect(result[1].parameters.properties.stage.enum).toEqual([
      'Prospecting',
      'Qualification',
      'Closed Won',
    ]);
    expect(result[1].parameters.required).toEqual([
      'name',
      'accountId',
      'stage',
      'closeDate',
    ]);
  });
});
