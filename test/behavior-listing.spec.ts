import 'reflect-metadata';
import * as path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { createApp } from './helpers';
import { buildDocument } from '../src';
import { ListingModule } from './fixtures/listing/listing.module';

const roots = [path.join(__dirname, 'fixtures', 'listing')];
let app: INestApplication;
let doc: any;
const build = (extra: object = {}): any => buildDocument(app, { logger: false, sources: { roots }, rbac: { metadataKey: 'permissions' }, ...extra });
beforeAll(async () => {
  app = await createApp(ListingModule);
  doc = build();
});
afterAll(async () => app.close());
const op = (p: string, m = 'get'): any => doc.paths[p][m];
const note = (o: any, title: string): string => ((o.description ?? '').split(`**${title}**\n`)[1] ?? '').split(/\n\n(?=\*\*|<\/details>)/)[0];

describe('listing note', () => {
  it('page based, with limits, enum sort, search, other params and envelope fields', () => {
    const n = note(op('/users'), 'Listing');
    expect(n).toContain('Page based: `page` picks the page (starts at 1); `limit` sets the page size (default 20, min 1, max 100)');
    expect(n).toContain('`sortBy` (one of `createdAt`, `name`) chooses the field; `order` (one of `asc`, `desc`) chooses the direction');
    expect(n).toContain('**Search.** `search`');
    expect(n).toContain('**Other query parameters.** `role`');
    expect(n).toContain('`total`, `totalPages`, `page`');
    expect(op('/users')['x-pagination']).toMatchObject({ style: 'page', page: 'page', size: 'limit', search: 'search', pageSize: { default: 20, max: 100 } });
  });
  it('offset based, and a bare array response is called out', () => {
    const n = note(op('/logs'), 'Listing');
    expect(n).toContain('Offset based: `offset` items are skipped; `limit` sets the page size (default 50, max 200)');
    expect(n).toContain('A plain array');
  });
  it('cursor based', () => {
    const n = note(op('/feed'), 'Listing');
    expect(n).toContain('Cursor based: send `cursor`');
    expect(n).toContain('`take` sets the page size (default 10)');
    expect(n).toContain('`nextCursor`, `hasMore`');
  });
  it('leaves non-list operations alone', () => {
    expect(op('/ping').description ?? '').not.toContain('Listing');
    expect(op('/ping')['x-pagination']).toBeUndefined();
  });
  it('is idempotent and can be switched off or kept out of the description', () => {
    const once = (op("/users").description.match(/\*\*Listing\*\*\n/g) ?? []).length;
    expect(once).toBe(1);
    expect(build({ listing: false }).paths['/users'].get['x-pagination']).toBeUndefined();
    const d = build({ listing: { description: false } }).paths['/users'].get;
    expect(d['x-pagination']).toBeDefined();
    expect(d.description ?? '').not.toContain('Listing');
  });
});

describe('behavior note', () => {
  it('permissions and the global rate limit', () => {
    const n = note(op('/users'), 'Behavior');
    expect(op('/users').description).toContain('needs the `users:read` permission');
    expect(n).not.toContain('Permissions');
    expect(n).toContain('100 requests per 1 minute');
    expect(op('/users')['x-behavior']).toMatchObject({ permissions: ['users:read'], rateLimit: [{ limit: 100, windowMs: 60000 }] });
  });
  it('@Throttle override', () => {
    expect(note(op('/users/slow'), 'Behavior')).toContain('2 requests per 1 second');
  });
  it('CacheInterceptor with @CacheTTL / @CacheKey (seconds with the Nest built-in cache)', () => {
    const n = note(op('/users/cached'), 'Behavior');
    expect(n).toContain('cached for 30 seconds');
    expect(n).toContain('`users-cached`');
    expect(op('/users/cached')['x-behavior'].cache).toEqual({ ttlMs: 30000, key: 'users-cached' });
  });
  it('CacheInterceptor without a TTL says so plainly', () => {
    const n = note(op('/users/cached-default'), 'Behavior');
    expect(n).toContain('are cached, so a repeat call');
  });
  it('guards are named only on request', () => {
    expect(note(op('/users/slow'), 'Behavior')).not.toContain('AdminGuard');
    const d = build({ behavior: { guards: true } });
    expect(note(d.paths['/users/slow'].get, 'Behavior')).toContain('`AdminGuard`');
    expect(d.paths['/users/slow'].get['x-behavior'].guards).toContain('AdminGuard');
    expect(d.paths['/users/slow'].get['x-behavior'].guards).not.toContain('ThrottlerGuard');
  });
  it('ttl unit can be forced', () => {
    const d = build({ behavior: { cacheTtlUnit: 'ms' } });
    expect(note(d.paths['/users/cached'].get, 'Behavior')).toContain('cached for 30 ms');
  });
  it('off switches and plain operations', () => {
    expect(build({ behavior: false }).paths['/users'].get['x-behavior']).toBeUndefined();
    const ping = note(op('/ping'), 'Behavior');
    expect(ping).toContain('Rate limit');
    expect(ping).not.toMatch(/Caching|Permissions|Guards/);
    const d = build({ behavior: { description: false } }).paths['/users'].get;
    expect(d['x-behavior']).toBeDefined();
    expect(d.description ?? '').not.toContain('Behavior');
  });
  it('no $-patterns are introduced', () => {
    expect(JSON.stringify(doc)).not.toMatch(/\$[`'&$]/);
  });
});

describe('listingOf on hand-made operations', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { listingOf, listingLines } = require('../src/enhancer/listing');
  const q = (...names: string[]) => ({ parameters: names.map((name) => ({ name, in: 'query', schema: { type: 'string' } })), responses: { 200: { description: 'ok' } } });
  const docOf = {} as any;
  it('JSON:API style names', () => {
    const f = listingOf(docOf, q('page[number]', 'page[size]', 'filter[status]', 'sort'));
    expect(f.style).toBe('page');
    expect(f.params).toEqual({ page: 'page[number]', size: 'page[size]' });
    expect(f.others).toEqual(['filter[status]']);
  });
  it('skip / take is offset based', () => {
    expect(listingOf(docOf, q('skip', 'take')).style).toBe('offset');
  });
  it('page alone still counts, limit alone does not', () => {
    expect(listingOf(docOf, q('page')).style).toBe('page');
    expect(listingOf(docOf, q('limit'))).toBeUndefined();
    expect(listingOf(docOf, q('search', 'status'))).toBeUndefined();
  });
  it('resolves $ref parameters and ignores header / path ones', () => {
    const d = { components: { parameters: { P: { name: 'page', in: 'query', schema: { type: 'integer', minimum: 0 } } } } };
    const op = { parameters: [{ $ref: '#/components/parameters/P' }, { name: 'limit', in: 'header', schema: {} }, { name: 'size', in: 'query', schema: { default: 5 } }] };
    const f = listingOf(d, op);
    expect(f.style).toBe('page');
    expect(listingLines(f)[0]).toContain('starts at 0');
  });
  it('unknown response shapes do not throw', () => {
    expect(() => listingOf(docOf, { ...q('page', 'limit'), responses: { 200: { content: { 'application/json': { schema: { $ref: '#/nope' } } } } } })).not.toThrow();
  });
});

describe('where the notes go', () => {
  it('inside the single Contract details fold by default', () => {
    const d = op('/users').description as string;
    expect((d.match(/<details>/g) ?? []).length).toBe(1);
    expect(d.trimEnd().endsWith('</details>')).toBe(true);
    expect(d.indexOf('**Behavior**')).toBeGreaterThan(d.indexOf('Contract details'));
  });
  it('inline when the fold is off, absent in summary mode, untouched with generate / transform / descriptions:false', () => {
    expect(build({ descriptions: { collapse: false } }).paths['/users'].get.description).toContain('**Behavior**');
    expect(build({ descriptions: { collapse: false } }).paths['/users'].get.description).not.toContain('<details>');
    for (const descriptions of [{ detail: 'summary' }, { generate: () => 'Mine' }, { transform: (t: string) => t }, false]) {
      const o = build({ descriptions }).paths['/users'].get;
      expect(o.description ?? '').not.toContain('**Behavior**');
      expect(o.description ?? '').not.toContain('**Listing**');
      expect(o['x-pagination']).toBeDefined();
      expect(o['x-behavior']).toBeDefined();
    }
  });
});

describe('behaviorLines', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { behaviorLines } = require('../src/enhancer/behavior');
  it('permissions, block time and guards', () => {
    const l = behaviorLines({ permissions: ['a:b', 'c:d'], rateLimits: [{ name: 'x', limit: 1, ttlMs: 1000, blockMs: 60000 }], cache: undefined, guards: ['G'] }, { guards: true });
    expect(l[0]).toBe('**Permissions.** Requires `a:b`, `c:d`.');
    expect(l[1]).toContain('1 request per 1 second (blocked for 1 minute when exceeded)');
    expect(l[2]).toBe('**Guards.** `G`.');
  });
});
