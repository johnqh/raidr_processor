/**
 * JSON Schema inference from sample values. Produces a deliberately small
 * subset of JSON Schema that `schemaToType` can turn into TypeScript.
 */

/**
 * The subset of JSON Schema this package emits. `unknown` means no evidence
 * (e.g. items of an empty array); `integer` and `number` are kept apart so a
 * single float widens the field.
 */
export type JsonSchema =
  | { type: 'unknown' }
  | { type: 'null' }
  | { type: 'boolean' }
  | { type: 'integer' }
  | { type: 'number' }
  | { type: 'string'; enum?: string[] }
  | { type: 'array'; items: JsonSchema }
  | { type: 'object'; properties: Record<string, JsonSchema>; required: string[] }
  | { anyOf: JsonSchema[] };

/** A string field is an enum if it stays this narrow across this many samples. */
const ENUM_MAX_DISTINCT = 6;
const ENUM_MIN_SAMPLES = 4;

function schemaOf(value: unknown): JsonSchema {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    return {
      type: 'array',
      items: value.length === 0 ? { type: 'unknown' } : inferSchema(value),
    };
  }
  switch (typeof value) {
    case 'boolean':
      return { type: 'boolean' };
    case 'number':
      return Number.isInteger(value) ? { type: 'integer' } : { type: 'number' };
    case 'string':
      return { type: 'string' };
    case 'object': {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(value as object)) {
        properties[key] = schemaOf(child);
        required.push(key);
      }
      return { type: 'object', properties, required };
    }
    default:
      return { type: 'unknown' };
  }
}

function kindOf(schema: JsonSchema): string {
  return 'anyOf' in schema ? 'anyOf' : schema.type;
}

function sortKeys(properties: Record<string, JsonSchema>): Record<string, JsonSchema> {
  const out: Record<string, JsonSchema> = {};
  for (const key of Object.keys(properties).sort()) out[key] = properties[key]!;
  return out;
}

/** Deduplicate union members and sort them, so unification is order-independent. */
function collapseUnion(members: JsonSchema[]): JsonSchema {
  const byKey = new Map<string, JsonSchema>();
  for (const member of members) {
    const key = JSON.stringify(member);
    if (!byKey.has(key)) byKey.set(key, member);
  }
  const unique = Array.from(byKey.entries())
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, schema]) => schema);
  return unique.length === 1 ? unique[0]! : { anyOf: unique };
}

/**
 * Merges two schemas into one that admits both. Object properties are merged
 * and `required` becomes their intersection, except that objects sharing no
 * keys become a union; mismatched kinds become an `anyOf`. Unions are
 * deduplicated and sorted, so the result does not depend on argument order.
 */
export function unifySchemas(a: JsonSchema, b: JsonSchema): JsonSchema {
  if (kindOf(a) === 'unknown') return b;
  if (kindOf(b) === 'unknown') return a;

  // Numeric widening: one float among integers makes the field a number.
  const numeric = new Set(['integer', 'number']);
  if (numeric.has(kindOf(a)) && numeric.has(kindOf(b))) {
    return kindOf(a) === kindOf(b) ? a : { type: 'number' };
  }

  if (kindOf(a) === 'anyOf' || kindOf(b) === 'anyOf') {
    return collapseUnion([
      ...('anyOf' in a ? a.anyOf : [a]),
      ...('anyOf' in b ? b.anyOf : [b]),
    ]);
  }

  if (kindOf(a) !== kindOf(b)) return collapseUnion([a, b]);

  if ('type' in a && 'type' in b) {
    if (a.type === 'array' && b.type === 'array') {
      return { type: 'array', items: unifySchemas(a.items, b.items) };
    }

    if (a.type === 'object' && b.type === 'object') {
      // Objects sharing no keys at all are distinct shapes, not one shape with
      // everything optional. Merging them would erase the difference between a
      // success body and an error body and make every field optional.
      const aKeys = Object.keys(a.properties);
      const bKeys = Object.keys(b.properties);
      const shared = aKeys.filter((key) => bKeys.includes(key));
      if (aKeys.length > 0 && bKeys.length > 0 && shared.length === 0) {
        return collapseUnion([a, b]);
      }

      const properties: Record<string, JsonSchema> = {};
      for (const key of new Set([
        ...Object.keys(a.properties),
        ...Object.keys(b.properties),
      ])) {
        const left = a.properties[key];
        const right = b.properties[key];
        properties[key] = left && right ? unifySchemas(left, right) : (left ?? right)!;
      }
      // Required is the intersection: a field absent from any sample is optional.
      const required = a.required.filter((key) => b.required.includes(key)).sort();
      return { type: 'object', properties: sortKeys(properties), required };
    }

    if (a.type === 'string' && b.type === 'string') {
      if (a.enum && b.enum) {
        return {
          type: 'string',
          enum: Array.from(new Set([...a.enum, ...b.enum])).sort(),
        };
      }
      return { type: 'string' };
    }
  }

  return a;
}

/** Promote narrow string fields to enums, using the full sample set. */
function applyEnums(schema: JsonSchema, samples: unknown[]): JsonSchema {
  if (!('type' in schema) || schema.type !== 'object') return schema;
  if (samples.length < ENUM_MIN_SAMPLES) return schema;

  const objects = samples.filter(
    (s): s is Record<string, unknown> =>
      typeof s === 'object' && s !== null && !Array.isArray(s)
  );

  const properties: Record<string, JsonSchema> = {};
  for (const [key, child] of Object.entries(schema.properties)) {
    if ('type' in child && child.type === 'string') {
      const values = objects
        .map((o) => o[key])
        .filter((v): v is string => typeof v === 'string');
      const distinct = Array.from(new Set(values)).sort();
      properties[key] =
        values.length >= ENUM_MIN_SAMPLES && distinct.length <= ENUM_MAX_DISTINCT
          ? { type: 'string', enum: distinct }
          : child;
      continue;
    }
    if ('type' in child && child.type === 'object') {
      properties[key] = applyEnums(
        child,
        objects.map((o) => o[key])
      );
      continue;
    }
    properties[key] = child;
  }

  return { ...schema, properties: sortKeys(properties) };
}

/**
 * Infers one schema for a set of sample values (e.g. every 200 body of one
 * endpoint). With 4 or more samples, a string property that takes at most 6
 * distinct values becomes an enum; this applies to object properties only,
 * recursively, not to top-level strings or array items. Returns
 * `{ type: 'unknown' }` for no samples.
 */
export function inferSchema(samples: unknown[]): JsonSchema {
  if (samples.length === 0) return { type: 'unknown' };
  const unified = samples.map(schemaOf).reduce((acc, next) => unifySchemas(acc, next));
  return applyEnums(unified, samples);
}
