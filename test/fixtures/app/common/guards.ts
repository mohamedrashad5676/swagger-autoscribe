import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY } from './decorators';

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.get<boolean>(IS_PUBLIC_KEY, context.getHandler())) return true;
    const req = context.switchToHttp().getRequest();
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      throw new UnauthorizedException('Authorization header is missing');
    }
    const [scheme, token] = authHeader.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException();
    }
    return true;
  }
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.get<string[]>(PERMISSIONS_KEY, context.getHandler()) ?? [];
    if (required.length === 0) return true;
    for (const p of required) {
      throw new ForbiddenException(`Permission denied: '${p}' is required`);
    }
    return true;
  }
}

// Used only through @UseGuards on one controller (NOT global).
@Injectable()
export class BetaGuard implements CanActivate {
  canActivate(): boolean {
    throw new ForbiddenException('Beta feature is not enabled for this account');
  }
}
