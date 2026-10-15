import type { HandlerInfo } from './handlers';

export interface RateLimit {
  name: string;
  limit: number;
  /** Window in milliseconds. */
  ttlMs: number;
  blockMs?: number;
}

const getMeta = (key: string, target: unknown): unknown =>
  target ? (Reflect as unknown as { getMetadata?: (k: string, t: object) => unknown }).getMetadata?.(key, target as object) : undefined;

/** True when the class or any ancestor is called `ThrottlerGuard` (covers `class MyGuard extends ThrottlerGuard`). */
export function isThrottlerGuard(instance: object): boolean {
  let proto: object | null = Object.getPrototypeOf(instance);
  for (let i = 0; proto && i < 12; i++) {
    if ((proto as { constructor?: { name?: string } }).constructor?.name === 'ThrottlerGuard') return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

interface RawThrottler {
  name?: string;
  limit?: unknown;
  ttl?: unknown;
  blockDuration?: unknown;
}

/** Throttlers configured on a guard instance across @nestjs/throttler v4–v6 option shapes. */
function guardThrottlers(guard: object): { list: RawThrottler[]; legacy: boolean } {
  const g = guard as { throttlers?: unknown; options?: unknown };
  const opts = g.options as { throttlers?: unknown; limit?: unknown; ttl?: unknown } | unknown[] | undefined;
  if (Array.isArray(g.throttlers) && g.throttlers.length) return { list: g.throttlers as RawThrottler[], legacy: false };
  if (Array.isArray(opts)) return { list: opts as RawThrottler[], legacy: false };
  if (opts && Array.isArray((opts as { throttlers?: unknown }).throttlers)) return { list: (opts as { throttlers: RawThrottler[] }).throttlers, legacy: false };
  if (opts && typeof opts === 'object' && ('limit' in opts || 'ttl' in opts)) // @nestjs/throttler v4: flat `{ ttl (seconds), limit }`, metadata keys without a name.
    return { list: [opts as RawThrottler], legacy: true };
  return { list: [], legacy: false };
}

const resolveNum = (v: unknown): number | undefined => {
  try {
    const out = typeof v === 'function' ? (v as (c: unknown) => unknown)({}) : v;
    return typeof out === 'number' && Number.isFinite(out) ? out : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Rate limits that apply to a handler: global throttler config from the
 * applied `ThrottlerGuard`, overridden per name by `@Throttle()` /
 * `@SkipThrottle()` metadata on the controller / handler.
 */
export function rateLimitsFor(info: HandlerInfo, guards: object[]): RateLimit[] {
  const guard = guards.find(isThrottlerGuard);
  if (!guard) return [];
  const { list: configured, legacy } = guardThrottlers(guard);
  const names = new Set<string>(configured.map((t) => t.name ?? 'default'));
  if (names.size === 0) names.add('default');
  // Names used by @Throttle({ short: {...} }) on the route that the guard may not list.
  const out: RateLimit[] = [];
  for (const name of names) {
    const skipKey = `THROTTLER:SKIP${legacy ? '' : name}`;
    const skipHandler = getMeta(skipKey, info.handler);
    const skipClass = getMeta(skipKey, info.controller);
    const skip = skipHandler !== undefined ? skipHandler : skipClass;
    if (skip === true) continue;
    const base = configured.find((t) => (t.name ?? 'default') === name);
    const suffix = legacy ? '' : name;
    const pick = (key: string): unknown => getMeta(`THROTTLER:${key}${suffix}`, info.handler) ?? getMeta(`THROTTLER:${key}${suffix}`, info.controller);
    const unit = legacy ? 1000 : 1;
    const limit = resolveNum(pick('LIMIT')) ?? resolveNum(base?.limit);
    const rawTtl = resolveNum(pick('TTL')) ?? resolveNum(base?.ttl);
    const ttl = rawTtl === undefined ? undefined : rawTtl * unit;
    if (limit === undefined || ttl === undefined) continue;
    const block = resolveNum(pick('BLOCK_DURATION')) ?? resolveNum(base?.blockDuration);
    out.push({ name, limit, ttlMs: ttl, ...(block !== undefined ? { blockMs: block } : {}) });
  }
  return out;
}

export function describeWindow(ms: number): string {
  if (ms % 3600000 === 0) return `${ms / 3600000} hour${ms === 3600000 ? '' : 's'}`;
  if (ms % 60000 === 0) return `${ms / 60000} minute${ms === 60000 ? '' : 's'}`;
  if (ms % 1000 === 0) return `${ms / 1000} second${ms === 1000 ? '' : 's'}`;
  return `${ms} ms`;
}
