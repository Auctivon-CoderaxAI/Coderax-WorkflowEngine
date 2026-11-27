import { z } from 'zod';

/**
 * A deliberately small zod-to-JSON-Schema converter.
 *
 * The OpenAPI document is generated from the same zod schemas the server
 * validates with, so a documented field cannot drift from an enforced field.
 * Only the constructs this contract package actually uses are supported, and an
 * unsupported construct throws instead of emitting a wrong schema.
 *
 * The walker reads zod 4's public `_zod.def` shape. It intentionally does not
 * call `z.toJSONSchema` because the OpenAPI document is part of this repository's
 * contract and must stay byte-stable; a vendor upgrade must not silently rewrite
 * every published schema.
 */

export type JsonSchema = Record<string, unknown>;

type CheckDef = {
  check?: string;
  minimum?: number;
  maximum?: number;
  value?: number;
  inclusive?: boolean;
  format?: string;
  pattern?: RegExp;
};

type ZodDef = {
  type?: string;
  checks?: Array<{ _zod?: { def?: CheckDef } }>;
  entries?: Record<string, unknown>;
  values?: unknown[];
  element?: z.ZodTypeAny;
  keyType?: z.ZodTypeAny;
  valueType?: z.ZodTypeAny;
  innerType?: z.ZodTypeAny;
  defaultValue?: unknown;
  shape?: Record<string, z.ZodTypeAny>;
  catchall?: z.ZodTypeAny;
  options?: z.ZodTypeAny[];
  discriminator?: string;
};

function def(schema: z.ZodTypeAny): ZodDef {
  const modern = (schema as unknown as { _zod?: { def?: ZodDef } })._zod?.def;
  if (modern) return modern;
  throw new Error('toJsonSchema requires the zod 4 schema shape');
}

function checksOf(schema: z.ZodTypeAny): CheckDef[] {
  return (def(schema).checks ?? [])
    .map((check) => check._zod?.def)
    .filter((check): check is CheckDef => check !== undefined);
}

function numberBounds(schema: z.ZodTypeAny): JsonSchema {
  const out: JsonSchema = { type: 'number' };
  for (const check of checksOf(schema)) {
    if (check.check === 'number_format' && check.format === 'safeint') out.type = 'integer';
    if (check.check === 'greater_than' && typeof check.value === 'number') {
      out[check.inclusive === false ? 'exclusiveMinimum' : 'minimum'] = check.value;
    }
    if (check.check === 'less_than' && typeof check.value === 'number') {
      out[check.inclusive === false ? 'exclusiveMaximum' : 'maximum'] = check.value;
    }
  }
  return out;
}

function stringBounds(schema: z.ZodTypeAny): JsonSchema {
  const out: JsonSchema = { type: 'string' };
  for (const check of checksOf(schema)) {
    if (check.check === 'min_length' && typeof check.minimum === 'number') {
      out.minLength = check.minimum;
    }
    if (check.check === 'max_length' && typeof check.maximum === 'number') {
      out.maxLength = check.maximum;
    }
    if (check.check === 'string_format' && typeof check.format === 'string') {
      if (check.format === 'regex' && check.pattern && !check.pattern.flags) out.pattern = check.pattern.source;
      else if (check.format === 'datetime') out.format = 'date-time';
      else if (check.format === 'email') out.format = 'email';
      else if (check.format === 'url') out.format = 'uri';
    }
  }
  return out;
}

function isOptional(schema: z.ZodTypeAny): boolean {
  // One probe covers optional, default and prefault without branching on every
  // wrapper type zod may add.
  const parsed = (schema as unknown as { safeParse?: (value: unknown) => { success: boolean } })
    .safeParse?.(undefined);
  return parsed?.success === true;
}

export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const d = def(schema);
  switch (d.type) {
    case 'string':
      return stringBounds(schema);
    case 'number':
      return numberBounds(schema);
    case 'boolean':
      return { type: 'boolean' };
    case 'null':
      return { type: 'null' };
    case 'any':
    case 'unknown':
      return {};
    case 'literal': {
      const values = d.values ?? [];
      if (values.length === 1) return { const: values[0] };
      return { enum: values };
    }
    case 'enum': {
      // A numeric enum's `entries` carry reverse-mapped names; the runtime
      // value set is what a client must be allowed to send.
      const runtime = (schema as unknown as { _zod?: { values?: Set<unknown> } })._zod?.values;
      const values = runtime ? [...runtime] : Object.values(d.entries ?? {});
      if (
        values.length === 0 ||
        values.some(
          (value) =>
            typeof value !== 'string' &&
            (typeof value !== 'number' || !Number.isFinite(value)),
        )
      ) {
        throw new Error('toJsonSchema does not support these enum values');
      }
      const types = [...new Set(values.map((value) => typeof value))];
      return { type: types.length === 1 ? types[0] : types, enum: values };
    }
    case 'array': {
      const item = d.element ? toJsonSchema(d.element) : {};
      const out: JsonSchema = { type: 'array', items: item };
      for (const check of checksOf(schema)) {
        if (check.check === 'min_length' && typeof check.minimum === 'number') {
          out.minItems = check.minimum;
        }
        if (check.check === 'max_length' && typeof check.maximum === 'number') {
          out.maxItems = check.maximum;
        }
      }
      return out;
    }
    case 'record': {
      const key = d.keyType;
      if (!key || def(key).type !== 'string' || checksOf(key).length > 0) {
        throw new Error('toJsonSchema supports only unconstrained string record keys');
      }
      return {
        type: 'object',
        additionalProperties: d.valueType ? toJsonSchema(d.valueType) : true,
      };
    }
    case 'optional': {
      return d.innerType ? toJsonSchema(d.innerType) : {};
    }
    case 'nullable': {
      const inner = d.innerType ? toJsonSchema(d.innerType) : {};
      return { anyOf: [inner, { type: 'null' }] };
    }
    case 'default':
    case 'prefault': {
      const inner = d.innerType ? toJsonSchema(d.innerType) : {};
      return d.defaultValue === undefined ? inner : { ...inner, default: d.defaultValue };
    }
    case 'union':
      return { anyOf: (d.options ?? []).map(toJsonSchema) };
    case 'object': {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(d.shape ?? {})) {
        properties[key] = toJsonSchema(value);
        if (!isOptional(value)) required.push(key);
      }
      const out: JsonSchema = { type: 'object', properties };
      if (required.length > 0) out.required = required;
      const catchall = d.catchall?._zod?.def?.type;
      if (catchall === 'never') out.additionalProperties = false;
      else if (catchall === 'unknown' || catchall === 'any') out.additionalProperties = true;
      return out;
    }
    default:
      throw new Error(`toJsonSchema does not support ${String(d.type)}`);
  }
}
