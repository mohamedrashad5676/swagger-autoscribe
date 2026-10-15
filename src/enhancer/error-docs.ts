import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { variantKey } from '../errors/extraction';
import { describeVariants } from '../errors/error-description';
import { RuntimeErrorScanner, type RuntimeErrorVariant } from '../errors/scanner';
import { deriveValidationMessages } from '../errors/validation-messages';
import { decideResponses, type Failure } from '../descriptions/error-reachability';
import { failureFromVariant } from '../descriptions/failure-normalizer';
import type { AutoDocLogger } from '../logger';
import type { JsonSchema } from '../schema/source-schema-extractor';
import type { ErrorOptions } from '../types';
import { EnhancerResolver } from './resolver';
import type { ContainerLike, ProviderLookup } from './di';
import type { HandlerInfo, OperationRef } from './handlers';
import {
  FALLBACK_VALIDATION_MESSAGES,
  ensureComponents,
  exampleForType,
  registerSchema,
  slugify,
  statusDescription,
} from './schema-utils';

interface AppConfigLike {
  getGlobalGuards?: () => unknown[];
  getGlobalFilters?: () => unknown[];
  getGlobalInterceptors?: () => unknown[];
  getGlobalPipes?: () => unknown[];
  getGlobalRequestGuards?: () => Array<{ instance?: unknown; metatype?: unknown }>;
  getGlobalRequestFilters?: () => Array<{ instance?: unknown; metatype?: unknown }>;
  getGlobalRequestInterceptors?: () => Array<{ instance?: unknown; metatype?: unknown }>;
  getGlobalRequestPipes?: () => Array<{ instance?: unknown; metatype?: unknown }>;
}

export interface ErrorDocsInput {
  app: INestApplication;
  container: ContainerLike;
  lookup: ProviderLookup;
  scanner: RuntimeErrorScanner;
  options: ErrorOptions;
  logger: AutoDocLogger;
}

interface PipeInfo {
  present: boolean | undefined;
  forbidNonWhitelisted: boolean;
}

/**
 * Standard error responses from RUNTIME discovery (see scanner.ts): every
 * reachable `new *Exception(...)` gets its schema + its REAL constructor
 * message as the example — never a generic description. Additive-only,
 * pre-existing content untouched.
 *
 *  - per endpoint: controller method + transitively reachable `this.*`
 *    methods, scanned from compiled JS via Function.toString.
 *  - guards: what is really applied to the route (global guards +
 *    @UseGuards on controller/handler), for non-public routes only. Mode
 *    `all-providers` restores "every provider exposing canActivate".
 *  - filters + interceptors: same two modes; they wrap every request, so
 *    their throws attach to each route they apply to.
 *  - ValidationPipe 400 (array message): attached to body operations when a
 *    validation pipe applies (global, @UsePipes, or on the @Body() itself).
 */
export class ErrorDocumenter {
  private readonly config: AppConfigLike;
  private readonly cache = new Map<Function, Map<string, RuntimeErrorVariant[]>>();
  private readonly mode: { guards: string; filters: string; interceptors: string };
  private readonly resolver: EnhancerResolver;
  // variantKey -> number of endpoints whose closure reaches it below the handler (relevance: 'specific').
  private sharedCount = new Map<string, number>();
  private allProviderCache: { guards: object[]; filters: object[]; interceptors: object[] } | undefined;

  constructor(private readonly input: ErrorDocsInput) {
    this.resolver = new EnhancerResolver(input.app, input.lookup);
    this.config = ((input.app as unknown as { config?: AppConfigLike }).config ?? {}) as AppConfigLike;
    this.mode = {
      guards: input.options.guards ?? 'applied',
      filters: input.options.filters ?? 'applied',
      interceptors: input.options.interceptors ?? 'applied',
    };
  }

  apply(document: OpenAPIObject, ops: OperationRef[]): void {
    const { schemas } = ensureComponents(document);
    if (!schemas['ErrorResponse']) {
      schemas['ErrorResponse'] = {
        type: 'object',
        properties: {
          statusCode: { type: 'number', example: 400 },
          message: {
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
            example: 'Bad Request',
          },
          error: { type: 'string', example: 'Bad Request' },
        },
        required: ['statusCode', 'message'],
      };
    }

    if (this.input.options.relevance === 'specific') {
      this.sharedCount = new Map();
      for (const { info } of ops) {
        if (!info) continue;
        const keys = new Set<string>();
        for (const v of this.input.scanner.scanEndpoint(info.instance, info.methodName)) {
          if ((v.depth ?? 0) > 0) keys.add(variantKey(v));
        }
        for (const k of keys) this.sharedCount.set(k, (this.sharedCount.get(k) ?? 0) + 1);
      }
    }

    for (const { path: pathKey, method, operation, info } of ops) {
      if (!operation?.responses) continue;
      const hasBody = Boolean(operation.requestBody?.content?.['application/json']);
      // Statuses the API itself declares (@ApiResponse): source analysis never removes these.
      const explicitStatuses = new Set<number>(
        Object.keys(operation.responses)
          .filter((k) => /^[45]\d\d$/.test(k))
          .map(Number),
      );

      const endpointVariants = info && this.input.options.endpoint !== false ? this.input.scanner.scanEndpoint(info.instance, info.methodName) : [];
      if (info && endpointVariants.length === 0) {
        this.input.logger.debug(
          `No endpoint-closure variants for ${method.toUpperCase()} ${pathKey} (${info.controllerName}.${info.methodName})`,
        );
      }

      const guardVariants: RuntimeErrorVariant[] = [];
      if (info && !info.isPublic) {
        for (const guard of this.enhancersFor('guards', info)) {
          for (const v of this.scan(guard, 'canActivate')) {
            if (v.isTemplate) {
              // templateRaw keeps its source backticks — strip them, then
              // concretize ${...} per required permission. Only when the route
              // declares permissions at all, mirroring the guard's early-return
              // when none are required.
              const raw = (v.templateRaw ?? '').replace(/^`|`$/g, '');
              for (const perm of info.requiredPermissions) {
                guardVariants.push({ status: v.status, message: raw.replace(/\$\{[^}]*\}/g, perm) });
              }
            } else {
              guardVariants.push(v);
            }
          }
        }
      }

      const globalVariants: RuntimeErrorVariant[] = [];
      if (info) {
        for (const filter of this.enhancersFor('filters', info)) globalVariants.push(...this.scan(filter, 'catch'));
        for (const interceptor of this.enhancersFor('interceptors', info)) {
          globalVariants.push(...this.scan(interceptor, 'intercept'));
        }
      }

      const byStatus = new Map<number, RuntimeErrorVariant[]>();
      for (const v of [...endpointVariants, ...guardVariants, ...globalVariants]) {
        const list = byStatus.get(v.status) ?? [];
        list.push(v);
        byStatus.set(v.status, list);
      }

      // ValidationPipe rejects bad bodies with 400 + an ARRAY message — only
      // possible where a body exists AND its DTO class resolves at runtime
      // (interface-typed bodies erase to Object, which the pipe skips). The
      // messages come from THIS endpoint's @Body() DTO validators — never a
      // hardcoded global example.
      const pipeInfo = this.pipeInfoFor(info);
      if (this.input.options.validation400 !== false && hasBody && pipeInfo.present !== false && info?.bodyDtoClass !== undefined) {
        const dtoMessages = deriveValidationMessages(info.bodyDtoClass, {
          forbidNonWhitelisted: pipeInfo.forbidNonWhitelisted,
        });
        const messages = dtoMessages.length > 0 ? dtoMessages : [...FALLBACK_VALIDATION_MESSAGES];
        const list = byStatus.get(400) ?? [];
        list.push({
          status: 400,
          messages,
          isValidationPipe: true,
          schema: {
            type: 'object',
            properties: {
              statusCode: { type: 'number', example: 400 },
              message: { type: 'array', items: { type: 'string' }, example: messages as unknown as undefined },
              error: { type: 'string', example: 'Bad Request' },
            },
            required: ['statusCode', 'message'],
          },
        });
        byStatus.set(400, list);
      }

      if (this.input.options.relevance === 'specific') {
        this.filterByRelevance(byStatus, explicitStatuses, info ? `${info.controllerName}.${info.methodName}` : `${method.toUpperCase()} ${pathKey}`);
      }

      // Every endpoint can still fail unexpectedly.
      if (this.input.options.document500 !== false && !byStatus.has(500)) byStatus.set(500, []);

      const st = this.input.options.statuses;
      if (st) {
        for (const code of [...byStatus.keys()]) {
          if ((st.include && !st.include.includes(code)) || (st.exclude && st.exclude.includes(code))) byStatus.delete(code);
        }
      }

      for (const [status, variants] of byStatus) {
        const key = String(status);
        const desc = statusDescription(status);
        if (!operation.responses[key]) operation.responses[key] = { description: desc };
        this.attachRuntimeVariants(document, operation.responses[key], key, desc, variants);
      }
    }
  }

  // Normalises every discovered variant into the shared Failure model and keeps
  // only those the model finds relevant as a documented response. Explicit
  // `@ApiResponse` statuses are protected (decideResponses' explicit set), and
  // validation-pipe entries are framework defaults, so they stay too.
  private filterByRelevance(byStatus: Map<number, RuntimeErrorVariant[]>, explicit: ReadonlySet<number>, operation: string): void {
    const items: { item: RuntimeErrorVariant; failure: Failure }[] = [];
    for (const variants of byStatus.values()) {
      for (const v of variants) {
        if (v.isValidationPipe) continue;
        const depth = v.depth ?? 0;
        // Reached by several endpoints below their handlers: shared code, not this operation's own rule.
        const shared = depth > 0 && (this.sharedCount.get(variantKey(v)) ?? 0) >= (this.input.options.sharedThreshold ?? 3);
        const failure = failureFromVariant(v, { operation, depth, shared, path: [], reachedWhen: [] });
        items.push({ item: v, failure });
      }
    }
    const dropped = new Set<RuntimeErrorVariant>();
    for (const d of decideResponses(items, new Set(explicit))) {
      if (!d.keep && !explicit.has(d.failure.consequence.status ?? -1)) dropped.add(d.item);
    }
    if (dropped.size === 0) return;
    for (const [status, variants] of [...byStatus]) {
      const kept = variants.filter((v) => !dropped.has(v));
      if (kept.length === variants.length) continue;
      if (kept.length === 0) byStatus.delete(status);
      else byStatus.set(status, kept);
    }
  }

  // ------------------------------------------------------ enhancer resolution

  private enhancersFor(kind: 'guards' | 'filters' | 'interceptors', info: HandlerInfo): object[] {
    const mode = this.mode[kind];
    if (mode === 'off') return [];
    if (mode === 'all-providers') return this.allProviders()[kind];

    return this.resolver.applied(kind, info);
  }

  private globalEnhancers(kind: 'guards' | 'filters' | 'interceptors'): unknown[] {
    const c = this.config;
    try {
      if (kind === 'guards') {
        return [...(c.getGlobalGuards?.() ?? []), ...(c.getGlobalRequestGuards?.() ?? []).map(wrapperInstance(this.input.lookup))];
      }
      if (kind === 'filters') {
        return [...(c.getGlobalFilters?.() ?? []), ...(c.getGlobalRequestFilters?.() ?? []).map(wrapperInstance(this.input.lookup))];
      }
      return [
        ...(c.getGlobalInterceptors?.() ?? []),
        ...(c.getGlobalRequestInterceptors?.() ?? []).map(wrapperInstance(this.input.lookup)),
      ];
    } catch (e) {
      this.input.logger.warn(`Failed to read global ${kind}: ${(e as Error).message}`);
      return [];
    }
  }

  // Original behaviour, kept as an opt-in mode: every provider/injectable that
  // exposes the Nest enhancer method, applied to every route.
  private allProviders(): { guards: object[]; filters: object[]; interceptors: object[] } {
    if (this.allProviderCache) return this.allProviderCache;
    const result = { guards: [] as object[], filters: [] as object[], interceptors: [] as object[] };
    const seen = new Set<unknown>();
    const visit = (instance: unknown): void => {
      if (!instance || typeof instance !== 'object' || seen.has(instance)) return;
      seen.add(instance);
      const t = instance as { canActivate?: unknown; catch?: unknown; intercept?: unknown };
      if (typeof t.canActivate === 'function') result.guards.push(instance);
      if (typeof t.catch === 'function') result.filters.push(instance);
      if (typeof t.intercept === 'function') result.interceptors.push(instance);
    };
    try {
      for (const module of this.input.container.values()) {
        for (const group of [module.providers, module.injectables]) {
          for (const wrapper of group?.values() ?? []) visit(wrapper.instance);
        }
      }
    } catch (e) {
      this.input.logger.warn(`Failed to discover providers: ${(e as Error).message}`);
    }
    // Imperatively registered global enhancers never enter the DI container.
    for (const kind of ['guards', 'filters', 'interceptors'] as const) {
      for (const g of this.globalEnhancers(kind)) visit(g);
    }
    this.allProviderCache = result;
    return result;
  }

  private scan(instance: object, method: string): RuntimeErrorVariant[] {
    const ctor = (instance as { constructor?: Function }).constructor ?? Object;
    let perClass = this.cache.get(ctor);
    if (!perClass) {
      perClass = new Map();
      this.cache.set(ctor, perClass);
    }
    const hit = perClass.get(method);
    if (hit) return hit;
    let variants: RuntimeErrorVariant[] = [];
    if (typeof (instance as Record<string, unknown>)[method] === 'function') {
      try {
        variants = this.input.scanner.scanMethod(instance, method);
      } catch (e) {
        this.input.logger.warn(`Failed to scan ${ctor.name}.${method}: ${(e as Error).message}`);
      }
    }
    perClass.set(method, variants);
    return variants;
  }

  // ------------------------------------------------------------------- pipes

  private pipeInfoFor(info: HandlerInfo | undefined): PipeInfo {
    const global = this.readGlobalPipeInfo();
    if (!info) return global;
    const local = [...info.enhancers.pipes, ...info.bodyPipes];
    let localInfo: PipeInfo | undefined;
    for (const pipe of local) {
      const instance = pipe as { constructor?: { name?: string }; validatorOptions?: Record<string, unknown>; name?: string };
      const name = typeof pipe === 'function' ? (pipe as Function).name : (instance.constructor?.name ?? '');
      const validatorOptions = typeof pipe === 'function' ? undefined : instance.validatorOptions;
      if (/valid/i.test(name) || validatorOptions !== undefined) {
        localInfo = { present: true, forbidNonWhitelisted: validatorOptions?.forbidNonWhitelisted === true };
      }
    }
    return localInfo ?? global;
  }

  // Reads the app's live global pipes: is a validation pipe registered, and
  // does it forbid non-whitelisted properties? `present` is undefined when the
  // config can't be read (caller falls back to Nest's out-of-the-box behavior).
  private readGlobalPipeInfo(): PipeInfo {
    const fallback: PipeInfo = { present: undefined, forbidNonWhitelisted: false };
    try {
      const pipes = [
        ...(this.config.getGlobalPipes?.() ?? []),
        ...(this.config.getGlobalRequestPipes?.() ?? []).map(wrapperInstance(this.input.lookup)),
      ];
      if (!this.config.getGlobalPipes) return fallback;
      if (pipes.length === 0) return fallback;
      let forbidNonWhitelisted = false;
      let present = false;
      for (const pipe of pipes) {
        const name = (pipe as { constructor?: { name?: string } })?.constructor?.name ?? '';
        const validatorOptions = (pipe as { validatorOptions?: Record<string, unknown> })?.validatorOptions;
        if (/valid/i.test(name) || validatorOptions !== undefined) {
          present = true;
          if (validatorOptions?.forbidNonWhitelisted === true) forbidNonWhitelisted = true;
        }
      }
      return { present, forbidNonWhitelisted };
    } catch {
      return fallback;
    }
  }

  // ------------------------------------------------------------- rendering

  // Renders one error response entry from its discovered variants:
  // - 0 variants -> generic ErrorResponse $ref + single example.
  // - 1 variant -> its schema (inline object shape or generic $ref) + the REAL
  //   constructor message as the example — not a generic description.
  // - N variants -> oneOf over the distinct schemas + a NAMED example per
  //   distinct error. Pre-existing content is never overwritten.
  private attachRuntimeVariants(
    document: OpenAPIObject,
    response: Record<string, any>,
    status: string,
    desc: string,
    variants: RuntimeErrorVariant[],
  ): void {
    const existingContent = response?.content?.['application/json'];
    if (existingContent?.schema && Object.keys(existingContent.schema).length > 0) return;

    const distinct = this.dedupe(variants);
    const statusCode = Number(status);

    // Always-visible variant list: Swagger UI displays a single selected
    // example at a time, so the description carries EVERY variant text with
    // zero interaction. A pre-existing custom description is kept as the lead.
    if (distinct.length > 0) {
      const lead =
        typeof response.description === 'string' && response.description.length > 0 ? response.description : desc;
      const lines = describeVariants(distinct, { hiddenConditions: this.input.options.hiddenConditions });
      if (lines.length > 0 && this.input.options.describe !== false) {
        response.description = `${lead}\n\n${this.input.options.describeHeading ?? 'Possible errors:'}\n${lines.map((line) => `- ${line}`).join('\n')}`;
      }
    }

    if (distinct.length === 0) {
      response.content = {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorResponse' },
          ...(this.input.options.examples === false ? {} : { example: { statusCode, message: desc, error: desc } }),
        },
      };
      return;
    }

    const schemaOf = (v: RuntimeErrorVariant): JsonSchema => {
      if (!v.schema) return { $ref: '#/components/schemas/ErrorResponse' };
      // Validation shapes are identical everywhere (only the examples differ
      // per endpoint) — inline them instead of minting near-duplicate components.
      if (v.isValidationPipe) return v.schema;
      // Genuinely different bodies become NAMED components so the oneOf reads
      // as "this OR this OR this" with selectable, meaningful names.
      const name = registerSchema(document, this.errorSchemaName(v, status), v.schema);
      return { $ref: `#/components/schemas/${name}` };
    };
    const exampleOf = (v: RuntimeErrorVariant): unknown => {
      if (v.isValidationPipe) {
        return { statusCode, message: v.messages ?? [...FALLBACK_VALIDATION_MESSAGES], error: desc };
      }
      if (v.schema) return this.exampleForRuntimeSchema(v.schema, statusCode, v.message ?? desc);
      return { statusCode, message: v.message ?? desc, error: desc };
    };

    if (distinct.length === 1) {
      response.content = {
        'application/json': { schema: schemaOf(distinct[0]), ...(this.input.options.examples === false ? {} : { example: exampleOf(distinct[0]) }) },
      };
      return;
    }

    const schemas: JsonSchema[] = [];
    const seenSchemas = new Set<string>();
    for (const v of distinct) {
      const s = schemaOf(v);
      const key = JSON.stringify(s);
      if (!seenSchemas.has(key)) {
        seenSchemas.add(key);
        schemas.push(s);
      }
    }

    const examples: Record<string, { value: unknown; summary?: string }> = {};
    const usedNames = new Set<string>();
    for (const v of distinct) {
      // Bare guard throws carry no message — their captured `if` condition is
      // what distinguishes them (and becomes the example summary).
      const base = v.isValidationPipe
        ? 'validationFailed'
        : typeof v.message === 'string'
          ? slugify(v.message)
          : v.condition
            ? slugify(v.condition)
            : 'customError';
      let name = base.length > 40 ? base.slice(0, 40) : base;
      let i = 2;
      while (usedNames.has(name)) name = `${base}${i++}`;
      usedNames.add(name);
      examples[name] = v.condition ? { value: exampleOf(v), summary: `when ${v.condition}` } : { value: exampleOf(v) };
    }

    response.content = {
      'application/json': {
        schema: schemas.length === 1 ? schemas[0] : { oneOf: schemas },
        ...(this.input.options.examples === false ? {} : { examples }),
      },
    };
  }

  // Component name for one error variant's body schema: Error409_StartedWaiting,
  // Error401_WhenAuthHeader, … — per status so the same shape on different
  // statuses never collides; registerSchema suffixes same-name/different-shape
  // collisions. Message-less object bodies fall back to their field names.
  private errorSchemaName(v: RuntimeErrorVariant, status: string): string {
    const cap = (s: string): string => (s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s);
    let base: string;
    if (v.isValidationPipe) {
      base = 'ValidationFailed';
    } else if (typeof v.message === 'string') {
      base = slugify(v.message);
    } else if (v.condition) {
      base = `When${slugify(v.condition)}`;
    } else if (v.schema?.properties) {
      const camelize = (s: string): string => s.split(/[^a-zA-Z0-9]+/).filter(Boolean).map(cap).join('');
      base = Object.keys(v.schema.properties).slice(0, 3).map(camelize).join('');
      if (!base) base = 'CustomError';
    } else {
      base = 'CustomError';
    }
    const name = `Error${status}${cap(base)}`;
    return name.length > 64 ? name.slice(0, 64) : name;
  }

  private dedupe(variants: RuntimeErrorVariant[]): RuntimeErrorVariant[] {
    const seen = new Set<string>();
    const out: RuntimeErrorVariant[] = [];
    for (const v of variants) {
      const key = `${v.status}::${v.message ?? ''}::${(v.messages ?? []).join('|')}::${v.isTemplate ? 'T' : ''}::${v.condition ?? ''}::${v.isValidationPipe ? 'V' : ''}::${v.schema ? JSON.stringify(v.schema) : ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(v);
      }
    }
    // A bare variant (no message, no condition, no schema — e.g. a generic
    // downstream-status fallback from a global filter) adds nothing once a
    // SPECIFIC variant for the same status is documented: it would only inject
    // redundant boilerplate next to the endpoint's real, named ones.
    const specificStatuses = new Set(out.filter((v) => v.message || v.condition || v.schema).map((v) => v.status));
    return out.filter((v) => v.message || v.condition || v.schema || !specificStatuses.has(v.status));
  }

  // Builds a realistic example from a runtime-discovered object schema,
  // preferring each property's captured literal example.
  private exampleForRuntimeSchema(schema: JsonSchema, statusCode: number, message: string): unknown {
    if (!schema.properties) return { statusCode, message };
    const out: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (prop.example !== undefined) {
        out[key] = prop.example;
        continue;
      }
      if (prop.$ref) {
        out[key] = {};
        continue;
      }
      out[key] = key === 'statusCode' ? statusCode : key === 'message' ? message : exampleForType(prop.type);
    }
    return out;
  }
}

function wrapperInstance(lookup: ProviderLookup) {
  return (w: { instance?: unknown; metatype?: unknown }): unknown =>
    w.instance ?? (typeof w.metatype === 'function' ? lookup.instanceOfClass(w.metatype as Function) : undefined);
}
