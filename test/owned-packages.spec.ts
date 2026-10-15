import 'reflect-metadata';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createApp } from './helpers';
import { buildDocument } from '../src';
import { discoverOwnedPackages, packageOfFile } from '../src/source/owned-packages';
import { SourceIndex } from '../src/source/source-index';
import { PkgDtoModule } from './fixtures/pkgdto/pkgdto.module';

const cwd = path.join(__dirname, 'fixtures', 'pkgdto');
let app: any;
beforeAll(async () => {
  app = await createApp(PkgDtoModule);
});
afterAll(async () => app.close());
const build = (o: Record<string, unknown> = {}): any => buildDocument(app, { logger: false, configFile: false, sources: { roots: [cwd], cwd, ...((o.sources as object) ?? {}) }, ...o, ...(o.sources ? { sources: { roots: [cwd], cwd, ...(o.sources as object) } } : {}) } as any);

describe('DTOs that live in an installed package', () => {
  it('are read without any configuration', () => {
    const d = build();
    const body = d.paths['/pkg-things'].post.requestBody.content['application/json'];
    expect(body.schema.$ref).toBe('#/components/schemas/CreateThingDto');
    expect(Object.keys(d.components.schemas.CreateThingDto.properties).sort()).toEqual(['name', 'quantity', 'tags']);
    expect(d.components.schemas.CreateThingDto.required.sort()).toEqual(['name', 'tags']);
    const params = d.paths['/pkg-things'].get.parameters.map((p: any) => `${p.name}:${p.required}`).sort();
    expect(params).toEqual(['page:true', 'search:false']);
    const ok = d.paths['/pkg-things'].get.responses['200'].content['application/json'].schema;
    expect(JSON.stringify(ok)).toContain('quantity');
  });
  it('a type-only import does not leave a Function placeholder', () => {
    const d = build();
    const body = d.paths['/pkg-things/{id}'].patch.requestBody.content['application/json'];
    expect(body.schema.$ref).toBe('#/components/schemas/UpdateThingDto');
    expect(d.components.schemas.Function).toBeUndefined();
    expect(Object.keys(d.components.schemas.UpdateThingDto.properties).sort()).toEqual(['name', 'quantity']);
  });
  it('sources.autoPackages:false keeps them opaque', () => {
    const d = build({ sources: { autoPackages: false } });
    const props = d.components.schemas.CreateThingDto?.properties;
    expect(props && Object.keys(props).length > 0).toBeFalsy();
  });
  it('sources.excludePackages leaves one alone', () => {
    const d = build({ sources: { excludePackages: ['@acme/shared'] } });
    const props = d.components.schemas.CreateThingDto?.properties;
    expect(props && Object.keys(props).length > 0).toBeFalsy();
  });
});

describe('discoverOwnedPackages', () => {
  it('finds file: dependencies, class-defining packages, ignores frameworks', () => {
    const found = discoverOwnedPackages(cwd, [path.join(cwd, 'node_modules/@nestjs/mapped-types/dist/x.js'), path.join(cwd, 'node_modules/other-lib/dist/y.js')]);
    expect(found.map((p) => p.name)).toEqual(['@acme/shared']); // other-lib is not installed; @nestjs is a framework
    expect(found[0].typeRoots).toEqual([path.join(found[0].dir, 'dist')]);
  });
  it('registry dependencies stay foreign unless a DTO class comes from them', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autodoc-own-'));
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ dependencies: { 'reg-lib': '^1.0.0', 'dto-lib': '^2.0.0' } }));
    for (const n of ['reg-lib', 'dto-lib']) {
      fs.mkdirSync(path.join(tmp, 'node_modules', n, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', n, 'package.json'), JSON.stringify({ name: n, types: 'dist/index.d.ts' }));
    }
    expect(discoverOwnedPackages(tmp, []).map((p) => p.name)).toEqual([]);
    expect(discoverOwnedPackages(tmp, [path.join(tmp, 'node_modules/dto-lib/dist/index.js')]).map((p) => p.name)).toEqual(['dto-lib']);
    expect(discoverOwnedPackages(tmp, [], ['reg-lib']).map((p) => p.name)).toEqual(['reg-lib']);
    expect(discoverOwnedPackages(tmp, [path.join(tmp, 'node_modules/dto-lib/dist/index.js')], [], ['dto-lib'])).toEqual([]);
  });
  it('symlinked workspace packages are owned', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autodoc-ws-'));
    fs.mkdirSync(path.join(tmp, 'packages', 'core', 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'packages', 'core', 'package.json'), JSON.stringify({ name: '@ws/core' }));
    fs.mkdirSync(path.join(tmp, 'node_modules', '@ws'), { recursive: true });
    fs.symlinkSync(path.join(tmp, 'packages', 'core'), path.join(tmp, 'node_modules', '@ws', 'core'), 'dir');
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ dependencies: { '@ws/core': '*' } }));
    const found = discoverOwnedPackages(tmp, []);
    expect(found.map((p) => p.name)).toEqual(['@ws/core']);
    expect(found[0].typeRoots).toEqual([fs.realpathSync(path.join(tmp, 'packages', 'core', 'src'))]);
  });
  it('packageOfFile takes the last node_modules segment and handles scopes', () => {
    expect(packageOfFile('/a/node_modules/.pnpm/x@1/node_modules/@s/p/dist/i.js')).toEqual({ name: '@s/p', dir: '/a/node_modules/.pnpm/x@1/node_modules/@s/p' });
    expect(packageOfFile('/a/src/i.js')).toBeUndefined();
  });
});

describe('SourceIndex.resolveDtoByShape', () => {
  it('matches an exact unique property set and refuses ambiguity', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autodoc-shape-'));
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'export class A { x: string; y: number; }\nexport class B { x: string; y: number; }\nexport class C { p: string; q: number; r?: boolean; }\n');
    const index = new SourceIndex({ roots: [tmp] });
    index.build();
    expect(index.resolveDtoByShape(['p', 'q', 'r'])?.name).toBe('C');
    expect(index.resolveDtoByShape(['x', 'y'])).toBeUndefined();
    expect(index.resolveDtoByShape(['nope', 'zzz'])).toBeUndefined();
    expect(index.resolveDtoByShape(['x'])).toBeUndefined();
  });
});
