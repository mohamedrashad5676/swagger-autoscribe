// Natural-language composition for EndpointBusinessFacts. Pure formatting:
// it adds no facts of its own.

import type { EndpointBusinessFacts } from './business-facts';
import type { DepthDimension, DepthLevel } from './depth';
import { article, capFirst, naturalList, nominal, participle, polish, singular, withPeriod } from './prose';

// How many sentences each depth may use: a description with little reliable
// contract evidence stays short; a detailed one may use the full budget.
const SENTENCE_BUDGET: Record<DepthLevel, number> = { minimal: 5, standard: 7, detailed: 9 };
const MAX_INLINE_FIELDS = 4;
const MAX_REQUEST_FIELDS = 5;
const MAX_RESPONSE_FIELDS = 4;
const MAX_RELATED = 3;

// A long field list is summarised, not dumped: the schema documents the rest.
const capped = (items: string[], max: number): string[] => (items.length > max ? [...items.slice(0, max - 1), 'other details'] : items);

// Sentences about a dimension the depth decision excluded (weak or disputed
// evidence) are not written. Depth never adds facts; it only limits what may be said.
// What a written sentence represents, for inspection only (never in Swagger).
export type Represented = DepthDimension | 'purpose' | 'input' | 'result' | 'schema';
export interface ComposedSentence {
  text: string;
  represents: Represented[];
}
export interface StructuredDescription {
  text: string;
  sentences: ComposedSentence[];
  // Dimensions stated by a sentence of their own.
  represented: Represented[];
  // Dimensions the description only implies (the lead refers to an existing, specified record).
  implied: DepthDimension[];
}

interface Sentence {
  text: string;
  dimension?: DepthDimension;
  represents: Represented[];
  // Lower = more important; least important are dropped past the depth budget.
  priority: number;
}

const isPluralObject = (object: string): boolean => {
  const head = object.replace(/ (of|for) the .*$/, '');
  const last = head.split(' ').pop() ?? '';
  return /^all /.test(head) || (singular(last) !== last && !/(ss|us|is)$/.test(last));
};

// "release" + "the seat" -> "the seat is released".
function passive(verb: string, object: string): string {
  if (verb === 'set' && object.includes(' to ')) {
    const [what, value] = object.split(' to ');
    return `${what} is set to ${value}`;
  }
  return `${object} ${isPluralObject(object) ? 'are' : 'is'} ${participle(verb)}`;
}

// Same-verb effects read better together: "the A, B, and C events are processed".
function groupEffects(effects: EndpointBusinessFacts['effects']): string[] {
  const byVerb = new Map<string, string[]>();
  for (const e of effects) byVerb.set(e.verb, [...(byVerb.get(e.verb) ?? []), e.object]);
  const out: string[] = [];
  for (const [verb, objects] of byVerb) {
    if (objects.length > 1 && objects.every((o) => o.endsWith(' event'))) {
      const names = objects.map((o) => o.replace(/^the /, '').replace(/ event$/, ''));
      out.push(`the ${naturalList(names)} events are ${participle(verb)}`);
    } else if (objects.length > 1 && verb !== 'set') {
      out.push(`${naturalList(objects)} ${objects.every((o) => !isPluralObject(o)) ? 'are' : 'are'} ${participle(verb)}`);
    } else {
      out.push(passive(verb, objects[0]));
    }
  }
  return out;
}

export const composeDescription = (f: EndpointBusinessFacts): string => composeStructured(f).text;

export function composeStructured(f: EndpointBusinessFacts): StructuredDescription {
  const out: Sentence[] = [];
  const excluded = new Set((f.depth?.excluded ?? []).map((e) => e.dimension));
  const add = (text: string | undefined, priority: number, dimension?: DepthDimension, represents: Represented[] = dimension ? [dimension] : []): void => {
    if (text && !(dimension && excluded.has(dimension))) out.push({ text: withPeriod(text), priority, represents, ...(dimension ? { dimension } : {}) });
  };

  // 1. Lead: action, target and (when short) the supplied inputs.
  const required = capped(f.request.required, MAX_REQUEST_FIELDS);
  const optional = capped(f.request.optional, MAX_REQUEST_FIELDS);
  const inline = required.length > 0 && required.length <= MAX_INLINE_FIELDS && optional.length === 0;
  const onlyOptional = required.length === 0 && optional.length > 0 && optional.length <= MAX_INLINE_FIELDS;
  const using = inline
    ? `using the supplied ${naturalList(required)}`
    : onlyOptional
      ? optional.length === 1
        ? `using the supplied ${optional[0]}`
        : `using any of the supplied ${naturalList(optional)}`
      : undefined;
  add([f.action.lead, f.target, using].filter(Boolean).join(' '), 0, undefined, using ? ['purpose', 'input'] : ['purpose']);

  // 2. Inputs that did not fit the lead.
  if (!inline && !onlyOptional && (required.length > 0 || optional.length > 0)) {
    const parts: string[] = [];
    if (required.length > 0) parts.push(`The request requires the ${naturalList(required)}`);
    if (optional.length > 0) {
      parts.push(
        required.length > 0
          ? `the ${naturalList(optional)} may also be supplied`
          : `The request accepts the optional ${naturalList(optional)}`,
      );
    }
    add(required.length > 0 && optional.length > 0 ? `${parts[0]}; ${parts[1]}` : parts[0], 2, undefined, ['input']);
  } else if (inline === false && onlyOptional === false) {
    // no inputs
  }
  if (f.request.constraints.length > 0) add(capFirst(naturalList(f.request.constraints)), 3, 'validation');
  if (f.request.partial) add('Fields that are omitted keep their current values', 7.5, 'partial-update');
  if (f.request.defaults.length > 0) {
    add(`By default, a new ${f.resource} ${naturalList(f.request.defaults)}`, 6, 'defaults');
  }

  if (f.relations.length > 0 && f.action.kind !== 'delete') {
    add(`${capFirst(article(f.resource))} ${f.resource} ${naturalList(f.relations)}`, 5.8, undefined, ['schema']);
  }

  // 3. Ownership and initialisation.
  const created: string[] = [];
  if (f.ownerAssigned && !excluded.has('authorization')) {
    const owner = f.resource.split(' ').slice(-1)[0];
    created.push(`The authenticated user becomes the ${owner} owner`);
  }
  if (f.initializations.length > 0 && !excluded.has('initialization')) {
    created.push(`${created.length > 0 ? 'the' : 'The'} new ${f.resource} is initialized with ${naturalList(f.initializations)}`);
  }
  const createdRepresents: Represented[] = [
    ...(f.ownerAssigned && !excluded.has('authorization') ? (['authorization'] as const) : []),
    ...(f.initializations.length > 0 && !excluded.has('initialization') ? (['initialization'] as const) : []),
  ];
  if (created.length > 0) add(created.join(', and '), 1, undefined, createdRepresents);

  // 4. Side effects, written passively and grouped.
  const effects = groupEffects(f.effects.filter((e) => !excluded.has(e.verb === 'set' ? 'state' : 'side-effect')));
  if (!excluded.has('audit')) for (const a of f.auditEntries) effects.push(`${/^[aeiou]/.test(a) ? 'an' : 'a'} ${a} entry is recorded in the audit log`);
  if (!excluded.has('events')) for (const ev of f.events) effects.push(`the ${ev} event is published`);
  if (effects.length > 0) {
    const noun = nominal(f.action.lemma);
    const stated: Represented[] = [
      ...(f.effects.some((e) => e.verb !== 'set' && !excluded.has('side-effect')) ? (['side-effect'] as const) : []),
      ...(f.effects.some((e) => e.verb === 'set' && !excluded.has('state')) ? (['state'] as const) : []),
      ...(f.auditEntries.length > 0 && !excluded.has('audit') ? (['audit'] as const) : []),
      ...(f.events.length > 0 && !excluded.has('events') ? (['events'] as const) : []),
    ];
    add(`As part of ${noun ? `the ${noun}` : 'this operation'}, ${naturalList(effects)}`, 4, undefined, stated);
  }

  // 5. Rules.
  const rules = f.rules;
  if (rules.length > 0) {
    const joined = naturalList(rules.map((r) => r));
    if (joined.length <= 230) add(capFirst(joined), 5, 'rules');
    else rules.forEach((r, i) => add(capFirst(r), 5 + i * 0.1, 'rules'));
  }
  if (f.idempotent) add('The operation is idempotent: repeating it does not cause further changes', 7, 'idempotency');
  const permanent = /^Permanently/.test(f.action.lead);
  f.lifecycle
    .filter((l) => !/does not exist, the request fails$/.test(l) && !(permanent && /soft-deleted:/.test(l)))
    .forEach((l, i) => add(capFirst(l), 5.5 + i * 0.1, undefined, ['state']));

  // 6. Querying and the response.
  if (f.querying.length > 0) {
    add(`Results can be ${naturalList(f.querying)} using the supported query options`, 6, undefined, ['input']);
  }
  const fields = capped(f.response.fields, MAX_RESPONSE_FIELDS);
  const own = singular(f.resource.split(' ').pop() ?? '');
  const related = f.response.related.filter((r) => singular(r.split(' ').pop() ?? '') !== own).slice(0, MAX_RELATED);
  const detail =
    fields.length > 0
      ? `the ${naturalList(fields)}${related.length > 0 ? `, along with the related ${naturalList(related)}` : ''}`
      : related.length > 0
        ? `the related ${naturalList(related)}`
        : '';
  if (f.response.list) {
    if (fields.length > 0) add(`Each item includes ${detail}`, 2.5, undefined, ['result']);
  } else if (f.result) {
    add(`Returns the ${f.result.qualifier}${f.result.text}${detail ? `, including ${detail}` : ''}`, 1.5, undefined, ['result']);
  } else if (detail && f.action.kind !== 'delete') {
    add(`The response includes ${detail}`, 2.5, undefined, ['result']);
  }

  const lead = out[0];
  const rest = out
    .slice(1)
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => a.priority - b.priority)
    .slice(0, SENTENCE_BUDGET[f.depth?.level ?? 'detailed'] - 1)
    .sort((a, b) => a.i - b.i);
  const kept = [lead, ...rest];
  return {
    text: polish(kept.map((s) => s.text).join(' ')),
    sentences: kept.map((s) => ({ text: s.text, represents: s.represents })),
    represented: [...new Set(kept.flatMap((s) => s.represents))].sort(),
    implied: f.existence && !excluded.has('existence') ? ['existence'] : [],
  };
}
