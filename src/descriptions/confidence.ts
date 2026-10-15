// Confidence model. Evidence says WHERE a fact was observed; confidence says
// HOW STRONGLY the source proves it. It belongs to semantic facts (failures,
// claims), never to prose, and never replaces provenance: every Confidence is
// a function of facts that stay attached to the thing it describes.
//
// Dimensions
//   tier           what kind of evidence: A explicit / directly observed,
//                  B strong structural, C indirect (meaning inferred from a
//                  observed call), D weak inference (names, conventions)
//   directness     direct (the operation's own code) | indirect (reached
//                  through calls) | inferred (no source path)
//   evidenceStrength  strong | moderate | weak
//   scope          does the evidence definitely belong to this operation?
//                  operation-local | operation-reachable |
//                  shared-but-conditioned | uncertain
//   level          the conservative conclusion: high | medium | low
//
// Level rules (one place, no scores):
//   tier D, or scope uncertain, or no source path          -> low
//   tier C                                                 -> medium
//   tier A/B, direct and operation-local                   -> high
//   tier A/B, indirect or conditioned or shared            -> medium
//   (shared code with no condition is only in scope when the path to it is
//   statically resolved and unbranched; failures, being branches, are not)
//   corroboration: the same fact found by two INDEPENDENT analysers lifts a
//   strong, in-scope `medium` to `high`. Repeating weak or indirect clues
//   never raises a level: the level is the strongest single observation.
//
// Propagation through a call path: each hop a failure/effect is reached
// through makes it indirect (one level below direct); a hop that is guarded by
// a call-site condition keeps the fact conditioned; shared code without any
// condition tying it to the operation has uncertain scope.

import type { Evidence } from './evidence';
import { EVIDENCE } from './evidence';

export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type EvidenceTier = 'A' | 'B' | 'C' | 'D';
export type Directness = 'direct' | 'indirect' | 'inferred';
export type EvidenceStrength = 'strong' | 'moderate' | 'weak';
export type ScopeCertainty = 'operation-local' | 'operation-reachable' | 'shared-but-conditioned' | 'uncertain';

export interface Confidence {
  level: ConfidenceLevel;
  tier: EvidenceTier;
  directness: Directness;
  evidenceStrength: EvidenceStrength;
  scope: ScopeCertainty;
  // Independent supporting observations.
  support: number;
  // Why the level is what it is (stable, human-readable, for diagnostics/tests).
  reasons: string[];
}

const LEVEL_RANK: ConfidenceLevel[] = ['high', 'medium', 'low'];
export const meets = (c: Pick<Confidence, 'level'>, min: ConfidenceLevel): boolean => LEVEL_RANK.indexOf(c.level) <= LEVEL_RANK.indexOf(min);
export const strongestLevel = (levels: readonly ConfidenceLevel[]): ConfidenceLevel =>
  levels.length === 0 ? 'low' : levels.slice().sort((a, b) => LEVEL_RANK.indexOf(a) - LEVEL_RANK.indexOf(b))[0];

// Tier by what an evidence kind observes. Kinds are generic; an unknown kind is
// treated as weak inference.
const TIER_BY_KIND: Record<string, EvidenceTier> = {
  [EVIDENCE.throws]: 'A',
  [EVIDENCE.guard]: 'A',
  [EVIDENCE.actorUse]: 'A',
  [EVIDENCE.actorBoundProperty]: 'A',
  [EVIDENCE.persistenceWrite]: 'A',
  [EVIDENCE.mergeInput]: 'A',
  [EVIDENCE.softDeleteFilter]: 'A',
  [EVIDENCE.eventEmit]: 'A',
  [EVIDENCE.auditRecord]: 'A',
  [EVIDENCE.entityDeclaration]: 'A',
  [EVIDENCE.entityField]: 'A',
  [EVIDENCE.entityRelation]: 'A',
  [EVIDENCE.rpcCall]: 'B',
  [EVIDENCE.jsdoc]: 'B',
  // A call is observed; what it MEANS comes from the callee's name.
  [EVIDENCE.serviceCall]: 'C',
  [EVIDENCE.plainCall]: 'C',
  [EVIDENCE.sameClassCall]: 'C',
  [EVIDENCE.idempotenceMarker]: 'C',
};
export const tierOfKind = (kind: string): EvidenceTier => TIER_BY_KIND[kind] ?? 'D';

// Where an observation sits relative to the operation.
export interface ObservationContext {
  // Calls between the handler and the observation (0 = the handler itself).
  depth: number;
  shared: boolean;
  // Branch conditions observed at call sites on the path.
  conditioned: boolean;
  // Resolves to nothing in source (only inferred).
  unresolved?: boolean;
  // Reached through a statically resolved call/inheritance path with no
  // branch on the way: shared code is then the operation's own behaviour.
  // (A failure is a branch of its own, so failures never claim this.)
  resolved?: boolean;
}

export interface Observation extends ObservationContext {
  tier: EvidenceTier;
}

export function scopeOf(c: ObservationContext): ScopeCertainty {
  if (c.unresolved) return 'uncertain';
  if (c.shared) return c.conditioned ? 'shared-but-conditioned' : c.resolved ? 'operation-reachable' : 'uncertain';
  return c.depth === 0 ? 'operation-local' : 'operation-reachable';
}

const STRENGTH: Record<EvidenceTier, EvidenceStrength> = { A: 'strong', B: 'strong', C: 'moderate', D: 'weak' };

function levelOf(o: Observation, scope: ScopeCertainty): { level: ConfidenceLevel; reason: string } {
  if (o.tier === 'D') return { level: 'low', reason: 'weak inference (names or conventions) cannot support a strong claim' };
  if (scope === 'uncertain') return { level: 'low', reason: 'nothing ties the evidence to this operation' };
  if (o.tier === 'C') return { level: 'medium', reason: 'meaning is inferred from an observed call' };
  if (o.depth === 0 && scope === 'operation-local') return { level: 'high', reason: 'observed in the operation itself' };
  return { level: 'medium', reason: o.shared ? 'shared code, tied to the operation by a condition' : 'reached through calls (indirect)' };
}

// Confidence of one fact from the observations that support it. The level is
// the strongest single observation: agreement between weak or indirect clues
// never escalates it. `independent` = analysers that found it separately.
export function assess(observations: readonly Observation[], independent = 1): Confidence {
  if (observations.length === 0) {
    return { level: 'low', tier: 'D', directness: 'inferred', evidenceStrength: 'weak', scope: 'uncertain', support: 0, reasons: ['no source observation'] };
  }
  const scored = observations
    .map((o) => {
      const scope = scopeOf(o);
      return { o, scope, ...levelOf(o, scope) };
    })
    .sort((a, b) => LEVEL_RANK.indexOf(a.level) - LEVEL_RANK.indexOf(b.level) || a.o.depth - b.o.depth || a.o.tier.localeCompare(b.o.tier));
  const best = scored[0];
  let level = best.level;
  const reasons = [best.reason];
  if (level === 'medium' && independent >= 2 && STRENGTH[best.o.tier] === 'strong' && best.scope !== 'uncertain') {
    level = 'high';
    reasons.push('found independently by two analysers');
  }
  return {
    level,
    tier: best.o.tier,
    directness: best.o.tier === 'D' || best.o.unresolved ? 'inferred' : best.o.depth === 0 ? 'direct' : 'indirect',
    evidenceStrength: STRENGTH[best.o.tier],
    scope: best.scope,
    support: observations.length,
    reasons,
  };
}

// Observations for evidence records, placing each where its step sits.
export const observe = (evidence: readonly Evidence[], where: (e: Evidence) => ObservationContext): Observation[] =>
  evidence.map((e) => ({ tier: tierOfKind(e.kind), ...where(e) }));
