import 'reflect-metadata';
import { generateSummary } from '../src/enhancer/summary';
import { rateLimitsFor, describeWindow } from '../src/enhancer/throttle';

const s = (controllerName: string, methodName: string, httpMethod: string, path: string, resourceName?: string): string | undefined =>
  generateSummary({ controllerName, methodName, httpMethod, path, resourceName });

describe('generateSummary', () => {
  it.each([
    ['UsersController', 'findAll', 'get', '/users', 'List users'],
    ['UsersController', 'findAllUsers', 'get', '/users', 'List users'],
    ['UsersController', 'getUsers', 'get', '/users', 'List users'],
    ['UsersController', 'findOne', 'get', '/users/{id}', 'Get user'],
    ['UsersController', 'getUserById', 'get', '/users/{id}', 'Get user by id'],
    ['UsersController', 'createUser', 'post', '/users', 'Create user'],
    ['UsersController', 'update', 'patch', '/users/{id}', 'Update user'],
    ['UsersController', 'remove', 'delete', '/users/{id}', 'Delete user'],
    ['CategoriesController', 'create', 'post', '/categories', 'Create category'],
    ['CategoriesController', 'findAll', 'get', '/categories', 'List categories'],
    ['AddressesController', 'findOne', 'get', '/a/{id}', 'Get address'],
    ['UserProfilesController', 'create', 'post', '/p', 'Create user profile'],
    ['UsersController', 'one', 'get', '/users/{id}', 'Get user'],
    ['AuthController', 'login', 'post', '/auth/login', 'Login'],
    ['AuthController', 'refreshToken', 'post', '/auth/refresh', 'Refresh token'],
    ['StatusController', 'findAll', 'get', '/status', 'List statuses'],
  ])('%s.%s -> %s', (c, m, v, p, expected) => {
    // "getUserById" has no dedicated rule: the humanised name is the honest fallback.
    expect(s(c, m, v, p)).toBe(expected);
  });
  it('prefers the resource class name', () => {
    expect(s('MixedController', 'findAll', 'get', '/x', 'InvoiceResource')).toBe('List invoices');
  });
});

describe('rateLimitsFor', () => {
  class ThrottlerGuard {}
  const info = (handler: Function = function h() {}, controller: Function = class C {}): any => ({ handler, controller });
  it('v6 array options', () => {
    class G extends ThrottlerGuard {
      throttlers = [{ name: 'short', limit: 3, ttl: 1000 }, { limit: 100, ttl: 60000 }];
    }
    expect(rateLimitsFor(info(), [new G()])).toEqual([
      { name: 'short', limit: 3, ttlMs: 1000 },
      { name: 'default', limit: 100, ttlMs: 60000 },
    ]);
  });
  it('v4 flat options: ttl in seconds, unnamed metadata keys', () => {
    class G extends ThrottlerGuard {
      options = { limit: 5, ttl: 60 };
    }
    const handler = function h() {};
    Reflect.defineMetadata('THROTTLER:LIMIT', 7, handler);
    expect(rateLimitsFor(info(handler), [new G()])).toEqual([{ name: 'default', limit: 7, ttlMs: 60000 }]);
    Reflect.defineMetadata('THROTTLER:SKIP', true, handler);
    expect(rateLimitsFor(info(handler), [new G()])).toEqual([]);
  });
  it('function ttl/limit, class-level skip, other guards ignored', () => {
    class G extends ThrottlerGuard {
      throttlers = [{ limit: () => 4, ttl: () => 2000 }];
    }
    expect(rateLimitsFor(info(), [new G()])).toEqual([{ name: 'default', limit: 4, ttlMs: 2000 }]);
    const ctl = class C2 {};
    Reflect.defineMetadata('THROTTLER:SKIPdefault', true, ctl);
    expect(rateLimitsFor(info(undefined, ctl), [new G()])).toEqual([]);
    expect(rateLimitsFor(info(), [{}])).toEqual([]);
  });
  it('describeWindow', () => {
    expect([describeWindow(1000), describeWindow(60000), describeWindow(3600000), describeWindow(1500)]).toEqual(['1 second', '1 minute', '1 hour', '1500 ms']);
  });
});
