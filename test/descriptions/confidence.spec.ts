// Confidence model: how strongly the source proves a semantic fact, and the
// decisions that depend on it. Synthetic project only.

import { ControllerRegistry } from '../../src/descriptions/controller-registry';
import { ServiceChainIndex } from '../../src/descriptions/service-chain';
import { deriveBusinessFacts, type EndpointBusinessFacts } from '../../src/descriptions/business-facts';
import { reachableFailures, mergeFailures, type Failure } from '../../src/descriptions/error-reachability';
import { failureFromMetadata, failureFromVariant } from '../../src/descriptions/failure-normalizer';
import { assess, meets, observe, tierOfKind } from '../../src/descriptions/confidence';
import { configureConventions, NEUTRAL_CONVENTIONS } from '../../src/descriptions/conventions';
import { failureStatusAdapter } from '../../src/descriptions/adapters/failure-status';
import { persistenceWriteAdapter } from '../../src/descriptions/adapters/persistence-writes';
import type { ChainProfile } from '../../src/descriptions/hop-provider';
import { EMPTY_RESPONSE } from '../../src/descriptions/schema-facts';

const CONTROLLER = `
@Controller('documents')
export class DocumentController {
  constructor(private readonly documents: DocumentService) {}
  @Post(':documentId/cancel')
  cancelDocument(document: Document) { if (!document) throw new NotFoundException('Document not found'); return this.documents.noop(); }
  @Post(':documentId/approve')
  approveDocument() { return this.documents.approve(); }
  @Post(':documentId/archive')
  archiveDocument() { return this.documents.archive(); }
  @Post(':documentId/lock')
  enableDocument() { return this.documents.lock(); }
  @Post(':documentId/unlock')
  disableDocument() { return this.documents.unlock(); }
  @Post(':documentId/remove')
  removeDocument() { return this.documents.remove(); }
  @Post(':documentId/send')
  sendDocument() { return this.documents.send(); }
  @Patch(':documentId')
  updateDocument() { return this.documents.save(); }
  @Patch(':documentId/rename')
  renameDocument() { return this.documents.rename(); }
}`;
const SERVICE = `
export class DocumentService extends Helpers {
  constructor(private readonly documentStore: DocumentStore) {}
  async noop() { return 1; }
  async approve() { throw new NotFoundException('Missing'); }
  async archive(document: Document) { if (document.locked) throw new ConflictException('A locked document cannot be archived'); }
  async lock(document: Document) { this.check('a', document); }
  async unlock(kind: string, document: Document) { this.check(kind, document); }
  async remove(document: Document) { this.lookup(document); }
  async send() { throw new ServiceUnavailableException('Cannot reach the mail relay'); }
  async save(input: DocInput) { await this.documentStore.save({ title: input.title }); }
  async rename(existing: Document, input: DocInput) { Object.assign(existing, input); await this.documentStore.save(existing); }
}`;
const HELPERS = `
export class Helpers {
  check(kind: string, document: Document) {
    if (kind === 'a') throw new ConflictException('Cannot change a kind a document');
    if (kind === 'b') throw new ConflictException('Cannot change a kind b document');
  }
  lookup(document: Document) { if (!document) throw new NotFoundException('Document not found'); }
}`;

const profile: ChainProfile = {
  entryRoot: 'app', entrySuffixes: ['.ts'], ancestorRoot: 'lib', discoverRoots: () => [], providers: [],
  methodAdapters: [failureStatusAdapter(), persistenceWriteAdapter({ receiverSuffixes: ['store'], softDeleteField: 'removedOn', technologyWords: ['store'] })],
  schemaProviders: [],
};

const chainOf = (method: string) => {
  const reg = new ControllerRegistry(profile.methodAdapters);
  reg.scanFile('/virtual/document.controller.ts', CONTROLLER);
  const idx = new ServiceChainIndex(reg, profile);
  idx.scanSource('app', '/virtual/document.service.ts', SERVICE);
  idx.scanSource('lib', '/virtual/helpers.ts', HELPERS);
  return idx.resolve('DocumentController', method);
};
const failuresOf = (method: string): Failure[] => reachableFailures(chainOf(method).steps, `DocumentController.${method}`);
const factsOf = (method: string, httpMethod = 'post'): EndpointBusinessFacts | undefined =>
  deriveBusinessFacts({
    controllerClassName: 'DocumentController', methodName: method, httpMethod, steps: chainOf(method).steps, crud: false,
    hasPagination: false, pathParams: ['documentId'], queryParams: [], response: EMPTY_RESPONSE,
    request: [{ name: 'title', label: 'title', required: false, type: 'string', constraints: [] }],
  });
const level = (f: Failure | undefined) => f?.confidence.level;
const byMessage = (fs: Failure[], m: string) => fs.find((f) => f.thrown.message === m);

beforeAll(() => configureConventions(NEUTRAL_CONVENTIONS));

describe('confidence of failures', () => {
  it('A. a direct observed condition in the operation itself is high', () => {
    const f = byMessage(failuresOf('cancelDocument'), 'Document not found')!;
    expect(f.confidence).toMatchObject({ level: 'high', tier: 'A', directness: 'direct', evidenceStrength: 'strong', scope: 'operation-local' });
  });

  it('B. explicit API metadata is high', () => {
    expect(failureFromMetadata(404, 'Op.run').confidence).toMatchObject({ level: 'high', tier: 'A', directness: 'direct' });
  });

  it('C. an indirect failure through a resolved call is medium: strong evidence, indirect conclusion', () => {
    const f = byMessage(failuresOf('archiveDocument'), 'A locked document cannot be archived')!;
    expect(f.confidence).toMatchObject({ level: 'medium', directness: 'indirect', evidenceStrength: 'strong', scope: 'operation-reachable' });
  });

  it('D/E. a proven literal branch is stronger than an unresolved one', () => {
    const proven = byMessage(failuresOf('enableDocument'), 'Cannot change a kind a document')!;
    expect(proven.branchBasis).toBe('proven-literal');
    expect(proven.confidence.level).toBe('medium');
    const unknown = byMessage(failuresOf('disableDocument'), 'Cannot change a kind a document')!;
    expect(unknown.branchBasis).toBe('unresolved-discriminator');
    expect(unknown.confidence.level).toBe('low');
    expect(meets(proven.confidence, 'medium')).toBe(true);
    expect(meets(unknown.confidence, 'medium')).toBe(false);
  });

  it('a branch the call site proves unreachable is low and not a fact', () => {
    const never = byMessage(failuresOf('enableDocument'), 'Cannot change a kind b document')!;
    expect(never.reach).toBe('unreachable');
    expect(never.confidence.level).toBe('low');
  });

  it('K. an infrastructure failure is never confident enough to be a business fact', () => {
    const f = byMessage(failuresOf('sendDocument'), 'Cannot reach the mail relay')!;
    expect(f.reach).toBe('infrastructure');
    expect(f.confidence.level).toBe('low');
    expect(factsOf('sendDocument')?.ruleFacts ?? []).toEqual([]);
  });

  it('a shared failure with no tying condition is low (uncertain scope)', () => {
    const f = failureFromVariant({ status: 403, message: 'x' }, { operation: 'Op.run', depth: 1, shared: true, path: [], reachedWhen: [] });
    expect(f.confidence).toMatchObject({ level: 'low', scope: 'uncertain' });
  });
});

describe('confidence of other evidence', () => {
  it('F. naming/convention evidence is low and cannot be raised by repetition', () => {
    const naming = (n: number) => observe(Array.from({ length: n }, (_, i) => ({ sourceFile: 'x.ts', line: i, kind: 'name-convention' })), () => ({ depth: 0, shared: false, conditioned: false }));
    expect(tierOfKind('name-convention')).toBe('D');
    expect(assess(naming(1)).level).toBe('low');
    expect(assess(naming(5)).level).toBe('low');
    expect(assess(naming(5), 3).level).toBe('low');
  });

  it('many indirect clues never add up to direct proof', () => {
    const calls = observe(Array.from({ length: 6 }, (_, i) => ({ sourceFile: 'x.ts', line: i, kind: 'service-call' })), () => ({ depth: 2, shared: false, conditioned: false }));
    expect(assess(calls).level).toBe('medium');
    expect(assess(calls).directness).toBe('indirect');
  });
});

describe('confidence gates semantic claims', () => {
  it('I. a direct absence condition gives a high-confidence existence claim', () => {
    const facts = factsOf('cancelDocument')!;
    expect(facts.existence).toMatch(/must already exist/);
    expect(facts.claims.find((c) => c.kind === 'existence')!.confidence).toMatchObject({ level: 'high' });
  });

  it('an indirect absence check is a lower-confidence (medium) existence claim', () => {
    const facts = factsOf('removeDocument')!;
    expect(facts.existence).toMatch(/must already exist/);
    expect(facts.claims.find((c) => c.kind === 'existence')!.confidence!.level).toBe('medium');
  });

  it('J. a not-found without an absence condition gives no existence claim', () => {
    expect(factsOf('approveDocument')?.existence).toBeUndefined();
  });

  it('a rule the source proves only weakly is not stated; the proven one is', () => {
    const rules = (m: string) => factsOf(m)?.ruleFacts.map((r) => r.rule) ?? [];
    expect(rules('enableDocument').length).toBeGreaterThan(0);
    expect(rules('disableDocument')).toEqual([]);
    expect(factsOf('enableDocument')!.ruleFacts[0].confidence.level).toBe('medium');
  });

  it('G. PATCH alone is not a partial update', () => {
    const facts = factsOf('updateDocument', 'patch')!;
    expect(facts.request.partial).toBe(false);
    expect(facts.claims.find((c) => c.kind === 'partial-update')).toBeUndefined();
  });

  it('H. a proven merge is a confident partial-update fact', () => {
    const facts = factsOf('renameDocument', 'patch')!;
    expect(facts.request.partial).toBe(true);
    const claim = facts.claims.find((c) => c.kind === 'partial-update')!;
    expect(meets(claim.confidence!, 'medium')).toBe(true);
    expect(claim.evidence.length).toBeGreaterThan(0);
  });

  it('every stated claim carries a confidence and none below medium survives the gate', () => {
    for (const m of ['cancelDocument', 'enableDocument', 'disableDocument', 'renameDocument', 'removeDocument']) {
      for (const c of factsOf(m, m.startsWith('rename') ? 'patch' : 'post')!.claims) {
        expect(c.confidence).toBeDefined();
        if (['rule', 'existence', 'partial-update', 'side-effect', 'state-change', 'event', 'audit-entry'].includes(c.kind)) expect(meets(c.confidence!, 'medium')).toBe(true);
      }
    }
  });
});

describe('normalised failures keep provenance and independent confidence', () => {
  const scanned = (when: string, message: string, depth: number) =>
    failureFromVariant({ status: 404, message, when }, { operation: 'DocumentController.archiveDocument', depth, shared: false, path: ['DocumentController.archiveDocument'], reachedWhen: [] });

  it('L. the same failure from two analysers is one failure, one deterministic confidence, both provenances', () => {
    const typed = byMessage(failuresOf('archiveDocument'), 'A locked document cannot be archived')!;
    const twin = failureFromVariant(
      { status: 409, message: 'A locked document cannot be archived', when: 'document.locked' },
      { operation: 'DocumentController.archiveDocument', depth: 1, shared: false, path: ['DocumentController.archiveDocument', 'DocumentService.archive'], reachedWhen: [] },
    );
    const merged = mergeFailures([twin, typed]);
    expect(merged).toHaveLength(1);
    expect(merged[0].discoveredBy).toEqual(['runtime-scanner', 'typed-call-graph']);
    expect(merged[0].evidence.length).toBeGreaterThan(0);
    expect(merged[0].aliases).toContain(typed.identity);
    expect(typed.confidence.level).toBe('medium');
    expect(merged[0].confidence.level).toBe('high');
    expect(merged[0].confidence.reasons).toContain('found independently by two analysers');
  });

  it('M. conflicting evidence is neither resolved nor merged: both survive with their own confidence', () => {
    const a = scanned('!entity', 'Gone', 0);
    const b = scanned('entity.isDeleted', 'Gone', 2);
    const out = mergeFailures([a, b]);
    expect(out).toHaveLength(2);
    expect(out.map((f) => [f.condition.text, f.confidence.level]).sort()).toEqual([['!entity', 'high'], ['entity.isDeleted', 'medium']]);
    expect(out.every((f) => f.consequence.status === 404 && f.aliases.length === 1)).toBe(true);
  });

  it('N. confidence and merged result are identical for every input order', () => {
    const typed = byMessage(failuresOf('archiveDocument'), 'A locked document cannot be archived')!;
    const twin = failureFromVariant(
      { status: 409, message: 'A locked document cannot be archived', when: 'document.locked' },
      { operation: 'DocumentController.archiveDocument', depth: 1, shared: false, path: ['DocumentController.archiveDocument', 'DocumentService.archive'], reachedWhen: [] },
    );
    const input = [typed, twin, scanned('!entity', 'Gone', 0), failureFromMetadata(409, 'DocumentController.archiveDocument')];
    const permutations = (xs: Failure[]): Failure[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
    const normal = (fs: Failure[]) => fs.map((f) => JSON.stringify([f.identity, f.confidence, f.discoveredBy])).sort();
    const reference = normal(mergeFailures(input));
    for (const p of permutations(input)) expect(normal(mergeFailures(p))).toEqual(reference);
    expect(level(mergeFailures(input).find((f) => f.origin === 'explicit-api-metadata'))).toBe('high');
  });

  it('framework defaults have their own, explicit confidence', () => {
    const f = failureFromVariant({ status: 401 }, { operation: 'Op.run', depth: 0, shared: false, path: [], reachedWhen: [] }, 'framework-default', 'framework');
    expect(f.confidence).toMatchObject({ level: 'medium', tier: 'B' });
  });
});
