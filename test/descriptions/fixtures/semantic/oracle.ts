// Semantic oracle for generated descriptions. It is deliberately independent of
// the composer: expectations are declared per fixture as a contract of roles,
// and checked two ways that must agree --
//   structural  the composer's own record of what each sentence represents
//   lexical     a wording-insensitive reading of the final TEXT using concept
//               lexicons (many phrasings per concept), never exact sentences
// A role is a contract dimension, not a sentence. Domain nouns, framework names
// and project terms appear nowhere in this file.

import type { StructuredDescription } from '../../../../src/descriptions/description-composer';
import { FAMILY_OF, type DepthDimension } from '../../../../src/descriptions/depth';

export type Role =
  | 'ownership' | 'rule' | 'validation' | 'partial-update' | 'event' | 'audit' | 'idempotency'
  | 'side-effect' | 'state' | 'initialization' | 'defaults' | 'existence';
export type Expectation = 'present' | 'absent';

// Concept lexicons: any of these phrasings expresses the concept.
const LEXICON: Partial<Record<Role, RegExp>> = {
  ownership: /\b(owner|owners|ownership|authenticated user becomes|belongs? to the (caller|authenticated))/i,
  rule: /\b(only|cannot|can not|must not|may not|not allowed|restricted|requires?|prohibited|forbidden|unless)\b|\bmust\b/i,
  validation: /\b(valid|must (be|fall|match|have)|required|supported (range|values)|expected format)\b/i,
  'partial-update': /\b(omitted|left unchanged|unchanged|preserv\w*|keep(s)? (their|its) current|only the supplied|partial(ly)?)\b/i,
  event: /\bevents?\b/i,
  audit: /\baudit\b/i,
  idempotency: /\b(idempotent|repeating it|repeat(ed)?|no further changes|no[- ]op)\b/i,
  initialization: /\binitiali[sz]ed\b/i,
  defaults: /\bby default\b/i,
};

// Structural role -> the dimensions/labels the composer may use for it.
const STRUCTURAL: Record<Role, (r: StructuredDescription) => boolean> = {
  ownership: (r) => r.represented.includes('authorization'),
  rule: (r) => r.represented.includes('rules'),
  validation: (r) => r.represented.includes('validation'),
  'partial-update': (r) => r.represented.includes('partial-update'),
  event: (r) => r.represented.includes('events'),
  audit: (r) => r.represented.includes('audit'),
  idempotency: (r) => r.represented.includes('idempotency'),
  'side-effect': (r) => r.represented.includes('side-effect'),
  state: (r) => r.represented.includes('state'),
  initialization: (r) => r.represented.includes('initialization'),
  defaults: (r) => r.represented.includes('defaults'),
  // existence is only implied by the lead's reference to a specified record
  existence: (r) => r.implied.includes('existence'),
};

// Implementation vocabulary that must never become a contract statement.
export const IMPLEMENTATION_NOISE = /\b(logger|loggers|logging|metrics?|tracer|tracing|span|helper|helpers|store|repository|Exception|emit|temporary|tmp|debug)\b/i;

export interface Contract {
  roles: Partial<Record<Role, Expectation>>;
  // Roles that must be reported absent on BOTH views even if not listed above.
  depth?: 'minimal' | 'standard' | 'detailed';
}

export interface Artifact { text: string; structured: StructuredDescription }

// Checks the artifact against a contract; returns violations (empty = faithful).
const PLAIN = new Set(['purpose', 'input', 'result', 'schema']);
// The text that can carry behaviour: sentences that are not purely lead, inputs or result.
const behaviouralText = (a: Artifact): string => a.structured.sentences.filter((s) => !s.represents.every((r) => PLAIN.has(r))).map((s) => s.text).join(' ');

export function violations(a: Artifact, c: Contract): string[] {
  const out: string[] = [];
  const body = behaviouralText(a);
  for (const [role, want] of Object.entries(c.roles) as [Role, Expectation][]) {
    const structural = STRUCTURAL[role](a.structured);
    const lexicon = LEXICON[role];
    const lexical = lexicon ? lexicon.test(body) : undefined;
    if (want === 'present') {
      if (!structural) out.push(`${role}: expected present, not represented`);
      if (lexical === false) out.push(`${role}: expected present, text does not express it`);
    } else {
      if (structural) out.push(`${role}: expected absent, but represented`);
      if (lexical === true) out.push(`${role}: expected absent, but the text expresses it`);
    }
  }
  if (IMPLEMENTATION_NOISE.test(a.text)) out.push('implementation detail exposed in the text');
  if (c.depth) {
    const behavioural = a.structured.represented.filter((r): r is DepthDimension => r in FAMILY_OF);
    const families = new Set(behavioural.map((d) => FAMILY_OF[d]));
    const level = behavioural.length === 0 ? 'minimal' : families.size >= 2 ? 'detailed' : 'standard';
    if (level !== c.depth) out.push(`depth: expected ${c.depth}, the description shows ${level}`);
  }
  return out;
}

// Each concept at most once: a fact found by several analysers is stated once.
export const statedOnce = (a: Artifact, role: Role): boolean => a.structured.sentences.filter((s) => (LEXICON[role] ?? /$^/).test(s.text)).length <= 1;
