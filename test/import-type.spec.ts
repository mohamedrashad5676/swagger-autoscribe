import 'reflect-metadata';
import * as path from 'node:path';
import { createApp } from './helpers';
import { buildDocument } from '../src';
import { M } from './fixtures/import-type/app';

describe('type-only imports (import type) everywhere', () => {
  let doc: any;
  beforeAll(async () => {
    const app = await createApp(M);
    doc = buildDocument(app, { logger: process.env.DBG ? undefined : false, sources: { roots: [path.join(__dirname, "fixtures", "import-type")] } });
    await app.close();
  });
  const op = (p: string, m: string): any => doc.paths[p][m];
  const names = (o: any): string[] => (o.parameters ?? []).map((x: any) => x.name);

  it('body', () => {
    const s = op('/it', 'post').requestBody.content['application/json'].schema;
    expect(JSON.stringify(s)).toMatch(/ItBody/);
    expect(doc.components.schemas.ItBody.properties.name).toBeDefined();
  });
  it('response (class) replaces the empty {type:object}', () => {
    const s = op('/it', 'post').responses['201'].content['application/json'].schema;
    expect(JSON.stringify(s)).toMatch(/ItResponse/);
    expect(doc.components.schemas.ItResponse.properties.id).toBeDefined();
  });
  it('response (interface, array)', () => {
    const s = op('/it/{id}', 'get').responses['200'].content['application/json'].schema;
    expect(s.type).toBe('array');
    expect(s.items.properties.total).toBeDefined();
  });
  it('query DTO expands to parameters', () => {
    expect(names(op('/it/list', 'get'))).toEqual(expect.arrayContaining(['page', 'search']));
  });
  it('param DTO expands to path parameters', () => {
    const ps = op('/it/{id}', 'get').parameters;
    expect(ps.find((p: any) => p.name === 'id' && p.in === 'path')).toBeDefined();
  });
});
