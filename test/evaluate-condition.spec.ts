import { evaluateCondition } from '../src/descriptions/error-reachability';

const env = (o: Record<string, unknown>): Map<string, { value: unknown }> => new Map(Object.entries(o).map(([k, v]) => [k, { value: v }]));

describe('evaluateCondition (three-valued)', () => {
  it.each([
    ["kind === 'a'", { kind: 'a' }, true],
    ["kind === 'a'", { kind: 'b' }, false],
    ["kind !== 'a'", { kind: 'b' }, true],
    ['!flag', { flag: false }, true],
    ['!flag', { flag: true }, false],
    ['flag', { flag: 0 }, false],
    ["(kind === 'a' || kind === 'b') && !flag", { kind: 'b', flag: false }, true],
    ["(kind === 'a' || kind === 'b') && !flag", { kind: 'c', flag: false }, false],
    ['!(a && b)', { a: true, b: true }, false],
    ['n > 3', { n: 5 }, true],
    ['n >= 5 && n < 5', { n: 5 }, false],
    ['n == null', { n: null }, true],
    ['x === undefined', { x: undefined }, true],
    ['"a" === kind', { kind: 'a' }, true],
  ])('%s with %j -> %s', (cond, bound, expected) => {
    expect(evaluateCondition(cond, env(bound))).toBe(expected);
  });
  it.each([
    ["other === 'a'", {}],
    ["other === 'a' && kind === 'a'", { kind: 'a' }],
    ["kind === 'a' || other", { kind: 'b' }],
    ['user.role === 1', { user: 1 }],
    ['fn(x)', { x: 1 }],
    ['a ? b : c', { a: true }],
    ['a ?? b', { a: 1 }],
    ['typeof kind === "string"', { kind: 'a' }],
    ["kind === 'it\\'s'", { kind: 'a' }],
    ['(a', { a: 1 }],
    ['a = 1', { a: 1 }],
  ])('cannot tell: %s', (cond, bound) => {
    expect(evaluateCondition(cond, env(bound as Record<string, unknown>))).toBeUndefined();
  });
  it('short-circuits only when proven', () => {
    expect(evaluateCondition("other && kind === 'x'", env({ kind: 'a' }))).toBe(false);
  });
});
