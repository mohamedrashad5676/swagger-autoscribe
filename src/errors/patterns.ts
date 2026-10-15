import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

// `this.foo()` -> prop undefined, method foo; `this.svc.go()` / `this.svc?.go()` -> prop svc, method go.
// (`?.` between the two identifiers is matched too — compiled ES2020+ output keeps it.)
export const THIS_CALL = /this\??\.([A-Za-z_$][\w$]*)(?:\s*\??\.\s*([A-Za-z_$][\w$]*))?\s*\(/g;

// `import { a, b as c } from './relative'` / `const { a, b } = require('./relative')`
// — the only cross-file jump the scanner follows for bare calls, and only
// into files reachable from the SAME source file via a relative specifier
// (never a bare package specifier — those go through isAppCode/DI instead).
export const IMPORT_SPEC =
  /(?:import\s*\{([^}]+)\}\s*from|(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require)\s*\(?\s*['"](\.[^'"]+)['"]\s*\)?/g;

// Compiled CJS output uses a NAMESPACE require (`const x_1 = require("./x")`,
// usage `x_1.fn(...)`) instead of a destructured import.
export const NAMESPACE_REQUIRE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g;

// Resolves a relative import specifier against the importing file's own
// directory — tries the bare path, common extensions, an index file, and the
// ESM-style `./x.js` -> `./x.ts` mapping. Undefined (= "not followed") when
// nothing on disk matches.
export function resolveRelativeModule(fromFile: string, spec: string): string | undefined {
  const base = resolvePath(dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.js`,
    `${base}.tsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}/index.ts`,
    `${base}/index.js`,
  ];
  if (/\.[cm]?js$/.test(base)) {
    candidates.push(base.replace(/\.([cm]?)js$/, '.$1ts'));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      // `base` itself may be a directory (`./utils` -> utils/); only files count.
      try {
        if (require('node:fs').statSync(candidate).isFile()) return candidate;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}
