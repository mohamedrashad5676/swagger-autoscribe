// Test harness for the synthetic fixture suite. It runs virtual source through
// the real pipeline (registry -> chain -> analysers -> facts -> confidence ->
// conflicts -> depth -> prose). Which adapters a project uses is declared here,
// in the fixture layer: the generic core is never told.

import { ControllerRegistry } from '../../../../src/descriptions/controller-registry';
import { ServiceChainIndex } from '../../../../src/descriptions/service-chain';
import { deriveBusinessFacts, type EndpointBusinessFacts } from '../../../../src/descriptions/business-facts';
import { composeStructured, type StructuredDescription } from '../../../../src/descriptions/description-composer';
import { reachableFailures, type Failure } from '../../../../src/descriptions/error-reachability';
import { failureConflicts } from '../../../../src/descriptions/failure-normalizer';
import { failureStatusAdapter } from '../../../../src/descriptions/adapters/failure-status';
import { persistenceConventions, persistenceWriteAdapter } from '../../../../src/descriptions/adapters/persistence-writes';
import { identitySourceAdapter } from '../../../../src/descriptions/adapters/identity-source';
import { signalMarkersAdapter } from '../../../../src/descriptions/adapters/signal-markers';
import { configureConventions, NEUTRAL_CONVENTIONS } from '../../../../src/descriptions/conventions';
import { EMPTY_RESPONSE, type FieldFact } from '../../../../src/descriptions/schema-facts';
import type { MethodFactAdapter } from '../../../../src/descriptions/method-facts';
import type { AssertionSeed, Conflict } from '../../../../src/descriptions/conflicts';
import type { ChainProfile } from '../../../../src/descriptions/hop-provider';
import { EVIDENCE } from '../../../../src/descriptions/evidence';

export const STORE = { receiverSuffixes: ['store'], softDeleteField: 'removedOn', technologyWords: ['store'] };
export const useSyntheticConventions = (): void => configureConventions({ ...NEUTRAL_CONVENTIONS, ...persistenceConventions(STORE) });

// A stance adapter: stands in for any analyser that records a positive or
// negative stance about a fact (see conflicts.ts).
export const stances: Record<string, AssertionSeed[]> = {};
export const clearStances = (): void => { for (const k of Object.keys(stances)) delete stances[k]; };
const stanceAdapter: MethodFactAdapter = {
  name: 'fixture-stances',
  onMethod: (ctx) => { for (const s of stances[ctx.method.name.getText()] ?? []) ctx.assert(ctx.method, s.label === 'weak' ? 'name-convention' : EVIDENCE.mergeInput, { ...s, label: undefined }); },
};

export const field = (name: string, required: boolean, constraints: FieldFact['constraints'] = []): FieldFact => ({ name, label: name, required, type: 'string', constraints });

export interface Sources { controller: string; app?: string; shared?: string }
export interface Run {
  facts?: EndpointBusinessFacts;
  text?: string;
  structured?: StructuredDescription;
  failures: Failure[];
  conflicts: Conflict[];
}

// Every run made by the suite, for cross-fixture invariants.
export const runs: { name: string; run: Run }[] = [];

export function project(src: Sources, controllerClass: string) {
  const profile: ChainProfile = {
    entryRoot: 'app', entrySuffixes: ['.ts'], ancestorRoot: 'lib', discoverRoots: () => [], providers: [],
    methodAdapters: [
      failureStatusAdapter(), persistenceWriteAdapter(STORE), signalMarkersAdapter(),
      identitySourceAdapter({ requestNames: ['ctx'], property: 'principal', paramDecorators: ['Caller'] }), stanceAdapter,
    ],
    schemaProviders: [],
  };
  return (method: string, opts: { http?: string; request?: FieldFact[]; pathParams?: string[] } = {}): Run => {
    const reg = new ControllerRegistry(profile.methodAdapters);
    reg.scanFile('/virtual/x.controller.ts', src.controller);
    const idx = new ServiceChainIndex(reg, profile);
    if (src.app) idx.scanSource('app', '/virtual/x.service.ts', src.app);
    if (src.shared) idx.scanSource('lib', '/virtual/shared.ts', src.shared);
    const steps = idx.resolve(controllerClass, method).steps;
    const operation = `${controllerClass}.${method}`;
    const failures = reachableFailures(steps, operation);
    const facts = deriveBusinessFacts({
      controllerClassName: controllerClass, methodName: method, httpMethod: opts.http ?? 'post', steps, crud: false, hasPagination: false,
      pathParams: opts.pathParams ?? ['id'], queryParams: [], response: EMPTY_RESPONSE, request: opts.request ?? [],
    });
    const structured = facts ? composeStructured(facts) : undefined;
    const run: Run = { facts, text: structured?.text, structured, failures, conflicts: failureConflicts(failures) };
    runs.push({ name: operation, run });
    return run;
  };
}
