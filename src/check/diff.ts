import type { OpenAPIObject } from '@nestjs/swagger';
import { operationsOf } from './coverage';

export interface Change {
  kind: 'breaking' | 'info';
  endpoint: string;
  message: string;
}

type Schema = Record<string, any>;

class Resolver {
  constructor(private readonly doc: OpenAPIObject) {}
  resolve(s: Schema | undefined, seen = new Set<string>()): Schema | undefined {
    let cur = s;
    while (cur && typeof cur.$ref === 'string') {
      if (seen.has(cur.$ref)) return undefined;
      seen.add(cur.$ref);
      const name = cur.$ref.replace('#/components/schemas/', '');
      cur = (this.doc.components?.schemas as Record<string, Schema> | undefined)?.[name];
    }
    return cur;
  }
}

const typeOf = (s: Schema): string => {
  if (s.enum) return `enum(${[...s.enum].map(String).sort().join('|')})`;
  if (s.oneOf || s.anyOf) return 'union';
  return String(s.type ?? (s.properties ? 'object' : 'any'));
};

/** Request: anything a client must NEWLY send / changed in type is breaking. */
function diffRequest(a: Schema | undefined, b: Schema | undefined, ra: Resolver, rb: Resolver, where: string, push: (c: string) => void, depth = 0): void {
  const x = ra.resolve(a), y = rb.resolve(b);
  if (!x || !y || depth > 6) return;
  if (x.properties || y.properties) {
    const xr = new Set<string>(x.required ?? []), yr = new Set<string>(y.required ?? []);
    for (const [name, ys] of Object.entries<Schema>(y.properties ?? {})) {
      const xs = x.properties?.[name];
      if (!xs) {
        if (yr.has(name)) push(`${where}.${name}: new REQUIRED request property`);
        continue;
      }
      if (!xr.has(name) && yr.has(name)) push(`${where}.${name}: became required`);
      const tx = typeOf(ra.resolve(xs) ?? xs), ty = typeOf(rb.resolve(ys) ?? ys);
      if (tx !== ty && tx !== 'any' && ty !== 'any') push(`${where}.${name}: type ${tx} -> ${ty}`);
      else diffRequest(xs, ys, ra, rb, `${where}.${name}`, push, depth + 1);
    }
    return;
  }
  if (x.items && y.items) diffRequest(x.items, y.items, ra, rb, `${where}[]`, push, depth + 1);
}

/** Response: anything a client may rely on that disappears / changes type is breaking. */
function diffResponse(a: Schema | undefined, b: Schema | undefined, ra: Resolver, rb: Resolver, where: string, push: (c: string) => void, depth = 0): void {
  const x = ra.resolve(a), y = rb.resolve(b);
  if (!x || !y || depth > 6) return;
  const tx = typeOf(x), ty = typeOf(y);
  if (tx !== ty && tx !== 'any' && ty !== 'any' && !x.properties && !y.properties) {
    push(`${where}: type ${tx} -> ${ty}`);
    return;
  }
  for (const [name, xs] of Object.entries<Schema>(x.properties ?? {})) {
    const ys = y.properties?.[name];
    if (!ys) {
      push(`${where}.${name}: response property removed`);
      continue;
    }
    const px = typeOf(ra.resolve(xs) ?? xs), py = typeOf(rb.resolve(ys) ?? ys);
    if (px !== py && px !== 'any' && py !== 'any') push(`${where}.${name}: type ${px} -> ${py}`);
    else diffResponse(xs, ys, ra, rb, `${where}.${name}`, push, depth + 1);
  }
  if (x.items && y.items) diffResponse(x.items, y.items, ra, rb, `${where}[]`, push, depth + 1);
}

const firstSchema = (content: any): Schema | undefined => Object.values<any>(content ?? {})[0]?.schema;

export function diffDocuments(baseline: OpenAPIObject, current: OpenAPIObject): Change[] {
  const changes: Change[] = [];
  const ra = new Resolver(baseline), rb = new Resolver(current);
  const before = new Map(operationsOf(baseline).map((o) => [o.key, o.op]));
  const after = new Map(operationsOf(current).map((o) => [o.key, o.op]));

  for (const [key, a] of before) {
    const b = after.get(key);
    const add = (kind: Change['kind']) => (message: string) => changes.push({ kind, endpoint: key, message });
    const breaking = add('breaking'), info = add('info');
    if (!b) {
      breaking('endpoint removed');
      continue;
    }
    // parameters
    const pk = (p: any) => `${p.in}:${p.name}`;
    const pa = new Map<string, any>((a.parameters ?? []).map((p: any) => [pk(p), p]));
    const pb = new Map<string, any>((b.parameters ?? []).map((p: any) => [pk(p), p]));
    for (const [k, p] of pb) {
      const old = pa.get(k);
      if (!old && p.required) breaking(`new REQUIRED ${k}`);
      else if (old && !old.required && p.required) breaking(`${k} became required`);
      else if (old) {
        const ta = typeOf(ra.resolve(old.schema) ?? old.schema ?? {}), tb = typeOf(rb.resolve(p.schema) ?? p.schema ?? {});
        if (ta !== tb && ta !== 'any' && tb !== 'any') breaking(`${k}: type ${ta} -> ${tb}`);
      }
    }
    for (const k of pa.keys()) if (!pb.has(k)) info(`parameter ${k} removed`);
    // request body
    if (!a.requestBody?.required && b.requestBody?.required) breaking('request body became required');
    diffRequest(firstSchema(a.requestBody?.content), firstSchema(b.requestBody?.content), ra, rb, 'body', breaking);
    // responses
    for (const [status, r] of Object.entries<any>(a.responses ?? {})) {
      const n = b.responses?.[status];
      if (!n) {
        (status.startsWith('2') ? breaking : info)(`response ${status} removed`);
        continue;
      }
      diffResponse(firstSchema(r.content), firstSchema(n.content), ra, rb, `response ${status}`, breaking);
    }
    for (const status of Object.keys(b.responses ?? {})) if (!a.responses?.[status]) info(`response ${status} added`);
  }
  for (const key of after.keys()) if (!before.has(key)) changes.push({ kind: 'info', endpoint: key, message: 'endpoint added' });
  return changes.sort((p, q) => (p.kind === q.kind ? p.endpoint.localeCompare(q.endpoint) : p.kind === 'breaking' ? -1 : 1));
}
