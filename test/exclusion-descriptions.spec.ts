import 'reflect-metadata';
import * as path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { createApp } from './helpers';
import { buildDocument } from '../src';
import { AppModule } from './fixtures/app/app.module';
import { IS_PUBLIC_KEY } from './fixtures/app/common/decorators';

const roots = [path.join(__dirname, 'fixtures', 'app')];
let app: INestApplication;
const base = { logger: false as const, sources: { roots }, auth: { publicMetadataKeys: [IS_PUBLIC_KEY] } };

beforeAll(async () => {
  app = await createApp(AppModule);
});
afterAll(async () => {
  await app.close();
  delete process.env.SWAGGER_EXCLUDE_ENDPOINTS;
});

describe('exclusion', () => {
  it('@swagger-ignore above a controller hides the whole controller, above a handler only that endpoint', () => {
    const doc = buildDocument(app, base);
    expect(doc.paths['/internal/ping']).toBeUndefined();
    expect(doc.paths['/users/debug']).toBeUndefined();
    expect(doc.paths['/users/health']).toBeDefined();
  });

  it('config: controller names and every endpoint id format', () => {
    const doc = buildDocument(app, {
      ...base,
      exclude: {
        controllers: ['OrdersController'],
        endpoints: ['UsersController.health', 'DELETE:/users/{id}', 'UsersController.GET:/users/paged'],
      },
    });
    expect(doc.paths['/orders/{id}']).toBeUndefined();
    expect(doc.paths['/users/health']).toBeUndefined();
    expect(doc.paths['/users/{id}']?.delete).toBeUndefined();
    expect(doc.paths['/users/{id}']?.get).toBeDefined(); // only the DELETE was named
    expect(doc.paths['/users/paged']).toBeUndefined();
    expect(doc.paths['/users']).toBeDefined();
  });

  it('env vars are merged with the options', () => {
    process.env.SWAGGER_EXCLUDE_ENDPOINTS = 'UsersController.stream';
    const doc = buildDocument(app, base);
    expect(doc.paths['/users/stream']).toBeUndefined();
    delete process.env.SWAGGER_EXCLUDE_ENDPOINTS;
  });

  it('excluded operations are not documented by any later pass (no leftover errors/examples)', () => {
    const doc = buildDocument(app, { ...base, exclude: { endpoints: ['UsersController.create'] } });
    expect((doc.paths['/users'] as any).post).toBeUndefined();
    expect((doc.paths['/users'] as any).get).toBeDefined();
  });
});

describe('automatic descriptions', () => {
  it('fills operations that have none, from the real call chain, in any project layout', () => {
    const doc = buildDocument(app, base);
    const create = (doc.paths['/users'] as any).post.description as string;
    expect(typeof create).toBe('string');
    expect(create.length).toBeGreaterThan(20);
    const get = (doc.paths['/users/{id}'] as any).get.description as string;
    expect(get).toMatch(/\./);
  });

  it('never overwrites a hand-written description', () => {
    const doc = buildDocument(app, base);
    expect((doc.paths['/users/manual'] as any).get.description).toBe('Written by hand.');
  });

  it('can be switched off, or marked', () => {
    const off = buildDocument(app, { ...base, descriptions: false });
    expect((off.paths['/users'] as any).post.description).toBeUndefined();
    const marked = buildDocument(app, { ...base, descriptions: { markGenerated: true } });
    expect((marked.paths['/users'] as any).post['x-generated-description']).toBe(true);
    expect((marked.paths['/users/manual'] as any).get['x-generated-description']).toBeUndefined();
  });

  it('is deterministic', () => {
    const a = buildDocument(app, base);
    const b = buildDocument(app, base);
    const pick = (d: any): string[] => Object.values<any>(d.paths).flatMap((p) => Object.values<any>(p).map((o) => o.description));
    expect(pick(a)).toEqual(pick(b));
  });
});
