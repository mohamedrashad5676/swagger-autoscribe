import * as fs from 'fs';
import * as path from 'path';
import { ModuleIndex } from '../src/errors/module-index';

// Native-ESM hosts have no require.cache entry for app modules: classes are located by their own source text.
describe('ModuleIndex text locator (ESM hosts)', () => {
  const dir = path.join(__dirname, 'tmp-locator');
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('finds the file of a class that is not in require.cache', () => {
    fs.mkdirSync(dir, { recursive: true });
    const code = 'class EsmOnlyService { find(id) { if (!id) { throw new Error("missing"); } return id; } }';
    const file = path.join(dir, 'esm-only.js');
    fs.writeFileSync(file, `${code}\nexport { EsmOnlyService };\n`);
    const ctor = new Function(`${code}; return EsmOnlyService;`)() as Function; // same text, never require()d
    expect(new ModuleIndex().fileOf(ctor)).toBe(file);
  });

  it('finds `var A = class B {}` by either name (bundler output)', () => {
    fs.mkdirSync(dir, { recursive: true });
    const code = 'var Orig = class Renamed2 { go() { return "bundle-only-marker"; } }';
    const file = path.join(dir, 'bundle.mjs.js');
    fs.writeFileSync(file, `${code};\n`);
    const ctor = new Function(`${code}; return Orig;`)() as Function; // ctor.name === 'Renamed2'
    expect(ctor.name).toBe('Renamed2');
    expect(new ModuleIndex().fileOf(ctor)).toBe(file);
  });

  it('returns undefined (fail closed) for unknown / native classes', () => {
    const idx = new ModuleIndex();
    expect(idx.fileOf(Map)).toBeUndefined();
    expect(idx.fileOf(new Function('return class Nowhere { x() { return 1234567; } }')() as Function)).toBeUndefined();
  });
});

describe('ModuleIndex text locator limits and platform paths', () => {
  const dir2 = path.join(__dirname, 'tmp-locator2');
  afterAll(() => fs.rmSync(dir2, { recursive: true, force: true }));

  it('reports when the search was cut short instead of failing silently', () => {
    fs.mkdirSync(dir2, { recursive: true });
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir2, `f${i}.js`), `class Svc${i} { run() { return ${i}; } }\n`);
    fs.writeFileSync(path.join(dir2, 'big.js'), 'class Big { run() {} }\n' + '/*' + 'x'.repeat(5000) + '*/');
    const idx = new ModuleIndex({ roots: [dir2], maxFiles: 5, maxBytes: 2000 });
    const ctor = new Function('class Svc99 { run() { return 99; } }; return Svc99;')() as Function;
    idx.fileOf(ctor);
    const note = idx.searchLimitNote();
    expect(note).toMatch(/stopped after 5 files/);
    const complete = new ModuleIndex({ roots: [dir2] });
    complete.fileOf(ctor);
    expect(complete.searchLimitNote()).toBeUndefined();
  });
});

describe('Windows-style paths', () => {
  const { SourceIndex } = require('../src/source/source-index');
  const { isInNodeModules, toPosix, stripSourceExt } = require('../src/fs-utils');
  it('path helpers treat backslashes like slashes', () => {
    expect(isInNodeModules('C:\\proj\\node_modules\\@nestjs\\core\\index.js')).toBe(true);
    expect(isInNodeModules('C:\\proj\\src\\app.ts')).toBe(false);
    expect(toPosix('C:\\proj\\src\\app.ts')).toBe('C:/proj/src/app.ts');
    expect(stripSourceExt('C:\\proj\\src\\app.ts')).toMatch(/app$/);
  });
  it('resolve() ranks candidates by trailing path even when the runtime hint uses backslashes', () => {
    const os = require('os');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'win-'));
    for (const m of ['a', 'b']) {
      fs.mkdirSync(path.join(d, m), { recursive: true });
      fs.writeFileSync(path.join(d, m, 'items.ts'), 'export class ItemsController {}\n');
    }
    const idx = new SourceIndex({ roots: [d] });
    idx.build();
    expect(idx.resolve('ItemsController', 'C:\\x\\dist\\b\\items.js')).toBe(path.join(d, 'b', 'items.ts'));
    expect(idx.resolve('ItemsController', 'C:\\x\\dist\\a\\items.js')).toBe(path.join(d, 'a', 'items.ts'));
    fs.rmSync(d, { recursive: true, force: true });
  });
});
