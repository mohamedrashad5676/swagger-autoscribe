import type { LoggerService } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { DocumentBuilder, SwaggerCustomOptions, SwaggerDocumentOptions } from '@nestjs/swagger';
import type { ExampleOptions } from './schema/example-generator';
import type { JsonSchema } from './schema/source-schema-extractor';
import type { CrossServiceOptions } from './errors/cross-service';
import type { DescriptionOptions } from './descriptions/auto-profile';

export type MetadataKey = string | symbol;

/** What the callbacks below get to look at for one route handler. */
export interface HandlerContext {
  controller: Function;
  controllerName: string;
  handler: Function;
  methodName: string;
  httpMethod: string;
  reflector: Reflector;
  /** Reads a metadata key from the handler first, then the controller class. */
  getMetadata<T = unknown>(key: MetadataKey): T | undefined;
}

export interface SourceOptions {
  /** Directories holding your TypeScript sources. Default: auto-detected (`nest-cli.json` roots, else `./src`, else `./`). */
  roots?: string[];
  /** Additional directories to index — e.g. a shared package's `dist/dtos` (`.d.ts` is fine). */
  extraRoots?: string[];
  /** Files matching any of these are not indexed. Default: spec/test files. */
  exclude?: RegExp[];
  /** tsconfig used to resolve imports/path aliases. Default: nearest `tsconfig.json`. */
  tsconfigPath?: string;
  /** `TypeSymbolName -> schema` overrides for types that need a custom wire shape. */
  typeMap?: Record<string, JsonSchema>;
  /**
   * Installed (node_modules) packages whose types are YOUR types — e.g. a published
   * `@acme/shared` with DTOs. Their classes/interfaces are expanded like local ones;
   * every other library type stays an opaque object.
   */
  includePackages?: string[];
  /**
   * Find the packages that hold your own types without being told (default true): dependencies installed from
   * `file:` / `link:` / `workspace:` / git / a tarball, symlinked workspace packages, and the packages that define
   * the DTO classes your routes use. Their TypeScript / `.d.ts` is read like your local sources.
   */
  autoPackages?: boolean;
  /** Package names `autoPackages` must leave alone. */
  excludePackages?: string[];
  cwd?: string;
}

export interface AuthOptions {
  enabled?: boolean;
  /** Metadata keys written by your `@Public()` decorator. Default: `isPublic`, `IS_PUBLIC_KEY`, `public`. */
  publicMetadataKeys?: MetadataKey[];
  /** Full control: return true/false to decide, undefined to fall back to `publicMetadataKeys`. */
  isPublic?: (ctx: HandlerContext) => boolean | undefined;
  /** Security scheme registered in `components.securitySchemes` and referenced by protected routes. */
  scheme?: { name?: string; definition?: Record<string, unknown> };
  /** Keep a `security` already set by `@ApiBearerAuth()` / `@ApiSecurity()` (default true). */
  respectExplicitSecurity?: boolean;
  /** Register the scheme in `components.securitySchemes` (default true; turn off when you register it with `builder`). */
  registerScheme?: boolean;
  /** Set `security: []` on public routes (default true). */
  markPublic?: boolean;
  /** Add the security requirement to protected routes (default true). */
  markProtected?: boolean;
}

export interface RbacOptions {
  enabled?: boolean;
  /** Metadata key(s) holding the permissions a route requires. */
  metadataKey?: MetadataKey | MetadataKey[];
  /** Custom reader; takes precedence over `metadataKey`. */
  read?: (ctx: HandlerContext) => string[] | undefined;
  /** OpenAPI extension name. Default `x-required-permissions`. */
  extension?: string;
}

export interface PaginationOptions {
  enabled?: boolean;
  /** Handler parameter type names that mean "this route is paginated". Default `['QueryOptions']`. */
  paramTypeNames?: string[];
  detect?: (ctx: HandlerContext, paramTypes: Array<Function | undefined>) => boolean;
  /** Replace the injected query parameters. */
  parameters?: Array<Record<string, unknown>>;
  /** Only add these parameters (by name) out of the default / custom set — e.g. `['page', 'limit']`. */
  include?: string[];
}

export interface ResponseEnvelope {
  single(itemRef: string): JsonSchema;
  list(itemRef: string): JsonSchema;
  singleExample(item: unknown): unknown;
  listExample(item: unknown): unknown;
}

/**
 * Opt-in: handlers decorated with a "response transformer" (a class whose
 * `transform()` return type is the wire shape) are documented from that type,
 * wrapped in the envelope your interceptor produces.
 */
export interface ResourceOptions {
  /** Metadata key under which the decorator stores the class. */
  metadataKey: MetadataKey;
  /**
   * `transformer` (default): the class has a method (`transformMethod`) whose declared return type is the output shape.
   * `dto`: the class IS the output shape (`@Serialize(UserDto)`, `@SerializeOptions`-style decorators).
   */
  kind?: 'transformer' | 'dto';
  /** Method whose declared return type is the output shape. Default `transform`. */
  transformMethod?: string;
  /** Does this transformer produce a list envelope? Default `/List/.test(className)`. */
  isList?: (className: string) => boolean;
  /** Default: `{ data }` / `{ data[], total, page, limit, totalPages }`. */
  envelope?: ResponseEnvelope;
}

export interface ResponseOptions {
  enabled?: boolean;
  /** Keep a success response schema that already exists (e.g. from `@ApiOkResponse`). Transformer-backed handlers always win. Default true. */
  respectExisting?: boolean;
  /** Reshape the documented payload with the interceptors that are really applied (global + controller + handler). Default true. */
  interceptors?: boolean;
}

export type EnhancerMode = 'applied' | 'all-providers' | 'off';

export interface ErrorOptions {
  enabled?: boolean;
  /** Where guard/filter/interceptor errors come from.
   *  `applied` (default): only what is really applied to the route (global + @UseGuards/@UseFilters/@UseInterceptors).
   *  `all-providers`: every provider exposing canActivate/catch/intercept, on every route. */
  guards?: EnhancerMode;
  filters?: EnhancerMode;
  interceptors?: EnhancerMode;
  /** Scan the handler's own code and the code it calls. Default true. */
  endpoint?: boolean;
  /** Document the ValidationPipe 400 (messages derived from the `@Body()` DTO). Default true. */
  validation400?: boolean;
  /** Add the "Possible errors:" list to each error response description. Default true. */
  describe?: boolean;
  /** Heading of that list. Default `Possible errors:`. */
  describeHeading?: string;
  /** Add `example` / `examples` to error responses (schemas stay). Default true. */
  examples?: boolean;
  /** Restrict / drop the documented error statuses (`@ApiResponse` ones you wrote are never removed). */
  statuses?: { include?: number[]; exclude?: number[] };
  /** Document a generic 500 on every route. Default true. */
  document500?: boolean;
  /**
   * Which discovered failures become documented responses.
   * `all` (default): everything the scanner reaches. `specific`: runs every failure through the
   * normalised failure model and drops infrastructure noise (a bare 5xx / `Error` with no message
   * or condition of its own) and unconditional failures of shared code. Statuses you declared with `@ApiResponse` are always kept.
   */
  relevance?: 'all' | 'specific';
  /**
   * With `relevance: 'specific'`: a failure thrown below the handler and reached by at least this many endpoints
   * is shared code; it is documented only where an `if` condition ties it to the operation. Default 3.
   */
  sharedThreshold?: number;
  /** Guard `if` conditions that are pure noise and not listed in descriptions. */
  hiddenConditions?: RegExp[];
  /** Example text for `${interpolation}` identifiers inside exception message templates. */
  templateExamples?: Record<string, string>;
  /** Custom exception class -> status, for classes the static analysis cannot infer. */
  exceptionStatus?: Record<string, number>;
  /** Installed (node_modules) packages treated as first-party when following calls. */
  includePackages?: string[];
  /** Follow errors into a sibling gRPC microservice's source (advanced, opt-in). */
  crossService?: CrossServiceOptions;
  maxDepth?: number;
  maxMethods?: number;
}

export interface DtoOptions {
  enabled?: boolean;
  /** Extra classes (or module namespaces) to look DTO classes up in, for class-validator refinements. */
  classes?: Array<Function | Record<string, unknown>>;
}

/** Everything that can be switched on or off as a whole. */
export type Feature =
  | 'auth' | 'rbac' | 'pagination' | 'dtos' | 'requestBodies' | 'responses' | 'examples' | 'errors'
  | 'descriptions' | 'summaries' | 'queryParams' | 'uploads' | 'rateLimit' | 'asyncEndpoints' | 'behavior' | 'listing';

/** Features that can be turned off for a single operation (`dtos` / `asyncEndpoints` work on the whole document). */
export type OperationFeature = Exclude<Feature, 'dtos' | 'asyncEndpoints'>;

export interface OperationContext {
  path: string;
  method: string;
  operationId: string | undefined;
  controllerName: string | undefined;
  methodName: string | undefined;
  tags: string[];
  operation: Record<string, any>;
}

export interface OperationRule {
  /** `Class.method`, `VERB:/route`, `Class.VERB:/route`, a string containing `*`, or a RegExp tested against `METHOD /path` and `Class.method`. */
  match: string | RegExp;
  disable?: OperationFeature[];
  enable?: OperationFeature[];
}

export interface HooksOptions {
  beforeEnhance?: (document: any, app: any) => void;
  /** May return a replacement document. */
  afterEnhance?: (document: any, app: any) => any;
  /** Called for every kept operation after all passes; mutate `ctx.operation`. */
  operation?: (ctx: OperationContext) => void;
}

export interface ExamplesConfig extends ExampleOptions {
  enabled?: boolean;
  /** Example on request bodies. Default true. */
  requests?: boolean;
  /** Example on path/query/header parameters. Default true. */
  parameters?: boolean;
  /** Example on response bodies. Default true. */
  responses?: boolean;
  /** Correct `required` (path always required, `?` params optional). Default true. */
  fixRequired?: boolean;
}

export interface AutoDocOptions {
  /** Start from a bundle: `standard` (default, everything on) or `minimal` (only auth, rbac, pagination, rate limits — nothing that reads your source). Explicit options always win. */
  preset?: 'standard' | 'minimal';
  /** Features to switch off (same as setting each to `false`). */
  disable?: Feature[];
  /** Features to switch back on after the preset (or an earlier `false`). `disable` wins over `enable`. */
  enable?: Feature[];
  /** Config file to read (default: `swagger-autodoc.config.js|cjs|json`, `.swagger-autodocrc.json`, or `"swaggerAutodoc"` in package.json). `false` = don't read any. Explicit options win over the file. */
  configFile?: string | false;
  /** Per-operation switches; first array rule match is combined with later ones. A function returns `{ disable, enable }`. */
  operations?: OperationRule[] | ((ctx: OperationContext) => { disable?: OperationFeature[]; enable?: OperationFeature[] } | void);
  hooks?: HooksOptions;
  /** `false` turns the package's warnings into debug messages. Default true. */
  warnings?: boolean;
  /** Default: `SWAGGER_DISABLED !== 'true'`. */
  enabled?: boolean;
  /** UI path. Default: `SWAGGER_PATH` or `docs`. */
  path?: string;
  title?: string;
  description?: string;
  version?: string;
  /** Customize the DocumentBuilder (servers, tags, extra security schemes, …). */
  builder?: (builder: DocumentBuilder) => DocumentBuilder;
  documentOptions?: SwaggerDocumentOptions;
  uiOptions?: SwaggerCustomOptions;
  /**
   * Postman-style variables & environments inside Swagger UI: `{{token}}` in parameters / headers / bodies, an environment picker,
   * capture of response values (login -> token), dynamic variables, Postman import / export. `true` for the defaults.
   */
  environments?: boolean | import('./ui/environments').EnvironmentsOptions;
  /** `false` silences the package; or pass your own LoggerService. */
  logger?: boolean | LoggerService;

  sources?: SourceOptions;
  auth?: AuthOptions | false;
  rbac?: RbacOptions | false;
  pagination?: PaginationOptions | false;
  dtos?: DtoOptions | false;
  /** Generate request bodies from `@Body()` types. Default true. */
  requestBodies?: boolean | { enabled?: boolean; example?: boolean };
  responses?: ResponseOptions | false;
  /** One or several response-transformer conventions (first decorator found on a handler wins). */
  resource?: ResourceOptions | ResourceOptions[];
  examples?: ExamplesConfig | false;
  errors?: ErrorOptions | false;
  /**
   * Opt-in analysis cache: reuse the finished document when nothing it depends on changed (base document,
   * options, source / compiled file stats, package + TypeScript versions, global enhancer config, SWAGGER_* env).
   * Not seen by the key: edits to files outside the source roots / require cache, and runtime state read at
   * startup (DB-driven config). Delete the folder or set `cache: false` if a result ever looks stale.
   */
  cache?: boolean | import('./cache').CacheOptions;
  /** List WebSocket events and microservice / gRPC handlers as `x-websocket` / `x-microservices` (only present when the app has any). Default on. */
  asyncEndpoints?: boolean | { enabled?: boolean; websocket?: boolean | string; microservices?: boolean | string };
  /** Auto `summary` for operations without one (never overrides `@ApiOperation`). Default on. */
  summaries?: boolean | { enabled?: boolean; overwrite?: boolean; generate?: (input: import('./enhancer/summary').SummaryInput) => string | undefined };
  /** Expand `@Query() dto` into individual query parameters when swagger emitted none. Default on. */
  queryParams?: boolean | { enabled?: boolean; query?: boolean; path?: boolean; header?: boolean; deepObject?: boolean };
  /** Document `FileInterceptor` family uploads as `multipart/form-data`. Default on. */
  uploads?: boolean | { enabled?: boolean; encoding?: boolean; rules?: boolean };
  /** Add a 429 response + `x-rate-limit` for routes behind `@nestjs/throttler`. Default on. */
  rateLimit?: boolean | { enabled?: boolean; response?: boolean; header?: boolean; extension?: string | false };
  /**
   * A "Behavior" note in each operation's description: required permissions, rate limit, response caching
   * (`CacheInterceptor` + `@CacheTTL`) and, on request, the guards. Also `x-behavior`. Default on.
   */
  behavior?:
    | boolean
    | {
        enabled?: boolean;
        /** Write the note into the description (default true). */
        description?: boolean;
        /** Document `CacheInterceptor` / `@CacheTTL` (default true). */
        cache?: boolean;
        /** `@nestjs/cache-manager` counts the TTL in ms, the old Nest cache in s; detected when omitted. */
        cacheTtlUnit?: 'ms' | 's';
        /** Name the guards that run on the route (default false). */
        guards?: boolean;
        /** Extension name, or `false` for none. Default `x-behavior`. */
        extension?: string | false;
      };
  /**
   * A "Listing" note for list endpoints: pagination style, page size limits, sorting, search and which
   * pagination fields the response carries. Read from the query parameters, so it works for any DTO. Default on.
   */
  listing?: boolean | { enabled?: boolean; description?: boolean; extension?: string | false };
  /** Generated descriptions for operations that have none (on by default; `false` disables). */
  descriptions?: DescriptionOptions | false;
  /**
   * Hide endpoints from the document. Also configurable through the comma-separated env vars
   * `SWAGGER_EXCLUDE_CONTROLLERS` / `SWAGGER_EXCLUDE_ENDPOINTS`, and per code with a
   * `@swagger-ignore` comment above a controller class or a handler.
   */
  exclude?: ExcludeOptions;
}

export interface ExcludeOptions {
  /** Controller class names, e.g. `HealthController`. */
  controllers?: string[];
  /** `Class.method`, `VERB:/route`, or `Class.VERB:/route` (`{id}` and `:id` are equivalent). */
  endpoints?: string[];
}

export type { LoggerService, Reflector, DescriptionOptions };
