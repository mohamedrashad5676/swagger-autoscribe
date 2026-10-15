import { computeCoverage, diffDocuments } from '../src/check';

const schemas = {
  User: { type: 'object', required: ['id', 'email'], properties: { id: { type: 'number' }, email: { type: 'string' }, name: { type: 'string' } } },
  CreateUser: { type: 'object', required: ['email'], properties: { email: { type: 'string' } } },
};
const ok = (ref: string) => ({ description: 'ok', content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } } });
const doc = (over: any = {}): any => ({
  openapi: '3.0.0',
  info: { title: 't', version: '1' },
  components: { schemas: { ...schemas, ...(over.schemas ?? {}) } },
  paths: {
    '/users': {
      post: {
        description: 'Create',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateUser' } } } },
        responses: { 201: ok('User'), 400: { description: 'bad' } },
      },
    },
    '/users/{id}': {
      get: { description: 'One', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: ok('User'), 404: { description: 'nf' } } },
      delete: { responses: { 204: { description: 'gone' } } },
    },
    ...(over.paths ?? {}),
  },
});

describe('coverage', () => {
  it('counts typed responses, descriptions, bodies and 4xx', () => {
    const r = computeCoverage(doc());
    expect(r.endpoints).toBe(3);
    expect(r.responseSchemas).toEqual({ covered: 3, total: 3, percent: 100 }); // 204 needs no schema
    expect(r.descriptions.covered).toBe(2);
    expect(r.requestBodies).toEqual({ covered: 1, total: 1, percent: 100 });
    expect(r.errorResponses.covered).toBe(2);
    expect(r.untypedResponses).toEqual([]);
  });
  it('lists endpoints without a typed 2xx response', () => {
    const d = doc();
    d.paths['/users'].post.responses[201] = { description: 'x' };
    const r = computeCoverage(d);
    expect(r.untypedResponses).toEqual(['POST /users']);
    expect(r.responseSchemas.percent).toBeCloseTo(66.7, 1);
  });
});

describe('breaking-change diff', () => {
  const msgs = (b: any, a: any, kind: 'breaking' | 'info' = 'breaking') =>
    diffDocuments(b, a).filter((c) => c.kind === kind).map((c) => `${c.endpoint}: ${c.message}`);

  it('identical documents -> no changes', () => expect(diffDocuments(doc(), doc())).toEqual([]));

  it('removed endpoint and removed success response are breaking', () => {
    const a = doc();
    delete a.paths['/users/{id}'].delete;
    delete a.paths['/users'].post.responses[201];
    expect(msgs(doc(), a)).toEqual(['DELETE /users/{id}: endpoint removed', 'POST /users: response 201 removed']);
  });

  it('response property removed / type changed is breaking; added property is not', () => {
    const a = doc({ schemas: { User: { type: 'object', properties: { id: { type: 'string' }, extra: { type: 'string' } } } } });
    const m = msgs(doc(), a);
    expect(m).toContain('GET /users/{id}: response 200.email: response property removed');
    expect(m).toContain('GET /users/{id}: response 200.id: type number -> string');
    expect(m.some((x) => x.includes('extra'))).toBe(false);
  });

  it('new required request property / param is breaking; optional is not', () => {
    const a = doc({ schemas: { CreateUser: { type: 'object', required: ['email', 'age'], properties: { email: { type: 'string' }, age: { type: 'number' }, nick: { type: 'string' } } } } });
    a.paths['/users/{id}'].get.parameters.push({ name: 'v', in: 'query', required: true, schema: { type: 'string' } });
    a.paths['/users/{id}'].get.parameters.push({ name: 'q', in: 'query', required: false, schema: { type: 'string' } });
    const m = msgs(doc(), a);
    expect(m).toContain('POST /users: body.age: new REQUIRED request property');
    expect(m).toContain('GET /users/{id}: new REQUIRED query:v');
    expect(m.some((x) => x.includes('nick') || x.includes('query:q'))).toBe(false);
  });

  it('removed request property and added endpoint/response are info only', () => {
    const a = doc({ paths: { '/health': { get: { responses: { 200: { description: 'ok' } } } } } });
    a.paths['/users'].post.responses[409] = { description: 'dup' };
    expect(msgs(doc(), a)).toEqual([]);
    expect(msgs(doc(), a, 'info')).toEqual(['GET /health: endpoint added', 'POST /users: response 409 added']);
  });

  it('is safe on self-referencing schemas', () => {
    const rec = { Node: { type: 'object', properties: { next: { $ref: '#/components/schemas/Node' } } } };
    const mk = () => doc({ schemas: rec, paths: { '/n': { get: { responses: { 200: ok('Node') } } } } });
    expect(diffDocuments(mk(), mk())).toEqual([]);
  });
});
