// Conflict detection: do several observations about the SAME semantic fact
// genuinely disagree? Synthetic Document domain; no real project involved.

import * as ts from 'typescript';
import { ControllerRegistry } from '../../src/descriptions/controller-registry';
import { ServiceChainIndex } from '../../src/descriptions/service-chain';
import { deriveBusinessFacts, type EndpointBusinessFacts } from '../../src/descriptions/business-facts';
import { decideResponses, reachableFailures, mergeFailures, type Failure } from '../../src/descriptions/error-reachability';
import { assertionOfFailure, failureConflicts, failureFromMetadata, failureFromVariant } from '../../src/descriptions/failure-normalizer';
import { detectConflicts, exclusiveConditions, withdrawsClaim, type Assertion } from '../../src/descriptions/conflicts';
import { assess, type Confidence } from '../../src/descriptions/confidence';
import { EVIDENCE } from '../../src/descriptions/evidence';
import { configureConventions, NEUTRAL_CONVENTIONS } from '../../src/descriptions/conventions';
import { failureStatusAdapter } from '../../src/descriptions/adapters/failure-status';
import { persistenceConventions, persistenceWriteAdapter } from '../../src/descriptions/adapters/persistence-writes';
import { identitySourceAdapter } from '../../src/descriptions/adapters/identity-source';
import type { MethodFactAdapter } from '../../src/descriptions/method-facts';
import type { AssertionSeed } from '../../src/descriptions/conflicts';
import type { ChainProfile } from '../../src/descriptions/hop-provider';
import { EMPTY_RESPONSE } from '../../src/descriptions/schema-facts';

// ---- generic assertions ----------------------------------------------------------------

const HIGH: Confidence = assess([{ tier: 'A', depth: 0, shared: false, conditioned: false }]);
const MEDIUM: Confidence = assess([{ tier: 'A', depth: 1, shared: false, conditioned: false }]);
const LOW: Confidence = assess([{ tier: 'D', depth: 0, shared: false, conditioned: false }]);

const assertion = (over: Partial<Assertion> & { value: string }): Assertion => ({
  dimension: 'requirement', operation: 'Doc.run', subject: 'caller owns document', cardinality: 'single',
  confidence: HIGH, source: { origin: 'source-failure', discoverer: 'typed-call-graph', path: ['Doc.run'], evidence: [{ sourceFile: 'a.ts', line: 1, kind: EVIDENCE.guard }] },
  ...over,
});
const by = (a: Assertion, discoverer: string, line = 1): Assertion => ({ ...a, source: { ...a.source, discoverer, evidence: [{ sourceFile: `${discoverer}.ts`, line, kind: EVIDENCE.guard }] } });
const kinds = (as: Assertion[]) => detectConflicts(as).map((c) => c.kind);

describe('semantic identity and relations', () => {
  it('A. the same value found twice is a duplicate, never a conflict', () => {
    const cs = detectConflicts([by(assertion({ value: 'affirm' }), 'one'), by(assertion({ value: 'affirm' }), 'two')]);
    expect(cs.map((c) => c.kind)).toEqual(['duplicate']);
    expect(cs[0].severity).toBe('none');
    expect(cs[0].sides[0].sources).toHaveLength(2);
  });

  it('B. affirm vs negate of one fact in one context is a blocking contradiction', () => {
    const [c] = detectConflicts([assertion({ value: 'affirm', confidence: MEDIUM }), assertion({ value: 'negate', confidence: MEDIUM })]);
    expect(c).toMatchObject({ kind: 'contradictory', resolution: 'unresolved', severity: 'blocking' });
    expect(c.prevailing).toBeUndefined();
  });

  it('C. high vs low: the policy resolves it, but the weaker side stays inspectable', () => {
    const [c] = detectConflicts([assertion({ value: 'affirm', confidence: HIGH }), assertion({ value: 'negate', confidence: LOW })]);
    expect(c).toMatchObject({ kind: 'contradictory', resolution: 'resolved', severity: 'advisory', prevailing: 'affirm' });
    const loser = c.sides.find((s) => s.value === 'negate')!;
    expect(loser.confidence.level).toBe('low');
    expect(loser.sources).toHaveLength(1);
  });

  it('C. high vs medium is NOT resolved: "high always wins" is not the policy', () => {
    const [c] = detectConflicts([assertion({ value: 'affirm', confidence: HIGH }), assertion({ value: 'negate', confidence: MEDIUM })]);
    expect(c).toMatchObject({ resolution: 'unresolved', severity: 'blocking' });
  });

  it('D. mutually exclusive branches are compatible, not contradictory', () => {
    expect(kinds([assertion({ value: 'affirm', when: ['ready'] }), assertion({ value: 'negate', when: ['!ready'] })])).toEqual(['compatible']);
    expect(kinds([assertion({ value: 'x', when: ["mode === 'draft'"] }), assertion({ value: 'y', when: ["mode === 'queued'"] })])).toEqual(['compatible']);
    expect(kinds([assertion({ value: 'x', when: ['(a)'] }), assertion({ value: 'y', when: ['!(a)'] })])).toEqual(['compatible']);
  });

  it('D. conditions that merely differ are not proven exclusive: ambiguous, not a contradiction', () => {
    const cs = detectConflicts([assertion({ value: 'affirm', when: ['ready'] }), assertion({ value: 'negate', when: ['signed'] })]);
    expect(cs.map((c) => c.kind)).toEqual(['ambiguous']);
    expect(cs[0].severity).toBe('advisory');
    expect(kinds([assertion({ value: 'affirm' }), assertion({ value: 'negate', when: ['ready'] })])).toEqual(['ambiguous']);
  });

  it('E. the same fact in different operations is independent', () => {
    expect(kinds([assertion({ value: 'affirm', operation: 'Doc.read' }), assertion({ value: 'negate', operation: 'Doc.write' })])).toEqual([]);
  });

  it('F. different subjects or dimensions of one operation are independent', () => {
    expect(kinds([assertion({ value: '404', subject: '!document' }), assertion({ value: '403', subject: '!allowed' })])).toEqual([]);
    expect(kinds([assertion({ value: 'affirm', dimension: 'ownership' }), assertion({ value: 'negate', dimension: 'existence' })])).toEqual([]);
  });

  it('H. outcomes of an open dimension conflict only when proven exclusive', () => {
    const move = (value: string, over: Partial<Assertion> = {}) => assertion({ dimension: 'transition', subject: 'draft ->', cardinality: 'open', value, ...over });
    expect(kinds([move('published'), move('queued')])).toEqual(['compatible']);
    const [c] = detectConflicts([move('published', { excludes: ['queued'] }), move('queued')]);
    expect(c.kind).toBe('contradictory');
    expect(kinds([move('published', { excludes: ['queued'], when: ["s === 'a'"] }), move('queued', { when: ["s === 'b'"] })])).toEqual(['compatible']);
  });

  it('differently labelled statements under one subject are distinct, not rivals', () => {
    expect(kinds([assertion({ value: '404', label: 'Missing' }), assertion({ value: '403', label: 'Denied' })])).toEqual(['compatible']);
  });

  it('exclusive conditions are recognised structurally, not textually', () => {
    expect(exclusiveConditions('a', '!a')).toBe(true);
    expect(exclusiveConditions("k === 'a'", "k === 'b'")).toBe(true);
    expect(exclusiveConditions("k === 'a'", "k !== 'a'")).toBe(true);
    expect(exclusiveConditions('a', 'b')).toBe(false);
    expect(exclusiveConditions("k === 'a'", "j === 'b'")).toBe(false);
    expect(exclusiveConditions('a', 'a')).toBe(false);
  });
});

describe('determinism and provenance', () => {
  const set = [
    by(assertion({ value: 'affirm', confidence: MEDIUM }), 'one', 1),
    by(assertion({ value: 'affirm', confidence: HIGH }), 'two', 2),
    by(assertion({ value: 'negate', confidence: LOW }), 'three', 3),
    by(assertion({ value: 'x', subject: 'other', when: ['p'] }), 'four', 4),
    by(assertion({ value: 'y', subject: 'other', when: ['q'] }), 'five', 5),
  ];
  const permutations = <T,>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));

  it('K. every permutation of the evidence gives the identical result', () => {
    const expected = JSON.stringify(detectConflicts(set));
    const all = permutations(set);
    expect(all).toHaveLength(120);
    for (const p of all) expect(JSON.stringify(detectConflicts(p))).toBe(expected);
  });

  it('L. both sides stay inspectable with origin, evidence, path and confidence', () => {
    const cs = detectConflicts(set).filter((c) => c.subject === 'caller owns document' && c.kind === 'contradictory');
    expect(cs).toHaveLength(1);
    const [c] = cs;
    expect(c.rationale).toMatch(/same requirement fact "caller owns document" of "Doc.run"/);
    for (const side of c.sides) {
      expect(side.sources.length).toBeGreaterThan(0);
      for (const s of side.sources) expect(s.source).toMatchObject({ origin: 'source-failure', path: ['Doc.run'] });
    }
    const affirm = c.sides.find((s) => s.value === 'affirm')!;
    expect(affirm.sources.map((s) => s.source.discoverer)).toEqual(['two', 'one']);
    expect(affirm.confidence.level).toBe('high');
  });

  it('M. explicit metadata does not win by origin: only its confidence takes part', () => {
    const explicit = (value: string, confidence: Confidence) => assertion({ value, confidence, source: { origin: 'explicit-api-metadata', discoverer: 'explicit-metadata', path: [], evidence: [] } });
    expect(detectConflicts([explicit('affirm', HIGH), assertion({ value: 'negate', confidence: HIGH })])[0].resolution).toBe('unresolved');
    expect(detectConflicts([explicit('affirm', LOW), assertion({ value: 'negate', confidence: HIGH })])[0]).toMatchObject({ resolution: 'resolved', prevailing: 'negate' });
  });

  it('a claim is withdrawn when the contradiction is unresolved or resolved against it', () => {
    const fact = { dimension: 'requirement', operation: 'Doc.run', subject: 'caller owns document' };
    const open = detectConflicts([assertion({ value: 'affirm', confidence: MEDIUM }), assertion({ value: 'negate', confidence: MEDIUM })]);
    const decided = detectConflicts([assertion({ value: 'affirm', confidence: HIGH }), assertion({ value: 'negate', confidence: LOW })]);
    expect(withdrawsClaim(open, fact, 'affirm')).toBe(true);
    expect(withdrawsClaim(decided, fact, 'affirm')).toBe(false);
    expect(withdrawsClaim(decided, fact, 'negate')).toBe(true);
    expect(withdrawsClaim([], fact, 'affirm')).toBe(false);
  });
});

// ---- failures and responses (after normalisation) -------------------------------------------

describe('failures', () => {
  const site = (over = {}) => ({ operation: 'Doc.run', depth: 0, shared: false, path: ['Doc.run'], reachedWhen: [] as string[], ...over });
  const variant = (status: number, message: string | undefined, when?: string) => ({ status, ...(message ? { message } : {}), ...(when ? { when } : {}) });
  const failure = (status: number, message: string | undefined, when: string | undefined, by: 'typed-call-graph' | 'runtime-scanner' = 'runtime-scanner', at = site()): Failure =>
    failureFromVariant(variant(status, message, when), at, 'source-failure', by);

  it('F. a missing-resource failure and an access-denied failure are different facts', () => {
    expect(failureConflicts([failure(404, 'Document not found', '!document'), failure(403, 'Not allowed', '!allowed')])).toEqual([]);
  });

  it('G. the same failing condition leading to two statuses is a contradiction', () => {
    const cs = failureConflicts([failure(404, 'Document not found', '!document'), failure(403, 'Document not found', '!document')]);
    expect(cs.map((c) => c.kind)).toEqual(['contradictory']);
    expect(cs[0]).toMatchObject({ dimension: 'failure-response', operation: 'Doc.run', subject: '!document' });
  });

  it('J. two analysers disagreeing is detected after normalisation, from the one Failure model', () => {
    const typed = failure(404, 'Document not found', '!document', 'typed-call-graph');
    const scanned = failure(403, 'Document not found', '!document', 'runtime-scanner');
    const [c] = failureConflicts([typed, scanned]);
    expect(c.kind).toBe('contradictory');
    expect(c.sides.flatMap((s) => s.sources.map((x) => x.source.discoverer)).sort()).toEqual(['runtime-scanner', 'typed-call-graph']);
    // the two failures were not merged: disagreement survives merging with its own confidence
    const merged = mergeFailures([typed, scanned]);
    expect(merged.map((f) => f.consequence.status).sort()).toEqual([403, 404]);
    expect(failureConflicts(merged)).toHaveLength(1);
  });

  it('J. the same finding from two analysers is agreement, not conflict', () => {
    const cs = failureConflicts([failure(404, 'Document not found', '!document', 'typed-call-graph'), failure(404, 'Document not found', '!document', 'runtime-scanner')]);
    expect(cs.map((c) => c.kind)).toEqual(['duplicate']);
  });

  it('N. branch-specific outcomes are not contradictions', () => {
    const a = failure(409, 'Already published', "state === 'draft'");
    const b = failure(422, 'Already published', "state === 'queued'");
    // different failing conditions are different facts: nothing to compare
    expect(failureConflicts([a, b])).toEqual([]);
    expect(failureConflicts([failure(409, 'x', undefined, 'runtime-scanner', site({ reachedWhen: ['ready'] })), failure(422, 'x', undefined, 'runtime-scanner', site({ reachedWhen: ['!ready'] }))]).map((c) => c.kind)).toEqual(['compatible']);
  });

  it('a failure with nothing identifying the fact, or shown unreachable, states nothing', () => {
    expect(assertionOfFailure(failureFromMetadata(404, 'Doc.run'))).toBeUndefined();
    expect(assertionOfFailure(failure(404, undefined, undefined))).toBeUndefined();
  });

  describe('the response decision consults the conflict state', () => {
    const decide = (fs: Failure[], explicit: number[] = []) => decideResponses(fs.map((failure) => ({ item: failure.consequence.status, failure })), new Set(explicit), failureConflicts(fs));
    const unproven = (status: number) => failure(status, 'Document not found', '!document', 'runtime-scanner', site({ depth: 1, path: ['Doc.run', 'Svc.get'] }));

    it('an unresolved contradiction documents both sides, marked contested', () => {
      const d = decide([failure(404, 'Document not found', '!document'), failure(403, 'Document not found', '!document')]);
      expect(d.map((x) => [x.failure.consequence.status, x.keep, x.contested])).toEqual([[404, true, true], [403, true, true]]);
    });

    it('a contradiction the policy resolves drops only the side that lost, with its evidence kept in the conflict', () => {
      const strong = failure(404, 'Document not found', undefined);
      const weak = failure(403, 'Document not found', undefined, 'runtime-scanner', site({ depth: 1, shared: true }));
      expect(strong.confidence.level).toBe('high');
      expect(weak.confidence.level).toBe('low');
      const d = decide([strong, weak]);
      expect(d.find((x) => x.failure === strong)!.keep).toBe(true);
      const lost = d.find((x) => x.failure === weak)!;
      expect(lost.keep).toBe(false);
      expect(lost.reason).toMatch(/better proven/);
      expect(failureConflicts([strong, weak])[0].sides.map((s) => s.value).sort()).toEqual(['403', '404']);
    });

    it('a lost side is kept when the side that won is not itself documented: no fact is left without a response', () => {
      const base = failure(404, 'Document not found', undefined);
      const winner = { ...base, thrown: { ...base.thrown, statusBasis: 'code-mapping' as const } };
      const other = { ...failure(403, 'Document not found', undefined, 'runtime-scanner', site({ depth: 1 })), confidence: LOW };
      const d = decide([winner, other]);
      expect(d.find((x) => x.failure === winner)!.keep).toBe(false);
      expect(d.find((x) => x.failure === other)).toMatchObject({ keep: true, contested: true });
    });

    it('a declared status is never dropped by a lost contradiction', () => {
      const strong = failure(404, 'Document not found', '!document');
      const declared = { ...failure(403, 'Document not found', '!document', 'runtime-scanner', site({ depth: 1, shared: true })), origin: 'explicit-api-metadata' as const };
      expect(decide([strong, declared]).find((x) => x.failure === declared)!.keep).toBe(true);
    });

    it('failures that do not conflict are decided exactly as before', () => {
      const fs = [unproven(404)];
      expect(decideResponses(fs.map((failure) => ({ item: 1, failure })), new Set(), [])[0].keep).toBe(decide(fs)[0].keep);
    });
  });
});

// ---- claims, through the real pipeline -----------------------------------------------------

const CONTROLLER = `
@Controller('documents')
export class DocumentController {
  constructor(private readonly documents: DocumentService) {}
  @Post(':documentId/cancel')
  cancelDocument(document: Document) { if (!document) throw new NotFoundException('Document not found'); return this.documents.noop(); }
  @Patch(':documentId/rename')
  renameDocument() { return this.documents.rename(); }
  @Post(':documentId/store')
  updateDocument() { return this.documents.update(); }
  @Post(':documentId/review')
  reviewDocument(mode: string) { if (mode === 'strict') { throw new ConflictException('A strict review needs a reason'); } else { throw new ForbiddenException('Reviews are closed'); } }
  @Post(':documentId/own')
  createOwnedDocument(ctx: Ctx) { return this.documents.createOwned({ ownerId: ctx.principal.id }); }
}`;
const SERVICE = `
export class DocumentService {
  constructor(private readonly documentStore: DocumentStore, private readonly archiveStore: ArchiveStore) {}
  async noop() { return 1; }
  async rename(existing: Document, input: DocInput) { Object.assign(existing, input); await this.documentStore.save(existing); }
  async update(input: DocInput) { await this.archiveStore.save({ copy: input }); }
  async createOwned(input: DocInput) { await this.documentStore.save(input); }
}`;

// Reads stances from method names; stands in for any adapter that records a
// positive or negative stance about a fact.
const stances: Record<string, AssertionSeed[]> = {};
const stanceAdapter: MethodFactAdapter = {
  name: 'test-stances',
  onMethod: (ctx) => {
    for (const seed of stances[ctx.method.name.getText()] ?? []) ctx.assert(ctx.method, seed.label === 'weak' ? 'name-convention' : EVIDENCE.mergeInput, { ...seed, label: undefined });
  },
};

const STORE = { receiverSuffixes: ['store'], softDeleteField: 'removedOn', technologyWords: ['store'] };
const profile: ChainProfile = {
  entryRoot: 'app', entrySuffixes: ['.ts'], ancestorRoot: 'lib', discoverRoots: () => [], providers: [],
  methodAdapters: [failureStatusAdapter(), persistenceWriteAdapter(STORE), identitySourceAdapter({ requestNames: ['ctx'], property: 'principal', paramDecorators: ['Caller'] }), stanceAdapter],
  schemaProviders: [],
};
const chainOf = (method: string) => {
  const reg = new ControllerRegistry(profile.methodAdapters);
  reg.scanFile('/virtual/document.controller.ts', CONTROLLER);
  const idx = new ServiceChainIndex(reg, profile);
  idx.scanSource('app', '/virtual/document.service.ts', SERVICE);
  return idx.resolve('DocumentController', method);
};
const factsOf = (method: string, httpMethod = 'post'): EndpointBusinessFacts | undefined =>
  deriveBusinessFacts({
    controllerClassName: 'DocumentController', methodName: method, httpMethod, steps: chainOf(method).steps, crud: false,
    hasPagination: false, pathParams: ['documentId'], queryParams: [], response: EMPTY_RESPONSE,
    request: [{ name: 'title', label: 'title', required: false, type: 'string', constraints: [] }],
  });
void ts;

beforeAll(() => configureConventions({ ...NEUTRAL_CONVENTIONS, ...persistenceConventions(STORE) }));
afterEach(() => { for (const k of Object.keys(stances)) delete stances[k]; });

describe('conflict-aware semantic claims', () => {
  const merge = (value: string, weak = false): AssertionSeed => ({ dimension: 'partial-update', subject: 'input', cardinality: 'single', value, ...(weak ? { label: 'weak' } : {}) });

  it('without conflicting evidence nothing is withdrawn and nothing is reported', () => {
    const f = factsOf('renameDocument', 'patch')!;
    expect(f.request.partial).toBe(true);
    expect(f.conflicts?.filter((c) => c.kind === 'contradictory')).toEqual([]);
  });

  it('partial update: an equally strong replace stance contradicts the merge and withdraws the claim', () => {
    stances.rename = [];
    stances.renameDocument = [];
    // the stance is read at the service step, same depth as the merge evidence
    stances.rename = [merge('negate')];
    const f = factsOf('renameDocument', 'patch')!;
    const c = f.conflicts!.find((x) => x.dimension === 'partial-update')!;
    expect(c).toMatchObject({ kind: 'contradictory', resolution: 'unresolved', severity: 'blocking' });
    expect(f.request.partial).toBe(false);
    expect(f.claims.find((x) => x.kind === 'partial-update')).toBeUndefined();
    expect(c.sides.map((s) => s.value).sort()).toEqual(['affirm', 'negate']);
    expect(c.sides.flatMap((s) => s.sources).every((s) => s.source.evidence.length > 0)).toBe(true);
  });

  it('partial update: a weak opposing stance is preserved but does not withdraw a proven merge', () => {
    stances.rename = [merge('negate', true)];
    const f = factsOf('renameDocument', 'patch')!;
    const c = f.conflicts!.find((x) => x.dimension === 'partial-update')!;
    expect(c).toMatchObject({ kind: 'contradictory', resolution: 'resolved', prevailing: 'affirm' });
    expect(c.sides.find((s) => s.value === 'negate')!.confidence.level).toBe('low');
    expect(f.request.partial).toBe(true);
  });

  it('I. persistence: "persisted" vs "not persisted" for the same effect withdraws the effect', () => {
    const base = factsOf('updateDocument')!;
    const effect = base.claims.find((c) => c.kind === 'side-effect' || c.kind === 'state-change')!;
    expect(effect).toBeDefined();
    stances.update = [{ dimension: 'effect', subject: effect.subject!, cardinality: 'single', value: 'negate' }];
    const f = factsOf('updateDocument')!;
    expect(f.conflicts!.find((c) => c.dimension === 'effect')).toMatchObject({ kind: 'contradictory', severity: 'blocking' });
    expect(f.effects.map((e) => `${e.verb} ${e.object}`)).not.toContain(effect.subject);
    expect(f.claims.find((c) => c.subject === effect.subject)).toBeUndefined();
  });

  it('ownership: required vs not required gates the ownership claim', () => {
    expect(factsOf('createOwnedDocument')!.ownerAssigned).toBe(true);
    stances.createOwnedDocument = [{ dimension: 'ownership', subject: 'owner', cardinality: 'single', value: 'negate' }];
    const f = factsOf('createOwnedDocument')!;
    expect(f.conflicts!.find((c) => c.dimension === 'ownership')).toMatchObject({ kind: 'contradictory', severity: 'blocking' });
    expect(f.ownerAssigned).toBe(false);
    expect(f.claims.find((c) => c.kind === 'ownership')).toBeUndefined();
  });

  it('existence: "must exist" vs "valid when absent" withdraws the existence claim', () => {
    expect(factsOf('cancelDocument')!.existence).toMatch(/must already exist/);
    stances.cancelDocument = [{ dimension: 'existence', subject: 'target', cardinality: 'single', value: 'negate' }];
    const f = factsOf('cancelDocument')!;
    expect(f.conflicts!.find((c) => c.dimension === 'existence')).toMatchObject({ kind: 'contradictory', resolution: 'unresolved' });
    expect(f.existence).toBeUndefined();
  });

  it('stances about another operation or another fact do not interfere', () => {
    stances.cancelDocument = [{ dimension: 'existence', subject: 'something else', cardinality: 'single', value: 'negate' }];
    stances.rename = [merge('negate')];
    const f = factsOf('cancelDocument')!;
    expect(f.existence).toMatch(/must already exist/);
    expect(f.conflicts?.filter((c) => c.kind === 'contradictory')).toEqual([]);
  });

  it('N. if/else branches that throw different errors are not contradictory', () => {
    const fs = reachableFailures(chainOf('reviewDocument').steps, 'DocumentController.reviewDocument');
    expect(fs.length).toBeGreaterThanOrEqual(2);
    expect(failureConflicts(fs).filter((c) => c.kind === 'contradictory')).toEqual([]);
  });
});
