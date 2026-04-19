/**
 * Property-based tests for MCP-to-Gemini schema conversion.
 *
 * **Validates: Requirements 4.2**
 *
 * Property 3: MCP-to-Gemini Schema Conversion
 * For any MCP tool schema (with name, description, and inputSchema containing
 * properties and required fields), converting it to a Gemini FunctionDeclaration
 * should produce an object where the name, description, and all parameter
 * names/types/descriptions are preserved.
 */

import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import { convertToolSchema } from '../../src/utils/schema-converter.js';
import type { ToolSchema } from '../../src/services/mcp-bridge.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const NUM_RUNS = 100;

/** Known JSON Schema types that the converter handles. */
const KNOWN_TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object'] as const;

/** Expected Gemini type mapping for each JSON Schema type. */
const EXPECTED_TYPE_MAP: Record<string, string> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
};

// ────────────────────────────────────────────────────────────────
// Arbitraries
// ────────────────────────────────────────────────────────────────

/** Tool names: non-empty alphanumeric + underscore (realistic MCP tool names). */
const toolNameArb = fc
  .stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
  .filter((s) => s.length >= 1 && s.length <= 80);

/** Property names: non-empty alphanumeric + underscore. */
const propNameArb = fc
  .stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
  .filter((s) => s.length >= 1 && s.length <= 60);

/** Arbitrary description string (can be empty). */
const descriptionArb = fc.string({ minLength: 0, maxLength: 200 });

/** Arbitrary non-empty description string. */
const nonEmptyDescriptionArb = fc.string({ minLength: 1, maxLength: 200 });

/** Arbitrary JSON Schema type from the known set. */
const jsonSchemaTypeArb = fc.constantFrom(...KNOWN_TYPES);

/** Arbitrary property definition with a known type and optional description. */
const propertyDefArb = fc.record({
  type: jsonSchemaTypeArb,
  description: fc.option(nonEmptyDescriptionArb, { nil: undefined }),
});

/**
 * Generate a record of property definitions with unique property names.
 * Returns 0–10 properties.
 */
const propertiesArb = fc
  .uniqueArray(propNameArb, { minLength: 0, maxLength: 10 })
  .chain((names) =>
    fc.tuple(
      fc.constant(names),
      fc.array(propertyDefArb, { minLength: names.length, maxLength: names.length }),
    ),
  )
  .map(([names, defs]) => {
    const props: Record<string, { type: string; description?: string }> = {};
    for (let i = 0; i < names.length; i++) {
      props[names[i]] = defs[i];
    }
    return props;
  });

/**
 * Generate a complete ToolSchema with random name, description,
 * properties, and a valid required subset.
 */
const toolSchemaArb: fc.Arbitrary<ToolSchema> = fc
  .tuple(toolNameArb, descriptionArb, propertiesArb)
  .chain(([name, description, properties]) => {
    const propNames = Object.keys(properties);
    // Generate a random subset of property names as required fields
    const requiredArb =
      propNames.length > 0
        ? fc.subarray(propNames, { minLength: 0, maxLength: propNames.length })
        : fc.constant([] as string[]);

    return requiredArb.map((required) => ({
      name,
      description,
      inputSchema: {
        type: 'object' as const,
        properties,
        required,
      },
    }));
  });

// ────────────────────────────────────────────────────────────────
// Property tests
// ────────────────────────────────────────────────────────────────

describe('Property 3: MCP-to-Gemini Schema Conversion', () => {
  it('name is preserved for any tool schema', () => {
    fc.assert(
      fc.property(toolSchemaArb, (schema) => {
        const result = convertToolSchema(schema);
        expect(result.name).toBe(schema.name);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('description is preserved for any tool schema', () => {
    fc.assert(
      fc.property(toolSchemaArb, (schema) => {
        const result = convertToolSchema(schema);
        expect(result.description).toBe(schema.description);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('all parameter names are preserved in the converted declaration', () => {
    fc.assert(
      fc.property(toolSchemaArb, (schema) => {
        const result = convertToolSchema(schema);
        const inputPropNames = Object.keys(schema.inputSchema.properties);
        const outputPropNames = Object.keys(result.parameters.properties);

        // Every input property name must appear in the output
        for (const name of inputPropNames) {
          expect(outputPropNames).toContain(name);
        }
        // Output should have exactly the same property names (no extras)
        expect(outputPropNames).toHaveLength(inputPropNames.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('parameter types are correctly mapped from JSON Schema to Gemini types', () => {
    fc.assert(
      fc.property(toolSchemaArb, (schema) => {
        const result = convertToolSchema(schema);

        for (const [propName, propDef] of Object.entries(schema.inputSchema.properties)) {
          const convertedProp = result.parameters.properties[propName];
          const expectedType = EXPECTED_TYPE_MAP[propDef.type] ?? 'STRING';
          expect(convertedProp.type).toBe(expectedType);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('required fields are preserved in the converted declaration', () => {
    fc.assert(
      fc.property(toolSchemaArb, (schema) => {
        const result = convertToolSchema(schema);

        // Same required array contents (order preserved)
        expect(result.parameters.required).toEqual(schema.inputSchema.required);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('top-level parameters type is always OBJECT for any tool schema', () => {
    fc.assert(
      fc.property(toolSchemaArb, (schema) => {
        const result = convertToolSchema(schema);
        expect(result.parameters.type).toBe('OBJECT');
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
