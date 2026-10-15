import 'reflect-metadata';
import * as path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { createApp } from './helpers';
import { buildDocument } from '../src';
import { FeaturesModule } from './fixtures/features/features.module';

const roots = [path.join(__dirname, 'fixtures', 'features')];
let app: INestApplication;
let doc: any;
beforeAll(async () => {
  app = await createApp(FeaturesModule);
  doc = buildDocument(app, { logger: false, sources: { roots } });
});
afterAll(async () => app.close());

const op = (m: string, p: string): any => doc.paths[p]?.[m];

describe('@Query() dto expansion', () => {
  it('expands the DTO into typed, required-aware query parameters', () => {
    const params = op('get', '/things').parameters;
    const by = Object.fromEntries(params.map((p: any) => [p.name, p]));
    expect(Object.keys(by).sort()).toEqual(['page', 'search', 'sort']);
    expect(by.page).toMatchObject({ in: 'query', required: true });
    expect(by.page.schema.type).toMatch(/number|integer/);
    expect(by.search).toMatchObject({ in: 'query', required: false, schema: { type: 'string' } });
  });
  it('leaves no query-only component behind', () => {
    expect(doc.components.schemas.ListThingsQuery).toBeUndefined();
  });
  it('does not touch @Param operations', () => {
    expect(op('get', '/things/{id}').parameters.map((p: any) => p.in)).toEqual(['path']);
  });
  it('can be disabled', () => {
    const d = buildDocument(app, { logger: false, sources: { roots }, queryParams: false });
    expect(d.paths['/things'].get.parameters ?? []).toEqual([]);
  });
});

describe('@Param() / @Headers() dto expansion', () => {
  it('path DTO: only names present in the route template, always required', () => {
    const params = op('get', '/things/by/{code}').parameters;
    expect(params.map((p: any) => `${p.in}:${p.name}:${p.required}`)).toEqual(['path:code:true']);
  });
  it('header DTO: one header per property, required from the DTO', () => {
    const params = op('get', '/things/hdr/check').parameters;
    const by = Object.fromEntries(params.map((p: any) => [p.name, p]));
    expect(by['x-trace-id']).toMatchObject({ in: 'header', required: true, schema: { type: 'string' } });
    expect(by['x-tenant']).toMatchObject({ in: 'header', required: false });
  });
  it('adds no components of its own', () => {
    const off = buildDocument(app, { logger: false, sources: { roots }, queryParams: false });
    expect(Object.keys(doc.components.schemas).sort()).toEqual(Object.keys(off.components.schemas).sort());
  });
});

describe('automatic summary', () => {
  it('derives CRUD summaries from verb + resource', () => {
    expect(op('get', '/things').summary).toBe('List things');
    expect(op('get', '/things/{id}').summary).toBe('Get thing');
    expect(op('post', '/things').summary).toBe('Create thing');
    expect(op('patch', '/things/{id}').summary).toBe('Update thing');
    expect(op('delete', '/things/{id}').summary).toBe('Delete thing');
  });
  it('humanises other method names', () => {
    expect(op('post', '/things/verify-email').summary).toBe('Verify email');
  });
  it('never overrides @ApiOperation', () => {
    expect(op('get', '/things/custom/own').summary).toBe('My own summary');
  });
  it('can be disabled or customised', () => {
    expect(buildDocument(app, { logger: false, sources: { roots }, summaries: false }).paths['/things'].get.summary).toBeUndefined();
    const d = buildDocument(app, { logger: false, sources: { roots }, summaries: { generate: (i) => `X ${i.methodName}` } });
    expect(d.paths['/things'].get.summary).toBe('X findAll');
  });
});

describe('@HttpCode', () => {
  it('uses the declared success status', () => {
    expect(Object.keys(op('delete', '/things/{id}').responses)).toContain('204');
    expect(Object.keys(op('delete', '/things/{id}').responses)).not.toContain('200');
    expect(Object.keys(op('post', '/things/login').responses)).toContain('200');
    expect(Object.keys(op('post', '/things/login').responses)).not.toContain('201');
    expect(op('post', '/things/login').responses['200'].content['application/json'].schema).toBeDefined();
  });
});

describe('multipart uploads', () => {
  it('FileInterceptor + DTO fields', () => {
    const s = op('post', '/things/avatar').requestBody.content;
    expect(Object.keys(s)).toEqual(['multipart/form-data']);
    const schema = s['multipart/form-data'].schema;
    expect(schema.properties.avatar).toEqual({ type: 'string', format: 'binary' });
    expect(schema.properties.title).toBeDefined();
    expect(schema.required).toEqual(expect.arrayContaining(['avatar', 'title']));
  });
  it('FilesInterceptor -> array of binaries with maxItems', () => {
    const p = op('post', '/things/gallery').requestBody.content['multipart/form-data'].schema.properties.photos;
    expect(p).toEqual({ type: 'array', items: { type: 'string', format: 'binary' }, maxItems: 5 });
  });
  it('FileFieldsInterceptor -> one property per field', () => {
    const p = op('post', '/things/docs').requestBody.content['multipart/form-data'].schema.properties;
    expect(p.cv).toEqual({ type: 'string', format: 'binary' });
    expect(p.letters.maxItems).toBe(3);
  });
  it('AnyFilesInterceptor', () => {
    expect(op('post', '/things/any').requestBody.content['multipart/form-data'].schema.properties.files.type).toBe('array');
  });
  it('ParseFilePipe: max size, type, encoding', () => {
    const c = op('post', '/things/photo').requestBody.content['multipart/form-data'];
    expect(c.schema.properties.photo).toMatchObject({ type: 'string', format: 'binary', description: 'Max size: 2 MB. Allowed type: image/png.', 'x-max-size': 2097152 });
    expect(c.encoding).toEqual({ photo: { contentType: 'image/png' } });
    expect(c.schema.required).toEqual(['photo']);
  });
  it('ParseFilePipe: fileIsRequired false, regex type is described not encoded', () => {
    const rb = op('post', '/things/optional').requestBody;
    expect(rb.required).toBe(false);
    const c = rb.content['multipart/form-data'];
    expect(c.schema.required).toBeUndefined();
    expect(c.schema.properties.doc.description).toContain('Allowed type: /pdf|word/');
    expect(c.encoding).toBeUndefined();
  });
  it('plain JSON bodies are untouched', () => {
    expect(Object.keys(op('post', '/things').requestBody.content)).toEqual(['application/json']);
  });
});

describe('throttler', () => {
  it('global limit -> 429 + x-rate-limit', () => {
    const o = op('get', '/things/{id}');
    expect(o['x-rate-limit']).toEqual([{ name: 'default', limit: 10, windowMs: 60000 }]);
    expect(o.responses['429'].description).toContain('10 requests per 1 minute');
    expect(o.responses['429'].headers['Retry-After']).toBeDefined();
  });
  it('@Throttle overrides, @SkipThrottle removes', () => {
    expect(op('get', '/things/limited/fast')['x-rate-limit'][0]).toMatchObject({ limit: 2, windowMs: 1000 });
    expect(op('get', '/things/limited/skip')['x-rate-limit']).toBeUndefined();
    expect(op('get', '/things/limited/skip').responses['429']).toBeUndefined();
  });
  it('can be disabled', () => {
    const d = buildDocument(app, { logger: false, sources: { roots }, rateLimit: false });
    expect(d.paths['/things'].get.responses['429']).toBeUndefined();
  });
});
