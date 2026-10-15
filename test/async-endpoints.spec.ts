import 'reflect-metadata';
import * as path from 'node:path';
import { createApp } from './helpers';
import { buildDocument } from '../src';
import { AsyncModule } from './fixtures/async/async.module';
import { FeaturesModule } from './fixtures/features/features.module';

const roots = [path.join(__dirname, 'fixtures', 'async')];
let doc: any;
let app: any;
beforeAll(async () => {
  app = await createApp(AsyncModule);
  doc = buildDocument(app, { logger: false, sources: { roots } });
});
afterAll(async () => app.close());

describe('WebSocket + microservice handlers', () => {
  it('lists gateway events with namespace, path and typed payload', () => {
    expect(doc['x-websocket']).toEqual([
      {
        gateway: 'ChatGateway',
        namespace: 'chat',
        path: '/ws',
        events: [
          { event: 'message', handler: 'ChatGateway.onMessage', payload: { $ref: '#/components/schemas/ChatMessage' } },
          { event: 'ping', handler: 'ChatGateway.onPing' },
        ],
      },
    ]);
    expect(doc.components.schemas.ChatMessage.properties.text).toBeDefined();
  });
  it('lists message / event / gRPC handlers with their transport', () => {
    const by = Object.fromEntries(doc['x-microservices'].map((h: any) => [h.handler, h]));
    expect(by['OrdersController.get']).toMatchObject({ kind: 'message', pattern: 'orders.get' });
    expect(by['OrdersController.placed']).toMatchObject({ kind: 'event', pattern: 'orders.placed', payload: { $ref: '#/components/schemas/OrderPlaced' } });
    expect(by['OrdersController.find']).toMatchObject({ transport: 'GRPC', grpc: { service: 'OrdersService', rpc: 'Find' } });
  });
  it('HTTP routes are unaffected and the extension is absent when the app has none', async () => {
    expect(Object.keys(doc.paths)).toEqual(['/orders']);
    const plain = await createApp(FeaturesModule);
    const d: any = buildDocument(plain, { logger: false, sources: { roots: [path.join(__dirname, 'fixtures', 'features')] } });
    expect(d['x-websocket']).toBeUndefined();
    expect(d['x-microservices']).toBeUndefined();
    await plain.close();
  });
  it('can be disabled', () => {
    const d: any = buildDocument(app, { logger: false, sources: { roots }, asyncEndpoints: false });
    expect(d['x-websocket']).toBeUndefined();
    expect(d['x-microservices']).toBeUndefined();
  });
});

describe('asyncEndpoints options', () => {
  const b = (o: any): any => buildDocument(app, { logger: false, sources: { roots }, configFile: false, asyncEndpoints: o } as any);
  it('websocket / microservices switched off separately', () => {
    const ws = b({ websocket: false });
    expect(ws['x-websocket']).toBeUndefined();
    expect(ws['x-microservices']).toBeDefined();
    const ms = b({ microservices: false });
    expect(ms['x-websocket']).toBeDefined();
    expect(ms['x-microservices']).toBeUndefined();
  });
  it('extension names can be changed', () => {
    const d = b({ websocket: 'x-ws', microservices: 'x-rpc' });
    expect(d['x-ws']).toBeDefined();
    expect(d['x-rpc']).toBeDefined();
    expect(d['x-websocket']).toBeUndefined();
    expect(d['x-microservices']).toBeUndefined();
  });
});
