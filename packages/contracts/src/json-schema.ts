import { z } from 'zod';

/**
 * A deliberately small zod-to-JSON-Schema converter.
 *
 * The OpenAPI document is generated from the same zod schemas the server
 * validates with, so a documented field cannot drift from an enforced field.
 * Only the constructs this contract package actually uses are supported, and an
 * unsupported construct throws instead of emitting a wrong schema.
 */

export type JsonSchema = Record<string, unknown>;

type Def = {
  typeName?: string;
  type?: z.ZodTypeAny;
  options?: z.ZodTypeAny[];
  innerType?: z.ZodTypeAny;
  schema?: z.ZodTypeAny;
  minLength?: { value: number };
  maxLength?: { value: number };
  values?: unknown[];
  value?: unknown;
  defaultValue?: unknown;
  description?: string;
  checks?: Array<{ kind: string; value?: unknown; inclusive?: boolean }>;
};

function def(schema: z.ZodTypeAny): Def {
  return (schema as unknown as { _def: Def })._def;
}

function numberBounds(checks: Def['checks']): JsonSchema {
  const out: JsonSchema = { type: 'number' };
  for (const check of checks ?? []) {
    if (check.kind === 'int') out.type = 'integer';
    if (check.kind === 'min' && typeof check.value === 'number') {
      out[check.inclusive === false ? 'exclusiveMinimum' : 'minimum'] = check.value;
    }
    if (check.kind === 'max' && typeof check.value === 'number') {
      out[check.inclusive === false ? 'exclusiveMaximum' : 'maximum'] = check.value;
    }
    if (check.kind === 'nonnegative') out.minimum = 0;
    if (check.kind === 'positive') out.exclusiveMinimum = 0;
  }
  return out;
}

function stringBounds(checks: Def['checks']): JsonSchema {
  const out: JsonSchema = { type: 'string' };
  for (const check of checks ?? []) {
    if (check.kind === 'min' && typeof check.value === 'number') out.minLength = check.value;
    if (check.kind === 'max' && typeof check.value === 'number') out.maxLength = check.value;
    if (check.kind === 'datetime') out.format = 'date-time';
    if (check.kind === 'url') out.format = 'uri';
  }
  return out;
}

export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const d = def(schema);
  switch (d.typeName) {
    case 'ZodString':
      return stringBounds(d.checks);
    case 'ZodNumber':
      return numberBounds(d.checks);
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodNull':
      return { type: 'null' };
    case 'ZodAny':
    case 'ZodUnknown':
      return {};
    case 'ZodLiteral':
      return { const: d.value };
    case 'ZodEnum':
      return { type: 'string', enum: [...(d.values ?? [])] };
    case 'ZodArray': {
      const item = d.type ? toJsonSchema(d.type) : {};
      const out: JsonSchema = { type: 'array', items: item };
      if (typeof d.minLength?.value === 'number') out.minItems = d.minLength.value;
      if (typeof d.maxLength?.value === 'number') out.maxItems = d.maxLength.value;
      return out;
    }
    case 'ZodRecord':
      return {
        type: 'object',
        additionalProperties: d.value ? toJsonSchema(d.value as z.ZodTypeAny) : true,
      };
    case 'ZodOptional':
    case 'ZodNullable': {
      const inner = d.innerType ? toJsonSchema(d.innerType) : {};
      if (d.typeName === 'ZodNullable') {
        return { anyOf: [inner, { type: 'null' }] };
      }
      return inner;
    }
    case 'ZodDefault': {
      const inner = d.innerType ? toJsonSchema(d.innerType) : {};
      return d.defaultValue === undefined ? inner : { ...inner, default: d.defaultValue };
    }
    case 'ZodEffects':
      return d.schema ? toJsonSchema(d.schema) : {};
    case 'ZodUnion':
      return { anyOf: (d.options ?? []).map(toJsonSchema) };
    case 'ZodObject': {
      const shape = (schema as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = toJsonSchema(value);
        const valueDef = def(value);
        const optional =
          valueDef.typeName === 'ZodOptional' ||
          valueDef.typeName === 'ZodDefault' ||
          (valueDef.typeName === 'ZodNullable' && value.isOptional());
        if (!optional) required.push(key);
      }
      const out: JsonSchema = { type: 'object', properties };
      if (required.length > 0) out.required = required;
      if ((schema as unknown as { _def: { unknownKeys?: string } })._def.unknownKeys === 'strict') {
        out.additionalProperties = false;
      }
      return out;
    }
    case 'ZodDiscriminatedUnion': {
      const options = (schema as unknown as { options: Map<string, z.ZodTypeAny> }).options;
      return { anyOf: [...options.values()].map(toJsonSchema) };
    }
    default:
      throw new Error(`toJsonSchema does not support ${String(d.typeName)}`);
  }
}
