// The pins of the pages that share this origin's node, as GitHub Pages publishes them: Reef, Bight, Winch and Hitch, and the
// node's own demo page (blaketestnode/browser/). Every reference to a script CDN is checked, not only the repository form: on
// cdn.jsdelivr.net a /gh/ path must name a whole commit (owner/repo@<40 hex>, since a tag or branch can be moved) and an /npm/
// path an exact version (name@x.y.z); a /combine/ path, a bare /gh/ or /npm/ prefix, a range (@^1, @latest), a path with . or
// .. segments (or their %2e forms: the browser resolves them to another package), a user name before the host, and every
// other script CDN host (unpkg, esm.sh, cdnjs, …) fail. Hosts are matched in any case, and URLs written with \/ (as in JSON)
// are read as the browser would. A page with no content security policy (Winch, Hitch) has only this check, so there every
// absolute URL written in it fails unless its host is cdn.jsdelivr.net, this origin, or one the apps connect to by name (the
// relays, the block mirror and the explorer, read from reef.js; github.com links; the w3.org namespaces): an import, an unquoted
// src, el.src =, importScripts(a, b), new Worker(new URL(…)) and a URL with \\ for / or an entity in its scheme included. A page
// has a policy only if one is in force in its <head> (one in a comment, a <template> or a <noscript> is not). The four apps
// must also pin the same node (they share its files and its lock); the demo page serves the node's own branch, so it has no
// node pin to compare. Only literal URLs are seen: a URL built from parts at run time is not.
//   node tools/pins.mjs               the pages as published (after a Reef deploy, and by pins.yml)
//   node tools/pins.mjs --local       Reef from this checkout, the others as published (before a Reef deploy)
//   node tools/pins.mjs --of reef.js  the node, library and engine pins of a file, as lines name=commit (for CI)
import { readFileSync } from 'node:fs';
const APPS = [
  'reef/reef.js',
  'reef/index.html',
  'bight/bight.js',
  'bight/index.html',
  'winch/winch.js',
  'winch/index.html',
  'hitch/hitch.js',
  'hitch/index.html',
  'blaketestnode/browser/index.html',
];
const NODE_APPS = ['reef', 'bight', 'winch', 'hitch'];
// the demo page runs the node the apps pin: it reads the commit from Reef's published page at run time, so its one node URL
// is built from that commit (owner/repo@${pin}); anywhere else a URL filled in at run time fails
const RUNTIME = { 'blaketestnode/browser/index.html': ['bitcoin-blake/blaketestnode'] };
// and its policy admits that one URL by the organisation's prefix (a policy has no form for "any commit of one repository": a
// source is a prefix only when it ends in /), so this exact token is allowed on this page and nowhere else
const PREFIXES = { 'blaketestnode/browser/index.html': ['https://cdn.jsdelivr.net/gh/bitcoin-blake/'] };
const main = import.meta.url === `file://${process.argv[1]}`;
const local = process.argv.includes('--local');

// any URL on a host that serves scripts from packages or repositories (with an optional user name before the host)
const CDN_HOSTS =
  '(?:cdn|fastly|gcore|testingcf)\\.jsdelivr\\.net|unpkg\\.com|esm\\.sh|esm\\.run|cdnjs\\.cloudflare\\.com|cdn\\.skypack\\.dev|ga\\.jspm\\.io|jspm\\.dev|cdn\\.statically\\.io|rawcdn\\.githack\\.com|raw\\.githack\\.com';
const CDN_URL = new RegExp(`(?:https?:)?//([^\\s/'"\`@]+@)?(${CDN_HOSTS})(?![\\w.-])(/[^\\s'"\`;),]*)?`, 'gi');
const GH = /^\/gh\/([\w.-]+\/[\w.-]+)@([0-9a-f]{40})(?:\/|$)/;
const NPM = /^\/npm\/((?:@[\w.-]+\/)?[\w.-]+)@(\d+\.\d+\.\d+(?:-[\w.]+)?)(?:\/|$)/;
// a page's text as the browser reads its URLs: \/ (JSON, escaped strings) is /, an entity is its character, and a tab or line
// break inside a scheme is dropped (the browser drops them from a URL)
const unescape = (body) =>
  body
    .replace(/\\\//g, '/')
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&colon;/gi, ':')
    .replace(/&sol;/gi, '/')
    .replace(/\b(h[\t\r\n]*t[\t\r\n]*t[\t\r\n]*p[\t\r\n]*s?|w[\t\r\n]*s[\t\r\n]*s?)[\t\r\n]*:/gi, (m) => m.replace(/[\t\r\n]/g, ''));
// every absolute URL a page writes, wherever it is used (an import, a src with or without quotes, a property, a worker): with a
// scheme and // or \\ (the browser reads \ as / there), or scheme-relative after a quote, = or ( → its host, lower case
const ABS_URL =
  /\b(?:https?|wss?):[\\/]{2}(?:[^\s/\\'"`<>@]+@)?([^\s/\\'"`<>?#:;,)]+)|(?:['"`=(]\s*)[\\/]{2}([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
// the hosts the apps connect to by name, read from Reef's own constants (so the list is never written twice): the relays, the
// block mirror, the explorer; then source links and the XML namespaces of an inline SVG
export function connectHosts(reefSrc) {
  const hosts = new Set(['cdn.jsdelivr.net', 'bitcoin-blake.github.io', 'github.com', 'www.w3.org']);
  for (const name of ['DEFAULT_RELAYS', 'TIP_RELAYS', 'DEFAULT_SNAP', 'DEFAULT_BLOCKS', 'EXPLORER']) {
    const m = reefSrc.match(new RegExp(`\\b${name} = (\\[[^\\]]*\\]|'[^']*')`));
    for (const u of m?.[1].match(/(?:https?|wss?):\/\/[^/'"\s]+/g) ?? []) hosts.add(new URL(u).host.toLowerCase());
  }
  return hosts;
}
const REEF_SRC = (() => {
  try {
    return readFileSync(new URL('../reef.js', import.meta.url), 'utf8');
  } catch {
    return '';
  }
})();
const ALLOWED = connectHosts(REEF_SRC);
// a URL's verdict: { repo, ref } when it is pinned as the rules above say, else { why }
export function judge(host, path = '', user = '') {
  host = host.toLowerCase();
  if (user) return { why: `a user name before the host (${user}): the URL is not what it seems` };
  if (host !== 'cdn.jsdelivr.net') return { why: `${host} is not an allowed script CDN (only cdn.jsdelivr.net with pinned paths)` };
  if (/%2e|%2f|(?:^|\/)\.{1,2}(?:\/|$)/i.test(path))
    return { why: 'a path with . or .. segments (or %2e, %2f): the browser resolves it to another package' };
  let m = path.match(GH);
  if (m) return { repo: m[1], ref: m[2] };
  // a commit filled in at run time (owner/repo@${name}): not judged here; allowed only where RUNTIME says so
  m = path.match(/^\/gh\/([\w.-]+\/[\w.-]+)@\$\{[A-Za-z_$][\w$]*\}(?:\/|$)/);
  if (m) return { repo: m[1], runtime: true };
  m = path.match(NPM);
  if (m) return { repo: 'npm:' + m[1], ref: m[2] };
  if (path.startsWith('/gh/'))
    return { why: 'a /gh/ path not pinned to a whole commit (owner/repo@<40 hex>): a tag or branch can be moved' };
  if (path.startsWith('/npm/')) return { why: 'an /npm/ path not pinned to an exact version (name@x.y.z): a range or tag can move' };
  return { why: `${path || 'the bare host'}: only /gh/ and /npm/ paths can be pinned (combine and the like cannot)` };
}
// every CDN reference of a page's text, judged: [{ url, repo, ref } | { url, why }]
export function cdnRefs(body) {
  return [...unescape(body).matchAll(CDN_URL)].map(([url, user, host, path]) => ({ url, ...judge(host, path ?? '', user ?? '') }));
}
// the absolute URLs of a page whose host is none of the allowed ones: refused where no policy stops them
export function offCdn(body, allowed = ALLOWED) {
  return [...unescape(body).matchAll(ABS_URL)]
    .map((m) => ({ url: m[0].replace(/^['"`=(]\s*/, ''), host: (m[1] ?? m[2]).toLowerCase() }))
    .filter((r) => !allowed.has(r.host))
    .map((r) => r.url);
}
// does a page have a policy in force: a policy meta in its <head>, comments, templates and noscripts set aside
export function hasPolicy(body) {
  const live = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<template[\s>][\s\S]*?<\/template>/gi, '')
    .replace(/<noscript[\s>][\s\S]*?<\/noscript>/gi, '');
  // the head as the browser builds it: up to </head> or <body (the <head> tag itself may be left out)
  const end = live.search(/<\/head>|<body[\s>]/i);
  const head = end < 0 ? live : live.slice(0, end);
  return /<meta\b[^>]*\bhttp-equiv\s*=\s*(["']?)Content-Security-Policy\1/i.test(head);
}
// the first pin of each repository in a file: { 'owner/repo': commit }
export function pinsOf(src) {
  const out = {};
  for (const r of cdnRefs(src)) if (r.repo && !r.repo.startsWith('npm:')) out[r.repo] ??= r.ref;
  return out;
}
// one page's text judged: its failures and its pins (the two exceptions above apply to their own page only)
export function pageVerdict(f, body, policed) {
  const failures = [],
    pins = [];
  for (const r of cdnRefs(body)) {
    if (r.runtime) {
      if (!(RUNTIME[f] ?? []).includes(r.repo)) failures.push(`${f}: ${r.url}: a commit filled in at run time cannot be checked here`);
    } else if (r.why) {
      if (!(PREFIXES[f] ?? []).includes(r.url)) failures.push(`${f}: ${r.url}: ${r.why}`);
    } else pins.push(r);
  }
  if (!policed)
    for (const u of offCdn(body)) failures.push(`${f}: ${u}: a host the apps do not connect to by name, on a page with no security policy`);
  return { failures, pins };
}
if (main && process.argv.includes('--of')) {
  const p = pinsOf(readFileSync(process.argv[process.argv.indexOf('--of') + 1], 'utf8'));
  console.log(`node=${p['bitcoin-blake/blaketestnode'] ?? ''}`);
  console.log(`lib=${p['sidestr/spec'] ?? ''}`);
  console.log(`engine=${p['bitcoin-desktop/schema'] ?? ''}`);
  process.exit(0);
} else if (main) {
  let failed = 0;
  const fail = (m) => {
    console.log(`::error::${m}`);
    failed++;
  };
  const bodies = {};
  for (const f of APPS) {
    const app = f.split('/')[0];
    if (local && app === 'reef') bodies[f] = readFileSync(new URL('../' + f.slice(5), import.meta.url), 'utf8');
    else {
      const r = await fetch(`https://bitcoin-blake.github.io/${f}?nocache=${Date.now()}`, { cache: 'no-store' }).catch((e) => ({
        ok: false,
        statusText: e.message,
      }));
      if (!r.ok) {
        fail(`could not fetch ${f} from Pages (${r.status ?? ''} ${r.statusText}): the site, not the pins`);
        continue;
      }
      bodies[f] = await r.text();
    }
  }
  // which pages carry a content security policy (in their index.html)
  const policed = new Set(
    Object.entries(bodies)
      .filter(([f, b]) => f.endsWith('index.html') && hasPolicy(b))
      .map(([f]) => f.split('/')[0]),
  );
  const byApp = {};
  for (const [f, body] of Object.entries(bodies)) {
    const app = f.split('/')[0];
    const pins = (byApp[app] ??= new Map());
    const v = pageVerdict(f, body, policed.has(app));
    v.failures.forEach(fail);
    for (const r of v.pins) (pins.get(r.repo) ?? pins.set(r.repo, new Set()).get(r.repo)).add(r.ref);
  }
  for (const [app, pins] of Object.entries(byApp))
    console.log(
      `${app}${local && app === 'reef' ? ' (this checkout)' : ''}${policed.has(app) ? '' : ' (no security policy)'}: ${[...pins].map(([repo, refs]) => `${repo}@${[...refs].join(',')}`).join('  ') || 'no pins'}`,
    );
  const nodes = NODE_APPS.filter((a) => byApp[a]).map((app) => [app, [...(byApp[app].get('bitcoin-blake/blaketestnode') ?? [])]]);
  for (const [app, refs] of nodes) if (refs.length !== 1) fail(`${app} pins ${refs.length} node versions (${refs.join(', ') || 'none'})`);
  if (new Set(nodes.map(([, refs]) => refs.join())).size > 1)
    fail(
      `the apps pin different node versions: ${nodes.map(([a, r]) => `${a} ${r.join(',').slice(0, 7)}`).join(', ')}` +
        (local ? ' (release the other apps on this pin first: README, Releasing)' : ''),
    );
  if (!failed) console.log(`all four pin the node at ${nodes[0]?.[1][0]}; every CDN reference is a whole commit or an exact version`);
  process.exit(failed ? 1 : 0);
}
