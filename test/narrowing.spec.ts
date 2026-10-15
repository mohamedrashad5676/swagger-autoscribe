import 'reflect-metadata';
import * as path from 'node:path';
import { createApp } from './helpers';
import { buildDocument } from '../src';
import { NarrowModule } from './fixtures/narrowing/narrowing.module';

let app: any;
let doc: any;
beforeAll(async () => {
  app = await createApp(NarrowModule);
  doc = buildDocument(app, { logger: false, sources: { roots: [path.join(__dirname, 'fixtures', 'narrowing')] } });
});
afterAll(async () => app.close());
const statuses = (p: string): string[] => Object.keys(doc.paths[p].get.responses).filter((s) => /^[45]/.test(s)).sort();
const text = (p: string): string => JSON.stringify(doc.paths[p].get.responses);

describe('literal call-site narrowing', () => {
  it('module helper called with a literal documents only the failure that literal reaches', () => {
    expect(statuses('/n/a')).toEqual(expect.arrayContaining(['404']));
    expect(statuses('/n/a')).not.toContain('409');
    expect(text('/n/a')).toContain('A missing');
    expect(text('/n/a')).not.toContain('B conflict');
  });
  it('service method called with a literal', () => {
    expect(statuses('/n/b')).toContain('409');
    expect(statuses('/n/b')).not.toContain('404');
    expect(text('/n/b')).toContain('svc B');
    // the unconditional fallthrough is still reachable
    expect(statuses('/n/b')).toContain('400');
  });
  it('two literal calls keep both failures', () => {
    expect(statuses('/n/both')).toEqual(expect.arrayContaining(['404', '409']));
  });
  it('a non-literal argument proves nothing: all failures stay', () => {
    expect(statuses('/n/unknown')).toEqual(expect.arrayContaining(['404', '409']));
  });
  it('literals propagate through a relaying helper', () => {
    expect(statuses('/n/relay')).toContain('409');
    expect(statuses('/n/relay')).not.toContain('404');
  });
  it('a parameter reassigned in the body is never narrowed', () => {
    expect(statuses('/n/reassigned')).toContain('403');
  });
  it('boolean literals', () => {
    expect(statuses('/n/flag')).not.toContain('403');
    expect(statuses('/n/flagon')).toContain('403');
  });
  it('a call guarded by an if is skipped when the literals make the guard false', () => {
    expect(statuses('/n/gated-off')).not.toContain('404');
    expect(statuses('/n/gated-on')).toContain('404');
  });
  it('parenthesised / negated conditions are evaluated', () => {
    expect(text('/n/complex-hit')).toContain('complex hit');
    expect(text('/n/complex-miss')).not.toContain('complex hit');
  });
  it('is deterministic', () => {
    const again = buildDocument(app, { logger: false, sources: { roots: [path.join(__dirname, 'fixtures', 'narrowing')] } });
    expect(JSON.stringify(again)).toBe(JSON.stringify(doc));
  });
});
