// Adaptive description depth: how much of the contract an operation's evidence
// justifies describing. A semantic decision made AFTER relevance, confidence
// and conflict handling, from facts that already passed those gates. It never
// looks at prose, string lengths or raw evidence counts.
//
// Levels (information density, not length)
//   minimal   no reliable behavioural dimension: purpose and result only
//   standard  reliable evidence in one dimension family
//   detailed  reliable evidence in two or more families, at least one of it
//             proven strongly (high confidence)
//
// A semantic dimension is something a caller can observe about the contract.
// Dimensions group into families:
//   input        validation, partial-update, defaults
//   access       authorization, existence, rules, failures
//   outcome      state, side-effect, events, audit, idempotency, initialization
// A dimension contributes only when its supporting claim is at least `medium`
// confidence and is not disputed by an unresolved contradiction. Weak or
// contradicted dimensions are listed as excluded, with the reason. Implementation
// detail (calls, helpers, logging, relations) never forms a dimension, so it
// cannot inflate depth. Many facts in one dimension count once.
//
// Determinism: the decision is a function of the SET of reliable dimensions.

import type { Confidence, ConfidenceLevel } from './confidence';
import { meets } from './confidence';
import type { Conflict } from './conflicts';
import type { Fact } from './evidence';

export type DepthLevel = 'minimal' | 'standard' | 'detailed';
export type DepthFamily = 'input' | 'access' | 'outcome';
export type DepthDimension =
  | 'validation' | 'partial-update' | 'defaults'
  | 'authorization' | 'existence' | 'rules' | 'failures'
  | 'state' | 'side-effect' | 'events' | 'audit' | 'idempotency' | 'initialization';

export const FAMILY_OF: Record<DepthDimension, DepthFamily> = {
  validation: 'input', 'partial-update': 'input', defaults: 'input',
  authorization: 'access', existence: 'access', rules: 'access', failures: 'access',
  state: 'outcome', 'side-effect': 'outcome', events: 'outcome', audit: 'outcome', idempotency: 'outcome', initialization: 'outcome',
};

// Claim kinds that state a contract-level dimension. Other claim kinds
// (relations, constraints, filters) describe implementation or schema and carry none.
const DIMENSION_OF_CLAIM: Record<string, DepthDimension> = {
  actor: 'authorization', ownership: 'authorization', existence: 'existence', rule: 'rules',
  'partial-update': 'partial-update', default: 'defaults', initialization: 'initialization',
  'state-change': 'state', 'soft-deletion': 'state', 'side-effect': 'side-effect',
  event: 'events', 'audit-entry': 'audit', idempotence: 'idempotency',
};
export const dimensionOfClaim = (kind: string): DepthDimension | undefined => DIMENSION_OF_CLAIM[kind];

export interface DepthExclusion {
  dimension: DepthDimension;
  reason: 'low-confidence' | 'disputed';
}

export interface DepthDecision {
  level: DepthLevel;
  // Reliable dimensions, canonically ordered.
  dimensions: DepthDimension[];
  families: DepthFamily[];
  strongest: ConfidenceLevel;
  // Dimensions evidence exists for but that were not allowed to count.
  excluded: DepthExclusion[];
  reasons: string[];
}

// What the decision reads: facts after the semantic gates, plus (optionally)
// the operation's failures and the claims the gates withdrew.
export interface DepthInput {
  claims: readonly Fact[];
  constraints: readonly string[];
  // Claims removed by the semantic gates (confidence or conflict), with why.
  withdrawn?: readonly { kind: string; subject?: string; reason: 'low-confidence' | 'disputed' }[];
  // Operation failures already judged relevant and confident, specific ones only.
  failures?: readonly { confidence: Confidence; specific: boolean; contested?: boolean }[];
  conflicts?: readonly Conflict[];
}

const RANK: ConfidenceLevel[] = ['high', 'medium', 'low'];
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function decideDepth(input: DepthInput): DepthDecision {
  const best = new Map<DepthDimension, ConfidenceLevel>();
  const note = (d: DepthDimension, level: ConfidenceLevel): void => {
    const cur = best.get(d);
    if (!cur || RANK.indexOf(level) < RANK.indexOf(cur)) best.set(d, level);
  };
  const weak = new Set<DepthDimension>();
  for (const c of input.claims) {
    const d = dimensionOfClaim(c.kind);
    if (!d) continue;
    if (c.confidence && !meets(c.confidence, 'medium')) weak.add(d);
    else note(d, c.confidence?.level ?? 'medium');
  }
  if (input.constraints.length > 0) note('validation', 'high');
  const failures = (input.failures ?? []).filter((f) => f.specific && meets(f.confidence, 'medium') && !f.contested);
  if (failures.length > 0) note('failures', failures.reduce((a, f) => (RANK.indexOf(f.confidence.level) < RANK.indexOf(a) ? f.confidence.level : a), 'low' as ConfidenceLevel));

  const excluded = new Map<DepthDimension, DepthExclusion['reason']>();
  for (const w of input.withdrawn ?? []) {
    const d = dimensionOfClaim(w.kind);
    if (d && !best.has(d)) excluded.set(d, w.reason === 'disputed' || !excluded.has(d) ? w.reason : excluded.get(d)!);
  }
  for (const d of weak) if (!best.has(d) && !excluded.has(d)) excluded.set(d, 'low-confidence');

  const dimensions = [...best.keys()].sort(byName);
  const families = [...new Set(dimensions.map((d) => FAMILY_OF[d]))].sort(byName);
  const strongest = dimensions.length === 0 ? 'low' : dimensions.map((d) => best.get(d)!).sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b))[0];
  const level: DepthLevel = dimensions.length === 0 ? 'minimal' : families.length >= 2 && strongest === 'high' ? 'detailed' : 'standard';
  const reasons =
    level === 'minimal'
      ? ['no reliable behavioural dimension']
      : level === 'detailed'
      ? [`reliable evidence in ${families.length} families (${families.join(', ')}) including a high-confidence dimension`]
      : families.length < 2
      ? [`reliable evidence in one family only (${families.join(', ')})`]
      : ['no dimension is proven at high confidence'];
  return {
    level,
    dimensions,
    families,
    strongest,
    excluded: [...excluded.entries()].map(([dimension, reason]) => ({ dimension, reason })).sort((a, b) => byName(a.dimension, b.dimension)),
    reasons,
  };
}
