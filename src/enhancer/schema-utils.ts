import type { OpenAPIObject } from '@nestjs/swagger';
import type { JsonSchema } from '../schema/source-schema-extractor';
import type { ResponseEnvelope } from '../types';

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'] as const;
export type OpenApiMethod = (typeof HTTP_METHODS)[number];

export const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });

// Response envelope produced by a ResourceInterceptor-style layer:
// `{ data: T }` for a single item, `{ data: T[], total, page, limit,
// totalPages }` for a list. This mirrors that shape exactly so the documented
// schema matches the actual HTTP response, not the raw pre-transform service
// return type. Replaceable through `resource.envelope`.
export const DEFAULT_ENVELOPE: ResponseEnvelope = {
  list: (itemRef) => ({
    type: 'object',
    properties: {
      data: { type: 'array', items: ref(itemRef) },
      total: { type: 'number', example: 42 },
      page: { type: 'number', example: 1 },
      limit: { type: 'number', example: 20 },
      totalPages: { type: 'number', example: 3 },
    },
    required: ['data', 'total', 'page', 'limit', 'totalPages'],
  }),
  single: (itemRef) => ({
    type: 'object',
    properties: { data: ref(itemRef) },
    required: ['data'],
  }),
  listExample: (item) => ({ data: [item], total: 42, page: 1, limit: 20, totalPages: 3 }),
  singleExample: (item) => ({ data: item }),
};

// Realistic ValidationPipe 400 body — message serializes as an ARRAY, unlike
// every other Nest exception. Per-endpoint messages come from
// deriveValidationMessages; this is only the last-resort shape when a body
// exists but its DTO class can't be resolved at runtime.
export const FALLBACK_VALIDATION_MESSAGES = ['Request body failed validation'];

// camelCase slug of an error message's first words, for named OpenAPI
// examples (`idempotencyKeyIsRequiredReuseTheSame`).
export function slugify(message: string): string {
  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  if (words.length === 0) return 'error';
  return words[0] + words.slice(1).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
}

export function exampleForType(type: string | undefined): unknown {
  switch (type) {
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return 'string';
  }
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function ensureComponents(document: OpenAPIObject): { schemas: Record<string, unknown> } {
  if (!document.components) document.components = {};
  if (!document.components.schemas) document.components.schemas = {};
  return { schemas: document.components.schemas as Record<string, unknown> };
}

/**
 * Registers `schema` under `preferredName` in components.schemas, resolving
 * name collisions. Several output interfaces reuse the same bare name across
 * unrelated domains with genuinely DIFFERENT shapes (e.g. `MembersItem` in
 * two resources) — an identical shape under an already-used name is reused
 * as-is; a differing one gets a domain-prefixed unique name instead of
 * silently overwriting or producing a wrong schema for one of the two
 * endpoints.
 */
export function registerSchema(
  document: OpenAPIObject,
  preferredName: string,
  schema: JsonSchema,
  ownerClassName?: string,
): string {
  const { schemas } = ensureComponents(document);
  if (!schemas[preferredName]) {
    schemas[preferredName] = schema;
    return preferredName;
  }
  if (deepEqual(schemas[preferredName], schema)) return preferredName;

  const prefix = ownerClassName ? ownerClassName.replace(/(List|Detail)?Resource$/, '') : '';
  let suffix = 2;
  let candidate = prefix ? `${prefix}${preferredName}` : `${preferredName}${suffix}`;
  while (schemas[candidate] && !deepEqual(schemas[candidate], schema)) {
    suffix++;
    candidate = prefix ? `${prefix}${preferredName}${suffix}` : `${preferredName}${suffix}`;
  }
  schemas[candidate] = schema;
  return candidate;
}

export const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  418: "I'm a Teapot",
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

export function statusDescription(status: number): string {
  return STATUS_TEXT[status] ?? 'Error';
}
