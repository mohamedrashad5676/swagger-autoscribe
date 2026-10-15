import type { INestApplication } from '@nestjs/common';
import type { ProviderLookup } from './di';
import type { HandlerInfo } from './handlers';

type Kind = 'guards' | 'filters' | 'interceptors';
type WrapperLike = { instance?: unknown; metatype?: unknown };

interface AppConfigLike {
  getGlobalGuards?: () => unknown[];
  getGlobalFilters?: () => unknown[];
  getGlobalInterceptors?: () => unknown[];
  getGlobalRequestGuards?: () => WrapperLike[];
  getGlobalRequestFilters?: () => WrapperLike[];
  getGlobalRequestInterceptors?: () => WrapperLike[];
}

/**
 * Which guards / filters / interceptors are REALLY applied to a route:
 * global ones (APP_*, `useGlobal*`) plus `@UseX()` on the controller and the
 * handler. Ordered outermost first (global, controller, handler).
 */
export class EnhancerResolver {
  private readonly config: AppConfigLike;

  constructor(
    app: INestApplication,
    private readonly lookup: ProviderLookup,
  ) {
    this.config = ((app as unknown as { config?: AppConfigLike }).config ?? {}) as AppConfigLike;
  }

  applied(kind: Kind, info: HandlerInfo): object[] {
    const seen = new Set<unknown>();
    const out: object[] = [];
    const add = (candidate: unknown): void => {
      if (!candidate) return;
      const instance =
        typeof candidate === 'function' ? this.lookup.instanceOfClass(candidate as Function) : (candidate as object);
      if (typeof instance !== 'object') return;
      const key = (instance as { constructor?: unknown }).constructor ?? instance;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(instance);
    };
    for (const g of this.global(kind)) add(g);
    for (const e of info.enhancers[kind]) add(e);
    return out;
  }

  global(kind: Kind): unknown[] {
    const c = this.config;
    const fromWrapper = (w: WrapperLike): unknown =>
      w.instance ?? (typeof w.metatype === 'function' ? this.lookup.instanceOfClass(w.metatype as Function) : undefined);
    try {
      if (kind === 'guards') return [...(c.getGlobalGuards?.() ?? []), ...(c.getGlobalRequestGuards?.() ?? []).map(fromWrapper)];
      if (kind === 'filters') return [...(c.getGlobalFilters?.() ?? []), ...(c.getGlobalRequestFilters?.() ?? []).map(fromWrapper)];
      return [...(c.getGlobalInterceptors?.() ?? []), ...(c.getGlobalRequestInterceptors?.() ?? []).map(fromWrapper)];
    } catch {
      return [];
    }
  }
}
