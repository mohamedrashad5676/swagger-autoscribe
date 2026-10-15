import * as fs from 'node:fs';
import * as path from 'node:path';
import { readTextSafe, stripSourceExt, toPosix, walkFiles, dirExists } from '../fs-utils';
import { silentLogger, type AutoDocLogger } from '../logger';

export type DeclKind = 'class' | 'interface' | 'type';

export interface IndexedDecl {
  name: string;
  kind: DeclKind;
  file: string;
  extendsName?: string;
}

export interface SourceIndexOptions {
  roots: string[];
  /** Files whose path matches any of these are ignored. Default: spec/test files. */
  exclude?: RegExp[];
  logger?: AutoDocLogger;
}

const DEFAULT_EXCLUDE = [/\.(?:spec|test|e2e-spec|e2e)\.[cm]?tsx?$/, /[\\/]__(?:tests|mocks)__[\\/]/];

// Declarations at the start of a line (so JSDoc / comment mentions never count).
const CLASS_DECL = /^[ \t]*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)([^{]*)/gm;
const INTERFACE_DECL = /^[ \t]*(?:export\s+)?(?:default\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/gm;
const TYPE_DECL = /^[ \t]*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/gm;

/**
 * Name -> declaration-file index over the project's TypeScript sources.
 *
 * Replaces file-naming conventions (`*.controller.ts`, `*.resource.ts`,
 * "everything under dtos/") with a lookup by what the file actually
 * DECLARES, so any project layout works: feature folders, layered folders,
 * monorepo apps/libs, `.d.ts` shipped by a workspace package, …
 *
 * It is a cheap regex pass — no TypeScript parse — so indexing thousands of
 * files is fast. When several files declare the same name, `resolve()` picks
 * the one that best matches a runtime hint (the compiled file the class was
 * loaded from).
 */
export class SourceIndex {
  private readonly byName = new Map<string, IndexedDecl[]>();
  private readonly exclude: RegExp[];
  private readonly logger: AutoDocLogger;
  private built = false;
  private readonly declTextCache = new Map<string, string>();
  private readonly propsCache = new Map<string, string[]>();
  private shapeMap: Map<string, IndexedDecl[]> | undefined;
  fileCount = 0;

  constructor(private readonly options: SourceIndexOptions) {
    this.exclude = options.exclude ?? DEFAULT_EXCLUDE;
    this.logger = options.logger ?? silentLogger;
  }

  get roots(): string[] {
    return this.options.roots;
  }

  hasUsableRoots(): boolean {
    return this.options.roots.some((r) => dirExists(r));
  }

  build(): void {
    if (this.built) return;
    this.built = true;
    const seen = new Set<string>();
    for (const root of this.options.roots) {
      if (!dirExists(root)) continue;
      const files = walkFiles(root, {
        filter: (full, name) =>
          /\.[cm]?tsx?$/.test(name) && !this.exclude.some((re) => re.test(full)),
      });
      for (const file of files) {
        if (seen.has(file)) continue;
        seen.add(file);
        // A `.d.ts` next to a real `.ts` of the same name adds nothing.
        if (file.endsWith('.d.ts') && fs.existsSync(file.replace(/\.d\.ts$/, '.ts'))) continue;
        this.scanFile(file);
      }
    }
    this.fileCount = seen.size;
    this.logger.log(`Indexed ${this.byName.size} declarations from ${seen.size} source files`);
  }

  private add(decl: IndexedDecl): void {
    const list = this.byName.get(decl.name) ?? [];
    if (!list.some((d) => d.file === decl.file && d.kind === decl.kind)) list.push(decl);
    this.byName.set(decl.name, list);
  }

  private scanFile(file: string): void {
    const text = readTextSafe(file);
    if (!text) return;
    let m: RegExpExecArray | null;
    CLASS_DECL.lastIndex = 0;
    while ((m = CLASS_DECL.exec(text)) !== null) {
      const header = m[2] ?? '';
      const ext = /\bextends\s+([A-Za-z_$][\w$.]*)/.exec(header.replace(/<[^>]*>/g, ''));
      this.add({ name: m[1], kind: 'class', file, extendsName: ext?.[1] });
    }
    INTERFACE_DECL.lastIndex = 0;
    while ((m = INTERFACE_DECL.exec(text)) !== null) this.add({ name: m[1], kind: 'interface', file });
    TYPE_DECL.lastIndex = 0;
    while ((m = TYPE_DECL.exec(text)) !== null) this.add({ name: m[1], kind: 'type', file });
  }

  /** Every declaration with this name (optionally restricted to kinds). */
  /**
   * Bundlers rename colliding / decorated classes (`UsersController` -> `UsersController2`,
   * `_UsersController`). Map a runtime class name back to the name declared in source,
   * only when the literal name is unknown and the stripped one is a known declaration.
   */
  canonicalName(name: string): string {
    if (!name || this.byName.has(name)) return name;
    const known = (n: string): boolean => n.length > 1 && /^[A-Za-z]/.test(n) && this.byName.has(n);
    // 1. peel generated affixes, one layer at a time, so combinations resolve too
    //    (`_Foo2`, `Foo$1`, `Foo_1`, `__Foo`, `$Foo`, `Foo_default`, `Foo2_1` ...)
    let cur = name;
    for (let i = 0; i < 4; i++) {
      const next = cur
        .replace(/^[_$]+/, '')
        .replace(/(?:[_$]?\d+|_default|_class|\$class)$/, '');
      if (next === cur || !next) break;
      cur = next;
      if (known(cur)) return cur;
    }
    // 2. module-path prefixes (webpack concatenation: `users_users_controller_UsersController`)
    const parts = name.split(/[_$]+/).filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const tail = parts.slice(i).join('');
      if (/^[A-Z]/.test(tail) && known(tail)) return tail;
      const last = parts[parts.length - 1];
      if (i === parts.length - 1 && /^[A-Z]/.test(last) && known(last)) return last;
    }
    return name;
  }

  find(name: string, kinds?: DeclKind[]): IndexedDecl[] {
    const list = this.byName.get(name) ?? [];
    return kinds ? list.filter((d) => kinds.includes(d.kind)) : list;
  }

  /**
   * Best file for `name`. With several candidates the one sharing the longest
   * trailing path (extension-agnostic) with `hintFile` wins — `hintFile` is
   * typically the compiled module the runtime class came from.
   */
  resolve(name: string, hintFile?: string, kinds?: DeclKind[], members?: readonly string[], literals?: readonly string[]): string | undefined {
    return this.resolveDecl(name, hintFile, kinds, members, literals)?.file;
  }

  /**
   * Same as `resolve` but returns the declaration (its DECLARED name matters when the runtime
   * name was changed by a bundler). When the runtime name matches nothing at all (a minified
   * bundle: `UsersController` became `e`), a class is recognised by its shape instead: it must
   * declare every runtime member and contain every string the runtime class carries (route path).
   */
  resolveDecl(name: string, hintFile?: string, kinds?: DeclKind[], members?: readonly string[], literals?: readonly string[]): IndexedDecl | undefined {
    let candidates = this.find(this.canonicalName(name), kinds);
    if (candidates.length === 0) return this.byShape(members, literals);
    if (candidates.length === 1) return candidates[0];
    // String metadata the runtime class carries (route path, ...) must appear literally in its own source.
    if (literals && literals.length > 0) {
      const narrowed = candidates.filter((c) => {
        const t = this.declText(c.file, c.name);
        return literals.every((l) => t.includes(l));
      });
      if (narrowed.length > 0) candidates = narrowed;
      if (candidates.length === 1) return candidates[0];
    }
    // Several declarations share the name. Prefer the path closest to the runtime file ...
    let best = candidates[0];
    let bestScore = -1;
    let tied = 0;
    if (hintFile) {
      for (const c of candidates) {
        const score = commonTailSegments(c.file, hintFile);
        if (score > bestScore) {
          best = c;
          bestScore = score;
          tied = 1;
        } else if (score === bestScore) tied++;
      }
      if (tied === 1 && bestScore > 0) return best;
    }
    // ... and, when the path says nothing (bundles: every class lives in one file), by what the
    // runtime class actually has: its member names must appear in the declaration's body.
    if (members && members.length > 0) {
      let top = -1;
      let pick: IndexedDecl | undefined;
      let ties = 0;
      for (const c of candidates) {
        const sc = this.memberScore(c.file, canonicalOf(c), members);
        if (sc > top) {
          top = sc;
          pick = c;
          ties = 1;
        } else if (sc === top) ties++;
      }
      if (pick && top > 0 && ties === 1) return pick;
    }
    return hintFile ? best : candidates[0];
  }

  /**
   * DTO classes have no route to identify them. When a minifier removed the name, a class is
   * recognised only by an EXACT, UNIQUE match of its declared property names (>= 2 of them).
   */
  resolveDtoByShape(props: readonly string[]): IndexedDecl | undefined {
    if (props.length < 2) return undefined;
    const want = [...new Set(props)].sort().join(',');
    if (!this.shapeMap) {
      // One pass over the declarations, then every lookup is a map hit.
      this.shapeMap = new Map();
      for (const d of this.allDecls()) {
        if (d.kind !== 'class') continue;
        const key = [...new Set(this.classProperties(d.file, d.name))].sort().join(',');
        const list = this.shapeMap.get(key) ?? [];
        list.push(d);
        this.shapeMap.set(key, list);
      }
    }
    const list = this.shapeMap.get(want);
    if (!list || list.length === 0) return undefined;
    const first = list[0];
    return list.every((d) => d.file === first.file && d.name === first.name) ? first : undefined; // ambiguous otherwise
  }

  /** Property names declared directly in a class body (brace depth 1, outside parentheses). */
  private classProperties(file: string, name: string): string[] {
    const key = `${file}\0${name}`;
    const cached = this.propsCache.get(key);
    if (cached) return cached;
    const out = this.computeClassProperties(file, name);
    this.propsCache.set(key, out);
    return out;
  }

  private computeClassProperties(file: string, name: string): string[] {
    const text = this.declText(file, name);
    const open = text.indexOf('{', text.search(new RegExp(`\\bclass\\s+${name}\\b`)));
    if (open < 0) return [];
    const src = text.slice(open).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
    let brace = 0;
    let paren = 0;
    let top = '';
    for (const ch of src) {
      if (ch === '{') brace++;
      else if (ch === '}') {
        brace--;
        if (brace === 0) break;
      } else if (ch === '(') {
        // `name(...)` is a method or a decorator call, never a property: drop its identifier so a
        // return-type colon after the parentheses is not mistaken for `name:`.
        if (brace === 1 && paren === 0) top = top.replace(/[A-Za-z_$][\w$]*\s*$/, '');
        paren++;
      } else if (ch === ')') paren--;
      top += brace === 1 && paren === 0 && ch !== '{' && ch !== '}' && ch !== '(' && ch !== ')' ? ch : ' ';
    }
    const out: string[] = [];
    for (const m of top.matchAll(/([A-Za-z_$][\w$]*)\s*[!?]?\s*:/g)) out.push(m[1]);
    return out;
  }

  private byShape(members?: readonly string[], literals?: readonly string[]): IndexedDecl | undefined {
    if (!members || members.length < 2 || !literals || literals.length === 0) return undefined;
    let found: IndexedDecl | undefined;
    for (const d of this.allDecls()) {
      if (d.kind !== 'class') continue;
      const text = this.declText(d.file, d.name);
      if (!literals.every((l) => text.includes(l))) continue;
      if (this.memberScore(d.file, d.name, members) !== members.length) continue;
      if (found && (found.file !== d.file || found.name !== d.name)) return undefined; // ambiguous
      found = d;
    }
    return found;
  }

  /** Text of one declaration, including the decorators written right above it. */
  private declText(file: string, name: string): string {
    const key = `${file}\0${name}`;
    const hit = this.declTextCache.get(key);
    if (hit !== undefined) return hit;
    const out = this.computeDeclText(file, name);
    this.declTextCache.set(key, out);
    return out;
  }

  private computeDeclText(file: string, name: string): string {
    const text = readTextSafe(file);
    if (!text) return '';
    const m = new RegExp(`\\b(?:class|interface|type)\\s+${name}\\b`).exec(text);
    if (!m) return '';
    // Decorators written above the class: everything after the previous declaration's closing brace.
    const before = text.slice(Math.max(0, m.index - 800), m.index);
    let cut = 0;
    for (const c of before.matchAll(/\}[ \t]*;?[ \t]*\n/g)) cut = (c.index ?? 0) + c[0].length;
    const head = before.slice(cut);
    const rest = text.slice(m.index + 1);
    const next = rest.search(/\n(?:@[\w.]+\([^\n]*\)\s*\n)*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|interface|type|function|const|enum)\s/);
    return head + text.slice(m.index, m.index + 1) + (next < 0 ? rest : rest.slice(0, next));
  }

  private memberScore(file: string, name: string, members: readonly string[]): number {
    const body = this.declText(file, name);
    if (!body) return 0;
    let n = 0;
    for (const m of members) if (new RegExp(`(?:^|[\\s;{,(])${escapeRe(m)}\\s*[?!]?\\s*[(:=;<]`).test(body)) n++;
    return n;
  }

  /** Every distinct file that declares at least one of the given names. */
  filesFor(names: Iterable<string>): string[] {
    const out = new Set<string>();
    for (const n of names) for (const d of this.byName.get(n) ?? []) out.add(d.file);
    return Array.from(out);
  }

  allDecls(): IndexedDecl[] {
    return Array.from(this.byName.values()).flat();
  }
}

function commonTailSegments(a: string, b: string): number {
  const as = toPosix(stripSourceExt(a)).split('/');
  const bs = toPosix(stripSourceExt(b)).split('/');
  let n = 0;
  while (n < as.length && n < bs.length && as[as.length - 1 - n] === bs[bs.length - 1 - n]) n++;
  return n;
}

/**
 * Where the project's TypeScript lives, without any configuration:
 *  1. `nest-cli.json` — `sourceRoot` and every `projects[*].sourceRoot`
 *     (Nest monorepo mode: apps/*, libs/*)
 *  2. `<cwd>/src`
 *  3. `<cwd>` itself
 */
export function detectSourceRoots(cwd: string): string[] {
  const roots = new Set<string>();
  const cliPath = path.join(cwd, 'nest-cli.json');
  const text = readTextSafe(cliPath);
  if (text) {
    try {
      const cli = JSON.parse(text) as {
        sourceRoot?: string;
        projects?: Record<string, { sourceRoot?: string; root?: string }>;
      };
      if (cli.sourceRoot) roots.add(path.resolve(cwd, cli.sourceRoot));
      for (const project of Object.values(cli.projects ?? {})) {
        if (project.sourceRoot) roots.add(path.resolve(cwd, project.sourceRoot));
        else if (project.root) roots.add(path.resolve(cwd, project.root));
      }
    } catch {
      // malformed nest-cli.json — ignore
    }
  }
  const existing = Array.from(roots).filter(dirExists);
  if (existing.length > 0) return existing;
  const src = path.join(cwd, 'src');
  if (dirExists(src)) return [src];
  return [cwd];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function canonicalOf(d: IndexedDecl): string {
  return d.name;
}
