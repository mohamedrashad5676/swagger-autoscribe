import * as path from 'node:path';
import type * as T from 'typescript';
import * as ts from 'typescript';
import { silentLogger, type AutoDocLogger } from '../logger';

// Turns a plain TypeScript interface/class/type-alias declaration into an
// OpenAPI schema by reading its .ts SOURCE directly via the TypeScript
// Compiler API — not runtime reflection. Response shapes are very often plain
// interfaces with no decorators; interfaces have zero runtime representation,
// so no amount of decorator fixing can recover their shape at runtime.
// Reading the source is the only way to get an accurate schema without
// duplicating every type as a second, Swagger-only DTO.
//
// Nested object types are inlined rather than registered as separate
// $ref'd component schemas unless the caller opts in (extractWithRefs).
// Several locally-scoped interfaces reuse the same name across unrelated
// files with DIFFERENT shapes — inlining avoids a global-name collision
// entirely; only the caller-chosen top-level type needs a document-wide
// unique name (handled by the caller's schema registry).
export interface JsonSchema {
  type?: string;
  format?: string;
  pattern?: string;
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  nullable?: boolean;
  additionalProperties?: JsonSchema | boolean;
  oneOf?: JsonSchema[];
  example?: unknown;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  description?: string;
  $ref?: string;
}

export type ResolveNamedType = (className: string, sourceFile: T.SourceFile) => JsonSchema | undefined;

const UTILITY_TYPE_NAMES = new Set([
  'Partial',
  'Required',
  'Readonly',
  'Pick',
  'Omit',
  'Exclude',
  'Extract',
  'NonNullable',
  'Record',
  'Array',
  'ReadonlyArray',
  'Promise',
  'Observable',
  'Awaited',
]);

// Containers that wrap the real payload of a handler return value.
const ASYNC_WRAPPER_NAMES = new Set(['Promise', 'PromiseLike', 'Observable', 'Subscribable']);

// Types whose structure is irrelevant on the wire — mapped by symbol name.
const DEFAULT_TYPE_MAP: Record<string, JsonSchema> = {
  Date: { type: 'string', format: 'date-time' },
  Buffer: { type: 'string', format: 'binary' },
  Uint8Array: { type: 'string', format: 'binary' },
  ArrayBuffer: { type: 'string', format: 'binary' },
  Blob: { type: 'string', format: 'binary' },
  File: { type: 'string', format: 'binary' },
  Readable: { type: 'string', format: 'binary' },
  ObjectId: { type: 'string' },
  Decimal128: { type: 'string' },
  Decimal: { type: 'string' },
  Long: { type: 'string' },
  BigNumber: { type: 'string' },
  URL: { type: 'string', format: 'uri' },
  RegExp: { type: 'string' },
};

// Handlers returning these are not JSON documents at all.
const NON_JSON_RETURN_TYPES = new Set(['StreamableFile', 'Response', 'Readable', 'ReadStream']);

export interface ExtractorOptions {
  /** Explicit compiler options (skips tsconfig discovery). */
  compilerOptions?: T.CompilerOptions;
  /** tsconfig to read `paths`/`baseUrl`/module resolution from. Default: nearest tsconfig.json from cwd. */
  tsconfigPath?: string;
  cwd?: string;
  /** Extra `typeSymbolName -> schema` mappings (e.g. `{ Money: { type: 'string', example: '49.99' } }`). */
  typeMap?: Record<string, JsonSchema>;
  /**
   * Classes/interfaces declared in files for which this returns true are NOT
   * expanded (rendered as an opaque `{ type: 'object' }`): third-party library
   * types would otherwise drag thousands of unrelated properties into the
   * document. Default: TypeScript's own lib files only.
   */
  isForeign?: (fileName: string) => boolean;
  logger?: AutoDocLogger;
}

const FALLBACK_COMPILER_OPTIONS = (): T.CompilerOptions => ({
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  esModuleInterop: true,
  skipLibCheck: true,
});

/**
 * Builds the compiler options used for the (single, shared) Program.
 *
 * The project's own tsconfig is honoured so path aliases (`@app/*`),
 * `baseUrl`, and the module resolution mode behave exactly like in the real
 * build — otherwise every aliased import silently resolves to `any` and the
 * schema degrades to `{}`. Options that only matter for emitting/diagnostics
 * are neutralised. `strictNullChecks` is forced ON so `| null` can be told
 * apart from an optional (`?`) property.
 */
export function buildCompilerOptions(options: ExtractorOptions = {}): T.CompilerOptions {
  let base: T.CompilerOptions = options.compilerOptions ?? {};
  if (!options.compilerOptions) {
    const cwd = options.cwd ?? process.cwd();
    const configPath = options.tsconfigPath ?? ts.findConfigFile(cwd, ts.sys.fileExists, 'tsconfig.json');
    base = FALLBACK_COMPILER_OPTIONS();
    if (configPath) {
      try {
        const read = ts.readConfigFile(configPath, ts.sys.readFile);
        if (!read.error) {
          const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
          base = { ...base, ...parsed.options };
        }
      } catch {
        // fall back to defaults
      }
    }
  }
  return {
    ...base,
    noEmit: true,
    skipLibCheck: true,
    incremental: false,
    composite: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    outDir: undefined,
    tsBuildInfoFile: undefined,
    strictNullChecks: true,
    experimentalDecorators: true,
    // Plain-JS leftovers never carry type information worth the parse cost.
    allowJs: false,
    checkJs: false,
  };
}

export class SourceSchemaExtractor {
  // A single shared Program covering every root file this extractor will
  // ever be asked about. Building a ts.Program re-parses and binds every
  // transitively-imported file (node_modules .d.ts included) — one Program
  // per lookup, across dozens of files, exhausts the heap. Document
  // generation happens once at app startup, so one upfront build is the right
  // cost to pay, not a per-call one.
  private program: T.Program | undefined;
  private readonly typeMap: Record<string, JsonSchema>;
  private readonly compilerOptions: T.CompilerOptions;
  private readonly logger: AutoDocLogger;
  private readonly warned = new Set<string>();
  /** Running count of `any`/`unknown` leaves met while converting types (a coverage signal). */
  anyLeaves = 0;
  // While computing an interceptor envelope: type-parameter name -> payload schema, and the
  // `any` slot probe (a lone `any` leaf in `map(d => ({ data: d }))` IS the handler payload).
  private substitutions: Map<string, JsonSchema> | undefined;
  private anyProbe: { payload: JsonSchema; replace: boolean; count: number } | undefined;

  constructor(private readonly options: ExtractorOptions = {}) {
    this.typeMap = { ...DEFAULT_TYPE_MAP, ...(options.typeMap ?? {}) };
    this.compilerOptions = buildCompilerOptions(options);
    this.logger = options.logger ?? silentLogger;
  }

  /**
   * Build (or extend) the shared Program to cover `rootFiles`. Must be
   * called with the full set of files before any `extract*()` call.
   */
  initialize(rootFiles: string[]): void {
    this.program = ts.createProgram(rootFiles, this.compilerOptions, undefined, this.program);
  }

  isInitialized(): boolean {
    return this.program !== undefined;
  }

  hasFile(filePath: string): boolean {
    return !!this.program?.getSourceFile(filePath);
  }

  private requireProgram(method: string): T.Program {
    if (!this.program) {
      throw new Error(`SourceSchemaExtractor.initialize() must be called before ${method}()`);
    }
    return this.program;
  }

  private requireSource(program: T.Program, filePath: string): T.SourceFile {
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) {
      throw new Error(`SourceSchemaExtractor: ${filePath} was not part of the initialized root file set`);
    }
    return sourceFile;
  }

  /**
   * Extract a JSON Schema for `typeName` (an interface, class, or type
   * alias) declared directly in `filePath`. `filePath` must be part of the
   * root set passed to `initialize()`.
   */
  extract(filePath: string, typeName: string): JsonSchema {
    const program = this.requireProgram('extract');
    const checker = program.getTypeChecker();
    const sourceFile = this.requireSource(program, filePath);
    const targetNode = this.findTypeDeclaration(sourceFile, typeName);
    if (!targetNode) {
      throw new Error(`SourceSchemaExtractor: type "${typeName}" not found in ${filePath}`);
    }
    return this.typeToSchema(checker.getTypeAtLocation(targetNode), checker);
  }

  private findTypeDeclaration(sourceFile: T.SourceFile, typeName: string): T.Node | undefined {
    let found: T.Node | undefined;
    ts.forEachChild(sourceFile, (node) => {
      if (found) return;
      if (
        (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
        node.name?.text === typeName
      ) {
        found = node;
      }
    });
    return found;
  }

  private findClass(sourceFile: T.SourceFile, className: string): T.ClassDeclaration | undefined {
    let found: T.ClassDeclaration | undefined;
    ts.forEachChild(sourceFile, (node) => {
      if (!found && ts.isClassDeclaration(node) && node.name?.text === className) found = node;
    });
    return found;
  }

  private findMethod(sourceFile: T.SourceFile, className: string, methodName: string): T.MethodDeclaration | undefined {
    const cls = this.findClass(sourceFile, className);
    if (!cls) return undefined;
    for (const member of cls.members) {
      if (ts.isMethodDeclaration(member) && memberName(member.name) === methodName) return member;
    }
    return undefined;
  }

  /**
   * Extract a JSON Schema for a controller method's return type.
   *  1. Explicit annotation: `(): Promise<SomeDto>` — reads the type node directly
   *  2. Explicit annotation + inline: `(): Promise<{ data: X }>`
   *  3. NO annotation (inferred): `async start() { return { ... } }` — asks the checker
   *  4. Union return: `(): Promise<A | B>` — oneOf
   *  5. Named type: interface/class — returned with `typeName` so the caller registers a $ref
   *  6. Inline object literal — embedded directly
   * `Promise<T>` and `Observable<T>` are unwrapped.
   */
  extractFromReturnType(
    controllerFilePath: string,
    controllerClassName: string,
    methodName: string,
  ): { schema: JsonSchema; typeName: string | undefined } | undefined {
    const program = this.requireProgram('extractFromReturnType');
    const sourceFile = this.requireSource(program, controllerFilePath);
    const checker = program.getTypeChecker();
    const methodDecl = this.findMethod(sourceFile, controllerClassName, methodName);
    if (!methodDecl) return undefined;

    const isUntypedKeyword = (k: T.SyntaxKind): boolean =>
      k === ts.SyntaxKind.AnyKeyword || k === ts.SyntaxKind.UnknownKeyword;

    let normal: { schema: JsonSchema; typeName: string | undefined } | undefined;
    const before = this.anyLeaves;

    if (methodDecl.type) {
      // Strategy 1: explicit return type annotation on the method signature
      const target = unwrapAsyncTypeNode(methodDecl.type);
      if (target.kind === ts.SyntaxKind.VoidKeyword || target.kind === ts.SyntaxKind.NeverKeyword) return undefined;
      if (!isUntypedKeyword(target.kind)) {
        const rawName = typeNodeName(target);
        if (rawName && NON_JSON_RETURN_TYPES.has(rawName)) return undefined;
        const typeName = componentNameForNode(target);
        const type = unwrapAsyncType(checker.getTypeFromTypeNode(target), checker);
        normal = { schema: this.typeToSchema(type, checker), typeName };
      }
    } else {
      // Strategy 2: no explicit annotation — infer from the declaration.
      const sig = checker.getSignatureFromDeclaration(methodDecl);
      if (!sig) return undefined;
      const inferredType = unwrapAsyncType(checker.getReturnTypeOfSignature(sig), checker);
      const finalText = checker.typeToString(inferredType);
      if (finalText === 'void' || finalText === 'never') return undefined;
      if (finalText !== 'any' && finalText !== 'unknown') {
        const symName = inferredType.symbol?.name;
        if (symName && NON_JSON_RETURN_TYPES.has(symName)) return undefined;
        const decl = inferredType.symbol?.declarations?.[0];
        let typeName: string | undefined;
        if (decl && (ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl)) && decl.name && !isGenericInstantiation(inferredType)) {
          typeName = decl.name.text;
        }
        normal = { schema: this.typeToSchema(inferredType, checker), typeName };
      }
    }
    const normalAny = normal ? this.anyLeaves - before : Infinity;
    if (normal && normalAny === 0) return normal;

    // The signature is silent (`any`, `Promise<any>`, a mapper declared `: any`, an untyped
    // repository…): read the code that PRODUCES the value and follow every call it makes.
    const deepBefore = this.anyLeaves;
    const deep = this.returnsSchema(methodDecl, checker, new Set(), 0);
    const deepAny = this.anyLeaves - deepBefore;
    if (deep && Object.keys(deep).length > 0 && (!normal || deepAny < normalAny)) {
      this.anyLeaves = deepBefore + deepAny;
      return { schema: deep, typeName: undefined };
    }
    return normal;
  }

  // ----------------------------------------------------- deep return analysis

  private static readonly MAX_DEEP_DEPTH = 14;

  /**
   * Schema of what a function-like declaration returns, by walking its return expressions and
   * following the calls inside them (mappers, helpers, services, nested helpers…) to any depth.
   * A declared concrete return type wins; `any`/missing annotations are looked through.
   */
  private returnsSchema(
    decl: T.SignatureDeclaration,
    checker: T.TypeChecker,
    seen: Set<T.Node>,
    depth: number,
  ): JsonSchema | undefined {
    if (depth > SourceSchemaExtractor.MAX_DEEP_DEPTH || seen.has(decl)) return undefined;
    const path = new Set(seen).add(decl);

    if (decl.type) {
      const target = unwrapAsyncTypeNode(decl.type);
      const k = target.kind;
      if (k !== ts.SyntaxKind.AnyKeyword && k !== ts.SyntaxKind.UnknownKeyword) {
        if (k === ts.SyntaxKind.VoidKeyword || k === ts.SyntaxKind.NeverKeyword) return undefined;
        const mark = this.anyLeaves;
        const schema = this.typeToSchema(unwrapAsyncType(checker.getTypeFromTypeNode(target), checker), checker);
        if (this.anyLeaves === mark) return schema;
        // concrete but partially untyped annotation: try the body, keep the better one
        const deepMark = this.anyLeaves;
        const body = this.returnExpressionsSchema(decl, checker, path, depth);
        if (body && this.anyLeaves - deepMark < this.anyLeaves - mark) return body;
        return schema;
      }
    }
    return this.returnExpressionsSchema(decl, checker, path, depth);
  }

  private returnExpressionsSchema(
    decl: T.SignatureDeclaration,
    checker: T.TypeChecker,
    path: Set<T.Node>,
    depth: number,
  ): JsonSchema | undefined {
    const body = (decl as T.FunctionLikeDeclaration).body;
    if (!body) return undefined;
    const exprs: T.Expression[] = [];
    if (!ts.isBlock(body)) {
      exprs.push(body);
    } else {
      const visit = (node: T.Node): void => {
        if (ts.isReturnStatement(node)) {
          if (node.expression) exprs.push(node.expression);
          return;
        }
        if (ts.isFunctionLike(node)) return; // nested functions have their own returns
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(body, visit);
    }
    if (exprs.length === 0) return undefined;
    const schemas = exprs
      .map((e) => this.exprSchema(e, checker, path, depth + 1))
      .filter((x): x is JsonSchema => x !== undefined);
    const distinct = dedupeSchemas(schemas);
    if (distinct.length === 0) return undefined;
    return distinct.length === 1 ? distinct[0] : { oneOf: distinct };
  }

  /** Schema of one expression; falls back to structural reading wherever its static type is untyped. */
  private exprSchema(
    expr: T.Expression,
    checker: T.TypeChecker,
    path: Set<T.Node>,
    depth: number,
  ): JsonSchema | undefined {
    const inner = skipWrappers(expr);
    if (depth > SourceSchemaExtractor.MAX_DEEP_DEPTH) return undefined;
    const type = unwrapAsyncType(checker.getTypeAtLocation(inner), checker);
    const mark = this.anyLeaves;
    const typed = this.typeToSchema(type, checker);
    if (this.anyLeaves === mark) return typed; // fully typed — the checker already followed everything

    // Count only the better reading: roll the typed attempt back while the structural one runs.
    const typedAny = this.anyLeaves - mark;
    this.anyLeaves = mark;
    const structural = this.structuralSchema(inner, checker, path, depth);
    if (structural === undefined) {
      this.anyLeaves = mark + typedAny;
      return typed;
    }
    return structural;
  }

  private structuralSchema(
    expr: T.Expression,
    checker: T.TypeChecker,
    path: Set<T.Node>,
    depth: number,
  ): JsonSchema | undefined {
    if (ts.isObjectLiteralExpression(expr)) {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const prop of expr.properties) {
        if (ts.isPropertyAssignment(prop)) {
          const name = memberName(prop.name);
          if (!name) continue;
          properties[name] = this.exprSchema(prop.initializer, checker, path, depth + 1) ?? {};
          required.push(name);
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          const sym = checker.getShorthandAssignmentValueSymbol(prop);
          const init = sym ? declarationInitializer(sym) : undefined;
          properties[prop.name.text] = init ? (this.exprSchema(init, checker, path, depth + 1) ?? {}) : this.typeToSchema(checker.getTypeAtLocation(prop.name), checker);
          required.push(prop.name.text);
        } else if (ts.isSpreadAssignment(prop)) {
          const spread = this.exprSchema(prop.expression, checker, path, depth + 1);
          if (spread?.properties) {
            Object.assign(properties, spread.properties);
            for (const r of spread.required ?? []) if (!required.includes(r)) required.push(r);
          }
        } else if (ts.isMethodDeclaration(prop)) {
          continue;
        }
      }
      return { type: 'object', properties, ...(required.length ? { required } : {}) };
    }

    if (ts.isArrayLiteralExpression(expr)) {
      const items = expr.elements
        .filter((e): e is T.Expression => !ts.isOmittedExpression(e) && !ts.isSpreadElement(e))
        .map((e) => this.exprSchema(e, checker, path, depth + 1))
        .filter((x): x is JsonSchema => x !== undefined);
      const distinct = dedupeSchemas(items);
      return { type: 'array', items: distinct.length === 0 ? {} : distinct.length === 1 ? distinct[0] : { oneOf: distinct } };
    }

    if (ts.isConditionalExpression(expr)) {
      const parts = [expr.whenTrue, expr.whenFalse]
        .map((e) => this.exprSchema(e, checker, path, depth + 1))
        .filter((x): x is JsonSchema => x !== undefined);
      const distinct = dedupeSchemas(parts);
      return distinct.length === 0 ? undefined : distinct.length === 1 ? distinct[0] : { oneOf: distinct };
    }

    if (
      ts.isBinaryExpression(expr) &&
      (expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || expr.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      const parts = [expr.left, expr.right]
        .map((e) => this.exprSchema(e, checker, path, depth + 1))
        .filter((x): x is JsonSchema => x !== undefined && Object.keys(x).length > 0);
      const distinct = dedupeSchemas(parts);
      return distinct.length === 0 ? undefined : distinct.length === 1 ? distinct[0] : { oneOf: distinct };
    }

    if (ts.isIdentifier(expr)) {
      const sym = checker.getSymbolAtLocation(expr);
      const init = sym ? declarationInitializer(sym) : undefined;
      if (init && !path.has(init)) return this.exprSchema(init, checker, new Set(path).add(init), depth + 1);
      return undefined;
    }

    if (ts.isCallExpression(expr)) {
      // `items.map(x => toDto(x))` / flatMap: array of whatever the callback returns
      if (ts.isPropertyAccessExpression(expr.expression) && (expr.expression.name.text === 'map' || expr.expression.name.text === 'flatMap')) {
        const cb = expr.arguments[0];
        if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
          const item = this.returnsSchema(cb, checker, path, depth + 1);
          if (item) return { type: 'array', items: item };
        }
      }
      // `promise.then(x => toDto(x))`
      if (ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === 'then') {
        const cb = expr.arguments[0];
        if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
          const r = this.returnsSchema(cb, checker, path, depth + 1);
          if (r) return r;
        }
      }
      // a call to a function/method we can read: follow it
      let signature: T.Signature | undefined;
      try {
        signature = checker.getResolvedSignature(expr);
      } catch {
        signature = undefined;
      }
      const target = signature?.declaration;
      if (target && ts.isFunctionLike(target) && !path.has(target)) {
        return this.returnsSchema(target as T.SignatureDeclaration, checker, path, depth + 1);
      }
      return undefined;
    }

    if (ts.isNewExpression(expr)) return undefined; // typed by its class
    return undefined;
  }

  /**
   * Output type of a response-transformer class method (e.g. a Resource's
   * `transform()` return annotation). Resolved through the checker, so the
   * declaring file of the output type does not need to be known.
   */
  extractTransformOutput(
    filePath: string,
    className: string,
    methodName: string,
  ): { schema: JsonSchema; typeName: string | undefined } | undefined {
    const program = this.requireProgram('extractTransformOutput');
    const sourceFile = this.requireSource(program, filePath);
    const checker = program.getTypeChecker();
    const method = this.findMethod(sourceFile, className, methodName);
    if (!method?.type) return undefined;
    const target = unwrapAsyncTypeNode(method.type);
    const typeName = typeNodeName(target);
    if (!typeName) return undefined;
    const type = checker.getTypeFromTypeNode(target);
    return { schema: this.typeToSchema(type, checker), typeName };
  }


  /**
   * Shape an interceptor gives to the payload a handler returns.
   *  - `class Wrap<T> implements NestInterceptor<T, Resp<T>>`: `T` is replaced by the payload;
   *  - `map(data => ({ data, ts }))` (no generics): the single `any` leaf is the payload slot.
   * Returns undefined when the interceptor does not reshape the payload (logging, caching, …)
   * or when the shape cannot be determined unambiguously.
   */
  extractInterceptorEnvelope(filePath: string, className: string, payload: JsonSchema): JsonSchema | undefined {
    const program = this.requireProgram('extractInterceptorEnvelope');
    const sourceFile = this.requireSource(program, filePath);
    const checker = program.getTypeChecker();
    const method = this.findMethod(sourceFile, className, 'intercept');
    const cls = this.findClass(sourceFile, className);
    if (!method || !cls) return undefined;

    let type: T.Type | undefined;
    if (method.type) type = checker.getTypeFromTypeNode(unwrapAsyncTypeNode(method.type));
    else {
      const sig = checker.getSignatureFromDeclaration(method);
      if (sig) type = checker.getReturnTypeOfSignature(sig);
    }
    if (type) type = unwrapAsyncType(type, checker);
    // `intercept(): Observable<any>` hides what the body really returns — read the
    // returned expression itself (`next.handle().pipe(map(d => ({ data: d })))`).
    if (!type || type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
      let fromBody: T.Type | undefined;
      const visit = (node: T.Node): void => {
        if (fromBody) return;
        if (ts.isReturnStatement(node) && node.expression) {
          const t = unwrapAsyncType(checker.getTypeAtLocation(node.expression), checker);
          if (!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) fromBody = t;
          return;
        }
        if (ts.isFunctionLike(node) && node !== method) return;
        ts.forEachChild(node, visit);
      };
      if (method.body) visit(method.body);
      if (fromBody) type = fromBody;
    }
    if (!type) return undefined;

    const run = (): JsonSchema => this.typeToSchema(type as T.Type, checker);
    try {
      const params = (cls.typeParameters ?? []).map((tp) => tp.name.text);
      let result: JsonSchema;
      if (params.length > 0) {
        this.substitutions = new Map(params.map((n) => [n, payload]));
        result = run();
      } else {
        this.anyProbe = { payload, replace: false, count: 0 };
        run();
        if (this.anyProbe.count !== 1) return undefined;
        this.anyProbe.replace = true;
        result = run();
      }
      const bare = checker.typeToString(type);
      if (bare === 'any' || bare === 'unknown') return undefined; // passthrough
      if (JSON.stringify(result) === JSON.stringify(payload)) return undefined;
      return result;
    } finally {
      this.substitutions = undefined;
      this.anyProbe = undefined;
    }
  }

  /**
   * Whether each individually `@Query('name')`/`@Param('name')`-decorated
   * parameter on this method carries a `?` (optional) token. Nest's own
   * Swagger explorer can't see this without the CLI plugin, so it marks every
   * such parameter `required: true` — this reads the actual signature.
   */
  getParamOptionality(controllerFilePath: string, controllerClassName: string, methodName: string): Map<string, boolean> {
    const result = new Map<string, boolean>();
    if (!this.program) return result;
    const sourceFile = this.program.getSourceFile(controllerFilePath);
    if (!sourceFile) return result;
    const method = this.findMethod(sourceFile, controllerClassName, methodName);
    if (!method) return result;
    for (const param of method.parameters) {
      for (const dec of decoratorsOf(param)) {
        const decoratorName = decoratorNameOf(dec);
        if (decoratorName !== 'Query' && decoratorName !== 'Param') continue;
        if (!ts.isCallExpression(dec.expression)) continue;
        const nameArg = dec.expression.arguments[0];
        const paramName = nameArg && ts.isStringLiteralLike(nameArg) ? nameArg.text : undefined;
        if (paramName) {
          result.set(paramName, param.questionToken !== undefined || param.initializer !== undefined);
        }
      }
    }
    return result;
  }

  /**
   * Multipart upload fields declared with Nest's file interceptors
   * (`FileInterceptor('file')`, `FilesInterceptor('files', 5)`,
   * `FileFieldsInterceptor([{ name, maxCount }])`, `AnyFilesInterceptor()`)
   * on the method or its controller. The field name lives in a closure at
   * runtime, so the source is the only place it can be read from.
   */
  extractUploadSpec(
    controllerFilePath: string,
    controllerClassName: string,
    methodName: string,
  ): { fields: Array<{ name: string; multiple: boolean; maxCount?: number }>; any: boolean } | undefined {
    if (!this.program) return undefined;
    const sourceFile = this.program.getSourceFile(controllerFilePath);
    if (!sourceFile) return undefined;
    const method = this.findMethod(sourceFile, controllerClassName, methodName);
    if (!method) return undefined;
    const fields: Array<{ name: string; multiple: boolean; maxCount?: number }> = [];
    let any = false;
    const str = (n: T.Node | undefined): string | undefined => (n && ts.isStringLiteralLike(n) ? n.text : undefined);
    const num = (n: T.Node | undefined): number | undefined => (n && ts.isNumericLiteral(n) ? Number(n.text) : undefined);
    const visit = (node: T.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = node.expression.text;
        const [a0, a1] = node.arguments;
        if (callee === 'FileInterceptor') {
          const name = str(a0);
          if (name) fields.push({ name, multiple: false });
        } else if (callee === 'FilesInterceptor') {
          const name = str(a0);
          if (name) fields.push({ name, multiple: true, maxCount: num(a1) });
        } else if (callee === 'FileFieldsInterceptor' && a0 && ts.isArrayLiteralExpression(a0)) {
          for (const el of a0.elements) {
            if (!ts.isObjectLiteralExpression(el)) continue;
            let name: string | undefined;
            let maxCount: number | undefined;
            for (const prop of el.properties) {
              if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
              if (prop.name.text === 'name') name = str(prop.initializer);
              if (prop.name.text === 'maxCount') maxCount = num(prop.initializer);
            }
            if (name) fields.push({ name, multiple: maxCount === undefined || maxCount > 1, maxCount });
          }
        } else if (callee === 'AnyFilesInterceptor') any = true;
      }
      ts.forEachChild(node, visit);
    };
    const owners: T.Node[] = [method];
    if (method.parent && ts.isClassLike(method.parent)) owners.push(method.parent);
    for (const owner of owners) {
      for (const dec of decoratorsOf(owner)) if (decoratorNameOf(dec) === 'UseInterceptors') visit(dec);
    }
    return fields.length || any ? { fields, any } : undefined;
  }

  /**
   * Extract the JSON Schema for a controller method's @Body() parameter.
   * Works for named type references (`@Body() body: StartMeetingBodyDto`) and
   * inline object literals (`@Body() body: { idempotencyKey?: string }`).
   * `isArray` is true for `Dto[]` / `Array<Dto>` bodies — the schema and
   * typeName then describe the ELEMENT type.
   */
  /**
   * Name of the type annotated on the whole-object `@Query()` / `@Param()` / `@Headers()` parameter
   * (`@Query() q: ListDto`) — read from the source, so it also works when the type was imported with
   * `import type` (erased: runtime metadata only says `Object`).
   */
  extractParamTypeName(controllerFilePath: string, controllerClassName: string, methodName: string, decorator: string): string | undefined {
    const program = this.requireProgram('extractParamTypeName');
    const sourceFile = this.requireSource(program, controllerFilePath);
    const method = this.findMethod(sourceFile, controllerClassName, methodName);
    if (!method) return undefined;
    const param = method.parameters.find((p) => decoratorsOf(p).some((d) => decoratorNameOf(d) === decorator && !hasStringArg(d)));
    if (!param?.type || !ts.isTypeReferenceNode(param.type)) return undefined;
    const name = componentNameForNode(param.type);
    if (!name || ['Record', 'Partial', 'Pick', 'Omit', 'Required', 'Readonly', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Date'].includes(name)) return undefined;
    return name;
  }

  extractBodyType(
    controllerFilePath: string,
    controllerClassName: string,
    methodName: string,
  ): { schema: JsonSchema; typeName: string | undefined; isArray: boolean } | undefined {
    const program = this.requireProgram('extractBodyType');
    const sourceFile = this.requireSource(program, controllerFilePath);
    const method = this.findMethod(sourceFile, controllerClassName, methodName);
    if (!method) return undefined;

    const bodyParam = method.parameters.find((p) => decoratorsOf(p).some((d) => decoratorNameOf(d) === 'Body' && !hasStringArg(d)));
    if (!bodyParam) {
      // `@Body('email') email: string, @Body('age') age: number` binds individual
      // fields — compose them into one object schema.
      const named = method.parameters.filter((p) =>
        decoratorsOf(p).some((d) => decoratorNameOf(d) === 'Body' && hasStringArg(d)),
      );
      if (named.length === 0) return undefined;
      const checker = program.getTypeChecker();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const param of named) {
        const dec = decoratorsOf(param).find((d) => decoratorNameOf(d) === 'Body' && hasStringArg(d)) as T.Decorator;
        const field = ((dec.expression as T.CallExpression).arguments[0] as T.StringLiteralLike).text;
        properties[field] = param.type
          ? this.typeToSchema(checker.getTypeFromTypeNode(param.type), checker)
          : {};
        if (!param.questionToken && !param.initializer) required.push(field);
      }
      return {
        schema: { type: 'object', properties, ...(required.length ? { required } : {}) },
        typeName: undefined,
        isArray: false,
      };
    }
    if (!bodyParam.type) return undefined;

    let schemaTypeNode = bodyParam.type;
    let isArray = false;
    if (ts.isArrayTypeNode(schemaTypeNode)) {
      schemaTypeNode = schemaTypeNode.elementType;
      isArray = true;
    } else if (
      ts.isTypeReferenceNode(schemaTypeNode) &&
      ts.isIdentifier(schemaTypeNode.typeName) &&
      (schemaTypeNode.typeName.text === 'Array' || schemaTypeNode.typeName.text === 'ReadonlyArray') &&
      schemaTypeNode.typeArguments?.[0]
    ) {
      schemaTypeNode = schemaTypeNode.typeArguments[0];
      isArray = true;
    }

    const typeName = componentNameForNode(schemaTypeNode);
    const checker = program.getTypeChecker();
    const type = checker.getTypeFromTypeNode(schemaTypeNode);
    return { schema: this.typeToSchema(type, checker), typeName, isArray };
  }

  /**
   * Like `extract()`, but every nested property that resolves to a NAMED
   * class or interface (not an inline/anonymous shape) is handed to
   * `resolveNamedType` instead of being inlined — the caller registers it as
   * its own `components.schemas` entry and this returns whatever schema
   * (typically a `{ $ref }`) the callback returns in its place. Recurses to
   * unlimited depth; cycle safety is the caller's responsibility
   * (placeholder-then-fill registration breaks A -> B -> A cycles).
   */
  extractWithRefs(filePath: string, typeName: string, resolveNamedType: ResolveNamedType): JsonSchema {
    const program = this.requireProgram('extractWithRefs');
    const checker = program.getTypeChecker();
    const sourceFile = this.requireSource(program, filePath);
    const targetNode = this.findTypeDeclaration(sourceFile, typeName);
    if (!targetNode) {
      throw new Error(`SourceSchemaExtractor: type "${typeName}" not found in ${filePath}`);
    }
    const type = checker.getTypeAtLocation(targetNode);
    // A class/interface walks its OWN properties directly: applying the
    // named-type delegation to the top-level type would just delegate back to
    // itself. Aliases of unions/intersections/arrays go through typeToSchema.
    if (ts.isClassDeclaration(targetNode) || ts.isInterfaceDeclaration(targetNode)) {
      return this.walkObjectType(type, checker, new Set(), resolveNamedType);
    }
    return this.typeToSchema(type, checker, new Set(), resolveNamedType);
  }

  // ---------------------------------------------------------------- types

  private typeToSchema(
    type: T.Type,
    checker: T.TypeChecker,
    seen: Set<T.Type> = new Set(),
    resolveNamedType?: ResolveNamedType,
  ): JsonSchema {
    const typeText = checker.typeToString(type);

    const known = this.knownTypeSchema(type, checker, seen, resolveNamedType);
    if (known) return known;

    const flags = type.flags;
    if (flags & ts.TypeFlags.String) return { type: 'string' };
    if (flags & ts.TypeFlags.Number) return { type: 'number' };
    if (flags & ts.TypeFlags.Boolean) return { type: 'boolean' };
    if (flags & ts.TypeFlags.BooleanLiteral) return { type: 'boolean', example: typeText === 'true' };
    if (flags & ts.TypeFlags.StringLiteral) return { type: 'string', enum: [(type as T.StringLiteralType).value] };
    if (flags & ts.TypeFlags.NumberLiteral) return { type: 'number', enum: [(type as T.NumberLiteralType).value] };
    if (flags & (ts.TypeFlags.BigInt | ts.TypeFlags.BigIntLiteral)) return { type: 'integer', format: 'int64' };
    if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
      this.anyLeaves++;
      if (this.anyProbe) {
        this.anyProbe.count++;
        if (this.anyProbe.replace) return JSON.parse(JSON.stringify(this.anyProbe.payload));
      }
      return {};
    }
    if (flags & (ts.TypeFlags.Void | ts.TypeFlags.Never | ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol)) return {};
    if (flags & ts.TypeFlags.NonPrimitive) return { type: 'object' };

    // Standalone undefined / null
    if (flags & ts.TypeFlags.Undefined) return {};
    if (flags & ts.TypeFlags.Null) return { nullable: true };

    // Type parameters (generic T without constraint) -> resolve to apparent type
    if (flags & ts.TypeFlags.TypeParameter) {
      const substituted = this.substitutions?.get(type.symbol?.name ?? '');
      if (substituted) return JSON.parse(JSON.stringify(substituted));
      const apparent = checker.getApparentType(type);
      if (apparent !== type) return this.typeToSchema(apparent, checker, seen, resolveNamedType);
      return {};
    }

    if (type.isUnion()) return this.unionToSchema(type, checker, seen, resolveNamedType);

    // Intersection types (A & B): flatten to a single merged object
    if (type.isIntersection()) return this.flattenIntersection(type, checker, seen, resolveNamedType);

    // Tuple types ([string, number])
    if (checker.isTupleType(type)) {
      const typeArgs = checker.getTypeArguments(type as T.TypeReference);
      if (typeArgs.length === 0) return { type: 'array', items: {} };
      const schemas = typeArgs.map((t) => this.typeToSchema(t, checker, seen, resolveNamedType));
      const distinct = dedupeSchemas(schemas);
      return {
        type: 'array',
        items: distinct.length === 1 ? distinct[0] : { oneOf: distinct },
        minItems: typeArgs.length,
        maxItems: typeArgs.length,
      };
    }

    if (checker.isArrayType(type)) {
      const elemType = checker.getTypeArguments(type as T.TypeReference)[0];
      return { type: 'array', items: elemType ? this.typeToSchema(elemType, checker, seen, resolveNamedType) : {} };
    }

    if (flags & ts.TypeFlags.Object) {
      // A function-typed value has no JSON representation.
      if (type.getCallSignatures().length > 0 && type.getProperties().length === 0) return {};
      // Library types (Express.Request, Stripe.Customer, …) stay opaque.
      const declared = type.symbol?.declarations?.[0];
      if (
        declared &&
        (ts.isClassDeclaration(declared) || ts.isInterfaceDeclaration(declared)) &&
        this.isForeign(declared.getSourceFile().fileName)
      ) {
        return { type: 'object' };
      }
      // A named class/interface (a real DTO, not an inline `{ data: X }`
      // literal) gets delegated to the caller instead of inlined — that's
      // what turns `profile: CreateProfileDto` into a $ref against its own
      // registered component schema. Generic INSTANTIATIONS (`Page<User>`)
      // are inlined: their name alone cannot identify the shape.
      if (resolveNamedType && !isGenericInstantiation(type)) {
        const decl = type.symbol?.declarations?.[0];
        if (decl && (ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl)) && decl.name) {
          const resolved = resolveNamedType(decl.name.text, decl.getSourceFile());
          if (resolved) return resolved;
        }
      }
      return this.walkObjectType(type, checker, seen, resolveNamedType);
    }

    this.warnOnce(`Unhandled type "${typeText}" — falling back to empty schema`);
    return {};
  }

  private isForeign(fileName: string): boolean {
    if (this.options.isForeign) return this.options.isForeign(fileName);
    return /[\\/]typescript[\\/]lib[\\/]lib\.[^\\/]*\.d\.ts$/.test(fileName);
  }

  private warnOnce(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.logger.warn(message);
  }

  private knownTypeSchema(
    type: T.Type,
    checker: T.TypeChecker,
    seen: Set<T.Type>,
    resolveNamedType?: ResolveNamedType,
  ): JsonSchema | undefined {
    if (!(type.flags & ts.TypeFlags.Object)) return undefined;
    const name = type.aliasSymbol?.name ?? type.symbol?.name;
    if (!name) return undefined;
    const mapped = this.typeMap[name];
    if (mapped) return { ...mapped };
    if (name === 'Map' || name === 'ReadonlyMap' || name === 'WeakMap') {
      const args = checker.getTypeArguments(type as T.TypeReference);
      return {
        type: 'object',
        additionalProperties: args[1] ? this.typeToSchema(args[1], checker, seen, resolveNamedType) : true,
      };
    }
    if (name === 'Set' || name === 'ReadonlySet' || name === 'WeakSet') {
      const args = checker.getTypeArguments(type as T.TypeReference);
      return { type: 'array', items: args[0] ? this.typeToSchema(args[0], checker, seen, resolveNamedType) : {} };
    }
    return undefined;
  }

  private unionToSchema(
    type: T.UnionType,
    checker: T.TypeChecker,
    seen: Set<T.Type>,
    resolveNamedType?: ResolveNamedType,
  ): JsonSchema {
    const hasNull = type.types.some((t) => t.flags & ts.TypeFlags.Null);
    const nonNull = type.types.filter(
      (t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)),
    );
    const nullable = hasNull ? { nullable: true } : {};

    if (nonNull.length === 0) return hasNull ? { nullable: true } : {};

    // `boolean` is internally `true | false` — collapse the pair back.
    const hasTrue = nonNull.some((t) => t.flags & ts.TypeFlags.BooleanLiteral && checker.typeToString(t) === 'true');
    const hasFalse = nonNull.some((t) => t.flags & ts.TypeFlags.BooleanLiteral && checker.typeToString(t) === 'false');
    const collapseBool = hasTrue && hasFalse;
    const members = collapseBool ? nonNull.filter((t) => !(t.flags & ts.TypeFlags.BooleanLiteral)) : nonNull;

    if (!collapseBool && members.length > 0 && members.every((t) => t.flags & ts.TypeFlags.StringLiteral)) {
      return { type: 'string', enum: members.map((t) => (t as T.StringLiteralType).value), ...nullable };
    }
    if (!collapseBool && members.length > 0 && members.every((t) => t.flags & ts.TypeFlags.NumberLiteral)) {
      const values = members.map((t) => (t as T.NumberLiteralType).value);
      return { type: values.every(Number.isInteger) ? 'integer' : 'number', enum: values, ...nullable };
    }

    const schemas: JsonSchema[] = members.map((t) => this.typeToSchema(t, checker, seen, resolveNamedType));
    if (collapseBool) schemas.push({ type: 'boolean' });
    const distinct = dedupeSchemas(schemas);
    if (distinct.length === 1) return { ...distinct[0], ...nullable };
    return { oneOf: distinct, ...nullable };
  }

  private typeOfProperty(checker: T.TypeChecker, prop: T.Symbol): T.Type | undefined {
    // Properties synthesised by mapped types (Partial/Pick/Omit/PartialType…)
    // carry no `valueDeclaration`; resolving through the symbol itself works
    // for them and for ordinary declarations alike.
    const direct = (checker as unknown as { getTypeOfSymbol?: (s: T.Symbol) => T.Type }).getTypeOfSymbol;
    if (typeof direct === 'function') {
      try {
        return direct.call(checker, prop);
      } catch {
        // fall through
      }
    }
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    if (!decl) return undefined;
    return checker.getTypeOfSymbolAtLocation(prop, decl);
  }

  private isDataProperty(prop: T.Symbol): boolean {
    if (prop.flags & ts.SymbolFlags.Method) return false;
    if (prop.name.startsWith('__@') || prop.name.includes('#')) return false;
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    if (decl) {
      try {
        const mods = ts.getCombinedModifierFlags(decl as T.Declaration);
        if (mods & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) return false;
      } catch {
        // synthetic declaration — keep
      }
    }
    return true;
  }

  private walkObjectType(
    type: T.Type,
    checker: T.TypeChecker,
    seen: Set<T.Type>,
    resolveNamedType?: ResolveNamedType,
  ): JsonSchema {
    if (seen.has(type)) return { type: 'object' }; // cycle guard for anonymous/inline shapes only
    const nextSeen = new Set(seen);
    nextSeen.add(type);

    const stringIndexInfo = checker.getIndexInfoOfType(type, ts.IndexKind.String);
    const properties = checker.getPropertiesOfType(type).filter((p) => this.isDataProperty(p));
    if (stringIndexInfo && properties.length === 0) {
      const valueType = this.typeToSchema(stringIndexInfo.type, checker, nextSeen, resolveNamedType);
      return {
        type: 'object',
        additionalProperties: Object.keys(valueType).length === 0 ? true : valueType,
      };
    }

    const schemaProps: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const prop of properties) {
      const propType = this.typeOfProperty(checker, prop);
      if (!propType) continue;
      // Arrow-function typed members are behaviour, not data.
      if (propType.getCallSignatures().length > 0 && propType.getProperties().length === 0) continue;
      const isOptional = !!(prop.flags & ts.SymbolFlags.Optional);
      schemaProps[prop.name] = this.typeToSchema(propType, checker, nextSeen, resolveNamedType);
      if (!isOptional) required.push(prop.name);
    }
    const result: JsonSchema = {
      type: 'object',
      properties: schemaProps,
      ...(required.length ? { required } : {}),
    };
    if (stringIndexInfo) {
      const valueType = this.typeToSchema(stringIndexInfo.type, checker, nextSeen, resolveNamedType);
      result.additionalProperties = Object.keys(valueType).length === 0 ? true : valueType;
    }
    return result;
  }

  // Flatten an intersection type (A & B & C) into a single merged object
  // schema. Each constituent is recursively resolved — if it's an object, its
  // properties are merged. Named nested types become inlined properties in
  // the merged result rather than $ref pointers, since the intersection
  // itself has no name to register. A primitive member (branded string:
  // `string & { __brand }`) makes the whole thing that primitive.
  private flattenIntersection(
    type: T.IntersectionType,
    checker: T.TypeChecker,
    seen: Set<T.Type>,
    resolveNamedType?: ResolveNamedType,
  ): JsonSchema {
    const primitive = type.types.find(
      (m) => m.flags & (ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.Boolean),
    );
    if (primitive) return this.typeToSchema(primitive, checker, seen, resolveNamedType);

    const mergedProps: Record<string, JsonSchema> = {};
    const mergedRequired: string[] = [];
    const seenProps = new Set<string>();

    for (const member of type.types) {
      let resolved = member;
      if (member.flags & ts.TypeFlags.TypeParameter) resolved = checker.getApparentType(member);
      if (!(resolved.flags & ts.TypeFlags.Object)) continue;
      for (const prop of checker.getPropertiesOfType(resolved)) {
        if (!this.isDataProperty(prop)) continue;
        if (seenProps.has(prop.name)) continue;
        const propType = this.typeOfProperty(checker, prop);
        if (!propType) continue;
        seenProps.add(prop.name);
        const isOptional = !!(prop.flags & ts.SymbolFlags.Optional);
        mergedProps[prop.name] = this.typeToSchema(propType, checker, new Set(seen), resolveNamedType);
        if (!isOptional) mergedRequired.push(prop.name);
      }
    }

    return {
      type: 'object',
      properties: mergedProps,
      ...(mergedRequired.length ? { required: mergedRequired } : {}),
    };
  }
}

// ------------------------------------------------------------------ helpers

function skipWrappers(expr: T.Expression): T.Expression {
  let e = expr;
  for (let i = 0; i < 20; i++) {
    if (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    else if (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) {
      // `x as any` hides the real value; `x as Dto` states it
      const t = e.type;
      if (t.kind === ts.SyntaxKind.AnyKeyword || t.kind === ts.SyntaxKind.UnknownKeyword) e = e.expression;
      else return e;
    } else break;
  }
  return e;
}

function declarationInitializer(sym: T.Symbol): T.Expression | undefined {
  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return decl.initializer;
  return undefined;
}

function memberName(name: T.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

function decoratorsOf(node: T.Node): readonly T.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

function decoratorNameOf(dec: T.Decorator): string | undefined {
  const expr = dec.expression;
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) return expr.expression.text;
  if (ts.isIdentifier(expr)) return expr.text;
  return undefined;
}

// `@Body('field') name: string` binds ONE field, not the whole body.
function hasStringArg(dec: T.Decorator): boolean {
  if (!ts.isCallExpression(dec.expression)) return false;
  const first = dec.expression.arguments[0];
  return !!first && ts.isStringLiteralLike(first);
}

function typeNodeName(node: T.TypeNode): string | undefined {
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) return node.typeName.text;
  if (ts.isTypeReferenceNode(node) && ts.isQualifiedName(node.typeName)) return node.typeName.right.text;
  return undefined;
}

function toComponentName(rawName: string | undefined): string | undefined {
  if (!rawName) return undefined;
  if (UTILITY_TYPE_NAMES.has(rawName)) return undefined;
  return rawName;
}

// `Page<UserDto>` -> `PageUserDto` so two instantiations of one generic never
// fight over the same component name; plain `UserDto` stays `UserDto`.
function componentNameForNode(node: T.TypeNode): string | undefined {
  const base = toComponentName(typeNodeName(node));
  if (!base) return undefined;
  if (ts.isTypeReferenceNode(node) && node.typeArguments?.length) {
    const parts: string[] = [];
    for (const arg of node.typeArguments) {
      const n = typeNodeName(arg);
      if (!n) return undefined; // anonymous argument -> inline instead of guessing a name
      parts.push(n);
    }
    return base + parts.join('');
  }
  return base;
}

function unwrapAsyncTypeNode(node: T.TypeNode): T.TypeNode {
  let target = node;
  for (let i = 0; i < 3; i++) {
    if (
      ts.isTypeReferenceNode(target) &&
      ts.isIdentifier(target.typeName) &&
      ASYNC_WRAPPER_NAMES.has(target.typeName.text) &&
      target.typeArguments?.[0]
    ) {
      target = target.typeArguments[0];
    } else {
      break;
    }
  }
  return target;
}

function unwrapAsyncType(type: T.Type, checker: T.TypeChecker): T.Type {
  let current = type;
  for (let i = 0; i < 3; i++) {
    const name = current.symbol?.name;
    if (name && ASYNC_WRAPPER_NAMES.has(name)) {
      const args = checker.getTypeArguments(current as T.TypeReference);
      if (args.length > 0) {
        current = args[0];
        continue;
      }
    }
    break;
  }
  return current;
}

function isGenericInstantiation(type: T.Type): boolean {
  const objectFlags = (type as T.ObjectType).objectFlags;
  if (!(objectFlags & ts.ObjectFlags.Reference)) return false;
  const ref = type as T.TypeReference;
  return ref.target !== ref && (ref.target as T.InterfaceType).typeParameters !== undefined;
}

function dedupeSchemas(schemas: JsonSchema[]): JsonSchema[] {
  const seen = new Set<string>();
  const out: JsonSchema[] = [];
  for (const s of schemas) {
    const key = JSON.stringify(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
