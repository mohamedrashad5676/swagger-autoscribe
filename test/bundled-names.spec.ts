import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SourceIndex } from '../src/source/source-index';

describe('SourceIndex.canonicalName (bundler-renamed classes)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export class UsersController {}\nexport class Order2Service {}\n');
  const index = new SourceIndex({ roots: [dir] });
  index.build();

  it('maps esbuild/webpack suffixes and underscores back to the declared name', () => {
    expect(index.canonicalName('UsersController2')).toBe('UsersController');
    expect(index.canonicalName('_UsersController')).toBe('UsersController');
    expect(index.resolve('UsersController3', undefined, ['class'])).toBeDefined();
  });
  it.each([
    ['UsersController2', 'UsersController'], ['_UsersController', 'UsersController'], ['__UsersController', 'UsersController'],
    ['$UsersController', 'UsersController'], ['UsersController$1', 'UsersController'], ['UsersController_1', 'UsersController'],
    ['_UsersController2', 'UsersController'], ['UsersController$12', 'UsersController'], ['UsersController_default', 'UsersController'],
    ['users_users_controller_UsersController', 'UsersController'], ['app_UsersController', 'UsersController'],
    ['_Order2Service', 'Order2Service'], ['Order2Service$1', 'Order2Service'], ['Order2Service_1', 'Order2Service'],
  ])('%s -> %s', (runtime, declared) => {
    expect(index.canonicalName(runtime)).toBe(declared);
  });
  it.each(['UsersController', 'Order2Service', 'Nope', 'Nope2', '_Nope', 'x', '', 'anonymous', '_class'])(
    'leaves %p alone', (n) => { expect(index.canonicalName(n)).toBe(n); });
  it('never rewrites a name that exists, or one it cannot prove', () => {
    expect(index.canonicalName('Order2Service')).toBe('Order2Service');
    expect(index.canonicalName('Unknown7')).toBe('Unknown7');
  });
});

describe('SourceIndex.resolve disambiguation (same name, several files)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idx2-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = path.join(dir, 'a', 'items.ts');
  const b = path.join(dir, 'b', 'items.ts');
  fs.mkdirSync(path.dirname(a), { recursive: true });
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.writeFileSync(a, "@Controller('a-items')\nexport class ItemsController { one() {}\n  make() {} }\nexport class Dto { weight!: number; }\n");
  fs.writeFileSync(b, "@Controller('b-items')\nexport class ItemsController { one() {}\n  make() {} }\nexport class Dto { label!: string; }\n");
  const index = new SourceIndex({ roots: [dir] });
  index.build();

  it('path tail wins when the runtime file mirrors the source layout', () => {
    expect(index.resolve('ItemsController', '/x/dist/b/items.js')).toBe(b);
    expect(index.resolve('ItemsController', '/x/dist/a/items.js')).toBe(a);
  });
  it('string metadata (route) decides when every class lives in one bundle', () => {
    expect(index.resolve('ItemsController', '/x/bundle/main.mjs', undefined, ['one', 'make'], ['b-items'])).toBe(b);
    expect(index.resolve('ItemsController2', '/x/bundle/main.mjs', undefined, ['one', 'make'], ['a-items'])).toBe(a);
  });
  it('member names decide for DTOs', () => {
    expect(index.resolve('Dto', '/x/bundle/main.mjs', undefined, ['label'])).toBe(b);
    expect(index.resolve('Dto2', '/x/bundle/main.mjs', undefined, ['weight'])).toBe(a);
  });
});

describe('SourceIndex.resolveDecl: minified bundles (names are gone)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idx3-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'u.ts'), "@Controller('users')\nexport class UsersController { list() {}\n  one() {} }\n@Controller('orders')\nexport class OrdersController { list() {}\n  one() {} }\n");
  const index = new SourceIndex({ roots: [dir] });
  index.build();

  it('finds a controller by route literal + member names', () => {
    expect(index.resolveDecl('e', '/x/main.js', ['class'], ['list', 'one'], ['users'])?.name).toBe('UsersController');
    expect(index.resolveDecl('t', '/x/main.js', ['class'], ['list', 'one'], ['orders'])?.name).toBe('OrdersController');
  });
  it('refuses to guess: no literal, too few members, or an unknown member', () => {
    expect(index.resolveDecl('e', undefined, ['class'], ['list', 'one'], [])).toBeUndefined();
    expect(index.resolveDecl('e', undefined, ['class'], ['list'], ['users'])).toBeUndefined();
    expect(index.resolveDecl('e', undefined, ['class'], ['list', 'two'], ['users'])).toBeUndefined();
  });
});

describe('SourceIndex.resolveDtoByShape (minified DTO names)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idx4-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'd.ts'), `
export class CreateUserDto {
  @IsEmail({ each: true }) email!: string;
  @IsString() name!: string;
  note?: string; // "fake: prop"
  helper(a: number): { x: number } { const o = { notAProp: 1 }; return { x: a }; }
}
export class UserEntity { id!: number; email!: string; name!: string; note?: string; }
export class Small { only!: string; }
export class PairA { a!: string; b!: string; }
export class PairB { a!: string; b!: string; }
`);
  const index = new SourceIndex({ roots: [dir] });
  index.build();
  it('matches only an exact property set, ignoring method bodies, comments and strings', () => {
    expect(index.resolveDtoByShape(['email', 'name', 'note'])?.name).toBe('CreateUserDto');
    expect(index.resolveDtoByShape(['id', 'email', 'name', 'note'])?.name).toBe('UserEntity');
  });
  it('never guesses: subset, superset, one property, or ambiguous', () => {
    expect(index.resolveDtoByShape(['email', 'name'])).toBeUndefined();
    expect(index.resolveDtoByShape(['email', 'name', 'note', 'extra'])).toBeUndefined();
    expect(index.resolveDtoByShape(['only'])).toBeUndefined();
    expect(index.resolveDtoByShape(['a', 'b'])).toBeUndefined();
  });
});
