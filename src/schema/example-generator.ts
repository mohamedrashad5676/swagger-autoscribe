import type { JsonSchema } from './source-schema-extractor';
import {
  ISO_DATE_EXAMPLE,
  UUID_EXAMPLE,
  coerceToSchema,
  createDefaultMatchers,
  nameInfo,
  type ExampleMatcher,
} from './example-matchers';

// Generates a realistic example value for a schema node, using the property
// NAME's semantics (not just its TS type) wherever the name is recognized.
// Sensitive fields (password, tokens, secrets) get clearly-fake placeholders,
// never anything that could pass for a real credential.

export type SchemaRefResolver = (refName: string) => JsonSchema | undefined;

export interface ExampleOptions {
  /** Base URL used for `*Url` / `link` examples. Default `https://example.com`. */
  baseUrl?: string;
  /** Exact property name (case/format-insensitive) -> example. Wins over every matcher. */
  byName?: Record<string, unknown>;
  /** Extra matchers, evaluated BEFORE the built-in ones. */
  matchers?: ExampleMatcher[];
  /** Key used for the single example entry of a dynamic-key map (`Record<string, T>`). Default `key`. */
  dynamicKey?: string;
  /** Set false to skip the built-in name heuristics (type-based examples only). */
  useDefaultMatchers?: boolean;
}

export type ExampleGenerator = (
  schema: JsonSchema,
  propertyName?: string,
  resolveRef?: SchemaRefResolver,
  visitedRefs?: Set<string>,
) => unknown;

export function createExampleGenerator(options: ExampleOptions = {}): ExampleGenerator {
  const baseUrl = options.baseUrl ?? 'https://example.com';
  const dynamicKey = options.dynamicKey ?? 'key';
  const matchers: ExampleMatcher[] = [
    ...(options.matchers ?? []),
    ...(options.useDefaultMatchers === false ? [] : createDefaultMatchers({ baseUrl })),
  ];
  const byName = new Map<string, unknown>();
  for (const [k, v] of Object.entries(options.byName ?? {})) byName.set(nameInfo(k).joined, v);

  function nameBasedExample(propertyName: string, schema: JsonSchema): unknown | undefined {
    const info = nameInfo(propertyName);
    if (byName.has(info.joined)) {
      const coerced = coerceToSchema(byName.get(info.joined), schema);
      if (coerced !== undefined) return coerced;
    }
    for (const m of matchers) {
      if (!m.test(info)) continue;
      const coerced = coerceToSchema(m.value(info), schema);
      if (coerced !== undefined) return coerced;
    }
    return undefined;
  }

  const generate: ExampleGenerator = (schema, propertyName, resolveRef, visitedRefs = new Set()) => {
    if (schema.$ref) {
      const refName = schema.$ref.replace('#/components/schemas/', '');
      if (visitedRefs.has(refName)) return {}; // circular DTO — stop, don't loop forever
      const resolved = resolveRef?.(refName);
      if (!resolved) return {};
      return generate(resolved, propertyName, resolveRef, new Set(visitedRefs).add(refName));
    }

    if (schema.example !== undefined) return schema.example;
    if (schema.enum && schema.enum.length > 0) return schema.enum[0];
    if (schema.default !== undefined) return schema.default;
    if (schema.oneOf && schema.oneOf.length > 0) return generate(schema.oneOf[0], propertyName, resolveRef, visitedRefs);

    // Name-based heuristics only apply to LEAF (scalar) schemas. An object or
    // array must always recurse into its real structure — a property named
    // "data" must not let a name match short-circuit past its nested schema.
    const isLeaf = schema.type !== 'object' && schema.type !== 'array';

    if (isLeaf && schema.type === 'string' && schema.format) {
      const byFormat = formatExample(schema.format);
      if (byFormat !== undefined) return byFormat;
    }

    if (isLeaf && propertyName) {
      const byNameValue = nameBasedExample(propertyName, schema);
      if (byNameValue !== undefined) return byNameValue;
    }

    switch (schema.type) {
      case 'string': {
        // Fixed-digit-count patterns (`^\d{6}$` OTP/code validators) get a
        // matching digit string instead of a value their own validator rejects.
        const digitMatch = schema.pattern?.match(/^\^?\\d\{(\d+)\}\$?$/);
        if (digitMatch) return '1'.repeat(Number(digitMatch[1]));
        const raw = 'Example value';
        return schema.maxLength !== undefined && raw.length > schema.maxLength ? raw.slice(0, schema.maxLength) : raw;
      }
      case 'number':
      case 'integer':
        return coerceToSchema(25, schema);
      case 'boolean':
        return true;
      case 'array':
        return schema.items ? [generate(schema.items, propertyName, resolveRef, visitedRefs)] : [];
      case 'object': {
        if (schema.properties) {
          const result: Record<string, unknown> = {};
          for (const [key, propSchema] of Object.entries(schema.properties)) {
            result[key] = generate(propSchema, key, resolveRef, visitedRefs);
          }
          return result;
        }
        // Dynamic-key map (Record<string, T[]>) — no fixed `properties`, only
        // `additionalProperties`: one representative entry.
        if (schema.additionalProperties && typeof schema.additionalProperties !== 'boolean') {
          return { [dynamicKey]: generate(schema.additionalProperties, propertyName, resolveRef, visitedRefs) };
        }
        return {};
      }
      default:
        return null;
    }
  };
  return generate;
}

function formatExample(format: string): string | undefined {
  switch (format) {
    case 'date-time':
      return ISO_DATE_EXAMPLE;
    case 'date':
      return '2026-01-15';
    case 'email':
      return 'ahmed.hassan@example.com';
    case 'uuid':
      return UUID_EXAMPLE;
    case 'uri':
    case 'url':
      return 'https://example.com/resource';
    case 'binary':
      return '(binary)';
    default:
      return undefined;
  }
}

/** Generator with the built-in defaults (also exported for ad-hoc use). */
export const generateExample: ExampleGenerator = createExampleGenerator();
