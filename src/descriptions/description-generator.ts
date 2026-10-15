// Deterministic endpoint descriptions. Pipeline:
//   source facts -> EndpointBusinessFacts (business-facts.ts)
//                -> prose (description-composer.ts)
// Manual documentation always wins: a meaningful JSDoc is used verbatim, and
// the post-processor never overwrites an existing @ApiOperation description.

import { deriveBusinessFacts, controllerNoun } from './business-facts';
import type { EndpointSourceInput } from './business-facts';
import { composeDescription } from './description-composer';

export type DescriptionInput = EndpointSourceInput;
export type { FieldFact, ResponseFacts } from './schema-facts';

function meaningfulJsdoc(jsdoc: string | undefined): string | undefined {
  if (!jsdoc) return undefined;
  const text = jsdoc.trim();
  if (text.split(/\s+/).length < 3 || /^(todo|fixme)\b/i.test(text)) return undefined;
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export interface DetailedDescription {
  text: string;
  /** The source did not prove what the operation does; `text` is the conservative placeholder. */
  fallback: boolean;
  /** Singular-ish noun of the controller ("user account"), for callers that improve the placeholder. */
  noun: string;
}

export function buildDescriptionDetailed(input: DescriptionInput): DetailedDescription {
  const noun = controllerNoun(input.controllerClassName).join(' ');
  const doc = meaningfulJsdoc(input.steps[0]?.info.jsdoc);
  if (doc) return { text: doc, fallback: false, noun };

  const facts = deriveBusinessFacts(input);
  if (!facts) {
    return { text: noun ? `Handles the requested ${noun} operation.` : 'Handles the requested operation.', fallback: true, noun };
  }
  return { text: composeDescription(facts), fallback: false, noun };
}

export function buildDescription(input: DescriptionInput): string {
  return buildDescriptionDetailed(input).text;
}
