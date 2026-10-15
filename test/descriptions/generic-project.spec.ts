// Proves the engine is not tied to the OnMeeting layout: an unrelated domain
// (invoices), a different architecture (controller -> use case -> repository,
// no RPC, no gateway) and a profile with no providers and no conventions.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ControllerRegistry } from '../../src/descriptions/controller-registry';
import { ServiceChainIndex } from '../../src/descriptions/service-chain';
import { buildDescription } from '../../src/descriptions/description-generator';
import { deriveBusinessFacts, unsupportedClaims } from '../../src/descriptions/business-facts';
import { configureConventions, NEUTRAL_CONVENTIONS } from '../../src/descriptions/conventions';
import type { ChainProfile } from '../../src/descriptions/hop-provider';
import { identitySourceAdapter } from '../../src/descriptions/adapters/identity-source';
import { persistenceWriteAdapter } from '../../src/descriptions/adapters/persistence-writes';
import { signalMarkersAdapter } from '../../src/descriptions/adapters/signal-markers';
import { EMPTY_RESPONSE } from '../../src/descriptions/schema-facts';

const CONTROLLER = `
@Controller('invoices')
export class InvoiceController {
  constructor(private readonly issueInvoice: IssueInvoiceUseCase) {}
  @Post(':invoiceId/cancel')
  cancelInvoice() { return this.issueInvoice.cancelIt(); }
  @Post('mystery')
  mystery() { return this.issueInvoice.opaque(); }
}`;
const APPLICATION = `
export class IssueInvoiceUseCase {
  constructor(private readonly invoiceRepository: InvoiceRepository, private readonly paymentGateway: PaymentGateway) {}
  async cancelIt(invoice: Invoice) {
    if (invoice.paid) throw new ConflictException('Cannot cancel a paid invoice');
    await this.paymentGateway.release();
  }
  async opaque() { return 1; }
}`;

const profile: ChainProfile = {
  entryRoot: 'app',
  entrySuffixes: ['.ts'],
  discoverRoots: () => [],
  providers: [],
  methodAdapters: [],
  schemaProviders: [],
};

const describeOp = (method: string, pathParams: string[]): string => {
  const reg = new ControllerRegistry(profile.methodAdapters);
  reg.scanFile('/virtual/invoice.controller.ts', CONTROLLER);
  const idx = new ServiceChainIndex(reg, profile);
  idx.scanSource('app', '/virtual/issue.use-case.ts', APPLICATION);
  const chain = idx.resolve('InvoiceController', method);
  return buildDescription({
    controllerClassName: 'InvoiceController',
    methodName: method,
    httpMethod: 'post',
    steps: chain.steps,
    crud: chain.crud,
    entity: chain.entity,
    hasPagination: false,
    pathParams,
    queryParams: [],
    request: [],
    response: EMPTY_RESPONSE,
  });
};

describe('unrelated project, no OnMeeting profile', () => {
  beforeAll(() => configureConventions(NEUTRAL_CONVENTIONS));

  it('derives behaviour through a use case with no gateway, RPC or conventions', () => {
    const d = describeOp('cancelInvoice', ['invoiceId']);
    expect(d).toMatch(/^Cancels the specified invoice\./);
    expect(d).toContain('A paid invoice cannot be cancelled');
    expect(d).toContain('the payment gateway is released');
  });

  it('falls back conservatively when the source proves nothing', () => {
    expect(describeOp('mystery', [])).toBe('Handles the requested invoice operation.');
  });

  it('every claim traces to a source file and line', () => {
    const reg = new ControllerRegistry(profile.methodAdapters);
    reg.scanFile('/virtual/invoice.controller.ts', CONTROLLER);
    const idx = new ServiceChainIndex(reg, profile);
    idx.scanSource('app', '/virtual/issue.use-case.ts', APPLICATION);
    const chain = idx.resolve('InvoiceController', 'cancelInvoice');
    const facts = deriveBusinessFacts({
      controllerClassName: 'InvoiceController', methodName: 'cancelInvoice', httpMethod: 'post', steps: chain.steps,
      crud: false, hasPagination: false, pathParams: ['invoiceId'], queryParams: [], request: [], response: EMPTY_RESPONSE,
    });
    expect(facts?.claims.length).toBeGreaterThan(0);
    expect(unsupportedClaims(facts!)).toEqual([]);
    expect(facts!.claims.find((c) => c.kind === 'side-effect')?.evidence[0]).toMatchObject({ sourceFile: '/virtual/issue.use-case.ts', kind: 'service-call' });
  });

  it('is deterministic', () => {
    expect(describeOp('cancelInvoice', ['invoiceId'])).toBe(describeOp('cancelInvoice', ['invoiceId']));
  });
});

// A second unrelated style: the caller arrives as `ctx.principal` behind a
// differently named decorator, persistence goes through a *Store, and events
// use a bus. The same adapters, configured differently, read it.
describe('unrelated project, adapters with its own conventions', () => {
  const CONTROLLER_2 = `
@Controller('payments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}
  @Post()
  createPayment(@Body() dto: PaymentInput, @Caller() ctx: Context) { return this.paymentService.record({ ...dto, ownerId: ctx.principal.id }); }
}`;
  const SERVICE_2 = `
export class PaymentService {
  constructor(private readonly paymentStore: PaymentStore, private readonly bus: EventBus) {}
  async record(dto: PaymentInput) {
    if (!dto.amount) throw new BadRequestException('Amount is required to create a payment');
    await this.paymentStore.save({ amount: dto.amount });
    this.bus.publish('payment.recorded', {});
  }
}`;
  const profile2: ChainProfile = {
    entryRoot: 'app',
    entrySuffixes: ['.ts'],
    discoverRoots: () => [],
    providers: [],
    schemaProviders: [],
    methodAdapters: [
      identitySourceAdapter({ requestNames: ['ctx'], property: 'principal', paramDecorators: ['Caller'] }),
      persistenceWriteAdapter({ receiverSuffixes: ['store'], softDeleteField: 'removedOn', technologyWords: ['store'] }),
      signalMarkersAdapter(),
    ],
  };

  const facts = () => {
    const reg = new ControllerRegistry(profile2.methodAdapters);
    reg.scanFile('/virtual/payment.controller.ts', CONTROLLER_2);
    const idx = new ServiceChainIndex(reg, profile2);
    idx.scanSource('app', '/virtual/payment.service.ts', SERVICE_2);
    const chain = idx.resolve('PaymentController', 'createPayment');
    const input = {
      controllerClassName: 'PaymentController', methodName: 'createPayment', httpMethod: 'post', steps: chain.steps,
      crud: false, hasPagination: false, pathParams: [] as string[], queryParams: [] as string[], request: [], response: EMPTY_RESPONSE,
    };
    return { input, facts: deriveBusinessFacts(input)!, description: buildDescription(input) };
  };

  beforeAll(() => configureConventions({ ...NEUTRAL_CONVENTIONS, softDeleteField: 'removedOn', dataAccessSuffixes: ['store'], technologyWords: ['store'] }));
  afterAll(() => configureConventions(NEUTRAL_CONVENTIONS));

  it('reads identity, persistence and events through the configured conventions', () => {
    const { description } = facts();
    expect(description).toMatch(/^Creates a new payment\./);
    expect(description).toContain('The authenticated user becomes the payment owner');
    expect(description).toContain('the payment-recorded event is published');
    expect(description).toContain('Amount is required to create a payment');
  });

  it('every claim has evidence in the right file', () => {
    const { facts: f } = facts();
    expect(unsupportedClaims(f)).toEqual([]);
    const kinds = f.claims.map((c) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(['actor', 'ownership', 'event', 'rule']));
    for (const c of f.claims) for (const e of c.evidence) expect(e.sourceFile).toMatch(/^\/virtual\/payment\./);
  });

  it('with the default OnMeeting-style conventions absent, the same source claims nothing about identity', () => {
    const reg = new ControllerRegistry([]);
    reg.scanFile('/virtual/payment.controller.ts', CONTROLLER_2);
    const idx = new ServiceChainIndex(reg, { ...profile2, methodAdapters: [] });
    idx.scanSource('app', '/virtual/payment.service.ts', SERVICE_2);
    const chain = idx.resolve('PaymentController', 'createPayment');
    const d = buildDescription({
      controllerClassName: 'PaymentController', methodName: 'createPayment', httpMethod: 'post', steps: chain.steps,
      crud: false, hasPagination: false, pathParams: [], queryParams: [], request: [], response: EMPTY_RESPONSE,
    });
    expect(d).not.toMatch(/authenticated user|owner|event is published/);
  });
});

// Golden baseline: descriptions recorded before the decoupling refactor.
