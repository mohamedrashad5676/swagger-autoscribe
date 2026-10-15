# Changelog

## 1.0.0

First release.

### Documentation generated from your code
- Auth (`bearerAuth`, public routes), RBAC (`x-required-permissions`) and pagination parameters.
- Request / response schemas read from TypeScript (deep traversal of helpers, mappers, services, interceptors), including `import type` DTOs, `@Query()` / `@Param()` / `@Headers()` DTOs expanded into parameters, and DTOs that live in your own installed packages (found automatically).
- Examples, automatic `summary`, and evidence-based collapsed descriptions ("Contract details").
- Runtime-discovered errors, with narrowing by call-site literals and guards.
- File uploads as `multipart/form-data` (`FileInterceptor` family, `ParseFilePipe` rules).
- Rate limits for `@nestjs/throttler` (v4-v6): `429` response, `Retry-After`, `x-rate-limit`.
- **Behavior note**: permissions, rate limit and response caching (`CacheInterceptor` with `@CacheTTL` / `@CacheKey`), optionally the guards; mirrored in `x-behavior`.
- **Listing note**: page / offset / cursor pagination, page size limits, sorting, search, other query parameters and the paging fields of the response; mirrored in `x-pagination`.
- WebSocket gateways and microservice handlers listed as `x-websocket` / `x-microservices`.
- Endpoint exclusion (`@swagger-ignore`), same-named DTOs in different modules get separate schemas.

### Variables and environments in Swagger UI (`environments: true`)
- Postman-style `{{variables}}` in every request (path, query, headers, body, Authorize dialog), environments, globals, secrets, dynamic variables (`{{$guid}}`, `{{$timestamp}}`, ...), import / export of Postman environment files.
- Automatic detection: route parameters become variables, tokens are found in login / refresh responses whatever the key is called, `id` fields fill the matching route variable, empty inputs are pre-filled. Everything is editable from the UI.
- `baseUrl` variable re-targets requests per environment; Curl and Request URL show what is really sent.
- Variable picker: `{{` autocomplete, `{x}` button, green / amber / red field highlighting with value tooltip, and **Set as variable** from a selected part of a response.

### Configuration
- Every feature takes `false`, `{ enabled: false }` or an options object; `disable` / `enable` lists and `preset: 'minimal'`.
- Config file (`swagger-autodoc.config.js|cjs|json`, `.swagger-autodocrc.json`, or `"swaggerAutodoc"` in package.json) and env vars (`SWAGGER_AUTODOC_*`). Precedence: preset < file < code options < `enable` < `disable` < env.
- Per-operation rules (`operations`) and hooks (`beforeEnhance`, `afterEnhance`, `operation`).
- Optional `cache` that reuses the finished document when nothing changed.

### Compatibility
- NestJS 9-12, Express and Fastify, CommonJS and native ESM, TypeScript 4.9-7 (bundled TS 5.9 fallback), Node 18-24.
- tsc, SWC and esbuild output, npm workspaces, pnpm, Yarn PnP, Nest CLI monorepos; minified production bundles (controllers, DTOs, operationIds and schema names are restored).

### CLI
- `check`: coverage gates and breaking-change detection against a baseline, for CI. `config` prints what is on or off.
- CI workflow (Linux / Windows / macOS x Node 18-24).
