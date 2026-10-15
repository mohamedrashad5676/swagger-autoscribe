// Request / response facts read from the generated OpenAPI document (which is
// itself derived from the DTO classes and their class-validator decorators),
// so validation constraints and response shapes are source-proven.

import type { OpenAPIObject } from '@nestjs/swagger';
import { fieldLabel } from './prose';

export type ConstraintKind = 'enum' | 'email' | 'uuid' | 'format' | 'range' | 'length' | 'url' | 'date';

export interface FieldFact {
  name: string;
  label: string;
  required: boolean;
  type: string;
  // Meaningful constraints only; plain `string`/`number` typing is not one.
  constraints: ConstraintKind[];
}

export interface ResponseFacts {
  list: boolean;
  paginated: boolean;
  // Scalar fields of one returned item.
  fields: FieldFact[];
  // Nested objects / arrays of one returned item (related data).
  related: string[];
}

export const EMPTY_RESPONSE: ResponseFacts = { list: false, paginated: false, fields: [], related: [] };

interface Schema {
  $ref?: string;
  type?: string;
  format?: string;
  enum?: unknown[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  allOf?: Schema[];
}

const NOISE_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'deletedAt', 'created_at', 'updated_at', 'deleted_at']);
const ENVELOPE_KEYS = new Set(['total', 'page', 'limit', 'totalPages', 'data', 'success', 'message', 'meta']);
const MAX_FIELDS = 12;

function resolve(document: OpenAPIObject, schema: Schema | undefined): Schema | undefined {
  let cur = schema;
  for (let i = 0; i < 5 && cur?.$ref; i++) {
    cur = document.components?.schemas?.[cur.$ref.split('/').pop()!] as Schema | undefined;
  }
  if (cur?.allOf && !cur.properties) {
    const merged: Schema = { properties: {}, required: [] };
    for (const part of cur.allOf) {
      const r = resolve(document, part);
      Object.assign(merged.properties!, r?.properties);
      merged.required!.push(...(r?.required ?? []));
    }
    return merged;
  }
  return cur;
}

function constraintsOf(prop: Schema): ConstraintKind[] {
  const out: ConstraintKind[] = [];
  if (Array.isArray(prop.enum) && prop.enum.length > 0) out.push('enum');
  if (prop.format === 'email') out.push('email');
  if (prop.format === 'uuid') out.push('uuid');
  if (prop.format === 'uri' || prop.format === 'url') out.push('url');
  if (prop.format === 'date-time' || prop.format === 'date') out.push('date');
  if (prop.pattern) out.push('format');
  if (prop.minimum !== undefined || prop.maximum !== undefined) out.push('range');
  if ((prop.minLength ?? 0) > 0 || prop.maxLength !== undefined) out.push('length');
  return out;
}

function fieldsOf(document: OpenAPIObject, schema: Schema | undefined): FieldFact[] {
  const resolved = resolve(document, schema);
  const props = resolved?.properties;
  if (!props) return [];
  const required = resolved?.required ?? [];
  return Object.entries(props)
    .slice(0, 60)
    .map(([name, raw]) => {
      const prop = resolve(document, raw) ?? raw;
      const type = prop.type ?? (prop.properties ? 'object' : 'unknown');
      return {
        name,
        label: fieldLabel(name, type),
        required: required.includes(name),
        type,
        constraints: constraintsOf(prop),
      };
    });
}

export function requestFactsOf(document: OpenAPIObject, operation: Record<string, unknown>): FieldFact[] {
  const body = operation.requestBody as { content?: Record<string, { schema?: Schema }> } | undefined;
  let schema = body?.content?.['application/json']?.schema;
  const resolved = resolve(document, schema);
  if (resolved?.type === 'array') schema = resolved.items;
  return fieldsOf(document, schema);
}

export function responseFactsOf(document: OpenAPIObject, operation: Record<string, unknown>): ResponseFacts {
  const responses = operation.responses as Record<string, { content?: Record<string, { schema?: Schema }> }> | undefined;
  const code = Object.keys(responses ?? {}).find((c) => c.startsWith('2'));
  const root = resolve(document, responses?.[code ?? '']?.content?.['application/json']?.schema);
  if (!root) return EMPTY_RESPONSE;

  let item: Schema | undefined = root;
  let list = false;
  let paginated = false;
  if (root.properties?.data) {
    const data = resolve(document, root.properties.data);
    paginated = Boolean(root.properties.total || root.properties.totalPages);
    if (data?.type === 'array') {
      list = true;
      item = resolve(document, data.items);
    } else {
      item = data;
    }
  } else if (root.type === 'array') {
    list = true;
    item = resolve(document, root.items);
  }
  const all = fieldsOf(document, item);
  const scalars = all.filter(
    (f) => !NOISE_FIELDS.has(f.name) && !ENVELOPE_KEYS.has(f.name) && f.type !== 'object' && f.type !== 'array',
  );
  const related = all
    .filter((f) => (f.type === 'object' || f.type === 'array') && !NOISE_FIELDS.has(f.name))
    .map((f) => f.label);
  return { list, paginated, fields: scalars.slice(0, MAX_FIELDS), related: related.slice(0, 6) };
}
