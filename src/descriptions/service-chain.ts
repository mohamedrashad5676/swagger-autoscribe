import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { EVIDENCE } from './evidence';
import { diagnostics } from './diagnostics';
import { walkFiles } from '../fs-utils';
import type { ControllerRegistry } from './controller-registry';
import { readCtorTypes, readMethodInfo, type MethodSourceInfo } from './method-facts';
import type { CallEdge } from './error-reachability';
import type { ChainProfile, ChainView, Hop } from './hop-provider';
import type { EntityFacts } from './entity-facts';

export type { EntityFacts, EntityField } from './entity-facts';

const logger = diagnostics('ServiceChainIndex');

const MAX_DEPTH = 4;
const MAX_STEPS = 40;
const MAX_HERITAGE = 4;

// One method visited while following an endpoint's call chain.
export interface ChainStep {
  root: string;
  className: string;
  methodName: string;
  depth: number;
  info: MethodSourceInfo;
  // Calls from the endpoint handler to this method, e.g. ['Ctl.run', 'Svc.run', 'Helper.check'].
  path: string[];
  // Reached through code that belongs to the shared/ancestor root rather than the project's own.
  shared: boolean;
  // The call that led here (absent for the handler) and the branch conditions observed on the way.
  via?: CallEdge;
  reachedWhen: string[];
}

export interface ChainFacts {
  steps: ChainStep[];
  // The chain crossed a remote call into an indexed backend service.
  reachedBackend: boolean;
  // The endpoint is served by the shared generic CRUD base classes.
  crud: boolean;
  entity?: EntityFacts;
}

export interface ClassIndex {
  ctor: Map<string, string>;
  methods: Map<string, MethodSourceInfo>;
  parent?: { name: string; typeArgs: string[] };
  // String literals passed to `super(...)` in the constructor.
  superArgs: string[];
  entity?: EntityFacts;
}

export interface HandlerRef {
  root: string;
  className: string;
  methodName: string;
}

// Static, deterministic call-chain resolver. It follows `this.<dep>.<method>()`
// and same-class calls inside every indexed root; any other hop (RPC, generic
// CRUD base, …) comes from the profile's HopProviders. Roots, the entry root
// and ancestor lookup are described by the ChainProfile, so the resolver has
// no project layout of its own. Nothing is executed or fetched. Classes are
// scoped per root.
export class ServiceChainIndex {
  private readonly roots = new Map<string, Map<string, ClassIndex>>();
  private built = false;
  private readonly view: ChainView;

  constructor(
    private readonly registry: ControllerRegistry,
    private readonly profile: ChainProfile,
  ) {
    this.view = {
      hasRoot: (root) => this.roots.has(root),
      isEntryRoot: (root) => root === this.profile.entryRoot,
      classOf: (root, className) => this.roots.get(root)?.get(className),
      entityOf: (root, className) => this.entityOf(root, className),
    };
  }

  build(entrySrcRoot: string | string[]): void {
    if (this.built) return;
    this.built = true;
    const entryRoots = Array.isArray(entrySrcRoot) ? entrySrcRoot : [entrySrcRoot];
    for (const dir of entryRoots) this.scanRoot(this.profile.entryRoot, dir, this.profile.entrySuffixes);
    for (const spec of this.profile.discoverRoots(entryRoots[0])) {
      if (spec.fallback && this.roots.has(spec.name)) continue;
      this.scanRoot(spec.name, spec.dir, spec.suffixes);
    }
    logger.log(`Indexed ${this.roots.size} source roots`);
  }

  private readEntity(node: ts.ClassLikeDeclaration): EntityFacts | undefined {
    for (const provider of this.profile.schemaProviders) {
      const entity = provider.readEntity(node);
      if (entity) return entity;
    }
    return undefined;
  }

  private scanRoot(root: string, dir: string, suffixes: string[]): void {
    const files = walkFiles(dir, {
      filter: (_full, name) =>
        !/\.(spec|test)\.[tj]s$/.test(name) && !name.endsWith('.d.ts') && !name.endsWith('.map') && suffixes.some((s) => name.endsWith(s)),
    });
    for (const file of files) this.scanSource(root, file);
  }

  // Exposed for tests (virtual sources).
  // Test hook: index extra files under an arbitrary root, e.g. the compiled
  // fallback shared package, exactly as `build()` does when its `src` is absent.
  scanDirectory(root: string, dir: string, suffixes: string[]): void {
    this.scanRoot(root, dir, suffixes);
    this.built = true;
  }

  scanSource(root: string, filePath: string, textOverride?: string): void {
    const text = textOverride ?? fs.readFileSync(filePath, 'utf8');
    const kind = filePath.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.ES2023, true, kind);
    const classes = this.roots.get(root) ?? new Map<string, ClassIndex>();
    this.roots.set(root, classes);

    // `class X {}` and the compiled form `let X = class X {}` (decorated classes in dist).
    const classLikes: { name: string; node: ts.ClassLikeDeclaration }[] = [];
    ts.forEachChild(sf, (top) => {
      if (ts.isClassDeclaration(top) && top.name) classLikes.push({ name: top.name.text, node: top });
      if (ts.isVariableStatement(top)) {
        for (const decl of top.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer && ts.isClassExpression(decl.initializer)) {
            classLikes.push({ name: decl.name.text, node: decl.initializer });
          }
        }
      }
    });
    for (const { name: className, node } of classLikes) {
      const index: ClassIndex = {
        ctor: readCtorTypes(node),
        methods: new Map(),
        superArgs: [],
        entity: this.readEntity(node),
      };
      const ext = node.heritageClauses
        ?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
        ?.types[0];
      if (ext) {
        index.parent = {
          name: ext.expression.getText(),
          typeArgs: (ext.typeArguments ?? []).map((t) => t.getText()),
        };
      }
      for (const member of node.members) {
        if (ts.isConstructorDeclaration(member) && member.body) {
          const visitSuper = (n: ts.Node): void => {
            if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.SuperKeyword) {
              index.superArgs = n.arguments.filter(ts.isStringLiteralLike).map((a) => a.text);
            }
            ts.forEachChild(n, visitSuper);
          };
          visitSuper(member.body);
        }
        if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
        const info = readMethodInfo(member, text, this.profile.methodAdapters);
        index.methods.set(member.name.text, info);
        for (const provider of this.profile.providers) provider.indexMethod?.(root, className, member.name.text, info, this.view);
      }
      classes.set(className, index);
    }
  }

  // Finds `method` on the class or, failing that, on its ancestors (same
  // root first, then the shared package).
  private findMethod(
    root: string,
    className: string,
  ): (method: string) => { at: HandlerRef; info: MethodSourceInfo; cls: ClassIndex } | undefined {
    return (method) => {
      let curRoot = root;
      let curName: string | undefined = className;
      for (let i = 0; i < MAX_HERITAGE && curName; i++) {
        const cls: ClassIndex | undefined = this.roots.get(curRoot)?.get(curName);
        if (!cls) return undefined;
        const info = cls.methods.get(method);
        if (info) return { at: { root: curRoot, className: curName, methodName: method }, info, cls };
        const parent: string | undefined = cls.parent?.name;
        if (!parent) return undefined;
        curRoot = this.rootOfParent(curRoot, parent);
        curName = parent;
      }
      return undefined;
    };
  }

  // Where an ancestor class lives: the same root first, then the declared shared/library roots,
  // then any other indexed root that declares it.
  private rootOfParent(curRoot: string, parent: string): string {
    if (this.roots.get(curRoot)?.has(parent)) return curRoot;
    const preferred = [this.profile.ancestorRoot, ...(this.profile.ancestorRoots ?? [])].filter((r): r is string => !!r);
    for (const r of preferred) if (this.roots.get(r)?.has(parent)) return r;
    for (const [r, classes] of this.roots) if (classes.has(parent)) return r;
    return this.profile.ancestorRoot ?? curRoot;
  }

  private isSharedRoot(root: string): boolean {
    return root === this.profile.ancestorRoot || (this.profile.ancestorRoots ?? []).includes(root);
  }

  private entityOf(root: string, className: string): EntityFacts | undefined {
    let curRoot = root;
    let curName: string | undefined = className;
    for (let i = 0; i < MAX_HERITAGE && curName; i++) {
      const cls: ClassIndex | undefined = this.roots.get(curRoot)?.get(curName);
      if (!cls) return undefined;
      const entityName = cls.parent?.typeArgs[0];
      if (entityName) {
        const classes = this.roots.get(curRoot);
        // The type argument may be an alias of the entity class; the first candidate that exists wins.
        const found = this.profile.schemaProviders.flatMap((p) => p.entityClassNames(entityName)).find((n) => classes?.has(n));
        const entity = found === undefined ? undefined : classes?.get(found)?.entity;
        if (entity) return entity;
      }
      const parent: string | undefined = cls.parent?.name;
      if (!parent) return undefined;
      curRoot = this.rootOfParent(curRoot, parent);
      curName = parent;
    }
    return undefined;
  }

  resolve(controllerClassName: string, methodName: string): ChainFacts {
    const out: ChainFacts = { steps: [], reachedBackend: false, crud: false };
    const handler = this.registry.getMethod(controllerClassName, methodName);
    if (!handler) return out;
    this.visit(
      { root: this.profile.entryRoot, className: controllerClassName, methodName },
      handler,
      (prop) => this.registry.getDependencyType(controllerClassName, prop),
      0,
      new Set<string>(),
      out,
    );
    return out;
  }

  private visit(
    at: HandlerRef,
    info: MethodSourceInfo,
    depType: (prop: string) => string | undefined,
    depth: number,
    seen: Set<string>,
    out: ChainFacts,
    trail: string[] = [],
    entry: { via?: CallEdge; reachedWhen: string[] } = { reachedWhen: [] },
  ): void {
    const key = `${at.root}:${at.className}.${at.methodName}`;
    if (seen.has(key) || out.steps.length >= MAX_STEPS) return;
    seen.add(key);
    const path = [...trail, `${at.className}.${at.methodName}`];
    out.steps.push({ ...at, depth, info, path, shared: this.isSharedRoot(at.root), ...(entry.via ? { via: entry.via } : {}), reachedWhen: entry.reachedWhen });
    if (depth >= MAX_DEPTH) return;

    const apply = (hop: Hop): void => {
      if (hop.crud) out.crud = true;
      if (hop.reachedBackend) out.reachedBackend = true;
      if (hop.entity) out.entity = out.entity ?? hop.entity;
      if (!hop.target) return;
      if (hop.followCalls) {
        next(hop.target.root, hop.target.className, hop.target.methodName);
        return;
      }
      const found = this.findMethod(hop.target.root, hop.target.className)(hop.target.methodName);
      if (found) this.visit(found.at, found.info, (prop) => found.cls.ctor.get(prop), depth + 1, seen, out, path, { reachedWhen: entry.reachedWhen });
    };

    // The call edge for one call: where it is, the observed branch condition
    // (only when every call site is inside a branch) and the argument texts.
    const edgeFor = (kind: string, call: string, callee: string): CallEdge | undefined => {
      const sites = info.evidence.filter((e) => e.kind === kind && e.details?.call === call);
      if (sites.length === 0) return undefined;
      const first = sites[0];
      const conditional = sites.every((e) => typeof e.details?.when === 'string');
      return {
        caller: path[path.length - 1],
        callee,
        sourceFile: first.sourceFile,
        ...(first.line !== undefined ? { line: first.line } : {}),
        ...(conditional ? { condition: String(first.details?.when) } : {}),
        args: Array.isArray(first.details?.args) ? (first.details?.args as string[]) : [],
      };
    };

    const next = (root: string, className: string, method: string, edge?: CallEdge): void => {
      const found = this.findMethod(root, className)(method);
      if (found) {
        const reachedWhen = edge?.condition ? [...entry.reachedWhen, edge.condition] : entry.reachedWhen;
        this.visit(found.at, found.info, (prop) => found.cls.ctor.get(prop), depth + 1, seen, out, path, { ...(edge ? { via: edge } : {}), reachedWhen });
      }
      const target = { root, className, methodName: method };
      for (const provider of this.profile.providers) {
        for (const hop of provider.hopsFromCall?.(target, this.view) ?? []) apply(hop);
      }
    };

    for (const call of info.serviceCalls) {
      const [, prop, method] = call.split('.');
      const type = depType(prop);
      if (type) next(at.root, type, method, edgeFor(EVIDENCE.serviceCall, call, `${type}.${method}`));
    }
    for (const m of info.sameClassCalls) next(at.root, at.className, m, edgeFor(EVIDENCE.sameClassCall, m, `${at.className}.${m}`));

    for (const provider of this.profile.providers) {
      for (const hop of provider.hopsFromMethod?.(at, info, this.view) ?? []) apply(hop);
    }
  }
}
