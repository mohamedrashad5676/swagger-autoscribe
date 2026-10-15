// Adaptive description depth: how much contract the evidence justifies.
// Synthetic neutral domain; depth is tested apart from prose wording.

import { assess, type Confidence } from '../../src/descriptions/confidence';
import { decideDepth, type DepthInput } from '../../src/descriptions/depth';
import type { Fact } from '../../src/descriptions/evidence';
import { composeDescription } from '../../src/descriptions/description-composer';
import { deriveBusinessFacts, type EndpointBusinessFacts } from '../../src/descriptions/business-facts';
import { ControllerRegistry } from '../../src/descriptions/controller-registry';
import { ServiceChainIndex } from '../../src/descriptions/service-chain';
import { configureConventions, NEUTRAL_CONVENTIONS } from '../../src/descriptions/conventions';
import { failureStatusAdapter } from '../../src/descriptions/adapters/failure-status';
import { persistenceConventions, persistenceWriteAdapter } from '../../src/descriptions/adapters/persistence-writes';
import { EVIDENCE } from '../../src/descriptions/evidence';
import { EMPTY_RESPONSE } from '../../src/descriptions/schema-facts';
import type { MethodFactAdapter } from '../../src/descriptions/method-facts';
import type { AssertionSeed } from '../../src/descriptions/conflicts';
import type { ChainProfile } from '../../src/descriptions/hop-provider';

const HIGH: Confidence = assess([{ tier: 'A', depth: 0, shared: false, conditioned: false }]);
const MEDIUM: Confidence = assess([{ tier: 'A', depth: 1, shared: false, conditioned: false }]);
const LOW: Confidence = assess([{ tier: 'D', depth: 0, shared: false, conditioned: false }]);
const claim = (kind: string, confidence: Confidence, subject = kind): Fact => ({ kind, subject, evidence: [{ sourceFile: 'a.ts', line: 1, kind: EVIDENCE.throws }], confidence });
const depth = (over: Partial<DepthInput> = {}) => decideDepth({ claims: [], constraints: [], ...over });

describe('depth levels from semantic coverage', () => {
  it('A. no reliable behavioural dimension is minimal', () => {
    expect(depth()).toMatchObject({ level: 'minimal', dimensions: [], strongest: 'low' });
  });

  it('B. reliable evidence in one family is standard', () => {
    expect(depth({ constraints: ['x must be set'] }).level).toBe('standard');
    expect(depth({ claims: [claim('existence', MEDIUM), claim('rule', MEDIUM)] }).level).toBe('standard');
  });

  it('C/G. reliable evidence across families, strongly proven, is detailed', () => {
    const d = depth({ constraints: ['x'], claims: [claim('ownership', HIGH), claim('state-change', MEDIUM)] });
    expect(d).toMatchObject({ level: 'detailed', families: ['access', 'input', 'outcome'], strongest: 'high' });
    expect(d.reasons[0]).toMatch(/3 families/);
  });

  it('F. one strong fact is not enough, however strong', () => {
    expect(depth({ claims: [claim('ownership', HIGH)] }).level).toBe('standard');
  });

  it('several families without any high-confidence dimension stay standard', () => {
    const d = depth({ claims: [claim('ownership', MEDIUM), claim('event', MEDIUM, 'created')] });
    expect(d.level).toBe('standard');
    expect(d.reasons[0]).toMatch(/high/);
  });

  it('coverage beats count: many facts in one dimension count once', () => {
    const many = Array.from({ length: 8 }, (_, i) => claim('rule', HIGH, `rule ${i}`));
    expect(depth({ claims: many }).level).toBe('standard');
    expect(depth({ claims: [claim('rule', HIGH), claim('event', HIGH)] }).level).toBe('detailed');
  });

  it('K/L/M/N. each contract dimension contributes', () => {
    for (const [kind, dim] of [['partial-update', 'partial-update'], ['ownership', 'authorization'], ['state-change', 'state'], ['side-effect', 'side-effect'], ['audit-entry', 'audit'], ['idempotence', 'idempotency']] as const) {
      expect(depth({ claims: [claim(kind, HIGH)] }).dimensions).toEqual([dim]);
    }
  });

  it('O. specific, confident failures count; generic or weak ones do not', () => {
    expect(depth({ failures: [{ confidence: HIGH, specific: true }] }).dimensions).toEqual(['failures']);
    expect(depth({ failures: [{ confidence: HIGH, specific: false }, { confidence: LOW, specific: true }, { confidence: HIGH, specific: true, contested: true }] }).level).toBe('minimal');
  });
});

describe('what must NOT raise depth', () => {
  it('D. many low-confidence observations never inflate depth; they are listed as excluded', () => {
    const weak = ['ownership', 'state-change', 'side-effect', 'event', 'audit-entry', 'idempotence', 'initialization'].map((k) => claim(k, LOW));
    const d = depth({ claims: weak });
    expect(d.level).toBe('minimal');
    expect(d.excluded.map((e) => e.dimension).sort()).toEqual(['audit', 'authorization', 'events', 'idempotency', 'initialization', 'side-effect', 'state']);
    expect(d.excluded.every((e) => e.reason === 'low-confidence')).toBe(true);
  });

  it('E. a withdrawn disputed claim is excluded and named as disputed', () => {
    const d = depth({ claims: [claim('event', MEDIUM, 'sent')], withdrawn: [{ kind: 'ownership', reason: 'disputed' }] });
    expect(d.dimensions).toEqual(['events']);
    expect(d.excluded).toEqual([{ dimension: 'authorization', reason: 'disputed' }]);
  });

  it('H. implementation-level claims carry no dimension', () => {
    const d = depth({ claims: ['relation', 'unique-constraint', 'soft-delete-filter', 'unknown-kind'].map((k) => claim(k, HIGH)) });
    expect(d.level).toBe('minimal');
    expect(d.dimensions).toEqual([]);
  });
});

describe('determinism', () => {
  const claims = [claim('ownership', HIGH), claim('state-change', MEDIUM), claim('event', LOW), claim('rule', MEDIUM, 'r1'), claim('rule', HIGH, 'r2')];
  const permutations = <T,>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
  it('P. every ordering of the evidence gives the same decision', () => {
    const expected = JSON.stringify(depth({ constraints: ['c'], claims }));
    for (const p of permutations(claims)) expect(JSON.stringify(depth({ constraints: ['c'], claims: p }))).toBe(expected);
  });
});

// ---- through the real pipeline ----------------------------------------------------------

const CONTROLLER = `
@Controller('orders')
export class OrderController {
  constructor(private readonly orders: OrderService) {}
  @Post('a') cancelOrder(order: Order) { if (!order) throw new NotFoundException('Order not found'); return this.orders.noop(); }
  @Post('b') updateOrder() { return this.orders.update(); }
  @Post('c') updateItem() { return this.orders.noop(); }
}`;
const SERVICE = `
export class OrderService {
  constructor(private readonly archiveStore: ArchiveStore) {}
  async noop() { return 1; }
  async update(input: Input) { await this.archiveStore.save({ copy: input }); this.logger.log('x'); this.helper.format(input); }
}`;
const STORE = { receiverSuffixes: ['store'], softDeleteField: 'removedOn', technologyWords: ['store'] };
const stances: Record<string, AssertionSeed[]> = {};
const stanceAdapter: MethodFactAdapter = {
  name: 'stances',
  onMethod: (ctx) => { for (const s of stances[ctx.method.name.getText()] ?? []) ctx.assert(ctx.method, EVIDENCE.mergeInput, s); },
};
const profile: ChainProfile = {
  entryRoot: 'app', entrySuffixes: ['.ts'], ancestorRoot: 'lib', discoverRoots: () => [], providers: [],
  methodAdapters: [failureStatusAdapter(), persistenceWriteAdapter(STORE), stanceAdapter], schemaProviders: [],
};
const factsOf = (method: string): EndpointBusinessFacts | undefined => {
  const reg = new ControllerRegistry(profile.methodAdapters);
  reg.scanFile('/virtual/order.controller.ts', CONTROLLER);
  const idx = new ServiceChainIndex(reg, profile);
  idx.scanSource('app', '/virtual/order.service.ts', SERVICE);
  return deriveBusinessFacts({
    controllerClassName: 'OrderController', methodName: method, httpMethod: 'post', steps: idx.resolve('OrderController', method).steps, crud: false,
    hasPagination: false, pathParams: ['orderId'], queryParams: [], response: EMPTY_RESPONSE, request: [],
  });
};
beforeAll(() => configureConventions({ ...NEUTRAL_CONVENTIONS, ...persistenceConventions(STORE) }));
afterEach(() => { for (const k of Object.keys(stances)) delete stances[k]; });

describe('depth in the pipeline', () => {
  it('H. calls, logging and helpers add nothing: an operation with only implementation detail is minimal', () => {
    expect(factsOf('updateOrder')!.depth).toMatchObject({ level: 'standard', dimensions: ['side-effect'] });
    expect(factsOf('updateItem')?.depth?.level ?? 'minimal').toBe('minimal');
  });

  it('a direct absence check is one reliable dimension: standard', () => {
    expect(factsOf('cancelOrder')!.depth).toMatchObject({ level: 'standard', dimensions: ['existence'], families: ['access'] });
  });

  it('I. a stance recorded for another operation never changes this one', () => {
    const before = JSON.stringify(factsOf('cancelOrder')!.depth);
    stances.updateOrder = [{ dimension: 'existence', subject: 'target', cardinality: 'single', value: 'negate' }];
    expect(JSON.stringify(factsOf('cancelOrder')!.depth)).toBe(before);
  });

  it('E. an unresolved contradiction removes the disputed dimension from depth and from the description', () => {
    const base = factsOf('cancelOrder')!;
    expect(base.depth!.dimensions).toContain('existence');
    stances.cancelOrder = [{ dimension: 'existence', subject: 'target', cardinality: 'single', value: 'negate' }];
    const f = factsOf('cancelOrder')!;
    expect(f.existence).toBeUndefined();
    expect(f.depth!.dimensions).not.toContain('existence');
    expect(f.depth!.excluded).toContainEqual({ dimension: 'existence', reason: 'disputed' });
    expect(f.withdrawn).toContainEqual(expect.objectContaining({ kind: 'existence', reason: 'disputed' }));
  });
});

describe('composition consumes the decision', () => {
  const facts = (over: Partial<EndpointBusinessFacts>): EndpointBusinessFacts => ({
    action: { lead: 'Updates', kind: 'update', lemma: 'update' }, resource: 'order', target: 'the order',
    request: { required: [], optional: [], constraints: [], defaults: [], partial: false }, ownerAssigned: false, initializations: [],
    effects: [], auditEntries: [], events: [], rules: [], ruleFacts: [], idempotent: false, lifecycle: [], relations: [], querying: [],
    response: { list: false, paginated: false, fields: [], related: [] }, claims: [], ...over,
  });
  const text = (f: EndpointBusinessFacts) => composeDescription({ ...f, depth: decideDepth({ claims: f.claims, constraints: f.request.constraints, withdrawn: f.withdrawn }) });

  it('a sentence about a dimension whose evidence is only weak is not written', () => {
    const f = facts({ idempotent: true, events: ['shipped'], claims: [claim('idempotence', LOW), claim('event', LOW, 'shipped')] });
    const out = text(f);
    expect(out).not.toMatch(/idempotent/);
    expect(out).not.toMatch(/shipped/);
  });

  it('the same sentence is written when the evidence is reliable', () => {
    const f = facts({ idempotent: true, claims: [claim('idempotence', MEDIUM)] });
    expect(text(f)).toMatch(/idempotent/);
  });

  it('depth never adds facts: a detailed decision with nothing supported says only the lead', () => {
    expect(text(facts({}))).toBe('Updates the order.');
  });
});
