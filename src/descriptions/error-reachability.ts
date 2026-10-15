// Operation-aware failure model. A throw that exists somewhere in the traced
// call chain is only a *candidate*; it becomes a documented failure or a rule
// when the chain establishes that it is relevant to this operation. Nothing
// here knows a framework: statuses come from an adapter (ThrownError.status).

import type { ChainStep } from './service-chain';
import type { GuardCondition, ThrownError } from './method-facts';
import { EVIDENCE, type Evidence } from './evidence';
import { assess, type Confidence, type Observation } from './confidence';
import type { Conflict } from './conflicts';

// How a failure relates to the operation.
//  direct          thrown by the handler itself
//  indirect        thrown by code the handler calls (project-owned)
//  shared          thrown by shared library code; only relevant when the
//                  source shows the condition that triggers it
//  infrastructure  generic failure (unspecified error, 5xx, throttling) any
//                  component could raise; never an operation rule
//  unknown         a candidate with no source path behind it (only inferred)
//  unreachable     source shows the call/throw cannot happen on this path
export type Reachability = 'direct' | 'indirect' | 'shared' | 'infrastructure' | 'unknown' | 'unreachable';

// How well the trigger is known.
//  observed  the guarding condition was read from the source (`if (c) throw`)
//  branch    the throw is in a branch, condition not readable
//  none      the throw has no visible condition (unconditional on its path)
export type ConditionStrength = 'observed' | 'branch' | 'none';

// Which mechanism found a failure. Downstream semantics never branch on it.
export type Discoverer = 'typed-call-graph' | 'runtime-scanner' | 'explicit-metadata' | 'framework';

// The one semantic failure every analyser emits. Rules and responses are
// decided from this alone; nothing downstream re-reads raw source.
export interface Failure {
  // Deterministic identity: operation + status + message + condition.
  identity: string;
  // Identities of every failure folded into this one by `mergeFailures`.
  aliases: string[];
  discoveredBy: Discoverer[];
  origin: ResponseOrigin;
  // Operation the failure was traced from (unrelated operations never share one).
  operation?: string;
  thrown: ThrownError;
  reach: Reachability;
  condition: { text?: string; strength: ConditionStrength };
  // The consequence: the operation is rejected, with this status when known.
  consequence: { rejects: true; status?: number };
  // endpoint -> ... -> method containing the throw.
  path: string[];
  // Branch conditions observed at call sites on the way to the failure.
  reachedWhen: string[];
  evidence: Evidence[];
  // Carries its own message / schema / observed condition (not a bare generic failure).
  specific: boolean;
  // Whether a branch condition on a callee parameter was fixed by the call site.
  branchBasis: BranchBasis;
  // How strongly the source proves this failure for this operation.
  confidence: Confidence;
  // Passes the relevance threshold for a business rule on this operation.
  relevant: boolean;
}

// How the guarding condition relates to the arguments of the call that reached it.
//  independent               not a comparison of a parameter with a literal
//  proven-literal            such a comparison, and the call site passes the
//                            literal that makes it hold
//  unresolved-discriminator  such a comparison, but the argument is not a
//                            literal: which branch applies cannot be told
export type BranchBasis = 'independent' | 'proven-literal' | 'unresolved-discriminator';

// A failure is generic infrastructure noise when it is an unspecified error or
// its status says so (5xx, throttling). Statuses come from an adapter; the core
// knows no framework exception names.
const GENERIC_TYPE = /^Error$/;

export const isGenericFailure = (t: ThrownError): boolean =>
  GENERIC_TYPE.test(t.type) || (t.status !== undefined && (t.status >= 500 || t.status === 429));

// Where a documented response comes from.
export type ResponseOrigin = 'explicit-api-metadata' | 'source-failure' | 'framework-default' | 'inferred';

// One call edge on the path from the operation to a failure.
export interface CallEdge {
  caller: string;
  callee: string;
  sourceFile?: string;
  line?: number;
  // Condition of the enclosing `if`, only when one was observed at the call site.
  condition?: string;
  args: string[];
}

// The single reachability rule. Both analysers (typed call chain and the
// runtime scanner) classify through this, so there is one policy.
export function reachOf(a: { depth: number; shared: boolean; generic: boolean; known: boolean; unreachable?: boolean }): Reachability {
  if (a.unreachable) return 'unreachable';
  if (!a.known) return 'unknown';
  if (a.generic) return 'infrastructure';
  if (a.depth === 0) return 'direct';
  return a.shared ? 'shared' : 'indirect';
}

// The single relevance policy. `reachedWhen` are branch conditions observed on
// the path to the failure (call-site conditions). A business rule never comes
// from an infrastructure failure; a documented *response* may, but only when
// the failure is specific to this operation (own message / observed condition).
export function isRelevant(
  reach: Reachability,
  strength: ConditionStrength,
  reachedWhen: readonly string[] = [],
  origin: ResponseOrigin = 'source-failure',
  purpose: 'rule' | 'response' = 'rule',
  specific = false,
): boolean {
  if (origin === 'explicit-api-metadata' || origin === 'framework-default') return purpose === 'response';
  if (reach === 'direct' || reach === 'indirect') return true;
  if (reach === 'shared') return strength === 'observed' || reachedWhen.length > 0;
  if (reach === 'infrastructure') return purpose === 'response' && specific;
  return false;
}

export interface ResponseDecision<T> {
  item: T;
  failure: Failure;
  keep: boolean;
  reason: string;
  // The failure is one side of an unresolved or ambiguous disagreement about the same fact.
  contested: boolean;
}

// Relevance of a failure as a documented response.
export const relevantAsResponse = (f: Pick<Failure, 'reach' | 'condition' | 'reachedWhen' | 'origin' | 'specific'>): boolean =>
  isRelevant(f.reach, f.condition.strength, f.reachedWhen, f.origin, 'response', f.specific);

// The comparable fact a failure states: for this operation, the failing
// condition (or its message when it has none) leads to this status.
export const FAILURE_DIMENSION = 'failure-response';
export const failureFact = (f: Pick<Failure, 'operation' | 'condition' | 'thrown'>): { dimension: string; operation: string; subject: string } | undefined => {
  const subject = f.condition.strength === 'observed' && f.condition.text ? f.condition.text.replace(/\s+/g, ' ').trim() : f.thrown.message;
  return subject ? { dimension: FAILURE_DIMENSION, operation: f.operation ?? '', subject } : undefined;
};

// Decides every failure once; callers document only `keep` ones. A status the
// API declares explicitly is never dropped by source analysis. A failure whose
// status the confidence policy has resolved AGAINST (a contradiction it lost) is
// not documented, but only when the side that won is itself documented: the
// conflict never leaves a fact with no response at all. An unresolved
// disagreement keeps every side, marked contested.
export function decideResponses<T>(
  items: readonly { item: T; failure: Failure }[],
  explicitStatuses: ReadonlySet<number> = new Set(),
  conflicts: readonly Conflict[] = [],
): ResponseDecision<T>[] {
  const base = items.map(({ item, failure }) => {
    const declared = failure.consequence.status !== undefined && explicitStatuses.has(failure.consequence.status) && failure.origin === 'inferred';
    const origin: ResponseOrigin = declared ? 'explicit-api-metadata' : failure.origin;
    // A status that only a conventional code table assigned, with no second
    // analyser or explicit declaration agreeing, is not asserted in the API docs.
    const unverifiedStatus = failure.thrown.statusBasis === 'code-mapping' && failure.discoveredBy.length === 1 && origin === 'source-failure';
    const keep = !unverifiedStatus && relevantAsResponse({ ...failure, origin });
    const fact = failureFact(failure);
    const value = String(failure.consequence.status);
    const mine = fact ? conflicts.filter((c) => c.dimension === fact.dimension && c.operation === fact.operation && c.subject === fact.subject && c.sides.some((side) => side.value === value)) : [];
    return { item, failure, origin, unverifiedStatus, keep, fact, value, mine };
  });
  const documentedWinner = (b: (typeof base)[number], prevailing: string | undefined): boolean =>
    base.some((o) => o !== b && o.keep && o.fact && b.fact && o.fact.operation === b.fact.operation && o.fact.subject === b.fact.subject && o.value === prevailing);
  return base.map((b) => {
    const resolvedAgainst = b.mine.filter((c) => c.kind === 'contradictory' && c.resolution === 'resolved' && c.prevailing !== b.value);
    const lost = b.origin !== 'explicit-api-metadata' && resolvedAgainst.some((c) => documentedWinner(b, c.prevailing));
    const contested =
      b.mine.some((c) => c.kind === 'contradictory' && c.resolution === 'unresolved') || (resolvedAgainst.length > 0 && !lost);
    const keep = b.keep && !lost;
    const { failure } = b;
    const reason = b.unverifiedStatus
      ? 'status comes only from an unverified code mapping'
      : lost
      ? 'a contradicting failure for the same condition is better proven'
      : keep
      ? `${b.origin}: ${failure.reach}`
      : failure.reach === 'shared'
        ? 'shared code failure with no condition tying it to this operation'
        : `${failure.reach} failure is not specific to this operation`;
    return { item: b.item, failure, keep, reason, contested };
  });
}

function evidenceOf(step: ChainStep, thrown: ThrownError, cond?: string): Evidence[] {
  return step.info.evidence.filter(
    (e) => (e.kind === EVIDENCE.throws && e.line === thrown.line) || (e.kind === EVIDENCE.guard && cond !== undefined && e.details?.cond === cond),
  );
}

const LITERAL = /^(?:'([^']*)'|"([^"]*)"|(-?\d+(?:\.\d+)?)|(true|false|null|undefined))$/;
const literalOf = (text: string): { value: unknown } | undefined => {
  const m = LITERAL.exec(text.trim());
  if (!m) return undefined;
  if (m[1] !== undefined) return { value: m[1] };
  if (m[2] !== undefined) return { value: m[2] };
  if (m[3] !== undefined) return { value: Number(m[3]) };
  return { value: m[4] === 'true' ? true : m[4] === 'false' ? false : m[4] === 'null' ? null : undefined };
};

// Evaluates a condition made of comparisons / truthiness of callee parameters
// against literal call arguments, with `!`, `&&`, `||` and parentheses
// (three-valued: `undefined` = cannot tell, so nothing is ever claimed that is
// not proven). Anything outside that grammar (calls, member access, `?:`, `??`)
// makes the whole condition "cannot tell".
export function evaluateCondition(cond: string, bound: ReadonlyMap<string, { value: unknown }>): boolean | undefined {
  const tokens = tokenizeCondition(cond);
  if (!tokens) return undefined;
  let i = 0;
  const peek = (): string | undefined => tokens[i]?.t;
  type V = { known: true; value: unknown } | { known: false };
  const operand = (): V | 'bad' => {
    const tok = tokens[i++];
    if (!tok) return 'bad';
    if (tok.kind === 'lit') return { known: true, value: tok.value };
    if (tok.kind === 'id') return bound.has(tok.t) ? { known: true, value: bound.get(tok.t)?.value } : { known: false };
    return 'bad';
  };
  const truthy = (v: V): boolean | undefined => (v.known ? Boolean(v.value) : undefined);
  const compare = (l: V, op: string, r: V): boolean | undefined => {
    if (!l.known || !r.known) return undefined;
    const a = l.value as never;
    const b = r.value as never;
    switch (op) {
      case '===': return a === b;
      case '!==': return a !== b;
      // eslint-disable-next-line eqeqeq
      case '==': return a == b;
      // eslint-disable-next-line eqeqeq
      case '!=': return a != b;
      case '<': return a < b;
      case '<=': return a <= b;
      case '>': return a > b;
      case '>=': return a >= b;
      default: return undefined;
    }
  };
  const BAD = Symbol('bad');
  const primary = (): boolean | undefined | typeof BAD => {
    if (peek() === '!') {
      i++;
      const inner = primary();
      return inner === BAD ? BAD : inner === undefined ? undefined : !inner;
    }
    if (peek() === '(') {
      i++;
      const inner = or();
      if (peek() !== ')') return BAD;
      i++;
      return inner;
    }
    const left = operand();
    if (left === 'bad') return BAD;
    const op = tokens[i]?.kind === 'op' ? tokens[i].t : undefined;
    if (op && ['===', '!==', '==', '!=', '<', '<=', '>', '>='].includes(op)) {
      i++;
      const right = operand();
      return right === 'bad' ? BAD : compare(left, op, right);
    }
    return truthy(left);
  };
  const and = (): boolean | undefined | typeof BAD => {
    let acc = primary();
    while (acc !== BAD && peek() === '&&') {
      i++;
      const next = primary();
      if (next === BAD) return BAD;
      acc = acc === false || next === false ? false : acc === true && next === true ? true : undefined;
    }
    return acc;
  };
  const or = (): boolean | undefined | typeof BAD => {
    let acc = and();
    while (acc !== BAD && peek() === '||') {
      i++;
      const next = and();
      if (next === BAD) return BAD;
      acc = acc === true || next === true ? true : acc === false && next === false ? false : undefined;
    }
    return acc;
  };
  const result = or();
  if (result === BAD || i !== tokens.length) return undefined;
  return result;
}

interface CondToken {
  kind: 'lit' | 'id' | 'op';
  t: string;
  value?: unknown;
}

function tokenizeCondition(src: string): CondToken[] | undefined {
  const out: CondToken[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    let m: RegExpExecArray | null;
    const rest = src.slice(i);
    if ((m = /^(===|!==|==|!=|<=|>=|&&|\|\||<|>|!|\(|\))/.exec(rest))) {
      out.push({ kind: 'op', t: m[1] });
      i += m[1].length;
    } else if ((m = /^'([^'\\]*)'|^"([^"\\]*)"/.exec(rest))) {
      out.push({ kind: 'lit', t: m[0], value: m[1] ?? m[2] });
      i += m[0].length;
    } else if ((m = /^-?\d+(?:\.\d+)?(?![\w$.])/.exec(rest))) {
      out.push({ kind: 'lit', t: m[0], value: Number(m[0]) });
      i += m[0].length;
    } else if ((m = /^[A-Za-z_$][\w$]*/.exec(rest))) {
      const w = m[0];
      const after = rest.slice(w.length).trimStart();
      // member access / call / optional chaining / assignment are outside the grammar.
      if (/^[.([?=]/.test(after) && !/^(==|=== )/.test(after) && !/^={2,3}/.test(after)) return undefined;
      if (w === 'true' || w === 'false') out.push({ kind: 'lit', t: w, value: w === 'true' });
      else if (w === 'null') out.push({ kind: 'lit', t: w, value: null });
      else if (w === 'undefined') out.push({ kind: 'lit', t: w, value: undefined });
      else out.push({ kind: 'id', t: w });
      i += w.length;
    } else {
      return undefined;
    }
  }
  return out;
}

// Callee parameters bound to literal call arguments (positional). Anything that
// is not a literal stays unbound, so narrowing never claims more than it proves.
export function bindLiterals(params: readonly string[], args: readonly string[] | undefined): Map<string, { value: unknown }> {
  const out = new Map<string, { value: unknown }>();
  params.forEach((name, i) => {
    const arg = args?.[i];
    const lit = arg === undefined ? undefined : literalOf(arg);
    if (lit) out.set(name, lit);
  });
  return out;
}

// True when the call-site literals prove the guarding condition can never hold.
export const provablyUnreachable = (cond: string | undefined, params: readonly string[], args: readonly string[] | undefined): boolean =>
  cond !== undefined && args !== undefined && evaluateCondition(cond, bindLiterals(params, args)) === false;

export const strengthOf = (when: string | undefined, branch: boolean | undefined): ConditionStrength => (when ? 'observed' : branch ? 'branch' : 'none');

const DISCRIMINATOR = (param: string): RegExp => new RegExp(`(?:^|[^\\w.])${param}\\s*(?:===|!==|==|!=)\\s*(?:'[^']*'|"[^"]*"|-?\\d)`);

export function branchBasisOf(cond: string | undefined, params: readonly string[], args: readonly string[] | undefined): BranchBasis {
  if (!cond || args === undefined) return 'independent';
  const compared = params.filter((p) => p && DISCRIMINATOR(p).test(cond));
  if (compared.length === 0) return 'independent';
  const bound = bindLiterals(params, args);
  return compared.every((p) => bound.has(p)) && evaluateCondition(cond, bound) === true ? 'proven-literal' : 'unresolved-discriminator';
}

// Confidence of a failure, a pure function of its own (merged) facts.
export function assessFailure(f: Pick<Failure, 'origin' | 'reach' | 'condition' | 'reachedWhen' | 'branchBasis' | 'discoveredBy'>): Confidence {
  if (f.origin === 'explicit-api-metadata') {
    return { level: 'high', tier: 'A', directness: 'direct', evidenceStrength: 'strong', scope: 'operation-local', support: 1, reasons: ['declared in the API metadata'] };
  }
  if (f.origin === 'framework-default') {
    return { level: 'medium', tier: 'B', directness: 'direct', evidenceStrength: 'moderate', scope: 'operation-reachable', support: 1, reasons: ['configured framework response, not proven per operation'] };
  }
  const none = (reason: string, scope: Confidence['scope'] = 'uncertain'): Confidence => ({ level: 'low', tier: 'D', directness: 'inferred', evidenceStrength: 'weak', scope, support: 1, reasons: [reason] });
  if (f.reach === 'unreachable') return none('the source proves this failure cannot occur on this path');
  if (f.reach === 'unknown') return none('no source path leads to this failure');
  if (f.reach === 'infrastructure') return { ...none('infrastructure failure: not an operation rule', 'operation-reachable'), tier: 'C', directness: 'indirect', evidenceStrength: 'moderate' };
  if (f.branchBasis === 'unresolved-discriminator') return { ...none('which branch applies cannot be told from the call-site argument'), tier: 'B', directness: 'indirect', evidenceStrength: 'moderate' };
  const obs: Observation = {
    tier: f.condition.strength === 'branch' ? 'B' : 'A',
    depth: f.reach === 'direct' ? 0 : 1,
    shared: f.reach === 'shared',
    conditioned: f.reachedWhen.length > 0 || f.condition.strength === 'observed',
  };
  const independent = new Set(f.discoveredBy.filter((d) => d === 'typed-call-graph' || d === 'runtime-scanner')).size;
  const c = assess([obs], independent);
  return f.branchBasis === 'proven-literal' ? { ...c, reasons: [...c.reasons, 'call-site literal proves the branch'] } : c;
}

export const sealFailure = <T extends Omit<Failure, 'confidence'>>(f: T): T & { confidence: Confidence } => ({ ...f, confidence: assessFailure(f) });

// Semantic identity of a failure: the operation it rejects, the status it
// produces, its message and the condition that triggers it. Never the message
// alone (two operations may share a message) and never the analyser or the
// exact throw location, which differ between a typed read and a runtime read
// of the same throw (the location stays in `path` / `evidence`).
export function failureIdentity(f: { origin: ResponseOrigin; operation?: string; consequence: { status?: number }; thrown: ThrownError; condition: { text?: string; strength?: string } }): string {
  return [f.origin, f.operation ?? '', f.consequence.status ?? '', f.thrown.message ?? '', (f.condition.text ?? '').replace(/\s+/g, ' ').trim()].join('::');
}

// Typed call chain -> Failure.
export function classifyFailure(step: ChainStep, thrown: ThrownError, guard?: GuardCondition, operation?: string): Failure {
  const text = thrown.when ?? guard?.cond;
  const strength = strengthOf(text, thrown.branch);
  const unreachable = step.via !== undefined && provablyUnreachable(text, step.info.params, step.via.args);
  const generic = isGenericFailure(thrown);
  const reach = reachOf({ depth: step.depth, shared: step.shared, generic, known: true, unreachable });
  const reachedWhen = step.reachedWhen ?? [];
  const branchBasis = branchBasisOf(text, step.info.params, step.via?.args);
  const failure = {
    operation,
    branchBasis,
    discoveredBy: ['typed-call-graph'] as Discoverer[],
    origin: 'source-failure' as ResponseOrigin,
    thrown,
    reach,
    condition: { ...(text ? { text } : {}), strength },
    consequence: { rejects: true as const, ...(thrown.status !== undefined ? { status: thrown.status } : {}) },
    path: step.path,
    reachedWhen,
    evidence: evidenceOf(step, thrown, text),
    specific: Boolean(thrown.message || text),
  };
  return sealFailure({ ...failure, identity: failureIdentity(failure), aliases: [], relevant: isRelevant(reach, strength, reachedWhen) });
}

// Every throw in the chain with its classification. Deterministic: chain order.
export function reachableFailures(steps: ChainStep[], operation?: string): Failure[] {
  const out: Failure[] = [];
  for (const step of steps) {
    for (const t of step.info.throws) {
      const guard = step.info.guards.find((g) => g.thrown.type === t.type && g.thrown.message === t.message);
      out.push(classifyFailure(step, t, guard, operation));
    }
  }
  return out;
}

const REACH_RANK: Reachability[] = ['direct', 'indirect', 'shared', 'infrastructure', 'unknown'];
const STRENGTH_RANK: ConditionStrength[] = ['observed', 'branch', 'none'];
const unionSorted = <T extends string>(a: readonly T[], b: readonly T[]): T[] => [...new Set([...a, ...b])].sort();

const normalizedCondition = (f: Failure): string => (f.condition.text ?? '').replace(/\s+/g, ' ').trim();

// Same throw seen by two analysers: same operation, status and trigger condition,
// and messages that agree. An analyser that could not read a message (a template
// literal, a computed value) is compatible with one that did — but only when a
// condition ties the two together; unconditional failures need equal messages.
function sameFailure(a: Failure, b: Failure): boolean {
  // Declared metadata, framework defaults and source failures never absorb each other.
  if (a.origin !== b.origin) return false;
  if (a.operation !== b.operation || a.consequence.status !== b.consequence.status) return false;
  if (normalizedCondition(a) !== normalizedCondition(b)) return false;
  if (a.thrown.message === b.thrown.message) return true;
  return normalizedCondition(a) !== '' && (!a.thrown.message || !b.thrown.message);
}

// Merges failures that are the same semantic failure found by different
// analysers. Facts only get stronger: the better-known reachability, the
// stronger condition, the union of evidence. `unreachable` is a proof and wins
// over any analyser that could not narrow. The result does not depend on input
// order: failures are folded in a canonical order, and the output is arranged
// by the earliest position of any member.
export function mergeFailures(failures: readonly Failure[]): Failure[] {
  const canon = (f: Failure): string => [f.thrown.message ? '0' : '1', f.identity, f.discoveredBy.join(','), f.path.join('>'), f.reach].join('\u0000');
  const ordered = failures
    .map((f, index) => ({ f, index, key: canon(f), full: JSON.stringify(f) }))
    .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : x.full < y.full ? -1 : x.full > y.full ? 1 : 0));
  const out: { failure: Failure; first: number }[] = [];
  for (const { f, index } of ordered) {
    const at = out.findIndex((prior) => sameFailure(prior.failure, f));
    if (at < 0) {
      out.push({ failure: { ...f, aliases: unionSorted(f.aliases, [f.identity]) }, first: index });
      continue;
    }
    const prior = out[at].failure;
    const reach: Reachability =
      prior.reach === 'unreachable' || f.reach === 'unreachable'
        ? 'unreachable'
        : REACH_RANK[Math.min(REACH_RANK.indexOf(prior.reach), REACH_RANK.indexOf(f.reach))];
    const strength = STRENGTH_RANK[Math.min(STRENGTH_RANK.indexOf(prior.condition.strength), STRENGTH_RANK.indexOf(f.condition.strength))];
    const text = prior.condition.text ?? f.condition.text;
    const seen = new Set(prior.evidence.map((e) => `${e.sourceFile}:${e.line}:${e.kind}`));
    const reachedWhen = prior.reachedWhen.length >= f.reachedWhen.length ? prior.reachedWhen : f.reachedWhen;
    const merged: Failure = {
      ...prior,
      aliases: unionSorted(prior.aliases, [f.identity]),
      discoveredBy: unionSorted(prior.discoveredBy, f.discoveredBy),
      reach,
      condition: { ...(text ? { text } : {}), strength },
      path: prior.path.length >= f.path.length ? prior.path : f.path,
      reachedWhen,
      evidence: [...prior.evidence, ...f.evidence.filter((e) => !seen.has(`${e.sourceFile}:${e.line}:${e.kind}`))],
      specific: prior.specific || f.specific,
      thrown: { ...f.thrown, ...prior.thrown, ...(prior.thrown.message ? {} : f.thrown.message ? { message: f.thrown.message } : {}) },
    };
    merged.relevant = reach !== 'unreachable' && isRelevant(reach, strength, reachedWhen);
    merged.branchBasis = prior.branchBasis === 'unresolved-discriminator' || f.branchBasis === 'unresolved-discriminator' ? 'unresolved-discriminator' : prior.branchBasis === 'proven-literal' || f.branchBasis === 'proven-literal' ? 'proven-literal' : 'independent';
    merged.confidence = assessFailure(merged);
    out[at] = { failure: merged, first: Math.min(out[at].first, index) };
  }
  return out.sort((x, y) => x.first - y.first).map((x) => x.failure);
}
