import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { RuntimeErrorScanner } from '../src/errors/scanner';

// Fake service behind a fake controller — proves the transitive
// `this.svc.method()` walk without any NestJS testing module: the scanner
// only needs live objects + Function.toString, so plain classes suffice.
// NOTE: jest compiles this file to CJS, so at runtime these read as
// `new common_1.BadRequestException(...)` — exactly like production dist
// output, which is what the scanner's dotted-path handling targets.
export class FakeMeetingService {
  async startMeeting(): Promise<void> {
    try {
      await this.callDownstream();
    } catch (err) {
      throw this.restoreTokenError(err);
    }
  }

  private async callDownstream(): Promise<void> {
    throw new Error('TOKEN_ERROR expired');
  }

  private restoreTokenError(err: unknown): unknown {
    const message = (err as Error)?.message ?? '';
    if (message.includes('TOKEN_ERROR')) {
      return new HttpException({ message, token_not_valid: true }, HttpStatus.PAYMENT_REQUIRED);
    }
    return err;
  }
}

class FakeMeetingController {
  constructor(private readonly meetings: FakeMeetingService = new FakeMeetingService()) {}

  async start(body: { idempotencyKey?: string }): Promise<unknown> {
    if (!body?.idempotencyKey) {
      throw new BadRequestException('idempotencyKey is required — reuse the same key on retry');
    }
    return this.meetings.startMeeting();
  }

  async conflict(): Promise<void> {
    throw new ConflictException({ started: false, waiting: true, retryAfterSeconds: 30 });
  }

  async templated(permission: string): Promise<void> {
    throw new ForbiddenException(`Permission denied: '${permission}' is required`);
  }

  async bare(): Promise<void> {
    throw new UnauthorizedException();
  }

  async ignored(): Promise<void> {
    const err = new Error('not an HttpException subclass');
    throw err;
  }
}

class CyclicA {
  b!: CyclicB;
  go(): void {
    this.b.go();
  }
}

class CyclicB {
  a!: CyclicA;
  go(): void {
    throw new NotFoundException('gone');
  }
}

// Collaborators travel by reference in DI graphs, where every provider
// class is module-exported — export the doubles so require.cache resolves
// them exactly like production classes.
export { CyclicA, CyclicB };

// Module-scope mapper a la throwFromGrpcError / throwFromOrgRoleError:
// bare function in the SAME file, throwing per error code.
function throwFromDomain(code: string): never {
  switch (code) {
    case 'NOPE':
      throw new NotFoundException('domain gone');
    default:
      throw new BadRequestException('domain bad');
  }
}

function shadowed(): void {
  throw new ConflictException('must never be documented');
}

class UsesMapperController {
  async go(code: string): Promise<void> {
    throwFromDomain(code);
  }

  async shadowedCall(): Promise<void> {
    const shadowed = (): string => 'local';
    shadowed();
  }
}

// Production controllers/services are always module-exported (they are
// referenced from @Module metadata), which is exactly how require.cache
// resolves their file. Export the double for the same reason.
export { UsesMapperController };

class FakeGuard {
  async canActivate(kind: string): Promise<boolean> {
    if (!kind) {
      throw new UnauthorizedException();
    }
    if (kind !== 'Bearer') {
      throw new UnauthorizedException();
    }
    try {
      await this.verify(kind);
    } catch (error) {
      throw new UnauthorizedException();
    }
    return true;
  }

  private async verify(_kind: string): Promise<void> {
    return undefined;
  }
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { FakeFrameworkClient } = require('./fixtures/scanner/node_modules/fake-framework');

class UsesFrameworkController {
  constructor(private readonly fw = new FakeFrameworkClient()) {}

  async go(): Promise<void> {
    await this.fw.fetch();
  }
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { FakeSharedGrpcClientFactory } = require('./fixtures/scanner/workspace-pkg/fake-shared-service');

// Mirrors the real ActiveMembershipGuard / PermissionResolverService shape:
// an injected collaborator whose CLASS lives in a workspace package
// (@onmeeting/shared) resolved through a node_modules symlink.
class UsesWorkspacePackageController {
  constructor(private readonly clientFactory = new FakeSharedGrpcClientFactory()) {}

  async go(): Promise<void> {
    await this.clientFactory.getClient();
  }
}

describe('RuntimeErrorScanner', () => {
  const scanner = new RuntimeErrorScanner();

  it('captures a literal constructor message with its status', () => {
    const variants = scanner.scanEndpoint(new FakeMeetingController(), 'start');
    const bad = variants.find((v) => v.status === 400);
    expect(bad).toBeDefined();
    expect(bad?.message).toBe('idempotencyKey is required — reuse the same key on retry');
  });

  it('follows this.service.method() and resolves HttpStatus enum refs to 402', () => {
    const variants = scanner.scanEndpoint(new FakeMeetingController(), 'start');
    const payment = variants.find((v) => v.status === HttpStatus.PAYMENT_REQUIRED);
    expect(payment).toBeDefined();
    expect(payment?.schema?.properties?.token_not_valid).toEqual({ type: 'boolean', example: true });
    expect(payment?.schema?.properties?.message).toBeDefined();
  });

  it('turns object-literal bodies into schemas', () => {
    const variants = scanner.scanEndpoint(new FakeMeetingController(), 'conflict');
    const conflict = variants.find((v) => v.status === 409);
    expect(conflict).toBeDefined();
    expect(conflict?.schema?.properties?.started).toEqual({ type: 'boolean', example: false });
    expect(conflict?.schema?.properties?.waiting).toEqual({ type: 'boolean', example: true });
    expect(conflict?.schema?.properties?.retryAfterSeconds).toEqual({ type: 'number', example: 30 });
  });

  it('flags template-literal messages instead of faking a literal', () => {
    const variants = scanner.scanEndpoint(new FakeMeetingController(), 'templated');
    const forbidden = variants.find((v) => v.status === 403);
    expect(forbidden).toBeDefined();
    expect(forbidden?.isTemplate).toBe(true);
    expect(forbidden?.templateRaw).toContain('${');
    // Runtime values aren't known statically, but the surrounding text is —
    // each interpolation is swapped for a plausible example value so
    // Swagger shows real content instead of falling back to the raw `if`
    // condition or leaking the source expression.
    expect(forbidden?.message).toBeDefined();
    expect(forbidden?.message).not.toContain('${');
    expect(forbidden?.message).not.toMatch(/[{}]/);
  });

  it('keeps bare exceptions as generic shapes (no message)', () => {
    const variants = scanner.scanEndpoint(new FakeMeetingController(), 'bare');
    const unauthorized = variants.find((v) => v.status === 401);
    expect(unauthorized).toBeDefined();
    expect(unauthorized?.message).toBeUndefined();
    expect(unauthorized?.schema).toBeUndefined();
  });

  it('ignores non-Nest errors', () => {
    const variants = scanner.scanEndpoint(new FakeMeetingController(), 'ignored');
    expect(variants).toEqual([]);
  });

  it('terminates on cyclic service graphs', () => {
    const a = new CyclicA();
    const b = new CyclicB();
    a.b = b;
    b.a = a;
    const variants = scanner.scanEndpoint(a, 'go');
    expect(variants.some((v) => v.status === 404 && v.message === 'gone')).toBe(true);
  });

it('splits bare throws by their enclosing if condition', () => {
     const variants = scanner.scanMethod(new FakeGuard(), 'canActivate');
     const unauthorized = variants.filter((v) => v.status === 401);
     expect(unauthorized.length).toBe(2);
     expect(unauthorized.some((v) => v.condition === '!kind')).toBe(true);
     expect(unauthorized.some((v) => v.condition === "kind !== 'Bearer'")).toBe(true);
     // Guard internal errors (catch (error)) are skipped
     expect(unauthorized.some((v) => v.condition === 'catch (error)')).toBe(false);
   });

  it('never walks into node_modules framework code', () => {
    const variants = scanner.scanEndpoint(new UsesFrameworkController(), 'go');
    expect(variants).toEqual([]);
  });

  it('walks into a workspace package resolved through a node_modules symlink', () => {
    const variants = scanner.scanEndpoint(new UsesWorkspacePackageController(), 'go');
    expect(
      variants.some((v) => v.status === HttpStatus.PAYMENT_REQUIRED && v.message === 'shared client factory blew up'),
    ).toBe(true);
  });

  it('follows bare same-file mapper functions', () => {
    const variants = scanner.scanEndpoint(new UsesMapperController(), 'go');
    expect(variants.some((v) => v.status === 404 && v.message === 'domain gone')).toBe(true);
    expect(variants.some((v) => v.status === 400 && v.message === 'domain bad')).toBe(true);
  });

  it('does not follow names shadowed by locals', () => {
    const variants = scanner.scanEndpoint(new UsesMapperController(), 'shadowedCall');
    expect(variants).toEqual([]);
  });
});
