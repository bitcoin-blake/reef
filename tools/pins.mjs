// The pins of the four apps that share this origin's node (Reef, Bight, Winch, Hitch), as GitHub Pages publishes them: every
// CDN path pinned to a repository (cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>) must be pinned to a whole commit (a tag can be
// moved), and the four must pin the same node (they share its files and its lock). The library and engine pins are listed.
//   node tools/pins.mjs               the four as published (hourly, and after a Reef deploy)
//   node tools/pins.mjs --local       Reef from this checkout, the others as published (before a Reef deploy)
const APPS = ['reef/reef.js', 'reef/index.html', 'bight/bight.js', 'bight/index.html', 'winch/winch.js', 'winch/index.html', 'hitch/hitch.js', 'hitch/index.html'];
const local = process.argv.includes('--local');
const { readFileSync } = await import('node:fs');

const GH = /cdn\.jsdelivr\.net\/gh\/([\w.-]+\/[\w.-]+)@([\w.-]+)/g;
let failed = 0;
const fail = (m) => {
  console.log(`::error::${m}`);
  failed++;
};
const byApp = {};
for (const f of APPS) {
  const app = f.split('/')[0];
  let body;
  if (local && app === 'reef') body = readFileSync(new URL('../' + f.slice(5), import.meta.url), 'utf8');
  else {
    const r = await fetch(`https://bitcoin-blake.github.io/${f}?nocache=${Date.now()}`, { cache: 'no-store' }).catch((e) => ({ ok: false, statusText: e.message }));
    if (!r.ok) {
      fail(`could not fetch ${f} from Pages (${r.status ?? ''} ${r.statusText}): the site, not the pins`);
      continue;
    }
    body = await r.text();
  }
  const pins = (byApp[app] ??= new Map());
  for (const [, repo, ref] of body.matchAll(GH)) {
    (pins.get(repo) ?? pins.set(repo, new Set()).get(repo)).add(ref);
    if (!/^[0-9a-f]{40}$/.test(ref)) fail(`${f} pins ${repo}@${ref}: not a whole commit (a tag or branch can be moved)`);
  }
}
for (const [app, pins] of Object.entries(byApp))
  console.log(`${app}${local && app === 'reef' ? ' (this checkout)' : ''}: ${[...pins].map(([repo, refs]) => `${repo}@${[...refs].join(',')}`).join('  ') || 'no pins'}`);
const nodes = Object.entries(byApp).map(([app, pins]) => [app, [...(pins.get('bitcoin-blake/blaketestnode') ?? [])]]);
for (const [app, refs] of nodes) if (refs.length !== 1) fail(`${app} pins ${refs.length} node versions (${refs.join(', ') || 'none'})`);
if (new Set(nodes.map(([, refs]) => refs.join())).size > 1)
  fail(
    `the apps pin different node versions: ${nodes.map(([a, r]) => `${a} ${r.join(',').slice(0, 7)}`).join(', ')}` +
      (local ? ' (release the other apps on this pin first: README, Releasing)' : ''),
  );
if (!failed) console.log(`all four pin the node at ${nodes[0]?.[1][0]}, and every repository pin is a whole commit`);
process.exit(failed ? 1 : 0);
