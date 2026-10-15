import { readFileSync, realpathSync } from 'node:fs';
import { isInNodeModules, toPosix } from '../fs-utils';
import {
  DEFAULT_EXTRACTION_CONTEXT,
  collectIfBlocks,
  innermostCondition,
  type IfBlock,
  errorsIn,
  hasDynamicStatusResponse,
  variantKey,
  type ExtractionContext,
  type RuntimeErrorVariant,
} from './extraction';
import type { CrossServiceScanner } from './cross-service';
import { ModuleIndex } from './module-index';
import { IMPORT_SPEC, NAMESPACE_REQUIRE, THIS_CALL, resolveRelativeModule } from './patterns';
import { bodyOpen, matchBrace, matchParen, splitTopLevel, statementEnd } from './text-utils';
import { bindLiterals, evaluateCondition } from '../descriptions/error-reachability';

export type { RuntimeErrorVariant } from './extraction';

// Real endpoint closures route through DI chains many services deep
// (controller -> service -> shared base class -> client factory -> per-file
// error mapper -> nested mapper helpers), each hop potentially fanning out
// into several further `this.*`/module-fn calls. These caps exist only to
// stop runaway/cyclic graphs — kept generous so real closures are never
// truncated before every reachable throw is found.
const DEFAULT_MAX_DEPTH = 40;
const DEFAULT_MAX_METHODS = 600;

interface Callee {
  // `this.foo()` -> { prop: undefined, method: 'foo' }
  // `this.svc.go()` -> { prop: 'svc', method: 'go' }
  prop: string | undefined;
  method: string;
  /** Call-site argument texts (trimmed), for literal narrowing. */
  args: string[];
  /** Innermost `if` condition the call sits in. */
  guard?: string;
}

// Bare `name(` calls — anything that is not a method call (`x.name(`),
// a `new` expression, or a language keyword. Resolved against module-scope
// functions of the SAME file (or a relative import of it).
const BARE_CALL = /(^|[^\w$.?'"`])\b([A-Za-z_$][\w$]*)\s*\(/g;
// `400: 'BAD_REQUEST'` / `404: SomeEnum.X` style table rows — a generic,
// recognizable "status code table" shape (numeric HTTP status literal as an
// object key). Restricted to the valid HTTP status range.
const STATUS_TABLE_ENTRY = /(?:^|[{,])\s*(\d{3})\s*:/g;
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new',
  'delete', 'void', 'await', 'yield', 'else', 'do', 'try', 'finally',
  'in', 'of', 'instanceof', 'import', 'super', 'this', 'function',
  'class', 'extends', 'case', 'default', 'break', 'continue', 'throw',
  'with', 'debugger', 'require',
]);

export interface RuntimeErrorScannerOptions {
  extraction?: ExtractionContext;
  /**
   * npm packages that are physically installed under node_modules but must be
   * treated as first-party code (e.g. your published `@acme/shared` that holds
   * the gRPC client factory / base services). Without this, only workspace
   * symlinks are considered first-party.
   */
  includePackages?: string[];
  /**
   * Resolves `this.<prop>` when the property is not present on the instance —
   * typical for REQUEST/TRANSIENT scoped providers, which Nest exposes as a
   * bare prototype-only object (constructor never ran on it).
   */
  resolveInjected?: (ctor: Function, prop: string) => object | undefined;
  /** Full override of the "is this first-party code" decision. Return undefined to fall back to the default rule. */
  isAppCode?: (ctor: Function, file: string | undefined) => boolean | undefined;
  crossService?: CrossServiceScanner;
  maxDepth?: number;
  maxMethods?: number;
  /** Share one runtime module index with the rest of the pipeline. */
  moduleIndex?: ModuleIndex;
}

type QueueNode =
  | { kind: 'method'; instance: object; method: string; depth: number; args?: string[] }
  | { kind: 'fn'; file: string; fnName: string; depth: number; args?: string[] };

interface NodeAnalysis {
  variants: RuntimeErrorVariant[];
  dynamicStatus: boolean;
  grpcTarget?: { consulService: string; serviceKey: string };
  rpcMethod?: string;
  callees: Callee[];
  bare: BareCall[];
}

interface BareCall {
  name: string;
  args: string[];
  guard?: string;
}

/**
 * One distinct throwable error discovered at RUNTIME from a live object's
 * method source. The scanner works on the compiled JS via
 * `Function.prototype.toString`, so it runs identically on any NestJS project
 * (dist JS, ts-node, swc) with zero project-specific knowledge.
 *
 * What is captured per `new XxxException(...)` call site:
 *  - status: from the Nest exception class name (framework-wide table), from
 *    a custom exception class that extends one (see `exceptionStatus`), or
 *    from HttpException's 2nd constructor arg (numeric literal or HttpStatus.X).
 *  - message: the 1st constructor arg WHEN it is a static string/template.
 *  - schema: when the 1st arg is an object literal, its keys become properties.
 */
export class RuntimeErrorScanner {
  private readonly ctx: ExtractionContext;
  private readonly maxDepth: number;
  private readonly maxMethods: number;
  // filename per class constructor, resolved once.
  private readonly fileCache = new Map<Function, string | undefined>();
  // module-scope functions per loaded file: file -> (name -> body source).
  private readonly moduleFnCache = new Map<string, Map<string, string> | undefined>();
  private readonly fileTextCache = new Map<string, string | undefined>();
  private readonly realFileCache = new Map<string, boolean>();
  private readonly importCache = new Map<string, Map<string, string>>();
  private readonly statusTableCache = new Map<string, number[]>();
  // Per-node analysis (regex passes over a method body) is independent of
  // which endpoint reached it — compute once, reuse across the whole app.
  private readonly analysisCache = new Map<string, NodeAnalysis>();
  private readonly moduleIndex: ModuleIndex;

  constructor(private readonly options: RuntimeErrorScannerOptions = {}) {
    this.ctx = options.extraction ?? DEFAULT_EXTRACTION_CONTEXT;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxMethods = options.maxMethods ?? DEFAULT_MAX_METHODS;
    this.moduleIndex = options.moduleIndex ?? new ModuleIndex();
  }

  // Full closure for one endpoint: the controller method plus every
  // reachable `this.*` method (injected services first of all).
  scanEndpoint(rootInstance: object, methodName: string): RuntimeErrorVariant[] {
    return this.walk(rootInstance, methodName);
  }

  // Single method on any live object — guards (canActivate), exception
  // filters (catch), interceptors (intercept), pipes (transform).
  scanMethod(instance: object, methodName: string): RuntimeErrorVariant[] {
    return this.walk(instance, methodName);
  }

  private walk(rootInstance: object, rootMethod: string): RuntimeErrorVariant[] {
    const merged = new Map<string, RuntimeErrorVariant>();
    const seen = new Set<string>();
    const visitedFiles = new Set<string>();
    let dynamicStatusSeen = false;
    // The gRPC target this closure's own gateway-side code calls out to —
    // opportunistically filled in as visited nodes reveal it, never guessed.
    let grpcConsulService: string | undefined;
    let grpcServiceKey: string | undefined;
    let grpcRpcMethod: string | undefined;
    const cross = this.options.crossService;
    const constructorsChecked = new Set<Function>();
    const queue: QueueNode[] = [{ kind: 'method', instance: rootInstance, method: rootMethod, depth: 0 }];
    let visited = 0;
    let head = 0;

    while (head < queue.length && visited < this.maxMethods) {
      const current = queue[head++];
      const resolved = this.resolveSource(current);
      if (!resolved) continue;
      // Literal call-site arguments bind the callee's parameters: the same
      // helper reached with two different literals is two visits, and a throw
      // guarded by a condition those literals make false is not reachable.
      const params = current.kind === 'fn' ? this.moduleFnParams(current.file, current.fnName) : paramNamesOfSource(resolved.src);
      const bound = new Map(bindLiterals(params, current.args));
      for (const name of [...bound.keys()]) if (isReassigned(resolved.src, name)) bound.delete(name);
      const visitKey = bound.size ? `${resolved.key}|${JSON.stringify([...bound])}` : resolved.key;
      if (seen.has(visitKey)) continue;
      seen.add(visitKey);
      visited++;

      const nodeFile = current.kind === 'method' ? this.fileOf(current.instance) : current.file;
      const analysis = this.analyze(resolved.key, resolved.src, nodeFile, current.kind === 'method');
      for (const variant of analysis.variants) {
        if (bound.size && variant.when && evaluateCondition(variant.when, bound) === false) continue;
        const key = variantKey(variant);
        // Copy: analyses are cached across endpoints, but depth is per walk.
        if (!merged.has(key)) merged.set(key, { ...variant, depth: current.depth });
      }
      if (analysis.dynamicStatus) dynamicStatusSeen = true;

      if (cross) {
        if (analysis.grpcTarget) {
          grpcConsulService = analysis.grpcTarget.consulService;
          grpcServiceKey = analysis.grpcTarget.serviceKey;
        }
        if (analysis.rpcMethod) grpcRpcMethod = analysis.rpcMethod;
        if (current.kind === 'method') {
          const ctor = (current.instance as { constructor?: Function }).constructor;
          if (ctor && !constructorsChecked.has(ctor)) {
            constructorsChecked.add(ctor);
            try {
              const ctorTarget = cross.detectTarget(Function.prototype.toString.call(ctor));
              if (ctorTarget) {
                grpcConsulService = ctorTarget.consulService;
                grpcServiceKey = ctorTarget.serviceKey;
              }
            } catch {
              // best-effort only.
            }
          }
        }
      }

      if (nodeFile) visitedFiles.add(nodeFile);
      if (current.depth + 1 > this.maxDepth) continue;

      for (const callee of analysis.callees) {
        if (callee.guard && bound.size && evaluateCondition(callee.guard, bound) === false) continue;
        if (callee.prop === undefined) {
          // Same object (`this.foo()`) — no new trust domain is crossed,
          // so no provenance gate applies. Module-function bodies have no
          // `this` receiver, so only method nodes take this branch.
          if (current.kind !== 'method' || !methodFn(current.instance, callee.method)) continue;
          queue.push({ kind: 'method', instance: current.instance, method: callee.method, depth: current.depth + 1, args: forward(callee.args, bound) });
          continue;
        }
        // Cross-instance jump (`this.svc.go()`) — the target is admitted
        // ONLY on proven application provenance (fail-closed). This is the
        // boundary that keeps framework internals (whose injector throws
        // once leaked into every endpoint's 500s) out of the docs.
        if (current.kind !== 'method') continue;
        const target = this.readInjected(current.instance, callee.prop);
        if (!target) continue;
        if (!this.isAppCode(target)) continue;
        if (!methodFn(target, callee.method)) continue;
        queue.push({ kind: 'method', instance: target, method: callee.method, depth: current.depth + 1, args: forward(callee.args, bound) });
      }

      // Bare `throwFromX(err)` style calls: same-file module-scope functions
      // first (the standard Nest pattern for shared error mapping); when a
      // name isn't declared in the current file, follow a RELATIVE import
      // into its actual source file. Never follows a bare package
      // specifier (that stays behind the isAppCode/DI provenance gate).
      if (nodeFile) {
        for (const { name, args, guard } of analysis.bare) {
          if (guard && bound.size && evaluateCondition(guard, bound) === false) continue;
          if (this.moduleFnBody(nodeFile, name) !== undefined) {
            queue.push({ kind: 'fn', file: nodeFile, fnName: name, depth: current.depth + 1, args: forward(args, bound) });
            continue;
          }
          const resolvedImport = this.importsOf(nodeFile).get(name);
          if (!resolvedImport) continue;
          if (!this.isAppFile(resolvedImport)) continue;
          if (this.moduleFnBody(resolvedImport, name) === undefined) continue;
          queue.push({ kind: 'fn', file: resolvedImport, fnName: name, depth: current.depth + 1, args: forward(args, bound) });
        }
      }
    }

    if (dynamicStatusSeen) {
      for (const status of this.reachableStatusTable(visitedFiles)) {
        const variant: RuntimeErrorVariant = { status };
        const key = variantKey(variant);
        if (!merged.has(key)) merged.set(key, variant);
      }
    }

    // If this closure's real work is a gRPC call, the real errors live in the
    // OTHER service's source (a sibling package on disk, never a live object
    // in THIS process). Only fires when both the target and the specific RPC
    // method were actually seen in the closure — never guessed.
    if (cross && grpcConsulService && grpcServiceKey && grpcRpcMethod) {
      for (const variant of cross.scanRpcCall(grpcConsulService, grpcServiceKey, grpcRpcMethod)) {
        const key = variantKey(variant);
        if (!merged.has(key)) merged.set(key, variant);
      }
    }

    return Array.from(merged.values());
  }

  private analyze(key: string, src: string, nodeFile: string | undefined, isMethod: boolean): NodeAnalysis {
    const cacheKey = `${nodeFile ?? ''}::${key}`;
    const hit = this.analysisCache.get(cacheKey);
    if (hit) return hit;
    const { ifBlocks, catchSpans } = collectIfBlocks(src);
    const cross = this.options.crossService;
    const analysis: NodeAnalysis = {
      variants: errorsIn(src, ifBlocks, catchSpans, nodeFile ? this.fileText(nodeFile) : undefined, this.ctx),
      dynamicStatus: hasDynamicStatusResponse(src, catchSpans),
      grpcTarget: cross?.detectTarget(src),
      rpcMethod: cross?.detectRpcMethod(src),
      callees: calledMethods(src, ifBlocks),
      bare: bareCalls(src, shadowedNames(src, isMethod), ifBlocks),
    };
    this.analysisCache.set(cacheKey, analysis);
    return analysis;
  }

  // Every distinct HTTP-status-shaped literal found in the files actually
  // visited by this walk, plus one hop through each visited file's own
  // relative imports — bounded, source-backed, never a guess: only fires when
  // the walk also saw a dynamically-computed `.status(x).json(...)` write.
  private reachableStatusTable(visitedFiles: Set<string>): number[] {
    const files = new Set(visitedFiles);
    for (const file of visitedFiles) {
      for (const target of this.importsOf(file).values()) files.add(target);
    }
    const statuses = new Set<number>();
    for (const file of files) {
      for (const status of this.statusTableOf(file)) statuses.add(status);
    }
    return Array.from(statuses).sort((a, b) => a - b);
  }

  private statusTableOf(file: string): number[] {
    const cached = this.statusTableCache.get(file);
    if (cached) return cached;
    const text = this.fileText(file) ?? '';
    const out: number[] = [];
    const re = new RegExp(STATUS_TABLE_ENTRY.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const n = parseInt(match[1], 10);
      if (n >= 100 && n <= 599) out.push(n);
    }
    this.statusTableCache.set(file, out);
    return out;
  }

  private importsOf(file: string): Map<string, string> {
    const cached = this.importCache.get(file);
    if (cached) return cached;
    const out = new Map<string, string>();
    const text = this.fileText(file);
    if (text !== undefined) {
      const importRe = new RegExp(IMPORT_SPEC.source, 'g');
      let match: RegExpExecArray | null;
      while ((match = importRe.exec(text)) !== null) {
        const names = (match[1] ?? match[2] ?? '').split(',');
        const resolved = resolveRelativeModule(file, match[3]);
        if (!resolved) continue;
        for (const raw of names) {
          const parts = raw.trim().split(/\s+as\s+/);
          const local = (parts[1] ?? parts[0])?.trim();
          if (local) out.set(local, resolved);
        }
      }
      const nsRe = new RegExp(NAMESPACE_REQUIRE.source, 'g');
      while ((match = nsRe.exec(text)) !== null) {
        const resolved = resolveRelativeModule(file, match[2]);
        if (resolved) out.set(match[1], resolved);
      }
    }
    this.importCache.set(file, out);
    return out;
  }

  // Source + dedupe key for a queue node. Module-function bodies come from
  // the loaded file's text (the exact code that's executing — dist JS in
  // production, .ts under ts-node/jest).
  private resolveSource(node: QueueNode): { key: string; src: string } | undefined {
    if (node.kind === 'fn') {
      const body = this.moduleFnBody(node.file, node.fnName);
      if (body === undefined) return undefined;
      return { key: `${node.file}::fn:${node.fnName}`, src: body };
    }
    const fn = methodFn(node.instance, node.method);
    if (!fn) return undefined;
    let src: string;
    try {
      src = Function.prototype.toString.call(fn);
    } catch {
      return undefined;
    }
    if (src.includes('[native code]')) return undefined;
    // Same class name in two files must not collide -> the declaring file is part of the key.
    return { key: `${this.fileOf(node.instance) ?? ''}#${ctorName(node.instance)}.${node.method}`, src };
  }

  private fileOf(instance: object): string | undefined {
    const ctor = (instance as { constructor?: Function }).constructor;
    if (!ctor) return undefined;
    return this.fileOfCtor(ctor);
  }

  private fileOfCtor(ctor: Function): string | undefined {
    if (!this.fileCache.has(ctor)) {
      this.fileCache.set(ctor, this.moduleIndex.fileOf(ctor));
    }
    return this.fileCache.get(ctor);
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

  private moduleFnParams(file: string, name: string): string[] {
    this.moduleFnBody(file, name); // fills the cache
    const text = this.moduleFnCache.get(file)?.get(`${name}\u0000params`);
    return text === undefined ? [] : paramNames(text);
  }

  private moduleFnBody(file: string, name: string): string | undefined {
    if (!this.moduleFnCache.has(file)) {
      const text = this.fileText(file);
      this.moduleFnCache.set(file, text === undefined ? undefined : parseModuleFunctions(text));
    }
    return this.moduleFnCache.get(file)?.get(name);
  }

  // `this.<prop>` on a live instance, with a DI-metadata fallback for
  // request/transient scoped providers whose constructor never ran.
  private readInjected(instance: object, prop: string): object | undefined {
    const direct = readProp(instance, prop);
    if (direct) return direct;
    const ctor = (instance as { constructor?: Function }).constructor;
    if (!ctor || !this.options.resolveInjected) return undefined;
    try {
      return this.options.resolveInjected(ctor, prop);
    } catch {
      return undefined;
    }
  }

  // True when the object's class was PROVABLY loaded from application code
  // rather than node_modules. Anything unresolvable is EXCLUDED — fail-closed:
  // an unidentified target is far more likely framework internals (whose
  // injector throws were once documented as endpoint 500s on every route)
  // than reachable application code.
  private isAppCode(instance: object): boolean {
    const ctor = (instance as { constructor?: Function }).constructor;
    if (!ctor) return false;
    const file = this.fileOfCtor(ctor);
    const override = this.options.isAppCode?.(ctor, file);
    if (override !== undefined) return override;
    if (!file) return false;
    return this.isAppFile(file);
  }

  // A raw `node_modules` substring is the wrong test for monorepos:
  // workspace packages are installed as a symlink INTO node_modules, so their
  // recorded path contains "node_modules" even though the code is first-party.
  // Resolving the real path tells workspace code (real path outside
  // node_modules) apart from genuine third-party dependencies. Published
  // packages that are physically installed (e.g. your own `@acme/shared`)
  // opt in through `includePackages`.
  private isAppFile(file: string): boolean {
    const cached = this.realFileCache.get(file);
    if (cached !== undefined) return cached;
    let real: string;
    try {
      real = realpathSync(file);
    } catch {
      real = file;
    }
    let isApp = !isInNodeModules(real);
    if (!isApp && this.options.includePackages?.length) {
      const posix = toPosix(real);
      isApp = this.options.includePackages.some((pkg) => posix.includes(`/node_modules/${pkg}/`));
    }
    this.realFileCache.set(file, isApp);
    return isApp;
  }

  /** File (compiled or source) a class was loaded from, if it can be proven. */
  moduleFileOf(ctor: Function): string | undefined {
    return this.fileOfCtor(ctor);
  }
}

function calledMethods(src: string, ifBlocks: IfBlock[]): Callee[] {
  const out: Callee[] = [];
  const seen = new Set<string>();
  const re = new RegExp(THIS_CALL.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(src)) !== null) {
    const prop = match[2] === undefined ? undefined : match[1];
    const method = match[2] === undefined ? match[1] : match[2];
    const args = callArgs(src, match.index + match[0].length - 1);
    const guard = innermostCondition(ifBlocks, match.index);
    const key = `${prop ?? ''}.${method}|${argSignature(args)}|${guard ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ prop, method, args, ...(guard ? { guard } : {}) });
  }
  return out;
}

const LITERAL_ARG = /^(?:'[^']*'|"[^"]*"|-?\d+(?:\.\d+)?|true|false|null|undefined)$/;
const IDENT_ARG = /^[A-Za-z_$][\w$]*$/;

/** Top-level argument texts of the call whose `(` is at `openIdx`. */
function callArgs(src: string, openIdx: number): string[] {
  const close = matchParen(src, openIdx);
  if (close < 0 || close - openIdx > 400) return [];
  return splitTopLevel(src.slice(openIdx + 1, close)).map((a) => a.trim());
}

// Only literals and bare identifiers matter for narrowing; everything else is "unknown".
function argSignature(args: string[]): string {
  return JSON.stringify(args.map((a) => (LITERAL_ARG.test(a) || IDENT_ARG.test(a) ? a : '_')));
}

/** Call arguments as seen by the callee: literals stay, bound identifiers are replaced by their literal, the rest is unknown (''). */
function forward(args: string[], bound: ReadonlyMap<string, { value: unknown }>): string[] | undefined {
  const out = args.map((a) => {
    if (LITERAL_ARG.test(a)) return a;
    if (IDENT_ARG.test(a) && bound.has(a)) {
      const v = bound.get(a)!.value;
      return typeof v === 'string' ? JSON.stringify(v) : String(v);
    }
    return '';
  });
  return out.some((a) => a !== '') ? out : undefined;
}

/** Ordered parameter names of a method source (`name(a, b) {` / `async name(a)` / `(a) =>`). Unnamed (destructured) slots are ''. */
function paramNamesOfSource(src: string): string[] {
  const open = src.indexOf('(');
  if (open < 0 || open > 200) return [];
  const close = matchParen(src, open);
  if (close < 0) return [];
  return paramNames(src.slice(open + 1, close));
}

function paramNames(text: string): string[] {
  return splitTopLevel(text).map((param) => {
    const name = param.replace(/^\s*(public|private|protected|readonly)\s+/, '').split(/[:=?\s]/)[0].trim();
    return /^[A-Za-z_$][\w$]*$/.test(name) ? name : '';
  });
}

// A parameter that is assigned inside the body no longer holds the call-site value.
function isReassigned(src: string, name: string): boolean {
  const esc = name.replace(/\$/g, '\\$');
  return new RegExp(`(?:^|[^\\w$.])${esc}\\s*(?:[-+*/%&|^]|\\*\\*|<<|>>>?|\\?\\?|&&|\\|\\|)?=(?!=)|(?:\\+\\+|--)\\s*${esc}\\b|\\b${esc}\\s*(?:\\+\\+|--)`).test(src.slice(src.indexOf('{') + 1));
}

// Bare `name(` calls that are not method calls, `new` expressions, or
// keywords — candidates for same-file module functions. Names shadowed by
// the function's own params/locals are excluded so a local `helper()` never
// resolves to an unrelated module-scope `helper`.
function bareCalls(src: string, shadowed: Set<string>, ifBlocks: IfBlock[]): BareCall[] {
  const out: BareCall[] = [];
  const seen = new Set<string>();
  const re = new RegExp(BARE_CALL.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(src)) !== null) {
    const name = match[2];
    if (KEYWORDS.has(name) || shadowed.has(name)) continue;
    // `new Foo(` — the NEW_EXPR pass owns these.
    const before = src.slice(Math.max(0, match.index - 4), match.index + match[1].length);
    if (/\bnew\s*$/.test(before)) continue;
    const args = callArgs(src, match.index + match[0].length - 1);
    const guard = innermostCondition(ifBlocks, match.index);
    const key = `${name}|${argSignature(args)}|${guard ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, args, ...(guard ? { guard } : {}) });
  }
  return out;
}

// Names bound inside the function itself: its parameter list (full method
// sources only — bare bodies carry no header) plus local
// const/let/var/function/class declarations.
function shadowedNames(src: string, hasHeader: boolean): Set<string> {
  const out = new Set<string>();
  if (hasHeader) {
    const openIdx = src.indexOf('(');
    if (openIdx >= 0 && openIdx < 200) {
      const closeIdx = matchParen(src, openIdx);
      if (closeIdx > openIdx) {
        for (const param of splitTopLevel(src.slice(openIdx + 1, closeIdx))) {
          const name = param
            .replace(/^\s*(public|private|protected|readonly)\s+/, '')
            .split(/[:=?\s]/)[0]
            .trim();
          if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
        }
      }
    }
  }
  const decl = /(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
  let match: RegExpExecArray | null;
  while ((match = decl.exec(src)) !== null) {
    out.add(match[1]);
  }
  return out;
}

// Module-scope functions of one loaded file: `function name(...) { ... }`
// declarations and `const name = (...) => { ... }` arrows, mapped to their
// body source. Operates on the EXECUTING code (dist JS in production, .ts
// under ts-node/jest) — still runtime, never a configured path.
function parseModuleFunctions(fileText: string): Map<string, string> {
  const out = new Map<string, string>();
  const fnDecl = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm;
  const arrowDecl = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gm;
  let match: RegExpExecArray | null;
  while ((match = fnDecl.exec(fileText)) !== null) {
    const openIdx = match.index + match[0].length - 1;
    const paramsEnd = matchParen(fileText, openIdx);
    if (paramsEnd < 0) continue;
    const bodyStart = bodyOpen(fileText, paramsEnd + 1);
    if (bodyStart < 0) continue;
    const bodyEnd = matchBrace(fileText, bodyStart);
    if (bodyEnd < 0) continue;
    if (!out.has(match[1])) {
      out.set(match[1], fileText.slice(bodyStart, bodyEnd + 1));
      out.set(`${match[1]}\u0000params`, fileText.slice(openIdx + 1, paramsEnd));
    }
  }
  while ((match = arrowDecl.exec(fileText)) !== null) {
    const openIdx = match.index + match[0].length - 1;
    const paramsEnd = matchParen(fileText, openIdx);
    if (paramsEnd < 0) continue;
    let cursor = paramsEnd + 1;
    while (cursor < fileText.length && /\s/.test(fileText[cursor])) cursor++;
    if (!fileText.startsWith('=>', cursor)) continue;
    cursor += 2;
    while (cursor < fileText.length && /\s/.test(fileText[cursor])) cursor++;
    if (fileText[cursor] === '{') {
      const bodyEnd = matchBrace(fileText, cursor);
      if (bodyEnd < 0) continue;
      if (!out.has(match[1])) {
        out.set(match[1], fileText.slice(cursor, bodyEnd + 1));
        out.set(`${match[1]}\u0000params`, fileText.slice(openIdx + 1, paramsEnd));
      }
    } else {
      const end = statementEnd(fileText, cursor);
      if (!out.has(match[1])) {
        out.set(match[1], `{${fileText.slice(cursor, end + 1)}}`);
        out.set(`${match[1]}\u0000params`, fileText.slice(openIdx + 1, paramsEnd));
      }
    }
  }
  return out;
}

function methodFn(instance: object, method: string): Function | undefined {
  // Walk the prototype chain: services inherit CRUD methods from a shared
  // base class, and `this.list()` must resolve there too. (The caller already
  // gated the INSTANCE to application code.)
  let proto: unknown = Object.getPrototypeOf(instance);
  while (proto && proto !== Object.prototype) {
    try {
      const desc = Object.getOwnPropertyDescriptor(proto, method);
      if (desc && typeof desc.value === 'function') return desc.value as Function;
    } catch {
      // ignore exotic prototypes
    }
    proto = Object.getPrototypeOf(proto);
  }
  try {
    const own = (instance as Record<string, unknown>)[method];
    if (typeof own === 'function') return own as Function;
  } catch {
    return undefined;
  }
  return undefined;
}

function readProp(instance: object, prop: string): object | undefined {
  try {
    const value = (instance as Record<string, unknown>)[prop];
    if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
      return value as object;
    }
  } catch {
    // throwing getter
  }
  return undefined;
}

function ctorName(instance: object): string {
  return (instance as { constructor?: { name?: string } }).constructor?.name ?? 'anon';
}
