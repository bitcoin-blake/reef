// The release itself: the version said the same in three places, and every pinned file (the node's loader, the wallet's code,
// the engine's rule files) the one at its pinned commit, with the security policy naming exactly those pins and nothing more,
// and the pins check (tools/pins.mjs) refusing every CDN reference that is not a whole commit or an exact version.
// Needs the checkouts: SCHEMA=<bitcoin-desktop/schema> SIDESTR_LIB=<spec/siding/lib> BLAKETESTNODE=<blaketestnode>
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
const H = (p) => p.replace(/^~/, homedir());
// the same defaults as the other tests
const SCHEMA = H(process.env.SCHEMA ?? '~/bitcoin-desktop/schema'),
  SPEC = H(process.env.SIDESTR_LIB ?? '~/remote/github.com/sidestr/spec/siding/lib').replace(/\/siding\/lib\/?$/, ''),
  BTN = H(process.env.BLAKETESTNODE ?? '~/remote/github.com/bitcoin-blake/blaketestnode');
// a file at a commit of a checkout (null when it cannot be read)
const show = (dir, ref, path, encoding) => {
  try {
    return execSync(`git -C ${dir} show ${ref}:${path}`, { encoding, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 });
  } catch {
    return null;
  }
};
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
let ok = 0,
  failed = 0;
const t = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`);
  cond ? ok++ : failed++;
};
// a policy as { directive: Set(tokens) }
const parseCsp = (csp) =>
  Object.fromEntries(
    csp
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map(([k, ...v]) => [k, new Set(v)]),
  );
const cspDiff = (csp, want) => {
  const got = parseCsp(csp),
    out = [];
  for (const k of new Set([...Object.keys(got), ...Object.keys(want)])) {
    const g = got[k] ?? new Set(),
      w = new Set(want[k] ?? []);
    const extra = [...g].filter((x) => !w.has(x)),
      lack = [...w].filter((x) => !g.has(x));
    if (!got[k]) out.push(`${k} missing`);
    else if (!want[k]) out.push(`${k} not expected`);
    if (extra.length) out.push(`${k} +${extra.join(' +')}`);
    if (lack.length) out.push(`${k} -${lack.join(' -')}`);
  }
  return out.join('; ');
};
const cspMatches = (csp, want) => cspDiff(csp, want) === '';
// ---- the page's version and version.json agree (a release that forgets one shows a false update banner)
{
  const src = readFileSync(new URL('../reef.js', import.meta.url), 'utf8');
  const v = src.match(/export const VERSION = '([^']+)'/)?.[1];
  const j = JSON.parse(readFileSync(new URL('../version.json', import.meta.url), 'utf8'));
  t('reef.js VERSION matches version.json', v && v === j.version, `${v} vs ${j.version}`);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  t('index.html loads reef.js?v= the same version', html.includes(`reef.js?v=${v}"`));
  const node = src.match(/blaketestnode@([0-9a-f]{40})/)?.[1],
    lib = src.match(/sidestr\/spec@([0-9a-f]{40})/)?.[1],
    eng = src.match(/schema@([0-9a-f]{40})/)?.[1];
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
  {
    // the engine's rule files: the hashes in reef.js are those of the files at the pinned commit
    const want = Object.fromEntries([...src.matchAll(/'(schema\/[a-z0-9/-]+\.jsonld)': '([0-9a-f]{64})'/g)].map((m) => [m[1], m[2]]));
    const wrong = Object.entries(want).filter(([f, h]) => {
      const body = show(SCHEMA, eng, f);
      return !body || sha256(body) !== h;
    });
    const fetched = [...src.matchAll(/j\(['`](schema\/[^'`$]+)['`]\)/g)].map((m) => m[1]);
    t(
      'every rule file the page fetches by name has a pinned hash',
      fetched.length >= 1 && fetched.every((f) => want[f]),
      fetched.join(', '),
    );
    t(
      'the six rule files are pinned by hash, and the hashes are those at the pinned engine commit',
      Object.keys(want).length === 6 && !wrong.length,
      wrong.map(([f]) => f).join(', '),
    );
  }
  {
    // the wallet's code is checked by sha256 in the page: each hash is that of the file at the pinned commit, and the table
    // covers every file the entries import (the page refuses a file it has no hash for, so a gap would stop the wallet)
    const want = Object.fromEntries([...src.matchAll(/'((?:siding|codec)\/[a-z0-9/.-]+)': '([0-9a-f]{64})'/g)].map((m) => [m[1], m[2]]));
    const fileAt = (f) => (f.startsWith('siding/') ? show(SPEC, lib, f) : show(SCHEMA, eng, f));
    const RE = new RegExp(src.match(/const IMPORT_RE = \/(.+)\/g;/)[1], 'g');
    // every import in the graph, relative or not: only relative ones are rewritten to checked blobs, so a pinned file that one
    // day imported a full URL (allowed by the policy's pinned prefix) would run unchecked
    const ANY = new RegExp(src.match(/const ANY_IMPORT_RE = \/(.+)\/g;/)[1], 'g'); // the page's own pattern
    const wrong = [],
      missing = [],
      absolute = [];
    let imports = 0;
    const walk = (f, seen = new Set()) => {
      if (seen.has(f)) return;
      seen.add(f);
      if (!want[f]) return missing.push(f);
      const body = fileAt(f);
      if (!body) return wrong.push(f);
      if (sha256(body) !== want[f]) wrong.push(f);
      for (const m of String(body).matchAll(ANY)) {
        imports++;
        if (!/^\.{1,2}\//.test(m[2])) absolute.push(`${f} imports ${m[2]}`);
      }
      for (const m of String(body).matchAll(RE)) {
        const u = new URL(m[3], 'https://x/' + f);
        walk(u.pathname.slice(1) + u.search, seen);
      }
    };
    const entries = [...src.matchAll(/(?:spec|engine)\('((?:siding|codec)\/[^']+)'\)/g)].map((m) => m[1]);
    const seen = new Set();
    entries.forEach((f) => walk(f, seen));
    t(
      "every file of the wallet's code is pinned by hash at the pinned commits, the whole import graph included",
      entries.length > 0 && !wrong.length && !missing.length && seen.size === Object.keys(want).length,
      `entries ${entries.length}, wrong ${wrong.join(', ')}, missing ${missing.join(', ')}, ${seen.size} walked vs ${Object.keys(want).length} pinned`,
    );
    t(
      "no file of the wallet's code imports anything but a relative path (only those are checked)",
      imports > 0 && !absolute.length,
      absolute.join('; ') || `${imports} imports`,
    );
  }
  {
    // the node's loader is checked by sha256 in the page: the hash is that of the file at the pinned node commit
    const want = src.match(/const TABNODE_SHA256 = '([0-9a-f]{64})'/)?.[1];
    const body = show(BTN, node, 'browser/tabnode.js');
    const got = body && sha256(body);
    t("the node loader's pinned sha256 is the file's at the pinned node commit", !!want && want === got, `${want} vs ${got}`);
  }
  {
    // the policy, directive by directive: script-src and worker-src are exactly the pins (no stale pin, no bare prefix that
    // would admit any repository, nothing unsafe), and the fixed directives are as written
    const w = show(BTN, node, 'browser/worker.js', 'utf8') ?? '';
    const tn = show(BTN, node, 'browser/tabnode.js', 'utf8') ?? '';
    const wpins = [...new Set([...w.matchAll(/https:\/\/cdn\.jsdelivr\.net\/gh\/[^'"`]+?@[0-9a-f]{40}/g)].map((m) => m[0] + '/'))];
    const wt = tn.match(/const WT_URL = '([^']+)'/)?.[1];
    const qr = html.match(/<script[^>]* src="(https:\/\/cdn\.jsdelivr\.net\/npm\/qrcode-generator@[^"]+)"/)?.[1];
    t('the node worker imports at least two pinned paths, and the loader names its WebTorrent build', wpins.length >= 2 && !!wt && !!qr);
    const pinned = [
      `https://cdn.jsdelivr.net/gh/bitcoin-blake/blaketestnode@${node}/`,
      `https://cdn.jsdelivr.net/gh/sidestr/spec@${lib}/`,
      `https://cdn.jsdelivr.net/gh/bitcoin-desktop/schema@${eng}/`,
      ...wpins,
    ];
    const want = {
      'default-src': ["'self'"],
      'script-src': ["'self'", 'blob:', ...pinned, qr, wt],
      'worker-src': ["'self'", 'blob:', ...pinned],
      'connect-src': ["'self'", 'https:', 'wss:'],
      'img-src': ["'self'", 'data:', 'blob:'],
      'style-src': ["'self'", "'unsafe-inline'"],
      'object-src': ["'none'"],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
    };
    t('the security policy is exactly the expected one', cspMatches(csp, want), cspDiff(csp, want));
  }
}

{
  // the checker itself refuses each policy a release could drift to (a stale pin, a bare prefix, unsafe-eval, a wildcard, a
  // dropped directive, another version of a script)
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
  const want = Object.fromEntries(Object.entries(parseCsp(csp)).map(([k, v]) => [k, [...v]]));
  const drifts = [
    (c) =>
      c.replace(
        "script-src 'self'",
        "script-src 'self' https://cdn.jsdelivr.net/gh/bitcoin-blake/blaketestnode@c03bf56404e986bf633a44d8a7bbb530ec282cb5/",
      ),
    (c) => c.replace("script-src 'self'", "script-src 'self' https://cdn.jsdelivr.net/gh/"),
    (c) => c.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"),
    (c) => c.replace("connect-src 'self' https: wss:", 'connect-src *'),
    (c) => c.replace("; object-src 'none'", ''),
    (c) => c.replace('qrcode-generator@1.4.4', 'qrcode-generator@1.4.5'),
    (c) => c.replace('webtorrent@3.0.21', 'webtorrent@3.0.22'),
    (c) => c.replace("base-uri 'none'", "base-uri 'self'"),
  ];
  t(
    'the policy check refuses each drift (stale pin, bare prefix, unsafe-eval, wildcard, dropped directive, other versions)',
    cspMatches(csp, want) && drifts.every((d) => !cspMatches(d(csp), want)),
    drifts
      .map((d, i) => (cspMatches(d(csp), want) ? `drift ${i} passed` : ''))
      .filter(Boolean)
      .join(', '),
  );
}
{
  // tools/pins.mjs: every CDN reference is judged, not only owner/repo@ref, and only a whole commit or an exact version passes
  const { judge } = await import('../tools/pins.mjs');
  const C = 'cdn.jsdelivr.net';
  const refused = [
    [C, '/gh/evil/x/a.js'],
    [C, '/gh/evil/x@^1/a.js'],
    [C, '/gh/a/b@v0.0.27/x.js'],
    [C, '/gh/'],
    [C, '/npm/evil@latest'],
    [C, '/npm/evil/a.js'],
    [C, '/npm/evil@^1.2.3/a.js'],
    [C, '/combine/gh/a/b@1/x.js'],
    [C, ''],
    ['esm.sh', '/evil'],
    ['unpkg.com', '/evil@1.0.0/a.js'],
  ];
  const passed = [
    [C, '/gh/a/b@' + 'ab'.repeat(20) + '/x.js'],
    [C, '/npm/qrcode-generator@1.4.4/qrcode.js'],
    [C, '/npm/@scope/n@1.2.3-rc.1/x.js'],
  ];
  t(
    'the pins check refuses every unpinned CDN reference and passes whole commits and exact versions',
    refused.every(([h, p]) => judge(h, p).why) && passed.every(([h, p]) => !judge(h, p).why),
    [...refused.filter(([h, p]) => !judge(h, p).why), ...passed.filter(([h, p]) => judge(h, p).why)].map(([h, p]) => h + p).join(', '),
  );
}

console.log(`\n${ok} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
