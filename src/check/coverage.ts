import type { OpenAPIObject } from '@nestjs/swagger';

export interface CoverageReport {
  endpoints: number;
  /** 2xx responses that carry a real schema. */
  responseSchemas: Ratio;
  /** Operations with a description. */
  descriptions: Ratio;
  /** POST/PUT/PATCH operations that document a request body. */
  requestBodies: Ratio;
  /** Operations that document at least one 4xx response. */
  errorResponses: Ratio;
  /** `METHOD /path` of every endpoint missing a 2xx response schema. */
  untypedResponses: string[];
}

export interface Ratio {
  covered: number;
  total: number;
  percent: number;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;
const BODY_METHODS = new Set(['post', 'put', 'patch']);

function ratio(covered: number, total: number): Ratio {
  return { covered, total, percent: total === 0 ? 100 : Math.round((covered / total) * 1000) / 10 };
}

export function operationsOf(doc: OpenAPIObject): Array<{ key: string; method: string; path: string; op: any }> {
  const out: Array<{ key: string; method: string; path: string; op: any }> = [];
  for (const [p, item] of Object.entries(doc.paths ?? {})) {
    for (const m of METHODS) {
      const op = (item as any)?.[m];
      if (op) out.push({ key: `${m.toUpperCase()} ${p}`, method: m, path: p, op });
    }
  }
  return out;
}

function hasSchema(content: any): boolean {
  for (const media of Object.values<any>(content ?? {})) {
    const s = media?.schema;
    if (s && (s.$ref || Object.keys(s).length > 0)) return true;
  }
  return false;
}

export function computeCoverage(doc: OpenAPIObject): CoverageReport {
  const ops = operationsOf(doc);
  let resp = 0, desc = 0, bodyTotal = 0, bodyOk = 0, err = 0;
  const untyped: string[] = [];
  for (const { key, method, op } of ops) {
    const success = Object.entries<any>(op.responses ?? {}).filter(([s]) => s.startsWith('2'));
    const typed = success.some(([, r]) => hasSchema(r?.content));
    // 204 / empty-body successes have nothing to type.
    const empty = success.length > 0 && success.every(([s]) => s === '204');
    if (typed || empty) resp++;
    else untyped.push(key);
    if (typeof op.description === 'string' && op.description.trim()) desc++;
    if (BODY_METHODS.has(method)) {
      bodyTotal++;
      if (hasSchema(op.requestBody?.content)) bodyOk++;
    }
    if (Object.keys(op.responses ?? {}).some((s) => s.startsWith('4'))) err++;
  }
  return {
    endpoints: ops.length,
    responseSchemas: ratio(resp, ops.length),
    descriptions: ratio(desc, ops.length),
    requestBodies: ratio(bodyOk, bodyTotal),
    errorResponses: ratio(err, ops.length),
    untypedResponses: untyped.sort(),
  };
}
