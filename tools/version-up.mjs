// CI: when the code changed since `base`, version.json must have gone up (a version not above the last is never offered
// to open tabs, so they would keep running the old code). Usage: node tools/version-up.mjs <base-commit>
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const base = process.argv[2];
const sh = (c) => execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
let changed;
try {
  changed = sh(`git diff --name-only ${base} HEAD`).split('\n');
} catch {
  console.log('no base commit to compare with');
  process.exit(0);
}
if (!changed.some((f) => /^(reef\.js|lib\/|index\.html)/.test(f))) process.exit(0);
const key = (v) => (/^(\d{4})-(\d{2})-(\d{2})\.(\d+)$/.exec(v) ?? []).slice(1).map(Number);
const now = JSON.parse(readFileSync('version.json', 'utf8')).version;
const was = JSON.parse(sh(`git show ${base}:version.json`)).version;
const [a, b] = [key(now), key(was)];
const i = a.findIndex((x, j) => x !== b[j]);
if (a.length !== 4 || b.length !== 4 || i < 0 || a[i] < b[i]) {
  console.log(`version ${now} is not above ${was}: bump version.json with the code (README, Releasing)`);
  process.exit(1);
}
console.log(`version ${was} → ${now}`);
