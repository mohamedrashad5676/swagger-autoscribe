import 'reflect-metadata';
import { createApp } from './helpers';
import { buildDocument, setupSwagger } from '../src';
import { AppModule } from './fixtures/app/app.module';

describe('resilience', () => {
  it('no TypeScript sources on disk (prod image): runtime features still work, nothing throws', async () => {
    const app = await createApp(AppModule);
    const doc = buildDocument(app, { logger: false, sources: { roots: ['/definitely/not/here'] } });
    expect(doc.paths['/users/health']).toBeDefined();
    const post = (doc.paths['/users'] as any).post;
    expect(post.security).toEqual([{ bearerAuth: [] }]);
    expect(post.responses['409']).toBeDefined(); // runtime error discovery needs no sources
    await app.close();
  });

  it('every feature can be switched off; disabled setup returns undefined', async () => {
    const app = await createApp(AppModule);
    const doc = buildDocument(app, {
      logger: false, auth: false, pagination: false, dtos: false, requestBodies: false,
      responses: false, examples: false, errors: false,
    });
    expect((doc.paths['/users'] as any).post.responses['409']).toBeUndefined();
    expect(setupSwagger(app, { enabled: false, logger: false })).toBeUndefined();
    await app.close();
  });
});
