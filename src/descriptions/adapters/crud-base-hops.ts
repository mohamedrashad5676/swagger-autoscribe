// Generic CRUD base hop: a service extending `baseClass` and not overriding
// `method` forwards to the backend service named by two of its `super(...)`
// string literals (by position).

import type { ChainView, Hop, HopProvider } from '../hop-provider';
import type { HandlerRef } from '../service-chain';

export function crudBaseHopProvider(options: { baseClass: string; rootArg: number; classArg: number }): HopProvider {
  return {
    name: 'crud-base',
    hopsFromCall(target: HandlerRef, view: ChainView): Hop[] {
      const cls = view.classOf(target.root, target.className);
      if (cls?.parent?.name !== options.baseClass || cls.methods.has(target.methodName)) return [];
      const root = cls.superArgs[options.rootArg];
      const serviceClass = cls.superArgs[options.classArg];
      if (!root || !serviceClass || !view.hasRoot(root)) return [];
      return [
        {
          crud: true,
          reachedBackend: true,
          entity: view.entityOf(root, serviceClass),
          target: { root, className: serviceClass, methodName: target.methodName },
          followCalls: false,
        },
      ];
    },
  };
}
