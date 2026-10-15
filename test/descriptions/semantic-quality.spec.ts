// Semantic quality assertions on the FINAL generated description.
//
// Not a prose test: each scenario declares a contract of roles (ownership,
// rule, validation, ...) from what its virtual source proves, and the oracle
// (__fixtures__/semantic/oracle.ts) checks the artifact two independent ways:
// the composer's record of what each sentence represents, and a lexicon reading
// of the text itself. Wording may change freely; meaning may not.
//
// Layers: generic fixtures run the real pipeline (source -> analysers -> facts
// -> reachability -> confidence -> conflicts -> depth -> composer -> text).
// Framework-specific behaviour is only used by fixtures that say so.

import { project, field, stances, clearStances, runs, useSyntheticConventions, type Run } from './fixtures/synthetic/harness';
import { violations, statedOnce, IMPLEMENTATION_NOISE, type Contract } from './fixtures/semantic/oracle';
import { decideResponses, mergeFailures } from '../../src/descriptions/error-reachability';
import { failureConflicts, failureFromMetadata, failureFromVariant } from '../../src/descriptions/failure-normalizer';
import { decideDepth } from '../../src/descriptions/depth';
import { composeStructured } from '../../src/descriptions/description-composer';

beforeAll(useSyntheticConventions);
afterEach(clearStances);

const verify = (r: Run, c: Contract): string[] => (r.text && r.structured ? violations({ text: r.text, structured: r.structured }, c) : ['no description was generated']);

// ---- the oracle itself: wording-insensitive, meaning-sensitive ---------------------------------
describe('the oracle judges meaning, not wording', () => {
  const art = (sentences: [string, string[]][]) => ({
    text: sentences.map(([t]) => t).join(' '),
    structured: { text: '', sentences: sentences.map(([text, represents]) => ({ text, represents: represents as never })), represented: [...new Set(sentences.flatMap(([, r]) => r))].sort() as never, implied: [] },
  });
  const lead: [string, string[]] = ['Updates the resource.', ['purpose']];

  it('two phrasings of the same restriction both satisfy an ownership + rule contract', () => {
    const a = art([lead, ['Only account owners can update the resource.', ['rules', 'authorization']]]);
    const b = art([lead, ['Updates are restricted to the resource owner.', ['rules', 'authorization']]]);
    for (const x of [a, b]) expect(violations(x, { roles: { ownership: 'present', rule: 'present' } })).toEqual([]);
  });

  it('a meaning change is caught: a missing claim, an extra claim and a leaked implementation detail', () => {
    const none = art([lead]);
    expect(violations(none, { roles: { ownership: 'present' } }).length).toBeGreaterThan(0);
    const owner = art([lead, ['The authenticated user becomes the resource owner.', ['authorization']]]);
    expect(violations(owner, { roles: { ownership: 'absent' } }).length).toBeGreaterThan(0);
    const leak = art([lead, ['The metrics collector is updated.', ['side-effect']]]);
    expect(violations(leak, { roles: {} })).toContain('implementation detail exposed in the text');
  });

  it('depth is read from what the description represents, not its length', () => {
    expect(violations(art([lead]), { roles: {}, depth: 'minimal' })).toEqual([]);
    const one = art([lead, ['An audit entry is recorded in the audit log.', ['audit']], ['The x event is published.', ['events']]]);
    expect(violations(one, { roles: {}, depth: 'standard' })).toEqual([]);
    expect(violations(one, { roles: {}, depth: 'detailed' }).length).toBeGreaterThan(0);
  });
});

// ---- shared scenario: one project, many operations --------------------------------------------
const run = project({
  controller: `@Controller('assets') export class AssetController {
    constructor(private readonly assets: AssetService) {}
    @Post() createAsset(ctx: Ctx) { return this.assets.create({ ownerId: ctx.principal.id, name: 'n' }); }
    @Post('copies') createCopy(ctx: Ctx) { return this.assets.create({ name: 'n' }); }
    @Post('hints') createHint(ctx: Ctx) { return this.assets.create({ name: 'n' }); }
    @Post(':id/archive') archiveAsset(ctx: Ctx) { return this.assets.archive(ctx.principal.id); }
    @Post(':id/remove') removeAsset(asset: Asset) { if (!asset) throw new NotFoundException('Asset not found'); return 1; }
    @Post(':id/cancel') cancelAsset(mode: string) { if (mode === 'fast') { throw new ConflictException('A fast asset cannot be cancelled'); } return 1; }
    @Post(':id/approve') approveAsset() { return this.assets.approveA(); }
    @Post(':id/enable') enableAsset() { return this.assets.approveB(); }
    @Post(':id/disable') disableAsset(kind: string) { return this.assets.approveFor(kind); }
    @Post(':id/lock') lockAsset() { return this.assets.approveFor('a'); }
    @Post(':id/send') sendAsset() { return this.assets.viaStore(); }
    @Patch(':id') updateAsset() { return this.assets.merge(); }
    @Patch(':id/settings') updateAssetSettings() { return this.assets.noop(); }
    @Post(':id/notify') disableAssetAlerts() { this.cacheLayer.invalidateEntries(); this.metrics.notifyListeners(); return this.assets.logOnly(); }
    @Post(':id/delete') deleteAsset(asset: Asset) { if (asset.hidden) { throw new NotFoundException('Asset is hidden'); } return 1; }
    @Post(':id/rename') renameAsset() { return this.assets.noop(); } }`,
  app: `export class AssetService extends Guards { constructor(private readonly assetStore: AssetStore, private readonly events: Events, private readonly auditTrail: AuditTrail) {}
    async create(input: Input) { await this.assetStore.save(input); }
    async archive(actorId: string, asset: Asset) {
      if (asset.ownerId !== actorId) throw new ForbiddenException('Only the owner can archive an asset');
      if (asset.state !== 'approved') throw new ConflictException('Only an approved asset can be archived');
      if (asset.archived) { this.logger.log('already archived, no-op'); return; }
      asset.state = 'archived'; await this.assetStore.save(asset);
      this.events.emit('asset.archived', {}); this.auditTrail.record({ action: 'archive' }); }
    async approveA() { this.requireKind('a'); }
    async approveB() { this.requireKind('b'); }
    async approveFor(kind: string) { this.requireKind(kind); }
    async viaStore() { await this.assetStore.crash(); }
    async merge(existing: Asset, input: Input) { Object.assign(existing, input); await this.assetStore.save(existing); }
    async noop() { return 1; }
    async logOnly() { this.logger.log('x'); this.metrics.count('y'); this.tracer.span('z'); const tmp = this.format(1); this.debugDump(tmp); } }
    export class AssetStore { async crash() { throw new InternalServerErrorException(); } }`,
  shared: `export class Guards { requireKind(kind: string) {
    if (kind === 'a') throw new ConflictException('Cannot change a kind a asset');
    if (kind === 'b') throw new ConflictException('Cannot change a kind b asset'); }
    unused() { throw new ForbiddenException('Never reachable from these operations'); } }`,
}, 'AssetController');

describe('positive: strong evidence is represented in the final description', () => {
  it('ownership', () => {
    expect(verify(run('createAsset'), { roles: { ownership: 'present' } })).toEqual([]);
  });
  it('authorization + state prerequisite + state transition + persistence + event + audit + idempotency, and detailed depth', () => {
    const r = run('archiveAsset');
    expect(verify(r, { roles: { rule: 'present', event: 'present', audit: 'present', idempotency: 'present' }, depth: 'detailed' })).toEqual([]);
    expect(r.structured!.represented).toEqual(expect.arrayContaining(['rules', 'events', 'audit', 'idempotency']));
  });
  it('existence is implied by a lead that refers to the specified record', () => {
    const r = run('removeAsset');
    expect(r.facts!.existence).toBeDefined();
    expect(verify(r, { roles: { existence: 'present' } })).toEqual([]);
    expect(r.text).toMatch(/specified/);
  });
  it('partial update', () => {
    expect(verify(run('updateAsset', { http: 'patch', request: [field('name', false)] }), { roles: { 'partial-update': 'present' } })).toEqual([]);
  });
  it('validation from declared constraints', () => {
    const r = run('createCopy', { request: [field('email', true, ['email'])] });
    expect(verify(r, { roles: { validation: 'present' } })).toEqual([]);
  });
});

describe('negative: unsupported claims never appear', () => {
  it('A. low-confidence ownership is withheld', () => {
    stances.createHint = [{ dimension: 'ownership', subject: 'owner', cardinality: 'single', value: 'affirm', label: 'weak' }];
    const r = run('createHint');
    expect(verify(r, { roles: { ownership: 'absent' } })).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });

  it('B. high vs high ownership dispute is not documented on either side', () => {
    stances.createAsset = [{ dimension: 'ownership', subject: 'owner', cardinality: 'single', value: 'negate' }];
    const r = run('createAsset');
    expect(verify(r, { roles: { ownership: 'absent' } })).toEqual([]);
    expect(r.facts!.conflicts!.find((c) => c.dimension === 'ownership')).toMatchObject({ kind: 'contradictory', resolution: 'unresolved' });
  });

  it('B. high vs low: the policy keeps the strong claim and still records the weak one', () => {
    stances.createAsset = [{ dimension: 'ownership', subject: 'owner', cardinality: 'single', value: 'negate', label: 'weak' }];
    const r = run('createAsset');
    expect(verify(r, { roles: { ownership: 'present' } })).toEqual([]);
    const c = r.facts!.conflicts!.find((x) => x.dimension === 'ownership')!;
    expect(c).toMatchObject({ resolution: 'resolved', prevailing: 'affirm' });
    expect(c.sides.find((s) => s.value === 'negate')!.confidence.level).toBe('low');
  });

  it('C. a rule in a helper branch the operation never reaches is absent', () => {
    for (const m of ['approveAsset', 'enableAsset', 'removeAsset', 'archiveAsset']) {
      expect(run(m).text).not.toMatch(/Never reachable/);
    }
    expect(run('approveAsset').text ?? '').not.toMatch(/kind b/);
    expect(run('enableAsset').text ?? '').not.toMatch(/kind a/);
  });

  it('H. a 404 under a non-absence condition states no existence requirement', () => {
    const r = run('deleteAsset');
    expect(r.failures.map((f) => f.consequence.status)).toEqual([404]);
    expect(r.facts!.existence).toBeUndefined();
    expect(verify(r, { roles: { existence: 'absent' } })).toEqual([]);
  });

  it('D. another operation does not inherit ownership', () => {
    expect(run('createCopy').facts!.ownerAssigned).toBe(false);
    expect(verify(run('createCopy'), { roles: { ownership: 'absent' } })).toEqual([]);
    expect(verify(run('createAsset'), { roles: { ownership: 'present' } })).toEqual([]);
  });

  it('E. logging, tracing, metrics, helpers and temporaries are not contract', () => {
    const r = run('disableAssetAlerts');
    expect(r.facts).toBeDefined();
    expect(r.text ?? '').not.toMatch(IMPLEMENTATION_NOISE);
    expect(r.structured?.represented.filter((x) => !['purpose', 'input', 'result', 'schema'].includes(x)) ?? []).toEqual([]);
  });

  it('F. PATCH without merge evidence makes no preservation claim', () => {
    expect(verify(run('updateAssetSettings', { http: 'patch', request: [field('name', false)] }), { roles: { 'partial-update': 'absent' } })).toEqual([]);
  });

  it('G. an infrastructure failure is not a business rule', () => {
    expect(verify(run('sendAsset'), { roles: { rule: 'absent' } })).toEqual([]);
    expect(run('sendAsset').failures.every((f) => f.reach === 'infrastructure')).toBe(true);
  });

  it('duplicate evidence does not duplicate the statement', () => {
    stances.createAsset = [{ dimension: 'ownership', subject: 'owner', cardinality: 'single', value: 'affirm' }];
    const r = run('createAsset');
    expect(r.facts!.conflicts!.some((c) => c.kind === 'duplicate')).toBe(true);
    expect(statedOnce({ text: r.text!, structured: r.structured! }, 'ownership')).toBe(true);
  });
});

describe('conditions, helpers and failures', () => {
  it('a branch-specific failure stays conditional and is not stated as an unconditional rule', () => {
    const r = run('cancelAsset');
    expect(r.failures[0].condition).toMatchObject({ text: "mode === 'fast'", strength: 'observed' });
    expect(r.text ?? '').not.toMatch(/\balways\b|\bevery request\b/i);
  });

  it('a literal helper argument narrows per operation; a variable stays conservative', () => {
    const m = (op: string) => run(op).failures.filter((f) => f.reach !== 'unreachable').map((f) => f.thrown.message).sort();
    expect(m('approveAsset')).toEqual(['Cannot change a kind a asset']);
    expect(m('enableAsset')).toEqual(['Cannot change a kind b asset']);
    expect(m('disableAsset')).toEqual(['Cannot change a kind a asset', 'Cannot change a kind b asset']);
    expect(run('disableAsset').failures.every((f) => f.confidence.level === 'low')).toBe(true);
    expect(verify(run('disableAsset'), { roles: { rule: 'absent' } })).toEqual([]);
    // known limitation: a literal passed through an intermediate parameter is not propagated, so the result is conservative (both branches, low confidence)
    expect(m('lockAsset')).toEqual(['Cannot change a kind a asset', 'Cannot change a kind b asset']);
    expect(run('lockAsset').failures.every((f) => f.confidence.level === 'low')).toBe(true);
  });

  describe('responses follow the accepted policy', () => {
    const site = { operation: 'Op.run', depth: 0, shared: false, path: ['Op.run'], reachedWhen: [] as string[] };
    const source = failureFromVariant({ status: 404, message: 'Thing not found', when: '!thing' }, site);
    const decide = (fs: ReturnType<typeof failureFromMetadata>[], explicit: number[] = []) =>
      decideResponses(fs.map((failure) => ({ item: failure.consequence.status, failure })), new Set(explicit), failureConflicts(fs));

    it('direct, indirect and branch-specific source failures are kept; infrastructure is not', () => {
      const keep = (r: Run, i = 0) => decide([r.failures[i]])[0].keep;
      expect(keep(run('removeAsset'))).toBe(true);
      expect(keep(run('archiveAsset'))).toBe(true);
      expect(keep(run('cancelAsset'))).toBe(true);
      expect(keep(run('sendAsset'))).toBe(false);
    });

    it('a generic default never erases a source-backed failure', () => {
      const generic = failureFromVariant({ status: 500 }, site, 'framework-default', 'framework');
      const merged = mergeFailures([source, generic]);
      expect(merged).toHaveLength(2);
      expect(decide(merged).find((d) => d.failure.consequence.status === 404)!.keep).toBe(true);
    });

    it('an unverified status does not override a declared response', () => {
      const unverified = { ...failureFromVariant({ status: 409, message: 'x', when: '!y' }, site), thrown: { type: 'E', status: 409, message: 'x', statusBasis: 'code-mapping' as const } };
      const declared = failureFromMetadata(404, 'Op.run');
      const d = decide([unverified, declared], [404]);
      expect(d.find((x) => x.failure === unverified)!.keep).toBe(false);
      expect(d.find((x) => x.failure === declared)!.keep).toBe(true);
    });

    it('conflicting source failures are both documented and marked contested', () => {
      const other = failureFromVariant({ status: 403, message: 'Thing not found', when: '!thing' }, site);
      const d = decide([source, other]);
      expect(d.every((x) => x.keep && x.contested)).toBe(true);
    });
  });
});

describe('adaptive depth at the final description', () => {
  it('minimal: only the purpose', () => {
    const r = run('renameAsset');
    expect(verify(r, { roles: {}, depth: 'minimal' })).toEqual([]);
    expect(r.facts!.depth!.level).toBe('minimal');
  });
  it('standard: supported details, one family', () => {
    expect(verify(run('removeAsset'), { roles: { existence: 'present' }, depth: 'minimal' })).toEqual([]);
    const r = run('createAsset');
    expect(r.facts!.depth!.level).toBe('standard');
    expect(verify(r, { roles: { ownership: 'present' }, depth: 'standard' })).toEqual([]);
  });
  it('detailed adds supported facts, never unsupported ones', () => {
    const r = run('archiveAsset');
    expect(r.facts!.depth!.level).toBe('detailed');
    expect(verify(r, { roles: { 'partial-update': 'absent', validation: 'absent', defaults: 'absent', initialization: 'absent' } })).toEqual([]);
  });
  it('an excluded (disputed) dimension does not appear because the operation is detailed', () => {
    stances.archiveAsset = [{ dimension: 'audit', subject: 'archive', cardinality: 'single', value: 'negate' }];
    const r = run('archiveAsset');
    expect(r.facts!.depth!.excluded.length + (r.facts!.withdrawn?.length ?? 0)).toBeGreaterThan(0);
    expect(verify(r, { roles: { audit: 'absent', event: 'present' } })).toEqual([]);
  });
});

// ---- domain and architecture neutrality --------------------------------------------------------
describe('neutrality', () => {
  const contract: Contract = { roles: { ownership: 'present', rule: 'present', event: 'present' }, depth: 'detailed' };
  const make = (noun: string, plural: string, arch: 'inline' | 'helper' | 'nested' | 'shared') => {
    const lower = noun.toLowerCase();
    const body = `const found = await this.ledgerStore.findOne(entry);
      if (!found) throw new NotFoundException('${noun} not found');
      if (found.ownerId !== actorId) throw new ForbiddenException('Only the owner can archive a ${lower}');
      await this.ledgerStore.save(found); this.events.emit('${lower}.archived', {}); this.auditTrail.record({ action: 'archive' });`;
    const call = { inline: body, helper: 'await this.inner(actorId, entry);', nested: 'await this.outer(actorId, entry);', shared: 'await this.shared(actorId, entry);' }[arch];
    const extra = { inline: '', helper: `async inner(actorId: string, entry: ${noun}) { ${body} }`, nested: `async outer(actorId: string, entry: ${noun}) { await this.inner(actorId, entry); } async inner(actorId: string, entry: ${noun}) { ${body} }`, shared: '' }[arch];
    return project({
      controller: `@Controller('${plural}') export class ${noun}Controller { constructor(private readonly svc: ${noun}Service) {}
        @Post(':id/archive') archive${noun}(ctx: Ctx) { return this.svc.archive(ctx.principal.id); } }`,
      app: `export class ${noun}Service ${arch === 'shared' ? 'extends Base ' : ''}{ constructor(private readonly ledgerStore: LedgerStore, private readonly events: Events, private readonly auditTrail: AuditTrail) {}
        async archive(actorId: string, entry: ${noun}) { ${call} } ${extra} }`,
      shared: arch === 'shared' ? `export class Base { async shared(actorId: string, entry: any) { ${body} } }` : undefined,
    }, `${noun}Controller`)(`archive${noun}`);
  };

  it.each([['Order', 'orders'], ['Document', 'documents'], ['Task', 'tasks'], ['Account', 'accounts'], ['Project', 'projects']])('%s: the same contract holds', (noun, plural) => {
    const r = make(noun, plural, 'inline');
    expect(verify(r, { roles: { rule: 'present', event: 'present', audit: 'present' } })).toEqual([]);
  });

  it.each(['inline', 'helper', 'nested', 'shared'] as const)('%s organisation: the same contract holds', (arch) => {
    const r = make('Order', 'orders', arch);
    expect(r.failures.map((f) => f.consequence.status).sort()).toEqual([403, 404]);
    expect(verify(r, { roles: { rule: 'present', event: 'present', audit: 'present' } })).toEqual([]);
  });
  void contract;
});

describe('determinism and isolation across the suite', () => {
  const site = (operation: string) => ({ operation, depth: 0, shared: false, path: [operation], reachedWhen: [] as string[] });
  const v = (operation: string, status: number) => failureFromVariant({ status, message: 'Thing unavailable', when: '!thing' }, site(operation));

  it('operation isolation: the same condition and message in two operations never conflicts', () => {
    expect(failureConflicts([v('Op.a', 404), v('Op.b', 403)])).toEqual([]);
    expect(failureConflicts([v('Op.a', 404), v('Op.a', 403)])).toHaveLength(1);
  });

  it('semantic extraction is order-independent: depth and conflicts do not depend on evidence order', () => {
    const fs = [v('Op.a', 404), v('Op.a', 403), v('Op.b', 404), { ...v('Op.c', 409), reachedWhen: ['ready'] }, { ...v('Op.c', 410), reachedWhen: ['!ready'] }];
    const base = JSON.stringify(failureConflicts(fs));
    expect(JSON.stringify(failureConflicts([...fs].reverse()))).toBe(base);
    expect(JSON.stringify(failureConflicts([fs[3], fs[0], fs[4], fs[2], fs[1]]))).toBe(base);
    const facts = run('archiveAsset').facts!;
    const depth = JSON.stringify(decideDepth({ claims: facts.claims, constraints: facts.request.constraints, withdrawn: facts.withdrawn }));
    expect(JSON.stringify(decideDepth({ claims: [...facts.claims].reverse(), constraints: facts.request.constraints, withdrawn: facts.withdrawn }))).toBe(depth);
  });

  it('a dimension with only weak evidence is not written even though the operation is otherwise detailed', () => {
    const f = { ...run('archiveAsset').facts! };
    const weak = f.claims.map((c) => (c.kind === 'idempotence' ? { ...c, confidence: { ...c.confidence!, level: 'low' as const } } : c));
    const withDepth = { ...f, claims: weak, depth: decideDepth({ claims: weak, constraints: [], withdrawn: f.withdrawn }) };
    expect(withDepth.depth.excluded).toContainEqual({ dimension: 'idempotency', reason: 'low-confidence' });
    const out = composeStructured(withDepth);
    expect(out.represented).not.toContain('idempotency');
    expect(out.text).not.toMatch(/idempotent/);
  });

  it('the same operation yields byte-identical text and semantics', () => {
    const a = JSON.stringify(run('archiveAsset'));
    expect(JSON.stringify(run('archiveAsset'))).toBe(a);
  });
  it('every description in every run is free of implementation detail', () => {
    for (const { run: r } of runs) expect(r.text ?? '').not.toMatch(IMPLEMENTATION_NOISE);
  });
});
