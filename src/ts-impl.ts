import { loadTypeScript } from './ts';
// Runtime stand-in for `require('typescript')` inside the built package (see scripts/rewrite-ts.js).
export = (loadTypeScript() ?? {}) as typeof import('typescript');
