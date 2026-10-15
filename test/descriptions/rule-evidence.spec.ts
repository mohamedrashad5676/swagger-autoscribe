// Operation-aware rule evidence and failure reachability, on a synthetic
// project with no relation to the real one.

import { ControllerRegistry } from '../../src/descriptions/controller-registry';
import { ServiceChainIndex } from '../../src/descriptions/service-chain';
import { deriveBusinessFacts } from '../../src/descriptions/business-facts';
import { reachableFailures } from '../../src/descriptions/error-reachability';
import { configureConventions, NEUTRAL_CONVENTIONS } from '../../src/descriptions/conventions';
import { failureStatusAdapter } from '../../src/descriptions/adapters/failure-status';
import type { ChainProfile } from '../../src/descriptions/hop-provider';
import { EMPTY_RESPONSE } from '../../src/descriptions/schema-facts';

const CONTROLLER = `
@Controller('orders')
export class OrderController {
  constructor(private readonly orders: OrderService) {}
  @Post(':orderId/cancel')
  cancel() { return this.orders.cancel(); }
  @Post(':orderId/approve')
  approve() { return this.orders.approve(); }
}`;
const SERVICE = `
export class OrderService {
  constructor(private readonly checks: Checks) {}
  async cancel(order: Order) {
    if (order.paid) throw new ConflictException('Cannot cancel a paid order');
    this.verify(order);
    throw new BadRequestException('Cannot cancel an empty order');
  }
  async approve(order: Order) {
    this.verify(order);
    if (order.approved) throw new ConflictException('The order is already approved');
  }
  verify(order: Order) {
    if (!order.address) throw new Error('Cannot ship without address');
    if (order.flagged) throw new ForbiddenException('Only unflagged orders are allowed');
    try { this.checks.run(); } catch (e) { throw new ServiceUnavailableException('Cannot reach the carrier'); }
  }
}`;
const SHARED = `
export class Checks {
  run() {
    throw new ConflictException('A shared check must never fail');
  }
  guarded(order: Order) {
    if (order.locked) throw new ConflictException('A locked order cannot be changed');
  }
}`;

const profile: ChainProfile = {
  entryRoot: 'app', entrySuffixes: ['.ts'], ancestorRoot: 'lib', discoverRoots: () => [], providers: [],
  methodAdapters: [failureStatusAdapter()], schemaProviders: [],
};

const chainOf = (method: string) => {
  const reg = new ControllerRegistry(profile.methodAdapters);
  reg.scanFile('/virtual/order.controller.ts', CONTROLLER);
  const idx = new ServiceChainIndex(reg, profile);
  idx.scanSource('app', '/virtual/order.service.ts', SERVICE);
  idx.scanSource('lib', '/virtual/checks.ts', SHARED);
  return idx.resolve('OrderController', method);
};
const factsOf = (method: string) => {
  const chain = chainOf(method);
  return deriveBusinessFacts({
    controllerClassName: 'OrderController', methodName: method, httpMethod: 'post', steps: chain.steps, crud: false,
    hasPagination: false, pathParams: ['orderId'], queryParams: [], request: [], response: EMPTY_RESPONSE,
  })!;
};

describe('failure reachability', () => {
  beforeAll(() => configureConventions(NEUTRAL_CONVENTIONS));

  it('classifies direct, indirect, conditional and infrastructure failures with their path', () => {
    const failures = reachableFailures(chainOf('cancel').steps);
    const conflict = failures.find((f) => f.thrown.message === 'Cannot cancel a paid order')!;
    expect(conflict).toMatchObject({ reach: 'indirect', relevant: true, consequence: { rejects: true, status: 409 } });
    expect(conflict.condition).toEqual({ text: 'order.paid', strength: 'observed' });
    expect(conflict.path).toEqual(['OrderController.cancel', 'OrderService.cancel']);
    const bare = failures.find((f) => f.thrown.message === 'Cannot cancel an empty order')!;
    expect(bare.condition.strength).toBe('none');
    const infra = failures.filter((f) => f.reach === 'infrastructure').map((f) => f.thrown.type).sort();
    expect(infra).toEqual(['Error', 'ServiceUnavailableException']);
    expect(failures.filter((f) => f.reach === 'infrastructure').every((f) => !f.relevant)).toBe(true);
  });

  it('a throw in the catch branch has a branch condition but no readable condition', () => {
    const f = reachableFailures(chainOf('cancel').steps).find((x) => x.thrown.type === 'ServiceUnavailableException')!;
    expect(f.condition.strength).toBe('branch');
  });

  it('infrastructure failures never become business rules', () => {
    const rules = factsOf('cancel').rules.join(' ');
    expect(rules).not.toMatch(/address|carrier/i);
  });

  it('each rule carries only its own evidence, with a call path', () => {
    const facts = factsOf('cancel');
    const rule = facts.ruleFacts.find((r) => /paid/.test(r.rule))!;
    expect(rule.reachability).toBe('indirect');
    expect(rule.condition).toBe('observed');
    const lines = rule.failures.flatMap((f) => f.evidence.map((e) => e.line));
    expect(lines.length).toBeGreaterThan(0);
    const claim = facts.claims.find((c) => c.kind === 'rule' && c.subject === rule.rule)!;
    // The cancelled-order rule is not supported by the unrelated throws in the same chain.
    const all = reachableFailures(chainOf('cancel').steps).flatMap((f) => f.evidence).length;
    expect(claim.evidence.length).toBeLessThan(all);
    expect(claim.evidence.every((e) => e.sourceFile.endsWith('order.service.ts'))).toBe(true);
  });

  it('a sibling operation does not inherit rules from a different path', () => {
    const rules = factsOf('approve').rules.join(' ');
    expect(rules).toMatch(/already be approved/i);
    expect(rules).not.toMatch(/paid/i);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(factsOf('cancel').ruleFacts)).toBe(JSON.stringify(factsOf('cancel').ruleFacts));
  });
});

// ---- existence claim and branch-specific shared helpers -----------------------

const ITEM_CONTROLLER = `
@Controller('items')
export class ItemController {
  constructor(private readonly items: ItemService) {}
  @Post(':itemId/cancel') cancelItem() { return this.items.cancelA(); }
  @Post(':itemId/approve') approveItem() { return this.items.approveB(); }
  @Post(':itemId/archive') archiveItem() { return this.items.archiveC(); }
  @Post(':itemId/remove') removeItem() { return this.items.removeD(); }
  @Post(':itemId/suspend') suspendItem() { return this.items.suspendE(); }
  @Post(':itemId/lock') lockItem() { return this.items.lockF(); }
  @Post(':itemId/unlock') unlockItem() { return this.items.unlockG(); }
}`;
const ITEM_SERVICE = `
export class ItemService extends Helpers {
  async cancelA(item: Item) {
    if (!item) throw new NotFoundException('Item not found');
    item.state = 'cancelled';
  }
  async approveB(item: Item) {
    item.state = 'approved';
  }
  async archiveC() { this.lookup(); }
  async removeD(item: Item) { this.lookupGuarded(item); }
  async suspendE(item: Item) {
    if (item.vip) throw new NotFoundException('Not here');
  }
  async lockF(flag: boolean, item: Item) {
    if (flag) { this.check('a', item); }
  }
  async unlockG(item: Item) { this.check('b', item); }
}`;
const ITEM_HELPERS = `
export class Helpers {
  lookup() { throw new NotFoundException('Missing'); }
  lookupGuarded(item: Item) { if (!item) throw new NotFoundException('Missing item'); }
  check(kind: string, item: Item) {
    if (kind === 'a') throw new ConflictException('Kind a is locked');
    if (kind === 'b') throw new ConflictException('Kind b is locked');
  }
}`;
const itemChain = (method: string) => {
  const reg = new ControllerRegistry(profile.methodAdapters);
  reg.scanFile('/virtual/item.controller.ts', ITEM_CONTROLLER);
  const idx = new ServiceChainIndex(reg, profile);
  idx.scanSource('app', '/virtual/item.service.ts', ITEM_SERVICE);
  idx.scanSource('lib', '/virtual/helpers.ts', ITEM_HELPERS);
  return idx.resolve('ItemController', method);
};
const itemFacts = (method: string) =>
  deriveBusinessFacts({
    controllerClassName: 'ItemController', methodName: method, httpMethod: 'post', steps: itemChain(method).steps, crud: false,
    hasPagination: false, pathParams: ['itemId'], queryParams: [], request: [], response: EMPTY_RESPONSE,
  });

describe('existence claim', () => {
  beforeAll(() => configureConventions(NEUTRAL_CONVENTIONS));

  it('A: a relevant not-found guarded by an absence check supports the claim', () => {
    const facts = itemFacts('cancelItem')!;
    expect(facts.existence).toBe('the specified item must already exist');
    const claim = facts.claims.find((c) => c.kind === 'existence')!;
    expect(claim.evidence.length).toBeGreaterThan(0);
    expect(claim.evidence.every((e) => e.sourceFile.endsWith('item.service.ts'))).toBe(true);
  });

  it('B: a not-found in a sibling operation that is not reached gives no claim', () => {
    expect(itemFacts('approveItem')?.existence).toBeUndefined();
  });

  it('C: a shared helper throwing not-found with no readable condition gives no claim', () => {
    expect(itemFacts('archiveItem')?.existence).toBeUndefined();
  });

  it('shared code with an observed absence check is relevant and gives the claim', () => {
    const facts = itemFacts('removeItem')!;
    expect(facts.existence).toBe('the specified item must already exist');
    expect(facts.claims.find((c) => c.kind === 'existence')!.evidence.every((e) => e.sourceFile.endsWith('helpers.ts'))).toBe(true);
  });

  it('a not-found whose condition is not an absence check does not state existence', () => {
    expect(itemFacts('suspendItem')?.existence).toBeUndefined();
  });
});

describe('branch-specific shared helpers', () => {
  it('records the call edge with its observed branch condition and arguments', () => {
    const step = itemChain('lockItem').steps.find((s) => s.methodName === 'check')!;
    expect(step.via).toMatchObject({ caller: 'ItemService.lockF', callee: 'ItemService.check', condition: 'flag', args: ["'a'", 'item'] });
    expect(step.reachedWhen).toEqual(['flag']);
    expect(step.shared).toBe(true);
  });

  it('keeps only the failures the literal call argument can trigger', () => {
    const failures = reachableFailures(itemChain('lockItem').steps).filter((f) => f.path.includes('Helpers.check'));
    const kindA = failures.find((f) => f.thrown.message === 'Kind a is locked')!;
    const kindB = failures.find((f) => f.thrown.message === 'Kind b is locked')!;
    expect(kindA).toMatchObject({ reach: 'shared', relevant: true, reachedWhen: ['flag'] });
    expect(kindB).toMatchObject({ reach: 'unreachable', relevant: false });
  });

  it('the sibling operation gets the opposite branch from the same helper', () => {
    const failures = reachableFailures(itemChain('unlockItem').steps).filter((f) => f.path.includes('Helpers.check'));
    expect(failures.find((f) => f.thrown.message === 'Kind b is locked')?.relevant).toBe(true);
    expect(failures.find((f) => f.thrown.message === 'Kind a is locked')?.reach).toBe('unreachable');
  });

  it('an unconditional call adds no branch condition and a bare throw stays NONE', () => {
    const step = itemChain('unlockItem').steps.find((s) => s.methodName === 'check')!;
    expect(step.via?.condition).toBeUndefined();
    expect(step.reachedWhen).toEqual([]);
    const bare = reachableFailures(itemChain('archiveItem').steps).find((f) => f.thrown.message === 'Missing')!;
    expect(bare.condition.strength).toBe('none');
    expect(bare).toMatchObject({ reach: 'shared', relevant: false });
  });
});

describe('existence claim: accepted absence evidence', () => {
  const CONTROLLER = (names: string[]) => `
@Controller('things')
export class ThingController {
  constructor(private readonly things: ThingService) {}
${names.map((n) => `  @Post(':thingId/${n}') ${n}() { return this.things.${n}(); }`).join('\n')}
}`;
  const SERVICE = `
export class ThingService {
  async cancelStrict(thing: Thing) { if (thing === null) throw new NotFoundException('Thing not found'); }
  async cancelLoose(thing: Thing) { if (thing == null) throw new NotFoundException('Thing not found'); }
  async cancelRows(rows: Thing[]) { if (rows.length === 0) throw new NotFoundException('Thing not found'); }
  async cancelNegated(thing: Thing) { if (!thing) throw new NotFoundException('Thing not found'); }
  async cancelUnrelated(thing: Thing) { if (thing.locked) throw new NotFoundException('Thing not found'); }
}`;
  const names = ['cancelStrict', 'cancelLoose', 'cancelRows', 'cancelNegated', 'cancelUnrelated'];
  const existenceOf = (method: string, adapters = profile.methodAdapters) => {
    const p = { ...profile, methodAdapters: adapters };
    const reg = new ControllerRegistry(p.methodAdapters);
    reg.scanFile('/virtual/thing.controller.ts', CONTROLLER(names));
    const idx = new ServiceChainIndex(reg, p);
    idx.scanSource('app', '/virtual/thing.service.ts', SERVICE);
    return deriveBusinessFacts({
      controllerClassName: 'ThingController', methodName: method, httpMethod: 'post', steps: idx.resolve('ThingController', method).steps,
      crud: false, hasPagination: false, pathParams: ['thingId'], queryParams: [], request: [], response: EMPTY_RESPONSE,
    })?.existence;
  };
  beforeAll(() => configureConventions(NEUTRAL_CONVENTIONS));

  it.each(['cancelStrict', 'cancelLoose', 'cancelRows', 'cancelNegated'])('%s: an absence check supports the claim', (m) => {
    expect(existenceOf(m)).toMatch(/must already exist/);
  });
  it('a not-found guarded by a non-absence condition gives no claim', () => {
    expect(existenceOf('cancelUnrelated')).toBeUndefined();
  });
  it('without a status mapping the failure is not known to be a not-found, so no claim', () => {
    expect(existenceOf('cancelNegated', [])).toBeUndefined();
  });
});
