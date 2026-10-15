// One normalised Failure model: the typed call graph, the runtime scanner,
// explicit API metadata and framework defaults all emit the same Failure before
// any reachability or relevance decision. Synthetic fixtures only.

import * as path from 'node:path';
import { Test } from '@nestjs/testing';
import { DiscoveryModule, Reflector } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { ControllerRegistry } from '../../src/descriptions/controller-registry';
import { ServiceChainIndex } from '../../src/descriptions/service-chain';
import { RuntimeErrorScanner } from '../../src/descriptions/../errors/scanner';
import { SwaggerDocumentProcessor } from '../../src/descriptions/swagger-engine';
import { decideResponses, mergeFailures, reachableFailures, type Failure } from '../../src/descriptions/error-reachability';
import { failureFromMetadata, failureFromVariant } from '../../src/descriptions/failure-normalizer';
import { failureStatusAdapter } from '../../src/descriptions/adapters/failure-status';
import { NEUTRAL_CONVENTIONS } from '../../src/descriptions/conventions';
import { NEUTRAL_EXAMPLES } from '../../src/descriptions/example-generator';
import { NEUTRAL_SCANNER } from '../../src/descriptions/runtime-errors';
import type { ChainProfile } from '../../src/descriptions/hop-provider';
import type { SwaggerProjectIntegration } from '../../src/descriptions/project-integration';
import { OrderController } from './fixtures/failure-model/order.controller';
import { OrderRepository, OrderService } from './fixtures/failure-model/order.service';

const FIXTURES = path.join(__dirname, '__fixtures__', 'failure-model');

const profile: ChainProfile = {
  entryRoot: 'app',
  entrySuffixes: ['.ts'],
  discoverRoots: () => [],
  providers: [],
  methodAdapters: [failureStatusAdapter()],
  schemaProviders: [],
};

const typedFailures = (method: string): Failure[] => {
  const registry = new ControllerRegistry(profile.methodAdapters);
  registry.build(FIXTURES);
  const index = new ServiceChainIndex(registry, profile);
  index.build(FIXTURES);
  return reachableFailures(index.resolve('OrderController', method).steps, `OrderController.${method}`).filter((f) => f.consequence.status !== undefined);
};

const controller = (): OrderController => new OrderController(new OrderService(new OrderRepository()));
const scannedFailures = (method: string): Failure[] =>
  new RuntimeErrorScanner().scanEndpoint(controller(), method).flatMap((v) => (v.failure ? [v.failure] : []));

const messages = (fs: Failure[]): (string | undefined)[] => fs.map((f) => f.thrown.message).sort();

describe('normalised failure: discovery by either analyser', () => {
  it('A. the same failure found by both analysers becomes one, remembering both', () => {
    const merged = mergeFailures([...scannedFailures('find'), ...typedFailures('find')]);
    const notFound = merged.filter((f) => f.thrown.message === 'Order not found');
    expect(notFound).toHaveLength(1);
    expect(notFound[0].discoveredBy).toEqual(['runtime-scanner', 'typed-call-graph']);
    expect(notFound[0].aliases.length).toBeGreaterThanOrEqual(1);
    expect(notFound[0].consequence.status).toBe(404);
    expect(notFound[0].condition).toMatchObject({ text: '!order', strength: 'observed' });
  });

  it('B. a failure only the typed analyser found still carries evidence and is relevant', () => {
    const f = typedFailures('find').find((x) => x.thrown.message === 'Order not found')!;
    expect(f.discoveredBy).toEqual(['typed-call-graph']);
    expect(f.evidence.length).toBeGreaterThan(0);
    expect(f.relevant).toBe(true);
    expect(decideResponses([{ item: 1, failure: f }])[0].keep).toBe(true);
  });

  it('C. a failure only the scanner found is documentable as a response', () => {
    const only = scannedFailures('find').find((x) => x.thrown.message === 'Order not found')!;
    expect(only.discoveredBy).toEqual(['runtime-scanner']);
    expect(decideResponses([{ item: 1, failure: only }])[0].keep).toBe(true);
  });

  it('L. an unrelated operation never inherits another operation’s failure, even with the same message', () => {
    const a = failureFromVariant({ status: 404, message: 'Order not found', when: '!order' }, { operation: 'OrderController.find', depth: 1, shared: false, path: [], reachedWhen: [] });
    const b = failureFromVariant({ status: 404, message: 'Order not found', when: '!order' }, { operation: 'OrderController.sibling', depth: 1, shared: false, path: [], reachedWhen: [] });
    expect(a.identity).not.toBe(b.identity);
    expect(mergeFailures([a, b])).toHaveLength(2);
    expect(scannedFailures('sibling')).toEqual([]);
  });

  it('a message the typed read could not see (template) still merges with a scanned one under the same condition', () => {
    const scanned = failureFromVariant({ status: 409, message: 'Order 7 is taken', when: 'taken' }, { operation: 'Op.run', depth: 1, shared: false, path: [], reachedWhen: [] });
    const typed = { ...failureFromVariant({ status: 409, when: 'taken' }, { operation: 'Op.run', depth: 1, shared: false, path: [], reachedWhen: [] }), discoveredBy: ['typed-call-graph' as const] };
    const merged = mergeFailures([scanned, typed]);
    expect(merged).toHaveLength(1);
    expect(merged[0].thrown.message).toBe('Order 7 is taken');
  });

  it('unconditional failures with different messages are different failures', () => {
    const at = { operation: 'Op.run', depth: 1, shared: false, path: [] as string[], reachedWhen: [] as string[] };
    expect(mergeFailures([failureFromVariant({ status: 409, message: 'X' }, at), failureFromVariant({ status: 409, message: 'Y' }, at)])).toHaveLength(2);
  });

  it('N. merging is deterministic and order does not change the failure set', () => {
    const inputs = [...scannedFailures('find'), ...typedFailures('find')];
    const once = JSON.stringify(mergeFailures(inputs));
    expect(JSON.stringify(mergeFailures(inputs))).toBe(once);
    const reversed = mergeFailures([...inputs].reverse());
    expect(reversed.map((f) => f.aliases.slice().sort().join('|')).sort()).toEqual(mergeFailures(inputs).map((f) => f.aliases.slice().sort().join('|')).sort());
  });
});

describe('normalised failure: deduplication identity', () => {
  const at = (operation: string) => ({ operation, depth: 1, shared: false, path: [] as string[], reachedWhen: [] as string[] });
  const f = (v: Parameters<typeof failureFromVariant>[0], operation = 'Op.run') => failureFromVariant(v, at(operation));

  it('explicit metadata is never merged into (or absorbed by) a source failure with the same status', () => {
    const merged = mergeFailures([f({ status: 404 }), failureFromMetadata(404, 'Op.run'), f({ status: 404, message: 'Gone' })]);
    expect(merged.filter((x) => x.origin === 'explicit-api-metadata')).toHaveLength(1);
    expect(merged.find((x) => x.origin === 'explicit-api-metadata')!.discoveredBy).toEqual(['explicit-metadata']);
    expect(merged).toHaveLength(3);
  });

  it('different conditions and incompatible messages stay separate; provenance survives merging', () => {
    expect(mergeFailures([f({ status: 409, message: 'M', when: 'a' }), f({ status: 409, message: 'M', when: 'b' })])).toHaveLength(2);
    expect(mergeFailures([f({ status: 409, message: 'M1', when: 'a' }), f({ status: 409, message: 'M2', when: 'a' })])).toHaveLength(2);
    const typed = { ...f({ status: 409, message: 'M', when: 'a' }), discoveredBy: ['typed-call-graph' as const] };
    const merged = mergeFailures([f({ status: 409, message: 'M', when: 'a' }), typed]);
    expect(merged[0].discoveredBy).toEqual(['runtime-scanner', 'typed-call-graph']);
    expect(merged[0].aliases.length).toBeGreaterThanOrEqual(1);
  });

  it('the merged set is identical for every input order', () => {
    const typed = { ...f({ status: 409, when: 'a' }), discoveredBy: ['typed-call-graph' as const] };
    const input = [f({ status: 409, message: 'One', when: 'a' }), typed, f({ status: 409, message: 'Two', when: 'a' }), failureFromMetadata(409, 'Op.run'), f({ status: 404, message: 'Z' })];
    const permutations = (xs: Failure[]): Failure[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
    const normal = (fs: Failure[]) => fs.map((x) => JSON.stringify(x)).sort();
    const reference = normal(mergeFailures(input));
    for (const p of permutations(input)) expect(normal(mergeFailures(p))).toEqual(reference);
  });
});

describe('normalised failure: classification is the same for both analysers', () => {
  const at = (over: Partial<{ depth: number; shared: boolean; reachedWhen: string[] }>) => ({ operation: 'Op.run', depth: 1, shared: false, path: [] as string[], reachedWhen: [] as string[], ...over });

  it('D/E. direct and indirect failures are reachable and relevant', () => {
    expect(failureFromVariant({ status: 404, message: 'x' }, at({ depth: 0 })).reach).toBe('direct');
    const indirect = failureFromVariant({ status: 404, message: 'x' }, at({ depth: 2 }));
    expect(indirect.reach).toBe('indirect');
    expect(indirect.relevant).toBe(true);
  });

  it('F/G. a shared failure needs an observed condition or branch path; without one it is not relevant', () => {
    expect(failureFromVariant({ status: 403, message: 'x', when: '!ok' }, at({ shared: true })).relevant).toBe(true);
    expect(failureFromVariant({ status: 403, message: 'x' }, at({ shared: true, reachedWhen: ["mode === 'a'"] })).relevant).toBe(true);
    expect(failureFromVariant({ status: 403, message: 'x' }, at({ shared: true })).relevant).toBe(false);
  });

  it('H. an infrastructure failure never becomes a rule, and is a response only when specific', () => {
    const bare = failureFromVariant({ status: 500, kind: 'InternalServerErrorException' }, at({ depth: 0 }));
    expect(bare.reach).toBe('infrastructure');
    expect(bare.relevant).toBe(false);
    expect(decideResponses([{ item: 1, failure: bare }])[0].keep).toBe(false);
    const specific = failureFromVariant({ status: 500, message: 'Storage rejected the write' }, at({ depth: 0 }));
    expect(specific.relevant).toBe(false);
    expect(decideResponses([{ item: 1, failure: specific }])[0].keep).toBe(true);
  });

  it('typed and scanner readings of one throw classify identically', () => {
    const typed = typedFailures('find').find((x) => x.thrown.message === 'Order not found')!;
    const scanned = scannedFailures('find').find((x) => x.thrown.message === 'Order not found')!;
    expect([typed.reach, typed.condition, typed.relevant]).toEqual([scanned.reach, scanned.condition, scanned.relevant]);
  });
});

describe('normalised failure: branch-specific shared helpers', () => {
  const kept = (fs: Failure[]): (string | undefined)[] => messages(fs.filter((f) => f.reach !== 'unreachable'));
  const proven = (fs: Failure[]): (string | undefined)[] => messages(fs.filter((f) => f.reach === 'unreachable'));

  it('I. scanner: helper(`a`) keeps only the failure its literal can reach', () => {
    const fs = scannedFailures('kindA');
    expect(kept(fs)).toEqual(['Kind a']);
    expect(proven(fs)).toEqual(['Kind b']);
    expect(kept(scannedFailures('kindB'))).toEqual(['Kind b']);
  });

  it('I. typed analyser reaches the same conclusion for the same source', () => {
    expect(kept(typedFailures('kindA'))).toEqual(['Kind a']);
    expect(kept(typedFailures('kindB'))).toEqual(['Kind b']);
  });

  it('I. module-level helper function is narrowed the same way', () => {
    const fs = scannedFailures('moduleKindA');
    expect(kept(fs)).toEqual(['Module kind a']);
    expect(proven(fs)).toEqual(['Module kind b']);
  });

  it('J. a non-literal argument proves nothing: both failures stay reachable', () => {
    expect(kept(scannedFailures('kindUnknown'))).toEqual(['Kind a', 'Kind b']);
    expect(kept(typedFailures('kindUnknown'))).toEqual(['Kind a', 'Kind b']);
  });

  it('J. one method calling the helper with two different literals keeps both', () => {
    expect(kept(scannedFailures('bothKinds'))).toEqual(['Kind a', 'Kind b']);
  });

  it('J. two paths reaching the same helper with different literals keep both (no first-visit shadowing)', () => {
    expect(kept(scannedFailures('chained'))).toEqual(['Kind a', 'Kind b']);
  });

  it('the two analysers agree, merged: a proven-unreachable failure stays unreachable', () => {
    const merged = mergeFailures([...scannedFailures('kindA'), ...typedFailures('kindA')]);
    expect(kept(merged)).toEqual(['Kind a']);
    expect(proven(merged)).toEqual(['Kind b']);
    expect(decideResponses(merged.map((failure) => ({ item: failure.thrown.message, failure }))).filter((d) => d.keep).map((d) => d.item)).toEqual(['Kind a']);
  });
});

describe('response candidates by provenance', () => {
  it('K. an explicitly declared status is its own provenance and is never dropped', () => {
    const declared = failureFromMetadata(418, 'Op.run');
    expect(declared.origin).toBe('explicit-api-metadata');
    expect(declared.discoveredBy).toEqual(['explicit-metadata']);
    expect(decideResponses([{ item: 1, failure: declared }])[0].keep).toBe(true);
  });

  it('a status only derived from a conventional code table is not asserted on its own', () => {
    const f = failureFromVariant({ status: 404, message: 'Gone' }, { operation: 'Op.run', depth: 1, shared: false, path: [], reachedWhen: [] });
    const mapped = { ...f, thrown: { ...f.thrown, statusBasis: 'code-mapping' as const }, discoveredBy: ['typed-call-graph' as const] };
    expect(decideResponses([{ item: 1, failure: mapped }])[0].keep).toBe(false);
    expect(decideResponses([{ item: 1, failure: { ...mapped, discoveredBy: ['runtime-scanner', 'typed-call-graph'] } }])[0].keep).toBe(true);
  });
});

// Engine-level: real Nest app, real OpenAPI document, the engine's own pipeline.
describe('engine: explicit metadata and normalised failures end to end', () => {
  let doc: OpenAPIObject;
  const project: SwaggerProjectIntegration = {
    sourceRoot: () => FIXTURES,
    dtoDeclarationRoot: () => undefined,
    dtoClasses: () => ({}),
    readHandlerMetadata: () => ({ isPublic: true, requiredPermissions: [], resourceClass: undefined }),
    chainProfile: () => profile,
    conventions: NEUTRAL_CONVENTIONS,
    examples: NEUTRAL_EXAMPLES,
    createErrorScanner: () => new RuntimeErrorScanner(NEUTRAL_SCANNER),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      controllers: [OrderController],
      providers: [OrderService, OrderRepository],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('t').setVersion('1').build());
    new SwaggerDocumentProcessor(app.get(Reflector), app, { excludeControllers: [], excludeEndpoints: [] }, project).process(doc);
    await app.close();
  });

  const responses = (route: string, verb: 'get' | 'post'): Record<string, { description?: string }> =>
    (doc.paths[route][verb] as unknown as { responses: Record<string, { description?: string }> }).responses;

  it('K. an explicit @ApiResponse stays, keeps its own text, and gains the proven source failure', () => {
    const r = responses('/orders/{id}', 'get')['404'];
    expect(r.description).toContain('Declared: the order cannot be found');
    expect(r.description).toContain('Order not found');
  });

  it('K. an explicit status that no source failure produces is still documented', () => {
    expect(responses('/orders/declared-only', 'post')['418'].description).toContain('Declared: teapot');
  });

  it('L. an unrelated sibling operation documents none of the other operation’s failures', () => {
    const r = responses('/orders/sibling', 'post');
    expect(Object.keys(r)).not.toContain('404');
    expect(Object.keys(r)).not.toContain('409');
  });

  it('I. each operation documents only the helper failure its own literal reaches', () => {
    const a = responses('/orders/kind-a', 'post')['409'].description ?? '';
    const b = responses('/orders/kind-b', 'post')['409'].description ?? '';
    expect(a).toContain('Kind a');
    expect(a).not.toContain('Kind b');
    expect(b).toContain('Kind b');
    expect(b).not.toContain('Kind a');
  });

  it('J. when the argument is not a literal, both are documented', () => {
    const r = responses('/orders/kind-unknown', 'post')['409'].description ?? '';
    expect(r).toContain('Kind a');
    expect(r).toContain('Kind b');
  });

  it('N. the whole document is deterministic across runs of the engine', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DiscoveryModule], controllers: [OrderController], providers: [OrderService, OrderRepository] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const again = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('t').setVersion('1').build());
    new SwaggerDocumentProcessor(app.get(Reflector), app, { excludeControllers: [], excludeEndpoints: [] }, project).process(again);
    await app.close();
    expect(JSON.stringify(again.paths)).toBe(JSON.stringify(doc.paths));
  });
});
