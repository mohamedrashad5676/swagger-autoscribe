import 'reflect-metadata';
import * as path from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { createApp } from './helpers';
import { buildDocument } from '../src';
import { AppModule } from './fixtures/app/app.module';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY, RESOURCE_KEY } from './fixtures/app/common/decorators';

const roots = [path.join(__dirname, 'fixtures', 'app')];
const common = { logger: false as const, sources: { roots }, auth: { publicMetadataKeys: [IS_PUBLIC_KEY] }, rbac: { metadataKey: PERMISSIONS_KEY }, resource: { metadataKey: RESOURCE_KEY } };

// Information items per description: sentences + bullet lines + enumerated names. Same counter for both versions.
export const countItems = (text: string): number => {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let n = 0;
  for (const line of lines) {
    n += 1;
    n += (line.match(/[,;]|\band\b|—/g) ?? []).length;
  }
  return n;
};

let app: INestApplication;
beforeAll(async () => {
  app = await createApp(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
});
afterAll(async () => app.close());

const descriptions = (doc: any): Record<string, string> =>
  Object.fromEntries(Object.entries<any>(doc.paths).flatMap(([p, item]) => Object.entries<any>(item).filter(([, o]) => o?.description).map(([m, o]) => [`${m.toUpperCase()} ${p}`, o.description as string])));

describe('collapsed contract section', () => {
  it('is folded into <details> by default: the first line is the readable summary', () => {
    const d = descriptions(buildDocument(app, { ...common }));
    const create = d['POST /users'];
    const [lead] = create.split('\n\n<details>');
    expect(lead).toMatch(/^Creates a new user\./);
    expect(lead).not.toContain('**Access.**');
    expect(create).toContain('<details><summary>Contract details</summary>\n\n**Access.**');
    expect(create.trimEnd().endsWith('</details>')).toBe(true);
    expect((create.match(/<details>/g) ?? []).length).toBe(1);
  });

  it('can be opened inline, or relabelled', () => {
    const inline = descriptions(buildDocument(app, { ...common, descriptions: { collapse: false } }));
    expect(inline['POST /users']).not.toContain('<details>');
    expect(inline['POST /users']).toContain('**Access.**');
    const relabel = descriptions(buildDocument(app, { ...common, descriptions: { collapse: 'Full contract' } }));
    expect(relabel['POST /users']).toContain('<summary>Full contract</summary>');
  });

  it('summary mode has nothing to fold', () => {
    const s = descriptions(buildDocument(app, { ...common, descriptions: { detail: 'summary' } }));
    expect(s['POST /users']).not.toContain('<details>');
  });
});

describe('description depth', () => {
  it('measured: the contract layer multiplies the proven information per operation', () => {
    const summary = descriptions(buildDocument(app, { ...common, descriptions: { detail: 'summary' } }));
    const full = descriptions(buildDocument(app, { ...common, descriptions: { detail: 'full' } }));
    const keys = Object.keys(full).filter((k) => !k.includes('/manual'));
    const before = keys.map((k) => countItems(summary[k] ?? ''));
    const after = keys.map((k) => countItems(full[k]));
    const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    const richKeys = keys.filter((_, i) => before[i] >= 0).filter((k) => /POST \/users$|PATCH|GET \/users$|GET \/users\/\{id\}/.test(k));
    const richBefore = avg(richKeys.map((k) => countItems(summary[k] ?? '')));
    const richAfter = avg(richKeys.map((k) => countItems(full[k])));
    // eslint-disable-next-line no-console
    console.log(`items/description  all ${avg(before).toFixed(1)} -> ${avg(after).toFixed(1)} (${(avg(after) / avg(before)).toFixed(1)}x) | rich endpoints ${richBefore.toFixed(1)} -> ${richAfter.toFixed(1)} (${(richAfter / richBefore).toFixed(1)}x)`);
    expect(avg(after)).toBeGreaterThan(avg(before) * 3);
    expect(richAfter).toBeGreaterThan(richBefore * 4);
  });

  it('every contract fact carries evidence', () => {
    const { deriveContractFacts } = require('../src/descriptions/contract-facts');
    const doc = buildDocument(app, { ...common, descriptions: false });
    let total = 0;
    for (const [p, item] of Object.entries<any>(doc.paths)) {
      for (const [m, op] of Object.entries<any>(item)) {
        const c = deriveContractFacts(doc, op, { isPublic: false, requiredPermissions: [], hasPagination: false, operationKey: `${m} ${p}` });
        expect(c.facts.filter((f: any) => f.evidence.length === 0)).toEqual([]);
        total += c.facts.length;
      }
    }
    expect(total).toBeGreaterThan(100);
  });

  it('states access, request, response and failures from their real sources', () => {
    const d = descriptions(buildDocument(app, { ...common }));
    const create = d['POST /users'];
    expect(create).toContain('**Access.** Requires authentication (bearerAuth). The caller needs the `users.create` permission.');
    expect(create).toContain('**Request body** (application/json)');
    expect(create).toMatch(/- `name` — string, required, at least 2 characters/);
    expect(create).toMatch(/- `email` — string, required, valid email address/);
    expect(create).toMatch(/- `role` — string, required, one of admin, member/);
    expect(create).toMatch(/- `address` — object \(AddressDto\), required\n\s+- `city` — string, required/);
    expect(create).toMatch(/- `nickname` — .*optional.*may be null|- `nickname` — .*may be null/);
    expect(create).toContain('**Response 201 Created**');
    expect(create).toMatch(/`deletedAt` — string, required, ISO 8601 timestamp, may be null/);
    expect(create).toMatch(/- `409` Conflict — Email already registered/);
    expect(create).toMatch(/- `400` Bad Request — email must be an email/);
    expect(d['GET /users/health']).toContain('Public endpoint — no authentication is required.');
  });

  it('documents query/path parameters and pagination defaults', () => {
    const d = descriptions(buildDocument(app, { ...common }));
    const paged = d['GET /users/paged'];
    expect(paged).toContain('**Query parameters**');
    expect(paged).toMatch(/- `limit` — integer, optional, between 1 and 100, default 10/);
    expect(paged).toContain('Pagination: pages are 1-based, page size defaults to 10 (between 1 and 100), sortable, searchable, filterable.');
    expect(d['GET /users/{id}']).toContain('**Path parameters**');
  });

  it('a placeholder lead is upgraded from the response contract', () => {
    const d = descriptions(buildDocument(app, { ...common }));
    expect(d['GET /reports/mapped']).toMatch(/^Returns the report data, including id, fullName/);
    expect(d['GET /reports/mapped']).not.toMatch(/^Handles the requested/);
  });

  it('sections are selectable and the summary mode keeps the old, short form', () => {
    const only = descriptions(buildDocument(app, { ...common, descriptions: { sections: ['access'] } }));
    expect(only['POST /users']).toContain('**Access.**');
    expect(only['POST /users']).not.toContain('**Request body**');
    const summary = descriptions(buildDocument(app, { ...common, descriptions: { detail: 'summary' } }));
    expect(summary['POST /users']).not.toContain('**Access.**');
  });
});
