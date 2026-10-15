import { RequestMethod, VERSION_NEUTRAL, VersioningType, type INestApplication } from '@nestjs/common';
import {
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
  EXCEPTION_FILTERS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  PIPES_METADATA,
  ROUTE_ARGS_METADATA,
  VERSION_METADATA,
} from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { AuthOptions, HandlerContext, MetadataKey, PaginationOptions, RbacOptions, ResourceOptions } from '../types';
import { ProviderLookup, type ContainerLike } from './di';

const meta = (key: MetadataKey, target: object, prop?: string | symbol): unknown => {
  const api = Reflect as unknown as { getMetadata?: (k: unknown, t: object, p?: string | symbol) => unknown };
  return prop === undefined ? api.getMetadata?.(key, target) : api.getMetadata?.(key, target, prop);
};

/** Express-style path -> comparable form: leading slash, no trailing slash, `{id}` -> `:id`, regex/optional params stripped. */
export function normalizeRoutePath(raw: string): string {
  let p = raw
    .replace(/\{([^}]+)\}/g, ':$1')
    .replace(/(:[A-Za-z0-9_]+)\([^)]*\)/g, '$1')
    .replace(/(:[A-Za-z0-9_]+)\?/g, '$1')
    .replace(/\/+/g, '/');
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

function joinPath(...parts: Array<string | undefined>): string {
  return normalizeRoutePath(parts.filter((p) => p !== undefined && p !== '').join('/') || '/');
}

const toList = (v: unknown): string[] => {
  if (v === undefined || v === null) return [''];
  if (Array.isArray(v)) return v.length ? v.map(String) : [''];
  return [String(v)];
};

export interface UploadRules {
  /** Bytes. */
  maxSize?: number;
  /** MIME type or pattern text from `FileTypeValidator`. */
  fileType?: string;
  required?: boolean;
}

/** Reads `ParseFilePipe` validators generically (v10 `validationOptions`, v11 same shape). */
function uploadRulesOf(pipes: unknown[] | undefined): UploadRules | undefined {
  const rules: UploadRules = {};
  for (const pipe of pipes ?? []) {
    const p = pipe as { validators?: unknown[]; fileIsRequired?: boolean } | undefined;
    if (!p || !Array.isArray(p.validators)) continue;
    if (p.fileIsRequired === false) rules.required = false;
    for (const v of p.validators) {
      const opts = ((v as { validationOptions?: Record<string, unknown> }).validationOptions ?? (v as { options?: Record<string, unknown> }).options ?? {}) as Record<string, unknown>;
      const name = (v as { constructor?: { name?: string } }).constructor?.name ?? '';
      if (/MaxFileSize/i.test(name) && typeof opts.maxSize === 'number') rules.maxSize = opts.maxSize;
      if (/FileType/i.test(name) && opts.fileType !== undefined) rules.fileType = String(opts.fileType);
    }
  }
  return Object.keys(rules).length ? rules : undefined;
}

export interface HandlerInfo {
  /** Lower-case OpenAPI method, or `all` for `@All()`. */
  httpMethod: string;
  controller: Function;
  controllerName: string;
  /** Name the class has at runtime, when it differs from `controllerName` (renamed by a bundler / minifier). */
  runtimeControllerName?: string;
  methodName: string;
  handler: Function;
  /** Live (or prototype-only for non-static scopes) controller instance — the error scanner walks it. */
  instance: object;
  isPublic: boolean;
  requiredPermissions: string[];
  hasPagination: boolean;
  /** Response transformer class declared through `resource.metadataKey`. */
  resourceClass: Function | undefined;
  /** Which `resource` convention produced `resourceClass`. */
  resourceSpec: ResourceOptions | undefined;
  /** @Body() DTO class from route-args + design:paramtypes. */
  bodyDtoClass: Function | undefined;
  /** `@Query() dto: SomeDto` class (whole-object binding, not `@Query('name')`). */
  queryDtoClass: Function | undefined;
  /** `@Param() dto` / `@Headers() dto` whole-object classes. */
  pathDtoClass: Function | undefined;
  headerDtoClass: Function | undefined;
  /** `@UploadedFile()` / `@UploadedFiles()` presence from route-args. */
  uploadArg: 'file' | 'files' | undefined;
  /** Limits from a `ParseFilePipe` on the upload argument. */
  uploadRules: UploadRules | undefined;
  /** True when ParseArrayPipe({ items }) is used on @Body(). */
  isArrayBody: boolean;
  /** Pipes attached to the @Body() argument. */
  bodyPipes: unknown[];
  /** Candidate full paths (global prefix / version / module path included), comparable form. */
  fullPaths: string[];
  /** controller + method path only, comparable form. */
  relativePaths: string[];
  /** Classes/instances from @UseGuards/@UseFilters/@UseInterceptors/@UsePipes (controller first, then handler). */
  enhancers: { guards: unknown[]; filters: unknown[]; interceptors: unknown[]; pipes: unknown[] };
}

export interface ScanInput {
  app: INestApplication;
  container: ContainerLike;
  lookup: ProviderLookup;
  auth: AuthOptions | false;
  rbac: RbacOptions | false;
  pagination: PaginationOptions | false;
  resource: ResourceOptions[];
}

interface AppConfigLike {
  getGlobalPrefix?: () => string;
  getVersioning?: () => { type?: VersioningType; prefix?: string | false; defaultVersion?: unknown } | undefined;
}

const DEFAULT_PUBLIC_KEYS: MetadataKey[] = ['isPublic', 'IS_PUBLIC_KEY', 'public', 'IS_PUBLIC'];

const METHOD_BY_ENUM: Record<number, string> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.DELETE]: 'delete',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.ALL]: 'all',
  [RequestMethod.OPTIONS]: 'options',
  [RequestMethod.HEAD]: 'head',
  // SEARCH exists in Nest >= 10.3 only; harmless lookup when absent.
  ...((RequestMethod as unknown as Record<string, number>).SEARCH !== undefined
    ? { [(RequestMethod as unknown as Record<string, number>).SEARCH]: 'search' }
    : {}),
};

/** Every method name reachable on the prototype chain (inherited handlers included), without touching getters. */
function methodNamesOf(prototype: object): string[] {
  const names = new Set<string>();
  let proto: object | null = prototype;
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (desc && typeof desc.value === 'function') names.add(name);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return Array.from(names);
}

export function scanHandlers(input: ScanInput): HandlerInfo[] {
  const { app, container, lookup } = input;
  const config = (app as unknown as { config?: AppConfigLike }).config;
  const prefix = (() => {
    try {
      return (config?.getGlobalPrefix?.() ?? '').replace(/\/+$/, '');
    } catch {
      return '';
    }
  })();
  const versioning = (() => {
    try {
      return config?.getVersioning?.();
    } catch {
      return undefined;
    }
  })();
  const uriVersionPrefix =
    versioning?.type === VersioningType.URI
      ? versioning.prefix === false
        ? ''
        : (versioning.prefix ?? 'v')
      : undefined;

  const reflector = new Reflector();
  const handlers: HandlerInfo[] = [];

  for (const module of container.values()) {
    const modulePath = lookup.modulePathOf(module.metatype);
    for (const wrapper of module.controllers?.values() ?? []) {
      const instance = wrapper.instance as object | undefined;
      if (!instance || typeof instance !== 'object') continue;
      const controller = ((wrapper.metatype as Function | undefined) ?? (instance.constructor as Function)) as Function;
      const controllerName = (instance.constructor as Function | undefined)?.name ?? controller.name ?? '';
      const prototype = Object.getPrototypeOf(instance) as object;
      const ctrlPaths = toList(meta(PATH_METADATA, controller));

      for (const methodName of methodNamesOf(prototype)) {
        const handler = (prototype as Record<string, unknown>)[methodName] as Function;
        const methodEnum = meta(METHOD_METADATA, handler) as number | undefined;
        if (methodEnum === undefined || methodEnum === null) continue;
        const httpMethod = METHOD_BY_ENUM[methodEnum];
        if (!httpMethod) continue;

        const methodPaths = toList(meta(PATH_METADATA, handler));
        const ctx: HandlerContext = {
          controller,
          controllerName,
          handler,
          methodName,
          httpMethod,
          reflector,
          getMetadata: <T>(key: MetadataKey) => (meta(key, handler) ?? meta(key, controller)) as T | undefined,
        };

        // --- route paths: [global prefix][/v1][module path][controller][method], like Nest's RoutePathFactory
        const version = meta(VERSION_METADATA, handler) ?? meta(VERSION_METADATA, controller) ?? versioning?.defaultVersion;
        const versionSegments: string[] = [''];
        if (uriVersionPrefix !== undefined && version !== undefined && version !== null) {
          const versions = Array.isArray(version) ? version : [version];
          versionSegments.length = 0;
          for (const v of versions) versionSegments.push(v === VERSION_NEUTRAL ? '' : `${uriVersionPrefix}${String(v)}`);
        }
        const fullPaths = new Set<string>();
        const relativePaths = new Set<string>();
        for (const modulePart of toList(modulePath)) {
          for (const c of ctrlPaths) {
            for (const m of methodPaths) {
              relativePaths.add(joinPath(c, m));
              for (const v of versionSegments) {
                const bare = joinPath(v, modulePart, c, m);
                fullPaths.add(bare);
                if (prefix) fullPaths.add(joinPath(prefix, bare));
              }
            }
          }
        }

        const isPublic = decidePublic(input.auth, ctx);
        handlers.push({
          httpMethod,
          controller,
          controllerName,
          methodName,
          handler,
          instance,
          isPublic,
          requiredPermissions: readPermissions(input.rbac, ctx),
          hasPagination: detectPagination(input.pagination, ctx, prototype),
          ...findResource(input.resource, handler),
          ...resolveBody(prototype, controller, methodName),
          ...resolveQueryAndUpload(prototype, controller, methodName),
          fullPaths: Array.from(fullPaths),
          relativePaths: Array.from(relativePaths),
          enhancers: {
            guards: enhancerList(GUARDS_METADATA, controller, handler),
            filters: enhancerList(EXCEPTION_FILTERS_METADATA, controller, handler),
            interceptors: enhancerList(INTERCEPTORS_METADATA, controller, handler),
            pipes: enhancerList(PIPES_METADATA, controller, handler),
          },
        });
      }
    }
  }
  return handlers;
}

function findResource(
  specs: ResourceOptions[],
  handler: Function,
): { resourceClass: Function | undefined; resourceSpec: ResourceOptions | undefined } {
  for (const spec of specs) {
    const value = meta(spec.metadataKey, handler);
    if (typeof value === 'function') return { resourceClass: value, resourceSpec: spec };
  }
  return { resourceClass: undefined, resourceSpec: undefined };
}

function enhancerList(key: string, controller: Function, handler: Function): unknown[] {
  const fromCtrl = (meta(key, controller) as unknown[] | undefined) ?? [];
  const fromHandler = (meta(key, handler) as unknown[] | undefined) ?? [];
  return [...fromCtrl, ...fromHandler];
}

function decidePublic(auth: AuthOptions | false, ctx: HandlerContext): boolean {
  if (auth === false) return false;
  const custom = auth.isPublic?.(ctx);
  if (custom !== undefined) return custom;
  const keys = auth.publicMetadataKeys ?? DEFAULT_PUBLIC_KEYS;
  return keys.some((k) => Boolean(ctx.getMetadata(k)));
}

function readPermissions(rbac: RbacOptions | false, ctx: HandlerContext): string[] {
  if (rbac === false || rbac.enabled === false) return [];
  const custom = rbac.read?.(ctx);
  if (custom) return custom;
  const keys = rbac.metadataKey === undefined ? [] : Array.isArray(rbac.metadataKey) ? rbac.metadataKey : [rbac.metadataKey];
  const out: string[] = [];
  for (const key of keys) {
    const value = ctx.getMetadata<unknown>(key);
    if (Array.isArray(value)) out.push(...value.map(String));
    else if (typeof value === 'string') out.push(value);
  }
  return Array.from(new Set(out));
}

function detectPagination(pagination: PaginationOptions | false, ctx: HandlerContext, prototype: object): boolean {
  if (pagination === false || pagination.enabled === false) return false;
  const paramTypes = meta('design:paramtypes', prototype, ctx.methodName) as Array<Function | undefined> | undefined;
  if (pagination.detect) return pagination.detect(ctx, paramTypes ?? []);
  if (!paramTypes) return false;
  const names = new Set(pagination.paramTypeNames ?? ['QueryOptions']);
  return paramTypes.some((t) => typeof t === 'function' && names.has(t.name));
}

const PRIMITIVE_NAMES = new Set(['Object', 'String', 'Number', 'Boolean', 'Array']);
// `Function`: what emitDecoratorMetadata writes for an erased (`import type`) class; the source names the type instead.
const ERASED_NAMES = new Set([...PRIMITIVE_NAMES, 'Function']);
const BODY_PARAMTYPE = '3'; // RouteParamtypes.BODY — stable across Nest versions

// Resolves the @Body() parameter's DTO class purely from runtime metadata:
// Nest stores route params under '__routeArguments__' keyed `${paramtype}:${index}`
// on the controller constructor, and TypeScript's emitDecoratorMetadata stores
// the real classes in design:paramtypes. Plain interfaces erase to Object and
// are skipped (the pipe skips validation for them too, so no 400 is
// documented). `@Body(new ParseArrayPipe({ items: X }))` keeps X on the pipe
// instance's options — also read at runtime.
function resolveBody(
  prototype: object,
  controller: Function,
  methodName: string,
): { bodyDtoClass: Function | undefined; isArrayBody: boolean; bodyPipes: unknown[] } {
  const empty = { bodyDtoClass: undefined, isArrayBody: false, bodyPipes: [] as unknown[] };
  try {
    const routeArgs = meta(ROUTE_ARGS_METADATA, controller, methodName) as
      | Record<string, { index: number; pipes?: unknown[] }>
      | undefined;
    if (!routeArgs) return empty;
    const bodyEntry = Object.entries(routeArgs).find(([key]) => key.split(':')[0] === BODY_PARAMTYPE);
    if (!bodyEntry) return empty;
    const pipes = bodyEntry[1].pipes ?? [];
    const paramTypes = meta('design:paramtypes', prototype, methodName) as unknown[] | undefined;
    const dto = paramTypes?.[bodyEntry[1].index];

    let itemsClass: Function | undefined;
    for (const pipe of pipes) {
      const items = (pipe as { options?: { items?: unknown } })?.options?.items;
      if (typeof items === 'function') {
        itemsClass = items;
        break;
      }
    }
    const direct =
      typeof dto === 'function' && !PRIMITIVE_NAMES.has((dto as Function).name) ? (dto as Function) : undefined;
    return {
      bodyDtoClass: direct ?? itemsClass,
      isArrayBody: itemsClass !== undefined,
      bodyPipes: pipes,
    };
  } catch {
    return empty;
  }
}

const QUERY_PARAMTYPE = '4';
const PARAM_PARAMTYPE = '5';
const HEADERS_PARAMTYPE = '6';
const FILE_PARAMTYPE = '8';
const FILES_PARAMTYPE = '9';

function resolveQueryAndUpload(
  prototype: object,
  controller: Function,
  methodName: string,
): {
  queryDtoClass: Function | undefined;
  pathDtoClass: Function | undefined;
  headerDtoClass: Function | undefined;
  uploadArg: 'file' | 'files' | undefined;
  uploadRules: UploadRules | undefined;
} {
  const out: {
    queryDtoClass: Function | undefined;
    pathDtoClass: Function | undefined;
    headerDtoClass: Function | undefined;
    uploadArg: 'file' | 'files' | undefined;
    uploadRules: UploadRules | undefined;
  } = { queryDtoClass: undefined, pathDtoClass: undefined, headerDtoClass: undefined, uploadArg: undefined, uploadRules: undefined };
  try {
    const routeArgs = meta(ROUTE_ARGS_METADATA, controller, methodName) as
      | Record<string, { index: number; data?: unknown; pipes?: unknown[] }>
      | undefined;
    if (!routeArgs) return out;
    const paramTypes = meta('design:paramtypes', prototype, methodName) as unknown[] | undefined;
    for (const [key, entry] of Object.entries(routeArgs)) {
      const type = key.split(':')[0];
      const whole = entry.data === undefined || entry.data === null;
      if (whole && (type === QUERY_PARAMTYPE || type === PARAM_PARAMTYPE || type === HEADERS_PARAMTYPE)) {
        const dto = paramTypes?.[entry.index];
        if (typeof dto === 'function' && !ERASED_NAMES.has((dto as Function).name) && (dto as Function).name !== 'Date') {
          if (type === QUERY_PARAMTYPE) out.queryDtoClass = dto as Function;
          else if (type === PARAM_PARAMTYPE) out.pathDtoClass = dto as Function;
          else out.headerDtoClass = dto as Function;
        }
      } else if (type === FILE_PARAMTYPE || type === FILES_PARAMTYPE) {
        out.uploadArg = type === FILES_PARAMTYPE ? 'files' : (out.uploadArg ?? 'file');
        out.uploadRules = uploadRulesOf(entry.pipes) ?? out.uploadRules;
      }
    }
  } catch {
    /* exotic metadata */
  }
  return out;
}

// -------------------------------------------------------------- matching

export interface OperationRef {
  path: string;
  method: string;
  operation: Record<string, any>;
  info: HandlerInfo | undefined;
}

/**
 * Pairs OpenAPI operations with the controller handlers that produced them.
 *
 * Matching does NOT rely on rebuilding the exact path (global prefix,
 * versioning, RouterModule paths and `@Controller(['a','b'])` all change it):
 *   1. `operationId` — `@nestjs/swagger` names operations `${Controller}_${method}`;
 *   2. exact path equality against every candidate full path;
 *   3. longest path-suffix match on `controller + method` paths.
 */
export class RouteIndex {
  private readonly byOperationId = new Map<string, HandlerInfo[]>();
  private readonly byExact = new Map<string, HandlerInfo[]>();

  constructor(private readonly handlers: HandlerInfo[]) {
    for (const h of handlers) {
      const opKey = `${h.controllerName}_${h.methodName}`;
      push(this.byOperationId, opKey, h);
      for (const p of h.fullPaths) push(this.byExact, p, h);
    }
  }

  match(method: string, docPath: string, operationId?: string): HandlerInfo | undefined {
    const accepts = (h: HandlerInfo): boolean => h.httpMethod === method || h.httpMethod === 'all';
    const normalized = normalizeRoutePath(docPath);

    if (operationId) {
      // `@All()` handlers get `_${method}` appended by swagger.
      const stripped = operationId.endsWith(`_${method}`) ? operationId.slice(0, -(method.length + 1)) : undefined;
      const candidates = [
        ...(this.byOperationId.get(operationId) ?? []),
        ...(stripped ? (this.byOperationId.get(stripped) ?? []) : []),
      ].filter(accepts);
      if (candidates.length === 1) return candidates[0];
      if (candidates.length > 1) {
        const byPath = candidates.filter((h) => h.fullPaths.includes(normalized));
        if (byPath.length >= 1) return byPath[0];
      }
    }

    const exact = (this.byExact.get(normalized) ?? []).filter(accepts);
    if (exact.length >= 1) return exact[0];

    let best: HandlerInfo | undefined;
    let bestLen = -1;
    for (const h of this.handlers) {
      if (!accepts(h)) continue;
      for (const rel of h.relativePaths) {
        if (rel.length > bestLen && (normalized === rel || normalized.endsWith(rel))) {
          best = h;
          bestLen = rel.length;
        }
      }
    }
    return best;
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
