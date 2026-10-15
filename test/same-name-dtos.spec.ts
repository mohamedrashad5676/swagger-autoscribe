import 'reflect-metadata';
import * as path from 'path';
import { Module } from '@nestjs/common';
import { createApp } from './helpers';
import { buildDocument } from '../src';
import { ItemsModule as A } from './fixtures/collide/a/items';
import { ItemsModule as B } from './fixtures/collide/b/items';

@Module({ imports: [A, B] })
class CollideModule {}

describe('two DTO classes with the same name in different modules', () => {
  it('each request body gets its own schema with its own properties', async () => {
    const app = await createApp(CollideModule);
    const doc: any = buildDocument(app, { logger: false, sources: { roots: [path.join(__dirname, 'fixtures', 'collide')] } });
    const s = doc.components.schemas;
    const body = (p: string) => doc.paths[p].post.requestBody.content['application/json'].schema.$ref;
    expect(body('/a-items')).toBe('#/components/schemas/CreateItemDto');
    expect(body('/b-items')).toBe('#/components/schemas/CreateItemDto2');
    expect(Object.keys(s.CreateItemDto.properties).sort()).toEqual(['name', 'weight']);
    expect(Object.keys(s.CreateItemDto2.properties).sort()).toEqual(['label', 'name']);
    // responses (interfaces with the same name) are separated too
    const ok = (p: string) => doc.paths[p].post.responses['201'].content['application/json'].schema.$ref.split('/').pop();
    expect(Object.keys(s[ok('/a-items')].properties)).toContain('weight');
    expect(Object.keys(s[ok('/b-items')].properties)).toContain('label');
    await app.close();
  });
});
