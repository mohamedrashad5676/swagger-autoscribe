import type { HandlerInfo } from './handlers';
import type { RateLimit } from './throttle';
import { describeWindow } from './throttle';

const getMeta = (key: string, target: unknown): unknown =>
  target ? (Reflect as unknown as { getMetadata?: (k: string, t: object) => unknown }).getMetadata?.(key, target as object) : undefined;

/** True when the class, or any class it extends, is called `name`. */
export function extendsNamed(instance: object, name: string): boolean {
  let proto: object | null = Object.getPrototypeOf(instance);
  for (let i = 0; proto && i < 12; i++) {
    if ((proto as { constructor?: { name?: string } }).constructor?.name === name) return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

export interface CacheBehavior {
  /** Time to live in milliseconds, when `@CacheTTL()` set one on the route. */
  ttlMs?: number;
  /** Fixed key from `@CacheKey()`. */
  key?: string;
}

function moduleInstalled(name: string): boolean {
  try {
    require.resolve(name, { paths: [process.cwd()] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Response caching of a route: `CacheInterceptor` (global, controller or handler) plus the optional
 * `@CacheTTL()` / `@CacheKey()` metadata. `@nestjs/cache-manager` counts the TTL in milliseconds,
 * the older `@nestjs/common` cache in seconds; `ttlUnit` overrides the guess.
 */
export function cacheFor(info: HandlerInfo, interceptors: object[], ttlUnit?: 'ms' | 's'): CacheBehavior | undefined {
  if (!interceptors.some((i) => extendsNamed(i, 'CacheInterceptor') || i.constructor?.name === 'CacheInterceptor')) return undefined;
  const pick = (key: string): unknown => getMeta(key, info.handler) ?? getMeta(key, info.controller);
  const rawTtl = pick('cache_module:cache_ttl');
  const ttl = typeof rawTtl === 'function' ? safe(() => (rawTtl as (c: unknown) => unknown)({})) : rawTtl;
  const key = pick('cache_module:cache_key');
  const unit = ttlUnit ?? (moduleInstalled('@nestjs/cache-manager') ? 'ms' : 's');
  const out: CacheBehavior = {};
  if (typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0) out.ttlMs = unit === 's' ? ttl * 1000 : ttl;
  if (typeof key === 'string' && key) out.key = key;
  return out;
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

export interface BehaviorFacts {
  permissions: string[];
  rateLimits: RateLimit[];
  cache?: CacheBehavior;
  guards: string[];
}

export function behaviorLines(f: BehaviorFacts, opts: { guards?: boolean } = {}): string[] {
  const lines: string[] = [];
  if (f.permissions.length > 0) lines.push(`**Permissions.** Requires ${f.permissions.map((p) => `\`${p}\``).join(', ')}.`);
  if (f.rateLimits.length > 0) {
    const text = f.rateLimits
      .map((l) => `${l.limit} request${l.limit === 1 ? '' : 's'} per ${describeWindow(l.ttlMs)}${l.blockMs ? ` (blocked for ${describeWindow(l.blockMs)} when exceeded)` : ''}`)
      .join(', ');
    lines.push(`**Rate limit.** ${text}. Over the limit the API answers \`429\` with a \`Retry-After\` header.`);
  }
  if (f.cache) {
    const ttl = f.cache.ttlMs ? ` for ${describeWindow(f.cache.ttlMs)}` : '';
    lines.push(`**Caching.** Successful responses are cached${ttl}${f.cache.key ? ` under the key \`${f.cache.key}\`` : ''}, so a repeat call can return slightly old data.`);
  }
  if (opts.guards && f.guards.length > 0) lines.push(`**Guards.** ${f.guards.map((g) => `\`${g}\``).join(', ')}.`);
  return lines;
}
