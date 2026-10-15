// Presentation conventions a project may register. The core ships neutral
// defaults: with nothing registered, no project word is known. These are the
// two spots where wording depends on knowledge the scanned source does not
// state; they are kept explicit and outside the engine so they stay visible.

import type { Verb } from './business-facts';

export interface DescriptionConventions {
  // Two words naming the same entity in different parts of a source tree.
  entityAliases: ReadonlyArray<readonly [string, string]>;
  // Terms the project writes in capitals wherever they occur (beyond the
  // common technical acronyms the prose layer already knows).
  acronyms: Readonly<Record<string, string>>;
  // Casing for product / proper names that appear inside identifiers.
  properNouns: Readonly<Record<string, string>>;
  // Column / property marking a record as soft-deleted (from the persistence adapter).
  softDeleteField?: string;
  // Receiver-name suffixes of data-access properties (from the persistence adapter).
  dataAccessSuffixes: readonly string[];
  // Technology words dropped when a property name is turned into a noun.
  technologyWords: readonly string[];
  // Words, besides "deleted", that name a view of deleted records.
  deletedViewWords: readonly string[];
  // Verbs a project adds to the generic verb table (idioms the name alone cannot explain).
  verbs: Readonly<Record<string, Verb>>;
}

export const NEUTRAL_CONVENTIONS: DescriptionConventions = {
  entityAliases: [],
  acronyms: {},
  properNouns: {},
  dataAccessSuffixes: [],
  technologyWords: [],
  deletedViewWords: [],
  verbs: {},
};

let active: DescriptionConventions = NEUTRAL_CONVENTIONS;

export const configureConventions = (c: DescriptionConventions = NEUTRAL_CONVENTIONS): void => {
  active = c;
};
export const conventions = (): DescriptionConventions => active;

export const canonicalWord = (word: string): string => {
  for (const [from, to] of active.entityAliases) if (word === from) return to;
  return word;
};
