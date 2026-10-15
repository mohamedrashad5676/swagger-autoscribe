import { matchParen, splitTopLevel } from '../errors/text-utils';

/** Minimal structural views of Nest's internal container (stable across v9–v11). */
interface WrapperLike {
  instance?: unknown;
  metatype?: unknown;
  token?: unknown;
  name?: unknown;
}
interface ModuleLike {
  metatype?: Function;
  controllers?: Map<unknown, WrapperLike>;
  providers?: Map<unknown, WrapperLike>;
  injectables?: Map<unknown, WrapperLike>;
}
export interface ContainerLike {
  values(): IterableIterator<ModuleLike>;
  applicationId?: string;
}

const getMeta = (key: string, target: object): unknown =>
  (Reflect as unknown as { getMetadata?: (k: string, t: object) => unknown }).getMetadata?.(key, target);

/**
 * Looks up live provider instances in Nest's module container: by class and
 * by injection token. Used to (a) turn the classes listed in `@UseGuards()` /
 * `@UseFilters()` / `@UseInterceptors()` into scannable instances and (b)
 * resolve `this.service` for request-/transient-scoped classes, whose
 * constructor never ran on the object Nest exposes.
 */
export class ProviderLookup {
  private readonly byMetatype = new Map<Function, object>();
  private readonly byToken = new Map<unknown, object>();
  private readonly modulePaths = new Map<Function, unknown>();

  constructor(private readonly container: ContainerLike) {
    for (const module of container.values()) {
      for (const group of [module.providers, module.injectables, module.controllers]) {
        if (!group) continue;
        for (const [token, wrapper] of group.entries()) {
          const instance = wrapper?.instance;
          if (!instance || typeof instance !== 'object') continue;
          if (!this.byToken.has(token)) this.byToken.set(token, instance as object);
          if (typeof wrapper.metatype === 'function' && !this.byMetatype.has(wrapper.metatype as Function)) {
            this.byMetatype.set(wrapper.metatype as Function, instance as object);
          }
        }
      }
    }
  }

  /**
   * A scannable instance for `cls`: the registered one if any, otherwise a
   * prototype-only placeholder (enough — scanning only needs method sources).
   */
  instanceOfClass(cls: Function): object {
    return this.byMetatype.get(cls) ?? Object.create(cls.prototype);
  }

  instanceOfToken(token: unknown): object | undefined {
    if (typeof token === 'function') {
      const direct = this.byMetatype.get(token) ?? this.byToken.get(token);
      if (direct) return direct;
      return undefined;
    }
    return this.byToken.get(token);
  }

  /** `this.<prop>` for a class whose constructor never ran on the inspected object. */
  resolveInjected = (ctor: Function, prop: string): object | undefined => {
    for (let c: Function | null = ctor; c && c !== Function.prototype; c = Object.getPrototypeOf(c) as Function | null) {
      const names = constructorParamNames(c);
      const idx = names.indexOf(prop);
      if (idx < 0) continue;
      const selfDeclared = getMeta('self:paramtypes', c) as Array<{ index: number; param: unknown }> | undefined;
      const token = selfDeclared?.find((d) => d.index === idx)?.param;
      const types = getMeta('design:paramtypes', c) as unknown[] | undefined;
      const target = token ?? types?.[idx];
      if (target === undefined) return undefined;
      return this.instanceOfToken(target);
    }
    return undefined;
  };

  /** `RouterModule`-registered path of the module owning a controller, if any. */
  modulePathOf(moduleCtor: Function | undefined): unknown {
    if (!moduleCtor) return undefined;
    if (this.modulePaths.has(moduleCtor)) return this.modulePaths.get(moduleCtor);
    const appId = this.container.applicationId ?? '';
    const value = getMeta(`__module_path__${appId}`, moduleCtor) ?? getMeta('__module_path__', moduleCtor);
    this.modulePaths.set(moduleCtor, value);
    return value;
  }
}

// Constructor parameter names of a class, read from its source
// (`constructor(private readonly svc: Foo, bar = 1)` -> ['svc', 'bar']).
// Compiled parameter properties keep the same identifier as the property.
const ctorNameCache = new WeakMap<Function, string[]>();
export function constructorParamNames(ctor: Function): string[] {
  const hit = ctorNameCache.get(ctor);
  if (hit) return hit;
  let names: string[] = [];
  try {
    const src = Function.prototype.toString.call(ctor);
    const m = /\bconstructor\s*\(/.exec(src);
    if (m) {
      const open = m.index + m[0].length - 1;
      const close = matchParen(src, open);
      if (close > open) {
        names = splitTopLevel(src.slice(open + 1, close))
          .map((p) =>
            p
              .replace(/^\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*/, '')
              .replace(/^\s*(?:public|private|protected|readonly)\s+/, '')
              .replace(/^\s*(?:public|private|protected|readonly)\s+/, '')
              .split(/[:=?\s]/)[0]
              .trim(),
          )
          .filter(Boolean);
      }
    }
  } catch {
    names = [];
  }
  ctorNameCache.set(ctor, names);
  return names;
}
