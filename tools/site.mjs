// CI: copies the files Pages serves into a directory and checks that every local file the page refers to (in index.html
// and reef.js: scripts, stylesheets, images, modules, fetched JSON) is there, so a file left out of the copy fails the run
// instead of breaking the published page. Usage: node tools/site.mjs <dir>
import { cpSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const out = process.argv[2] ?? '_site';
const FILES = ['index.html', 'reef.js', 'reef-app.js', 'version.json', 'og.html', 'og.png', 'lib', 'README.md', 'LICENSE'];
mkdirSync(out, { recursive: true });
for (const f of FILES) cpSync(f, join(out, f), { recursive: true });
const refs = new Set();
const html = readFileSync('index.html', 'utf8');
for (const m of html.matchAll(/(?:src|href)="([^"#:?]+)(?:\?[^"]*)?"/g)) refs.add(m[1]);
const js = readFileSync('reef.js', 'utf8');
for (const m of js.matchAll(/import\(`\.\/([^`?$]+)/g)) refs.add(m[1]);
for (const m of js.matchAll(/fetch\('([^':?]+)'/g)) refs.add(m[1]);
// the modules' own relative imports, so a lib file that imports another is checked too
for (const f of readdirSync('lib'))
  for (const m of readFileSync(join('lib', f), 'utf8').matchAll(/from '\.\/([^']+)'/g)) refs.add('lib/' + m[1]);
const missing = [...refs].filter((r) => !r.startsWith('//') && !existsSync(join(out, r)));
if (missing.length) {
  console.log(`the site refers to files it does not have: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`site: ${FILES.length} entries, ${refs.size} local references, all present`);
