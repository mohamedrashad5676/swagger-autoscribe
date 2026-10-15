// RPC hop: a call `client.<Rpc>` leaves the entry root and lands on the one
// handler class method registered under that rpc name. Ambiguous names are
// skipped rather than guessed.

import type { ChainView, Hop, HopProvider } from '../hop-provider';
import type { HandlerRef } from '../service-chain';
import type { MethodSourceInfo } from '../method-facts';

export function rpcHopProvider(options: { ignoreCallersOf?: string[] } = {}): HopProvider {
  const handlers = new Map<string, HandlerRef[]>();
  return {
    name: 'rpc',
    indexMethod(root: string, className: string, methodName: string, info: MethodSourceInfo, view: ChainView): void {
      if (!info.handlesRpc || view.isEntryRoot(root)) return;
      const refs = handlers.get(info.handlesRpc) ?? [];
      refs.push({ root, className, methodName });
      handlers.set(info.handlesRpc, refs);
    },
    hopsFromMethod(at: HandlerRef, info: MethodSourceInfo): Hop[] {
      const hops: Hop[] = [];
      for (const rpc of info.rpcCalls) {
        // Generic names shared by every resource are bridged by other providers.
        if (options.ignoreCallersOf?.includes(at.className)) continue;
        const refs = handlers.get(rpc);
        if (refs?.length !== 1) continue;
        hops.push({ target: refs[0], reachedBackend: true, followCalls: true });
      }
      return hops;
    },
  };
}
