import * as fs from 'node:fs';
import * as path from 'node:path';
import { toPosix } from '../fs-utils';

/** An installed package whose types / sources belong to the user's own system (shared DTO libraries, workspace packages). */
export interface OwnedPackage {
  name: string;
  /** Real directory of the package. */
  dir: string;
  /** Directories inside it that hold TypeScript (`src`, and the folder of the declared `.d.ts` files). */
  typeRoots: string[];
}

// Never the user's own code, even if a DTO-ish class happens to come from them.
const FRAMEWORK = /^(@nestjs|@types|@grpc|@opentelemetry|@apollo|@mikro-orm|@prisma)\//;
const FRAMEWORK_NAMES = new Set(['swagger-autodoc', 'rxjs', 'typeorm', 'mongoose', 'class-validator', 'class-transformer', 'reflect-metadata', 'express', 'fastify', 'typescript', 'swagger-ui-dist']);

const LOCAL_SPEC = /^(?:file:|link:|workspace:|git\+|git:|github:|https?:|portal:)/;

function readJson(file: string): Record<string, any> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** `<...>/node_modules/@scope/name/dist/x.js` -> `{ name: '@scope/name', dir }` (the LAST node_modules segment wins). */
export function packageOfFile(file: string): { name: string; dir: string } | undefined {
  const p = toPosix(file);
  const i = p.lastIndexOf('/node_modules/');
  if (i < 0) return undefined;
  const rest = p.slice(i + '/node_modules/'.length).split('/');
  const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  if (!name || name.endsWith('/undefined')) return undefined;
  return { name, dir: p.slice(0, i + '/node_modules/'.length) + name };
}

function isFramework(name: string): boolean {
  return FRAMEWORK.test(`${name}/`) || FRAMEWORK_NAMES.has(name);
}

function findInstalled(cwd: string, name: string): string | undefined {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(candidate)) return candidate;
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

function typeRootsOf(dir: string): string[] {
  const pkg = readJson(path.join(dir, 'package.json')) ?? {};
  const out = new Set<string>();
  const addFile = (rel: unknown): void => {
    if (typeof rel !== 'string' || !/\.d\.[cm]?ts$|\.[cm]?ts$/.test(rel)) return;
    const parts = path.normalize(rel).split(path.sep).filter((x) => x && x !== '.');
    out.add(parts.length > 1 ? path.join(dir, parts[0]) : dir);
  };
  addFile(pkg.types);
  addFile(pkg.typings);
  const walk = (v: unknown, key?: string): void => {
    if (typeof v === 'string') {
      if (key === 'types' || /\.d\.[cm]?ts$/.test(v)) addFile(v);
    } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(pkg.exports);
  if (fs.existsSync(path.join(dir, 'src'))) out.add(path.join(dir, 'src'));
  if (out.size === 0) {
    for (const d of ['dist', 'lib', 'build', 'types']) if (fs.existsSync(path.join(dir, d))) out.add(path.join(dir, d));
  }
  // A root that is the package folder itself would walk node_modules-free sources only.
  return Array.from(out).filter((d) => fs.existsSync(d));
}

/**
 * Packages whose types describe the user's API:
 *  - dependencies installed from somewhere other than a registry (`file:`, `link:`, `workspace:`, git, tarball URL) or symlinked workspace packages;
 *  - packages that define the classes the API really uses as DTOs (`classFiles` = compiled files of those classes).
 * Nothing to configure; `explicit` names (from `includePackages`) are always added, `exclude` names never.
 */
export function discoverOwnedPackages(cwd: string, classFiles: Iterable<string>, explicit: string[] = [], exclude: string[] = []): OwnedPackage[] {
  const found = new Map<string, string>(); // name -> dir
  const skip = new Set(exclude);
  const add = (name: string, dir: string | undefined): void => {
    if (!dir || skip.has(name) || found.has(name)) return;
    try {
      found.set(name, fs.realpathSync(dir));
    } catch {
      /* not installed */
    }
  };

  const own = readJson(path.join(cwd, 'package.json'));
  const deps = { ...(own?.dependencies ?? {}), ...(own?.devDependencies ?? {}), ...(own?.peerDependencies ?? {}) } as Record<string, string>;
  for (const [name, spec] of Object.entries(deps)) {
    if (isFramework(name)) continue;
    const installed = findInstalled(cwd, name);
    if (!installed) continue;
    let linked = false;
    try {
      linked = fs.lstatSync(installed).isSymbolicLink();
    } catch {
      /* ignore */
    }
    if (LOCAL_SPEC.test(String(spec)) || linked) add(name, installed);
  }

  for (const file of classFiles) {
    const pkg = packageOfFile(file);
    if (pkg && !isFramework(pkg.name)) add(pkg.name, pkg.dir);
  }
  for (const name of explicit) add(name, findInstalled(cwd, name));

  return Array.from(found, ([name, dir]) => ({ name, dir, typeRoots: typeRootsOf(dir) }));
}
