// Post-build: point every `require("typescript")` in dist at ./ts-impl so the package
// analyses sources with the project's TypeScript, or the bundled fallback on TS 7+.
const fs = require('fs'), path = require('path');
const dist = path.join(__dirname, '..', 'dist');
let n = 0;
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) { walk(f); continue; }
    if (!f.endsWith('.js') || /[\\/]dist[\\/]ts(-impl)?\.js$/.test(f)) continue;
    const s = fs.readFileSync(f, 'utf8');
    if (!/require\((["'])typescript\1\)/.test(s)) continue;
    let rel = path.relative(path.dirname(f), path.join(dist, 'ts-impl')).split(path.sep).join('/');
    if (!rel.startsWith('.')) rel = './' + rel;
    fs.writeFileSync(f, s.replace(/require\((["'])typescript\1\)/g, `require("${rel}")`)); n++;
  }
})(dist);
console.log('rewrote', n, 'files');
