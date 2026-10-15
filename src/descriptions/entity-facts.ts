// Persistent-resource facts, independent of how they were declared. A
// SchemaProvider (an ORM adapter) reads a class and returns these facts with
// evidence; the engine never looks at decorators itself.

import type * as ts from 'typescript';
import type { Evidence } from './evidence';

export interface EntityField {
  name: string;
  type: string;
  optional: boolean;
  unique: boolean;
  // `default: <literal>` text from the column / prop options.
  defaultValue?: string;
  enumType?: string;
  relation?: { kind: string; target?: string };
}

// Persistent resource facts (a table / collection and its fields).
export interface EntityFacts {
  className: string;
  table?: string;
  fields: EntityField[];
  softDelete: boolean;
  // `static response = { relations: [...] }`: related data embedded in responses.
  responseRelations: string[];
  // Where each entity claim was declared.
  evidence: Evidence[];
}

export interface SchemaProvider {
  readonly name: string;
  // Facts for `cls` when it declares a persistent resource.
  readEntity(cls: ts.ClassLikeDeclaration): EntityFacts | undefined;
  // Candidate class names for a generic type argument naming an entity
  // (e.g. a document alias -> the schema class), in preference order.
  entityClassNames(typeArg: string): string[];
}
