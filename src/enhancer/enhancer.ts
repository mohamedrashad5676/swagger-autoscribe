import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { ModuleIndex, stringMetadata } from '../errors/module-index';
import { RuntimeErrorScanner } from '../errors/scanner';
import { CrossServiceScanner } from '../errors/cross-service';
import { DEFAULT_EXAMPLE_BY_NAME, type ExtractionContext } from '../errors/extraction';
import { getValidatorMetadataStorage } from '../class-validator';
import { isInNodeModules, toPosix } from '../fs-utils';
import { createLogger, type AutoDocLogger } from '../logger';
import { createExampleGenerator, type ExampleGenerator } from '../schema/example-generator';
import { SourceSchemaExtractor, type JsonSchema } from '../schema/source-schema-extractor';
import { SourceIndex, detectSourceRoots } from '../source/source-index';
import { isTypeScriptAvailable } from '../ts';
import type { DescriptionEngine } from '../descriptions/engine';
import { disabledFor, resolveOptions } from '../options';
import type { AutoDocOptions, OperationContext, OperationFeature, ResourceOptions } from '../types';
import { discoverOwnedPackages, type OwnedPackage } from '../source/owned-packages';
import { ProviderLookup, type ContainerLike } from './di';
import { ErrorDocumenter } from './error-docs';
import { EnhancerResolver } from './resolver';
import { collectAsyncEndpoints } from './async-endpoints';
import { generateSummary } from './summary';
import { describeWindow, isThrottlerGuard, rateLimitsFor } from './throttle';
import { behaviorLines, cacheFor } from './behavior';
import { listingExtension, listingLines, listingOf } from './listing';
import { RouteIndex, scanHandlers, type HandlerInfo, type OperationRef } from './handlers';
import { DEFAULT_ENVELOPE, HTTP_METHODS, ensureComponents, ref, registerSchema } from './schema-utils';

const DEFAULT_PAGINATION_PARAMS = [
  {
    name: 'page',
    in: 'query',
    required: false,
    schema: { type: 'integer', default: 1, minimum: 1 },
    description: 'Page number (1-based)',
    example: 1,
  },
  {
    name: 'limit',
    in: 'query',
    required: false,
    schema: { type: 'integer', default: 10, minimum: 1, maximum: 100 },
    description: 'Items per page',
    example: 20,
  },
  {
    name: 'sort',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'Sort: field:ASC,field:DESC',
    example: 'createdAt:DESC',
  },
  {
    name: 'search',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'Search term',
    example: 'Ahmed',
  },
  {
    name: 'searchFields',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'Comma-separated search fields',
    example: 'name,email',
  },
  {
    name: 'filter',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'JSON filter object',
    example: '{"status":{"eq":"active"}}',
  },
];

const DEFAULT_SCHEME = { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' };
const BODY_METHODS = new Set(['post', 'put', 'patch', 'delete']);

interface AstContext {
  index: SourceIndex;
  extractor: SourceSchemaExtractor;
}

/**
 * Post-processes a generated OpenAPI document so it reflects what the app
 * REALLY does: auth, RBAC, pagination, request/response shapes read from the
 * TypeScript source, realistic examples, and the errors each route can throw.
 *
 * Works on any NestJS app: every project-specific convention (public-route
 * decorator, permission metadata, response envelope, pagination type, source
 * layout) is an option with a sensible default — nothing is imported from
 * your code.
 */
export class SwaggerEnhancer {
  private readonly logger: AutoDocLogger;
  private readonly cwd: string;
  private readonly moduleIndex = new ModuleIndex();
  private readonly warnedNames = new Set<string>();
  private readonly declaredDtoNames = new Map<string, string>();
  private container!: ContainerLike;
  private lookup!: ProviderLookup;
  private exampleGen: ExampleGenerator | undefined;
  private ast: AstContext | undefined;
  private handlers: HandlerInfo[] = [];
  private dtoClasses = new Map<string, Function>();
  private visitedDtos = new Set<string>();
  private resolver!: EnhancerResolver;
  private descriptionEngine: DescriptionEngine | undefined;
  /** Endpoints whose documented response still contains untyped (`any`) parts. */
  readonly untypedResponses: string[] = [];
  private resources: ResourceOptions[] = [];

  private readonly options: AutoDocOptions;
  private opRules = new Map<OperationRef, Set<string>>();
  /** Installed packages that hold the user's own DTO types (auto-discovered), indexed like local sources. */
  private ownedPkgs: OwnedPackage[] = [];

  constructor(
    private readonly app: INestApplication,
    input: AutoDocOptions = {},
  ) {
    const options = resolveOptions(input);
    this.options = options;
    const base = createLogger('SwaggerAutoDoc', options.logger);
    this.logger = options.warnings === false ? { ...base, warn: (m) => base.debug(m) } : base;
    this.cwd = options.sources?.cwd ?? process.cwd();
  }

  /** `true` / `undefined` -> `{}`, an object -> itself (feature options that may also be a plain boolean). */
  private cfg<T extends object>(v: T | boolean | undefined | false): Partial<T> {
    return v && typeof v === 'object' ? v : {};
  }

  private operationContext(ref: OperationRef): OperationContext {
    return {
      path: ref.path,
      method: ref.method,
      operationId: ref.operation.operationId,
      controllerName: ref.info?.controllerName,
      methodName: ref.info?.methodName,
      tags: Array.isArray(ref.operation.tags) ? ref.operation.tags : [],
      operation: ref.operation,
    };
  }

  /** The operations a feature may touch, after the per-operation `operations` rules. */
  private opsFor(feature: OperationFeature, ops: OperationRef[]): OperationRef[] {
    const rules = this.options.operations;
    if (!rules) return ops;
    return ops.filter((ref) => {
      let off = this.opRules.get(ref);
      if (!off) {
        try {
          off = disabledFor(rules, this.operationContext(ref));
        } catch (e) {
          this.logger.warn(`operations rule failed for ${ref.method.toUpperCase()} ${ref.path}: ${(e as Error).message}`);
          off = new Set();
        }
        this.opRules.set(ref, off);
      }
      return !off.has(feature);
    });
  }

  private runOperationHooks(ops: OperationRef[]): void {
    const hook = this.options.hooks?.operation;
    if (!hook) return;
    for (const ref of ops) {
      try {
        hook(this.operationContext(ref));
      } catch (e) {
        this.logger.warn(`hooks.operation failed for ${ref.method.toUpperCase()} ${ref.path}: ${(e as Error).message}`);
      }
    }
  }

  process(document: OpenAPIObject): OpenAPIObject {
    this.logger.log('Post-processing OpenAPI document...');
    try {
      this.options.hooks?.beforeEnhance?.(document, this.app);
    } catch (e) {
      this.logger.warn(`hooks.beforeEnhance failed: ${(e as Error).message}`);
    }
    const { schemas } = ensureComponents(document);
    void schemas;

    this.container = this.resolveContainer();
    this.lookup = new ProviderLookup(this.container);
    this.resolver = new EnhancerResolver(this.app, this.lookup);
    const o = this.options;
    this.resources = o.resource ? (Array.isArray(o.resource) ? o.resource : [o.resource]) : [];

    this.handlers = scanHandlers({
      app: this.app,
      container: this.container,
      lookup: this.lookup,
      auth: o.auth ?? {},
      rbac: o.rbac ?? false,
      pagination: o.pagination ?? {},
      resource: this.resources,
    });
    this.logger.log(`Found ${this.handlers.length} HTTP handlers`);

    const routes = new RouteIndex(this.handlers);
    let ops = this.collectOperations(document, routes);
    // First, so no later pass can see or re-add an excluded operation.
    ops = this.applyExclusions(document, ops);
    const unmatched = ops.filter((x) => !x.info).length;
    if (unmatched > 0) {
      this.logger.warn(`${unmatched} operation(s) could not be matched to a controller handler (customised operationId/path?)`);
    }

    this.ownedPkgs = this.findOwnedPackages();
    this.exampleGen = o.examples === false ? undefined : createExampleGenerator(o.examples ?? {});

    if (o.auth !== false) this.applyAuth(document, this.opsFor('auth', ops));
    if (o.rbac) this.applyRBAC(this.opsFor('rbac', ops));
    if (o.pagination !== false) this.applyPagination(this.opsFor('pagination', ops));

    const needsAst = o.dtos !== false || o.requestBodies !== false || o.responses !== false;
    this.ast = needsAst ? this.prepareAst(document, ops) : undefined;

    if (this.ast && o.dtos !== false) this.splitCollidingBodyDtos(document, ops);
    if (o.dtos !== false) this.enrichDTOSchemas(document);
    if (o.requestBodies !== false) this.applyRequestBodies(document, this.opsFor('requestBodies', ops));
    if (o.responses !== false) this.applyResponses(document, this.opsFor('responses', ops));
    if (o.asyncEndpoints !== false) this.applyAsyncEndpoints(document);
    if (o.queryParams !== false) this.applyQueryDtos(document, this.opsFor('queryParams', ops));
    if (o.uploads !== false) this.applyUploads(document, this.opsFor('uploads', ops));
    if (this.exampleGen) {
      if (this.cfg(o.examples).requests !== false) this.applyRequestExamples(document, this.opsFor('examples', ops));
      this.applyParameterExamples(document, this.opsFor('examples', ops));
    }
    this.restoreMinifiedSchemaNames(document);
    this.restoreMinifiedControllerNames(ops);
    if (o.errors !== false) this.applyErrors(document, this.opsFor('errors', ops));
    if (o.rateLimit !== false) this.applyRateLimits(this.opsFor('rateLimit', ops));
    if (o.summaries !== false) this.applySummaries(this.opsFor('summaries', ops));
    if (o.descriptions !== false) this.applyDescriptions(document, this.opsFor('descriptions', ops));
    if (o.behavior !== false) this.applyBehavior(document, this.opsFor('behavior', ops));
    if (o.listing !== false) this.applyListing(document, this.opsFor('listing', ops));
    this.dropUnusedPlaceholders(document);
    this.runOperationHooks(ops);

    const limit = this.moduleIndex.searchLimitNote();
    if (limit) {
      this.logger.warn(
        `Locating the compiled files of your classes ${limit}; some error / schema information may be missing. Run from your project root (or the app's folder) so only your own code is searched.`,
      );
    }
    this.logger.log('Post-processing complete');
    try {
      const replaced = this.options.hooks?.afterEnhance?.(document, this.app);
      if (replaced && typeof replaced === 'object') return replaced as OpenAPIObject;
    } catch (e) {
      this.logger.warn(`hooks.afterEnhance failed: ${(e as Error).message}`);
    }
    return document;
  }

  // ------------------------------------------------------- exclusion & docs

  private engine(): DescriptionEngine | undefined {
    if (this.descriptionEngine) return this.descriptionEngine;
    if (!isTypeScriptAvailable()) return undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { DescriptionEngine: Engine } = require('../descriptions/engine') as typeof import('../descriptions/engine');
      const src = this.options.sources ?? {};
      const roots = src.roots ?? detectSourceRoots(this.cwd);
      this.descriptionEngine = new Engine(this.cwd, roots, this.options.descriptions || {}, this.logger);
    } catch (e) {
      this.logger.warn(`Descriptions/exclusions unavailable: ${(e as Error).message}`);
    }
    return this.descriptionEngine;
  }

  private exclusionConfig(): { excludeControllers: string[]; excludeEndpoints: string[] } {
    const csv = (v: string | undefined): string[] => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const ex = this.options.exclude ?? {};
    return {
      excludeControllers: [...(ex.controllers ?? []), ...csv(process.env.SWAGGER_EXCLUDE_CONTROLLERS)],
      excludeEndpoints: [...(ex.endpoints ?? []), ...csv(process.env.SWAGGER_EXCLUDE_ENDPOINTS)],
    };
  }

  // Precedence: `@swagger-ignore` comment > config > manual docs > generation. Excluded operations are
  // deleted from the document and dropped from the list before any pass runs.
  private applyExclusions(document: OpenAPIObject, ops: OperationRef[]): OperationRef[] {
    const config = this.exclusionConfig();
    const hasConfig = config.excludeControllers.length > 0 || config.excludeEndpoints.length > 0;
    const engine = this.engine();
    engine?.build(this.options.descriptions !== false);
    if (!engine && !hasConfig) return ops;

    const kept: OperationRef[] = [];
    const excluded = new Set<HandlerInfo>();
    for (const ref of ops) {
      const info = ref.info;
      if (!info) {
        kept.push(ref);
        continue;
      }
      const method = info.httpMethod === 'all' ? ref.method : info.httpMethod;
      const candidates = Array.from(new Set([...info.relativePaths, ...info.fullPaths]));
      let reason: string | undefined;
      for (const fullPath of candidates.length > 0 ? candidates : ['/']) {
        const target = { controllerClassName: info.controllerName, methodName: info.methodName, method, fullPath };
        reason = engine
          ? engine.excludedBecause(target, config)
          : config.excludeControllers.includes(info.controllerName)
            ? 'config:controller'
            : undefined;
        if (reason) break;
      }
      if (!reason) {
        kept.push(ref);
        continue;
      }
      excluded.add(info);
      this.logger.log(`Excluding ${info.controllerName}.${info.methodName} (${ref.method.toUpperCase()} ${ref.path}): ${reason}`);
      const item = (document.paths as Record<string, any>)[ref.path];
      if (item) {
        delete item[ref.method];
        if (!HTTP_METHODS.some((m) => item[m])) delete (document.paths as Record<string, any>)[ref.path];
      }
    }
    // handlers of excluded controllers must not drive later passes either
    this.handlers = this.handlers.filter((h) => !excluded.has(h));
    return kept;
  }

  // Fills ONLY operations without a description: an explicit `@ApiOperation({ description })` always wins.
  private applyDescriptions(document: OpenAPIObject, ops: OperationRef[]): void {
    const engine = this.engine();
    if (!engine) return;
    engine.build(true);
    const dopts = this.cfg(this.options.descriptions);
    const mark = dopts.markGenerated === true;
    let generated = 0;
    for (const { operation, method, path, info } of ops) {
      if (!info) continue;
      if (dopts.overwrite !== true && typeof operation.description === 'string' && operation.description.trim().length > 0) continue;
      let text: string | undefined;
      try {
        text = engine.describe(document, operation, {
          controllerClassName: info.controllerName,
          methodName: info.methodName,
          httpMethod: info.httpMethod === 'all' ? method : info.httpMethod,
          hasPagination: info.hasPagination,
          resourceName: info.resourceClass?.name,
          isPublic: info.isPublic,
          requiredPermissions: info.requiredPermissions,
          operationKey: `${method.toUpperCase()} ${path}`,
        });
      } catch (e) {
        this.logger.warn(`Description failed for ${info.controllerName}.${info.methodName}: ${(e as Error).message}`);
      }
      try {
        const hctx = { path, method, controllerName: info.controllerName, methodName: info.methodName, operation, generated: text };
        const custom = dopts.generate?.(hctx);
        if (typeof custom === 'string') text = custom;
        if (text && dopts.transform) text = dopts.transform(text, hctx);
      } catch (e) {
        this.logger.warn(`Description hook failed for ${info.controllerName}.${info.methodName}: ${(e as Error).message}`);
      }
      if (!text) continue;
      operation.description = text;
      if (mark) operation['x-generated-description'] = true;
      generated++;
    }
    this.logger.log(`Generated ${generated} operation descriptions`);
  }

  // ------------------------------------------------- query / uploads / extras

  // `@Query() dto: ListDto`: @nestjs/swagger only expands it when the DTO has
  // @ApiProperty (or the CLI plugin). Otherwise the filters are invisible.
  private applyQueryDtos(document: OpenAPIObject, ops: OperationRef[]): void {
    if (!this.ast) return;
    const schemas = ensureComponents(document).schemas as Record<string, any>;
    let expanded = 0;
    const qp = this.cfg(this.options.queryParams);
    for (const { operation, info, path } of ops) {
      if (!info) continue;
      const cf = this.classFile(this.ast.index, info.controller);
      // Runtime metadata names the DTO class; when the import was `import type` it is erased, so the source decides.
      const named = (cls: Function | undefined, decorator: string): string | undefined => {
        if (cls) return cls.name;
        if (!cf || !this.ast!.extractor.hasFile(cf)) return undefined;
        try {
          return this.ast!.extractor.extractParamTypeName(cf, info.controllerName, info.methodName, decorator);
        } catch {
          return undefined;
        }
      };
      const targets: Array<{ name: string | undefined; where: 'query' | 'path' | 'header' }> = [
        { name: qp.query === false ? undefined : named(info.queryDtoClass, 'Query'), where: 'query' },
        { name: qp.path === false ? undefined : named(info.pathDtoClass, 'Param'), where: 'path' },
        { name: qp.header === false ? undefined : named(info.headerDtoClass, 'Headers'), where: 'header' },
      ];
      for (const { name: dtoName, where } of targets) {
        if (!dtoName) continue;
        const file = this.dtoFile(this.ast.index, dtoName);
        if (!file || !this.ast.extractor.hasFile(file)) continue;
        const existedBefore = dtoName in schemas;
        const wasVisited = this.visitedDtos.has(dtoName);
        let schema: any;
        try {
          this.resolveDtoSchema(document, this.visitedDtos, dtoName, file);
          schema = schemas[dtoName];
        } catch (e) {
          this.logger.warn(`Failed to expand ${where} DTO ${dtoName}: ${(e as Error).message}`);
          continue;
        }
        const props = schema?.properties as Record<string, any> | undefined;
        if (props && Object.keys(props).length > 0) {
          const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
          if (!Array.isArray(operation.parameters)) operation.parameters = [];
          const have = new Set((operation.parameters as any[]).filter((p) => p.in === where).map((p) => String(p.name).toLowerCase()));
          let added = 0;
          for (const [name, propSchema] of Object.entries(props)) {
            if (have.has(name.toLowerCase())) continue;
            // Path params exist only for names in the route template.
            if (where === 'path' && !new RegExp(`[:{]${name}\\b`).test(path)) continue;
            const { description, ...rest } = propSchema as Record<string, any>;
            const isObject = qp.deepObject !== false && where === 'query' && (rest.type === 'object' || rest.$ref !== undefined);
            operation.parameters.push({
              name,
              in: where,
              required: where === 'path' ? true : required.has(name),
              schema: rest,
              ...(description ? { description } : {}),
              ...(isObject ? { style: 'deepObject', explode: true } : {}),
            });
            added++;
          }
          if (added > 0) expanded++;
        }
        // These DTOs are parameter-only shapes: don't leave a component behind.
        if (!existedBefore) {
          delete schemas[dtoName];
          if (!wasVisited) this.visitedDtos.delete(dtoName);
        }
      }
    }
    if (expanded > 0) this.logger.log(`Expanded @Query()/@Param()/@Headers() DTOs into parameters for ${expanded} operations`);
  }

  private applyAsyncEndpoints(document: OpenAPIObject): void {
    let found: ReturnType<typeof collectAsyncEndpoints>;
    try {
      found = collectAsyncEndpoints(this.container);
    } catch (e) {
      this.logger.debug(`Async endpoint discovery failed: ${(e as Error).message}`);
      return;
    }
    if (!found) return;
    const ac = this.cfg(this.options.asyncEndpoints);
    const wsKey = typeof ac.websocket === 'string' ? ac.websocket : 'x-websocket';
    const msKey = typeof ac.microservices === 'string' ? ac.microservices : 'x-microservices';
    const schemas = ensureComponents(document).schemas as Record<string, any>;
    const payload = (cls: Function | undefined): Record<string, unknown> | undefined => {
      if (!cls) return undefined;
      if (this.ast) {
        const file = this.dtoFile(this.ast.index, cls.name);
        if (file && this.ast.extractor.hasFile(file)) {
          try {
            this.resolveDtoSchema(document, this.visitedDtos, cls.name, file);
          } catch {
            /* fall through to the name */
          }
        }
      }
      return cls.name in schemas ? { payload: { $ref: `#/components/schemas/${cls.name}` } } : { payloadType: cls.name };
    };
    if (found.gateways.length && ac.websocket !== false) {
      (document as any)[wsKey] = found.gateways.map((g) => ({
        gateway: g.gateway,
        ...g.options,
        events: g.events.map((e) => ({ event: e.event, handler: e.handler, ...payload(e.payloadClass) })),
      }));
    }
    if (found.patterns.length && ac.microservices !== false) {
      (document as any)[msKey] = found.patterns.map((p) => ({
        handler: p.handler,
        transport: p.transport,
        kind: p.kind,
        ...(p.grpc ? { grpc: p.grpc } : { pattern: p.pattern }),
        ...payload(p.payloadClass),
      }));
    }
    this.logger.log(`Listed ${found.gateways.reduce((n, g) => n + g.events.length, 0)} WebSocket events and ${found.patterns.length} microservice handlers`);
  }

  private applyUploads(document: OpenAPIObject, ops: OperationRef[]): void {
    let documented = 0;
    const uc = this.cfg(this.options.uploads);
    for (const { operation, info } of ops) {
      if (!info) continue;
      let spec: ReturnType<SourceSchemaExtractor['extractUploadSpec']>;
      const controllerFile = this.ast ? this.classFile(this.ast.index, info.controller) : undefined;
      if (this.ast && controllerFile && this.ast.extractor.hasFile(controllerFile)) {
        try {
          spec = this.ast.extractor.extractUploadSpec(controllerFile, info.controllerName, info.methodName);
        } catch {
          spec = undefined;
        }
      }
      if (!spec && info.uploadArg) {
        spec = { fields: [{ name: info.uploadArg, multiple: info.uploadArg === 'files' }], any: false };
      }
      if (!spec) continue;
      const content = (operation.requestBody?.content ?? {}) as Record<string, any>;
      if (content['multipart/form-data']) continue; // explicit @ApiConsumes / @ApiBody wins

      const properties: Record<string, any> = {};
      const required: string[] = [];
      const binary = { type: 'string', format: 'binary' };
      for (const f of spec.fields) {
        properties[f.name] = f.multiple
          ? { type: 'array', items: { ...binary }, ...(f.maxCount ? { maxItems: f.maxCount } : {}) }
          : { ...binary };
        if (!f.multiple) required.push(f.name);
      }
      if (spec.any && spec.fields.length === 0) {
        properties.files = { type: 'array', items: { ...binary } };
      }
      // Text fields that ride along the files (the @Body() DTO).
      const json = content['application/json']?.schema as any;
      const bodySchema = json?.$ref ? (document.components?.schemas?.[String(json.$ref).split('/').pop() as string] as any) : json;
      if (bodySchema?.properties) {
        for (const [k, v] of Object.entries(bodySchema.properties)) if (!(k in properties)) properties[k] = v;
        for (const r of (bodySchema.required ?? []) as string[]) if (!required.includes(r)) required.push(r);
      }
      const encoding: Record<string, { contentType: string }> = {};
      const rules = uc.rules === false ? undefined : info.uploadRules;
      if (rules) {
        const notes: string[] = [];
        if (rules.maxSize !== undefined) notes.push(`Max size: ${humanBytes(rules.maxSize)}.`);
        if (rules.fileType) notes.push(`Allowed type: ${rules.fileType}.`);
        const plainMime = rules.fileType && /^[\w.+-]+\/[\w.+*-]+$/.test(rules.fileType) ? rules.fileType : undefined;
        for (const f of spec.fields.length ? spec.fields : [{ name: 'files' }]) {
          const target = properties[f.name]?.type === 'array' ? properties[f.name].items : properties[f.name];
          if (!target) continue;
          if (notes.length) target.description = notes.join(' ');
          if (rules.maxSize !== undefined) target['x-max-size'] = rules.maxSize;
          if (plainMime && uc.encoding !== false) encoding[f.name] = { contentType: plainMime };
          if (rules.required === false) {
            const at = required.indexOf(f.name);
            if (at >= 0) required.splice(at, 1);
          }
        }
      }
      operation.requestBody = {
        ...(operation.requestBody ?? {}),
        required: rules?.required === false && required.length === 0 ? false : true,
        content: {
          'multipart/form-data': {
            schema: { type: 'object', properties, ...(required.length ? { required } : {}) },
            ...(Object.keys(encoding).length ? { encoding } : {}),
          },
        },
      };
      documented++;
    }
    if (documented > 0) this.logger.log(`Documented multipart uploads for ${documented} operations`);
  }

  private applyRateLimits(ops: OperationRef[]): void {
    let n = 0;
    const rc = this.cfg(this.options.rateLimit);
    for (const { operation, info } of ops) {
      if (!info) continue;
      let limits: ReturnType<typeof rateLimitsFor>;
      try {
        limits = rateLimitsFor(info, this.resolver.applied('guards', info));
      } catch {
        continue;
      }
      if (limits.length === 0) continue;
      const first = limits[0];
      if (rc.extension !== false) operation[typeof rc.extension === 'string' ? rc.extension : 'x-rate-limit'] = limits.map((l) => ({ name: l.name, limit: l.limit, windowMs: l.ttlMs, ...(l.blockMs ? { blockMs: l.blockMs } : {}) }));
      if (rc.response === false) {
        n++;
        continue;
      }
      operation.responses ??= {};
      const text = limits.map((l) => `${l.limit} request${l.limit === 1 ? '' : 's'} per ${describeWindow(l.ttlMs)}`).join(', ');
      const existing = operation.responses['429'];
      const headers = rc.header === false ? undefined : { 'Retry-After': { description: 'Seconds until the limit resets.', schema: { type: 'integer' } } };
      if (existing) {
        if (headers) existing.headers = { ...headers, ...(existing.headers ?? {}) };
      } else {
        operation.responses['429'] = {
          description: `Too Many Requests — rate limit exceeded (${text}).`,
          ...(headers ? { headers } : {}),
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { statusCode: { type: 'integer', example: 429 }, message: { type: 'string', example: 'ThrottlerException: Too Many Requests' } },
              },
            },
          },
        };
      }
      void first;
      n++;
    }
    if (n > 0) this.logger.log(`Documented rate limits for ${n} operations`);
  }

  /**
   * Operations whose description may receive extra notes: the descriptions feature is on for them, it is not
   * limited to one-line summaries, and the user did not take over the text with `generate` / `transform`.
   */
  private noteTargets(ops: OperationRef[]): Set<OperationRef> {
    const d = this.options.descriptions;
    if (d === false) return new Set();
    const c = this.cfg(d) as { detail?: string; generate?: unknown; transform?: unknown };
    if (c.detail === 'summary' || typeof c.generate === 'function' || typeof c.transform === 'function') return new Set();
    return new Set(this.opsFor('descriptions', ops));
  }

  /** Adds a titled bullet list; inside the "Contract details" fold when the description ends with one. */
  private appendNote(operation: any, title: string, lines: string[]): void {
    if (lines.length === 0) return;
    const current = typeof operation.description === 'string' ? operation.description.trimEnd() : '';
    if (current.includes(`**${title}**\n- `)) return;
    const block = `**${title}**\n${lines.map((l) => `- ${l}`).join('\n')}`;
    const close = '</details>';
    operation.description = current.endsWith(close)
      ? `${current.slice(0, -close.length).trimEnd()}\n\n${block}\n\n${close}`
      : current
        ? `${current}\n\n${block}`
        : block;
  }

  private applyBehavior(document: OpenAPIObject, ops: OperationRef[]): void {
    void document;
    const bc = this.cfg(this.options.behavior);
    const writable = this.noteTargets(ops);
    let n = 0;
    for (const ref of ops) {
      const { operation, info } = ref;
      if (!info) continue;
      try {
        const guards = this.resolver.applied('guards', info);
        const facts = {
          permissions: info.requiredPermissions.map(String),
          rateLimits: this.options.rateLimit === false ? [] : rateLimitsFor(info, guards),
          cache: bc.cache === false ? undefined : cacheFor(info, this.resolver.applied('interceptors', info), bc.cacheTtlUnit),
          guards: guards.filter((g) => !isThrottlerGuard(g)).map((g) => g.constructor?.name ?? '').filter(Boolean),
        };
        let lines = behaviorLines(facts, { guards: bc.guards === true });
        // The contract section already says which permission the caller needs.
        if (/permission/i.test(String(operation.description ?? ''))) lines = lines.filter((l) => !l.startsWith('**Permissions.**'));
        if (lines.length === 0 && !(bc.guards === true && facts.guards.length > 0)) continue;
        if (bc.extension !== false) {
          operation[typeof bc.extension === 'string' ? bc.extension : 'x-behavior'] = {
            ...(facts.permissions.length ? { permissions: facts.permissions } : {}),
            ...(facts.rateLimits.length ? { rateLimit: facts.rateLimits.map((l) => ({ name: l.name, limit: l.limit, windowMs: l.ttlMs })) } : {}),
            ...(facts.cache ? { cache: { ...(facts.cache.ttlMs ? { ttlMs: facts.cache.ttlMs } : {}), ...(facts.cache.key ? { key: facts.cache.key } : {}) } } : {}),
            ...(bc.guards === true && facts.guards.length ? { guards: facts.guards } : {}),
          };
        }
        if (bc.description !== false && writable.has(ref)) this.appendNote(operation, 'Behavior', lines);
        n++;
      } catch {
        /* never break the document for a note */
      }
    }
    if (n > 0) this.logger.log(`Documented behavior (permissions / rate limit / cache) for ${n} operations`);
  }

  private applyListing(document: OpenAPIObject, ops: OperationRef[]): void {
    const lc = this.cfg(this.options.listing);
    const writable = this.noteTargets(ops);
    let n = 0;
    for (const ref of ops) {
      const { operation } = ref;
      try {
        const facts = listingOf(document as any, operation);
        if (!facts) continue;
        if (lc.extension !== false) operation[typeof lc.extension === 'string' ? lc.extension : 'x-pagination'] = listingExtension(facts);
        if (lc.description !== false && writable.has(ref)) this.appendNote(operation, 'Listing', listingLines(facts));
        n++;
      } catch {
        /* never break the document for a note */
      }
    }
    if (n > 0) this.logger.log(`Documented pagination / sorting for ${n} list operations`);
  }

  private applySummaries(ops: OperationRef[]): void {
    const sc = this.cfg(this.options.summaries);
    const custom = sc.generate;
    for (const { operation, info, path, method } of ops) {
      if (!info) continue;
      if (sc.overwrite !== true && typeof operation.summary === 'string' && operation.summary.trim()) continue;
      const input = {
        controllerName: info.controllerName,
        methodName: info.methodName,
        httpMethod: info.httpMethod === 'all' ? method : info.httpMethod,
        path,
        resourceName: info.resourceClass?.name,
      };
      let text: string | undefined;
      try {
        text = custom ? (custom(input) ?? generateSummary(input)) : generateSummary(input);
      } catch {
        text = undefined;
      }
      if (text) operation.summary = text;
    }
  }

  // ----------------------------------------------------------------- setup

  private resolveContainer(): ContainerLike {
    const app = this.app as unknown as {
      container?: { getModules?: () => ContainerLike };
      get?: (token: unknown, opts?: unknown) => unknown;
    };
    const fromApp = app.container?.getModules?.();
    if (fromApp) return fromApp;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ModulesContainer } = require('@nestjs/core/injector/modules-container') as { ModulesContainer: unknown };
    return this.app.get(ModulesContainer as never, { strict: false }) as unknown as ContainerLike;
  }

  private collectOperations(document: OpenAPIObject, routes: RouteIndex): OperationRef[] {
    const out: OperationRef[] = [];
    for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
      if (typeof pathItem !== 'object' || pathItem === null) continue;
      for (const method of HTTP_METHODS) {
        const operation = (pathItem as Record<string, any>)[method];
        if (!operation) continue;
        out.push({ path, method, operation, info: routes.match(method, path, operation.operationId) });
      }
    }
    return out;
  }

  // Builds the (single, shared) TypeScript Program: controller files, response
  // transformer files and the source file of every DTO swagger could not
  // describe. Everything else is reached through imports by the type checker.
  private prepareAst(document: OpenAPIObject, ops: OperationRef[]): AstContext | undefined {
    if (!isTypeScriptAvailable()) {
      this.logger.warn(
        "'typescript' is not installed — request/response schemas cannot be read from source (auth, pagination, examples and error discovery still work).",
      );
      return undefined;
    }
    const src = this.options.sources ?? {};
    const roots = [...(src.roots ?? detectSourceRoots(this.cwd)), ...(src.extraRoots ?? []), ...this.ownedPkgs.flatMap((p) => p.typeRoots)];
    const index = new SourceIndex({ roots, exclude: src.exclude, logger: this.logger });
    index.build();
    if (index.fileCount === 0) {
      this.logger.warn(
        `No TypeScript sources found under ${roots.join(', ')} — type-derived schemas are skipped. Set sources.roots if your sources live elsewhere.`,
      );
      return undefined;
    }

    const owned = this.ownedPackagePrefixes(src.extraRoots ?? [], src.includePackages ?? []);
    const extractor = new SourceSchemaExtractor({
      cwd: this.cwd,
      tsconfigPath: src.tsconfigPath,
      typeMap: src.typeMap,
      logger: this.logger,
      isForeign: (file) => {
        const p = toPosix(file);
        if (/\/typescript\/lib\/lib\.[^/]*\.d\.ts$/.test(p)) return true;
        if (!isInNodeModules(file)) return false;
        return !owned.some((prefix) => p.includes(prefix));
      },
    });

    // Bundled apps (esbuild/webpack) rename classes; from here on only source lookups use the name.
    for (const h of this.handlers) {
      const d = index.resolveDecl(h.controllerName, this.moduleIndex.fileOf(h.controller), ['class'], runtimeMembers(h.controller), stringMetadata(h.controller));
      const declared = d?.name ?? index.canonicalName(h.controllerName);
      if (declared !== h.controllerName) h.runtimeControllerName = h.controllerName;
      h.controllerName = declared;
    }

    const files = new Set<string>();
    for (const h of this.handlers) {
      const f = this.classFile(index, h.controller);
      if (f) files.add(f);
      else this.logger.debug(`Source of controller ${h.controllerName} not found`);
      if (h.resourceClass) {
        const rf = this.classFile(index, h.resourceClass);
        if (rf) files.add(rf);
      }
      if (this.options.responses !== false && this.options.responses?.interceptors !== false) {
        for (const i of this.resolver.applied('interceptors', h)) {
          const ctor = (i as { constructor?: Function }).constructor;
          const f = ctor && ctor !== Object ? this.classFile(index, ctor) : undefined;
          if (f) files.add(f);
        }
      }
    }
    for (const h of this.handlers) {
      if (this.options.queryParams === false) continue;
      for (const cls of [h.queryDtoClass, h.pathDtoClass, h.headerDtoClass]) {
        if (!cls) continue;
        const f = this.classFile(index, cls) ?? this.dtoFile(index, cls.name);
        if (f) files.add(f);
      }
    }
    if (this.options.asyncEndpoints !== false) {
      try {
        const found = collectAsyncEndpoints(this.container);
        const classes = [...(found?.gateways.flatMap((g) => g.events.map((e) => e.payloadClass)) ?? []), ...(found?.patterns.map((p) => p.payloadClass) ?? [])];
        for (const cls of classes) {
          if (!cls) continue;
          const f = this.classFile(index, cls) ?? this.dtoFile(index, cls.name);
          if (f) files.add(f);
        }
      } catch {
        /* optional */
      }
    }
    // DTOs swagger could not describe (no @ApiProperty / CLI plugin).
    for (const [name, schema] of Object.entries(document.components?.schemas ?? {})) {
      const s = schema as JsonSchema;
      if (s.type === 'object' && !(s.properties && Object.keys(s.properties).length > 0)) {
        const f = this.dtoFile(index, name);
        if (f) files.add(f);
      }
    }
    void ops;
    if (files.size === 0) return undefined;
    extractor.initialize(Array.from(files));
    return { index, extractor };
  }

  // The user's own DTO libraries living in node_modules (a shared package installed from a tarball / file: / link:,
  // or any package that defines the classes the API really uses as DTOs) are read like local sources.
  private findOwnedPackages(): OwnedPackage[] {
    const src = this.options.sources ?? {};
    if (src.autoPackages === false) return [];
    try {
      this.dtoClass('');
      const classes = new Set<Function>(this.dtoClasses.values());
      for (const h of this.handlers) {
        for (const c of [h.bodyDtoClass, h.queryDtoClass, h.pathDtoClass, h.headerDtoClass, h.resourceClass]) if (c) classes.add(c);
      }
      const files = new Set<string>();
      for (const c of classes) {
        if (typeof c !== 'function' || c === Object) continue;
        const f = this.moduleIndex.fileOf(c);
        if (f) files.add(f);
      }
      const pkgs = discoverOwnedPackages(this.cwd, files, src.includePackages ?? [], src.excludePackages ?? []);
      if (pkgs.length > 0) this.logger.log(`Reading types of your packages: ${pkgs.map((p) => p.name).join(', ')}`);
      return pkgs;
    } catch (e) {
      this.logger.debug(`Package discovery failed: ${(e as Error).message}`);
      return [];
    }
  }

  private ownedPackagePrefixes(extraRoots: string[], includePackages: string[]): string[] {
    const prefixes = new Set<string>();
    for (const pkg of this.ownedPkgs) prefixes.add(`/node_modules/${pkg.name}/`);
    for (const pkg of includePackages) prefixes.add(`/node_modules/${pkg}/`);
    for (const root of extraRoots) {
      const m = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/|$)/.exec(toPosix(root));
      if (m) prefixes.add(`${m[1]}/`);
    }
    for (const pkg of this.options.errors === false ? [] : (this.options.errors?.includePackages ?? [])) {
      prefixes.add(`/node_modules/${pkg}/`);
    }
    return Array.from(prefixes);
  }

  private classFile(index: SourceIndex, cls: Function): string | undefined {
    return index.resolve(cls.name, this.moduleIndex.fileOf(cls), ['class'], runtimeMembers(cls), stringMetadata(cls));
  }

  /** Source file for a DTO name, telling same-named declarations apart by the runtime class's members. */
  private dtoFile(index: SourceIndex, name: string): string | undefined {
    const cls = this.dtoClass(name);
    const direct = index.resolve(name, this.hintFor(name), undefined, cls ? runtimeMembers(cls) : undefined, cls ? stringMetadata(cls) : undefined);
    if (direct || !cls) return direct;
    // Name lost to a minifier: recognise the class by its exact property set.
    const decl = index.resolveDtoByShape(declaredProps(cls));
    if (decl) this.declaredDtoNames.set(name, decl.name);
    return decl?.file;
  }

  private hintFor(className: string): string | undefined {
    const cls = this.dtoClass(className);
    return cls ? this.moduleIndex.fileOf(cls) : undefined;
  }

  // ------------------------------------------------------------- auth etc.

  private applyAuth(document: OpenAPIObject, ops: OperationRef[]): void {
    const auth = this.options.auth || {};
    const name = auth.scheme?.name ?? 'bearerAuth';
    const components = document.components as Record<string, any>;
    components.securitySchemes ??= {};
    if (auth.registerScheme !== false && !components.securitySchemes[name]) {
      components.securitySchemes[name] = auth.scheme?.definition ?? { ...DEFAULT_SCHEME };
    }
    const respect = auth.respectExplicitSecurity !== false;
    for (const { operation, info } of ops) {
      if (info?.isPublic) {
        if (auth.markPublic !== false) operation.security = [];
        continue;
      }
      if (auth.markProtected === false) continue;
      if (respect && Array.isArray(operation.security) && operation.security.length > 0) continue;
      operation.security = [{ [name]: [] }];
    }
  }

  private applyRBAC(ops: OperationRef[]): void {
    const rbac = this.options.rbac;
    const extension = (rbac && rbac.extension) || 'x-required-permissions';
    for (const { operation, info } of ops) {
      if (info && info.requiredPermissions.length > 0) operation[extension] = info.requiredPermissions;
    }
  }

  private applyPagination(ops: OperationRef[]): void {
    const pagination = this.options.pagination;
    const custom = pagination ? pagination.parameters : undefined;
    const include = pagination ? pagination.include : undefined;
    const all: Array<Record<string, unknown>> = custom ?? DEFAULT_PAGINATION_PARAMS;
    const params = include ? all.filter((p) => include.includes(String(p.name))) : all;
    for (const { operation, info } of ops) {
      if (!info?.hasPagination) continue;
      if (!operation.parameters) operation.parameters = [];
      const existing = new Set((operation.parameters as any[]).map((p) => p.name));
      for (const p of params) {
        if (!existing.has(p.name)) operation.parameters.push({ ...p });
      }
    }
  }

  // ------------------------------------------------------------------ DTOs

  // Swagger derived operationId / tag from the runtime class name (`p_one`, tag `p`); put the declared name back.
  private restoreMinifiedControllerNames(ops: OperationRef[]): void {
    const used = new Set(ops.map((o) => o.operation.operationId).filter((x): x is string => typeof x === 'string'));
    for (const { operation, info } of ops) {
      const from = info?.runtimeControllerName;
      if (!info || !from || from === info.controllerName) continue;
      if (typeof operation.operationId === 'string' && operation.operationId.startsWith(`${from}_`)) {
        const next = `${info.controllerName}_${operation.operationId.slice(from.length + 1)}`;
        // Two controllers that share a declared name keep their distinct runtime ids (ids must be unique).
        if (!used.has(next)) {
          used.delete(operation.operationId);
          used.add(next);
          operation.operationId = next;
        }
      }
      if (Array.isArray(operation.tags)) {
        const base = info.controllerName.replace(/Controller$/, '');
        operation.tags = operation.tags.map((t: string) => (t === from || t === from.replace(/Controller$/, '') ? base : t));
      }
    }
  }

  // A minifier turned `CreateUserDto` into `c`; once the class is matched to its source by shape we know
  // its real name, so give the schema (and every $ref to it) that name back.
  private restoreMinifiedSchemaNames(document: OpenAPIObject): void {
    if (this.declaredDtoNames.size === 0) return;
    const schemas = ensureComponents(document).schemas as Record<string, any>;
    const renames = new Map<string, string>();
    for (const [mangled, declared] of this.declaredDtoNames) {
      if (mangled === declared || !schemas[mangled] || schemas[declared]) continue;
      if ([...renames.values()].includes(declared)) continue;
      schemas[declared] = schemas[mangled];
      delete schemas[mangled];
      renames.set(mangled, declared);
    }
    if (renames.size === 0) return;
    const fix = (node: any): void => {
      if (Array.isArray(node)) return node.forEach(fix);
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        if (k === '$ref' && typeof v === 'string') {
          const name = v.replace('#/components/schemas/', '');
          const to = renames.get(name);
          if (to && v.startsWith('#/components/schemas/')) node[k] = `#/components/schemas/${to}`;
        } else fix(v);
      }
    };
    fix(document.paths);
    fix(document.components);
  }

  // @nestjs/swagger keeps ONE schema per class name, so two different body classes that share a name
  // (`CreateItemDto` in two modules) end up as one wrong schema. Give every further class its own
  // schema (`CreateItemDto2`, ...) and point its request bodies at it; enrichDTOSchemas fills them.
  private splitCollidingBodyDtos(document: OpenAPIObject, ops: OperationRef[]): void {
    const schemas = ensureComponents(document).schemas as Record<string, any>;
    const byName = new Map<string, Function[]>();
    for (const { info } of ops) {
      const cls = info?.bodyDtoClass;
      if (!cls || !cls.name) continue;
      const list = byName.get(cls.name) ?? [];
      if (!list.includes(cls)) list.push(cls);
      byName.set(cls.name, list);
    }
    this.dtoClass('');
    for (const [name, classes] of byName) {
      if (classes.length < 2) continue;
      // The first class keeps the name; drop a schema that clearly describes another class.
      const first = declaredProps(classes[0]);
      const existing = schemas[name];
      const have = Object.keys(existing?.properties ?? {});
      if (existing && have.length > 0 && first.length > 0 && first.some((p) => !have.includes(p))) {
        schemas[name] = { type: 'object', properties: {} };
      }
      this.dtoClasses.set(name, classes[0]);
      const keyOf = new Map<Function, string>([[classes[0], name]]);
      classes.slice(1).forEach((cls, i) => {
        let key = `${name}${i + 2}`;
        while (schemas[key] && !keyOf.has(cls)) key = `${key}_`;
        keyOf.set(cls, key);
        schemas[key] = { type: 'object', properties: {} };
        this.dtoClasses.set(key, cls);
      });
      for (const { operation, info } of ops) {
        const cls = info?.bodyDtoClass;
        const key = cls && keyOf.get(cls);
        const content = operation.requestBody?.content?.['application/json'];
        if (!key || !content?.schema) continue;
        const target = content.schema.$ref ? content.schema : content.schema.items;
        if (target?.$ref) target.$ref = `#/components/schemas/${key}`;
      }
    }
  }

  /** Runtime class for a DTO name: user-provided, then handler parameter types, then the loaded-module index. */
  private dtoClass(name: string): Function | undefined {
    if (this.dtoClasses.size === 0) this.seedDtoClasses();
    return this.dtoClasses.get(name) ?? this.moduleIndex.classesNamed(name)[0];
  }

  private seedDtoClasses(): void {
    const add = (fn: unknown): void => {
      if (typeof fn !== 'function' || !fn.name) return;
      const prev = this.dtoClasses.get(fn.name);
      if (!prev) this.dtoClasses.set(fn.name, fn);
      else if (prev !== fn && !PRIMITIVE_NAMES_FOR_WARN.has(fn.name) && !this.warnedNames.has(fn.name)) {
        this.warnedNames.add(fn.name);
        this.logger.warn(
          `Two different classes are both named "${fn.name}". @nestjs/swagger keeps one schema per class name; the request bodies are documented as separate schemas ("${fn.name}", "${fn.name}2", ...). Renaming one of them gives cleaner names.`,
        );
      }
    };
    const user = this.options.dtos === false ? [] : (this.options.dtos?.classes ?? []);
    for (const entry of user) {
      if (typeof entry === 'function') add(entry);
      else for (const v of Object.values(entry)) add(v);
    }
    const PRIMITIVES = new Set(['Object', 'String', 'Number', 'Boolean', 'Array', 'Date', 'Promise']);
    for (const h of this.handlers) {
      add(h.bodyDtoClass);
      const types = (Reflect as unknown as { getMetadata?: (k: string, t: object, p: string) => unknown }).getMetadata?.(
        'design:paramtypes',
        Object.getPrototypeOf(h.instance),
        h.methodName,
      ) as unknown[] | undefined;
      for (const t of types ?? []) if (typeof t === 'function' && !PRIMITIVES.has(t.name)) add(t);
    }
    if (this.dtoClasses.size === 0) this.dtoClasses.set('', Object); // mark as seeded
  }

  // DTO -> nested DTO -> nested DTO resolution.
  //
  // Structure comes from the .ts SOURCE (recursive, unlimited depth, cycle-safe
  // by construction) rather than from class-validator metadata, because
  // class-validator only tells you a property EXISTS and roughly what kind of
  // thing it validates — it does not say a property's type IS another DTO
  // class. class-validator metadata is still layered on top afterward, per
  // class, for refinements the bare TS type can't give you: @IsEmail ->
  // format, @Matches -> pattern, @IsEnum -> real enum values.
  private enrichDTOSchemas(document: OpenAPIObject): void {
    if (!this.ast) return;
    const schemas = ensureComponents(document).schemas as Record<string, any>;
    let enriched = 0;
    const visited = this.visitedDtos;

    for (const [schemaName, schema] of Object.entries(schemas)) {
      if (schema.type !== 'object') continue;
      if (schema.properties && Object.keys(schema.properties).length > 0) continue;
      const filePath = this.dtoFile(this.ast.index, schemaName);
      if (!filePath || !this.ast.extractor.hasFile(filePath)) continue;
      try {
        // resolveDtoSchema mutates schemas[schemaName] in place with the real
        // structure; its returned { $ref } is meant for a *nested* caller.
        this.resolveDtoSchema(document, visited, schemaName, filePath);
        enriched++;
      } catch (e) {
        this.logger.warn(`Failed to resolve DTO schema for ${schemaName}: ${(e as Error).message}`);
      }
    }
    this.logger.log(`Enriched ${enriched} top-level DTO schemas (recursive, ${visited.size} DTO classes total incl. nested)`);
  }

  // Placeholder-then-fill: register an (initially empty) schema for
  // `className` BEFORE recursing into its properties, and hand back a $ref to
  // that same object immediately if it's asked for again while still being
  // built. That's what makes A -> B -> A terminate through reference tracking
  // rather than a maxDepth guard.
  private resolveDtoSchema(document: OpenAPIObject, visited: Set<string>, className: string, filePath: string): JsonSchema {
    const schemas = document.components!.schemas as Record<string, any>;
    if (visited.has(className)) return ref(className);
    visited.add(className);

    const placeholder = schemas[className] ?? { type: 'object', properties: {} };
    schemas[className] = placeholder;

    const structural = this.ast!.extractor.extractWithRefs(filePath, this.declaredDtoNames.get(className) ?? this.ast!.index.canonicalName(className), (nestedName, nestedSource) =>
      // The AST's own source file for the nested declaration is ground truth
      // for where it lives — more reliable than a name-based lookup.
      this.resolveDtoSchema(document, visited, nestedName, nestedSource.fileName),
    );

    const DtoClass = this.dtoClass(className);
    if (DtoClass) this.applyValidatorRefinements(DtoClass, structural);

    Object.assign(placeholder, structural);
    return ref(className);
  }

  private static readonly VALIDATOR_TO_SCHEMA: Record<string, object> = {
    isString: { type: 'string' },
    isBoolean: { type: 'boolean' },
    isNumber: { type: 'number' },
    isInt: { type: 'integer' },
    isEmail: { type: 'string', format: 'email' },
    isUrl: { type: 'string', format: 'uri' },
    isUUID: { type: 'string', format: 'uuid' },
    isDate: { type: 'string', format: 'date-time' },
    isPositive: { minimum: 1 },
    isNegative: { maximum: -1 },
  };

  // Overlays class-validator-derived refinements onto an already-built
  // structural schema's TOP-LEVEL properties (nested DTO properties get their
  // own call when THEY are resolved). Only touches format/pattern/enum/min/max;
  // never overwrites the structural `type`/`items`/`properties`.
  private applyValidatorRefinements(DtoClass: Function, schema: JsonSchema): void {
    if (!schema.properties) return;
    const storage = getValidatorMetadataStorage();
    if (!storage) return;

    let metas: any[];
    try {
      metas = storage.getTargetValidationMetadatas(DtoClass, '', true, false) as any[];
    } catch {
      return;
    }
    if (!metas || metas.length === 0) return;

    for (const m of metas) {
      const propName = m.propertyName;
      if (!propName || !schema.properties[propName]) continue;
      const prop = schema.properties[propName] as any;

      const schemaInfo = m.name ? SwaggerEnhancer.VALIDATOR_TO_SCHEMA[m.name] : undefined;
      if (schemaInfo && !prop.$ref) {
        // A validator only refines: keep a structurally richer type (e.g. an enum or array).
        const refined: Record<string, unknown> = { ...schemaInfo };
        if (prop.type === 'array' || prop.enum) delete refined.type;
        Object.assign(prop, refined);
      }
      if (m.name === 'min' && typeof m.constraints?.[0] === 'number' && !prop.$ref) prop.minimum = m.constraints[0];
      if (m.name === 'max' && typeof m.constraints?.[0] === 'number' && !prop.$ref) prop.maximum = m.constraints[0];
      if (m.name === 'minLength' && typeof m.constraints?.[0] === 'number' && !prop.$ref) prop.minLength = m.constraints[0];
      if (m.name === 'maxLength' && typeof m.constraints?.[0] === 'number' && !prop.$ref) prop.maxLength = m.constraints[0];

      // @IsEnum(X) — constraints[1] is already the resolved array of member
      // values. Belt-and-suspenders alongside the source-read union-type enum.
      if (m.name === 'isEnum' && Array.isArray(m.constraints?.[1]) && !prop.enum) {
        prop.type = 'string';
        prop.enum = m.constraints[1];
      }
      // @Matches(/regex/) — keeps the schema and the generated example
      // consistent with the actual validation rule.
      if (m.name === 'matches' && m.constraints?.[0] instanceof RegExp) {
        prop.pattern = m.constraints[0].source;
      }
    }
  }

  // ----------------------------------------------------- request bodies

  // Generates request body schemas from @Body() parameter types on controller
  // methods. Works for BOTH named DTO references and inline object literals.
  // Named types get registered as component schemas with a $ref; inline types
  // are embedded directly.
  private applyRequestBodies(document: OpenAPIObject, ops: OperationRef[]): void {
    if (!this.ast) return;
    let resolved = 0;
    for (const { method, operation, info } of ops) {
      if (!info || !BODY_METHODS.has(method)) continue;
      const controllerFile = this.classFile(this.ast.index, info.controller);
      if (!controllerFile || !this.ast.extractor.hasFile(controllerFile)) continue;

      const content = operation.requestBody?.content as Record<string, any> | undefined;
      const existing = content?.['application/json'];
      // multipart / form uploads: never bolt a JSON body onto them.
      if (content && !existing && Object.keys(content).length > 0) continue;

      let body: ReturnType<SourceSchemaExtractor['extractBodyType']>;
      try {
        body = this.ast.extractor.extractBodyType(controllerFile, info.controllerName, info.methodName);
      } catch (e) {
        this.logger.warn(`Failed to extract body type for ${info.controllerName}.${info.methodName}: ${(e as Error).message}`);
        continue;
      }
      if (!body) continue;
      const isArray = body.isArray || info.isArrayBody;

      // Skip if a body schema already exists (from NestJS decorators). Exception: array
      // bodies — Nest's reflection can't see the element DTO through the array/pipe,
      // so it emits a placeholder; our AST-based schema wins there.
      if (existing?.schema && Object.keys(existing.schema).length > 0 && !isArray && !this.isPlaceholderSchema(document, existing.schema)) continue;

      let schemaForExample: JsonSchema = body.schema;
      let outSchema: JsonSchema;
      if (body.typeName) {
        // A class/interface known to the source index goes through the same
        // recursive resolution as DTO components (nested $refs + validator
        // refinements), and reuses the component Nest already registered.
        const dtoFile = this.dtoFile(this.ast.index, body.typeName);
        let itemSchema: JsonSchema | undefined;
        if (dtoFile && this.ast.extractor.hasFile(dtoFile)) {
          try {
            itemSchema = this.resolveDtoSchema(document, this.visitedDtos, body.typeName, dtoFile);
          } catch {
            itemSchema = undefined;
          }
        }
        itemSchema ??= ref(registerSchema(document, body.typeName, body.schema));
        outSchema = isArray ? { type: 'array', items: itemSchema } : itemSchema;
        schemaForExample = itemSchema;
      } else {
        outSchema = isArray ? { type: 'array', items: body.schema } : body.schema;
      }
      const example = this.exampleGen && this.cfg(this.options.requestBodies).example !== false && this.cfg(this.options.examples).requests !== false
        ? this.exampleGen(isArray ? { type: 'array', items: schemaForExample } : schemaForExample, undefined, this.refResolver(document))
        : undefined;

      if (!operation.requestBody) operation.requestBody = {};
      if (!operation.requestBody.content) operation.requestBody.content = {};
      operation.requestBody.content['application/json'] = {
        schema: outSchema,
        ...(example !== undefined ? { example } : {}),
      };
      resolved++;
    }
    this.logger.log(`Resolved request body schemas for ${resolved} operations`);
  }

  // `@Body() dto: Dto` with a type-only import (or any erased type) reaches swagger as `Function` / `Object`:
  // the placeholder says nothing, so the type named in the source replaces it.
  private isPlaceholderSchema(_document: OpenAPIObject, schema: any): boolean {
    if (!schema || typeof schema !== 'object') return false;
    if (typeof schema.$ref === 'string') {
      const name = schema.$ref.split('/').pop() as string;
      return name === 'Function' || name === 'Object';
    }
    return schema.type === 'object' && !schema.properties && !schema.additionalProperties && !schema.allOf && !schema.oneOf && !schema.anyOf;
  }

  // The `Function` / `Object` component swagger made for an erased type goes away once nothing points at it.
  private dropUnusedPlaceholders(document: OpenAPIObject): void {
    const schemas = document.components?.schemas as Record<string, unknown> | undefined;
    if (!schemas) return;
    const text = JSON.stringify(document);
    for (const name of ['Function', 'Object']) {
      if (name in schemas && !text.includes(`"#/components/schemas/${name}"`)) delete schemas[name];
    }
  }

  private refResolver(document: OpenAPIObject): (refName: string) => JsonSchema | undefined {
    return (refName) => document.components?.schemas?.[refName] as JsonSchema | undefined;
  }

  // -------------------------------------------------------------- responses

  // Sets each success response's schema to the ACTUAL HTTP response shape —
  // for handlers with a response transformer that's the interceptor's
  // envelope wrapping the transformer's output type; for everything else it's
  // the controller's own declared (or inferred) return type.
  private applyResponses(document: OpenAPIObject, ops: OperationRef[]): void {
    if (!this.ast) return;
    const respectExisting = (this.options.responses && this.options.responses.respectExisting) !== false;
    let resolved = 0;
    let skipped = 0;

    for (const { operation, info } of ops) {
      if (!info) continue;
      const successStatus = Object.keys(operation.responses ?? {}).find((k) => k.startsWith('2'));
      if (!successStatus) continue;

      const current = operation.responses[successStatus]?.content?.['application/json']?.schema;
      // `{type:'object'}` / `Function` / `Object` is what swagger emits for an erased type (`Promise<X>` with `import type`): says nothing.
      const hasExisting = current && Object.keys(current).length > 0 && !this.isPlaceholderSchema(document, current);
      if (hasExisting && respectExisting && !info.resourceClass) {
        skipped++;
        continue;
      }

      const result = this.resolveResponseSchema(document, info);
      if (!result) {
        skipped++;
        continue;
      }
      operation.responses[successStatus] = {
        ...operation.responses[successStatus],
        description: operation.responses[successStatus]?.description || 'Success',
        content: {
          'application/json': {
            schema: result.schema,
            ...(result.example !== undefined && this.cfg(this.options.examples).responses !== false ? { example: result.example } : {}),
          },
        },
      };
      resolved++;
    }
    this.logger.log(`Resolved response schemas for ${resolved} operations (${skipped} skipped — void/unresolvable/already documented)`);
    if (this.untypedResponses.length > 0) {
      const shown = this.untypedResponses.slice(0, 15).join(', ');
      this.logger.warn(
        `${this.untypedResponses.length} response(s) still contain untyped (any) parts — give the producing function a return type to document them: ${shown}${this.untypedResponses.length > 15 ? ', …' : ''}`,
      );
    }
  }

  private resolveResponseSchema(
    document: OpenAPIObject,
    info: HandlerInfo,
  ): { schema: JsonSchema; example: unknown } | undefined {
    const ast = this.ast!;
    const resource = info.resourceSpec;
    const resolveRefs = this.refResolver(document);

    if (info.resourceClass && resource) {
      const className = info.resourceClass.name;
      const file = this.classFile(ast.index, info.resourceClass);
      if (!file || !ast.extractor.hasFile(file)) return undefined;

      // kind 'dto': the decorated class IS the output shape (`@Serialize(UserDto)`).
      if (resource.kind === 'dto') {
        let itemSchema: JsonSchema;
        try {
          itemSchema = this.resolveDtoSchema(document, this.visitedDtos, className, file);
        } catch (e) {
          this.logger.warn(`Failed to extract schema for ${className}: ${(e as Error).message}`);
          return undefined;
        }
        // Arrays: the handler's own return type tells whether it yields one item or many.
        let isArray = resource.isList ? resource.isList(className) : false;
        const cf = this.classFile(ast.index, info.controller);
        if (!isArray && cf && ast.extractor.hasFile(cf)) {
          try {
            isArray = ast.extractor.extractFromReturnType(cf, info.controllerName, info.methodName)?.schema.type === 'array';
          } catch {
            // keep single
          }
        }
        const payload: JsonSchema = isArray ? { type: 'array', items: itemSchema } : itemSchema;
        const example = this.exampleGen?.(payload, undefined, resolveRefs);
        if (resource.envelope) {
          const refName = (itemSchema.$ref ?? '').replace('#/components/schemas/', '');
          return isArray
            ? { schema: resource.envelope.list(refName), example: example === undefined ? undefined : resource.envelope.listExample((example as unknown[])[0]) }
            : { schema: resource.envelope.single(refName), example: example === undefined ? undefined : resource.envelope.singleExample(example) };
        }
        return { schema: payload, example };
      }

      let out: ReturnType<SourceSchemaExtractor['extractTransformOutput']>;
      try {
        out = ast.extractor.extractTransformOutput(file, className, resource.transformMethod ?? 'transform');
      } catch (e) {
        this.logger.warn(`Failed to extract schema for ${className}: ${(e as Error).message}`);
        return undefined;
      }
      if (!out?.typeName) return undefined;

      const itemRef = registerSchema(document, out.typeName, out.schema, className);
      const itemExample = this.exampleGen?.(out.schema, undefined, resolveRefs);
      const envelope = resource.envelope ?? DEFAULT_ENVELOPE;
      const isList = resource.isList ? resource.isList(className) : /List/.test(className);
      return isList
        ? { schema: envelope.list(itemRef), example: this.exampleGen ? envelope.listExample(itemExample) : undefined }
        : { schema: envelope.single(itemRef), example: this.exampleGen ? envelope.singleExample(itemExample) : undefined };
    }

    const controllerFile = this.classFile(ast.index, info.controller);
    if (!controllerFile || !ast.extractor.hasFile(controllerFile)) return undefined;

    let resolved: ReturnType<SourceSchemaExtractor['extractFromReturnType']>;
    try {
      const anyBefore = ast.extractor.anyLeaves;
      resolved = ast.extractor.extractFromReturnType(controllerFile, info.controllerName, info.methodName);
      if (ast.extractor.anyLeaves > anyBefore) this.untypedResponses.push(`${info.controllerName}.${info.methodName}`);
    } catch (e) {
      this.logger.warn(`Failed to extract return-type schema for ${info.controllerName}.${info.methodName}: ${(e as Error).message}`);
      return undefined;
    }
    if (!resolved) return undefined;

    // Inline object-literal return types have no name to register under.
    let schema: JsonSchema = resolved.typeName
      ? ref(registerSchema(document, resolved.typeName, resolved.schema))
      : resolved.schema;
    schema = this.wrapWithInterceptors(info, schema, resolved.schema, document);
    return { schema, example: this.exampleGen?.(schema, undefined, resolveRefs) };
  }

  // Applies, innermost first (handler -> controller -> global), the payload reshaping done by
  // the interceptors that are really applied to this route.
  private wrapWithInterceptors(
    info: HandlerInfo,
    payload: JsonSchema,
    _inlinePayload: JsonSchema,
    document: OpenAPIObject,
  ): JsonSchema {
    void document;
    const ast = this.ast!;
    if (this.options.responses === false || this.options.responses?.interceptors === false) return payload;
    let current = payload;
    for (const interceptor of [...this.resolver.applied('interceptors', info)].reverse()) {
      const ctor = (interceptor as { constructor?: Function }).constructor;
      if (!ctor || ctor === Object) continue;
      const file = this.classFile(ast.index, ctor);
      if (!file || !ast.extractor.hasFile(file)) continue;
      try {
        const wrapped = ast.extractor.extractInterceptorEnvelope(file, ctor.name, current);
        if (wrapped) current = wrapped;
      } catch (e) {
        this.logger.debug(`Interceptor ${ctor.name} not analysed: ${(e as Error).message}`);
      }
    }
    return current;
  }

  // --------------------------------------------------------------- examples

  // Adds a realistic example to every request body whose schema resolved to a
  // real shape and doesn't already have one.
  private applyRequestExamples(document: OpenAPIObject, ops: OperationRef[]): void {
    const gen = this.exampleGen!;
    for (const { operation } of ops) {
      const content = operation?.requestBody?.content?.['application/json'];
      if (!content?.schema || content.example !== undefined || content.examples) continue;
      const resolved = this.resolveInlineSchema(document, content.schema);
      if (resolved) content.example = gen(resolved, undefined, this.refResolver(document));
    }
  }

  private resolveInlineSchema(document: OpenAPIObject, schema: any): JsonSchema | undefined {
    if (schema.$ref) {
      const name = String(schema.$ref).replace('#/components/schemas/', '');
      return document.components?.schemas?.[name] as JsonSchema | undefined;
    }
    return schema as JsonSchema;
  }

  // Adds a realistic example to path/query parameters that don't already have
  // one, and corrects `required` for individually-decorated @Query()/@Param()
  // parameters — Nest's Swagger explorer marks all of them required:true
  // regardless of a `?` on the method parameter.
  private applyParameterExamples(document: OpenAPIObject, ops: OperationRef[]): void {
    const gen = this.exampleGen!;
    const ec = this.cfg(this.options.examples);
    for (const { operation, info } of ops) {
      if (!Array.isArray(operation?.parameters)) continue;
      let optionality = new Map<string, boolean>();
      if (info && this.ast) {
        const file = this.classFile(this.ast.index, info.controller);
        if (file && this.ast.extractor.hasFile(file)) {
          optionality = this.ast.extractor.getParamOptionality(file, info.controllerName, info.methodName);
        }
      }
      for (const param of operation.parameters) {
        if (ec.fixRequired === false) {
          /* leave `required` as swagger emitted it */
        } else if (param.in === 'path') {
          param.required = true; // path params can never be optional in OpenAPI
        } else if (optionality.get(param.name) === true) {
          param.required = false;
        }
        if (ec.parameters !== false && param.example === undefined && param.examples === undefined) {
          const schema: JsonSchema = param.schema?.$ref ? { type: 'string' } : (param.schema ?? { type: 'string' });
          param.example = gen(schema, param.name, this.refResolver(document));
        }
      }
    }
  }

  // ----------------------------------------------------------------- errors

  private applyErrors(document: OpenAPIObject, ops: OperationRef[]): void {
    const errorOptions = this.options.errors || {};
    const extraction: ExtractionContext = {
      exceptionStatus: this.customExceptionStatus(errorOptions.exceptionStatus ?? {}),
      exampleByName: { ...DEFAULT_EXAMPLE_BY_NAME, ...lowerKeys(errorOptions.templateExamples ?? {}) },
    };
    const cross = errorOptions.crossService
      ? new CrossServiceScanner({ ...errorOptions.crossService, extraction: errorOptions.crossService.extraction ?? extraction })
      : undefined;
    const scanner = new RuntimeErrorScanner({
      extraction,
      includePackages: [...(errorOptions.includePackages ?? []), ...(this.options.sources?.includePackages ?? []), ...this.ownedPkgs.map((p) => p.name)],
      resolveInjected: this.lookup.resolveInjected,
      crossService: cross,
      maxDepth: errorOptions.maxDepth,
      maxMethods: errorOptions.maxMethods,
      moduleIndex: this.moduleIndex,
    });
    new ErrorDocumenter({
      app: this.app,
      container: this.container,
      lookup: this.lookup,
      scanner,
      options: errorOptions,
      logger: this.logger,
    }).apply(document, ops);
  }

  // `class OutOfStock extends ConflictException` -> 409, resolved from the
  // source index (so user-defined exception hierarchies get the right status
  // instead of a blanket 500).
  private customExceptionStatus(explicit: Record<string, number>): Map<string, number> {
    const result = new Map<string, number>(Object.entries(explicit));
    const index = this.ast?.index;
    if (!index) return result;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { STATUS_BY_EXCEPTION } = require('../errors/extraction') as typeof import('../errors/extraction');
    const decls = index.allDecls().filter((d) => d.kind === 'class' && d.extendsName);
    const statusOf = (name: string, depth = 0): number | undefined => {
      if (result.has(name)) return result.get(name);
      if (STATUS_BY_EXCEPTION[name] !== undefined) return STATUS_BY_EXCEPTION[name];
      if (depth > 8) return undefined;
      const decl = decls.find((d) => d.name === name);
      if (!decl?.extendsName) return undefined;
      return statusOf(decl.extendsName.split('.').pop() as string, depth + 1);
    };
    for (const d of decls) {
      if (!/Exception$|Error$/.test(d.name)) continue;
      const status = statusOf(d.extendsName!.split('.').pop() as string);
      if (status !== undefined && !result.has(d.name)) result.set(d.name, status);
    }
    return result;
  }
}

function humanBytes(n: number): string {
  if (n >= 1024 * 1024 && n % (1024 * 1024) === 0) return `${n / (1024 * 1024)} MB`;
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024} KB`;
  return `${n} bytes`;
}

function lowerKeys(obj: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));
}

export function enhanceDocument(app: INestApplication, document: OpenAPIObject, options: AutoDocOptions = {}): OpenAPIObject {
  return new SwaggerEnhancer(app, options).process(document);
}

const PRIMITIVE_NAMES_FOR_WARN = new Set(['Object', 'String', 'Number', 'Boolean', 'Array', 'Date', 'Promise']);

/** Member names a runtime class exposes: methods plus validator / swagger declared properties. */
function runtimeMembers(cls: Function): string[] {
  const out = new Set<string>();
  try {
    for (const k of Object.getOwnPropertyNames(cls.prototype ?? {})) if (k !== 'constructor') out.add(k);
  } catch {
    /* exotic prototype */
  }
  for (const p of declaredProps(cls)) out.add(p);
  return [...out];
}

/** Property names a DTO class declares through class-validator / @ApiProperty metadata. */
function declaredProps(cls: Function): string[] {
  const out = new Set<string>();
  try {
    const storage = getValidatorMetadataStorage();
    for (const m of (storage?.getTargetValidationMetadatas(cls, '', true, false) ?? []) as Array<{ propertyName?: string }>) {
      if (m.propertyName) out.add(m.propertyName);
    }
  } catch {
    /* optional */
  }
  try {
    const props = (Reflect as unknown as { getMetadata?: (k: string, t: object) => unknown }).getMetadata?.(
      'swagger/apiModelPropertiesArray',
      cls.prototype,
    ) as string[] | undefined;
    for (const p of props ?? []) out.add(String(p).replace(/^:/, ''));
  } catch {
    /* optional */
  }
  return [...out];
}
