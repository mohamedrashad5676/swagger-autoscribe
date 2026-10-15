import * as ts from 'typescript';
import { evidenceAt, EVIDENCE, type Evidence } from './evidence';
import type { AssertionSeed } from './conflicts';

// Discovery extension point. The core reader extracts what any TypeScript
// method states (calls, throws, guards, comments); everything that depends on
// a framework or persistence convention is read by an adapter, which fills the
// shared fact slots on MethodSourceInfo and records evidence for each claim.
export interface MethodReadContext {
  info: MethodSourceInfo;
  method: ts.MethodDeclaration;
  add(list: string[], value: string): void;
  evidence(node: ts.Node, kind: string, details?: Record<string, unknown>): void;
  // States a stance about a fact (see conflicts.ts), backed by evidence at `node`.
  // Positive and negative stances are both recorded; disagreement is judged later.
  assert(node: ts.Node, kind: string, seed: AssertionSeed, details?: Record<string, unknown>): void;
}
export interface MethodFactAdapter {
  readonly name: string;
  onMethod?(ctx: MethodReadContext): void;
  onNode?(node: ts.Node, ctx: MethodReadContext): void;
  onFinish?(ctx: MethodReadContext): void;
}

export const SWAGGER_IGNORE_TAG = '@swagger-ignore';
export const SWAGGER_IGNORE_RE = /@swagger-ignore\b/;

// `throw new X('message')` or `throw new X({ code, message })`.
export interface ThrownError {
  type: string;
  // Last segment of `status.NOT_FOUND` style codes.
  code?: string;
  message?: string;
  // 1-based source line of the throw statement.
  line?: number;
  // Condition text of the nearest enclosing `if` whose branch contains the throw:
  // observed, never inferred. Absent for a throw with no visible condition.
  when?: string;
  // The throw sits in some branch (if / switch / ternary / catch) whether or not its condition was read.
  branch?: boolean;
  // HTTP status of the failure, supplied by a framework adapter.
  status?: number;
  // How that status was obtained: the exception type fixes it, or a code was
  // translated through a conventional table (not verified against the project).
  statusBasis?: 'exception-type' | 'code-mapping';
}

// `if (<cond>) { ...; throw new X(...) }` — the condition that guards a
// failure, used to state a rule when the message alone is not enough.
export interface GuardCondition {
  cond: string;
  thrown: ThrownError;
}

// A persistence write on a `this.<model>` receiver. `set` maps field -> the
// initializer's source text; pulled/pushed are array fields touched by
// $pull / $push / $addToSet.
export interface DataWrite {
  receiver: string;
  op: string;
  set: Record<string, string>;
  pulled: string[];
  pushed: string[];
  // The write marks the record as deleted without removing it.
  softDeletes: boolean;
}

// Facts read from one method's source. Everything here is taken verbatim
// from the AST — nothing is inferred.
export interface MethodSourceInfo {
  ignored: boolean;
  jsdoc?: string;
  returnType?: string;
  // Parameter names in declaration order (maps call arguments to the callee's names).
  params: string[];
  // `this.<service>.<method>` call chains in the method body, in order.
  serviceCalls: string[];
  // Class names used in `throw new X(...)` inside the method body.
  thrown: string[];
  throws: ThrownError[];
  guards: GuardCondition[];
  // Remote methods the method invokes (filled by an RPC adapter).
  rpcCalls: string[];
  // Rpc name this method serves (filled by an RPC adapter).
  handlesRpc?: string;
  // `this.<method>(...)` calls to sibling methods of the same class.
  sameClassCalls: string[];
  // Calls to free functions, e.g. `generateJoinCode()`.
  plainCalls: string[];
  writes: DataWrite[];
  // String-literal `action:` values passed to audit `.record(...)` calls.
  auditActions: string[];
  // String-literal event names passed to `.emit(...)` / `.publish(...)`.
  emitted: string[];
  // A log/comment string in the body says the operation is an idempotent no-op.
  idempotent: boolean;
  // Filters on the soft-delete field being empty: deleted records are excluded.
  filtersDeleted: boolean;
  // The method merges its input into an existing record (only supplied fields change).
  mergesInput: boolean;
  // Handler acts for the authenticated caller (filled by an identity adapter).
  usesAuthUser: boolean;
  // Object-literal keys whose value comes from the authenticated user,
  // e.g. `ownerUserId: <caller>.userId` -> 'ownerUserId'.
  authUserProps: string[];
  // Where each claim above was observed.
  evidence: Evidence[];
  // Stances about facts that adapters read (positive and negative alike), each
  // with the evidence it rests on; compared for disagreement by conflicts.ts.
  assertions: { seed: AssertionSeed; evidence: Evidence }[];
}

export function leadingComments(node: ts.Node, text: string): string[] {
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  return ranges.map((r) => text.slice(r.pos, r.end));
}

export function extractJsdoc(comments: string[]): string | undefined {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (!c.startsWith('/**')) continue;
    const lines = c
      .replace(/^\/\*\*/, '')
      .replace(/\*\/$/, '')
      .split('\n')
      .map((l) => l.replace(/^\s*\*\s?/, '').trim());
    const out: string[] = [];
    for (const line of lines) {
      if (line.startsWith('@')) break;
      out.push(line);
    }
    const doc = out.join(' ').replace(/\s+/g, ' ').trim();
    return doc || undefined;
  }
  return undefined;
}

export function readCtorTypes(cls: ts.ClassLikeDeclaration): Map<string, string> {
  const map = new Map<string, string>();
  for (const member of cls.members) {
    if (!ts.isConstructorDeclaration(member)) continue;
    for (const p of member.parameters) {
      if (!ts.isIdentifier(p.name) || !p.type || !ts.isTypeReferenceNode(p.type)) continue;
      map.set(p.name.text, p.type.typeName.getText());
    }
  }
  return map;
}

export function stringValue(node: ts.Node | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

export function propValue(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === name) return p.initializer;
  }
  return undefined;
}

function readThrow(expr: ts.NewExpression): ThrownError | undefined {
  // `new X()` or, in compiled JS, `new common_1.X()`
  const type = ts.isIdentifier(expr.expression)
    ? expr.expression.text
    : ts.isPropertyAccessExpression(expr.expression)
      ? expr.expression.name.text
      : undefined;
  if (!type) return undefined;
  const out: ThrownError = { type };
  const [arg] = expr.arguments ?? [];
  if (!arg) return out;
  if (ts.isObjectLiteralExpression(arg)) {
    out.message = stringValue(propValue(arg, 'message'));
    const code = propValue(arg, 'code')?.getText();
    if (code) out.code = code.split('.').pop();
  } else {
    out.message = stringValue(arg);
  }
  return out;
}

export function emptyMethodInfo(overrides: Partial<MethodSourceInfo> = {}): MethodSourceInfo {
  return {
    ignored: false,
    params: [],
    serviceCalls: [],
    thrown: [],
    throws: [],
    guards: [],
    rpcCalls: [],
    sameClassCalls: [],
    plainCalls: [],
    writes: [],
    auditActions: [],
    emitted: [],
    idempotent: false,
    filtersDeleted: false,
    mergesInput: false,
    usesAuthUser: false,
    authUserProps: [],
    evidence: [],
    assertions: [],
    ...overrides,
  };
}

// Where a call sits: the observed `if` condition (only when the call is in that
// branch) and the argument texts, so a callee can be reached under a condition.
function callContext(call: ts.CallExpression): { when?: string; args: string[] } {
  const where = branchOf(call);
  return { ...(where.when ? { when: where.when } : {}), args: call.arguments.map((a) => a.getText()) };
}

// Walks up from a throw to find the branch it lives in. `when` is only set for
// an `if` whose then-branch contains the throw (the condition that triggers it).
function branchOf(node: ts.Node): { branch: boolean; when?: string } {
  let child: ts.Node = node;
  let branch = false;
  for (let cur: ts.Node | undefined = node.parent; cur && !ts.isMethodDeclaration(cur); child = cur, cur = cur.parent) {
    if (ts.isIfStatement(cur)) {
      branch = true;
      if (cur.thenStatement === child) return { branch, when: cur.expression.getText().replace(/\s+/g, ' ') };
    } else if (ts.isCaseClause(cur) || ts.isDefaultClause(cur) || ts.isConditionalExpression(cur) || ts.isCatchClause(cur)) {
      branch = true;
    }
  }
  return { branch };
}

export function readMethodInfo(method: ts.MethodDeclaration, text: string, adapters: readonly MethodFactAdapter[] = []): MethodSourceInfo {
  const comments = leadingComments(method, text);
  const info = emptyMethodInfo({
    ignored: comments.some((c) => SWAGGER_IGNORE_RE.test(c)),
    jsdoc: extractJsdoc(comments),
    returnType: method.type?.getText(),
    params: method.parameters.map((p) => p.name.getText()),
  });
  const add = (list: string[], v: string): void => {
    if (!list.includes(v)) list.push(v);
  };
  const ctx: MethodReadContext = {
    info,
    method,
    add,
    evidence: (node, kind, details) => info.evidence.push(evidenceAt(node, kind, details)),
    assert: (node, kind, seed, details) => info.assertions.push({ seed, evidence: evidenceAt(node, kind, details) }),
  };
  for (const adapter of adapters) adapter.onMethod?.(ctx);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        add(info.plainCalls, node.expression.text);
        ctx.evidence(node, EVIDENCE.plainCall, { call: node.expression.text, ...callContext(node) });
      }
      if (ts.isPropertyAccessExpression(node.expression)) {
        const callee = node.expression;
        const chain = callee.getText();
        if (/^this\.\w+\.\w+$/.test(chain)) {
          add(info.serviceCalls, chain);
          ctx.evidence(node, EVIDENCE.serviceCall, { call: chain, ...callContext(node) });
        }
        if (/^this\.\w+$/.test(chain)) {
          add(info.sameClassCalls, callee.name.text);
          ctx.evidence(node, EVIDENCE.sameClassCall, { call: callee.name.text, ...callContext(node) });
        }
      }
    }
    if (ts.isIfStatement(node)) {
      const throwStmt = ts.isThrowStatement(node.thenStatement)
        ? node.thenStatement
        : ts.isBlock(node.thenStatement)
          ? node.thenStatement.statements.find(ts.isThrowStatement)
          : undefined;
      if (throwStmt?.expression && ts.isNewExpression(throwStmt.expression)) {
        const thrown = readThrow(throwStmt.expression);
        if (thrown) {
          info.guards.push({ cond: node.expression.getText(), thrown });
          ctx.evidence(node, EVIDENCE.guard, { cond: node.expression.getText() });
        }
      }
    }
    if (ts.isThrowStatement(node) && node.expression && ts.isNewExpression(node.expression)) {
      const thrown = readThrow(node.expression);
      if (thrown) {
        add(info.thrown, thrown.type);
        thrown.line = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const where = branchOf(node);
        thrown.branch = where.branch;
        if (where.when) thrown.when = where.when;
        info.throws.push(thrown);
        ctx.evidence(node, EVIDENCE.throws, { type: thrown.type, code: thrown.code });
      }
    }
    for (const adapter of adapters) adapter.onNode?.(node, ctx);
    ts.forEachChild(node, visit);
  };
  if (method.body) visit(method.body);
  for (const adapter of adapters) adapter.onFinish?.(ctx);
  return info;
}
