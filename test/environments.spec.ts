import * as vm from 'node:vm';
import { environmentsScript, resolveEnvironments, defaultCaptures, routeParamNames } from '../src/ui/environments';

describe('Swagger UI environments script', () => {
  const cfg = resolveEnvironments(true)!;
  const script = environmentsScript(cfg);
  it('is off unless asked', () => {
    expect(resolveEnvironments(undefined)).toBeUndefined();
    expect(resolveEnvironments({ enabled: false })).toBeUndefined();
  });
  it('defaults: baseUrl rewrite, Bearer token, login captures', () => {
    expect(cfg.baseUrlVariable).toBe('baseUrl');
    expect(cfg.authorization).toEqual({ variable: 'token', scheme: 'Bearer' });
    expect(cfg.captures).toEqual([]);
    expect(cfg.auto).toMatchObject({ tokens: true, ids: true, fill: true, tokenVariable: 'token', refreshVariable: 'refreshToken' });
    expect(defaultCaptures.length).toBeGreaterThan(0);
    expect((resolveEnvironments({ captures: false, authorization: false, baseUrlVariable: false }) as any).captures).toEqual([]);
  });
  it('is valid JavaScript and survives @nestjs/swagger string.replace injection', () => {
    expect(() => new vm.Script(script)).not.toThrow();
    expect(script).not.toMatch(/\$[`'&$]/);
    expect(script).not.toMatch(/<\/script/i);
    expect('<% customJsStr %>'.replace('<% customJsStr %>', script)).toBe(script);
  });
  it('config text containing </script> cannot break out of the page', () => {
    const s = environmentsScript(resolveEnvironments({ globals: { x: '</script><b>' } })!);
    expect(s).not.toMatch(/<\/script/i);
  });
  it('route parameters become variables', () => {
    expect(routeParamNames({ paths: { '/a/{id}': {}, '/b/{id}/c/{userId}': {}, '/d': {} } })).toEqual(['id', 'userId']);
    expect((resolveEnvironments(true, { paths: { '/a/{id}': {} } }) as any).routeParams).toEqual(['id']);
    expect((resolveEnvironments({ auto: false }) as any).auto).toMatchObject({ tokens: false, ids: false, fill: false });
  });
});

describe('Swagger UI requestInterceptor (what Curl / Request URL show)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { requestInterceptorFor } = require('../src/setup');
  const withWindow = (env: unknown, fn: () => void): void => {
    (globalThis as any).window = { __autodocEnv: env };
    try {
      fn();
    } finally {
      delete (globalThis as any).window;
    }
  };
  it('runs the variable resolver, then the project hook; survives string.replace injection', () => {
    const fn = requestInterceptorFor((r: any) => ({ ...r, headers: { ...r.headers, 'x-own': '1' } }));
    expect(fn.toString()).not.toMatch(/\$[`'&$]/);
    withWindow({ interceptRequest: (r: any) => ({ ...r, url: r.url.replace('{{a}}', 'B') }) }, () => {
      expect(fn({ url: '/x/{{a}}', headers: {} })).toEqual({ url: '/x/B', headers: { 'x-own': '1' } });
    });
  });
  it('without a project hook it just resolves; without the script it is a no-op', () => {
    const fn = requestInterceptorFor();
    withWindow({ interceptRequest: (r: any) => ({ ...r, ok: true }) }, () => expect(fn({ url: '/' })).toEqual({ url: '/', ok: true }));
    withWindow(undefined, () => expect(fn({ url: '/' })).toEqual({ url: '/' }));
  });
});
