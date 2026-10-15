// Provenance for semantic claims. Evidence says where in the source a claim
// comes from; a Fact is a claim plus that evidence. Linguistic transforms
// (plurals, articles, field labels) carry no evidence; business claims do.

export interface Evidence {
  sourceFile: string;
  line?: number;
  kind: string;
  details?: Record<string, unknown>;
}

export interface Fact {
  kind: string;
  // What is claimed, in the words of the source (optional).
  subject?: string;
  evidence: Evidence[];
  // How strongly that evidence proves the claim (see confidence.ts).
  confidence?: import('./confidence').Confidence;
}

// Evidence kinds produced by discovery. A kind names what was observed, not
// what it means.
export const EVIDENCE = {
  serviceCall: 'service-call',
  plainCall: 'plain-call',
  sameClassCall: 'same-class-call',
  throws: 'throw',
  guard: 'guard',
  rpcCall: 'rpc-call',
  actorBoundProperty: 'actor-bound-property',
  actorUse: 'actor-use',
  persistenceWrite: 'persistence-write',
  mergeInput: 'merge-input',
  softDeleteFilter: 'soft-delete-filter',
  eventEmit: 'event-emit',
  auditRecord: 'audit-record',
  idempotenceMarker: 'idempotence-marker',
  entityDeclaration: 'entity-declaration',
  entityField: 'entity-field',
  entityRelation: 'entity-relation',
  jsdoc: 'jsdoc',
} as const;

export const evidenceAt = (node: { getStart(): number; getSourceFile(): { fileName: string; getLineAndCharacterOfPosition(p: number): { line: number } } }, kind: string, details?: Record<string, unknown>): Evidence => {
  const sf = node.getSourceFile();
  return { sourceFile: sf.fileName, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, kind, ...(details ? { details } : {}) };
};

export const sameEvidence = (a: Evidence, b: Evidence): boolean => a.sourceFile === b.sourceFile && a.line === b.line && a.kind === b.kind;

export const dedupeEvidence = (items: Evidence[]): Evidence[] => {
  const out: Evidence[] = [];
  for (const e of items) if (!out.some((o) => sameEvidence(o, e))) out.push(e);
  return out;
};
