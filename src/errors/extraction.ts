import { HttpStatus } from '@nestjs/common';
import type { JsonSchema } from '../schema/source-schema-extractor';
import { matchBrace, matchParen, splitTopLevel, statementEnd } from './text-utils';

// Per-scan configuration threaded through the extraction helpers. Everything
// project-specific (custom exception classes, example values for template
// interpolations) is injected here instead of being hardcoded.
export interface ExtractionContext {
  /** Custom exception class name -> HTTP status (e.g. `class OutOfStock extends ConflictException`). */
  exceptionStatus: ReadonlyMap<string, number>;
  /** Lower-cased interpolation identifier -> example text for `${...}` inside messages. */
  exampleByName: Readonly<Record<string, string>>;
}

// Realistic stand-ins for common variable names seen inside template-literal
// exception messages. Keyed by the interpolation's leaf identifier
// (lower-cased) so `item.definitionId` and `definitionId` resolve the same.
// Projects extend this through `errors.templateExamples`.
const UUID_EXAMPLE = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
export const DEFAULT_EXAMPLE_BY_NAME: Record<string, string> = {
  key: 'example-key',
  scope: 'member',
  status: 'active',
  type: 'string',
  field: 'name',
  id: UUID_EXAMPLE,
  userid: UUID_EXAMPLE,
  email: 'user@example.com',
  reason: 'invalid state',
  message: 'invalid state',
  value: '2026-01-15',
  action: 'delete',
};

export const DEFAULT_EXTRACTION_CONTEXT: ExtractionContext = {
  exceptionStatus: new Map(),
  exampleByName: DEFAULT_EXAMPLE_BY_NAME,
};

export type { RuntimeErrorVariant } from '../descriptions/runtime-errors';
import type { RuntimeErrorVariant } from '../descriptions/runtime-errors';

// NestJS framework exception class -> HTTP status. Framework knowledge,
// not project knowledge — identical in every NestJS application.
export const STATUS_BY_EXCEPTION: Record<string, number> = {
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
  PreconditionFailedException: 412,
  PayloadTooLargeException: 413,
  UnsupportedMediaTypeException: 415,
  ImATeapotException: 418,
  MisdirectedException: 421,
  UnprocessableEntityException: 422,
  TooManyRequestsException: 429,
  InternalServerErrorException: 500,
  NotImplementedException: 501,
  BadGatewayException: 502,
  ServiceUnavailableException: 503,
  GatewayTimeoutException: 504,
  HttpVersionNotSupportedException: 505,
};

// `new common_1.BadRequestException(` in compiled CJS, or
// `new BadRequestException(` in ts-node — the trailing segment is the
// class name either way.
const NEW_EXPR = /new\s+((?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*))\s*\(/g;

// A raw Express/Nest response write — the OTHER way real code emits an
// HTTP error, alongside `new XException(...)`. Exception filters commonly
// write `response.status(httpStatus).json({...})` directly rather than
// constructing (and immediately unwrapping) an exception object. When
// httpStatus is a literal it's handled exactly like HttpException's 2nd
// arg; when it's a runtime-computed identifier (the common case: derived
// from a status-code lookup table elsewhere in the same module graph),
// `dynamicStatusSeen` below triggers a bounded, non-fabricating fallback:
// every literal 3-digit `NNN: <value>` table entry actually reachable from
// the scanned closure (not just anything numeric — see statusTableEntries)
// is surfaced as a generic, real, source-backed status.
export const STATUS_RESPONSE_CALL = /\.\s*status\s*\(\s*([^()]*?)\s*\)\s*\.\s*(?:json|send)\s*\(/g;

// True when `src` writes an HTTP response with a status that ISN'T a
// literal/HttpStatus.MEMBER — e.g. `response.status(httpStatus).json(...)`
// where `httpStatus` came from a lookup table elsewhere. Literal statuses
// are already fully handled by errorsIn's own STATUS_RESPONSE_CALL pass
// (see there); this only flags the case that pass can't resolve, so walk()
// knows to fall back to reachableStatusTable().
export function hasDynamicStatusResponse(src: string, catchSpans: CatchSpan[]): boolean {
  STATUS_RESPONSE_CALL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STATUS_RESPONSE_CALL.exec(src)) !== null) {
    if (catchSpans.some((c) => c.start < match!.index && match!.index <= c.end)) continue;
    if (parseStatusArg(match[1]) === undefined) return true;
  }
  return false;
}

// Every `new X(...)` in the source whose class name smells like a Nest
// error (HttpException or any *Exception). `throw`, `return`, rxjs
// `throwError(() => new X(...))` all count — each is an error the caller
// can observe.
export function errorsIn(
  src: string,
  ifBlocks: IfBlock[],
  catchSpans: CatchSpan[],
  fileText?: string,
  ctx: ExtractionContext = DEFAULT_EXTRACTION_CONTEXT,
): RuntimeErrorVariant[] {
  const out: RuntimeErrorVariant[] = [];
  NEW_EXPR.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NEW_EXPR.exec(src)) !== null) {
    const className = match[2];
    if (className !== 'HttpException' && !className.endsWith('Exception')) continue;
    const openIdx = match.index + match[0].length - 1;
    const closeIdx = matchParen(src, openIdx);
    if (closeIdx < 0) continue;
    const args = splitTopLevel(src.slice(openIdx + 1, closeIdx));
    const variant = toVariant(className, args, fileText, ctx);
    if (!variant) continue;
    // A throw inside a catch block is either (a) a real, deliberate
    // gRPC-error-to-HTTP-exception mapping — extremely common in this
    // codebase's gateway services (`catch (err) { if (err.message.includes
    // ('NO_ROOM')) throw new NotFoundException('...'); }`) and just as
    // documentable as any other throw — or (b) generic noise, a
    // guard/service recovering from an unexpected failure with a bare
    // `throw new XException()` carrying no distinguishing content. Only
    // (b) is unlabeled/unhelpful in Swagger docs, so only skip when the
    // constructed exception has no message/template/schema of its own.
    const inCatch = catchSpans.some((c) => c.start < match!.index && match!.index <= c.end);
    if (inCatch && !variant.message && !variant.schema) continue;
    const condition = innermostCondition(ifBlocks, match.index);
    if (condition && !variant.message && !variant.schema) {
      variant.condition = condition;
    }
    // Always kept: call-site literals can prove this guard false (scanner narrowing).
    if (condition) variant.when = condition;
    if (inCatch) variant.inCatch = true;
    out.push(variant);
  }
  // The other real error-emission shape in this project: exception
  // filters writing the response directly (`response.status(N).json(...)`)
  // instead of constructing an exception object. Only literal statuses are
  // handled here — a runtime-computed status falls back to
  // hasDynamicStatusResponse()/reachableStatusTable() in walk().
  STATUS_RESPONSE_CALL.lastIndex = 0;
  while ((match = STATUS_RESPONSE_CALL.exec(src)) !== null) {
    if (catchSpans.some((c) => c.start < match!.index && match!.index <= c.end)) continue;
    const status = parseStatusArg(match[1]);
    if (status === undefined) continue;
    const openIdx = match.index + match[0].length - 1;
    const closeIdx = matchParen(src, openIdx);
    const bodyArg = closeIdx >= 0 ? splitTopLevel(src.slice(openIdx + 1, closeIdx))[0] : undefined;
    const variant = withBody(bodyArg, status, undefined, ctx);
    out.push(variant);
  }
  return out;
}

function toVariant(
  className: string,
  args: string[],
  fileText: string | undefined,
  ctx: ExtractionContext,
): RuntimeErrorVariant | undefined {
  if (className === 'HttpException') {
    const status = parseStatusArg(args[1]) ?? 500;
    return withBody(args[0], status, fileText, ctx);
  }
  const status = ctx.exceptionStatus.get(className) ?? STATUS_BY_EXCEPTION[className] ?? 500;
  return withBody(args[0], status, fileText, ctx);
}

function withBody(
  firstArg: string | undefined,
  status: number,
  fileText: string | undefined,
  ctx: ExtractionContext,
): RuntimeErrorVariant {
  if (firstArg === undefined) return { status };
  const parsed = parseFirstArg(firstArg, fileText);
  if (!parsed) return { status };
  if (parsed.kind === 'message') return { status, message: parsed.value };
  if (parsed.kind === 'template') {
    // Runtime values inside `${...}` aren't statically known, but the
    // surrounding template text is real, documentable content — far more
    // useful in Swagger than falling back to the raw `if` condition (e.g.
    // "when populatedFields.length > 1"). Each interpolation is replaced
    // with a plausible example value (looked up by its variable name) so
    // the rendered message reads like a real error instead of leaking
    // source code (`{key}`, `{populatedFields.map(...).join(', ')}`).
    const readable = parsed.value
      .slice(1, -1)
      .replace(/\$\{\s*([^}]*?)\s*\}/g, (_, expr: string) => exampleForExpr(expr, ctx));
    return { status, isTemplate: true, templateRaw: parsed.value, message: readable };
  }
  return { status, message: parsed.message, schema: parsed.schema };
}

type FirstArg =
  | { kind: 'message'; value: string }
  | { kind: 'template'; value: string }
  | { kind: 'object'; message?: string; schema: JsonSchema };

function parseFirstArg(raw: string, fileText?: string): FirstArg | undefined {
  const arg = raw.trim();
  if (!arg) return undefined;
  const first = arg[0];
  if (first === "'" || first === '"') {
    const value = parseQuoted(arg, first);
    return value === undefined ? undefined : { kind: 'message', value };
  }
  if (first === '`') {
    if (arg.length < 2 || !arg.endsWith('`')) return undefined;
    const inner = arg.slice(1, -1);
    return inner.includes('${') ? { kind: 'template', value: arg } : { kind: 'message', value: inner };
  }
  if (first === '{') {
    return parseObjectArg(arg);
  }
  // A bare identifier (`throw new NotFoundException(SOME_MESSAGE_CONST)`)
  // is real, static, documentable content — just declared as a
  // module-level const in the same file rather than inlined. Resolve it
  // there rather than treating it as an opaque runtime expression.
  if (fileText && /^[A-Za-z_$][\w$]*$/.test(arg)) {
    const constMatch = new RegExp(`\\bconst\\s+${arg}\\s*=\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`).exec(fileText);
    if (constMatch) {
      const quote = constMatch[1] as "'" | '"' | '`';
      return quote === '`'
        ? { kind: 'message', value: constMatch[2] }
        : { kind: 'message', value: parseQuoted(`${quote}${constMatch[2]}${quote}`, quote as "'" | '"') ?? constMatch[2] };
    }
  }
  // Identifier / variable / expression — message not statically known.
  return undefined;
}

// Best-effort example value for one `${...}` interpolation inside a template
// exception message. A method-chain expression (`populatedFields.map(...).join(', ')`)
// has no static value, so it's reduced to its root identifier's example
// instead — the chain itself carries no documentable content.
function exampleForExpr(expr: string, ctx: ExtractionContext): string {
  const trimmed = expr.replace(/\s+/g, ' ').trim();
  const dottedPath = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(trimmed) ? trimmed : undefined;
  const root = /^[A-Za-z_$][\w$]*/.exec(trimmed)?.[0];
  const leaf = (dottedPath ?? root ?? trimmed).split('.').pop() ?? trimmed;
  const byLeaf = ctx.exampleByName[leaf.toLowerCase()];
  if (byLeaf) return byLeaf;
  const byRoot = root ? ctx.exampleByName[root.toLowerCase()] : undefined;
  if (byRoot) return byRoot;
  if (/id$/i.test(leaf)) return UUID_EXAMPLE;
  if (/at$/i.test(leaf) && /^[a-z]/.test(leaf)) return '2026-01-15T10:30:00.000Z';
  if (/^(is|has)[A-Z]/.test(leaf)) return 'true';
  if (/type$/i.test(leaf)) return 'string';
  // Unknown shape — kebab-case the identifier itself as a legible stand-in
  // rather than leaking the raw expression source into the docs.
  const kebab = leaf.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  return `example-${kebab}`;
}

function parseQuoted(arg: string, quote: "'" | '"'): string | undefined {
  if (arg.length < 2 || !arg.endsWith(quote)) return undefined;
  return arg
    .slice(1, -1)
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

// `{ message, token_not_valid: true }` -> schema properties inferred from
// each value's literal shape; `X ?? <literal>` fallbacks count as the
// literal. A static `message: '...'` string doubles as the variant message.
function parseObjectArg(arg: string): FirstArg | undefined {
  if (!arg.endsWith('}')) return undefined;
  const entries = splitTopLevel(arg.slice(1, -1));
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  let message: string | undefined;
  for (const entry of entries) {
    const colon = entry.indexOf(':');
    if (colon < 0) {
      // Shorthand property (`{ message, token_not_valid: true }`) — the
      // value is a runtime variable, so only the key (string) is known.
      const shorthand = entry.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(shorthand)) {
        properties[shorthand] = { type: 'string' };
        required.push(shorthand);
      }
      continue;
    }
    const key = entry
      .slice(0, colon)
      .trim()
      .replace(/^['"`]|['"`]$/g, '');
    if (!key) continue;
    const value = entry.slice(colon + 1).trim();
    const prop = inferValueSchema(value);
    if (key === 'message' && prop.example !== undefined && typeof prop.example !== 'object') {
      message = String(prop.example);
      prop.example = message;
    }
    properties[key] = prop;
    required.push(key);
  }
  if (Object.keys(properties).length === 0) return undefined;
  const schema: JsonSchema = { type: 'object', properties, required };
  return { kind: 'object', message, schema };
}

function inferValueSchema(value: string): JsonSchema {
  const fromLiteral = literalSchema(value);
  if (fromLiteral) return fromLiteral;
  // `result.waitReason ?? 'UNKNOWN'` — the fallback is the honest example.
  const fallbackSplit = value.split('??');
  if (fallbackSplit.length > 1) {
    const fallback = literalSchema(fallbackSplit[fallbackSplit.length - 1].trim());
    if (fallback) return fallback;
  }
  if (value.startsWith('[')) return { type: 'array', items: { type: 'string' } };
  if (value.startsWith('{')) return { type: 'object' };
  return { type: 'string' };
}

function literalSchema(value: string): JsonSchema | undefined {
  const v = value.trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    const parsed = parseQuoted(v, v[0] as "'" | '"');
    return parsed === undefined ? undefined : { type: 'string', example: parsed };
  }
  if (v.startsWith('`') && v.endsWith('`') && !v.includes('${')) {
    return { type: 'string', example: v.slice(1, -1) };
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) return { type: 'number', example: Number(v) };
  if (v === 'true' || v === 'false') return { type: 'boolean', example: v === 'true' };
  return undefined;
}

// HttpException's 2nd constructor arg: `402`, or
// `common_1.HttpStatus.PAYMENT_REQUIRED` in compiled output.
export function parseStatusArg(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const arg = raw.trim();
  if (/^\d+$/.test(arg)) return parseInt(arg, 10);
  const member = arg.match(/(?:[\w$]+\.)*HttpStatus\.([A-Za-z0-9_]+)$/);
  if (member) {
    const resolved = (HttpStatus as unknown as Record<string, unknown>)[member[1]];
    if (typeof resolved === 'number') return resolved;
  }
  return undefined;
}

export function variantKey(v: RuntimeErrorVariant): string {
  return `${v.status}::${v.message ?? ''}::${v.isTemplate ? 'T' : ''}::${v.condition ?? ''}::${v.schema ? JSON.stringify(v.schema) : ''}`;
}

export interface IfBlock {
  cond: string;
  condEnd: number;
  start: number;
  end: number;
}

export interface CatchSpan {
  start: number;
  end: number;
}


const IF_EXPR = /if\s*\(/g;

const CATCH_EXPR = /catch\s*(\([^)]*\))?\s*\{/g;

const MAX_IF_BLOCKS = 200;

// Every `if (cond) { ... }` / `if (cond) single;` in the source, with the
// condition text and the controlled span. Lets a bare
// `throw new UnauthorizedException()` be documented as "401 when
// <condition>" instead of collapsing four identical-looking throws into
// one generic entry.
export function collectIfBlocks(src: string): { ifBlocks: IfBlock[]; catchSpans: CatchSpan[] } {
  const out: IfBlock[] = [];
  IF_EXPR.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IF_EXPR.exec(src)) !== null && out.length < MAX_IF_BLOCKS) {
    const openIdx = match.index + match[0].length - 1;
    const condEnd = matchParen(src, openIdx);
    if (condEnd < 0) continue;
    const cond = src
      .slice(openIdx + 1, condEnd)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 150);
    if (!cond) continue;
    let cursor = condEnd + 1;
    while (cursor < src.length && /\s/.test(src[cursor])) cursor++;
    // Skip line/block comments between ')' and the statement.
    if (src.startsWith('//', cursor)) {
      const nl = src.indexOf('\n', cursor);
      cursor = nl < 0 ? src.length : nl + 1;
      while (cursor < src.length && /\s/.test(src[cursor])) cursor++;
    }
    if (src.startsWith('/*', cursor)) {
      const close = src.indexOf('*/', cursor + 2);
      cursor = close < 0 ? src.length : close + 2;
      while (cursor < src.length && /\s/.test(src[cursor])) cursor++;
    }
    let end: number;
    if (src[cursor] === '{') {
      end = matchBrace(src, cursor);
      if (end < 0) continue;
    } else {
      end = statementEnd(src, cursor);
    }
    out.push({ cond, condEnd, start: match.index, end });
  }
  // `catch (e) { ... }` bodies are internal error-recovery paths, not
  // documentable user-facing conditions — collected separately so
  // errorsIn() can drop any throw inside them outright.
  const catchSpans: CatchSpan[] = [];
  CATCH_EXPR.lastIndex = 0;
  while ((match = CATCH_EXPR.exec(src)) !== null && catchSpans.length < MAX_IF_BLOCKS) {
    const openBrace = match.index + match[0].length - 1;
    const end = matchBrace(src, openBrace);
    if (end < 0) continue;
    catchSpans.push({ start: openBrace, end });
  }
  return { ifBlocks: out, catchSpans };
}

// Innermost (smallest-span) if-block whose body contains pos. The throw
// must sit after the condition's closing paren so `if (make(new X()))`
// style conditions never self-attribute.
export function innermostCondition(ifBlocks: IfBlock[], pos: number): string | undefined {
  let best: IfBlock | undefined;
  for (const block of ifBlocks) {
    if (block.condEnd < pos && pos <= block.end) {
      if (!best || block.start >= best.start) best = block;
    }
  }
  return best?.cond;
}
