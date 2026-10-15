import * as fs from 'node:fs';
import * as path from 'node:path';
import { dirExists, fileExists, readTextSafe } from '../fs-utils';
import { failureStatusAdapter } from './adapters/failure-status';
import { forwardingBaseHopProvider } from './adapters/forwarding-hops';
import { identitySourceAdapter, type IdentityConvention } from './adapters/identity-source';
import { DECORATOR_ORM, ormSchemaProvider, type OrmConvention } from './adapters/orm-entities';
import { persistenceConventions, persistenceWriteAdapter, type PersistenceConvention } from './adapters/persistence-writes';
import { rpcHopProvider } from './adapters/rpc-hops';
import { rpcSourceAdapter } from './adapters/rpc-source';
import { signalMarkersAdapter } from './adapters/signal-markers';
import type { DescriptionConventions } from './conventions';
import type { ChainProfile, RootSpec } from './hop-provider';
import { diagnostics } from './diagnostics';

const logger = diagnostics('DescriptionProfile');

export interface DescriptionHookContext {
  path: string;
  method: string;
  controllerName: string;
  methodName: string;
  operation: Record<string, any>;
  generated: string | undefined;
}

export interface DescriptionOptions {
  enabled?: boolean;
  /** Replace a description that already exists (default false: `@ApiOperation({ description })` always wins). */
  overwrite?: boolean;
  /** Return text to use instead of the generated one (return undefined to fall back to the generated text). */
  generate?: (ctx: DescriptionHookContext) => string | undefined;
  /** Post-process the final text (generated or from `generate`); return '' to drop the description. */
  transform?: (text: string, ctx: DescriptionHookContext) => string;
  /**
   * Where other code the chain may enter lives (backend services, shared libraries).
   *  - `auto` (default): workspace packages, Nest monorepo projects, local `file:`/`link:` dependencies;
   *  - `siblings`: also every sibling folder of the app that has a `src/` (the "services next to the gateway" layout);
   *  - `false`: only the application itself.
   */
  services?: 'auto' | 'siblings' | false;
  /** Extra source directories (absolute or relative to cwd) to index as additional roots. */
  roots?: string[];
  /** Write conventions the sources cannot state (aliases, acronyms, extra verbs…). All optional. */
  conventions?: Partial<DescriptionConventions>;
  orm?: Partial<OrmConvention>;
  persistence?: Partial<PersistenceConvention>;
  identity?: Partial<IdentityConvention>;
  /** `false` disables RPC discovery; otherwise the decorator / client receiver names. */
  rpc?: false | { handlerDecorator?: string; clientReceiver?: string };
  /** Add `x-generated-description: true` to operations whose description was generated. */
  markGenerated?: boolean;
  /**
   * `full` (default): behaviour sentences + a contract section (access, parameters, request/response structure
   * down to nested fields and constraints, documented failures). `summary`: behaviour sentences only.
   */
  detail?: 'summary' | 'full';
  /**
   * Fold the contract section into a collapsed `<details>` block (default `true`), so a long description stays
   * one line in the operations list until the reader opens it. `false` renders it inline. A string sets the
   * label of the toggle (default `Contract details`).
   */
  collapse?: boolean | string;
  /** Which contract sections to render (default: all). */
  sections?: Array<'access' | 'parameters' | 'request' | 'response' | 'errors'>;
}

const ENTRY_ROOT = 'app';
const SERVICE_SUFFIXES = ['.ts'];

interface LocalPackage {
  name: string;
  dir: string;
  src?: string;
  dist?: string;
}

const readJson = (file: string): Record<string, any> | undefined => {
  const text = readTextSafe(file);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// `apps/*`, `packages/*`, `services/**` style globs -> directories. Only the trailing-star forms
// that workspaces really use are supported.
function expandWorkspaceGlob(base: string, pattern: string): string[] {
  const clean = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!clean.includes('*')) return dirExists(path.join(base, clean)) ? [path.join(base, clean)] : [];
  const prefix = clean.split('*')[0].replace(/\/+$/, '');
  const dir = path.join(base, prefix);
  if (!dirExists(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
    .map((e) => path.join(dir, e.name))
    .sort();
}

function localPackageAt(dir: string): LocalPackage | undefined {
  const src = path.join(dir, 'src');
  const dist = path.join(dir, 'dist');
  const hasSrc = dirExists(src);
  const hasDist = dirExists(dist);
  if (!hasSrc && !hasDist) return undefined;
  return { name: path.basename(dir), dir, ...(hasSrc ? { src } : {}), ...(hasDist ? { dist } : {}) };
}

/** Walks up (a few levels) to the monorepo root, if any. */
function findWorkspaceRoot(cwd: string): string | undefined {
  let cur = cwd;
  for (let i = 0; i < 4; i++) {
    const pkg = readJson(path.join(cur, 'package.json'));
    if (pkg?.workspaces || fileExists(path.join(cur, 'pnpm-workspace.yaml')) || fileExists(path.join(cur, 'lerna.json'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return undefined;
}

export function discoverLocalPackages(cwd: string, entryRoots: string[], mode: 'auto' | 'siblings'): LocalPackage[] {
  const found = new Map<string, LocalPackage>();
  const entrySet = new Set(entryRoots.map((r) => path.resolve(r)));
  const add = (dir: string): void => {
    const pkg = localPackageAt(path.resolve(dir));
    if (!pkg) return;
    if (path.resolve(dir) === path.resolve(cwd)) return;
    if (pkg.src && entrySet.has(path.resolve(pkg.src))) return;
    if (!found.has(pkg.dir)) found.set(pkg.dir, pkg);
  };

  // 1. workspaces (npm/yarn/pnpm/lerna)
  const wsRoot = findWorkspaceRoot(cwd);
  if (wsRoot) {
    const pkg = readJson(path.join(wsRoot, 'package.json'));
    const globs: string[] = Array.isArray(pkg?.workspaces) ? pkg!.workspaces : (pkg?.workspaces?.packages ?? []);
    const yaml = readTextSafe(path.join(wsRoot, 'pnpm-workspace.yaml'));
    if (yaml) for (const m of yaml.matchAll(/^\s*-\s*['"]?([^'"\n]+?)['"]?\s*$/gm)) globs.push(m[1]);
    for (const g of globs) for (const dir of expandWorkspaceGlob(wsRoot, g)) add(dir);
  }

  // 2. Nest monorepo (nest-cli.json projects)
  const cli = readJson(path.join(wsRoot ?? cwd, 'nest-cli.json')) ?? readJson(path.join(cwd, 'nest-cli.json'));
  for (const project of Object.values<any>(cli?.projects ?? {})) {
    if (typeof project?.root === 'string') add(path.resolve(wsRoot ?? cwd, project.root));
  }

  // 3. local dependencies: "@acme/shared": "file:../shared" | "link:../shared" | "workspace:*" (resolved via node_modules)
  const own = readJson(path.join(cwd, 'package.json'));
  const deps = { ...(own?.dependencies ?? {}), ...(own?.devDependencies ?? {}) } as Record<string, string>;
  for (const [name, spec] of Object.entries(deps)) {
    const m = /^(?:file|link):(.+)$/.exec(String(spec));
    if (m) add(path.resolve(cwd, m[1]));
    else if (String(spec).startsWith('workspace:')) {
      try {
        add(fs.realpathSync(path.join(cwd, 'node_modules', name)));
      } catch {
        /* not installed */
      }
    }
  }

  // 4. optional: every sibling folder of the app (services living next to the gateway)
  if (mode === 'siblings') {
    const parent = path.dirname(cwd);
    try {
      for (const e of fs.readdirSync(parent, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') add(path.join(parent, e.name));
      }
    } catch {
      logger.warn(`Parent folder not readable: ${parent}`);
    }
  }
  return Array.from(found.values()).sort((a, b) => (a.dir < b.dir ? -1 : 1));
}

/**
 * The call-chain profile for ANY NestJS project, derived from the project itself:
 *  - the application's own sources are the entry root (every `.ts`, any file naming);
 *  - other roots (services, libraries) are discovered from workspaces / nest-cli / local deps;
 *  - framework & persistence adapters use their standard NestJS / TypeORM / Mongoose conventions;
 *  - RPC hops follow `@GrpcMethod`-style handlers and `client.<Rpc>` calls; forwarding bases are detected from `super(...)`.
 */
export function buildAutoProfile(cwd: string, entryRoots: string[], options: DescriptionOptions = {}): ChainProfile {
  const persistence: PersistenceConvention | undefined = options.persistence ? ({ ...persistenceDefaults(), ...options.persistence } as PersistenceConvention) : undefined;
  const rpc = options.rpc === false ? undefined : (options.rpc ?? {});
  const methodAdapters = [
    failureStatusAdapter(),
    ...(rpc
      ? [rpcSourceAdapter({ handlerDecorator: rpc.handlerDecorator ?? 'GrpcMethod', clientReceiver: rpc.clientReceiver ?? 'client' })]
      : []),
    identitySourceAdapter(options.identity ? ({ ...identityDefaults(), ...options.identity } as IdentityConvention) : undefined),
    persistenceWriteAdapter(persistence),
    signalMarkersAdapter(),
  ];

  const locals: { specs: RootSpec[]; names: string[] } = { specs: [], names: [] };
  const services = options.services ?? 'auto';
  if (services !== false) {
    for (const pkg of discoverLocalPackages(cwd, entryRoots, services)) {
      if (pkg.src) {
        locals.specs.push({ name: pkg.name, dir: pkg.src, suffixes: SERVICE_SUFFIXES });
        locals.names.push(pkg.name);
      } else if (pkg.dist) {
        // built-only package: read its compiled services, but never when real sources were indexed
        locals.specs.push({ name: pkg.name, dir: pkg.dist, suffixes: ['.service.js'], fallback: true });
        locals.names.push(pkg.name);
      }
    }
  }
  for (const extra of options.roots ?? []) {
    const dir = path.resolve(cwd, extra);
    if (!dirExists(dir)) continue;
    const name = path.basename(dir) === 'src' ? path.basename(path.dirname(dir)) : path.basename(dir);
    locals.specs.push({ name, dir, suffixes: SERVICE_SUFFIXES });
    locals.names.push(name);
  }
  if (locals.names.length > 0) logger.log(`Additional source roots: ${locals.names.join(', ')}`);

  return {
    entryRoot: ENTRY_ROOT,
    entrySuffixes: SERVICE_SUFFIXES,
    ancestorRoots: locals.names,
    discoverRoots: () => locals.specs,
    methodAdapters,
    schemaProviders: [ormSchemaProvider({ ...DECORATOR_ORM, ...(options.orm ?? {}) })],
    providers: [rpcHopProvider(), forwardingBaseHopProvider()],
  };
}

import { ORM_PERSISTENCE } from './adapters/persistence-writes';
import { REQUEST_USER } from './adapters/identity-source';
const persistenceDefaults = (): PersistenceConvention => ORM_PERSISTENCE;
const identityDefaults = (): IdentityConvention => REQUEST_USER;

export function autoConventions(options: DescriptionOptions = {}): Partial<DescriptionConventions> {
  return { ...persistenceConventions(options.persistence ? ({ ...ORM_PERSISTENCE, ...options.persistence } as PersistenceConvention) : undefined), ...(options.conventions ?? {}) };
}
