import 'reflect-metadata';
// Simulates TypeScript 7+ (native port): the module exists but has no JS compiler API.
jest.mock('typescript', () => ({ version: '7.0.2' }));
jest.mock('typescript-fallback', () => { throw new Error('not installed'); });
import { createApp } from './helpers';
import { buildDocument } from '../src';
import { AppModule } from './fixtures/app/app.module';

describe('TypeScript 7 (no compiler API and no bundled fallback)', () => {
  it('degrades gracefully: runtime features work, nothing throws', async () => {
    const app = await createApp(AppModule);
    const doc = buildDocument(app, { logger: false });
    const post = (doc.paths['/users'] as any).post;
    expect(post.security).toEqual([{ bearerAuth: [] }]);
    expect(post.responses['409']).toBeDefined();
    await app.close();
  });
});
