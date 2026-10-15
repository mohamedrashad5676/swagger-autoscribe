// Generic "forwarding base" hop. A class that does not define `method` itself but extends a base class
// forwards the call to a backend service named in its own `super(...)` string literals — the shape of
// shared CRUD gateway bases (`super(clientFactory, 'pkg.share_link', 'recording-service', 'ShareLinksService')`).
//
// Nothing is configured: two of the super-call literals must name an INDEXED root and a class inside it,
// which is only true when the forwarding really exists. Everything else stays untouched.

import type { ChainView, Hop, HopProvider } from '../hop-provider';
import type { HandlerRef } from '../service-chain';

export function forwardingBaseHopProvider(): HopProvider {
  return {
    name: 'forwarding-base',
    hopsFromCall(target: HandlerRef, view: ChainView): Hop[] {
      const cls = view.classOf(target.root, target.className);
      if (!cls?.parent || cls.methods.has(target.methodName) || cls.superArgs.length < 2) return [];
      for (let i = 0; i < cls.superArgs.length; i++) {
        const root = cls.superArgs[i];
        if (!view.hasRoot(root) || view.isEntryRoot(root)) continue;
        for (let j = 0; j < cls.superArgs.length; j++) {
          if (j === i) continue;
          const serviceClass = cls.superArgs[j];
          if (!view.classOf(root, serviceClass)) continue;
          return [
            {
              crud: true,
              reachedBackend: true,
              entity: view.entityOf(root, serviceClass),
              target: { root, className: serviceClass, methodName: target.methodName },
              followCalls: false,
            },
          ];
        }
      }
      return [];
    },
  };
}
