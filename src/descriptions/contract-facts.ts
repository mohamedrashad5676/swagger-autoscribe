// The CONTRACT layer of a description: what a caller can read off the generated OpenAPI operation itself —
// access, parameters, the request/response structure down to nested fields, constraints, defaults and the
// documented failures. Every item here is derived from a concrete artefact (a schema property, a declared
// parameter, a response entry, handler metadata); nothing is inferred from names or guessed.
//
// It sits next to the behavioural engine (business-facts.ts), it does not replace it: the engine explains what
// the operation DOES (rules, side effects, lifecycle); this layer states what the operation ACCEPTS and RETURNS.

import type { OpenAPIObject } from '@nestjs/swagger';
import type { Evidence, Fact } from './evidence';

interface Schema {
  $ref?: string;
  type?: string;
  format?: string;
  enum?: unknown[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  nullable?: boolean;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  additionalProperties?: Schema | boolean;
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
  description?: string;
  readOnly?: boolean;
}

export interface FieldDetail {
  name: string;
  type: string;
  required: boolean;
  notes: string[];
  children: FieldDetail[];
}

export interface ParameterDetail {
  name: string;
  where: 'path' | 'query' | 'header' | 'cookie';
  type: string;
  required: boolean;
  notes: string[];
  description?: string;
}

export interface FailureDetail {
  status: number;
  label: string;
  messages: { text: string; when?: string }[];
  /** Further distinct messages not listed (kept short on purpose). */
  more: number;
}

export interface ContractFacts {
  access?: { public: boolean; scheme?: string; permissions: string[] };
  parameters: ParameterDetail[];
  pagination?: string;
  request?: { contentType: string; list: boolean; fields: FieldDetail[] };
  responses: { status: number; label: string; contentType?: string; list: boolean; envelope: boolean; fields: FieldDetail[]; scalar?: string }[];
  failures: FailureDetail[];
  facts: Fact[];
}

export interface ContractContext {
  isPublic: boolean;
  requiredPermissions: string[];
  hasPagination: boolean;
  /** Where the operation is declared (for evidence); falls back to the operation key. */
  sourceFile?: string;
  operationKey: string;
}

const STATUS_LABEL: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 406: 'Not Acceptable', 408: 'Request Timeout', 409: 'Conflict', 410: 'Gone',
  412: 'Precondition Failed', 413: 'Payload Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Entity',
  429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

const MAX_DEPTH = 3;
const MAX_ENUM_SHOWN = 6;
const MAX_FIELDS = 40;
const MAX_MESSAGES = 4;

function deref(document: OpenAPIObject, schema: Schema | undefined, seen: string[] = []): { schema?: Schema; ref?: string } {
  let cur = schema;
  let ref: string | undefined;
  for (let i = 0; i < 6 && cur?.$ref; i++) {
    const name = cur.$ref.split('/').pop() as string;
    if (seen.includes(name)) return { ref: name };
    ref = name;
    cur = document.components?.schemas?.[name] as Schema | undefined;
  }
  if (cur?.allOf && !cur.properties) {
    const merged: Schema = { type: 'object', properties: {}, required: [] };
    for (const part of cur.allOf) {
      const r = deref(document, part, seen).schema;
      Object.assign(merged.properties as object, r?.properties);
      (merged.required as string[]).push(...(r?.required ?? []));
    }
    return { schema: merged, ref };
  }
  return { schema: cur, ref };
}

const FORMAT_TEXT: Record<string, string> = {
  email: 'valid email address',
  uuid: 'UUID',
  uri: 'URL',
  url: 'URL',
  'date-time': 'ISO 8601 timestamp',
  date: 'calendar date',
  binary: 'binary content',
  int64: '64-bit integer',
};

function notesOf(s: Schema): string[] {
  const notes: string[] = [];
  if (s.format && FORMAT_TEXT[s.format]) notes.push(FORMAT_TEXT[s.format]);
  if (Array.isArray(s.enum) && s.enum.length > 0) {
    const shown = s.enum.slice(0, MAX_ENUM_SHOWN).map(String);
    notes.push(`one of ${shown.join(', ')}${s.enum.length > MAX_ENUM_SHOWN ? `, … (${s.enum.length} values)` : ''}`);
  }
  if (s.minLength !== undefined && s.maxLength !== undefined) notes.push(`${s.minLength}–${s.maxLength} characters`);
  else if (s.minLength !== undefined && s.minLength > 0) notes.push(`at least ${s.minLength} characters`);
  else if (s.maxLength !== undefined) notes.push(`at most ${s.maxLength} characters`);
  if (s.minimum !== undefined && s.maximum !== undefined) notes.push(`between ${s.minimum} and ${s.maximum}`);
  else if (s.minimum !== undefined) notes.push(`at least ${s.minimum}`);
  else if (s.maximum !== undefined) notes.push(`at most ${s.maximum}`);
  if (s.minItems !== undefined && s.maxItems !== undefined) notes.push(`${s.minItems}–${s.maxItems} items`);
  else if (s.minItems !== undefined && s.minItems > 0) notes.push(`at least ${s.minItems} items`);
  else if (s.maxItems !== undefined) notes.push(`at most ${s.maxItems} items`);
  if (s.pattern) notes.push(`matches <code>${s.pattern.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\$/g, '&#36;')}</code>`);
  if (s.default !== undefined) notes.push(`default ${JSON.stringify(s.default)}`);
  if (s.nullable) notes.push('may be null');
  if (s.readOnly) notes.push('read-only');
  return notes;
}

function typeLabel(document: OpenAPIObject, s: Schema, depth: number, seen: string[]): string {
  const { schema, ref } = deref(document, s, seen);
  if (!schema) return ref ?? 'object';
  if (schema.oneOf || schema.anyOf) {
    const parts = (schema.oneOf ?? schema.anyOf ?? []).map((p) => typeLabel(document, p, depth, seen));
    return Array.from(new Set(parts)).join(' or ');
  }
  if (schema.type === 'array') return `list of ${schema.items ? typeLabel(document, schema.items, depth, seen) : 'values'}`;
  if (schema.type === 'object' || schema.properties) return ref ? `object (${ref})` : 'object';
  if (schema.type === 'integer') return 'integer';
  return schema.type ?? 'value';
}

function fieldsOf(document: OpenAPIObject, schema: Schema | undefined, depth: number, seen: string[]): FieldDetail[] {
  const { schema: resolved, ref } = deref(document, schema, seen);
  if (!resolved) return [];
  let target = resolved;
  if (target.type === 'array') {
    const inner = deref(document, target.items, seen);
    if (!inner.schema) return [];
    target = inner.schema;
  }
  const props = target.properties;
  if (!props) return [];
  const nextSeen = ref ? [...seen, ref] : seen;
  const required = new Set(target.required ?? []);
  const out: FieldDetail[] = [];
  for (const [name, raw] of Object.entries(props)) {
    if (out.length >= MAX_FIELDS) break;
    const { schema: prop, ref: propRef } = deref(document, raw, nextSeen);
    const effective: Schema = prop ?? raw;
    const field: FieldDetail = {
      name,
      type: typeLabel(document, raw, depth, nextSeen),
      required: required.has(name),
      notes: notesOf({ ...effective, ...(raw.nullable ? { nullable: true } : {}) }),
      children: [],
    };
    const nestedTarget = effective.type === 'array' ? effective.items : raw;
    if (depth < MAX_DEPTH && propRef !== undefined ? !nextSeen.includes(propRef) : depth < MAX_DEPTH) {
      field.children = fieldsOf(document, effective.type === 'array' ? nestedTarget : raw, depth + 1, nextSeen);
    }
    out.push(field);
  }
  return out;
}

function parametersOf(document: OpenAPIObject, operation: Record<string, any>): ParameterDetail[] {
  const out: ParameterDetail[] = [];
  for (const p of (operation.parameters ?? []) as any[]) {
    if (!p || typeof p !== 'object' || !p.name) continue;
    const schema: Schema = p.schema ?? { type: 'string' };
    out.push({
      name: p.name,
      where: p.in,
      type: typeLabel(document, schema, MAX_DEPTH, []),
      required: Boolean(p.required) || p.in === 'path',
      notes: notesOf(deref(document, schema).schema ?? schema),
      ...(typeof p.description === 'string' && p.description ? { description: p.description } : {}),
    });
  }
  return out;
}

function messagesOf(response: any): { text: string; when?: string }[] {
  const out: { text: string; when?: string }[] = [];
  const push = (value: any, summary?: string): void => {
    const message = value?.message;
    const list = Array.isArray(message) ? message : message !== undefined ? [message] : [];
    const when = typeof summary === 'string' ? summary.replace(/^when\s+/, '') : undefined;
    for (const m of list) if (typeof m === 'string' && m.length > 0) out.push({ text: m, ...(when ? { when } : {}) });
  };
  const content = response?.content?.['application/json'];
  if (!content) return out;
  if (content.example !== undefined) push(content.example);
  for (const e of Object.values<any>(content.examples ?? {})) push(e?.value, e?.summary);
  const seen = new Set<string>();
  return out.filter((m) => (seen.has(m.text) ? false : (seen.add(m.text), true)));
}

export function deriveContractFacts(document: OpenAPIObject, operation: Record<string, any>, ctx: ContractContext): ContractFacts {
  const facts: Fact[] = [];
  const where = ctx.sourceFile ?? ctx.operationKey;
  const evidence = (kind: string, details?: Record<string, unknown>): Evidence => ({ sourceFile: where, kind, ...(details ? { details } : {}) });
  const claim = (kind: string, subject: string, ev: Evidence): void => {
    facts.push({ kind, subject, evidence: [ev] });
  };

  const out: ContractFacts = { parameters: [], responses: [], failures: [], facts };

  // --- access (handler metadata + declared security)
  const security: Array<Record<string, unknown>> | undefined = operation.security;
  const scheme = Array.isArray(security) && security.length > 0 ? Object.keys(security[0])[0] : undefined;
  if (ctx.isPublic || Array.isArray(security) || ctx.requiredPermissions.length > 0) {
    out.access = { public: ctx.isPublic, ...(scheme ? { scheme } : {}), permissions: ctx.requiredPermissions };
    claim('access', ctx.isPublic ? 'public' : 'authenticated', evidence('handler-metadata', { public: ctx.isPublic }));
    for (const p of ctx.requiredPermissions) claim('permission', p, evidence('handler-metadata', { permission: p }));
  }

  // --- parameters
  out.parameters = parametersOf(document, operation);
  for (const p of out.parameters) {
    claim('parameter', `${p.where}:${p.name}`, evidence('declared-parameter', { in: p.where, required: p.required }));
    for (const n of p.notes) claim('parameter-constraint', `${p.name}: ${n}`, evidence('declared-parameter'));
  }
  if (ctx.hasPagination) {
    const byName = new Map(out.parameters.map((p) => [p.name, p]));
    const parts: string[] = [];
    const page = byName.get('page');
    const limit = byName.get('limit');
    if (page) parts.push('pages are 1-based');
    if (limit) {
      const d = limit.notes.find((n) => n.startsWith('default '));
      const m = limit.notes.find((n) => /^(between|at most)/.test(n));
      parts.push(`page size${d ? ` defaults to ${d.replace('default ', '')}` : ''}${m ? ` (${m})` : ''}`);
    }
    if (byName.has('sort')) parts.push('sortable');
    if (byName.has('search')) parts.push('searchable');
    if (byName.has('filter')) parts.push('filterable');
    if (parts.length > 0) {
      out.pagination = parts.join(', ');
      claim('pagination', out.pagination, evidence('declared-parameter'));
    }
  }

  // --- request body
  const body = operation.requestBody?.content as Record<string, { schema?: Schema }> | undefined;
  const bodyType = body ? (body['application/json'] ? 'application/json' : Object.keys(body)[0]) : undefined;
  if (bodyType && body?.[bodyType]?.schema) {
    const schema = body[bodyType].schema as Schema;
    const root = deref(document, schema).schema;
    const fields = fieldsOf(document, schema, 0, []);
    out.request = { contentType: bodyType, list: root?.type === 'array', fields };
    claim('request-body', bodyType, evidence('request-schema'));
    const count = (fs: FieldDetail[]): void =>
      fs.forEach((f) => {
        claim('request-field', f.name, evidence('request-schema', { required: f.required, type: f.type }));
        for (const n of f.notes) claim('request-constraint', `${f.name}: ${n}`, evidence('request-schema'));
        count(f.children);
      });
    count(fields);
  }

  // --- responses
  const responses = (operation.responses ?? {}) as Record<string, any>;
  for (const [code, response] of Object.entries(responses)) {
    const status = Number(code);
    if (Number.isNaN(status)) continue;
    if (status >= 200 && status < 300) {
      const content = response?.content as Record<string, { schema?: Schema }> | undefined;
      const type = content ? (content['application/json'] ? 'application/json' : Object.keys(content)[0]) : undefined;
      const schema = type ? content?.[type]?.schema : undefined;
      const root = deref(document, schema).schema;
      const list = root?.type === 'array';
      const envelope = Boolean(root?.properties?.data && (root.properties.total || root.properties.totalPages));
      const fields = schema ? fieldsOf(document, schema, 0, []) : [];
      const scalar = !fields.length && root && root.type && root.type !== 'object' && root.type !== 'array' ? typeLabel(document, schema as Schema, 0, []) : undefined;
      out.responses.push({ status, label: STATUS_LABEL[status] ?? 'Success', ...(type ? { contentType: type } : {}), list, envelope, fields, ...(scalar ? { scalar } : {}) });
      claim('response', String(status), evidence('response-schema', { status }));
      const count = (fs: FieldDetail[]): void =>
        fs.forEach((f) => {
          claim('response-field', f.name, evidence('response-schema', { type: f.type }));
          for (const n of f.notes) claim('response-constraint', `${f.name}: ${n}`, evidence('response-schema'));
          count(f.children);
        });
      count(fields);
    } else if (status >= 400) {
      const messages = messagesOf(response);
      // A bare, message-less 500 is true of every endpoint and says nothing about this one.
      if (status === 500 && messages.length === 0) continue;
      if (status === 401 && out.access?.public) continue;
      out.failures.push({ status, label: STATUS_LABEL[status] ?? 'Error', messages: messages.slice(0, MAX_MESSAGES), more: Math.max(0, messages.length - MAX_MESSAGES) });
      claim('failure', String(status), evidence('documented-response', { status }));
      for (const m of messages.slice(0, MAX_MESSAGES)) claim('failure-message', `${status}: ${m.text}`, evidence('documented-response', { status }));
    }
  }
  out.responses.sort((a, b) => a.status - b.status);
  out.failures.sort((a, b) => a.status - b.status);
  return out;
}
