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
// a policy as { directive: Set(tokens) }, directive names in lower case as the browser reads them; a directive written twice
// is listed in `repeated` (the browser enforces the first copy and ignores the second, so a checker must not read the last)
const parseCsp = (csp) => {
  const out = {},
    repeated = [];
  for (const [k0, ...v] of csp
    .split(';')
    .map((d) => d.trim().split(/\s+/))
    .filter((d) => d[0])) {
    const k = k0.toLowerCase();
    if (out[k]) repeated.push(k);
    else out[k] = new Set(v);
  }
  return Object.defineProperty(out, 'repeated', { value: repeated, enumerable: false });
};
const cspDiff = (csp, want) => {
  const got = parseCsp(csp),
    out = got.repeated.map((k) => `${k} repeated`);
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
// the page as the browser acts on it: a policy in a comment, a <template> or a <noscript> is text, not a policy in force
const liveHtml = (html) =>
  html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<template[\s>][\s\S]*?<\/template>/gi, '')
    .replace(/<noscript[\s>][\s\S]*?<\/noscript>/gi, '');
// a policy meta however its attribute is quoted (double, single, none)
const CSP_META = /<meta\b[^>]*\bhttp-equiv\s*=\s*(["']?)Content-Security-Policy\1[^>]*>/gi;
// the one policy in force: its content, or '' when there is none or more than one (two metas: the browser enforces both)
const cspOf = (html) => {
  const metas = liveHtml(html).match(CSP_META) ?? [];
  if (metas.length !== 1) return '';
  return (
    metas[0]
      .match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i)
      ?.slice(1)
      .find((x) => x != null) ?? ''
  );
};
// the policy meta sits in <head>, before the first <script (a meta policy governs only what is parsed after it)
const cspPlaced = (html0) => {
  const html = liveHtml(html0);
  const head = html.search(/<head[\s>]/i),
    endHead = html.search(/<\/head>/i),
    meta = html.search(new RegExp(CSP_META.source, 'i')),
    script = html.search(/<script[\s>]/i);
  return head >= 0 && meta > head && (endHead < 0 || meta < endHead) && (script < 0 || meta < script);
};
const { pinsOf, judge, cdnRefs, offCdn, pageVerdict, hasPolicy, strictPolicy } = await import('../tools/pins.mjs');
// ---- the page's version and version.json agree (a release that forgets one shows a false update banner)
{
  const src = readFileSync(new URL('../reef.js', import.meta.url), 'utf8');
  const v = src.match(/export const VERSION = '([^']+)'/)?.[1];
  const j = JSON.parse(readFileSync(new URL('../version.json', import.meta.url), 'utf8'));
  t('reef.js VERSION matches version.json', v && v === j.version, `${v} vs ${j.version}`);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  t('index.html loads reef.js?v= the same version', html.includes(`reef.js?v=${v}"`));
  const pins = pinsOf(src); // as CI reads them (tools/pins.mjs --of)
  const node = pins['bitcoin-blake/blaketestnode'],
    lib = pins['sidestr/spec'],
    eng = pins['bitcoin-desktop/schema'];
  t('the node, library and engine pins are read from reef.js', !!node && !!lib && !!eng);
  t(
    'the security policy is the first thing in <head> that can matter: before any script (a policy only covers what comes after it)',
    cspPlaced(html),
  );
  const csp = cspOf(html);
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
      // Reef has no frames: no page of this origin (Winch, Hitch, without a policy of their own) can be framed into it
      'frame-src': ["'none'"],
      'child-src': ["'none'"],
    };
    t('the security policy is exactly the expected one', cspMatches(csp, want), cspDiff(csp, want));
  }
}

{
  // the checker itself refuses each policy a release could drift to (a stale pin, a bare prefix, unsafe-eval, a wildcard, a
  // dropped directive, another version of a script)
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const csp = cspOf(html);
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
    (c) => c.replace("; frame-src 'none'", ''),
    (c) => "script-src * 'unsafe-inline' 'unsafe-eval'; " + c, // a second script-src in front: the browser enforces the first
    (c) => c.replace('script-src', 'SCRIPT-SRC') + "; script-src 'self'", // the same, in another case
  ];
  t(
    'the policy check refuses each drift (stale pin, bare prefix, unsafe-eval, wildcard, dropped directive, other versions, a directive written twice)',
    cspMatches(csp, want) && drifts.every((d) => !cspMatches(d(csp), want)),
    drifts
      .map((d, i) => (cspMatches(d(csp), want) ? `drift ${i} passed` : ''))
      .filter(Boolean)
      .join(', '),
  );
  // and the policy's place: moved into <body>, or after a script, it is refused
  const meta = html.match(/<meta[^>]+http-equiv="Content-Security-Policy"[^>]*>/)?.[0] ?? '';
  const inBody = html.replace(meta, '').replace(/<body([^>]*)>/i, (m) => m + meta);
  const afterScript = html.replace(meta, '').replace(/(<script[\s\S]*?<\/script>)/i, (m) => m + meta);
  t(
    'the placement check refuses a policy moved into <body> or after a script',
    cspPlaced(html) && !cspPlaced(inBody) && !cspPlaced(afterScript),
  );
  // a policy written but not in force: in a comment (with a weak real one, or none), in a <template>, in a <noscript>
  const weak = `<meta http-equiv='Content-Security-Policy' content="script-src *">`;
  const notInForce = [
    html.replace(meta, `<!--${meta}-->${weak}`),
    html.replace(meta, `<!--${meta}-->`),
    html.replace(meta, `<template>${meta}</template>`),
    html.replace(meta, `<noscript>${meta}</noscript>`),
    html.replace(meta, meta + weak), // a second policy beside it
  ];
  t(
    'a policy that is in the file but not in force (a comment, a template, a noscript) or a second one beside it is refused',
    cspMatches(cspOf(html), want) && notInForce.every((h) => !(cspPlaced(h) && cspMatches(cspOf(h), want))),
    notInForce
      .map((h, i) => (cspPlaced(h) && cspMatches(cspOf(h), want) ? `case ${i} passed` : ''))
      .filter(Boolean)
      .join(', '),
  );
}
{
  // tools/pins.mjs: every CDN reference is judged, not only owner/repo@ref, and only a whole commit or an exact version passes
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
    [C, '/gh/a/b@' + 'ab'.repeat(20) + '/../../../npm/evil@latest/x.js'], // the browser resolves it to /npm/evil@latest
    [C, '/gh/a/b@' + 'ab'.repeat(20) + '/%2e%2e/%2e%2e/%2e%2e/npm/evil@latest/x.js'],
    [C, '/npm/x@1.2.3/../x@latest/a.js'],
    [C, ''],
    ['esm.sh', '/evil'],
    ['unpkg.com', '/evil@1.0.0/a.js'],
  ];
  const passed = [
    [C, '/gh/a/b@' + 'ab'.repeat(20) + '/x.js'],
    [C, '/npm/qrcode-generator@1.4.4/qrcode.js'],
    [C, '/npm/@scope/n@1.2.3-rc.1/x.js'],
  ];
  // read from a page's text: any case of the host, \/ as in JSON, a user name before the host
  const pinned = 'https://cdn.jsdelivr.net/gh/a/b@' + 'ab'.repeat(20) + '/x.js';
  const texts = [
    "import('https://CDN.jsdelivr.net/gh/evil/x@main/a.js')",
    '{"u":"https:\\/\\/cdn.jsdelivr.net\\/gh\\/evil\\/x@main\\/a.js"}',
    "import('https://user@cdn.jsdelivr.net/gh/a/b@" + 'ab'.repeat(20) + "/x.js')",
  ];
  t(
    "the pins check reads a page's URLs as the browser does (host in any case, \\/ as /, a user name before the host)",
    texts.every((x) => cdnRefs(x).some((r) => r.why)) && cdnRefs(`import('${pinned}')`).every((r) => !r.why),
    texts.filter((x) => !cdnRefs(x).some((r) => r.why)).join(' | '),
  );
  t(
    'on a page without a security policy, a script from any other host is found (raw GitHub, another github.io, a mirror)',
    offCdn("import('https://raw.githubusercontent.com/a/b/main/x.js')").length === 1 &&
      offCdn('<script src="https://evil.github.io/x.js"></script>').length === 1 &&
      offCdn("new Worker('//fastly.jsdelivr.net/gh/a/b@main/w.js')").length === 1 &&
      offCdn(`import('${pinned}'); import('https://bitcoin-blake.github.io/reef/x.js')`).length === 0,
  );
  {
    // every way a page with no policy can name another host, each found (the reviewer's probes)
    const E = 'evil.example';
    const ways = [
      `import "https://${E}/x.js";`, // an import with no from
      `<script src=https://${E}/x.js></script>`, // unquoted
      `<script src="\\\\${E}/x.js"></script>`, // \\ for // (the browser reads \ as / here)
      `import('https:\\\\${E}/x.js')`,
      `el.src = 'https://${E}/x.js';`,
      `importScripts('./a.js', 'https://${E}/b.js');`, // the second argument
      `new Worker(new URL('https://${E}/w.js'));`,
      `<script src="ht&#x74;ps://${E}/x.js"></script>`, // an entity inside the scheme
      `<script src="htt\tps://${E}/x.js"></script>`, // a tab inside the scheme
      `fetch('wss://${E}/')`,
    ];
    const missed = ways.filter((w) => offCdn(w).length !== 1);
    t(
      'on a page without a policy, any other host is found however it is written (no from, no quotes, \\, a property, a worker, an entity or tab in the scheme)',
      missed.length === 0,
      missed.join(' | '),
    );
    t(
      'the hosts the apps connect to by name pass: the relays, the mirror and the explorer read from reef.js, github.com, w3.org',
      offCdn(
        "new WebSocket('wss://nos.lol'); fetch(DEFAULT_BLOCKS); x = 'https://mempool.guide/testnet4'; a = 'https://github.com/x'; ns = 'http://www.w3.org/2000/svg'",
      ).length === 0,
    );
    const meta = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">';
    t(
      'a page has a policy only when one is in force in its head (not in a comment, a template or a noscript; the head tag may be left out)',
      hasPolicy(`<html><head>${meta}</head><body></body>`) &&
        hasPolicy(`<!doctype html>${meta}<title>x</title><body>`) &&
        !hasPolicy(`<head><!--${meta}--></head>`) &&
        !hasPolicy(`<head><template>${meta}</template></head>`) &&
        !hasPolicy(`<head><noscript>${meta}</noscript></head>`) &&
        !hasPolicy(`<head></head><body>${meta}</body>`),
    );
    // two tiers: a host the apps connect to is allowed for connections, never for code (the round-16 list let both through)
    t(
      'on a page without a policy, code from a host the apps only connect to is refused (a script src, an import, importScripts)',
      offCdn('<script src="https://melvin.me/x.js"></script>').length === 1 &&
        offCdn('import("https://mempool.guide/a.js")').length === 1 &&
        offCdn("importScripts('./a.js', 'https://mempool.guide/b.js')").length === 1 &&
        offCdn("new Worker(new URL('wss://nos.lol/w.js'))").length === 1 &&
        offCdn("new WebSocket('wss://nos.lol'); x = 'https://mempool.guide/testnet4'").length === 0,
    );
    // a policy that limits nothing, or a meta that is only text, does not count as one (the page is judged as if it had none)
    const weak = (c) => `<head><meta http-equiv="Content-Security-Policy" content="${c}"></head>`;
    t(
      'a page counts as policed only with a strict script-src (or default-src): empty, unknown, *, https:, unsafe-inline or unsafe-eval do not count, nor a meta inside a script, style, title or textarea',
      [`script-src 'self'`, `default-src 'self'`, `script-src 'self' blob: 'wasm-unsafe-eval'`].every((c) => strictPolicy(c)) &&
        [
          '',
          'x',
          'script-src *',
          "script-src 'self' https:",
          "script-src 'self' 'unsafe-inline'",
          "default-src 'self' 'unsafe-eval'",
          "script-src 'self' https://*.example",
        ].every((c) => !strictPolicy(c)) &&
        !hasPolicy(weak('')) &&
        !hasPolicy(weak('x')) &&
        !hasPolicy(`<head><script>var m = '${meta}'</script></head>`) &&
        ['style', 'title', 'textarea'].every((tag) => !hasPolicy(`<head><${tag}>${meta}</${tag}></head>`)),
    );
  }
  t(
    'pinsOf: the first pin of each repository, as CI reads them',
    pinsOf(`'${pinned}'; 'https://cdn.jsdelivr.net/gh/a/b@${'cd'.repeat(20)}/y.js'`)['a/b'] === 'ab'.repeat(20),
  );
  {
    // the demo page's two exceptions (its node URL built from Reef's pin, its policy's organisation prefix) hold on that page only
    const demo = 'blaketestnode/browser/index.html';
    const body =
      '<meta http-equiv="Content-Security-Policy" content="script-src https://cdn.jsdelivr.net/gh/bitcoin-blake/">' +
      '<script>const base = `https://cdn.jsdelivr.net/gh/bitcoin-blake/blaketestnode@${pin}`;</script>';
    const fails = (f, b) => pageVerdict(f, b, true).failures.length;
    t(
      "the demo page's run-time node URL and its organisation prefix pass there, and fail on any other page",
      fails(demo, body) === 0 &&
        fails('reef/index.html', body) === 2 &&
        fails(demo, body.replace('bitcoin-blake/blaketestnode@', 'evil/x@')) === 1 &&
        fails(demo, body.replace('gh/bitcoin-blake/">', 'gh/">')) === 1,
      JSON.stringify([pageVerdict(demo, body, true).failures, pageVerdict('reef/index.html', body, true).failures]),
    );
  }
  t(
    'a commit filled in at run time is never taken as a pin',
    cdnRefs('`https://cdn.jsdelivr.net/gh/bitcoin-blake/blaketestnode@${pin}`').every((r) => r.runtime && !r.ref),
  );
  t(
    'the pins check refuses every unpinned CDN reference and passes whole commits and exact versions',
    refused.every(([h, p]) => judge(h, p).why) && passed.every(([h, p]) => !judge(h, p).why),
    [...refused.filter(([h, p]) => !judge(h, p).why), ...passed.filter(([h, p]) => judge(h, p).why)].map(([h, p]) => h + p).join(', '),
  );
}

console.log(`\n${ok} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
