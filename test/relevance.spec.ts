import 'reflect-metadata';
import * as path from 'node:path';
import { createApp } from './helpers';
import { buildDocument } from '../src';
import { RelModule } from './fixtures/relevance/relevance.module';

const roots = [path.join(__dirname, 'fixtures', 'relevance')];
let app: any;
beforeAll(async () => {
  app = await createApp(RelModule);
});
afterAll(async () => app.close());
const build = (relevance?: 'all' | 'specific'): any =>
  buildDocument(app, { logger: false, sources: { roots }, errors: relevance ? { relevance } : {} });

describe('errors.relevance', () => {
  it('default keeps every discovered failure', () => {
    const d = build();
    expect(Object.keys(d.paths['/rel/bare'].get.responses)).toContain('503');
  });
  it("'specific' drops a bare, message-less infrastructure failure", () => {
    const d = build('specific');
    expect(Object.keys(d.paths['/rel/bare'].get.responses)).not.toContain('503');
  });
  it("'specific' keeps failures that carry their own message, and conditional ones", () => {
    const r = build('specific').paths['/rel/msg'].get.responses;
    expect(r['503']).toBeDefined();
    expect(r['404']).toBeDefined();
  });
  it("'specific' never removes an explicit @ApiResponse status", () => {
    const r = build('specific').paths['/rel/declared'].get.responses;
    expect(r['502'].description).toContain('Upstream gave up');
  });
  it("'specific' drops unconditional shared-code failures, keeps conditional and direct ones", () => {
    const d = build('specific');
    const t = (p: string): string => JSON.stringify(d.paths[p].get.responses);
    expect(t('/rel/s1')).not.toContain('shared boom');
    expect(t('/rel/s1')).toContain('shared guarded');
    expect(t('/rel/own')).toContain('own direct');
    expect(JSON.stringify(build().paths['/rel/s1'].get.responses)).toContain('shared boom');
  });
  it('sharedThreshold controls what counts as shared', () => {
    const d = buildDocument(app, { logger: false, sources: { roots }, errors: { relevance: 'specific', sharedThreshold: 10 } }) as any;
    expect(JSON.stringify(d.paths['/rel/s1'].get.responses)).toContain('shared boom');
  });
  it('is deterministic', () => {
    expect(JSON.stringify(build('specific'))).toBe(JSON.stringify(build('specific')));
  });
});
