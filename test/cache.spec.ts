import 'reflect-metadata';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createApp } from './helpers';
import { buildDocument } from '../src';
import { FeaturesModule } from './fixtures/features/features.module';

let app: any;
let tmp: string;
let roots: string[];
beforeAll(async () => {
  app = await createApp(FeaturesModule);
});
afterAll(async () => app.close());
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autodoc-cache-'));
  const src = path.join(tmp, 'src');
  fs.mkdirSync(src);
  fs.copyFileSync(path.join(__dirname, 'fixtures/features/features.module.ts'), path.join(src, 'features.module.ts'));
  roots = [src];
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const dir = (): string => path.join(tmp, 'cache');
const files = (): string[] => (fs.existsSync(dir()) ? fs.readdirSync(dir()).filter((f) => f.endsWith('.json')) : []);
const build = (extra: object = {}): any => buildDocument(app, { logger: false, sources: { roots, cwd: tmp }, cache: { dir: dir() }, ...extra });

describe('analysis cache', () => {
  it('is off by default', () => {
    buildDocument(app, { logger: false, sources: { roots, cwd: tmp } });
    expect(files()).toEqual([]);
  });
  it('first build writes, second build returns the identical document without re-analysing', () => {
    const first = build();
    expect(files()).toHaveLength(1);
    // Poison the stored file: if the 2nd build really reads the cache we see the marker.
    const f = path.join(dir(), files()[0]);
    const stored = JSON.parse(fs.readFileSync(f, 'utf8'));
    expect(stored).toEqual(JSON.parse(JSON.stringify(first)));
    stored['x-from-cache'] = true;
    fs.writeFileSync(f, JSON.stringify(stored));
    expect(build()['x-from-cache']).toBe(true);
  });
  it('a changed option is a miss', () => {
    build();
    const d = build({ summaries: false });
    expect(files()).toHaveLength(2);
    expect(d['x-from-cache']).toBeUndefined();
    expect(d.paths['/things'].get.summary).toBeUndefined();
  });
  it('a changed source file is a miss', () => {
    build();
    const file = path.join(roots[0], 'features.module.ts');
    fs.appendFileSync(file, '\n// edit\n');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    build();
    expect(files()).toHaveLength(2);
  });
  it('a changed SWAGGER_* env var is a miss', () => {
    build();
    process.env.SWAGGER_EXCLUDE_ENDPOINTS = 'ThingsController.own';
    try {
      const d = build();
      expect(files()).toHaveLength(2);
      expect(d.paths['/things/custom/own']).toBeUndefined();
    } finally {
      delete process.env.SWAGGER_EXCLUDE_ENDPOINTS;
    }
  });
  it('a function option changes the key through its source text', () => {
    build({ summaries: { generate: () => 'a' } });
    build({ summaries: { generate: () => 'b' } });
    expect(files()).toHaveLength(2);
  });
  it('a corrupt cache file is ignored and rewritten', () => {
    build();
    const f = path.join(dir(), files()[0]);
    fs.writeFileSync(f, '{not json');
    const d = build();
    expect(d.paths['/things']).toBeDefined();
    expect(() => JSON.parse(fs.readFileSync(f, 'utf8'))).not.toThrow();
  });
  it('an unwritable cache dir never breaks the build', () => {
    const blocker = path.join(tmp, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const d = buildDocument(app, { logger: false, sources: { roots, cwd: tmp }, cache: { dir: path.join(blocker, 'sub') } });
    expect(d.paths['/things']).toBeDefined();
  });
  it('keeps at most 5 documents', () => {
    for (let i = 0; i < 8; i++) build({ summaries: { generate: () => `v${i}` } });
    expect(files().length).toBeLessThanOrEqual(5);
  });
});
