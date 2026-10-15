import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { dirExists, walkFiles } from '../fs-utils';
import {
  DEFAULT_EXTRACTION_CONTEXT,
  errorsIn,
  collectIfBlocks,
  variantKey,
  type ExtractionContext,
  type RuntimeErrorVariant,
} from './extraction';
import { IMPORT_SPEC, THIS_CALL, resolveRelativeModule } from './patterns';
import { bodyOpen, matchBrace, matchParen, splitTopLevel } from './text-utils';

/**
 * OPTIONAL, opt-in: documents errors thrown by a gRPC handler that lives in a
 * *sibling microservice* (a different package/process on disk), reached from a
 * gateway endpoint's client call. All the conventions below are configurable;
 * nothing runs unless `crossService` is passed in the options.
 */
export interface CrossServiceOptions {
  /** Directory of a sibling service's `src` given the name captured by `targetCallPattern`. Default: `<cwd>/../<name>/src`. */
  resolveServiceRoot?: (serviceName: string) => string | undefined;
  /** Source roots of the shared package (proto-derived `*_SERVICE_NAME` constants, CRUD factory, base classes). */
  sharedSourceRoots?: string[];
  /** RegExp with 2 capture groups: (service dir name, gRPC service key). Default matches `getClient(..., 'svc', 'Key')` / `super(..., 'svc', 'Key')`. */
  targetCallPattern?: RegExp;
  /** RegExp with 1-2 capture groups naming the called RPC method. Default matches `client.Method.bind(` / `client.Method(`. */
  rpcCallPattern?: RegExp;
  /** Decorator that registers a handler, e.g. `GrpcMethod` (default). */
  handlerDecorator?: string;
  /** Name of a generic CRUD controller factory function (optional). */
  crudControllerFactory?: string;
  crudControllerClass?: string;
  crudVerbs?: [string, string][];
  extraction?: ExtractionContext;
}

// `getClient('acme.auth', 'acme-service', 'AuthService')`
// (handwritten gateway services) or `super(grpcClientFactory,
// 'acme.share_link', 'recording-service', 'ShareLinksService')`
// (BaseGrpcCrudGatewayService subclasses) — both end in the same two
// literal identifiers: the Consul service name to register/discover under,
// and the gRPC service key `@GrpcMethod(key, ...)` is declared with on the
// OTHER side. Only the trailing two matter here; the leading package-name
// arg is skipped.
export const DEFAULT_GRPC_TARGET_CALL =
  /(?:getClient|super)\s*\(\s*[^()]*?['"][^'"]*['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g;
// `client.Register.bind(client)` / `client.Charge.bind(client)` — the
// PascalCase name IS the RPC method (proto/Nest convention), captured only
// off the `.bind(` shape actually used everywhere in this project's gRPC
// call sites (narrow on purpose — this only needs to be right, not to
// catch every conceivable call style).
// Two calling conventions coexist in this project: `client.X.bind(client)`
// (passed into a `toPromise`/`callGrpcMethod` helper) and a raw node-style
// callback `client.X({...}, (err, res) => ...)` written straight inline
// (see recording_folder.service.ts's getBreadcrumb/moveFolder/
// toggleFavorite). Both name the RPC method as a PascalCase property
// access directly off the local `client` — that's the only thing narrowed
// on, same as the .bind( form.
export const DEFAULT_GRPC_RPC_CALL = /\.\s*([A-Z][A-Za-z0-9]*)\s*\.\s*bind\s*\(|\bclient\s*\.\s*([A-Z][A-Za-z0-9]*)\s*\(/g;


// Statically scans a SIBLING microservice's own TypeScript source (a
// different package, a different process — never a live object this
// process can introspect) for the real `@GrpcMethod(serviceKey, rpcMethod)`
// handler a gateway endpoint's gRPC call actually reaches, and walks its
// closure the same way RuntimeErrorScanner walks a live one, just
// text-only: same `new *Exception(...)` extraction, one hop into
// constructor-injected collaborators resolved via the handler file's own
// imports. This is the only way to document errors that are real (they're
// sitting right there in the other service's code) but structurally
// unreachable from api-gateway's process memory.
export class CrossServiceScanner {
  private readonly targetCall: RegExp;
  private readonly rpcCall: RegExp;
  private readonly handlerDecorator: RegExp;
  private readonly factoryCall: RegExp | undefined;
  private readonly crudVerbs: [string, string][];
  private readonly ctx: ExtractionContext;

  constructor(private readonly options: CrossServiceOptions = {}) {
    this.targetCall = new RegExp((options.targetCallPattern ?? DEFAULT_GRPC_TARGET_CALL).source, 'g');
    this.rpcCall = new RegExp((options.rpcCallPattern ?? DEFAULT_GRPC_RPC_CALL).source, 'g');
    const decorator = options.handlerDecorator ?? 'GrpcMethod';
    this.handlerDecorator = new RegExp(
      `@${decorator}\\(\\s*(?:['"]([^'"]+)['"]|([A-Za-z_$][\\w$]*))\\s*,\\s*['"]([^'"]+)['"]\\s*\\)`,
      'g',
    );
    this.factoryCall = options.crudControllerFactory
      ? new RegExp(`${options.crudControllerFactory}\\(\\s*(['"][^'"]+['"]|[A-Za-z_$][\\w$]*)\\s*,?\\s*\\)`, 'g')
      : undefined;
    this.crudVerbs = options.crudVerbs ?? DEFAULT_CRUD_VERBS;
    this.ctx = options.extraction ?? DEFAULT_EXTRACTION_CONTEXT;
  }

  /** `getClient('pkg', 'service-dir', 'ServiceKey')` style call -> the two trailing literals. */
  detectTarget(src: string): { consulService: string; serviceKey: string } | undefined {
    this.targetCall.lastIndex = 0;
    const match = this.targetCall.exec(src);
    if (!match) return undefined;
    return { consulService: match[1], serviceKey: match[2] };
  }

  /** `client.Method.bind(...)` / `client.Method(...)` -> the RPC method name. */
  detectRpcMethod(src: string): string | undefined {
    this.rpcCall.lastIndex = 0;
    const match = this.rpcCall.exec(src);
    return match?.[1] ?? match?.[2];
  }

  private readonly fileTextCache = new Map<string, string | undefined>();
  // consulServiceName -> absolute src dir, resolved once.
  private readonly serviceRootCache = new Map<string, string | undefined>();
  // `${consulService}::${serviceKey}::${rpcMethod}` -> handler location.
  private readonly handlerCache = new Map<string, GrpcHandlerLocation | undefined>();
  // consulServiceName -> every @GrpcMethod('key','method') site found,
  // built once per service by a single directory walk.
  private readonly handlerIndexCache = new Map<string, Map<string, GrpcHandlerLocation>>();
  // SCREAMING_SNAKE_CASE `export const NAME = 'value'` constants across the
  // whole the shared package source tree (proto-derived service-name
  // constants like `AUDIT_LOGS_SERVICE_NAME` live there, imported bare —
  // `@GrpcMethod(AUDIT_LOGS_SERVICE_NAME, 'Create')` — instead of as a
  // string literal). Built once, lazily.
  private sharedConstIndex: Map<string, { value: string; file: string }[]> | undefined;
  // `export function NAME(...)` across the shared package, for locating the
  // generic CRUD controller factory (see FACTORY_CALL below).
  private sharedFnIndex: Map<string, string> | undefined;
  // `export class NAME` across the shared package — the fallback for
  // collaborator/`extends` types imported via a DEEP subpath specifier
  // (`the shared package/dist/crud/mongo-base-crud.service`, seen all over
  // the Mongo-backed services) rather than the relative-only import
  // resolution `resolveTypeImport` otherwise does.
  private sharedClassIndex: Map<string, string> | undefined;

  scanRpcCall(consulService: string, serviceKey: string, rpcMethod: string): RuntimeErrorVariant[] {
    const cacheKey = `${consulService}::${serviceKey}::${rpcMethod}`;
    let handler = this.handlerCache.get(cacheKey);
    if (handler === undefined && !this.handlerCache.has(cacheKey)) {
      handler = this.findHandler(consulService, serviceKey, rpcMethod);
      this.handlerCache.set(cacheKey, handler);
    }
    if (!handler) return [];
    const merged = new Map<string, RuntimeErrorVariant>();
    this.walkText(handler.file, handler.className, handler.methodName, 0, new Set(), merged);
    return Array.from(merged.values());
  }

  private findHandler(
    consulService: string,
    serviceKey: string,
    rpcMethod: string,
  ): GrpcHandlerLocation | undefined {
    let index = this.handlerIndexCache.get(consulService);
    if (!index) {
      index = this.buildHandlerIndex(consulService);
      this.handlerIndexCache.set(consulService, index);
    }
    return index.get(`${serviceKey}::${rpcMethod}`);
  }

  // One recursive directory walk over the sibling service's `src/`,
  // regexing every `@GrpcMethod(Key, 'Method')` decorator site (key
  // literal OR identifier resolved via resolveConst) and the class +
  // method it decorates, PLUS every generic `createGrpcCrudController(Key)`
  // factory-controller assignment (see FACTORY_CALL) — a subclass of it
  // inherits Create/FindAll/FindOne/Update/Delete without redeclaring the
  // decorator anywhere in the subclass's own source (see
  // grpc-crud-controller.factory.ts), so those 5 verbs are registered
  // straight at the factory's own generated class. Built once per service,
  // then cached; direct decorator sites always win over the generic
  // fallback where both exist for the same key+verb.
  private buildHandlerIndex(consulService: string): Map<string, GrpcHandlerLocation> {
    const out = new Map<string, GrpcHandlerLocation>();
    const root = this.serviceRoot(consulService);
    if (!root) return out;
    const factoryFallback = new Map<string, GrpcHandlerLocation>();
    for (const file of walkTsFiles(root)) {
      const text = this.fileText(file);
      if (!text) continue;
      if (text.includes('@')) {
        this.handlerDecorator.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = this.handlerDecorator.exec(text)) !== null) {
          const key = match[1] ?? this.resolveConst(text, file, match[2]);
          const method = match[3];
          if (!key) continue;
          const className = nearestClassName(text, match.index);
          if (!className) continue;
          const methodName = nearestMethodName(text, match.index + match[0].length);
          if (!methodName) continue;
          out.set(`${key}::${method}`, { file, className, methodName });
        }
      }
      if (this.factoryCall && text.includes(this.options.crudControllerFactory as string)) {
        this.factoryCall.lastIndex = 0;
        let fmatch: RegExpExecArray | null;
        while ((fmatch = this.factoryCall.exec(text)) !== null) {
          const rawKey = fmatch[1];
          const key =
            rawKey.startsWith("'") || rawKey.startsWith('"')
              ? rawKey.slice(1, -1)
              : this.resolveConst(text, file, rawKey);
          if (!key) continue;
          const factoryFile = this.sharedFunctionFile(this.options.crudControllerFactory as string);
          if (!factoryFile) continue;
          for (const [verb, methodName] of this.crudVerbs) {
            factoryFallback.set(`${key}::${verb}`, {
              file: factoryFile,
              className: this.options.crudControllerClass ?? 'GrpcCrudController',
              methodName,
            });
          }
        }
      }
    }
    for (const [key, loc] of factoryFallback) {
      if (!out.has(key)) out.set(key, loc);
    }
    return out;
  }

  // Resolves a bare `IDENT` used as a @GrpcMethod/factory arg to its
  // literal string value: first a same-file `const IDENT = '...'`
  // declaration, then the shared package's own constants (the common case
  // — proto-derived `*_SERVICE_NAME` constants live in the shared package
  // and are imported bare into every service that registers that gRPC
  // service).
  private resolveConst(fileText: string, file: string, ident: string): string | undefined {
    const local = new RegExp(`\\bconst\\s+${ident}\\s*=\\s*['"]([^'"]+)['"]`).exec(fileText);
    if (local) return local[1];
    void file;
    return this.sharedConst(ident);
  }

  // `the shared package` genuinely re-declares the same const name in more
  // than one file (e.g. `PRODUCTS_SERVICE_NAME` exists in BOTH
  // product.constants.ts = 'ProductsService' AND notification.constants.ts
  // = 'NotificationService' — a real duplicate-export bug upstream, not a
  // scanner artifact). A flat last-write-wins map silently picks the wrong
  // one, so every candidate is kept and disambiguated by matching the
  // declaring file's basename against the identifier's own stem.
  private sharedConst(name: string): string | undefined {
    if (!this.sharedConstIndex) this.sharedConstIndex = this.buildSharedIndex().consts;
    const candidates = this.sharedConstIndex.get(name);
    if (!candidates || candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0].value;
    const stem = name.replace(/_SERVICE_NAME$/, '').replace(/_/g, '').toLowerCase();
    const match = candidates.find((c) => {
      const base = c.file.split(/[\\/]/).pop()?.replace(/\.constants\.ts$/, '').replace(/[._-]/g, '').toLowerCase() ?? '';
      return base && (stem.includes(base) || base.includes(stem));
    });
    return (match ?? candidates[0]).value;
  }

  private sharedFunctionFile(name: string): string | undefined {
    if (!this.sharedFnIndex) this.sharedFnIndex = this.buildSharedIndex().fns;
    return this.sharedFnIndex.get(name);
  }

  private sharedClassFile(name: string): string | undefined {
    if (!this.sharedClassIndex) {
      const index = new Map<string, string>();
      for (const root of this.sharedRoots()) {
        for (const file of walkTsFiles(root)) {
          const text = this.fileText(file);
          if (!text || !text.includes('class ')) continue;
          CLASS_DECL.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = CLASS_DECL.exec(text)) !== null) {
            if (!index.has(m[1])) index.set(m[1], file);
          }
        }
      }
      this.sharedClassIndex = index;
    }
    return this.sharedClassIndex.get(name);
  }

  // One walk over the shared package's OWN TypeScript source (a sibling
  // package right next to every microservice , including
  // api-gateway itself) — builds both indexes together since it's the
  // same directory walk either way. Lazy + cached: only paid for once,
  // and only when a sibling service's @GrpcMethod/factory call actually
  // needs it resolved.
  private buildSharedIndex(): { consts: Map<string, { value: string; file: string }[]>; fns: Map<string, string> } {
    const consts = new Map<string, { value: string; file: string }[]>();
    const fns = new Map<string, string>();
    for (const root of this.sharedRoots()) {
      for (const file of walkTsFiles(root)) {
        const text = this.fileText(file);
        if (!text) continue;
        SHARED_CONST_DECL.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = SHARED_CONST_DECL.exec(text)) !== null) {
          const list = consts.get(m[1]) ?? [];
          list.push({ value: m[2], file });
          consts.set(m[1], list);
        }
        SHARED_FN_DECL.lastIndex = 0;
        while ((m = SHARED_FN_DECL.exec(text)) !== null) {
          if (!fns.has(m[1])) fns.set(m[1], file);
        }
      }
    }
    return { consts, fns };
  }

  private sharedRoots(): string[] {
    return (this.options.sharedSourceRoots ?? []).filter((r) => dirExists(r));
  }

  private serviceRoot(consulService: string): string | undefined {
    if (this.serviceRootCache.has(consulService)) return this.serviceRootCache.get(consulService);
    const candidate = this.options.resolveServiceRoot
      ? this.options.resolveServiceRoot(consulService)
      : resolvePath(process.cwd(), '..', consulService, 'src');
    const root = candidate && dirExists(candidate) ? candidate : undefined;
    this.serviceRootCache.set(consulService, root);
    return root;
  }

  private fileText(file: string): string | undefined {
    if (!this.fileTextCache.has(file)) {
      try {
        this.fileTextCache.set(file, readFileSync(file, 'utf8'));
      } catch {
        this.fileTextCache.set(file, undefined);
      }
    }
    return this.fileTextCache.get(file);
  }

  // Bounded text-only closure walk: current method's body, then ONE class
  // of collaborator per hop — constructor-injected properties resolved via
  // the file's own `import { Type } from './x'` statements (same-file
  // declarations included). Depth-capped; a sibling service's real closure
  // is rarely deep (handler -> one orchestration/domain service is the
  // overwhelming majority shape actually seen in this project).
  private walkText(
    file: string,
    className: string,
    methodName: string,
    depth: number,
    seen: Set<string>,
    merged: Map<string, RuntimeErrorVariant>,
  ): void {
    const key = `${file}::${className}.${methodName}`;
    if (seen.has(key) || depth > CROSS_SERVICE_MAX_DEPTH || seen.size > CROSS_SERVICE_MAX_NODES) return;
    seen.add(key);

    const text = this.fileText(file);
    if (!text) return;
    const cls = extractClass(text, className);
    if (!cls) return;

    // The method isn't necessarily declared on `className` itself — a thin
    // generated/hand-written subclass very often inherits its real work
    // from a parent (MongoBaseCrudService, BaseCrudService, etc.) without
    // redeclaring anything. Climb `extends` (same-file first, else a
    // relative import) until the method is actually found; the class it's
    // found ON owns the method body AND is the right scope for that body's
    // own `this.*` property types (its own constructor params, not the
    // originally-requested subclass's).
    let definingFile = file;
    let definingText = text;
    let definingClassName = className;
    let definingCls = cls;
    let body = extractMethodBody(definingCls.body, methodName);
    let hops = 0;
    while (body === undefined && definingCls.extendsName && hops < 6) {
      hops++;
      const parentName = definingCls.extendsName;
      const parentFile = extractClass(definingText, parentName)
        ? definingFile
        : (this.resolveTypeImport(definingText, definingFile, parentName) ?? this.sharedClassFile(parentName));
      if (!parentFile) break;
      const parentText = this.fileText(parentFile);
      if (!parentText) break;
      const parentCls = extractClass(parentText, parentName);
      if (!parentCls) break;
      definingFile = parentFile;
      definingText = parentText;
      definingClassName = parentName;
      definingCls = parentCls;
      body = extractMethodBody(definingCls.body, methodName);
    }
    if (!body) return;

    const { ifBlocks, catchSpans } = collectIfBlocks(body);
    for (const variant of errorsIn(body, ifBlocks, catchSpans, definingText, this.ctx)) {
      const vKey = variantKey(variant);
      if (!merged.has(vKey)) merged.set(vKey, variant);
    }

    // `this.<method>(...)` — a same-class private helper (the extremely
    // common `findXOrThrow`/`assertY` pattern that holds the REAL throws
    // behind a thin @GrpcMethod handler). No provenance gate needed: it's
    // the same class body already in hand, just recurse straight into it.
    THIS_CALL.lastIndex = 0;
    let call: RegExpExecArray | null;
    const props = new Set<string>();
    const sameClassMethods = new Set<string>();
    while ((call = THIS_CALL.exec(body)) !== null) {
      if (call[2] !== undefined) {
        props.add(call[1]);
      } else if (call[1] !== methodName && extractMethodBody(definingCls.body, call[1]) !== undefined) {
        sameClassMethods.add(call[1]);
      }
    }
    for (const m of sameClassMethods) {
      this.walkText(definingFile, definingClassName, m, depth + 1, seen, merged);
    }
    if (props.size === 0) return;
    const ctorParams = definingCls.ctorParams;
    for (const prop of props) {
      const typeName = ctorParams.get(prop);
      if (!typeName) continue;
      const targetFile = extractClass(definingText, typeName)
        ? definingFile
        : (this.resolveTypeImport(definingText, definingFile, typeName) ?? this.sharedClassFile(typeName));
      if (!targetFile) continue;
      const targetText = this.fileText(targetFile);
      if (!targetText) continue;
      const targetClass = extractClass(targetText, typeName);
      if (!targetClass) continue;
      THIS_CALL.lastIndex = 0;
      let m2: RegExpExecArray | null;
      const calledOnProp = new Set<string>();
      const propCallRe = new RegExp(`\\b${prop}\\??\\.([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
      while ((m2 = propCallRe.exec(body)) !== null) calledOnProp.add(m2[1]);
      for (const calleeMethod of calledOnProp) {
        this.walkText(targetFile, typeName, calleeMethod, depth + 1, seen, merged);
      }
    }
  }

  private resolveTypeImport(fileText: string, fromFile: string, typeName: string): string | undefined {
    IMPORT_SPEC.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_SPEC.exec(fileText)) !== null) {
      const names = (match[1] ?? match[2] ?? '').split(',').map((n) => n.trim());
      if (!names.includes(typeName)) continue;
      return resolveRelativeModule(fromFile, match[3]);
    }
    return undefined;
  }
}

interface GrpcHandlerLocation {
  file: string;
  className: string;
  methodName: string;
}

const CROSS_SERVICE_MAX_DEPTH = 6;
const CROSS_SERVICE_MAX_NODES = 120;
// First arg is a literal (group 1) OR a bare identifier (group 2) — the
// proto-derived `*_SERVICE_NAME` constants used almost everywhere in this
// codebase's real gRPC controllers are the identifier case (see
// resolveConst). The method name (group 3) is always a literal in every
// site actually seen here.
const DEFAULT_CRUD_VERBS: [string, string][] = [
  ['Create', 'create'],
  ['FindAll', 'findAll'],
  ['FindOne', 'findOne'],
  ['Update', 'update'],
  ['Delete', 'remove'],
];
// `export const NAME = 'value'` in the shared package — restricted to
// SCREAMING_SNAKE_CASE so this never picks up an unrelated lowercase/camel
// constant by accident.
const SHARED_CONST_DECL = /export\s+const\s+([A-Z][A-Z0-9_]*)\s*=\s*['"]([^'"]+)['"]/g;
const SHARED_FN_DECL = /export\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g;
const CLASS_DECL = /\bclass\s+([A-Za-z_$][\w$]*)/g;

// Recursively lists every `.ts` file under `root` (skipping `.spec.ts`,
// `.d.ts`, and node_modules should any ever appear under a src/ tree).
function walkTsFiles(root: string): string[] {
  return walkFiles(root, {
    filter: (_full, name) => name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts'),
  });
}

// Nearest `class Name` declaration at or before `pos` — attributes a
// decorator site to its enclosing class.
function nearestClassName(text: string, pos: number): string | undefined {
  CLASS_DECL.lastIndex = 0;
  let best: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = CLASS_DECL.exec(text)) !== null) {
    if (match.index > pos) break;
    best = match[1];
  }
  return best;
}

// The method name immediately declared after a decorator: skips past any
// further decorator lines (`@UsePipes(...)` etc.) and modifiers
// (async/public/private) to the first `name(` that starts a method.
function nearestMethodName(text: string, from: number): string | undefined {
  const METHOD_START = /(?:^|\n)\s*(?:@[\w.]+\([^)]*\)\s*\n\s*|\/\/[^\n]*\n\s*)*(?:public\s+|private\s+|protected\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\(/g;
  METHOD_START.lastIndex = from;
  const match = METHOD_START.exec(text);
  return match?.[1];
}

// Extracts one class's body text + its constructor's paramName->TypeName
// map, from raw TypeScript source (no compilation — used only for sibling
// services this scanner never loads as live objects).
// First `{` after a `class Name` header that is NOT nested inside the
// header's own `<...>` generic params / object-literal type constraints
// (e.g. `class X<T extends { id: string }>`) or `(...)`/`[...]` — those
// must not be mistaken for the class body's opening brace.
function classBodyOpen(text: string, from: number): number {
  let angle = 0;
  let paren = 0;
  let bracket = 0;
  let cursor = from;
  while (cursor < text.length) {
    const c = text[cursor];
    if (c === '<') angle++;
    else if (c === '>') angle = Math.max(0, angle - 1);
    else if (c === '(') paren++;
    else if (c === ')') paren = Math.max(0, paren - 1);
    else if (c === '[') bracket++;
    else if (c === ']') bracket = Math.max(0, bracket - 1);
    else if (c === '{' && angle === 0 && paren === 0 && bracket === 0) return cursor;
    cursor++;
  }
  return -1;
}

function extractClass(
  text: string,
  className: string,
): { body: string; ctorParams: Map<string, string>; extendsName?: string } | undefined {
  const decl = new RegExp(`\\bclass\\s+${className}\\b`);
  const match = decl.exec(text);
  if (!match) return undefined;
  // The class header (generic params, `extends`, `implements`) can embed
  // its own `{`/`}` (e.g. `class X<T extends { id: string }>`), so a plain
  // "first `{`" scan picks the WRONG brace — track bracket depth instead.
  const openIdx = classBodyOpen(text, match.index + match[0].length);
  if (openIdx < 0) return undefined;
  const closeIdx = matchBrace(text, openIdx);
  if (closeIdx < 0) return undefined;
  const body = text.slice(openIdx, closeIdx + 1);
  const header = text.slice(match.index + match[0].length, openIdx);
  // The FIRST `extends X` after any generic `<...>` block is the real base
  // class (a generic constraint inside `<T extends {...}>` is skipped since
  // it's followed by `{`/`}` chars, not an identifier directly usable as a
  // class name — the real `extends BaseFoo` always comes right before the
  // opening brace once generics are stripped).
  const extendsMatch = /\bextends\s+([A-Za-z_$][\w$]*)/.exec(header.replace(/<[^>]*>/g, ''));
  const extendsName = extendsMatch?.[1];

  const ctorParams = new Map<string, string>();
  const ctorMatch = /constructor\s*\(/.exec(body);
  if (ctorMatch) {
    const parenOpen = ctorMatch.index + ctorMatch[0].length - 1;
    const parenClose = matchParen(body, parenOpen);
    if (parenClose > parenOpen) {
      for (const param of splitTopLevel(body.slice(parenOpen + 1, parenClose))) {
        const cleaned = param
          .replace(/^\s*(public|private|protected|readonly)\s+/, '')
          .replace(/^\s*(public|private|protected|readonly)\s+/, '')
          .trim();
        const colonIdx = cleaned.indexOf(':');
        if (colonIdx < 0) continue;
        const name = cleaned.slice(0, colonIdx).trim();
        // A union type (`BaseCrudService<T> | MongoBaseCrudService<T>`,
        // often wrapped with a LEADING `|` on its own line) only needs its
        // first member here — good enough to find ONE real collaborator
        // class; strip the leading pipe before taking the first token.
        const type = cleaned
          .slice(colonIdx + 1)
          .trim()
          .replace(/^\|\s*/, '')
          .split(/[<\s|]/)[0];
        if (/^[A-Za-z_$][\w$]*$/.test(name) && /^[A-Za-z_$][\w$]*$/.test(type)) {
          ctorParams.set(name, type);
        }
      }
    }
  }
  return { body, ctorParams, extendsName };
}

// One method's body text within an already-extracted class body.
function extractMethodBody(classBody: string, methodName: string): string | undefined {
  const re = new RegExp(`(?:^|\\n)\\s*(?:@[\\w.]+\\([^)]*\\)\\s*\\n\\s*|\\/\\/[^\\n]*\\n\\s*)*(?:public\\s+|private\\s+|protected\\s+|async\\s+)*${methodName}\\s*\\(`);
  const match = re.exec(classBody);
  if (!match) return undefined;
  const parenOpen = match.index + match[0].length - 1;
  const parenClose = matchParen(classBody, parenOpen);
  if (parenClose < 0) return undefined;
  const openBrace = bodyOpen(classBody, parenClose + 1);
  if (openBrace < 0) return undefined;
  const closeBrace = matchBrace(classBody, openBrace);
  if (closeBrace < 0) return undefined;
  return classBody.slice(openBrace, closeBrace + 1);
}