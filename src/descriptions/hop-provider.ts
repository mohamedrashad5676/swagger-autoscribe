// Extension points of the call-chain resolver. The core only knows how to
// follow `this.<dependency>.<method>()` and same-class calls; every other way
// a request can travel (RPC, HTTP client, command bus, generic CRUD base…) is
// supplied by a HopProvider. Providers observe source and return hops; they
// never choose wording.

import type { EntityFacts, SchemaProvider } from './entity-facts';
import type { HandlerRef } from './service-chain';
import type { MethodFactAdapter, MethodSourceInfo } from './method-facts';

// Read-only view of the indexed sources handed to providers.
export interface ChainView {
  hasRoot(root: string): boolean;
  isEntryRoot(root: string): boolean;
  classOf(root: string, className: string): { parent?: { name: string }; methods: ReadonlyMap<string, MethodSourceInfo>; superArgs: readonly string[] } | undefined;
  entityOf(root: string, className: string): EntityFacts | undefined;
}

export interface Hop {
  target?: HandlerRef;
  // Evidence flags merged into the chain facts when the hop is taken.
  reachedBackend?: boolean;
  crud?: boolean;
  entity?: EntityFacts;
  // true: the target's own calls are expanded through providers too.
  followCalls?: boolean;
}

export interface HopProvider {
  readonly name: string;
  // Called for every method found while indexing sources.
  indexMethod?(root: string, className: string, methodName: string, info: MethodSourceInfo, view: ChainView): void;
  // Hops leaving a visited method body.
  hopsFromMethod?(at: HandlerRef, info: MethodSourceInfo, view: ChainView): Hop[];
  // Hops attached to a call that resolved to `target`.
  hopsFromCall?(target: HandlerRef, view: ChainView): Hop[];
}

export interface RootSpec {
  name: string;
  dir: string;
  suffixes: string[];
  // Scanned only when no root of this name was indexed already.
  fallback?: boolean;
}

// Everything the resolver needs to know about one project's layout.
export interface ChainProfile {
  entryRoot: string;
  entrySuffixes: string[];
  // Root searched when a class's ancestor is not found in its own root.
  ancestorRoot?: string;
  // Further shared/library roots (workspace libs, local packages).
  ancestorRoots?: string[];
  discoverRoots(entrySrcRoot: string): RootSpec[];
  providers: HopProvider[];
  // Discovery adapters used to read every method (controllers and services).
  methodAdapters: MethodFactAdapter[];
  // Readers turning declared persistent classes into EntityFacts.
  schemaProviders: SchemaProvider[];
}
