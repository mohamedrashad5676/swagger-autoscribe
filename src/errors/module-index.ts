// Runtime reverse index over Node's CommonJS module cache:
//   class constructor -> the module file it was loaded from
//   class name        -> every exported class with that name
//
// One pass over `require.cache` (instead of one pass per lookup). Rebuilt
// once if new modules were loaded since the last build. Pure ESM hosts have
// no `require.cache`; every lookup then simply returns undefined and callers
// fail closed.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', '.next', '.cache', '.nx', '.turbo']);
const CODE_FILE = /\.(?:[cm]?js)$/;
const MAX_FILES = 30000;
const MAX_BYTES = 8 * 1024 * 1024;
// Two patterns on purpose: `var A = class B {` declares BOTH names and one alternation would swallow B.
const CLASS_DECL = /\bclass\s+([A-Za-z_$][\w$]*)/g;
const CLASS_ASSIGN = /([A-Za-z_$][\w$]*)\s*=\s*class\b/g;

/**
 * Native-ESM hosts (NestJS 12 apps, `"type": "module"`) have no `require.cache`, so a class
 * cannot be traced to its module that way. Fallback: a class's own source text
 * (`Function.prototype.toString`) is present verbatim in the file it was loaded from, so
 * locate that file by content. Only application code is searched (never node_modules).
 *
 * One pass indexes `class Name` -> files (kept small); a lookup re-reads only the files that
 * declare that name. Anything skipped because of the limits is counted and reported.
 */
class TextLocator {
  private byName: Map<string, string[]> | undefined;
  private allFiles: string[] = [];
  private located = new Map<Function, string | null>();
  skippedFiles = 0;
  truncated = false;

  constructor(
    private readonly extraRoots: string[] = [],
    private readonly maxFiles = MAX_FILES,
    private readonly maxBytes = MAX_BYTES,
  ) {}

  locate(ctor: Function): string | undefined {
    if (this.located.has(ctor)) return this.located.get(ctor) ?? undefined;
    let found: string | null = null;
    try {
      const src = Function.prototype.toString.call(ctor);
      if (src.length > 20 && !/\[native code\]/.test(src)) {
        this.ensure();
        const named = ctor.name ? this.byName?.get(ctor.name) : undefined;
        let hits = (named ?? []).filter((f) => (this.read(f) ?? '').includes(src));
        // Anonymous classes have no name to look up: scan every file (rare).
        if (hits.length === 0 && !ctor.name) hits = this.allFiles.filter((f) => (this.read(f) ?? '').includes(src));
        if (hits.length > 1) {
          // Identical class bodies in different modules (copy-pasted controllers): the string metadata
          // the class carries (route path, tags, ...) appears as a literal only in its own file.
          const needles = stringMetadata(ctor);
          const narrowed = hits.filter((f) => needles.every((n) => (this.read(f) ?? '').includes(n)));
          if (narrowed.length > 0) hits = narrowed;
        }
        hits.sort((x, y) => x.length - y.length);
        found = hits[0] ?? null;
      }
    } catch {
      found = null;
    }
    this.located.set(ctor, found);
    return found ?? undefined;
  }

  /** Human readable note when the search was cut short; undefined when it was complete. */
  limitNote(): string | undefined {
    if (!this.truncated && this.skippedFiles === 0) return undefined;
    const parts: string[] = [];
    if (this.truncated) parts.push(`stopped after ${this.maxFiles} files`);
    if (this.skippedFiles > 0) parts.push(`skipped ${this.skippedFiles} file(s) larger than ${Math.round(this.maxBytes / 1024)}KB`);
    return parts.join(' and ');
  }

  private read(file: string): string | null {
    try {
      if (statSync(file).size > this.maxBytes) return null;
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  private ensure(): void {
    if (this.byName) return;
    const roots = new Set<string>();
    const add = (p?: string): void => {
      if (p) roots.add(nodePath.resolve(p));
    };
    if (process.argv[1]) add(nodePath.dirname(process.argv[1]));
    add(process.cwd());
    this.extraRoots.forEach(add);
    // Drop roots nested inside another root: walking the outer one covers them.
    const all = [...roots];
    const top = all.filter((r) => !all.some((o) => o !== r && r.startsWith(o + nodePath.sep)));
    const files: string[] = [];
    const walk = (dir: string): void => {
      if (this.truncated) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (files.length >= this.maxFiles) {
          this.truncated = true;
          return;
        }
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(nodePath.join(dir, e.name));
        } else if (CODE_FILE.test(e.name) && !e.name.endsWith('.min.js')) {
          files.push(nodePath.join(dir, e.name));
        }
      }
    };
    top.forEach(walk);
    const byName = new Map<string, string[]>();
    for (const f of files) {
      const text = this.read(f);
      if (text === null) {
        this.skippedFiles++;
        continue;
      }
      this.allFiles.push(f);
      const seen = new Set<string>();
      for (const m of [...text.matchAll(CLASS_DECL), ...text.matchAll(CLASS_ASSIGN)]) {
        const n = m[1];
        if (n && !seen.has(n)) {
          seen.add(n);
          const list = byName.get(n);
          if (list) list.push(f);
          else byName.set(n, [f]);
        }
      }
    }
    this.byName = byName;
  }
}

export class ModuleIndex {
  private readonly locator: TextLocator;

  constructor(options: { roots?: string[]; maxFiles?: number; maxBytes?: number } = {}) {
    this.locator = new TextLocator(options.roots, options.maxFiles, options.maxBytes);
  }

  private byCtor: Map<Function, string> | undefined;
  private byName: Map<string, Function[]> | undefined;
  private builtAtSize = -1;

  fileOf(ctor: Function): string | undefined {
    this.ensure(ctor);
    return this.byCtor?.get(ctor) ?? this.locator.locate(ctor);
  }

  /** Set when the ESM fallback search hit a limit and some classes may therefore be unlocatable. */
  searchLimitNote(): string | undefined {
    return this.locator.limitNote();
  }

  /** Every exported class/function with this name (several modules may export the same name). */
  classesNamed(name: string): Function[] {
    this.ensure();
    return this.byName?.get(name) ?? [];
  }

  /** All exported classes, by name. */
  allClasses(): ReadonlyMap<string, Function[]> {
    this.ensure();
    return this.byName ?? new Map();
  }

  private ensure(needle?: Function): void {
    if (typeof require !== 'function') return;
    let cache: NodeJS.Dict<NodeJS.Module> | undefined;
    try {
      cache = require.cache;
    } catch {
      return;
    }
    if (!cache) return;
    const size = Object.keys(cache).length;
    const stale = size !== this.builtAtSize;
    if (!this.byCtor || (stale && (needle === undefined || !this.byCtor.has(needle)))) {
      this.build(cache);
      this.builtAtSize = size;
    }
  }

  // The barrel (`dist/index.js`) and the real per-class file both export the
  // same reference — prefer whichever module exports the FEWEST names, i.e.
  // the actual declaration file, not the re-export hub.
  private build(cache: NodeJS.Dict<NodeJS.Module>): void {
    const best = new Map<Function, { file: string; size: number }>();
    const consider = (fn: unknown, file: string, size: number): void => {
      if (typeof fn !== 'function') return;
      const prev = best.get(fn);
      if (!prev || size < prev.size) best.set(fn, { file, size });
    };
    for (const filename of Object.keys(cache)) {
      // One misbehaving module (a throw-on-access getter, a Proxy, …) must
      // never take down resolution for every OTHER module.
      try {
        const exported = cache[filename]?.exports as unknown;
        if (!exported) continue;
        if (typeof exported === 'function') {
          consider(exported, filename, 1);
          continue;
        }
        if (typeof exported !== 'object') continue;
        const keys = Object.keys(exported as object);
        for (const k of keys) {
          try {
            // Plain data properties only: invoking accessors on arbitrary third-party
            // exports has side effects (e.g. express' deprecated `req.host` getter).
            // Barrels re-export through getters, but they are ignored anyway — the
            // declaring file exports the class as a plain value.
            const desc = Object.getOwnPropertyDescriptor(exported, k);
            if (desc && 'value' in desc) consider(desc.value, filename, keys.length);
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }
    const byCtor = new Map<Function, string>();
    const byName = new Map<string, Function[]>();
    for (const [fn, { file }] of best) {
      byCtor.set(fn, file);
      if (fn.name && /^[A-Z]/.test(fn.name)) {
        const list = byName.get(fn.name) ?? [];
        list.push(fn);
        byName.set(fn.name, list);
      }
    }
    this.byCtor = byCtor;
    this.byName = byName;
  }
}

export function stringMetadata(ctor: Function): string[] {
  const out = new Set<string>();
  const R = Reflect as unknown as {
    getMetadataKeys?: (t: object, p?: string | symbol) => unknown[];
    getMetadata?: (k: unknown, t: object, p?: string | symbol) => unknown;
  };
  if (!R.getMetadataKeys || !R.getMetadata) return [];
  const take = (v: unknown): void => {
    if (typeof v === 'string' && v.length > 1 && v.length < 120) out.add(v);
    else if (Array.isArray(v)) v.forEach((x) => typeof x === 'string' && x.length > 1 && x.length < 120 && out.add(x));
  };
  try {
    for (const k of R.getMetadataKeys(ctor)) take(R.getMetadata(k, ctor));
  } catch {
    /* exotic metadata */
  }
  return [...out];
}
