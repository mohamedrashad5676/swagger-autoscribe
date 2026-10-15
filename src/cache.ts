import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { isInNodeModules, walkFiles } from './fs-utils';
import { detectSourceRoots } from './source/source-index';
import { loadTypeScript } from './ts';
import type { AutoDocOptions } from './types';

const OPTION_KEYS_IGNORED = new Set(['logger', 'uiOptions', 'cache', 'enabled', 'path']);
const MAX_FILES = 40000;

export interface CacheOptions {
  /** Where to store the document. Default: `node_modules/.cache/swagger-autodoc` (or the OS temp dir). */
  dir?: string;
}

export function cacheDir(option: AutoDocOptions['cache'], cwd: string): string | undefined {
  if (!option) return undefined;
  if (typeof option === 'object' && option.dir) return path.resolve(cwd, option.dir);
  const nm = path.join(cwd, 'node_modules');
  if (fs.existsSync(nm)) return path.join(nm, '.cache', 'swagger-autodoc');
  return path.join(os.tmpdir(), 'swagger-autodoc');
}

/** Stable JSON: sorted keys, functions by source text, symbols by description, cycles cut. */
function stable(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value ?? null;
  const t = typeof value;
  if (t === 'function') return `fn:${Function.prototype.toString.call(value)}`;
  if (t === 'symbol') return `sym:${String(value)}`;
  if (t === 'bigint') return `big:${String(value)}`;
  if (t !== 'object') return value;
  if (value instanceof RegExp) return `re:${String(value)}`;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (depth > 8) return '…';
  const obj = value as object;
  if (seen.has(obj)) return '[circular]';
  seen.add(obj);
  let out: unknown;
  if (Array.isArray(obj)) out = obj.map((v) => stable(v, depth + 1, seen));
  else if (obj instanceof Map) out = [...obj.entries()].map(([k, v]) => [stable(k, depth + 1, seen), stable(v, depth + 1, seen)]);
  else if (obj instanceof Set) out = [...obj.values()].map((v) => stable(v, depth + 1, seen));
  else {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort().slice(0, 200)) o[k] = stable((obj as Record<string, unknown>)[k], depth + 1, seen);
    out = o;
  }
  seen.delete(obj);
  return out;
}

/** Class names + plain config of the global enhancers actually applied (what error/auth docs depend on). */
function appFingerprint(app: INestApplication): unknown {
  const config = ((app as unknown as { config?: Record<string, unknown> }).config ?? {}) as Record<string, unknown>;
  const kinds = ['Guards', 'Filters', 'Interceptors', 'Pipes'];
  const out: Record<string, unknown> = {};
  for (const kind of kinds) {
    const items: unknown[] = [];
    for (const getter of [`getGlobal${kind}`, `getGlobalRequest${kind}`]) {
      try {
        const fn = config[getter] as (() => unknown[]) | undefined;
        for (const raw of fn?.call(config) ?? []) {
          const item = ((raw as { instance?: unknown })?.instance ?? raw) as object | undefined;
          if (!item) continue;
          const plain: Record<string, unknown> = {};
          for (const k of Object.keys(item)) {
            const v = (item as Record<string, unknown>)[k];
            if (v === null || ['string', 'number', 'boolean', 'function'].includes(typeof v) || Array.isArray(v) || (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype)) {
              plain[k] = v;
            }
          }
          items.push([(item as { constructor?: { name?: string } }).constructor?.name ?? typeof item, stable(plain)]);
        }
      } catch {
        items.push('unreadable');
      }
    }
    out[kind] = items;
  }
  return out;
}

function statLine(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${file}:${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return `${file}:missing`;
  }
}

function sourceFingerprint(cwd: string, options: AutoDocOptions): string[] {
  const src = options.sources ?? {};
  const roots = [...(src.roots ?? detectSourceRoots(cwd)), ...(src.extraRoots ?? [])];
  const files = new Set<string>();
  for (const root of roots) {
    for (const f of walkFiles(root, { filter: (_p, name) => /\.(ts|tsx|mts|cts)$/.test(name) })) {
      files.add(f);
      if (files.size >= MAX_FILES) break;
    }
  }
  // Compiled output in this process: Function.toString of these files is what the error scanner reads.
  for (const f of Object.keys(require.cache ?? {})) {
    if (!isInNodeModules(f)) files.add(f);
    if (files.size >= MAX_FILES) break;
  }
  for (const out of ['dist', 'build', 'out']) {
    const dir = path.join(cwd, out);
    if (!fs.existsSync(dir)) continue;
    for (const f of walkFiles(dir, { skipDirs: new Set(['node_modules']), filter: (_p, n) => /\.(js|mjs|cjs)$/.test(n) })) files.add(f);
    if (files.size >= MAX_FILES) break;
  }
  for (const f of [path.join(cwd, 'tsconfig.json'), path.join(cwd, 'tsconfig.build.json'), path.join(cwd, 'nest-cli.json'), ...(src.tsconfigPath ? [path.resolve(cwd, src.tsconfigPath)] : [])]) {
    files.add(f);
  }
  return [...files].sort().map(statLine);
}

export function computeCacheKey(app: INestApplication, options: AutoDocOptions, base: OpenAPIObject, cwd: string): string {
  const hash = crypto.createHash('sha256');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const own = (require('../package.json') as { version?: string }).version ?? '0';
  hash.update(`autodoc:${own}|node:${process.versions.node.split('.')[0]}|ts:${loadTypeScript()?.version ?? 'none'}\n`);
  hash.update(JSON.stringify(base));
  const opts: Record<string, unknown> = {};
  for (const k of Object.keys(options).sort()) if (!OPTION_KEYS_IGNORED.has(k)) opts[k] = (options as Record<string, unknown>)[k];
  hash.update(JSON.stringify(stable(opts)));
  hash.update(JSON.stringify(appFingerprint(app)));
  const env = Object.keys(process.env).filter((k) => k.startsWith('SWAGGER_')).sort().map((k) => `${k}=${process.env[k]}`);
  hash.update(env.join('\n'));
  hash.update(sourceFingerprint(cwd, options).join('\n'));
  return hash.digest('hex').slice(0, 32);
}

export function readCached(dir: string, key: string): OpenAPIObject | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8')) as OpenAPIObject;
  } catch {
    return undefined;
  }
}

export function writeCached(dir: string, key: string, doc: OpenAPIObject): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `${key}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(doc));
    fs.renameSync(tmp, path.join(dir, `${key}.json`));
    // Keep the folder small: only the newest few documents matter.
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const old of files.slice(5)) fs.unlinkSync(path.join(dir, old.f));
  } catch {
    /* a cache that cannot be written is just a cache miss next time */
  }
}
