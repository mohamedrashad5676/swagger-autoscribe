# swagger-autodoc

Swagger/OpenAPI documentation for any NestJS project, with no `@ApiProperty` or `@ApiResponse` to write.
It reads your TypeScript and the running app, then fills in auth, RBAC, pagination, request/response schemas, realistic examples,
descriptions, and the errors each endpoint can throw (with their real messages).

Works with NestJS 9-12, Express or Fastify, CommonJS or native ESM, monolith, monorepo or microservices.

| Tested on | |
|---|---|
| NestJS | 9.4, 10.4, 11.2, 12.1 (`@nestjs/swagger` 6.3, 7.4, 11.4, 12.0) |
| TypeScript | 4.9, 5.9, 7.0 |
| Node | 18, 20, 22, 24 |
| Platform | Express, Fastify |
| Layout | tsc, SWC, esbuild bundle, npm workspaces, pnpm, Yarn PnP, Nest CLI monorepo with `paths` |

## Install

```bash
npm i swagger-autodoc
# peers you almost certainly have: @nestjs/common @nestjs/core @nestjs/swagger reflect-metadata rxjs
# TypeScript is optional. TS 4.9-5.x is used as-is; on TypeScript 7+ (no JS compiler API) the package
# analyses your sources with a bundled TS 5.9 fallback - results are identical, your own TS is untouched.
```

## Use

```ts
import { setupSwagger } from 'swagger-autodoc';

const app = await NestFactory.create(AppModule);
app.setGlobalPrefix('api');
app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
// ... guards / filters / versioning ...
setupSwagger(app, { title: 'My API' });   // call LAST, right before listen()
await app.listen(3000);
```

Env switches: `SWAGGER_DISABLED=true`, `SWAGGER_PATH`, `SWAGGER_TITLE`, `SWAGGER_DESCRIPTION`, `SWAGGER_VERSION`.
Export the spec without a UI: `writeOpenApiFile(buildDocument(app), 'openapi.json')`.

## Configuration reference

Every behaviour can be switched off, and most can be tuned. Nothing is required; these are the knobs.

| Option | Default | What it controls |
| --- | --- | --- |
| `preset` | `standard` | `minimal` = only `auth`, `rbac`, `pagination`, `rateLimit` (nothing that reads your source). Explicit options win. |
| `enable` / `disable` | – | Lists of features to switch on / off. `disable` wins. |
| `configFile` | auto | Path to a config file, or `false`. Auto-detects `swagger-autodoc.config.js|cjs|json`, `.swagger-autodocrc.json`, `package.json#swaggerAutodoc`. |
| `operations` | – | Per-operation switches: `[{ match: 'UsersController.findAll', disable: ['descriptions'] }]` or `(ctx) => ({ disable: [...] })`. `match` is `Class.method`, `VERB:/route`, a `*` wildcard or a RegExp; a later `enable` undoes an earlier `disable`. |
| `hooks` | – | `beforeEnhance(doc, app)`, `afterEnhance(doc, app)` (may return a new document), `operation(ctx)` (mutate `ctx.operation`). A throwing hook only logs. |
| `sources` | auto | `roots`, `extraRoots`, `includePackages`, `typeMap`, `tsconfigPath`; `autoPackages: false` stops the automatic discovery of your own installed packages (shared DTO libraries, workspace packages), `excludePackages` skips named ones. |
| `warnings` | `true` | `false` demotes the package's warnings to debug. `logger: false` silences everything. |
| `auth` | on | `false`; `scheme`, `registerScheme`, `markPublic`, `markProtected`, `respectExplicitSecurity`, `publicMetadataKeys`, `isPublic`. |
| `rbac` | off | Give options (or `enable: ['rbac']`) to turn on; `metadataKey`, `read`, `extension`. |
| `pagination` | on | `false`; `paramTypeNames`, `detect`, `parameters`, `include: ['page','limit']`. |
| `dtos` / `requestBodies` / `responses` | on | `false`; `requestBodies.example`; `responses.respectExisting`, `responses.interceptors`. |
| `examples` | on | `false`; `requests`, `parameters`, `responses`, `fixRequired` plus `baseUrl`, `byName`, `matchers`. |
| `errors` | on | `false`; `guards`/`filters`/`interceptors` (`applied`/`all-providers`/`off`), `endpoint`, `validation400`, `document500`, `describe`, `describeHeading`, `examples`, `statuses: { include, exclude }`, `relevance`, `sharedThreshold`, … |
| `descriptions` | on | `false`; `overwrite`, `generate(ctx)`, `transform(text, ctx)`, `detail`, `collapse`, `markGenerated`, … |
| `summaries` | on | `false`; `overwrite`, `generate(input)`. |
| `queryParams` | on | `false`; `query`, `path`, `header`, `deepObject`. |
| `uploads` | on | `false`; `encoding`, `rules`. |
| `rateLimit` | on | `false`; `response`, `header`, `extension` (name or `false`). |
| `behavior` | on | `false`; `description`, `cache`, `cacheTtlUnit` (`'ms'` / `'s'`), `guards` (name the guards), `extension` (default `x-behavior`). Adds a "Behavior" block: permissions, rate limit, response caching. |
| `listing` | on | `false`; `description`, `extension` (default `x-pagination`). Adds a "Listing" block to list endpoints: pagination style and limits, sorting, search, other filters, paging fields in the response. |
| `asyncEndpoints` | on | `false`; `websocket` / `microservices` (`false` or a custom extension name). |
| `cache` | off | See Cache. |

Config files are loaded synchronously: in a `"type": "module"` project name it `swagger-autodoc.config.cjs` (an unloadable auto-detected file only logs a warning; `.mjs` is not supported). Functions and RegExps need a `.js`/`.cjs` file; JSON carries plain values only.

Environment: `SWAGGER_AUTODOC_DISABLE=errors,uploads`, `SWAGGER_AUTODOC_ENABLE=…`, `SWAGGER_AUTODOC_PRESET=minimal`, `SWAGGER_AUTODOC_CONFIG=path`. Precedence, lowest to highest: preset < config file < options in code < `enable` < `disable` < env. `npx swagger-autodoc config` shows the result. `operations` can switch off every feature except `dtos` and `asyncEndpoints` (document-wide).

## Tell it about your conventions (all optional)

```ts
setupSwagger(app, {
  auth:       { publicMetadataKeys: [IS_PUBLIC_KEY] },          // your @Public() decorator
  rbac:       { metadataKey: PERMISSIONS_KEY },                 // -> x-required-permissions
  pagination: { paramTypeNames: ['PaginationDto'] },
  resource:   { metadataKey: RESOURCE_KEY },                    // response-transformer classes (opt-in)
  sources:    { roots: ['apps/api/src'], extraRoots: ['node_modules/@acme/shared/dist/dtos'], includePackages: ['@acme/shared'] },
  examples:   { baseUrl: 'https://api.acme.io', byName: { sku: 'SKU-001' } },
  errors:     { exceptionStatus: { OutOfStock: 409 }, guards: 'applied' },
});
```
Each feature can be switched off with `false` (`auth: false`, `errors: false`, `responses: false`, ...).
See `src/presets/onmeeting.ts` for the full real-world example.

## Response shape after interceptors / mappers / serializers

The documented response is what the client RECEIVES, not the raw return type:

| Your code | What happens |
|---|---|
| handler without return type | type is inferred from the body (`return this.svc.stats()` -> the service's type) |
| mapper method in the body | followed through inference as long as its types flow |
| `@UseInterceptors(X)` / global / `APP_INTERCEPTOR` | applied interceptors reshape the payload, innermost first. Generic `X<T> implements NestInterceptor<T, Resp<T>>`: `T` = the handler payload. Non-generic `map(d => ({ data: d, ... }))`: the single `any` slot is the payload. Pass-through ones (`tap`, logging) change nothing |
| `@Serialize(UserDto)`-style decorator | `resource: { metadataKey: KEY, kind: 'dto' }` — the class is the output (array if the handler returns an array) |
| `@Resource(XResource)` with `transform()` | `resource: { metadataKey: KEY }` (default kind `transformer`) + optional `envelope` |

`resource` accepts an array to support several conventions at once. Limits: a handler that returns `any` with no decorator
and no interceptor information cannot be typed; an interceptor whose output shape depends on runtime values is skipped.

## Automatic descriptions (zero configuration)

Operations that have no description get one, built deterministically from the code — no LLM, no network, nothing executed:
`controller -> service -> repository / use case / RPC client -> the handler on the other side`, up to 4 hops.
Every behavioural claim needs a proof in the source (rules from thrown messages and guards, ownership, side effects,
partial update only with merge evidence, defaults and unique columns from ORM entities, validation from the schema); no proof, no sentence.
Length follows how much the sources justify (minimal / standard / detailed). It adapts to YOUR layout by itself:

- the application sources are read from every `.ts` file (any naming / folder layout; controllers are found by `@Controller`);
- other code the chain can enter is discovered from npm/yarn/pnpm workspaces, Nest monorepo projects and local `file:`/`link:`
  dependencies. Services that live in sibling folders of the app: `descriptions: { services: 'siblings' }`; any other folder: `descriptions: { roots: ['../billing/src'] }`;
- NestJS/TypeORM/Mongoose/`req.user` conventions are built in; `@GrpcMethod` handlers and `client.Rpc()` calls are followed; a base class forwarding
  through `super('pkg', 'service-dir', 'ServiceKey')` is recognised on its own.

**Two layers.** (1) the behaviour sentences above (what the operation DOES, evidence-gated); (2) a deterministic **contract section**
(Markdown, rendered by Swagger UI): *Access* (public / authenticated / required permissions), *path / query / header parameters* with types,
constraints and defaults, *pagination* defaults, the *request body* and every *response* down to nested fields (types, required/optional,
enums, ranges, lengths, patterns, formats, nullability) and the *documented failures* with their real messages and conditions.
Every contract item is a `Fact` with evidence (schema property, declared parameter, handler metadata, documented response) — none is inferred from names.
A placeholder lead ("Handles the requested X operation.") is upgraded from the response contract when one exists.
The contract section is **collapsed by default**: the operation list shows only the behaviour sentences, and a
`Contract details` toggle (`<details>`) opens the rest. `descriptions: { collapse: false }` renders it inline,
`descriptions: { collapse: 'Full contract' }` renames the toggle.
`descriptions: { detail: 'summary' }` keeps only the behaviour sentences; `descriptions: { sections: ['access','errors'] }` picks sections.
The contract section repeats information Swagger UI also shows in its schema panel — it exists so the same facts are available to
`description` consumers (generated clients, docs sites, search, LLM tooling) that never render the schema tree.

A hand-written `@ApiOperation({ description })` is never overwritten. `descriptions: false` switches it off;
`descriptions: { markGenerated: true }` adds `x-generated-description: true` to generated ones.
Optional vocabulary the sources cannot state: `descriptions: { conventions: { acronyms: { otp: 'OTP' }, entityAliases: [['member','user']] } }`.

## Query DTOs, uploads, summaries, rate limits

All on by default, each with an off switch:

| Feature | What you get | Switch |
|---|---|---|
| `@Query()` / `@Param()` / `@Headers()` dto | one parameter per DTO property (type, required, description) when swagger emitted none; path names must be in the route template | `queryParams: false` |
| File uploads | `multipart/form-data` with `format: binary` fields (`FileInterceptor('avatar')` -> `avatar`; `FilesInterceptor('photos', 5)` -> array, `maxItems: 5`; `FileFieldsInterceptor`, `AnyFilesInterceptor`) plus the `@Body()` DTO fields. An explicit `@ApiConsumes`/`@ApiBody` multipart body is kept. | `uploads: false` |
| `summary` | `List users`, `Get user`, `Create user`, `Update user`, `Delete user`, otherwise the humanised method name. `@ApiOperation({ summary })` always wins. | `summaries: false`, `summaries: { generate(input) }` |
| Rate limits | `@nestjs/throttler` (v4-v6): `429` response, `Retry-After` header, `x-rate-limit: [{ name, limit, windowMs }]`; `@Throttle` overrides, `@SkipThrottle` removes | `rateLimit: false` |
| `@HttpCode` | the success response uses the declared status (e.g. `200` on POST, `204` on DELETE) | - |

`ParseFilePipe` limits show up too: `MaxFileSizeValidator` / `FileTypeValidator` become the field description (plus `x-max-size`, and `encoding.contentType` for a plain MIME type), `fileIsRequired: false` makes the body optional.

The upload field name sits in a closure at runtime, so it is read from your TypeScript source; without sources a plain `@UploadedFile()` is documented as the field `file` (`files` for `@UploadedFiles()`).

## WebSocket and microservice handlers

They are not HTTP routes, so OpenAPI has no native place for them. When the app has any, the document gets `x-websocket` (gateway, namespace, path, events with their `@MessageBody()` DTO as a `$ref`) and `x-microservices` (handler, transport, `message` / `event`, pattern or `{ service, rpc }` for gRPC, `@Payload()` DTO). Swagger UI ignores these keys; client generators and docs tooling can read them. `asyncEndpoints: false` turns it off.

## Variables & environments in Swagger UI (opt-in)

```ts
setupSwagger(app, {
  environments: {
    environments: { Local: { baseUrl: 'http://localhost:3000' }, Staging: { baseUrl: 'https://staging.example.com' } },
    globals: { lang: 'en' },
  },
}); // or simply `environments: true`
```

An **Env** picker and a **Variables** manager appear on the docs page. Write `{{name}}` in any parameter, header, body or in the *Authorize* dialog.
Dynamic values: `{{$guid}} {{$timestamp}} {{$isoTimestamp}} {{$randomInt}} {{$randomString}} {{$randomEmail}}`.
**Automatic detection** (switches in *Variables → Auto-capture*): route `{params}` become variables; the access / refresh token is found in auth-like responses whatever its key is called (JWT shape, `token`/`jwt`/`session` keys, `Authorization` header) and sent as `Authorization: Bearer {{token}}`; `id`/`…Id` of a response fill the matching route variable; empty path/query inputs are pre-filled from variables. Disable with `auto: false` or per switch (`auto: { ids: false }`).
A `baseUrl` variable re-targets requests to another server (needs CORS there). Import/export Postman environment files. Values stay in the browser.
Options: `environments`, `globals`, `auto`, `captures` (extra rules), `active`, `baseUrlVariable` (`false` to disable), `authorization` (`false` to disable).
Note: Swagger UI validates typed fields itself, so a variable in an integer/boolean field can be rejected before sending; string, UUID-less and body fields are fine.

## Cache (opt-in)

```ts
setupSwagger(app, { cache: true });            // node_modules/.cache/swagger-autodoc
setupSwagger(app, { cache: { dir: '.cache' } });
```

The finished document is reused when none of these changed: the base document, your options (functions by source text), `.ts` and loaded compiled file stats, tsconfig, package / TypeScript / Node versions, the global guards / filters / pipes / interceptors and their plain config, and `SWAGGER_*` env vars. **Not** seen: files outside the source roots and the require cache, and state read at startup from a database. If a result ever looks stale, delete the folder or turn the cache off. At most 5 documents are kept.

## Failure relevance

`errors: { relevance: 'specific' }` sends every discovered failure through the normalised failure model and drops message-less infrastructure noise (for example a bare `new ServiceUnavailableException()`). Statuses you declare with `@ApiResponse` are always kept. Failures thrown below the handler and reached by `sharedThreshold` (default 3) or more endpoints count as shared code and are kept only where an `if` condition ties them to the operation. The default `'all'` documents everything the scanner reaches.

**Literal narrowing** (always on): when a helper or service is called with literals (`check('a')`, `this.svc.run(false)`), only failures whose guard those literals can satisfy are documented. Literals propagate through relaying helpers; a non-literal argument, or a parameter reassigned in the callee, proves nothing and keeps every failure.

## Hiding endpoints

```ts
/** @swagger-ignore */            // above a class: the whole controller disappears
@Controller('internal') class InternalController {}

  // @swagger-ignore               // above a handler: only that endpoint
  @Get('debug') debug() {}
```
Or by configuration: `exclude: { controllers: ['HealthController'], endpoints: ['UsersController.create', 'DELETE:/users/{id}', 'UsersController.GET:/users/paged'] }`
(`{id}` and `:id` are equivalent), or env `SWAGGER_EXCLUDE_CONTROLLERS` / `SWAGGER_EXCLUDE_ENDPOINTS` (comma separated).
Precedence: comment > config > hand-written docs > generation. Excluded operations are removed first, so no later pass can re-add them.
Limit: DTO schemas used only by excluded endpoints may remain in `components.schemas`.

## Helpers, mappers and services (deep traversal)

When a handler's type is not enough (no annotation, `: any`, `Promise<any>`, an untyped repository), the package reads the
code that PRODUCES the value and follows every call it makes — to any depth, across files, folders and shared packages
(as long as their `.ts` sources are reachable; `.d.ts` only gives declared types):

- `return this.svc.load()` -> into `load()` -> into `mapUser(x)` -> into `decorate(x)` -> ... until a typed value is found
- `rows.map(r => toDto(r))` -> array of what the callback returns; `promise.then(x => toDto(x))`
- object literals are traced per property: `{ user: mapUser(u), meta: { page: 1 } }`
- spreads, `const` variables, ternaries (`oneOf`), `a ?? b`, `await`, `x as any`
- cyclic helpers terminate (cycle guard + depth cap)

A concrete declared return type is always trusted as-is. What can NOT be known (a value that is really `any`, e.g. `JSON.parse`,
an interface-typed dependency with no body to read) stays undocumented — and is **reported**: after processing you get one
warning listing the endpoints that still contain untyped parts, so you know exactly where to add a return type.

## How it works

| Feature | Source of truth |
|---|---|
| security / public routes | your `@Public()` metadata |
| request/response schemas | TypeScript compiler API over your sources (honours `tsconfig` paths) |
| DTO refinements (`format`, `pattern`, `enum`, `minLength`) | class-validator metadata |
| errors per endpoint | live DI instances + `Function.toString` — follows `controller -> service -> repository`, guards, filters, interceptors that are *really applied* |
| 400 validation messages | the endpoint's own `@Body()` DTO validators |

Route matching uses `operationId`, so global prefix, URI versioning, `RouterModule` and path arrays all work.

## Notes / limits

- Call `setupSwagger` after all global guards/filters/pipes are registered.
- Source features need `.ts` files on disk (dev, CI, or an image that keeps `src`). Without them the runtime features (auth, pagination, error discovery) still work and the schema/description parts degrade without crashing. Best practice for prod: generate `openapi.json` in CI (see `check` below).
- Error discovery reads the compiled JS of your classes. It works in CommonJS and in native ESM (classes are located by their own source text), and in single-file bundles (esbuild, webpack). In minified production bundles controllers are matched to your sources by route path + method names and DTO classes by their exact property set, and the real names are restored in `operationId`, tags and schema names. If the search for compiled files hits its limit (30000 files / 8MB per file) a warning says so; run from your project root to keep it small.
- Two different DTO classes with the same name in different modules collide inside `@nestjs/swagger` (one schema per class name). The package documents each request body with its own schema (`CreateItemDto`, `CreateItemDto2`, ...) and logs a warning; renaming one of them gives cleaner names. `@nestjs/swagger` itself may still emit equal `operationId`s for same-named controllers.
- `typescript` is optional. On TypeScript 7+ (no JS compiler API) a bundled TypeScript 5.9 is used for reading your sources; your own compiler is untouched.
- Documentation never blocks boot: `setupSwagger` catches and logs failures.

## CI check: coverage gates and breaking changes

```bash
npx swagger-autodoc check --app dist/app.js \
  --baseline openapi.baseline.json --min-response-schemas 90 --min-descriptions 80
npx swagger-autodoc check --app dist/app.js --baseline openapi.baseline.json --update-baseline   # accept the current API
```

`dist/app.js` is a compiled file of yours that exports `createApp()` (configure prefix, pipes and versioning, then return the app
without calling `listen()`; it may also export `autodocOptions`), or simply exports your root module (`--export AppModule`).
Without `createApp()` you can still describe the app with flags: `--prefix api`, `--versioning-uri`, `--validation`.
It prints the coverage (typed 2xx responses, descriptions, request bodies, documented 4xx) and lists the endpoints with no typed response.
Exit code 1 when a `--min-*` gate is missed or the API has breaking changes versus the baseline (`--allow-breaking` to report only), 2 on usage errors.
Breaking = endpoint or success response removed, response property removed or retyped, new required parameter or request property,
a parameter or property that became required or changed type. Added endpoints/responses and removed optional inputs are reported as info.
`--json` prints a machine readable report; `--out file.json` also writes the OpenAPI document. The same functions are exported:
`computeCoverage(doc)` and `diffDocuments(baseline, current)`.

## Behaviour changes vs. the original OnMeeting code
Fixed: wrong `RequestMethod` mapping; broken matching with prefix/versioning; empty schemas for `Partial/Pick/Omit/PartialType`;
`| null` not nullable; unresolved tsconfig path aliases; crash when `src` missing; name heuristics matching `paid`/`valid` as ids;
type-incompatible examples; guards applied to routes they don't guard; custom exceptions defaulting to 500; Windows paths;
inherited controller handlers; plain `Dto[]` bodies. Use `onmeetingPreset()` to reproduce the old defaults exactly.
