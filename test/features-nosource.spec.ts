import 'reflect-metadata';
import { createApp } from './helpers';
import { buildDocument } from '../src';
import { FeaturesModule } from './fixtures/features/features.module';

// No readable sources: runtime metadata alone must still produce sane docs.
describe('without TypeScript sources', () => {
  it('uploads fall back to the route-args kind; nothing throws', async () => {
    const app = await createApp(FeaturesModule);
    const doc: any = buildDocument(app, { logger: false, sources: { roots: ['/nonexistent-dir-xyz'] } });
    const avatar = doc.paths['/things/avatar'].post.requestBody.content['multipart/form-data'].schema.properties;
    expect(avatar.file).toEqual({ type: 'string', format: 'binary' });
    const gallery = doc.paths['/things/gallery'].post.requestBody.content['multipart/form-data'].schema.properties;
    expect(gallery.files.type).toBe('array');
    expect(doc.paths['/things'].get.summary).toBe('List things');
    expect(doc.paths['/things/{id}'].get['x-rate-limit']).toBeDefined();
    await app.close();
  });
});
