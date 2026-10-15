import type * as TS from 'typescript';

/**
 * `typescript` is a *peer* dependency that is only needed for the AST based
 * features (request/response schema extraction). It is loaded lazily so that:
 *  - production images that pruned devDependencies do not crash at import time;
 *  - the runtime-only features (auth, pagination, runtime error discovery)
 *    keep working even if TypeScript is not installed.
 */
let cached: typeof TS | null | undefined;

export function loadTypeScript(): typeof TS | undefined {
  if (cached !== undefined) return cached ?? undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('typescript') as typeof TS;
    // TypeScript 7+ (native port) ships no JS compiler API -> use the bundled TS 5.x
    // fallback purely for *reading source code*; the project's own TS is untouched.
    cached = typeof m.createProgram === 'function' ? m : loadFallback();
  } catch {
    cached = loadFallback();
  }
  return cached ?? undefined;
}

function loadFallback(): typeof TS | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const f = require('typescript-fallback') as typeof TS;
    return typeof f.createProgram === 'function' ? f : null;
  } catch {
    return null;
  }
}

export function isTypeScriptAvailable(): boolean {
  return loadTypeScript() !== undefined;
}

/**
 * Drop-in stand-in for `import * as ts from 'typescript'`. Resolves the real
 * module on first property access and throws a readable error if it is
 * missing (instead of failing the whole process at import time).
 */
export const ts: typeof TS = new Proxy({} as typeof TS, {
  get(_target, prop) {
    const real = loadTypeScript();
    if (!real) {
      throw new Error(
        "swagger-autodoc: the 'typescript' package is required for source-based schema extraction. Install it (npm i -D typescript) or disable the features that need it.",
      );
    }
    return (real as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export type { TS };
