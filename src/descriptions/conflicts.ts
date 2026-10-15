// Conflict detection. Asks: do several observations about the SAME semantic
// fact genuinely disagree? It never compares raw prose or bare statuses.
//
// Pipeline position: evidence -> facts -> confidence -> CONFLICTS -> gates.
// It consumes `Assertion`s that the existing normalisers produce (a Failure, a
// claim, an adapter's stance); it owns no second failure or confidence model.
//
// Semantic identity
//   Two assertions are comparable only when they share
//     (dimension, operation, subject)
//   `dimension` names the kind of fact (a failure response, an ownership
//   requirement, an effect...), `subject` names which fact of that kind. Other
//   operations, dimensions or subjects are independent and never compared.
//
// Relation of two comparable sides that carry different values
//   compatible     not provably incompatible: the conditions they hold under
//                  are mutually exclusive branches, the values of an `open`
//                  dimension are not proven exclusive, or the sides are
//                  differently labelled statements
//   contradictory  incompatible values, same execution context
//   ambiguous      incompatible values, but the contexts differ without proof
//                  that they exclude each other (cannot tell which applies)
//   duplicate      the very same value and context seen more than once
//
// Cardinality of a dimension
//   single   one value per (operation, subject, context): any other value opposes it
//   open     several outcomes may coexist; values oppose only when an assertion
//            declares that it `excludes` the other
//
// Resolution (explicit policy, never "highest always wins")
//   A contradiction is `resolved` only when one side meets `prevailingMin` and
//   every opposing side is at or below `opposingMax`. Otherwise it stays
//   `unresolved`, and an unresolved contradiction is `blocking`: claims that
//   depend on the fact must not be stated. A resolved contradiction is
//   `advisory`; the losing side stays in the report with its confidence and
//   provenance. Nothing is ever deleted.
//
// Determinism: assertions are canonically ordered before use, conflict ids are
// derived from content, output is sorted; permuting the input changes nothing.

import type { Confidence, ConfidenceLevel } from './confidence';
import type { Evidence } from './evidence';

export type ConflictKind = 'duplicate' | 'compatible' | 'ambiguous' | 'contradictory';
export type ConflictResolution = 'resolved' | 'unresolved' | 'informational';
export type ConflictSeverity = 'blocking' | 'advisory' | 'none';
export type Cardinality = 'single' | 'open';

// What an analyser or adapter states about a fact, before operation/confidence are known.
export interface AssertionSeed {
  dimension: string;
  subject: string;
  cardinality: Cardinality;
  value: string;
  // `open` dimensions: values this assertion rules out.
  excludes?: readonly string[];
  // Wording-level qualifier: two differently labelled statements under one
  // subject are distinct statements, not rivals.
  label?: string;
  // Branch conditions the assertion holds under (empty = unconditionally).
  when?: readonly string[];
}

export interface AssertionSource {
  // Where the assertion entered the model ('source-failure', 'explicit-api-metadata', 'adapter', ...).
  origin: string;
  // Which analyser/mechanism found it.
  discoverer: string;
  // Call path from the operation to the evidence.
  path: readonly string[];
  evidence: readonly Evidence[];
}

export interface Assertion extends AssertionSeed {
  operation: string;
  confidence: Confidence;
  source: AssertionSource;
}

export interface ConflictSide {
  value: string;
  when: string[];
  label?: string;
  // The strongest single member (agreement never adds up).
  confidence: Confidence;
  // Every member, canonically ordered, each with its own confidence and provenance.
  sources: { confidence: Confidence; source: AssertionSource }[];
}

export interface Conflict {
  id: string;
  kind: ConflictKind;
  resolution: ConflictResolution;
  severity: ConflictSeverity;
  dimension: string;
  operation: string;
  subject: string;
  sides: ConflictSide[];
  // Value of the side that prevails under the policy (resolved contradictions only).
  prevailing?: string;
  // Why the sides were considered comparable, and how they were related.
  rationale: string;
}

export interface ConflictPolicy {
  prevailingMin: ConfidenceLevel;
  opposingMax: ConfidenceLevel;
}
export const DEFAULT_CONFLICT_POLICY: ConflictPolicy = { prevailingMin: 'medium', opposingMax: 'low' };

const RANK: ConfidenceLevel[] = ['high', 'medium', 'low'];
const atLeast = (c: Confidence, min: ConfidenceLevel): boolean => RANK.indexOf(c.level) <= RANK.indexOf(min);
const atMost = (c: Confidence, max: ConfidenceLevel): boolean => RANK.indexOf(c.level) >= RANK.indexOf(max);

// ---- conditions -------------------------------------------------------------------

const unwrap = (s: string): string => {
  let t = s.replace(/\s+/g, ' ').trim();
  while (t.startsWith('(') && t.endsWith(')') && balanced(t.slice(1, -1))) t = t.slice(1, -1).trim();
  return t;
};
const balanced = (s: string): boolean => {
  let d = 0;
  for (const ch of s) {
    d += ch === '(' ? 1 : ch === ')' ? -1 : 0;
    if (d < 0) return false;
  }
  return d === 0;
};
const LITERAL = String.raw`'[^']*'|"[^"]*"|-?\d+(?:\.\d+)?`;
const COMPARE = new RegExp(`^(.+?)\\s*(===|!==|==|!=)\\s*(${LITERAL})$`);
const negation = (s: string): string | undefined => (s.startsWith('!') && !s.startsWith('!=') ? unwrap(s.slice(1)) : undefined);

// Two conditions that provably cannot hold together: `c` and `!c`, or the same
// expression compared with different literals / equal-and-unequal to one literal.
export function exclusiveConditions(a: string, b: string): boolean {
  const x = unwrap(a);
  const y = unwrap(b);
  if (x === y) return false;
  if (negation(x) === y || negation(y) === x) return true;
  const cx = COMPARE.exec(x);
  const cy = COMPARE.exec(y);
  if (!cx || !cy || unwrap(cx[1]) !== unwrap(cy[1])) return false;
  const eq = (op: string): boolean => op === '===' || op === '==';
  if (eq(cx[2]) && eq(cy[2])) return cx[3] !== cy[3];
  if (eq(cx[2]) !== eq(cy[2])) return cx[3] === cy[3];
  return false;
}

const contextOf = (when: readonly string[] | undefined): string[] => [...new Set((when ?? []).map(unwrap).filter(Boolean))].sort();
const contextKey = (ctx: readonly string[]): string => ctx.join(' && ');
const exclusiveContexts = (a: readonly string[], b: readonly string[]): boolean => a.some((x) => b.some((y) => exclusiveConditions(x, y)));

// ---- sides --------------------------------------------------------------------------

const json = (v: unknown): string => JSON.stringify(v);
const strongestFirst = (a: Confidence, b: Confidence): number => RANK.indexOf(a.level) - RANK.indexOf(b.level);

interface Side extends ConflictSide {
  key: string;
  excludes: string[];
}

function sidesOf(group: readonly Assertion[]): Side[] {
  const byKey = new Map<string, Assertion[]>();
  for (const a of group) {
    const key = `${a.value}\u0000${contextKey(contextOf(a.when))}\u0000${a.label ?? ''}`;
    byKey.set(key, [...(byKey.get(key) ?? []), a]);
  }
  return [...byKey.entries()]
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([key, members]) => {
      const sources = members
        .map((m) => ({ confidence: m.confidence, source: m.source, sort: json([m.source, m.confidence]) }))
        .sort((x, y) => strongestFirst(x.confidence, y.confidence) || (x.sort < y.sort ? -1 : x.sort > y.sort ? 1 : 0))
        .map(({ confidence, source }) => ({ confidence, source }));
      const first = members[0];
      return {
        key,
        value: first.value,
        when: contextOf(first.when),
        ...(first.label ? { label: first.label } : {}),
        confidence: sources[0].confidence,
        sources,
        excludes: [...new Set(members.flatMap((m) => m.excludes ?? []))].sort(),
      };
    });
}

const publicSide = ({ key: _key, excludes: _excludes, ...side }: Side): ConflictSide => side;

// ---- detection ----------------------------------------------------------------------

function relate(x: Side, y: Side, cardinality: Cardinality): { kind: ConflictKind; why: string } {
  if (exclusiveContexts(x.when, y.when)) return { kind: 'compatible', why: 'the sides hold under mutually exclusive conditions' };
  const opposed = cardinality === 'single' || x.excludes.includes(y.value) || y.excludes.includes(x.value);
  if (!opposed) return { kind: 'compatible', why: 'the values are not proven mutually exclusive' };
  if (x.label && y.label && x.label !== y.label) return { kind: 'compatible', why: 'the sides are differently labelled statements' };
  if (contextKey(x.when) === contextKey(y.when)) return { kind: 'contradictory', why: 'incompatible values in the same context' };
  return { kind: 'ambiguous', why: 'incompatible values in contexts not proven exclusive' };
}

function resolve(kind: ConflictKind, x: Side, y: Side, policy: ConflictPolicy): { resolution: ConflictResolution; severity: ConflictSeverity; prevailing?: string } {
  if (kind === 'ambiguous') return { resolution: 'informational', severity: 'advisory' };
  if (kind !== 'contradictory') return { resolution: 'informational', severity: 'none' };
  for (const [winner, loser] of [[x, y], [y, x]] as const) {
    if (atLeast(winner.confidence, policy.prevailingMin) && atMost(loser.confidence, policy.opposingMax) && winner.confidence.level !== loser.confidence.level) {
      return { resolution: 'resolved', severity: 'advisory', prevailing: winner.value };
    }
  }
  return { resolution: 'unresolved', severity: 'blocking' };
}

// Finds every relation among comparable assertions. Order-independent.
export function detectConflicts(assertions: readonly Assertion[], policy: ConflictPolicy = DEFAULT_CONFLICT_POLICY): Conflict[] {
  const identities = new Map<string, Assertion[]>();
  for (const a of assertions) {
    const id = json([a.dimension, a.operation, a.subject]);
    identities.set(id, [...(identities.get(id) ?? []), a]);
  }
  const out: Conflict[] = [];
  for (const group of identities.values()) {
    const { dimension, operation, subject, cardinality } = group[0];
    const sides = sidesOf(group);
    const base = { dimension, operation, subject };
    for (const s of sides) {
      if (s.sources.length > 1) {
        out.push({ ...base, id: json([dimension, operation, subject, 'duplicate', s.key]), kind: 'duplicate', resolution: 'informational', severity: 'none', sides: [publicSide(s)], rationale: 'the same value in the same context was found more than once' });
      }
    }
    for (let i = 0; i < sides.length; i++) {
      for (let j = i + 1; j < sides.length; j++) {
        const [x, y] = [sides[i], sides[j]];
        if (x.value === y.value) continue;
        const { kind, why } = relate(x, y, cardinality);
        const verdict = resolve(kind, x, y, policy);
        out.push({
          ...base,
          id: json([dimension, operation, subject, kind, x.key, y.key]),
          kind,
          ...verdict,
          sides: [publicSide(x), publicSide(y)],
          rationale: `comparable: same ${dimension} fact "${subject}" of "${operation}"; ${why}`,
        });
      }
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---- consumers ----------------------------------------------------------------------

export const isBlocking = (c: Conflict): boolean => c.severity === 'blocking';

// May a claim that asserts `value` for this fact still be stated? Not when the
// facts contradict it unresolved, or when the policy resolves the contradiction
// against it.
export function withdrawsClaim(conflicts: readonly Conflict[], fact: { dimension: string; operation: string; subject: string }, value: string): boolean {
  return conflicts.some(
    (c) =>
      c.kind === 'contradictory' &&
      c.dimension === fact.dimension &&
      c.operation === fact.operation &&
      c.subject === fact.subject &&
      c.sides.some((s) => s.value === value) &&
      (c.resolution === 'unresolved' || c.prevailing !== value),
  );
}
