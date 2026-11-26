import { z } from 'zod';

/**
 * A deliberately small zod-to-JSON-Schema converter.
 *
 * The OpenAPI document is generated from the same zod schemas the server
 * validates with, so a documented field cannot drift from an enforced field.
 * Only the constructs this contract package actually uses are supported, and an
 * unsupported construct throws instead of emitting a wrong schema.
 *
 * Zod 4 keeps the public schema objects but moves the definition into
 * `_zod.def`; both spellings are read so a schema imported from a package built
 * against the previous major still refuses rather than silently emits `{}`.
 */

export type JsonSchema = Record<string, unknown>;

type CheckDef = {
  check?: string;
  format?: string;
  value?: unknown;
  inclusive?: boolean;
  minimum?: number;
  maximum?: number;
};

type CheckLike = {
  def?: CheckDef;
  _zod?: { def?: CheckDef };
};

type SchemaDef = {
  type?: string;
  checks?: CheckLike[];
  values?: unknown[];
  entries?: Record<string, string>;
  element?: z.ZodTypeAny;
  valueType?: z.ZodTypeAny;
  innerType?: z.ZodTypeAny;
  defaultValue?: unknown;
  shape?: Record<string, z.ZodTypeAny>;
  catchall?: z.ZodTypeAny;
  options?: z.ZodTypeAny[];
};

type SchemaInternals = {
  _def?: SchemaDef;
  _zod?: { def?: SchemaDef };
  shape?: Record<string, z.ZodTypeAny>;
  options?: z.ZodTypeAny[] | Map<string, z.ZodTypeAny>;
  isOptional?: () => boolean;
};

function internals(schema: z.ZodTypeAny): SchemaInternals {
  return schema as unknown as SchemaInternals;
}

/** Zod 4 stores the definition on `_zod.def`; Zod 3 used `_def`. */
function def(schema: z.ZodTypeAny): SchemaDef {
  const value = internals(schema);
  return value._zod?.def ?? value._def ?? {};
}

function checks(schema: z.ZodTypeAny): CheckDef[] {
  return (def(schema).checks ?? []).map(
    (entry) => entry.def ?? entry._zod?.def ?? (entry as CheckDef),
  );
}

function numberBounds(schema: z.ZodTypeAny): JsonSchema {
  const out: JsonSchema = { type: 'number' };
  for (const check of checks(schema)) {
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
  for (const check of checks(schema)) {
    if (check.check === 'min_length' && typeof check.minimum === 'number') {
      out.minLength = check.minimum;
    }
    if (check.check === 'max_length' && typeof check.maximum === 'number') {
      out.maxLength = check.maximum;
    }
    if (check.check === 'string_format' && check.format === 'datetime') {
      out.format = 'date-time';
    }
  }
  return out;
}

function literalValue(schema: z.ZodTypeAny): JsonSchema {
  const values = def(schema).values ?? [];
  return values.length === 1 ? { const: values[0] } : { enum: [...values] };
}

export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const definition = def(schema);
  const type = definition.type;
  switch (type) {
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
    case 'literal':
      return literalValue(schema);
    case 'enum':
      return { type: 'string', enum: Object.keys(definition.entries ?? {}) };
    case 'array': {
      const item = definition.element ? toJsonSchema(definition.element) : {};
      return { type: 'array', items: item };
    }
    case 'record':
      return {
        type: 'object',
        additionalProperties: definition.valueType ? toJsonSchema(definition.valueType) : true,
      };
    case 'optional':
    case 'nullable': {
      const inner = definition.innerType ? toJsonSchema(definition.innerType) : {};
      if (type === 'nullable') {
        return { anyOf: [inner, { type: 'null' }] };
      }
      return inner;
    }
    case 'default':
      // Defaults are applied by the server but are not part of the published
      // shape; this keeps the generated document identical across zod majors.
      return definition.innerType ? toJsonSchema(definition.innerType) : {};
    case 'object': {
      const shape = definition.shape ?? internals(schema).shape ?? {};
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = toJsonSchema(value);
        const valueDef = def(value);
        const optional =
          valueDef.type === 'optional' ||
          valueDef.type === 'default' ||
          (valueDef.type === 'nullable' && internals(value).isOptional?.() === true) ||
          internals(value).isOptional?.() === true;
        if (!optional) required.push(key);
      }
      const out: JsonSchema = { type: 'object', properties };
      if (required.length > 0) out.required = required;
      if (def(definition.catchall ?? ({} as z.ZodTypeAny)).type === 'never') {
        out.additionalProperties = false;
      }
      return out;
    }
    case 'union': {
      const raw = internals(schema).options ?? definition.options ?? [];
      const options = raw instanceof Map ? [...raw.values()] : raw;
      return { anyOf: options.map(toJsonSchema) };
    }
    default:
      throw new Error(`toJsonSchema does not support ${String(type)}`);
  }
}
