// Maps thrown exception names / codes to HTTP statuses (framework knowledge,
// optional: without it failures simply carry no status).

import type { MethodFactAdapter } from '../method-facts';

export const HTTP_EXCEPTION_STATUS: Record<string, number> = {
  BadRequestException: 400,
  UnauthorizedException: 401,
  PaymentRequiredException: 402,
  ForbiddenException: 403,
  NotFoundException: 404,
  MethodNotAllowedException: 405,
  NotAcceptableException: 406,
  RequestTimeoutException: 408,
  ConflictException: 409,
  GoneException: 410,
  PayloadTooLargeException: 413,
  UnprocessableEntityException: 422,
  InternalServerErrorException: 500,
  NotImplementedException: 501,
  BadGatewayException: 502,
  ServiceUnavailableException: 503,
  GatewayTimeoutException: 504,
};

// gRPC status code names -> HTTP.
export const RPC_CODE_STATUS: Record<string, number> = {
  INVALID_ARGUMENT: 400,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  FAILED_PRECONDITION: 400,
  RESOURCE_EXHAUSTED: 429,
  INTERNAL: 500,
  UNAVAILABLE: 503,
};

export function failureStatusAdapter(extra: { types?: Record<string, number>; codes?: Record<string, number> } = {}): MethodFactAdapter {
  const types = { ...HTTP_EXCEPTION_STATUS, ...extra.types };
  const codes = { ...RPC_CODE_STATUS, ...extra.codes };
  return {
    name: 'failure-status',
    onFinish(ctx) {
      for (const t of ctx.info.throws) {
        const mapped = t.code ? codes[t.code] : undefined;
        const status = mapped ?? types[t.type];
        if (status !== undefined) {
          t.status = status;
          t.statusBasis = mapped !== undefined ? 'code-mapping' : 'exception-type';
        }
      }
      for (const g of ctx.info.guards) {
        const mapped = g.thrown.code ? codes[g.thrown.code] : undefined;
        const status = mapped ?? types[g.thrown.type];
        if (status !== undefined) {
          g.thrown.status = status;
          g.thrown.statusBasis = mapped !== undefined ? 'code-mapping' : 'exception-type';
        }
      }
    },
  };
}
