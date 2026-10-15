// Normalisation boundary. Each discovery mechanism (typed call graph, runtime
// source scanner, explicit API metadata, framework configuration) keeps its own
// way of finding failures; all of them are turned into the one `Failure` model
// here, before any reachability or relevance decision is made.

import type { RuntimeErrorVariant } from './runtime-errors';
import { detectConflicts, type Assertion, type Conflict } from './conflicts';
import {
  failureFact,
  failureIdentity,
  isGenericFailure,
  isRelevant,
  provablyUnreachable,
  branchBasisOf,
  sealFailure,
  reachOf,
  strengthOf,
  type Discoverer,
  type Failure,
  type ResponseOrigin,
} from './error-reachability';

// Where a discovered failure sits relative to the operation.
export interface DiscoverySite {
  operation?: string;
  depth: number;
  shared: boolean;
  path: string[];
  reachedWhen: string[];
  // Call-site arguments and the callee's parameter names, when known: they let
  // a guard on a literal parameter be proven unreachable.
  args?: string[];
  params?: string[];
}

const KIND_FALLBACK = 'Failure';

// Runtime scanner variant -> Failure.
export function failureFromVariant(
  v: RuntimeErrorVariant,
  at: DiscoverySite,
  origin: ResponseOrigin = 'source-failure',
  discoveredBy: Discoverer = 'runtime-scanner',
): Failure {
  const thrown = { type: v.kind ?? KIND_FALLBACK, status: v.status, ...(v.message ? { message: v.message } : {}), ...(v.when ? { when: v.when } : {}), ...(v.inCatch ? { branch: true } : {}) };
  const strength = strengthOf(v.when, v.inCatch);
  const unreachable = provablyUnreachable(v.when, at.params ?? [], at.args);
  const reach = reachOf({ depth: at.depth, shared: at.shared, generic: isGenericFailure(thrown), known: true, unreachable });
  const condition = { ...(v.when ? { text: v.when } : {}), strength };
  const base = {
    operation: at.operation,
    branchBasis: branchBasisOf(v.when, at.params ?? [], at.args),
    discoveredBy: [discoveredBy],
    origin,
    thrown,
    reach,
    condition,
    consequence: { rejects: true as const, status: v.status },
    path: at.path,
    reachedWhen: at.reachedWhen,
    evidence: [],
    specific: Boolean(v.message || v.schema || v.isTemplate || v.when),
  };
  return sealFailure({ ...base, identity: failureIdentity(base), aliases: [], relevant: isRelevant(reach, strength, at.reachedWhen) });
}

// A status the API declares itself (explicit response metadata). It is a
// consequence with no source throw behind it, and it is never deleted by source analysis.
export function failureFromMetadata(status: number, operation?: string): Failure {
  const base = {
    operation,
    branchBasis: 'independent' as const,
    discoveredBy: ['explicit-metadata'] as Discoverer[],
    origin: 'explicit-api-metadata' as ResponseOrigin,
    thrown: { type: 'DeclaredResponse', status },
    reach: 'direct' as const,
    condition: { strength: 'none' as const },
    consequence: { rejects: true as const, status },
    path: [],
    reachedWhen: [],
    evidence: [],
    specific: true,
  };
  return sealFailure({ ...base, identity: failureIdentity(base), aliases: [], relevant: false });
}

// `(0, mod_1.fn)(x)` is how compiled CommonJS spells a call to an imported
// function; documentation should say `fn(x)`.
const readableCondition = (cond: string): string => cond.replace(/\(0,\s*\w+_\d+\.(\w+)\)/g, '$1');

// Failure -> the response payload a documented entry is built from (used when
// the failure was found by an analyser that does not produce response bodies).
export function variantFromFailure(f: Failure): RuntimeErrorVariant {
  return {
    status: f.consequence.status ?? 500,
    ...(f.thrown.message ? { message: f.thrown.message } : {}),
    ...(f.thrown.when ? { when: readableCondition(f.thrown.when), ...(f.thrown.message ? {} : { condition: readableCondition(f.thrown.when) }) } : {}),
    kind: f.thrown.type,
    failure: f,
  };
}

// A failure as a comparable assertion: for its operation, the failing condition
// leads to this status. A failure that proves nothing about a fact (no status,
// no condition or message to identify it, or shown unreachable) states nothing.
export function assertionOfFailure(f: Failure): Assertion | undefined {
  const fact = failureFact(f);
  if (!fact || f.consequence.status === undefined || f.reach === 'unreachable') return undefined;
  return {
    ...fact,
    cardinality: 'single',
    value: String(f.consequence.status),
    ...(f.thrown.message && f.condition.strength === 'observed' ? { label: f.thrown.message } : {}),
    when: f.reachedWhen,
    confidence: f.confidence,
    source: { origin: f.origin, discoverer: f.discoveredBy.join('+'), path: f.path, evidence: f.evidence },
  };
}

// Disagreements among the failures of one set (order-independent).
export const failureConflicts = (failures: readonly Failure[]): Conflict[] =>
  detectConflicts(failures.flatMap((f) => assertionOfFailure(f) ?? []));
