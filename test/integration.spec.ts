import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { createApp } from './helpers';
import { buildDocument } from '../src';
import { AppModule } from './fixtures/app/app.module';
import { SERIALIZE_KEY } from './fixtures/app/reports/reports';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY, RESOURCE_KEY } from './fixtures/app/common/decorators';

const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'app');

describe('end-to-end: real Nest app -> enhanced OpenAPI document', () => {
  let app: INestApplication;
  let doc: any;

  beforeAll(async () => {
    app = await createApp(AppModule);
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    doc = buildDocument(app, {
      logger: false,
      sources: { roots: [FIXTURE_ROOT] },
      auth: { publicMetadataKeys: [IS_PUBLIC_KEY] },
      rbac: { metadataKey: PERMISSIONS_KEY },
      pagination: { paramTypeNames: ['QueryOptions'] },
      resource: [{ metadataKey: RESOURCE_KEY }, { metadataKey: SERIALIZE_KEY, kind: 'dto' }],
    });
    fs.writeFileSync(path.join(require('os').tmpdir(), 'enhanced-openapi.json'), JSON.stringify(doc, null, 2));
  });

  afterAll(async () => {
    await app.close();
  });

  const op = (method: string, p: string): any => doc.paths[p]?.[method];
  const schemas = (): Record<string, any> => doc.components.schemas;

  it('matches handlers even with a global prefix and URI versioning', () => {
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/api/users', '/api/users/{id}', '/api/v1/orders/{id}', '/api/v2/orders/{id}']),
    );
    expect(op('get', '/api/v1/orders/{id}').responses['200'].content['application/json'].schema.properties.total).toBeDefined();
    const v2 = op('get', '/api/v2/orders/{id}').responses['200'].content['application/json'].schema;
    expect(Object.keys(v2.properties)).toEqual(['id', 'total', 'currency']);
  });

  it('auth: public routes have empty security, others the bearer scheme', () => {
    expect(op('get', '/api/users/health').security).toEqual([]);
    expect(op('get', '/api/users/paged').security).toEqual([{ bearerAuth: [] }]);
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
  });

  it('rbac: permissions are exposed as an extension', () => {
    expect(op('post', '/api/users')['x-required-permissions']).toEqual(['users.create']);
    expect(op('get', '/api/users/paged')['x-required-permissions']).toBeUndefined();
  });

  it('pagination: injected for QueryOptions routes only; optional @Query is not required', () => {
    const names = (op('get', '/api/users/paged').parameters as any[]).map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['page', 'limit', 'sort', 'search', 'filter']));
    const role = (op('get', '/api/users').parameters as any[]).find((p) => p.name === 'role');
    expect(role.required).toBe(false);
    const id = (op('get', '/api/users/{id}').parameters as any[]).find((p) => p.name === 'id');
    expect(id.required).toBe(true);
    expect(id.example).toBe('3fa85f64-5717-4562-b3fc-2c963f66afa6');
  });

  it('pagination.include keeps only the listed parameters; auth.markPublic:false leaves public routes alone', () => {
    const d = buildDocument(app, {
      logger: false,
      configFile: false,
      sources: { roots: [FIXTURE_ROOT] },
      auth: { publicMetadataKeys: [IS_PUBLIC_KEY], markPublic: false },
      pagination: { paramTypeNames: ['QueryOptions'], include: ['page', 'limit'] },
    } as any);
    const names = (d.paths['/api/v1/users/paged']?.get?.parameters ?? d.paths['/api/users/paged']?.get?.parameters ?? []).map((p: any) => p.name);
    expect(names).toEqual(expect.arrayContaining(['page', 'limit']));
    expect(names).not.toContain('sort');
    expect(names).not.toContain('filter');
    const full = Object.values(doc.paths).flatMap((p: any) => Object.values(p) as any[]);
    const pub = full.filter((o) => Array.isArray(o.security) && o.security.length === 0).length;
    const pub2 = Object.values(d.paths).flatMap((p: any) => Object.values(p) as any[]).filter((o) => Array.isArray(o.security) && o.security.length === 0).length;
    expect(pub).toBeGreaterThan(0);
    expect(pub2).toBeLessThan(pub);
  });

  describe('responses', () => {
    const ok = (m: string, p: string, status = '200'): any => op(m, p).responses[status].content['application/json'];

    it('inline return types become inline schemas (literal union -> enum)', () => {
      const s = ok('get', '/api/users/health').schema;
      expect(s.properties.status).toEqual({ type: 'string', enum: ['ok'] });
      expect(s.properties.uptime).toEqual({ type: 'number' });
    });

    it('named return types are registered once and referenced', () => {
      expect(ok('post', '/api/users', '201').schema).toEqual({ $ref: '#/components/schemas/UserView' });
      const user = schemas().UserView;
      expect(user.required).toEqual(expect.arrayContaining(['id', 'name', 'email', 'role', 'createdAt', 'deletedAt', 'badges']));
      expect(user.required).not.toContain('address');
      expect(user.properties.createdAt).toEqual({ type: 'string', format: 'date-time' });
      // `| null` is nullable; a plain optional property is NOT
      expect(user.properties.deletedAt).toEqual({ type: 'string', format: 'date-time', nullable: true });
      expect(user.properties.address.nullable).toBeUndefined();
      expect(user.properties.role).toEqual({ type: 'string', enum: ['admin', 'member'] });
      expect(user.properties.badges.items.properties.level.enum).toEqual([1, 2, 3]);
    });

    it('Observable<T> and Promise<T> are unwrapped', () => {
      expect(ok('get', '/api/users/stream').schema.type).toBe('array');
      expect(ok('get', '/api/users/alias-a').schema.properties.ok).toEqual({ type: 'boolean' });
      expect(ok('get', '/api/users/alias-b').schema.properties.ok).toEqual({ type: 'boolean' });
    });

    it('@All() routes are matched for every method', () => {
      expect(ok('get', '/api/users/any').schema.properties.any).toBeDefined();
      expect(ok('post', '/api/users/any', '200').schema.properties.any).toBeDefined();
    });

    it('transformer-backed handlers get the configured envelope', () => {
      const single = ok('get', '/api/users/{id}').schema;
      expect(single.properties.data).toEqual({ $ref: '#/components/schemas/UserView' });
      const list = ok('get', '/api/users').schema;
      expect(list.properties.data.type).toBe('array');
      expect(list.required).toEqual(expect.arrayContaining(['data', 'total', 'page', 'limit', 'totalPages']));
      expect(ok('get', '/api/users').example.data).toHaveLength(1);
    });

    it('response examples use name + type aware values', () => {
      const ex = ok('post', '/api/users', '201').example;
      expect(ex.email).toBe('ahmed.hassan@example.com');
      expect(ex.createdAt).toBe('2026-01-15T10:30:00.000Z');
      expect(ex.role).toBe('admin');
    });
  });

  describe('request bodies & DTOs', () => {
    it('class DTOs are enriched from source + class-validator', () => {
      const dto = schemas().CreateUserDto;
      expect(dto.required).toEqual(expect.arrayContaining(['name', 'email', 'age', 'role', 'otp', 'address']));
      expect(dto.required).not.toContain('nickname');
      expect(dto.properties.name).toMatchObject({ type: 'string', minLength: 2 });
      expect(dto.properties.email).toMatchObject({ type: 'string', format: 'email' });
      expect(dto.properties.age).toMatchObject({ type: 'integer' });
      expect(dto.properties.role).toEqual({ type: 'string', enum: ['admin', 'member'] });
      expect(dto.properties.otp.pattern).toBe('^\\d{6}$');
      expect(dto.properties.address).toEqual({ $ref: '#/components/schemas/AddressDto' });
      expect(schemas().AddressDto.properties.city).toEqual({ type: 'string' });
      expect(dto.properties.nickname.nullable).toBe(true);
      expect(dto.properties.tags).toEqual({ type: 'array', items: { type: 'string' } });
      expect(dto.properties.settings).toEqual({ type: 'object', additionalProperties: { type: 'string' } });
    });

    it('PartialType()/mapped-type DTOs keep their properties (all optional)', () => {
      const dto = schemas().UpdateUserDto;
      expect(Object.keys(dto.properties)).toEqual(expect.arrayContaining(['name', 'email', 'age', 'address']));
      expect(dto.required).toBeUndefined();
    });

    it('request examples respect validators and property types', () => {
      const ex = op('post', '/api/users').requestBody.content['application/json'].example;
      expect(ex.otp).toMatch(/^\d{6}$/);
      expect(ex.email).toBe('ahmed.hassan@example.com');
      expect(ex.age).toBe(25);
      expect(ex.role).toBe('admin');
      expect(ex.address.city).toBe('Cairo');
      // token-boundary matching: `paid` is NOT an id, `isActive` is a boolean
      expect(ex.paid).toBe(true);
      expect(ex.isActive).toBe(true);
      expect(ex.createdAt).toBe('2026-01-15T10:30:00.000Z');
    });

    it('array bodies (plain `Dto[]` and ParseArrayPipe) are documented as arrays of the DTO', () => {
      for (const p of ['/api/users/bulk', '/api/users/bulk-pipe']) {
        const body = op('post', p).requestBody.content['application/json'];
        expect(body.schema).toEqual({ type: 'array', items: { $ref: '#/components/schemas/CreateUserDto' } });
        expect(Array.isArray(body.example)).toBe(true);
        expect(body.example[0].email).toBe('ahmed.hassan@example.com');
      }
    });

    it('Pick<>/Omit<> bodies resolve (mapped types carry no valueDeclaration)', () => {
      const body = op('post', '/api/users/partial').requestBody.content['application/json'].schema;
      expect(Object.keys(body.properties).sort()).toEqual(['email', 'name']);
      expect(body.required.sort()).toEqual(['email', 'name']);
    });

    it('inline object bodies and numeric examples', () => {
      const body = op('post', '/api/users/inline').requestBody.content['application/json'];
      expect(body.schema.required).toEqual(['amount']);
      expect(typeof body.example.amount).toBe('number');
      expect(body.example.idempotencyKey).toBe('a1b2c3d4-req-2026-01-15');
    });

    it('@Body("field") parameters are composed into one object', () => {
      const body = op('post', '/api/users/fields').requestBody.content['application/json'].schema;
      expect(body.properties.email).toEqual({ type: 'string' });
      expect(body.properties.age).toEqual({ type: 'number' });
      expect(body.required).toEqual(['email']);
    });
  });

  describe('runtime error discovery', () => {
    const errors = (m: string, p: string, status: string): any => op(m, p).responses[status];
    const messagesOf = (resp: any): string[] => {
      const c = resp.content['application/json'];
      const out: string[] = [];
      if (c.example?.message) out.push(...[c.example.message].flat());
      for (const e of Object.values<any>(c.examples ?? {})) {
        const m = e.value.message;
        out.push(...(Array.isArray(m) ? m : [m]));
      }
      return out;
    };

    it('real constructor messages from the service closure (controller -> service -> repository)', () => {
      expect(messagesOf(errors('post', '/api/users', '409'))).toContain('Email already registered');
      const notFound = messagesOf(errors('get', '/api/users/{id}', '404'));
      expect(notFound.some((m) => /^User .+ not found$/.test(m) && !m.includes('${'))).toBe(true);
    });

    it('custom exception classes inherit the status of their base class', () => {
      expect(messagesOf(errors('delete', '/api/users/{id}', '403'))).toContain('Quota exceeded for this plan');
      expect(errors('delete', '/api/users/{id}', '500').description).not.toContain('Quota exceeded');
    });

    it('guards: applied guards are concretized per required permission, public routes skip them', () => {
      expect(messagesOf(errors('post', '/api/users', '403'))).toContain("Permission denied: 'users.create' is required");
      expect(messagesOf(errors('post', '/api/users', '401'))).toContain('Authorization header is missing');
      expect(op('get', '/api/users/health').responses['401']).toBeUndefined();
    });

    it('route-level @UseGuards only affects that route', () => {
      expect(messagesOf(errors('get', '/api/users/beta', '403'))).toContain('Beta feature is not enabled for this account');
      expect(op('get', '/api/users/paged').responses['403']).toBeUndefined();
    });

    it('ValidationPipe 400 uses the endpoint DTO validators', () => {
      const msgs = messagesOf(errors('post', '/api/users', '400'));
      expect(msgs).toEqual(expect.arrayContaining(['email must be an email']));
      expect(msgs.some((m) => m.startsWith('name must be longer'))).toBe(true);
    });

    it('every route documents a 500', () => {
      expect(op('get', '/api/users/health').responses['500']).toBeDefined();
    });
  });

  describe('response shape after interceptors / mappers / serializers', () => {
    const body = (p: string): any => op('get', p).responses['200'].content['application/json'];

    it('generic interceptor <T> wraps an INFERRED handler type (no return annotation)', () => {
      const s = body('/api/reports/generic').schema;
      expect(s.properties.success).toEqual({ type: 'boolean' });
      expect(s.properties.result.properties.count).toEqual({ type: 'number' });
      expect(body('/api/reports/generic').example.result.count).toBe(5);
    });

    it('non-generic map(data => ({ data, … })) interceptor: the lone any slot is the payload', () => {
      const s = body('/api/reports/wrapped').schema;
      expect(Object.keys(s.properties)).toEqual(['data', 'generatedAt']);
      expect(s.properties.data.properties.total).toEqual({ type: 'number' });
    });

    it('interceptors compose innermost-first; pass-through (tap) interceptors change nothing', () => {
      const s = body('/api/reports/both').schema;
      // UseInterceptors(Wrap, Envelope): Envelope is innermost -> { data: { success, result: { n } }, generatedAt }
      expect(s.properties.data.properties.result.properties.n).toEqual({ type: 'number' });
      const plain = body('/api/reports/plain').schema;
      expect(Object.keys(plain.properties)).toEqual(['n']);
    });

    it('mapper methods are followed through inference when types flow', () => {
      const s = body('/api/reports/mapped').schema;
      expect(Object.keys(s.properties)).toEqual(['id', 'fullName']);
    });

    it('dto-kind serializer decorator documents the class even when the handler returns any', () => {
      expect(body('/api/reports/serialized').schema).toEqual({ $ref: '#/components/schemas/PublicUserDto' });
      expect(schemas().PublicUserDto.properties.displayName).toEqual({ type: 'string' });
      expect(body('/api/reports/serialized-list').schema).toEqual({
        type: 'array',
        items: { $ref: '#/components/schemas/PublicUserDto' },
      });
    });
  });

  describe('deep traversal of helpers / mappers / services', () => {
    const schemaOf = (p: string): any => op('get', p).responses['200']?.content?.['application/json']?.schema;
    const keys = (o: any): string[] => Object.keys(o.properties).sort();

    it('follows controller -> service -> mapper(any) -> helper -> helper', () => {
      const s = schemaOf('/api/deep/one');
      expect(keys(s)).toEqual(['adult', 'fullName', 'id', 'tags']);
      expect(s.properties.adult).toEqual({ type: 'boolean' });
    });

    it('array.map(cb) with an untyped source: items come from the callback', () => {
      const s = schemaOf('/api/deep/many');
      expect(s.type).toBe('array');
      expect(keys(s.items)).toEqual(['adult', 'fullName', 'id']);
    });

    it('object literals: each property is traced independently', () => {
      const s = schemaOf('/api/deep/wrapped');
      expect(keys(s.properties.user)).toEqual(['adult', 'fullName', 'id', 'tags']);
      expect(s.properties.meta.properties.page).toEqual({ type: 'number' });
    });

    it('conditional returns become oneOf', () => {
      const s = schemaOf('/api/deep/branch');
      expect(s.oneOf).toHaveLength(2);
    });

    it('a handler annotated `any` is still read through its body', () => {
      expect(keys(schemaOf('/api/deep/direct'))).toEqual(['adult', 'fullName', 'id', 'tags']);
    });

    it('cyclic untyped helpers terminate; truly untyped values stay undocumented (and are reported)', () => {
      expect(schemaOf('/api/deep/loop')).toBeUndefined();
      expect(schemaOf('/api/deep/hopeless')).toBeUndefined();
    });
  });
});
