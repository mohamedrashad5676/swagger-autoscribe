import * as fs from 'node:fs';
import * as path from 'node:path';

const DEFAULT_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.next', '.turbo', 'out', '.cache']);

export interface WalkOptions {
  skipDirs?: Set<string>;
  /** Return false to skip a file. */
  filter?: (fullPath: string, name: string) => boolean;
}

/**
 * Manual recursive walk — `readdirSync(..., { recursive: true })` needs
 * Node >= 18.17 and returns inconsistent `parentPath`/`path` fields across
 * minors, so we do not rely on it. Never throws on missing/unreadable dirs.
 */
export function walkFiles(root: string, options: WalkOptions = {}): string[] {
  const skip = options.skipDirs ?? DEFAULT_SKIP_DIRS;
  const out: string[] = [];
  const stack: string[] = [root];
  const seenReal = new Set<string>();
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (seenReal.has(real)) continue; // symlink loops
    seenReal.add(real);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const st = fs.statSync(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        if (!skip.has(entry.name)) stack.push(full);
      } else if (isFile) {
        if (!options.filter || options.filter(full, entry.name)) out.push(full);
      }
    }
  }
  return out.sort();
}

export function readTextSafe(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export function dirExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function fileExists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Path-separator agnostic "is inside node_modules" check (Windows safe). */
export function isInNodeModules(file: string): boolean {
  return /[\\/]node_modules[\\/]/.test(file);
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function stripSourceExt(file: string): string {
  return file.replace(/\.d\.ts$/, '').replace(/\.(?:[cm]?[jt]sx?)$/, '');
}
