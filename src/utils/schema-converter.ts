/**
 * MCP-to-Gemini Schema Converter
 *
 * Converts MCP tool schemas (JSON Schema format) to Gemini
 * FunctionDeclaration format for registration with the Gemini API.
 *
 * Type mapping:
 *   JSON Schema → Gemini
 *   'string'    → 'STRING'
 *   'number'    → 'NUMBER'
 *   'integer'   → 'INTEGER'
 *   'boolean'   → 'BOOLEAN'
 *   'array'     → 'ARRAY'
 *   'object'    → 'OBJECT'
 *   unknown     → 'STRING' (safe fallback)
 *
 * @module schema-converter
 */

import type { ToolSchema } from '../services/mcp-bridge.js';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

/** Gemini parameter type — uppercase string enum. */
export type GeminiType =
  | 'STRING'
  | 'NUMBER'
  | 'INTEGER'
  | 'BOOLEAN'
  | 'ARRAY'
  | 'OBJECT';

/** Schema for a single parameter in a Gemini function declaration. */
export interface GeminiParameterSchema {
  type: GeminiType;
  description?: string;
  enum?: string[];
  items?: GeminiParameterSchema;
  properties?: Record<string, GeminiParameterSchema>;
  required?: string[];
}

/** Gemini function declaration — the target format. */
export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: 'OBJECT';
    properties: Record<string, GeminiParameterSchema>;
    required: string[];
  };
}

// ────────────────────────────────────────────────────────────────
// Type mapping
// ────────────────────────────────────────────────────────────────

const TYPE_MAP: Record<string, GeminiType> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
};

/**
 * Map a JSON Schema type string to a Gemini type.
 * Falls back to 'STRING' for unknown or missing types.
 */
function mapType(jsonSchemaType: unknown): GeminiType {
  if (typeof jsonSchemaType === 'string' && jsonSchemaType in TYPE_MAP) {
    return TYPE_MAP[jsonSchemaType];
  }
  return 'STRING';
}

// ────────────────────────────────────────────────────────────────
// Property conversion (recursive)
// ────────────────────────────────────────────────────────────────

/**
 * Convert a single JSON Schema property definition to a
 * GeminiParameterSchema. Handles nested objects, arrays with
 * items, and enum values recursively.
 */
function convertProperty(prop: Record<string, any>): GeminiParameterSchema {
  const result: GeminiParameterSchema = {
    type: mapType(prop.type),
  };

  // Preserve description
  if (typeof prop.description === 'string' && prop.description.length > 0) {
    result.description = prop.description;
  }

  // Preserve enum values
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    result.enum = prop.enum.filter(
      (v: unknown): v is string => typeof v === 'string',
    );
    // Only keep enum if there are valid string entries
    if (result.enum.length === 0) {
      delete result.enum;
    }
  }

  // Handle array items
  if (result.type === 'ARRAY' && prop.items && typeof prop.items === 'object') {
    result.items = convertProperty(prop.items);
  }

  // Handle nested object properties
  if (
    result.type === 'OBJECT' &&
    prop.properties &&
    typeof prop.properties === 'object'
  ) {
    result.properties = convertProperties(prop.properties);

    if (Array.isArray(prop.required) && prop.required.length > 0) {
      result.required = prop.required.filter(
        (r: unknown): r is string => typeof r === 'string',
      );
    }
  }

  return result;
}

/**
 * Convert a Record of JSON Schema properties to Gemini format.
 */
function convertProperties(
  properties: Record<string, any>,
): Record<string, GeminiParameterSchema> {
  const result: Record<string, GeminiParameterSchema> = {};

  for (const [key, value] of Object.entries(properties)) {
    if (value && typeof value === 'object') {
      result[key] = convertProperty(value);
    }
  }

  return result;
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Convert a single MCP tool schema to a Gemini FunctionDeclaration.
 *
 * @param schema  MCP tool schema from `tools/list`
 * @returns       Gemini-compatible function declaration
 */
export function convertToolSchema(
  schema: ToolSchema,
): GeminiFunctionDeclaration {
  return {
    name: schema.name,
    description: schema.description,
    parameters: {
      type: 'OBJECT',
      properties: convertProperties(schema.inputSchema.properties),
      required: Array.isArray(schema.inputSchema.required)
        ? schema.inputSchema.required.filter(
            (r: unknown): r is string => typeof r === 'string',
          )
        : [],
    },
  };
}

/**
 * Convert all MCP tool schemas to Gemini FunctionDeclarations.
 *
 * @param schemas  Array of MCP tool schemas
 * @returns        Array of Gemini function declarations
 */
export function convertAllSchemas(
  schemas: ToolSchema[],
): GeminiFunctionDeclaration[] {
  return schemas.map(convertToolSchema);
}
