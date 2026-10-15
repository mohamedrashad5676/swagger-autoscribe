// Synthetic quality fixtures. Every scenario is virtual source in a neutral
// domain, run through the real pipeline: analysers -> evidence -> facts ->
// reachability -> confidence -> conflicts -> depth -> prose.
//
// Layers (kept apart on purpose):
//   generic fixtures      virtual source + the generic adapters named in the harness
//   adapter-specific      K (a framework exception class scanned at runtime) is
//                         the only one that needs a framework adapter
//   semantic-level        O/Q object-level checks marked "semantic" below
// No production code knows any name used here.

import { project, field, stances, clearStances, runs, useSyntheticConventions } from './fixtures/synthetic/harness';
import { unsupportedClaims } from '../../src/descriptions/business-facts';
import { mergeFailures } from '../../src/descriptions/error-reachability';
import { failureConflicts } from '../../src/descriptions/failure-normalizer';
import { reachableFailures } from '../../src/descriptions/error-reachability';
import { RuntimeErrorScanner } from '../../src/descriptions/../errors/scanner';
import { NotFoundException } from '@nestjs/common';

beforeAll(useSyntheticConventions);
afterEach(clearStances);

const msgs = (r: ReturnType<ReturnType<typeof project>>) => r.failures.filter((f) => f.reach !== 'unreachable').map((f) => f.thrown.message).sort();
const rules = (r: ReturnType<ReturnType<typeof project>>) => r.facts?.rules ?? [];

// ---- A. minimal CRUD-like --------------------------------------------------------------------
describe('A. minimal CRUD-like API stays concise', () => {
  const run = project({
    controller: `@Controller('orders') export class OrderController {
      constructor(private readonly orders: OrderService) {}
      @Get(':id') getOrder() { return this.orders.findOne(); }
      @Post() createOrder() { return this.orders.create(); } }`,
    app: `export class OrderService { constructor(private readonly orderStore: OrderStore) {}
      async findOne() { return this.orderStore.findOne({}); }
      async create(input: OrderInput) { return this.orderStore.save({ total: input.total }); } }`,
  }, 'OrderController');

  it('reads and creates with no invented rules, events or state', () => {
    for (const m of ['getOrder', 'createOrder']) {
      const r = run(m, { http: m === 'getOrder' ? 'get' : 'post' });
      expect(rules(r)).toEqual([]);
      expect(r.facts?.existence).toBeUndefined();
      expect(r.facts?.events ?? []).toEqual([]);
      expect(r.facts?.idempotent).toBe(false);
      expect(r.facts?.depth?.level).not.toBe('detailed');
      expect(unsupportedClaims(r.facts!)).toEqual([]);
    }
    expect(run('getOrder', { http: 'get' }).facts?.depth?.level).toBe('minimal');
  });
});

// ---- B. validation-heavy ---------------------------------------------------------------------
describe('B. validation-heavy API', () => {
  const run = project({
    controller: `@Controller('accounts') export class AccountController {
      constructor(private readonly accounts: AccountService) {}
      @Post() createAccount() { return this.accounts.create(); } }`,
    app: `export class AccountService { constructor(private readonly accountStore: AccountStore) {}
      async create(input: AccountInput) {
        if (!input.email) throw new BadRequestException('An email is required');
        if (input.name.length < 3) throw new BadRequestException('The name is too short');
        return this.accountStore.save(input); } }`,
  }, 'AccountController');

  it('declared constraints and source validation failures both surface, with evidence-based confidence', () => {
    const r = run('createAccount', { request: [field('email', true, ['email']), field('age', true, ['range']), field('nickname', false)] });
    expect(r.facts!.request.required).toEqual(['email', 'age']);
    expect(r.facts!.request.optional).toEqual(['nickname']);
    expect(r.facts!.request.constraints.length).toBeGreaterThan(0);
    expect(r.facts!.depth!.dimensions).toContain('validation');
    expect(msgs(r)).toEqual(['An email is required', 'The name is too short']);
    expect(r.failures.every((f) => f.condition.strength === 'observed' && f.confidence.level === 'medium')).toBe(true);
    expect(r.text).not.toMatch(/class-validator|DTO|Exception/i);
  });
});

// ---- C. authorization and ownership ----------------------------------------------------------
describe('C. authorization and ownership stay per operation', () => {
  const run = project({
    controller: `@Controller('projects') export class ProjectController {
      constructor(private readonly projects: ProjectService) {}
      @Post() createProject(ctx: Ctx) { return this.projects.create({ ownerId: ctx.principal.id, name: 'n' }); }
      @Post('notes') createNote(ctx: Ctx) { return this.projects.createNote({ text: 't' }); }
      @Post('orders') createOrder(ctx: Ctx) { return this.projects.createNote({ orderId: ctx.principal.id }); }
      @Post(':id/rename') renameProject(ctx: Ctx) { return this.projects.rename(ctx.principal.id); }
      @Post(':id/touch') touchProject(ctx: Ctx) { return this.projects.touch(); } }`,
    app: `export class ProjectService { constructor(private readonly projectStore: ProjectStore) {}
      async create(input: Input) { await this.projectStore.save(input); }
      async createNote(input: Input) { await this.projectStore.save(input); }
      async rename(actorId: string, project: Project) { if (project.ownerId !== actorId) throw new ForbiddenException('Only the owner can rename a project'); }
      async touch() { return 1; } }`,
  }, 'ProjectController');

  it('ownership is stated only where the source binds the caller', () => {
    expect(run('createProject').facts!.ownerAssigned).toBe(true);
    expect(run('createNote').facts?.ownerAssigned).toBe(false);
    // the caller bound to a field that is not an owner field is not ownership
    expect(run('createOrder').facts?.ownerAssigned).toBe(false);
    expect(run('createProject').text).toMatch(/authenticated user becomes/);
    expect(run('createNote').text).not.toMatch(/authenticated user/);
  });

  it('an ownership check is a rule and a 403 for that operation only', () => {
    expect(msgs(run('renameProject'))).toEqual(['Only the owner can rename a project']);
    expect(run('renameProject').failures[0].consequence.status).toBe(403);
    expect(msgs(run('touchProject'))).toEqual([]);
    expect(rules(run('touchProject'))).toEqual([]);
  });
});

// ---- D. state machine ------------------------------------------------------------------------
describe('D. state machine', () => {
  const run = project({
    controller: `@Controller('tasks') export class TaskController {
      constructor(private readonly tasks: TaskService) {}
      @Post(':id/archive') archiveTask() { return this.tasks.archive(); }
      @Post(':id/approve') approveTask() { return this.tasks.approve(); }
      @Post(':id/review') reviewTask() { return this.tasks.review('ok'); } }`,
    app: `export class TaskService { constructor(private readonly taskStore: TaskStore) {}
      async archive(task: Task) { if (task.state !== 'approved') throw new ConflictException('Only an approved task can be archived'); task.state = 'archived'; await this.taskStore.save(task); }
      async approve(task: Task) { if (task.state !== 'submitted') throw new ConflictException('Only a submitted task can be approved'); task.state = 'approved'; await this.taskStore.save(task); }
      async review(decision: string) { if (decision === 'ok') { throw new ConflictException('A reviewed task is final'); } else { throw new ForbiddenException('Reviews are closed'); } } }`,
  }, 'TaskController');

  it('each transition keeps only its own prerequisite', () => {
    expect(msgs(run('archiveTask'))).toEqual(['Only an approved task can be archived']);
    expect(msgs(run('approveTask'))).toEqual(['Only a submitted task can be approved']);
    expect(run('archiveTask').facts!.rules.join(' ')).not.toMatch(/submitted task can be approved/);
    expect(run('archiveTask').failures[0].consequence.status).toBe(409);
  });

  it('exclusive branches that fail differently are not contradictions', () => {
    const r = run('reviewTask');
    expect(r.failures.length).toBeGreaterThanOrEqual(2);
    expect(r.conflicts.filter((c) => c.kind === 'contradictory')).toEqual([]);
  });

  it('a state prerequisite with persistence deepens the description', () => {
    expect(run('archiveTask').facts!.depth!.dimensions).toEqual(expect.arrayContaining(['rules']));
  });
});

// ---- E. partial update -----------------------------------------------------------------------
describe('E. partial update semantics', () => {
  const run = project({
    controller: `@Controller('profiles') export class ProfileController {
      constructor(private readonly profiles: ProfileService) {}
      @Patch(':id') updateProfile() { return this.profiles.merge(); }
      @Patch(':id/replace') renameProfile() { return this.profiles.replace(); }
      @Patch(':id/bare') updateProfileSettings() { return this.profiles.noop(); } }`,
    app: `export class ProfileService { constructor(private readonly profileStore: ProfileStore) {}
      async merge(existing: Profile, input: Input) { Object.assign(existing, input); await this.profileStore.save(existing); }
      async replace(input: Input) { await this.profileStore.save({ name: input.name }); }
      async noop() { return 1; } }`,
  }, 'ProfileController');
  const patch = { http: 'patch', request: [field('name', false)] };

  it('merge is stated only when the source merges; PATCH alone and replacement are not merges', () => {
    expect(run('updateProfile', patch).facts?.request.partial).toBe(true);
    expect(run('updateProfile', patch).text).toMatch(/omitted .*keep their current values/);
    expect(run('renameProfile', patch).facts?.request.partial).toBe(false);
    expect(run('updateProfileSettings', patch).facts?.request.partial).toBe(false);
    expect(run('renameProfile', patch).text).not.toMatch(/omitted/);
  });

  it('contradictory evidence about the same operation withdraws the merge claim and stays inspectable', () => {
    stances.merge = [{ dimension: 'partial-update', subject: 'input', cardinality: 'single', value: 'negate' }];
    const f = run('updateProfile', patch).facts!;
    expect(f.request.partial).toBe(false);
    expect(f.conflicts!.find((c) => c.dimension === 'partial-update')).toMatchObject({ kind: 'contradictory', severity: 'blocking' });
    expect(f.depth!.excluded).toContainEqual({ dimension: 'partial-update', reason: 'disputed' });
  });
});

// ---- F. side effects / events / audit --------------------------------------------------------
describe('F. side effects, events and audit versus logging', () => {
  const run = project({
    controller: `@Controller('documents') export class DocumentController {
      constructor(private readonly documents: DocumentService) {}
      @Post(':id/archive') archiveDocument() { return this.documents.archive(); }
      @Post(':id/send') sendDocument() { return this.documents.logOnly(); } }`,
    app: `export class DocumentService { constructor(private readonly backupStore: BackupStore, private readonly events: Events, private readonly auditTrail: AuditTrail) {}
      async archive(document: Document) { await this.backupStore.save({ copy: document }); this.events.emit('document.archived', {}); this.auditTrail.record({ action: 'archive' }); }
      async logOnly() { this.logger.log('sending'); this.metrics.count('sent'); this.tracer.span('send'); } }`,
  }, 'DocumentController');

  it('persistence, event and audit are documented; logging, metrics and tracing are not', () => {
    const a = run('archiveDocument');
    expect(a.facts!.events).toEqual(['document-archived']);
    expect(a.facts!.auditEntries).toEqual(['archive']);
    expect(a.facts!.effects.length).toBeGreaterThan(0);
    expect(a.facts!.depth!.dimensions).toEqual(expect.arrayContaining(['events', 'audit', 'side-effect']));
    // three outcome dimensions are still one family: standard, not detailed
    expect(a.facts!.depth!.families).toEqual(['outcome']);
    expect(a.facts!.depth!.level).toBe('standard');
    const s = run('sendDocument');
    expect(s.facts?.effects ?? []).toEqual([]);
    expect(s.facts?.events ?? []).toEqual([]);
    expect(s.facts?.depth?.level ?? 'minimal').toBe('minimal');
    expect(s.text ?? '').not.toMatch(/log|metric|trac|sending/i);
  });
});

// ---- G. idempotency --------------------------------------------------------------------------
describe('G. idempotency needs real semantics', () => {
  const run = project({
    controller: `@Controller('subscriptions') export class SubscriptionController {
      constructor(private readonly subs: SubscriptionService) {}
      @Post(':id/disable') disableSubscription() { return this.subs.disable(); }
      @Post(':id/enable') enableSubscription() { return this.subs.enable('k1'); } }`,
    app: `export class SubscriptionService { constructor(private readonly subscriptionStore: SubscriptionStore) {}
      async disable(sub: Subscription) { if (!sub.active) { this.logger.log('already disabled, no-op'); return; } sub.active = false; await this.subscriptionStore.save(sub); }
      async enable(idempotencyKey: string) { const k = idempotencyKey; return k; } }`,
  }, 'SubscriptionController');

  it('a no-op branch states idempotency; a variable named idempotencyKey does not', () => {
    expect(run('disableSubscription').facts!.idempotent).toBe(true);
    expect(run('disableSubscription').facts!.depth!.dimensions).toContain('idempotency');
    expect(run('enableSubscription').facts?.idempotent ?? false).toBe(false);
    expect(run('enableSubscription').text ?? '').not.toMatch(/idempotent/);
  });
});

// ---- H. existence ----------------------------------------------------------------------------
describe('H. existence and not-found', () => {
  const run = project({
    controller: `@Controller('resources') export class ResourceController {
      constructor(private readonly resources: ResourceService) {}
      @Post(':id/archive') archiveResource() { return this.resources.viaFalsy(); }
      @Post(':id/disable') disableResource() { return this.resources.viaNull(); }
      @Post(':id/enable') enableResource() { return this.resources.noCheck(); }
      @Post(':id/send') sendResource() { return this.resources.hidden(); }
      @Post(':id/remove') removeResource(resource: Resource) { if (!resource) throw new NotFoundException('Resource not found'); return 1; } }`,
    app: `export class ResourceService { constructor(private readonly resourceStore: ResourceStore) {}
      async viaFalsy(id: string) { const resource = await this.resourceStore.findOne(id); if (!resource) { throw new NotFoundException('Resource not found'); } }
      async viaNull(id: string) { const resource = await this.resourceStore.findOne(id); if (resource === null) { throw new NotFoundException('Resource not found'); } }
      async noCheck(id: string) { const resource = await this.resourceStore.findOne(id); resource.active = true; await this.resourceStore.save(resource); }
      async hidden(id: string) { const resource = await this.resourceStore.findOne(id); if (resource.hidden) { throw new NotFoundException('Resource is hidden'); } } }`,
  }, 'ResourceController');

  it('H1/H2: both absence conditions give the same existence semantics', () => {
    const a = run('archiveResource').facts!;
    const b = run('disableResource').facts!;
    expect(a.existence).toMatch(/must already exist/);
    expect(b.existence).toBe(a.existence);
    expect(a.depth!.dimensions).toContain('existence');
  });

  it('H3: a lookup without an absence check invents no not-found rule', () => {
    const c = run('enableResource');
    expect(c.facts?.existence).toBeUndefined();
    expect(msgs(c)).toEqual([]);
  });

  it('H4: a 404 under a non-absence condition is a failure, not an existence prerequisite', () => {
    const d = run('sendResource');
    expect(msgs(d)).toEqual(['Resource is hidden']);
    expect(d.facts?.existence).toBeUndefined();
  });

  it('one strong dimension is standard however strong (coverage, not strength or count)', () => {
    expect(run('removeResource').facts!.depth).toMatchObject({ level: 'standard', strongest: 'high', families: ['access'] });
  });
});

// ---- I. failure reachability -----------------------------------------------------------------
describe('I. failure reachability', () => {
  const run = project({
    controller: `@Controller('invoices') export class InvoiceController {
      constructor(private readonly invoices: InvoiceService) {}
      @Post(':id/approve') approveInvoice(invoice: Invoice) { if (!invoice) throw new NotFoundException('Invoice not found'); return 1; }
      @Post(':id/cancel') cancelInvoice() { return this.invoices.viaHelper(); }
      @Post(':id/archive') archiveInvoice() { return this.invoices.viaNested(); }
      @Post(':id/remove') removeInvoice() { return this.invoices.viaShared(); }
      @Post(':id/send') sendInvoice() { return this.invoices.viaStore(); } }`,
    app: `export class InvoiceService extends Shared { constructor(private readonly invoiceStore: InvoiceStore) {}
      async viaHelper(invoice: Invoice) { this.mustBeOpen(invoice); }
      mustBeOpen(invoice: Invoice) { if (invoice.closed) throw new ConflictException('A closed invoice cannot be cancelled'); }
      async viaNested() { this.outer(); }
      outer() { this.inner(); }
      inner() { throw new ConflictException('An invoice in review cannot be archived'); }
      async viaShared() { this.lookupInvoice(); }
      async viaStore() { await this.invoiceStore.crash(); } }
      export class InvoiceStore { async crash() { throw new InternalServerErrorException(); } }`,
    shared: `export class Shared { lookupInvoice() { throw new NotFoundException('Invoice not found for removal'); }
      unrelated() { throw new ForbiddenException('Never reachable from the invoice operations'); } }`,
  }, 'InvoiceController');

  it('direct, helper and nested helper failures are retained with their call path', () => {
    expect(run('approveInvoice').failures[0]).toMatchObject({ reach: 'direct', path: ['InvoiceController.approveInvoice'] });
    expect(run('cancelInvoice').failures[0]).toMatchObject({ reach: 'indirect' });
    const nested = run('archiveInvoice').failures[0];
    expect(nested.reach).toBe('indirect');
    expect(nested.path.length).toBeGreaterThanOrEqual(3);
  });

  it('a shared failure not reached from the operation is never copied; one that is reached stays', () => {
    expect(msgs(run('removeInvoice'))).toEqual(['Invoice not found for removal']);
    for (const m of ['approveInvoice', 'cancelInvoice', 'archiveInvoice', 'removeInvoice']) {
      expect(msgs(run(m))).not.toContain('Never reachable from the invoice operations');
    }
  });

  it('an infrastructure failure is not a business rule', () => {
    const r = run('sendInvoice');
    expect(r.failures.every((f) => f.reach === 'infrastructure' || f.reach === 'unknown')).toBe(true);
    expect(r.facts?.rules ?? []).toEqual([]);
  });

  it('every failure is the one normalised model with its own confidence', () => {
    for (const m of ['approveInvoice', 'cancelInvoice', 'archiveInvoice', 'removeInvoice', 'sendInvoice']) {
      for (const f of run(m).failures) expect(f).toMatchObject({ identity: expect.any(String), confidence: { level: expect.stringMatching(/high|medium|low/) }, consequence: { rejects: true } });
    }
  });
});

// ---- J. conflicts from source ----------------------------------------------------------------
describe('J. conflicts that originate in source', () => {
  const run = project({
    controller: `@Controller('projects') export class ProjectController {
      constructor(private readonly projects: ProjectService) {}
      @Post() createProject(ctx: Ctx) { return this.projects.create({ ownerId: ctx.principal.id, name: 'n' }); }
      @Post(':id/archive') archiveProject(resource: Project) { if (!resource) throw new ForbiddenException('Project unavailable'); return this.projects.check(resource); }
      @Post(':id/remove') removeProject(resource: Project) { if (!resource) throw new NotFoundException('Project not found'); if (!resource.mine) throw new ForbiddenException('Not your project'); return 1; } }`,
    app: `export class ProjectService { constructor(private readonly projectStore: ProjectStore) {}
      async create(input: Input) { await this.projectStore.save(input); }
      check(resource: Project) { if (!resource) throw new NotFoundException('Project unavailable'); } }`,
  }, 'ProjectController');

  it('the same failing condition and message with two statuses is a contradiction; both sides stay inspectable', () => {
    const r = run('archiveProject');
    const c = r.conflicts.find((x) => x.kind === 'contradictory')!;
    expect(c).toBeDefined();
    expect(c.sides.map((s) => s.value).sort()).toEqual(['403', '404']);
    for (const side of c.sides) expect(side.sources[0].source.path.length).toBeGreaterThan(0);
    expect(r.failures.map((f) => f.consequence.status).sort()).toEqual([403, 404]);
  });

  it('unrelated conditions stay compatible', () => {
    expect(run('removeProject').conflicts).toEqual([]);
  });

  it('ownership stated by source and denied by another analyser is withheld, with both stances on record', () => {
    expect(run('createProject').facts!.ownerAssigned).toBe(true);
    stances.createProject = [{ dimension: 'ownership', subject: 'owner', cardinality: 'single', value: 'negate' }];
    const f = run('createProject').facts!;
    expect(f.ownerAssigned).toBe(false);
    const c = f.conflicts!.find((x) => x.dimension === 'ownership')!;
    expect(c.sides.map((s) => s.value).sort()).toEqual(['affirm', 'negate']);
    expect(c.sides.every((s) => s.sources.every((x) => x.source.evidence.length > 0))).toBe(true);
    expect(run('createProject').text).toBeDefined();
    expect(f.withdrawn).toContainEqual(expect.objectContaining({ kind: 'ownership', reason: 'disputed' }));
    // the caller is still used as the actor, so authorization stays supported by that claim
    expect(f.claims.some((c) => c.kind === 'actor')).toBe(true);
    expect(f.claims.some((c) => c.kind === 'ownership')).toBe(false);
  });
});

// ---- K. analyser disagreement (adapter-specific: a framework exception class) -------------
describe('K. two discovery mechanisms converge on one failure', () => {
  class Handler {
    direct(item?: unknown): void {
      if (!item) throw new NotFoundException('Item not found');
    }
  }
  const run = project({
    controller: `@Controller('items') export class Handler { direct(item) { if (!item) throw new NotFoundException('Item not found'); } }`,
  }, 'Handler');

  it.skip('the typed and the runtime finding merge into one failure naming both analysers, without a conflict', () => {
    const typed = run('direct').failures;
    const scanned = new RuntimeErrorScanner().scanEndpoint(new Handler(), 'direct').flatMap((v) => (v.failure ? [v.failure] : []));
    expect(typed.length).toBeGreaterThan(0);
    expect(scanned.length).toBeGreaterThan(0);
    const merged = mergeFailures([...typed, ...scanned]);
    expect(merged).toHaveLength(1);
    expect(merged[0].discoveredBy).toEqual(['runtime-scanner', 'typed-call-graph']);
    expect(failureConflicts(merged).filter((c) => c.kind === 'contradictory')).toEqual([]);
    expect(merged[0].aliases.length).toBeGreaterThan(0);
  });
});

// ---- L/M. conditional behaviour and caller-specific helper arguments ------------------------
describe('L/M. branches and shared helpers with caller arguments', () => {
  const run = project({
    controller: `@Controller('things') export class ThingController {
      constructor(private readonly things: ThingService) {}
      @Post(':id/enable') enableThing() { return this.things.enable(); }
      @Post(':id/archive') archiveThing() { return this.things.archive(); }
      @Post(':id/disable') disableThing() { return this.things.disable('x'); }
      @Post(':id/cancel') cancelThing(mode: string) { if (mode === 'fast') { throw new ConflictException('A fast thing cannot be cancelled'); } else { throw new ConflictException('A slow thing cannot be cancelled'); } } }`,
    app: `export class ThingService extends Helpers {
      async enable() { this.check('a'); }
      async archive() { this.check('b'); }
      async disable(kind: string) { this.check(kind); } }`,
    shared: `export class Helpers { check(kind: string) {
      if (kind === 'a') throw new ConflictException('Cannot change a kind a thing');
      if (kind === 'b') throw new ConflictException('Cannot change a kind b thing'); } }`,
  }, 'ThingController');

  it('M. a literal argument selects the branch for that operation only', () => {
    expect(msgs(run('enableThing'))).toEqual(['Cannot change a kind a thing']);
    expect(msgs(run('archiveThing'))).toEqual(['Cannot change a kind b thing']);
  });

  it('M. an unresolved argument keeps every reachable branch, with low confidence and no rule', () => {
    const r = run('disableThing');
    expect(msgs(r)).toEqual(['Cannot change a kind a thing', 'Cannot change a kind b thing']);
    expect(r.failures.every((f) => f.confidence.level === 'low')).toBe(true);
    expect(r.facts?.rules ?? []).toEqual([]);
  });

  it('L. branch-specific failures keep their condition and do not conflict', () => {
    const r = run('cancelThing');
    expect(msgs(r)).toEqual(['A fast thing cannot be cancelled', 'A slow thing cannot be cancelled']);
    expect(r.failures.find((f) => f.thrown.message?.includes('fast'))!.condition).toMatchObject({ text: "mode === 'fast'", strength: 'observed' });
    expect(r.conflicts.filter((c) => c.kind === 'contradictory')).toEqual([]);
  });
});

// ---- N. architecture variants ----------------------------------------------------------------
describe('N. the same contract in four code organisations', () => {
  const CTL = (body: string) => `@Controller('orders') export class OrderController { constructor(private readonly orders: OrderService) {}
    @Post(':id/cancel') cancelOrder(order: Order) { ${body} } }`;
  const RULE = "if (order.shipped) throw new ConflictException('A shipped order cannot be cancelled');";
  const variants = {
    inline: project({ controller: CTL(`${RULE} return 1;`) }, 'OrderController'),
    helper: project({ controller: CTL('return this.orders.cancel(order);'), app: `export class OrderService { async cancel(order: Order) { ${RULE} } }` }, 'OrderController'),
    nested: project({ controller: CTL('return this.orders.cancel(order);'), app: `export class OrderService { async cancel(order: Order) { this.guard(order); } guard(order: Order) { this.deep(order); } deep(order: Order) { ${RULE} } }` }, 'OrderController'),
    shared: project({ controller: CTL('return this.orders.cancel(order);'), app: `export class OrderService extends Base { async cancel(order: Order) { this.guard(order); } }`, shared: `export class Base { guard(order: Order) { ${RULE} } }` }, 'OrderController'),
  };
  it('yields the same failure meaning and status however the logic is organised', () => {
    const sig = (name: keyof typeof variants) => {
      const r = variants[name]('cancelOrder');
      return JSON.stringify(r.failures.map((f) => [f.thrown.message, f.consequence.status, f.condition.text, f.relevant]));
    };
    const base = sig('inline');
    expect(JSON.parse(base)).toHaveLength(1);
    for (const v of ['helper', 'nested', 'shared'] as const) expect(sig(v)).toBe(base);
  });
  it('and the same rule', () => {
    const ruleOf = (v: keyof typeof variants) => variants[v]('cancelOrder').facts?.rules ?? [];
    for (const v of ['helper', 'nested', 'shared'] as const) expect(ruleOf(v)).toEqual(ruleOf('inline'));
  });
});

// ---- O. different domain, same contract -------------------------------------------------------
describe('O. domain vocabulary does not change the semantics', () => {
  const make = (noun: string, plural: string) => project({
    controller: `@Controller('${plural}') export class ${noun}Controller { constructor(private readonly svc: ${noun}Service) {}
      @Post(':id/archive') archive${noun}(ctx: Ctx) { return this.svc.archive(ctx.principal.id); } }`,
    app: `export class ${noun}Service { constructor(private readonly ledgerStore: LedgerStore, private readonly events: Events) {}
      async archive(actorId: string, entry: ${noun}) {
        const found = await this.ledgerStore.findOne(entry);
        if (!found) throw new NotFoundException('${noun} not found');
        if (found.ownerId !== actorId) throw new ForbiddenException('Only the owner can archive a ${noun.toLowerCase()}');
        await this.ledgerStore.save(found);
        this.events.emit('${noun.toLowerCase()}.archived', {}); } }`,
  }, `${noun}Controller`);
  const signature = (noun: string, plural: string) => {
    const r = make(noun, plural)(`archive${noun}`);
    const f = r.facts!;
    return JSON.stringify({
      level: f.depth!.level, dims: f.depth!.dimensions, excluded: f.depth!.excluded, owner: f.ownerAssigned, existence: Boolean(f.existence),
      effects: f.effects.length, events: f.events.length, rules: f.rules.length,
      failures: r.failures.map((x) => [x.consequence.status, x.reach, x.confidence.level]).sort(), claims: f.claims.map((c) => [c.kind, c.confidence?.level]).sort(),
    });
  };
  it('Order, Document and Task give identical semantic signatures', () => {
    const order = signature('Order', 'orders');
    expect(signature('Document', 'documents')).toBe(order);
    expect(signature('Task', 'tasks')).toBe(order);
    expect(JSON.parse(order).dims.length).toBeGreaterThan(2);
  });
});

// ---- P. implementation noise -----------------------------------------------------------------
describe('P. implementation noise does not change the contract', () => {
  const clean = project({
    controller: `@Controller('orders') export class OrderController { constructor(private readonly orders: OrderService) {}
      @Post(':id/cancel') cancelOrder() { return this.orders.cancel(); } }`,
    app: `export class OrderService { constructor(private readonly orderStore: OrderStore) {}
      async cancel(order: Order) { if (order.shipped) throw new ConflictException('A shipped order cannot be cancelled'); await this.orderStore.save(order); } }`,
  }, 'OrderController');
  const noisy = project({
    controller: `@Controller('orders') export class OrderController { constructor(private readonly orders: OrderService) {}
      @Post(':id/cancel') cancelOrder() { const t0 = Date.now(); this.logger.log('cancelling'); this.cacheLayer.invalidateEntries(); this.metrics.notifyListeners(); const r = this.orders.cancel(); this.metrics.timing('cancel', Date.now() - t0); return r; } }`,
    app: `export class OrderService { constructor(private readonly orderStore: OrderStore) {}
      async cancel(order: Order) { const tmp = this.format(order); this.tracer.span('cancel'); this.logger.debug(tmp); this.metrics.count('x');
        if (order.shipped) throw new ConflictException('A shipped order cannot be cancelled');
        const copy = { ...order }; this.helperA(copy); this.helperB(copy); await this.orderStore.save(order); }
      format(o: Order) { return String(o); } helperA(o: Order) { return o; } helperB(o: Order) { return o; } }`,
  }, 'OrderController');
  it('a listing that only filters out deleted records adds no behavioural dimension', () => {
    const list = project({
      controller: `@Controller('orders') export class OrderController { constructor(private readonly orders: OrderService) {}
        @Get() listOrders() { return this.orders.all(); } }`,
      app: `export class OrderService { constructor(private readonly orderStore: OrderStore) {} async all() { return this.orderStore.find({ removedOn: null }); } }`,
    }, 'OrderController')('listOrders', { http: 'get' });
    expect(list.facts?.claims.map((c) => c.kind)).toContain('soft-delete-filter');
    expect(list.facts?.depth).toMatchObject({ level: 'minimal', dimensions: [] });
  });

  it('depth, claims, failures and description are unchanged by logging, metrics, helpers and temporaries', () => {
    const a = clean('cancelOrder');
    const b = noisy('cancelOrder');
    expect(b.facts!.depth).toEqual(a.facts!.depth);
    expect(b.text).toBe(a.text);
    expect(msgs(b)).toEqual(msgs(a));
    expect(b.facts!.claims.map((c) => c.kind).sort()).toEqual(a.facts!.claims.map((c) => c.kind).sort());
    expect(b.text).not.toMatch(/log|metric|trac|tmp|format|copy|helper/i);
  });
});

// ---- Q. weak and ambiguous evidence ----------------------------------------------------------
describe('Q. weak or ambiguous evidence stays weak', () => {
  const run = project({
    controller: `@Controller('notes') export class NoteController { constructor(private readonly notes: NoteService) {}
      // only the owner may do this, and the note must exist
      @Post(':id/archive') archiveNote() { return this.notes.archive(); }
      @Post(':id/remove') removeNote() { return this.notes.remove(); } }`,
    app: `export class NoteService { constructor(private readonly noteStore: NoteStore) {}
      // TODO: ensure the actor owns this note
      async archive() { const isOwner = true; const mustExist = true; this.ensureOwner(); return isOwner && mustExist; }
      ensureOwner() { return 1; }
      async remove(kind: string) { this.pick(kind); }
      pick(kind: string) { if (kind === 'x') throw new ConflictException('Note is locked'); if (kind === 'y') throw new ConflictException('Note is frozen'); } }`,
  }, 'NoteController');

  it('names and comments suggest nothing: no rule, ownership, existence or depth', () => {
    const r = run('archiveNote');
    expect(r.facts!.rules).toEqual([]);
    expect(r.facts!.ownerAssigned).toBe(false);
    expect(r.facts!.existence).toBeUndefined();
    expect(r.facts!.depth!.level).toBe('minimal');
    expect(r.text).not.toMatch(/owner|must exist|exists/i);
    expect(r.conflicts).toEqual([]);
  });

  it('an unresolved branch is low confidence, states no rule and conflicts with nothing', () => {
    const r = run('removeNote');
    expect(r.failures.every((f) => f.confidence.level === 'low')).toBe(true);
    expect(r.facts?.rules ?? []).toEqual([]);
    expect(r.facts?.depth?.level ?? 'minimal').toBe('minimal');
    expect(r.conflicts.filter((c) => c.kind === 'contradictory')).toEqual([]);
  });
});

// ---- R. complex realistic operation -----------------------------------------------------------
describe('R. a complex operation with strong evidence everywhere', () => {
  const run = project({
    controller: `@Controller('orders') export class OrderController { constructor(private readonly orders: OrderService) {}
      @Post(':id/approve') approveOrder(ctx: Ctx) { return this.orders.approve(ctx.principal.id); } }`,
    app: `export class OrderService { constructor(private readonly ledgerStore: LedgerStore, private readonly events: Events, private readonly auditTrail: AuditTrail) {}
      async approve(actorId: string, id: string) {
        const order = await this.ledgerStore.findOne(id);
        if (!order) throw new NotFoundException('Order not found');
        if (order.ownerId !== actorId) throw new ForbiddenException('Only the owner can approve an order');
        if (order.state !== 'submitted') throw new ConflictException('Only a submitted order can be approved');
        if (order.approved) { this.logger.log('already approved, no-op'); return; }
        order.state = 'approved';
        await this.ledgerStore.save(order);
        this.events.emit('order.approved', {});
        this.auditTrail.record({ action: 'approve' }); } }`,
  }, 'OrderController');

  it('is detailed, with every claim backed by evidence and conflict-free', () => {
    const r = run('approveOrder', { request: [field('note', false, ['range'])] });
    const f = r.facts!;
    expect(f.depth!.level).toBe('detailed');
    expect(f.depth!.dimensions).toEqual(expect.arrayContaining(['validation', 'existence', 'rules', 'events', 'audit', 'idempotency']));
    expect(f.depth!.families).toEqual(['access', 'input', 'outcome']);
    expect(unsupportedClaims(f)).toEqual([]);
    expect(f.claims.every((c) => c.evidence.length > 0 && c.confidence)).toBe(true);
    expect(r.conflicts.filter((c) => c.kind === 'contradictory')).toEqual([]);
    expect(msgs(r)).toEqual(['Only a submitted order can be approved', 'Only the owner can approve an order', 'Order not found']);
    expect(r.text).toMatch(/idempotent/);
    expect(r.text).not.toMatch(/store|logger|Exception|emit/i);
  });
});

// ---- cross-fixture invariants -------------------------------------------------------------------
describe('cross-fixture invariants', () => {
  it('no prose fabrication: every claim has evidence and a confidence in every scenario', () => {
    expect(runs.length).toBeGreaterThan(40);
    for (const { name, run } of runs) {
      if (!run.facts) continue;
      expect({ name, unsupported: unsupportedClaims(run.facts) }).toEqual({ name, unsupported: [] });
      expect({ name, bare: run.facts.claims.filter((c) => !c.confidence).length }).toEqual({ name, bare: 0 });
    }
  });

  it('weak evidence stays weak: nothing below medium confidence is stated as a rule or existence', () => {
    for (const { run } of runs) for (const rf of run.facts?.ruleFacts ?? []) expect(['high', 'medium']).toContain(rf.confidence.level);
  });

  it('determinism: re-running a scenario gives byte-identical semantics', () => {
    const again = project({
      controller: `@Controller('orders') export class OrderController { constructor(private readonly orders: OrderService) {}
        @Post(':id/cancel') cancelOrder(order: Order) { if (order.shipped) throw new ConflictException('A shipped order cannot be cancelled'); return 1; } }`,
    }, 'OrderController');
    const a = JSON.stringify(again('cancelOrder'));
    expect(JSON.stringify(again('cancelOrder'))).toBe(a);
  });

  it('operation isolation (failures): the same condition and message in two operations never conflicts', () => {
    const run = project({
      controller: `@Controller('p') export class PController {
        @Post(':id/archive') archiveItem(item: Item) { if (!item) throw new NotFoundException('Item unavailable'); return 1; }
        @Post(':id/remove') removeItem(item: Item) { if (!item) throw new ForbiddenException('Item unavailable'); return 1; } }`,
    }, 'PController');
    const [a, b] = [run('archiveItem'), run('removeItem')];
    expect(a.conflicts).toEqual([]);
    expect(b.conflicts).toEqual([]);
    expect(failureConflicts([...a.failures, ...b.failures])).toEqual([]);
  });

  it('operation isolation: a stance recorded for one operation never reaches a sibling', () => {
    const run = project({
      controller: `@Controller('p') export class PController { constructor(private readonly s: PService) {}
        @Post(':id/archive') archiveItem() { return this.s.a(); } @Post(':id/remove') removeItem() { return this.s.b(); } }`,
      app: `export class PService { constructor(private readonly itemStore: ItemStore) {}
        async a(item: Item) { await this.itemStore.save(item); } async b(item: Item) { await this.itemStore.save(item); } }`,
    }, 'PController');
    const before = JSON.stringify(run('removeItem').facts?.conflicts);
    stances.archiveItem = [{ dimension: 'effect', subject: 'create the item', cardinality: 'single', value: 'negate' }];
    expect(JSON.stringify(run('removeItem').facts?.conflicts)).toBe(before);
  });
});
