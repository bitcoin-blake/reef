// The release itself: the version said the same in three places, and every pinned file (the node's loader, the wallet's code,
// the engine's rule files) the one at its pinned commit, with the security policy naming exactly those pins.
// Needs the checkouts: SCHEMA=<bitcoin-desktop/schema> SIDESTR_LIB=<spec/siding/lib> BLAKETESTNODE=<blaketestnode>
let ok = 0,
  bad = 0;
const t = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`);
  cond ? ok++ : bad++;
};
// ---- the page's version and version.json agree (a release that forgets one shows a false update banner)
{
  const { readFileSync } = await import('node:fs');
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
    const { execSync } = await import('node:child_process');
    const { createHash } = await import('node:crypto');
    const { homedir } = await import('node:os');
    const dir = process.env.SCHEMA ?? homedir() + '/bitcoin-desktop/schema';
    const want = Object.fromEntries([...src.matchAll(/'(schema\/[a-z0-9/-]+\.jsonld)': '([0-9a-f]{64})'/g)].map((m) => [m[1], m[2]]));
    const bad = Object.entries(want).filter(([f, h]) => {
      try {
        return (
          createHash('sha256')
            .update(execSync(`git -C ${dir} show ${eng}:${f}`, { stdio: ['ignore', 'pipe', 'ignore'] }))
            .digest('hex') !== h
        );
      } catch {
        return true;
      }
    });
    const fetched = [...src.matchAll(/j\(['`](schema\/[^'`$]+)['`]\)/g)].map((m) => m[1]);
    t(
      'every rule file the page fetches by name has a pinned hash',
      fetched.length >= 1 && fetched.every((f) => want[f]),
      fetched.join(', '),
    );
    t(
      'the six rule files are pinned by hash, and the hashes are those at the pinned engine commit',
      Object.keys(want).length === 6 && !bad.length,
      bad.map(([f]) => f).join(', '),
    );
  }
  {
    // the wallet's code is checked by sha256 in the page: each hash is that of the file at the pinned commit, and the table
    // covers every file the entries import (the page refuses a file it has no hash for, so a gap would stop the wallet)
    const { execSync } = await import('node:child_process');
    const { createHash } = await import('node:crypto');
    const { homedir } = await import('node:os');
    const specDir = (process.env.SIDESTR_LIB ?? homedir() + '/remote/github.com/sidestr/spec/siding/lib').replace(/\/siding\/lib\/?$/, '');
    const engDir = process.env.SCHEMA ?? homedir() + '/bitcoin-desktop/schema';
    const want = Object.fromEntries([...src.matchAll(/'((?:siding|codec)\/[a-z0-9/.-]+)': '([0-9a-f]{64})'/g)].map((m) => [m[1], m[2]]));
    const show = (f) =>
      execSync(`git -C ${f.startsWith('siding/') ? specDir : engDir} show ${f.startsWith('siding/') ? lib : eng}:${f}`, {
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 1 << 26,
      });
    const RE = new RegExp(src.match(/const IMPORT_RE = \/(.+)\/g;/)[1], 'g');
    // every import in the graph, relative or not: only relative ones are rewritten to checked blobs, so a pinned file that one
    // day imported a full URL (allowed by the policy's pinned prefix) would run unchecked
    const ANY = new RegExp(src.match(/const ANY_IMPORT_RE = \/(.+)\/g;/)[1], 'g'); // the page's own pattern
    const bad = [],
      missing = [],
      absolute = [];
    let imports = 0;
    const walk = (f, seen = new Set()) => {
      if (seen.has(f)) return;
      seen.add(f);
      if (!want[f]) return missing.push(f);
      let body;
      try {
        body = show(f);
      } catch {
        return bad.push(f);
      }
      if (createHash('sha256').update(body).digest('hex') !== want[f]) bad.push(f);
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
      entries.length > 0 && !bad.length && !missing.length && seen.size === Object.keys(want).length,
      `entries ${entries.length}, bad ${bad.join(', ')}, missing ${missing.join(', ')}, ${seen.size} walked vs ${Object.keys(want).length} pinned`,
    );
    t(
      "no file of the wallet's code imports anything but a relative path (only those are checked)",
      imports > 0 && !absolute.length,
      absolute.join('; ') || `${imports} imports`,
    );
  }
  {
    // the node's loader is checked by sha256 in the page: the hash is that of the file at the pinned node commit
    const { execSync } = await import('node:child_process');
    const { createHash } = await import('node:crypto');
    const { homedir } = await import('node:os');
    const want = src.match(/const TABNODE_SHA256 = '([0-9a-f]{64})'/)?.[1];
    let got = null;
    try {
      got = createHash('sha256')
        .update(
          execSync(
            `git -C ${process.env.BLAKETESTNODE ?? homedir() + '/remote/github.com/bitcoin-blake/blaketestnode'} show ${node}:browser/tabnode.js`,
            { stdio: ['ignore', 'pipe', 'ignore'] },
          ),
        )
        .digest('hex');
    } catch {}
    t("the node loader's pinned sha256 is the file's at the pinned node commit", !!want && want === got, `${want} vs ${got}`);
  }
  {
    const { execSync } = await import('node:child_process');
    const { homedir } = await import('node:os');
    let w = '';
    try {
      w = execSync(
        `git -C ${process.env.BLAKETESTNODE ?? homedir() + '/remote/github.com/bitcoin-blake/blaketestnode'} show ${node}:browser/worker.js`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch {}
    const wpins = [...new Set([...w.matchAll(/https:\/\/cdn\.jsdelivr\.net\/gh\/[^'"`]+?@[0-9a-f]{40}/g)].map((m) => m[0] + '/'))];
    t(
      'every pinned path the node worker itself imports is allowed by the policy',
      w && wpins.length >= 2 && wpins.every((u) => csp.includes(u)),
      wpins.filter((u) => !csp.includes(u)).join(' '),
    );
  }
  t(
    'the security policy names the exact pinned node, library and engine',
    !!node &&
      !!lib &&
      !!eng &&
      csp.includes(`blaketestnode@${node}/`) &&
      csp.includes(`spec@${lib}/`) &&
      csp.includes(`schema@${eng}/`) &&
      !/cdn\.jsdelivr\.net[ ;]/.test(csp),
  );
}

console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
