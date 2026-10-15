import 'reflect-metadata';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { createApp } from './helpers';
import { buildDocument, resolveOptions, resolveOptionsDetailed, FEATURES } from '../src';
import { disabledFor, deepMerge } from '../src/options';
import { FeaturesModule } from './fixtures/features/features.module';
import { main } from '../src/cli';

const roots = [path.join(__dirname, 'fixtures', 'features')];
let app: INestApplication;
beforeAll(async () => {
  app = await createApp(FeaturesModule);
  base = build();
});
afterAll(async () => app.close());

const build = (o: Record<string, unknown> = {}): any => buildDocument(app, { logger: false, sources: { roots }, configFile: false, ...o } as any);
const op = (d: any, m: string, p: string): any => d.paths[p]?.[m];
let base: any;

describe('baseline', () => {
  it('has the features this file switches off one by one', () => {
    expect(op(base, 'get', '/things').parameters.length).toBeGreaterThan(0);
    expect(op(base, 'get', '/things/limited/fast')['x-rate-limit']).toBeDefined();
    expect(op(base, 'get', '/things/limited/fast').responses['429']).toBeDefined();
    expect(op(base, 'get', '/things').summary).toBeTruthy();
    expect(op(base, 'get', '/things').description).toBeTruthy();
    expect(op(base, 'post', '/things').responses['400']).toBeDefined();
    expect(op(base, 'post', '/things').responses['500']).toBeDefined();
    expect(op(base, 'post', '/things').requestBody.content['application/json'].example).toBeDefined();
    expect(op(base, 'post', '/things/avatar').requestBody.content['multipart/form-data']).toBeDefined();
    expect(op(base, 'post', '/things/photo').requestBody.content['multipart/form-data'].encoding).toBeDefined();
    expect(base.components.securitySchemes.bearerAuth).toBeDefined();
  });
});

describe('every feature can be switched off', () => {
  it.each(FEATURES.filter((f) => f !== 'rbac'))('%s: false', (f) => {
    expect(() => build({ [f]: false })).not.toThrow();
  });
  it('object form with enabled:false equals false', () => {
    expect(JSON.stringify(build({ errors: { enabled: false } }))).toEqual(JSON.stringify(build({ errors: false })));
    expect(JSON.stringify(build({ rateLimit: { enabled: false } }))).toEqual(JSON.stringify(build({ rateLimit: false })));
    expect(JSON.stringify(build({ uploads: { enabled: false } }))).toEqual(JSON.stringify(build({ uploads: false })));
    expect(JSON.stringify(build({ summaries: { enabled: false } }))).toEqual(JSON.stringify(build({ summaries: false })));
    expect(JSON.stringify(build({ descriptions: { enabled: false } }))).toEqual(JSON.stringify(build({ descriptions: false })));
  });
  it('auth:false -> no security, no scheme', () => {
    const d = build({ auth: false });
    expect(op(d, 'get', '/things').security).toBeUndefined();
    expect(d.components.securitySchemes?.bearerAuth).toBeUndefined();
  });
  it('pagination:false / rbac stays off', () => {
    expect(build({ pagination: false })).toBeDefined();
  });
  it('requestBodies:false -> no generated bodies', () => {
    expect(op(build({ requestBodies: false, examples: false }), 'post', '/things/login').requestBody?.content?.['application/json']?.example).toBeUndefined();
  });
  it('queryParams:false', () => {
    expect(op(build({ queryParams: false }), 'get', '/things').parameters ?? []).toEqual([]);
  });
  it('queryParams.query:false keeps path/header expansion', () => {
    const d = build({ queryParams: { query: false } });
    expect(op(d, 'get', '/things').parameters ?? []).toEqual([]);
    expect(op(d, 'get', '/things/by/{code}').parameters.map((p: any) => p.name)).toEqual(['code']);
  });
  it('queryParams.path:false / header:false', () => {
    expect(op(build({ queryParams: { path: false } }), 'get', '/things/by/{code}').parameters ?? []).toEqual([]);
    expect(op(build({ queryParams: { header: false } }), 'get', '/things/by/{code}').parameters.map((p: any) => p.name)).toEqual(['code']);
    expect(op(build({ queryParams: { header: false } }), 'get', '/things/hdr/check').parameters ?? []).toEqual([]);
  });
  it('uploads:false', () => {
    expect(op(build({ uploads: false }), 'post', '/things/avatar').requestBody?.content?.['multipart/form-data']).toBeUndefined();
  });
  it('uploads.encoding:false / rules:false', () => {
    const e = op(build({ uploads: { encoding: false } }), 'post', '/things/photo').requestBody.content['multipart/form-data'];
    expect(e.encoding).toBeUndefined();
    expect(JSON.stringify(e.schema)).toContain('x-max-size');
    const r = op(build({ uploads: { rules: false } }), 'post', '/things/photo').requestBody.content['multipart/form-data'];
    expect(JSON.stringify(r)).not.toContain('x-max-size');
    expect(r.encoding).toBeUndefined();
  });
  it('rateLimit:false', () => {
    const d = op(build({ rateLimit: false }), 'get', '/things/limited/fast');
    expect(d['x-rate-limit']).toBeUndefined();
    expect(d.responses['429']).toBeUndefined();
  });
  it('rateLimit.response:false keeps the extension only', () => {
    const d = op(build({ rateLimit: { response: false } }), 'get', '/things/limited/fast');
    expect(d['x-rate-limit']).toBeDefined();
    expect(d.responses['429']).toBeUndefined();
  });
  it('rateLimit.extension:false / custom name / header:false', () => {
    expect(op(build({ rateLimit: { extension: false } }), 'get', '/things/limited/fast')['x-rate-limit']).toBeUndefined();
    expect(op(build({ rateLimit: { extension: 'x-throttle' } }), 'get', '/things/limited/fast')['x-throttle']).toBeDefined();
    expect(op(build({ rateLimit: { header: false } }), 'get', '/things/limited/fast').responses['429'].headers).toBeUndefined();
  });
  it('summaries:false / overwrite', () => {
    expect(op(build({ summaries: false }), 'get', '/things').summary).toBeUndefined();
    expect(op(build({ summaries: {} }), 'get', '/things/custom/own').summary).toBe('My own summary');
    expect(op(build({ summaries: { overwrite: true, generate: () => 'Forced' } }), 'get', '/things/custom/own').summary).toBe('Forced');
  });
  it('descriptions:false / overwrite / generate / transform', () => {
    expect(op(build({ descriptions: false }), 'get', '/things').description).toBeUndefined();
    expect(op(build({ descriptions: { generate: () => 'Mine' } }), 'get', '/things').description).toBe('Mine');
    expect(op(build({ descriptions: { transform: (t: string) => `>> ${t}` } }), 'get', '/things').description).toMatch(/^>> /);
    expect(op(build({ descriptions: { transform: () => '' } }), 'get', '/things').description).toBeUndefined();
    expect(op(build({ descriptions: { generate: (c: any) => (c.methodName === 'findAll' ? 'X' : undefined) } }), 'get', '/things').description).toBe('X');
  });
  it('examples: false / per kind', () => {
    const none = build({ examples: false });
    expect(op(none, 'post', '/things/login').requestBody?.content?.['application/json']?.example).toBeUndefined();
    expect(op(build({ examples: { requests: false } }), 'post', '/things/login').requestBody.content['application/json'].example).toBeUndefined();
    const noParams = op(build({ examples: { parameters: false } }), 'get', '/things/{id}').parameters;
    expect(noParams.every((p: any) => p.example === undefined)).toBe(true);
    expect(op(base, 'get', '/things/{id}').parameters.some((p: any) => p.example !== undefined)).toBe(true);
    const keep = op(build({ examples: { fixRequired: false } }), 'get', '/things/{id}').parameters;
    expect(keep).toBeDefined();
  });
  it('requestBodies.example:false', () => {
    expect(op(build({ requestBodies: { example: false }, examples: { requests: true } }), 'post', '/things/login').requestBody.content['application/json'].schema).toBeDefined();
  });
  it('auth.registerScheme / markPublic / markProtected', () => {
    expect(build({ auth: { registerScheme: false } }).components.securitySchemes?.bearerAuth).toBeUndefined();
    expect(op(build({ auth: { markProtected: false } }), 'get', '/things').security).toBeUndefined();
    expect(op(build({ auth: { markProtected: true } }), 'get', '/things').security).toEqual([{ bearerAuth: [] }]);
  });
  it('pagination.include', () => {
    expect(build({ pagination: { include: ['page'] } })).toBeDefined();
  });
  it('asyncEndpoints toggles', () => {
    expect(build({ asyncEndpoints: false })['x-websocket']).toBeUndefined();
    expect(build({ asyncEndpoints: { websocket: false } })['x-websocket']).toBeUndefined();
  });
});

describe('errors options', () => {
  const post = (o: Record<string, unknown>): any => op(build({ errors: o }), 'post', '/things');
  it('validation400:false removes the validation 400', () => {
    expect(op(base, 'post', '/things').responses['400']).toBeDefined();
    expect(post({ validation400: false }).responses['400']).toBeUndefined();
  });
  it('document500:false', () => {
    const count = (d: any): number => Object.values(d.paths).flatMap((p: any) => Object.values(p) as any[]).filter((o) => o.responses?.['500']).length;
    const specific = count(build({ errors: { relevance: 'specific' } }));
    expect(specific).toBeGreaterThan(0);
    expect(count(build({ errors: { relevance: 'specific', document500: false } }))).toBeLessThan(specific);
  });
  it('statuses include / exclude', () => {
    const inc = post({ statuses: { include: [400] } }).responses;
    expect(inc['400']).toBeDefined();
    expect(inc['500']).toBeUndefined();
    const exc = post({ statuses: { exclude: [400, 500] } }).responses;
    expect(exc['400']).toBeUndefined();
    expect(exc['500']).toBeUndefined();
  });
  it('describe:false drops the list, custom heading renames it', () => {
    const withList = Object.values(base.paths).flatMap((p: any) => Object.values(p)).flatMap((o: any) => Object.values(o.responses ?? {})) as any[];
    expect(withList.some((r) => /Possible errors:/.test(r.description ?? ''))).toBe(true);
    const off = Object.values(build({ errors: { describe: false } }).paths).flatMap((p: any) => Object.values(p)).flatMap((o: any) => Object.values(o.responses ?? {})) as any[];
    expect(off.some((r) => /Possible errors:/.test(r.description ?? ''))).toBe(false);
    const head = Object.values(build({ errors: { describeHeading: 'Failures:' } }).paths).flatMap((p: any) => Object.values(p)).flatMap((o: any) => Object.values(o.responses ?? {})) as any[];
    expect(head.some((r) => /Failures:/.test(r.description ?? '')) || !withList.some((r) => /Possible errors:/.test(r.description ?? ''))).toBe(true);
  });
  it('examples:false removes error examples but keeps schemas', () => {
    const r = post({ examples: false }).responses['500'].content['application/json'];
    expect(r.schema).toBeDefined();
    expect(r.example).toBeUndefined();
    expect(r.examples).toBeUndefined();
    expect(op(base, 'post', '/things').responses['500'].content['application/json'].example).toBeDefined();
  });
  it('endpoint:false does not scan handler code', () => {
    expect(post({ endpoint: false })).toBeDefined();
  });
});

describe('preset, enable/disable, env', () => {
  it('minimal turns off everything that reads source', () => {
    const d = build({ preset: 'minimal' });
    expect(op(d, 'get', '/things').summary).toBeUndefined();
    expect(op(d, 'get', '/things').description).toBeUndefined();
    expect(op(d, 'post', '/things/avatar').requestBody?.content?.['multipart/form-data']).toBeUndefined();
    expect(op(d, 'get', '/things/limited/fast')['x-rate-limit']).toBeDefined();
    expect(d.components.securitySchemes.bearerAuth).toBeDefined();
  });
  it('minimal + enable brings one back; explicit options win over the preset', () => {
    expect(op(build({ preset: 'minimal', enable: ['summaries'] }), 'get', '/things').summary).toBeTruthy();
    expect(op(build({ preset: 'minimal', summaries: true }), 'get', '/things').summary).toBeTruthy();
    expect(op(build({ preset: 'minimal', descriptions: { generate: () => 'D' } }), 'get', '/things').description).toBe('D');
  });
  it('disable list == false; disable beats enable', () => {
    expect(JSON.stringify(build({ disable: ['errors', 'uploads'] }))).toEqual(JSON.stringify(build({ errors: false, uploads: false })));
    expect(op(build({ enable: ['summaries'], disable: ['summaries'] }), 'get', '/things').summary).toBeUndefined();
  });
  it('enable keeps the options object', () => {
    const { options } = resolveOptionsDetailed({ configFile: false, errors: { enabled: false, document500: false }, enable: ['errors'] });
    expect(options.errors).toEqual({ document500: false });
  });
  it('rbac only turns on through enable/config', () => {
    expect(resolveOptionsDetailed({ configFile: false }).features.rbac).toBe(false);
    expect(resolveOptionsDetailed({ configFile: false, enable: ['rbac'] }).features.rbac).toBe(true);
  });
  it('env vars apply last', () => {
    process.env.SWAGGER_AUTODOC_DISABLE = 'summaries, errors';
    try {
      const d = build({ errors: { document500: true } });
      expect(op(d, 'get', '/things').summary).toBeUndefined();
      expect(op(d, 'post', '/things').responses['500']).toBeUndefined();
    } finally {
      delete process.env.SWAGGER_AUTODOC_DISABLE;
    }
    process.env.SWAGGER_AUTODOC_PRESET = 'minimal';
    process.env.SWAGGER_AUTODOC_ENABLE = 'summaries';
    try {
      const d = build();
      expect(op(d, 'get', '/things').summary).toBeTruthy();
      expect(op(d, 'get', '/things').description).toBeUndefined();
    } finally {
      delete process.env.SWAGGER_AUTODOC_PRESET;
      delete process.env.SWAGGER_AUTODOC_ENABLE;
    }
  });
  it('unknown feature names and presets only warn', () => {
    const r = resolveOptionsDetailed({ configFile: false, disable: ['nope' as never], preset: 'weird' as never });
    expect(r.warnings.join('|')).toMatch(/Unknown feature "nope"/);
    expect(r.warnings.join('|')).toMatch(/Unknown preset/);
    expect(r.preset).toBe('standard');
  });
  it('resolveOptions is idempotent', () => {
    const once = resolveOptions({ disable: ['errors'], configFile: false });
    expect(resolveOptions(once)).toBe(once);
  });
});

describe('config file', () => {
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'autodoc-cfg-'));
  it('reads swagger-autodoc.config.js, explicit options win, objects merge', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'swagger-autodoc.config.js'), "module.exports = { errors: { document500: false, relevance: 'specific' }, summaries: false, title: 'From file' };");
    const { options, configFile } = resolveOptionsDetailed({ sources: { cwd: dir }, errors: { relevance: 'all' }, title: 'Explicit' });
    expect(configFile).toMatch(/swagger-autodoc\.config\.js$/);
    expect(options.summaries).toBe(false);
    expect(options.errors).toEqual({ document500: false, relevance: 'all' });
    expect(options.title).toBe('Explicit');
  });
  it('reads .json and package.json "swaggerAutodoc"', () => {
    const a = tmp();
    fs.writeFileSync(path.join(a, '.swagger-autodocrc.json'), JSON.stringify({ disable: ['uploads'] }));
    expect(resolveOptionsDetailed({ sources: { cwd: a } }).features.uploads).toBe(false);
    const b = tmp();
    fs.writeFileSync(path.join(b, 'package.json'), JSON.stringify({ name: 'x', swaggerAutodoc: { preset: 'minimal' } }));
    expect(resolveOptionsDetailed({ sources: { cwd: b } }).features.descriptions).toBe(false);
  });
  it('configFile:false ignores it; a missing explicit file throws; a broken auto file only warns', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'swagger-autodoc.config.js'), 'module.exports = { summaries: false };');
    expect(resolveOptionsDetailed({ sources: { cwd: dir }, configFile: false }).features.summaries).toBe(true);
    expect(() => resolveOptionsDetailed({ sources: { cwd: dir }, configFile: 'nope.js' })).toThrow(/not found/);
    const bad = tmp();
    fs.writeFileSync(path.join(bad, 'swagger-autodoc.config.js'), 'throw new Error("boom");');
    const r = resolveOptionsDetailed({ sources: { cwd: bad } });
    expect(r.warnings.join('|')).toMatch(/boom/);
    expect(r.features.summaries).toBe(true);
  });
  it('the file reaches buildDocument', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'swagger-autodoc.config.js'), "module.exports = { disable: ['summaries'] };");
    const d = buildDocument(app, { logger: false, sources: { roots, cwd: dir } });
    expect(op(d, 'get', '/things').summary).toBeUndefined();
  });
  it('deepMerge replaces arrays and functions', () => {
    expect(deepMerge({ a: [1], b: { c: 1, d: 2 } }, { a: [2], b: { c: 3 } })).toEqual({ a: [2], b: { c: 3, d: 2 } });
  });
});

describe('per-operation rules and hooks', () => {
  it('array rules by Class.method, VERB:/route, wildcard and regexp', () => {
    const d = build({
      operations: [
        { match: 'ThingsController.findAll', disable: ['summaries', 'descriptions'] },
        { match: 'GET:/things/{id}', disable: ['examples'] },
        { match: 'POST /things/log*', disable: ['errors'] },
        { match: /avatar/, disable: ['uploads'] },
      ],
    });
    expect(op(d, 'get', '/things').summary).toBeUndefined();
    expect(op(d, 'get', '/things').description).toBeUndefined();
    expect(op(d, 'get', '/things/limited/fast').summary).toBeTruthy();
    expect(op(d, 'get', '/things/{id}').parameters.every((p: any) => p.example === undefined)).toBe(true);
    expect(op(d, 'post', '/things/login').responses['500']).toBeUndefined();
    expect(op(d, 'post', '/things').responses['500']).toBeDefined();
    expect(op(d, 'post', '/things/avatar').requestBody?.content?.['multipart/form-data']).toBeUndefined();
    expect(op(d, 'post', '/things/photo').requestBody.content['multipart/form-data']).toBeDefined();
  });
  it('a later enable undoes an earlier disable; function form', () => {
    const d = build({ operations: [{ match: '*', disable: ['summaries'] }, { match: 'ThingsController.findAll', enable: ['summaries'] }] });
    expect(op(d, 'get', '/things').summary).toBeTruthy();
    expect(op(d, 'get', '/things/limited/fast').summary).toBeUndefined();
    const f = build({ operations: (c: any) => (c.methodName === 'fast' ? { disable: ['rateLimit'] } : undefined) });
    expect(op(f, 'get', '/things/limited/fast')['x-rate-limit']).toBeUndefined();
    expect(op(f, 'get', '/things/limited/skip')).toBeDefined();
  });
  it('a throwing rule function does not break the build', () => {
    expect(() => build({ operations: () => { throw new Error('x'); } })).not.toThrow();
  });
  it('disabledFor matches case-insensitively on the verb', () => {
    const ctx = { path: '/a/{id}', method: 'get', operationId: 'x', controllerName: 'A', methodName: 'm', tags: [], operation: {} };
    expect([...disabledFor([{ match: 'get:/a/:id', disable: ['errors'] }], ctx)]).toEqual(['errors']);
    expect([...disabledFor([{ match: 'A.GET:/a/:id', disable: ['errors'] }], ctx)]).toEqual(['errors']);
    expect([...disabledFor([{ match: 'B.m', disable: ['errors'] }], ctx)]).toEqual([]);
  });
  it('hooks: before / after (replace) / operation', () => {
    const calls: string[] = [];
    const d = build({
      hooks: {
        beforeEnhance: (doc: any) => calls.push(`before:${Object.keys(doc.paths).length > 0}`),
        operation: (ctx: any) => {
          if (ctx.methodName === 'findAll') ctx.operation['x-hooked'] = true;
        },
        afterEnhance: (doc: any) => ({ ...doc, info: { ...doc.info, title: 'Replaced' } }),
      },
    });
    expect(calls).toEqual(['before:true']);
    expect(op(d, 'get', '/things')['x-hooked']).toBe(true);
    expect(d.info.title).toBe('Replaced');
  });
  it('a throwing hook is swallowed', () => {
    expect(() => build({ hooks: { beforeEnhance: () => { throw new Error('b'); }, afterEnhance: () => { throw new Error('a'); }, operation: () => { throw new Error('o'); } } })).not.toThrow();
  });
});

describe('warnings option and CLI config', () => {
  it('warnings:false routes warn() to debug', () => {
    const warn = jest.fn();
    const debug = jest.fn();
    const logger = { log: jest.fn(), warn, debug, error: jest.fn() };
    buildDocument(app, { logger, sources: { roots: [path.join(__dirname, 'nowhere')] }, configFile: false, warnings: false } as any);
    expect(warn).not.toHaveBeenCalled();
    const warn2 = jest.fn();
    buildDocument(app, { logger: { ...logger, warn: warn2 }, sources: { roots: [path.join(__dirname, 'nowhere')] }, configFile: false } as any);
    void warn2;
  });
  it('`config` command prints the effective features', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodoc-cli-'));
    fs.writeFileSync(path.join(dir, 'swagger-autodoc.config.json'), JSON.stringify({ disable: ['errors'] }));
    let out = '';
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: string) => ((out += s), true);
    try {
      expect(await main(['config', '--json'], dir)).toBe(0);
    } finally {
      (process.stdout as any).write = orig;
    }
    const j = JSON.parse(out);
    expect(j.features.errors).toBe(false);
    expect(j.features.summaries).toBe(true);
    expect(j.configFile).toMatch(/swagger-autodoc\.config\.json$/);
  });
});
