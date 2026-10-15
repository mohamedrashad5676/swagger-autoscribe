import type { ContainerLike } from './di';

/**
 * WebSocket gateways and microservice handlers (`@SubscribeMessage`,
 * `@MessagePattern`, `@EventPattern`, `@GrpcMethod`) are not HTTP routes, so
 * OpenAPI has no native place for them. They are listed as the vendor
 * extensions `x-websocket` / `x-microservices`, only when the app has any.
 * Everything comes from Nest's own decorator metadata; the packages are never
 * imported (so nothing here requires `@nestjs/websockets` / `@nestjs/microservices`).
 */
export interface AsyncHandler {
  handler: string;
  /** Payload DTO class, when `@MessageBody()` / `@Payload()` is typed with a class. */
  payloadClass?: Function;
}
export interface GatewayInfo {
  gateway: string;
  options: { namespace?: string; path?: string; port?: number };
  events: Array<AsyncHandler & { event: string }>;
}
export interface PatternInfo extends AsyncHandler {
  controller: string;
  transport: string;
  kind: 'message' | 'event';
  pattern: unknown;
  grpc?: { service: string; rpc: string; streaming?: string };
}
export interface AsyncEndpoints {
  gateways: GatewayInfo[];
  patterns: PatternInfo[];
}

const TRANSPORTS = ['TCP', 'REDIS', 'NATS', 'MQTT', 'GRPC', 'RMQ', 'KAFKA'];
const PRIMITIVES = new Set(['Object', 'String', 'Number', 'Boolean', 'Array', 'Date', 'Promise', 'Function']);
const WS_PAYLOAD = '3';
const RPC_PAYLOAD = '3';

const get = (key: string, target: unknown, prop?: string | symbol): unknown => {
  if (!target) return undefined;
  const api = Reflect as unknown as { getMetadata?: (k: string, t: object, p?: string | symbol) => unknown };
  try {
    return prop === undefined ? api.getMetadata?.(key, target as object) : api.getMetadata?.(key, target as object, prop);
  } catch {
    return undefined;
  }
};

function methodNames(proto: object): string[] {
  const out: string[] = [];
  let p: object | null = proto;
  for (let depth = 0; p && p !== Object.prototype && depth < 6; depth++) {
    for (const name of Object.getOwnPropertyNames(p)) {
      if (name === 'constructor' || out.includes(name)) continue;
      const d = Object.getOwnPropertyDescriptor(p, name);
      if (typeof d?.value === 'function') out.push(name);
    }
    p = Object.getPrototypeOf(p);
  }
  return out.sort();
}

function payloadOf(cls: Function, proto: object, method: string, paramtype: string): Function | undefined {
  const args = get('__routeArguments__', cls, method) as Record<string, { index: number; data?: unknown }> | undefined;
  const types = get('design:paramtypes', proto, method) as unknown[] | undefined;
  for (const [key, entry] of Object.entries(args ?? {})) {
    if (key.split(':')[0] !== paramtype || (entry.data !== undefined && entry.data !== null)) continue;
    const t = types?.[entry.index];
    if (typeof t === 'function' && !PRIMITIVES.has(t.name)) return t;
  }
  return undefined;
}

export function collectAsyncEndpoints(container: ContainerLike): AsyncEndpoints | undefined {
  const gateways: GatewayInfo[] = [];
  const patterns: PatternInfo[] = [];
  const seen = new Set<Function>();
  for (const module of container.values()) {
    for (const group of [module.providers, module.controllers]) {
      for (const wrapper of group?.values() ?? []) {
        const cls = (typeof wrapper.metatype === 'function' ? wrapper.metatype : (wrapper.instance as { constructor?: Function } | undefined)?.constructor) as Function | undefined;
        if (!cls || seen.has(cls) || !cls.prototype) continue;
        seen.add(cls);

        if (get('websockets:is_gateway', cls)) {
          const raw = (get('websockets:gateway_options', cls) ?? {}) as Record<string, unknown>;
          const options: GatewayInfo['options'] = {};
          if (typeof raw.namespace === 'string') options.namespace = raw.namespace;
          if (typeof raw.path === 'string') options.path = raw.path;
          const port = get('port', cls);
          if (typeof port === 'number' && port > 0) options.port = port;
          const events: GatewayInfo['events'] = [];
          for (const m of methodNames(cls.prototype)) {
            const fn = (cls.prototype as Record<string, unknown>)[m] as Function;
            if (!get('websockets:message_mapping', fn)) continue;
            const event = get('message', fn);
            if (typeof event !== 'string') continue;
            events.push({ event, handler: `${cls.name}.${m}`, payloadClass: payloadOf(cls, cls.prototype, m, WS_PAYLOAD) });
          }
          if (events.length) gateways.push({ gateway: cls.name, options, events });
        }

        for (const m of methodNames(cls.prototype)) {
          const fn = (cls.prototype as Record<string, unknown>)[m] as Function;
          const list = get('microservices:pattern', fn);
          if (!Array.isArray(list) || list.length === 0) continue;
          const handlerType = get('microservices:handler_type', fn);
          const transportRaw = get('microservices:transport', fn);
          const transport = typeof transportRaw === 'number' ? (TRANSPORTS[transportRaw] ?? String(transportRaw)) : 'any';
          for (const pattern of list) {
            const isGrpc = transport === 'GRPC' && pattern && typeof pattern === 'object' && 'service' in (pattern as object);
            patterns.push({
              controller: cls.name,
              handler: `${cls.name}.${m}`,
              transport,
              kind: handlerType === 2 ? 'event' : 'message',
              pattern: isGrpc ? undefined : pattern,
              ...(isGrpc
                ? { grpc: { service: String((pattern as any).service), rpc: String((pattern as any).rpc), ...((pattern as any).streaming ? { streaming: String((pattern as any).streaming) } : {}) } }
                : {}),
              payloadClass: payloadOf(cls, cls.prototype, m, RPC_PAYLOAD),
            });
          }
        }
      }
    }
  }
  gateways.sort((a, b) => a.gateway.localeCompare(b.gateway));
  patterns.sort((a, b) => a.handler.localeCompare(b.handler) || String(JSON.stringify(a.pattern)).localeCompare(String(JSON.stringify(b.pattern))));
  return gateways.length || patterns.length ? { gateways, patterns } : undefined;
}
