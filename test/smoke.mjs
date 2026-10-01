// The page itself in a headless browser, with the node replaced by test/fake/tabnode.js and the pinned libraries served from
// local checkouts (the same ones the unit tests use). It checks the startup order and the read-only paths that unit tests
// cannot see. Needs playwright-core and a Chromium: CHROME=<path> or `npx playwright-core install chromium-headless-shell`.
//   SCHEMA=<bitcoin-desktop/schema> SIDESTR_LIB=<siding/lib> node test/smoke.mjs
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
const H = (p) => p.replace(/^~/, homedir());
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCHEMA = H(process.env.SCHEMA ?? '~/bitcoin-desktop/schema'),
  SPEC = H(process.env.SIDESTR_LIB ?? '~/remote/github.com/sidestr/spec/siding/lib').replace(/\/siding\/lib\/?$/, '');
let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  if (process.env.CI) throw new Error('playwright-core is not installed');
  console.log('smoke: skipped (playwright-core is not installed: npm i --no-save playwright-core)');
  process.exit(0);
}
let ok = 0,
  bad = 0;
const t = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`);
  cond ? ok++ : bad++;
};
const MAP = [
  [/^https:\/\/cdn\.jsdelivr\.net\/gh\/bitcoin-blake\/blaketestnode@[0-9a-f]+\/browser\/tabnode\.js$/, () => `${ROOT}test/fake/tabnode.js`],
  // relays: the fake (nothing leaves the test), which serves the real module's other exports from ?real
  [/^https:\/\/cdn\.jsdelivr\.net\/gh\/sidestr\/spec@[0-9a-f]+\/siding\/lib\/relay\.mjs$/, () => `${ROOT}test/fake/relay.mjs`],
  // the libraries at the commit the page pins (git show), as the CDN serves them: the page checks the engine's files by hash
  [/^https:\/\/cdn\.jsdelivr\.net\/gh\/sidestr\/spec@([0-9a-f]+)\/([^?]*)(\?real)?$/, (m) => ({ dir: SPEC, sha: m[1], path: m[2] })],
  [/^https:\/\/cdn\.jsdelivr\.net\/gh\/bitcoin-desktop\/schema@([0-9a-f]+)\/(.*)$/, (m) => ({ dir: SCHEMA, sha: m[1], path: m[2] })],
  [/^http:\/\/localhost:8799\/seed$/, () => null],
  [/^http:\/\/localhost:8799\/([^?]*)/, (m) => `${ROOT}${m[1] || 'index.html'}`],
];
const FAKE_SHA = createHash('sha256')
  .update(readFileSync(`${ROOT}test/fake/tabnode.js`))
  .digest('hex');
// the page checks every file of its wallet code by sha256: the fake relay's hash stands in for relay.mjs, and the real one
// it re-exports (?real) is added under its own name with the real file's hash (that file is served as is)
const FAKE_RELAY_SHA = createHash('sha256')
  .update(readFileSync(`${ROOT}test/fake/relay.mjs`))
  .digest('hex');
// outsideImport: one file of the wallet's code served with an import of a full URL added, and its pinned hash made to match,
// so only the page's own import check stands between it and running (it must refuse the file: only relative imports are
// rewritten to checked code)
const LIB_PIN = readFileSync(`${ROOT}reef.js`, 'utf8').match(/sidestr\/spec@([0-9a-f]{40})/)[1];
const OUTSIDE = 'siding/lib/address.mjs';
const outsideBody = () =>
  String(execSync(`git -C ${SPEC} show ${LIB_PIN}:${OUTSIDE}`, { stdio: ['ignore', 'pipe', 'ignore'] })) +
  "\nimport 'https://cdn.jsdelivr.net/npm/evil@1.0.0/x.js';\n";
const forSmoke = (src, { outsideImport = false } = {}) => {
  const real = src.match(/'siding\/lib\/relay\.mjs': '([0-9a-f]{64})'/)[1];
  if (outsideImport)
    src = src.replace(
      /'siding\/lib\/address\.mjs': '[0-9a-f]{64}'/,
      `'siding/lib/address.mjs': '${createHash('sha256').update(outsideBody()).digest('hex')}'`,
    );
  return src
    .replace(/const TABNODE_SHA256 = '[0-9a-f]{64}'/, `const TABNODE_SHA256 = '${FAKE_SHA}'`)
    .replace(
      /'siding\/lib\/relay\.mjs': '[0-9a-f]{64}'/,
      `'siding/lib/relay.mjs': '${FAKE_RELAY_SHA}', 'siding/lib/relay.mjs?real': '${real}'`,
    );
};
const type = (p) =>
  p.endsWith('.html') ? 'text/html' : /\.json(ld)?$/.test(p) ? 'application/json' : p.endsWith('.css') ? 'text/css' : 'text/javascript';
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});

// one browser profile: seed its storage, then open Reef in one or more pages
// tamper: the loader served with a byte changed (its hash no longer matches); oldV: index.html asks for another reef.js
// version (a cached page of an older release); noSession: sessionStorage throws, as when site data is blocked; outsideImport:
// a wallet file that imports a full URL (see forSmoke)
async function profile({
  libDelay = 0,
  startMs = 50,
  seed = {},
  tamper = false,
  oldV = null,
  noSession = false,
  outsideImport = false,
} = {}) {
  const ctx = await browser.newContext();
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    for (const [re, f] of MAP) {
      const m = u.match(re);
      if (!m) continue;
      const p = f(m);
      if (p === null) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>seed</title>' });
      let body;
      if (typeof p === 'object') {
        try {
          body = execSync(`git -C ${p.dir} show ${p.sha}:${p.path}`, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 });
        } catch {
          body = existsSync(`${p.dir}/${p.path}`) ? readFileSync(`${p.dir}/${p.path}`) : null;
        }
      } else body = existsSync(p) ? readFileSync(p) : null;
      if (body == null) return route.fulfill({ status: 404, body: '' });
      // the page checks its node loader by sha256: the fake loader's hash stands in for the pinned one (the real pin is
      // is the sha256 of tabnode.js at that commit)
      if (typeof p === 'string' && p.endsWith('/reef.js')) body = forSmoke(String(body), { outsideImport });
      if (outsideImport && typeof p === 'object' && p.sha === LIB_PIN && p.path === OUTSIDE) body = outsideBody();
      if (tamper && typeof p === 'string' && p.endsWith('/fake/tabnode.js')) body = String(body) + '\n// changed\n';
      if (oldV && typeof p === 'string' && p.endsWith('/index.html'))
        body = String(body).replace(/reef\.js\?v=[^"]+"/, `reef.js?v=${oldV}"`);
      if (libDelay && !u.startsWith('http://localhost:8799')) await new Promise((r) => setTimeout(r, libDelay));
      const name = typeof p === 'object' ? p.path : p;
      return route.fulfill({ status: 200, contentType: type(name), body, headers: { 'access-control-allow-origin': '*' } });
    }
    if (/^https:\/\/cdn\.jsdelivr\.net\/npm\//.test(u)) return route.continue(); // qrcode (pinned by version, with an integrity hash) and webtorrent (by version only)
    return route.fulfill({ status: 404, body: '' }); // the mirror over http: nothing leaves the test (relays are faked above)
  });
  await ctx.addInitScript((ms) => (window.__START_MS = ms), startMs);
  // every text the status line shows, from the first paint (an idle tab must never say it is starting)
  await ctx.addInitScript(() => {
    window.__syncTexts = [];
    const watch = () => {
      const el = document.getElementById('syncmsg');
      if (!el) return requestAnimationFrame(watch);
      window.__syncTexts.push(el.textContent);
      new MutationObserver(() => window.__syncTexts.push(el.textContent)).observe(el, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    };
    watch();
  });
  if (noSession)
    await ctx.addInitScript(() =>
      Object.defineProperty(window, 'sessionStorage', {
        get() {
          throw new DOMException('blocked', 'SecurityError');
        },
      }),
    );
  const s = await ctx.newPage();
  await s.goto('http://localhost:8799/seed');
  await s.evaluate((seed) => {
    localStorage.clear();
    for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
  }, seed);
  await s.close();
  const errors = [];
  const open = async ({ ready = true } = {}) => {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on(
      'console',
      (m) => m.type() === 'error' && !/WebSocket|ERR_|404/.test(m.text()) && errors.push(m.text()), // a policy refusal is an error here
    );
    await page.goto('http://localhost:8799/index.html');
    if (ready) await page.waitForFunction(() => window.__fake, null, { timeout: 30000 });
    return page;
  };
  return { ctx, open, errors };
}
const ls = (page, k) => page.evaluate((k) => localStorage.getItem(k), k);

// a returning user's key and the tag the page stores its records under
const KEY = '11'.repeat(32);
const [{ makeSigner }, hash, secp] = await Promise.all([
  import(`${SPEC}/siding/lib/schnorr.mjs`),
  import(`${SCHEMA}/codec/hash.js`),
  import(`${SCHEMA}/codec/secp256k1.js`),
]);
const SCRIPT = '5120' + makeSigner({ hash, secp }).pubkeyOf(KEY);
const TAG = SCRIPT.slice(4, 20);
// the node's vouched height as the page keeps it between visits (a bare number, as older pages wrote it, is ignored)
const VOUCHED = JSON.stringify({ height: 152100, at: 1 });
const BAD = {
  txid: 'ab'.repeat(32),
  to: 'tb1pnope',
  sats: 1000,
  fee: 100,
  hex: '00',
  inputs: ['cd'.repeat(32) + ':0'],
  values: [5000],
  pending: true,
  at: 1,
  tip: 152000,
  kind: 'payment',
};
const returning = (extra = {}) => ({
  'reef:started': '1',
  'reef:key': KEY,
  ['reef:sent:' + TAG]: JSON.stringify([BAD]),
  ['reef:seen:' + TAG]: JSON.stringify([[BAD.inputs[0], 5000]]),
  'reef:vouched': VOUCHED, // a returning user's last signed tip: with none, coins above the snapshot base wait as pending
  ...extra,
});
const coins = (page) =>
  page.evaluate((script) => {
    window.__fake.emit('message', { type: 'synced', height: 152100, applied: true });
    window.__fake.emit('message', {
      type: 'coins',
      script,
      height: 152100,
      coins: [
        { key: 'cd'.repeat(32) + ':0', value: 5000, height: 152000 },
        { key: 'ef'.repeat(32) + ':1', value: 20000, height: 152050 },
      ],
    });
  }, SCRIPT);

// 1, 2: a record that fails its check is set aside in storage and its coins stay held, whichever finishes first
for (const [name, opts] of [
  ['the node starts before the wallet has loaded', { libDelay: 400, startMs: 20 }],
  ['the wallet loads before the node starts', { libDelay: 0, startMs: 3000 }],
]) {
  const p = await profile({ ...opts, seed: returning() });
  const page = await p.open();
  await page.waitForFunction(() => /^tb1p/.test(document.getElementById('rcvaddr').value), null, { timeout: 30000 });
  await page
    .waitForFunction((k) => JSON.parse(localStorage.getItem(k) ?? '[]').length > 0, 'reef:quarantine:' + TAG, {
      timeout: opts.startMs + 10000,
    })
    .catch(() => {}); // the assertion below says what was found
  const q = JSON.parse((await ls(page, 'reef:quarantine:' + TAG)) ?? '[]');
  const stored = JSON.parse((await ls(page, 'reef:sent:' + TAG)) ?? '[]');
  t(
    `${name}: the failing record is kept in the set-aside list`,
    q.some((x) => x.txid === BAD.txid),
    JSON.stringify({ q, stored }),
  );
  await coins(page);
  await page
    .waitForFunction(() => /0\.0002000/.test(document.getElementById('avail').textContent), null, { timeout: 5000 })
    .catch(() => {}); // the assertion below says what was found
  const avail = await page.textContent('#avail');
  t(`${name}: its coin is held (0.00020000 available, not 0.00025000)`, /0\.0002000\b|0\.00020000/.test(avail), avail);
  const q2 = JSON.parse((await ls(page, 'reef:quarantine:' + TAG)) ?? '[]');
  t(
    `${name}: still set aside after the first save`,
    q2.some((x) => x.txid === BAD.txid),
  );
  t(`${name}: no page errors`, !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
}

// 3: records written by a newer Reef: this copy does not start the node and writes nothing
{
  const seed = returning({ 'reef:schema': '99' });
  const p = await profile({ seed });
  const page = await p.open();
  await page.waitForSelector('#banners [data-b=schema]', { timeout: 10000 });
  t('a newer schema: the node is not started', (await page.evaluate(() => window.__fake.starts)) === 0);
  t(
    'a newer schema: the records and the marker are untouched',
    (await ls(page, 'reef:sent:' + TAG)) === seed['reef:sent:' + TAG] &&
      (await ls(page, 'reef:schema')) === '99' &&
      !(await ls(page, 'reef:quarantine:' + TAG)),
  );
  t(
    'a newer schema: sending is disabled and a notice says why',
    (await page.getAttribute('#sendgo', 'aria-disabled')) === 'true' && !!(await page.$('#banners [data-b=schema]')),
  );
  await p.ctx.close();
}

// 4, 5: before the node answers the wallet does not claim "no coins"; a second tab is idle and read-only
{
  const p = await profile({ seed: { 'reef:started': '1', 'reef:key': KEY } });
  const a = await p.open();
  const aOpened = Date.now();
  await a.waitForFunction(() => document.getElementById('recent').textContent.trim().length > 0, null, { timeout: 10000 });
  const recent = await a.textContent('#recent');
  t('before the node answers, the recent list says it is waiting', /waiting for the node/.test(recent), recent);
  const b = await p.open();
  await b.waitForFunction(() => document.body.classList.contains('idle'), null, { timeout: 10000 });
  t(
    'a second tab is idle: sending disabled, the node not started there',
    (await b.getAttribute('#sendgo', 'aria-disabled')) === 'true' &&
      (await b.evaluate(() => document.body.classList.contains('idle'))) &&
      (await b.evaluate(() => !window.__fake.posts.some((p) => p.type === 'coins'))),
  );
  t('the running tab is not marked idle', !(await a.evaluate(() => document.body.classList.contains('idle'))));
  const twotabs = (pg) => pg.evaluate(() => document.querySelector('#banners [data-b=twotabs] .bt')?.textContent ?? '');
  t(
    'the idle tab names what holds the node (another Reef tab, the version said only when it differs), and is short',
    /^Another Reef tab runs the node\. This one is view-only/.test(await twotabs(b)),
    await twotabs(b),
  );
  t(
    'the idle tab never said "Starting…" (it said what it was checking, then that it is idle)',
    !(await b.evaluate(() => (window.__syncTexts ?? []).some((x) => /Starting/i.test(x)))) &&
      (await b.evaluate(() => (window.__syncTexts ?? []).some((x) => /checking whether another tab/.test(x)))),
    await b.evaluate(() => (window.__syncTexts ?? []).join(' | ')),
  );
  // an older Reef holding the node: named with its version, and told (through storage) to look for its update now
  await a.waitForTimeout(Math.max(0, 6500 - (Date.now() - aOpened))); // its own first check (5 s after loading) is past
  let asked = 0;
  a.on('request', (r) => /version\.json/.test(r.url()) && asked++);
  await a.evaluate(() => localStorage.setItem('reef:running', JSON.stringify({ app: 'Reef', version: '2026-01-01.1', at: Date.now() })));
  const c = await p.open();
  await c.waitForFunction(() => document.body.classList.contains('idle'), null, { timeout: 10000 });
  // (both tabs here are the same version: a newer one is stood in for by writing a newer version where c writes its own)
  await c.evaluate(() => localStorage.setItem('reef:newest', '2099-01-01.1'));
  await a.waitForTimeout(800);
  t(
    'an idle tab names an older Reef that holds the node, and that tab looks for its update at once',
    /An older Reef \(2026-01-01\.1\) runs the node in another tab/.test(await twotabs(c)) && asked > 0,
    `${await twotabs(c)} | version.json asked ${asked}x`,
  );
  await c.close();
  // a newer Reef holding the node: this tab is the old one, and says so
  await a.evaluate(() => localStorage.setItem('reef:running', JSON.stringify({ app: 'Reef', version: '2099-01-01.1', at: Date.now() })));
  const d = await p.open();
  await d.waitForFunction(() => document.body.classList.contains('idle'), null, { timeout: 10000 });
  t(
    'an idle tab older than the Reef holding the node says it is the one to reload',
    /A newer Reef \(2099-01-01\.1\).*reload it/.test(await twotabs(d)),
    await twotabs(d),
  );
  await d.close();
  const shown = await a.evaluate(() =>
    [...document.querySelectorAll('[hidden]')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.id || e.className),
  );
  t('every element marked hidden is hidden (no style overrides it)', !shown.length, shown.join(', '));
  // keyboard: a dialog opened from a menu gives focus back to that menu's title; the tray gives it back to the page
  await a.focus('[data-m=settings]');
  await a.keyboard.press('Enter');
  await a.keyboard.press('End');
  const item = await a.evaluate(() => document.activeElement?.id);
  await a.evaluate(() => document.activeElement.click());
  await a.waitForSelector('dialog[open]', { timeout: 5000 }).catch(() => {});
  const opened = await a.evaluate(() => document.querySelector('dialog[open]')?.id);
  await a
    .waitForFunction(() => document.querySelector('dialog[open]')?.contains(document.activeElement), null, { timeout: 5000 })
    .catch(() => {});
  await a.keyboard.press('Escape');
  await a
    .waitForFunction(
      () =>
        !document.querySelector('dialog[open]') && document.activeElement !== document.body && !document.activeElement?.closest('dialog'),
      null,
      { timeout: 5000 },
    )
    .catch(() => {});
  const back = await a.evaluate(() => document.activeElement?.dataset?.m);
  t(
    'a dialog opened from a menu gives focus back to the menu title when closed',
    !!opened && back === 'settings',
    JSON.stringify({ item, opened, back }),
  );
  await a.evaluate(() => document.getElementById('m-exit').click());
  await a.waitForFunction(() => !document.getElementById('tray').hidden, null, { timeout: 5000 });
  await a.evaluate(() => document.getElementById('tray').click());
  await a
    .waitForFunction(() => document.getElementById('tray').hidden && !!document.activeElement?.closest('.tool'), null, { timeout: 5000 })
    .catch(() => {});
  t('restoring from the tray puts focus on the page toolbar', await a.evaluate(() => !!document.activeElement?.closest('.tool')));
  t('no page errors', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
}
// 6: a payment end to end: typed, confirmed, signed, recorded, published; then its coins spent by another transaction
{
  const p = await profile({ seed: { 'reef:started': '1', 'reef:key': KEY, 'reef:vouched': VOUCHED } });
  const a = await p.open();
  await a.waitForFunction(() => /^tb1p/.test(document.getElementById('rcvaddr').value), null, { timeout: 30000 });
  const COIN = 'cd'.repeat(32) + ':0';
  await a.evaluate(
    ({ script, COIN }) => {
      window.__fake.emit('message', { type: 'synced', height: 152100, applied: true });
      window.__fake.emit('message', { type: 'coins', script, height: 152100, coins: [{ key: COIN, value: 50000, height: 152000 }] });
    },
    { script: SCRIPT, COIN },
  );
  await a.waitForFunction(() => /0\.00050000/.test(document.getElementById('avail').textContent), null, { timeout: 5000 });
  await a.evaluate(() => document.querySelector('[data-p=send]').click());
  // a signed tip that disagrees with the blocks stops sending
  await a.evaluate(() =>
    window.__fake.emit('message', {
      type: 'nostr',
      height: 152102,
      hash: 'cd'.repeat(32),
      agree: 0,
      diverged: true,
      live: true,
      created_at: Math.floor(Date.now() / 1000),
    }),
  );
  await a.fill('#sendto', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
  await a.fill('#sendamt', '0.00001');
  await a.click('#sendgo');
  await a.waitForFunction(() => document.getElementById('senderr').textContent.length > 0 || document.querySelector('#ask[open]'), null, {
    timeout: 5000,
  });
  t(
    'with the signed tip disagreeing, no payment can be made',
    !(await a.$('#ask[open]')) && /disagrees/.test(await a.textContent('#senderr')),
    await a.textContent('#senderr'),
  );
  await a.evaluate(() =>
    window.__fake.emit('message', {
      type: 'nostr',
      height: 152100,
      hash: 'cd'.repeat(32),
      agree: 3,
      diverged: false,
      live: true,
      created_at: Math.floor(Date.now() / 1000),
    }),
  );
  await a.click('#sendclear');
  await a.evaluate(() => (document.getElementById('senderr').textContent = ''));
  await a.fill('#sendto', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
  await a.fill('#sendamt', '0.0001');
  await a.click('#sendgo');
  await a.waitForSelector('#ask[open]', { timeout: 5000 });
  const confirmText = await a.textContent('#ask-b');
  t(
    'the confirm dialog shows the address in fours, the amount and the fee',
    /tb1q w508/.test(confirmText) && /0\.00010000 tBTC/.test(confirmText) && /Fee:/.test(confirmText),
    confirmText.slice(0, 160),
  );
  await a.click('#ask-ok');
  const relayed = await a
    .waitForFunction(() => (window.__relay ?? []).length === 1, null, { timeout: 15000 })
    .then(
      () => true,
      () => false,
    );
  t('the payment reached the relays', relayed);
  const rec = JSON.parse((await ls(a, 'reef:sent:' + TAG)) ?? '[]');
  const ev = await a.evaluate(() => window.__relay?.[0] ?? null);
  t(
    'the payment is recorded before it leaves, and the published event carries its signed transaction',
    rec.length === 1 && rec[0].pending && rec[0].sats === 10000 && ev?.kind === 23503 && ev?.content === rec[0].hex,
    JSON.stringify({ n: rec.length, kind: ev?.kind }),
  );
  const avail = await a.textContent('#avail');
  t('its coin is held: nothing is available while it waits', /^0\.00000000/.test(avail), avail);
  t(
    'it reads as waiting, with a fee raise and a cancel on offer',
    (await a.evaluate(() => [...document.querySelectorAll('#txrows button[data-act]')].map((b) => b.dataset.act).join())) ===
      'bump,again,cancel',
  );
  {
    // on a phone the row keeps its main actions and folds "Announce again" behind More…
    await a.setViewportSize({ width: 360, height: 740 });
    await a.evaluate(() => document.querySelector('[data-p=tx]').click());
    const seen = () =>
      a.evaluate(() =>
        [...document.querySelectorAll('#txrows button')]
          .filter((b) => b.offsetParent)
          .map((b) => b.dataset.act ?? 'more')
          .join(),
      );
    const before = await seen();
    await a.click('#txrows button.rowmore');
    const after = await seen();
    await a.setViewportSize({ width: 1280, height: 800 });
    await a.evaluate(() => document.querySelector('[data-p=send]').click());
    t(
      'on a phone a crowded row shows its main actions and More…, which shows the rest',
      before === 'bump,cancel,more' && after === 'bump,again,cancel',
      `${before} → ${after}`,
    );
  }
  // its change in a block above the signed chain tip: counted once, as coming back, and the payment still waits
  const changeSats = rec[0].change;
  await a.evaluate(
    ({ script, key, value }) => {
      window.__fake.emit('message', {
        type: 'nostr',
        height: 152101,
        hash: 'ab'.repeat(32),
        agree: 2,
        diverged: false,
        live: true,
        created_at: Math.floor(Date.now() / 1000),
      });
      window.__fake.emit('message', { type: 'coins', script, height: 152102, coins: [{ key, value, height: 152102 }] });
    },
    { script: SCRIPT, key: rec[0].txid + ':1', value: changeSats },
  );
  const fmt = (x) => (x / 1e8).toFixed(8);
  await a
    .waitForFunction((want) => document.getElementById('pending').textContent.startsWith(want), fmt(changeSats), { timeout: 5000 })
    .catch(() => {}); // the assertion below says what was found
  const pend = await a.textContent('#pending'),
    tot = await a.textContent('#total');
  t(
    'change in a block above the signed tip is counted once (pending = total = the change), and the payment still waits',
    pend.startsWith(fmt(changeSats)) && tot.startsWith(fmt(changeSats)) && JSON.parse(await ls(a, 'reef:sent:' + TAG))[0].pending === true,
    `${pend} / ${tot}`,
  );
  // the coin spent by something else, no change back: the page asks the node which transaction spent it
  const txid = rec[0].txid;
  await a.evaluate(({ script }) => window.__fake.emit('message', { type: 'coins', script, height: 152102, coins: [] }), { script: SCRIPT });
  await a
    .waitForFunction((txid) => window.__fake.posts.some((m) => m.type === 'spend' && m.req === 'sent:' + txid), txid, { timeout: 5000 })
    .catch(() => {});
  const asked = await a.evaluate((txid) => window.__fake.posts.find((m) => m.type === 'spend' && m.req === 'sent:' + txid), txid);
  t(
    'with its coin gone and no change back, the node is asked which transaction spent it',
    !!asked && asked.key === COIN,
    JSON.stringify(asked),
  );
  // the question fails in the node (a busy or unreadable file): it is asked again with the next coins, not forgotten for good
  await a.evaluate((txid) => {
    window.__fake.posts.length = 0;
    // as the real worker sends it: the kind in name, the browser's own words in text
    window.__fake.emit('message', {
      type: 'error',
      name: 'NoModificationAllowedError',
      text: 'An attempt was made to modify an object where modifications are not allowed.',
      req: 'sent:' + txid,
    });
  }, txid);
  await a.waitForSelector('#banners [data-b="nodeerr"]', { timeout: 5000 }).catch(() => {});
  const busy = await a.evaluate(() => {
    const b = document.querySelector('#banners [data-b="nodeerr"]');
    return b && { cls: b.className, text: b.textContent, wipe: [...b.querySelectorAll('button')].some((x) => /Wipe/.test(x.textContent)) };
  });
  t(
    "a busy file (the node's error even though a request met it) is a warning that it passes by itself, with no offer to wipe",
    !!busy && /warn/.test(busy.cls) && /busy/.test(busy.text) && !busy.wipe,
    JSON.stringify(busy),
  );
  await a.evaluate(({ script }) => window.__fake.emit('message', { type: 'coins', script, height: 152102, coins: [] }), { script: SCRIPT });
  const again = await a
    .waitForFunction((txid) => window.__fake.posts.some((m) => m.type === 'spend' && m.req === 'sent:' + txid), txid, { timeout: 5000 })
    .then(
      () => true,
      () => false,
    );
  t('a spend question that failed in the node is asked again with the next coins', again);
  await a.evaluate(
    (txid) => window.__fake.emit('message', { type: 'spend', req: 'sent:' + txid, found: true, txid: 'ee'.repeat(32), height: 152101 }),
    txid,
  );
  await a.waitForFunction(() => document.querySelectorAll('.toast').length > 0, null, { timeout: 5000 }).catch(() => {});
  const toast = await a.evaluate(() => [...document.querySelectorAll('.toast')].map((x) => x.textContent).join(' | '));
  const row = await a.evaluate(() => document.querySelector('#txrows tr')?.textContent ?? '');
  t(
    'another transaction spent it: "did not happen" is said and the row is struck',
    /did not happen/i.test(toast) && /did not happen/.test(row),
    toast.slice(0, 120),
  );
  t('no page errors in the payment path', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
}
// 7: switching keys (a restore) holds after the page reloads, with and without an idle second tab
const NEWKEY = '22'.repeat(32);
for (const withIdle of [false, true]) {
  const p = await profile({
    seed: { 'reef:started': '1', 'reef:key': KEY, ['reef:backup:' + makeSigner({ hash, secp }).pubkeyOf(KEY).slice(0, 16)]: '1' },
  });
  const a = await p.open();
  await a.waitForFunction(() => /^tb1p/.test(document.getElementById('rcvaddr').value), null, { timeout: 30000 });
  await a.evaluate(
    ({ script }) => {
      window.__fake.emit('message', { type: 'synced', height: 152100, applied: true });
      window.__fake.emit('message', { type: 'coins', script, height: 152100, coins: [] });
    },
    { script: SCRIPT },
  );
  let b = null;
  if (withIdle) {
    b = await p.open();
    await b.waitForFunction(() => document.body.classList.contains('idle'), null, { timeout: 10000 });
  }
  await a.evaluate(() => {
    document.getElementById('m-options').click();
    document.querySelector('[data-o=wallet]').click();
  });
  await a.fill('#o-importkey', NEWKEY);
  await a.click('#o-ok');
  await a.waitForSelector('#ask[open]', { timeout: 5000 });
  const nav = a.waitForNavigation({ timeout: 10000 }).catch(() => null);
  await a.click('#ask-ok');
  await nav;
  await a.waitForFunction(() => /^tb1p/.test(document.getElementById('rcvaddr').value), null, { timeout: 30000 });
  const now = await ls(a, 'reef:key');
  const old = JSON.parse((await ls(a, 'reef:oldkeys')) ?? '[]');
  t(
    `a key switch ${withIdle ? 'with an idle second tab ' : ''}holds after the reload; the earlier key is kept under earlier keys`,
    now === NEWKEY && old.some((x) => x.key === KEY),
    JSON.stringify({ now: now?.slice(0, 6), old: old.length }),
  );
  if (b) t('the idle tab says the key was changed elsewhere', !!(await b.$('#banners [data-b=keychanged]')));
  t(`no page errors in the key switch${withIdle ? ' with an idle tab' : ''}`, !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
}
// 7b: with no signed tip yet and no record of one, money above the snapshot base waits as pending
{
  const p = await profile({ seed: { 'reef:started': '1', 'reef:key': KEY } });
  const a = await p.open();
  await a.waitForFunction(() => /^tb1p/.test(document.getElementById('rcvaddr').value), null, { timeout: 30000 });
  await a.evaluate(
    ({ script }) => {
      window.__fake.emit('message', { type: 'synced', height: 152100, applied: true });
      window.__fake.emit('message', {
        type: 'coins',
        script,
        height: 152100,
        coins: [{ key: 'cd'.repeat(32) + ':0', value: 50000, height: 152000 }],
      });
    },
    { script: SCRIPT },
  );
  await a.waitForTimeout(1500);
  const avail = await a.textContent('#avail');
  t('with no signed tip at all, a coin above the snapshot base is not spendable', /0\.00000000/.test(avail), avail);
  await p.ctx.close();
}
// 7c: a node that stops for good (a wipe that did not finish) is a fatal notice, and nothing can be sent
{
  const p = await profile({ seed: { 'reef:started': '1', 'reef:key': KEY, 'reef:vouched': VOUCHED } });
  const a = await p.open();
  await a.waitForFunction(() => /^tb1p/.test(document.getElementById('rcvaddr').value), null, { timeout: 30000 });
  await a.evaluate(
    ({ script }) => {
      window.__fake.emit('message', { type: 'synced', height: 152100, applied: true });
      window.__fake.emit('message', {
        type: 'coins',
        script,
        height: 152100,
        coins: [{ key: 'cd'.repeat(32) + ':0', value: 50000, height: 152000 }],
      });
    },
    { script: SCRIPT },
  );
  await a.waitForFunction(() => /0\.00050000/.test(document.getElementById('avail').textContent), null, { timeout: 5000 });
  await a.evaluate(() => {
    window.__fake.node.phase = 'error';
    window.__fake.emit('message', { type: 'error', text: 'the node did not wipe in time and is stopped', fatal: true });
  });
  await a.evaluate(() => document.querySelector('[data-p=send]').click());
  await a.fill('#sendto', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
  await a.fill('#sendamt', '0.00001');
  await a.click('#sendgo');
  await a.waitForFunction(() => document.getElementById('senderr').textContent.length > 0 || document.querySelector('#ask[open]'), null, {
    timeout: 5000,
  });
  t(
    'a node stopped for good: a fatal notice, and no payment can be made',
    !!(await a.$('#banners [data-b=fatal]')) && !(await a.$('#ask[open]')) && /stopped/.test(await a.textContent('#senderr')),
    `${await a.textContent('#senderr')}`,
  );
  t('a node stopped for good: the page record of the vouched height is cleared', (await ls(a, 'reef:vouched')) === null);
  await p.ctx.close();
}
// 8: money in a block above the signed tip is said as such, one way everywhere; a silent broadcaster is warned about
{
  const p = await profile({ seed: { 'reef:started': '1', 'reef:key': KEY } });
  const a = await p.open();
  await a.waitForFunction(() => /^tb1p/.test(document.getElementById('rcvaddr').value), null, { timeout: 30000 });
  await a.evaluate(
    ({ script }) => {
      const now = Math.floor(Date.now() / 1000);
      window.__fake.emit('message', { type: 'synced', height: 152105, applied: true });
      window.__fake.emit('message', {
        type: 'nostr',
        height: 152100,
        hash: 'ab'.repeat(32),
        agree: 3,
        diverged: false,
        live: true,
        created_at: now,
      });
      window.__fake.emit('message', {
        type: 'coins',
        script,
        height: 152105,
        coins: [
          { key: 'aa'.repeat(32) + ':0', value: 10000, height: 152090 },
          { key: 'bb'.repeat(32) + ':0', value: 7000, height: 152104 },
        ],
      });
    },
    { script: SCRIPT },
  );
  await a
    .waitForFunction(() => /signed chain tip has not reached/.test(document.getElementById('outgoing').textContent), null, {
      timeout: 5000,
    })
    .catch(() => {});
  t(
    'money in a block above the signed tip: not available, said as above the signed chain tip, in the list too',
    (await a.textContent('#avail')).startsWith('0.00010000') &&
      /0\.00007000 tBTC in blocks the signed chain tip has not reached yet/.test(await a.textContent('#outgoing')) &&
      /waiting for the signed chain tip/.test(await a.textContent('#recent')),
    `${await a.textContent('#avail')} | ${await a.textContent('#outgoing')}`,
  );
  await a.evaluate(() =>
    window.__fake.emit('message', {
      type: 'mempool',
      count: 0,
      bytes: 0,
      fees: 0,
      stats: { refused: 0, dropped: 0 },
      txs: [],
      all: [],
      following: true,
      feedFileAt: Date.now() - 11 * 60e3,
    }),
  );
  await a.waitForSelector('#banners [data-b=feed]', { timeout: 5000 }).catch(() => {});
  t('a broadcaster silent for over ten minutes is warned about', !!(await a.$('#banners [data-b=feed]')));
  await a.evaluate(() =>
    window.__fake.emit('message', {
      type: 'mempool',
      count: 0,
      bytes: 0,
      fees: 0,
      stats: { refused: 0, dropped: 0 },
      txs: [],
      all: [],
      following: true,
      feedFileAt: Date.now(),
    }),
  );
  await a.waitForFunction(() => !document.querySelector('#banners [data-b=feed]'), null, { timeout: 5000 }).catch(() => {});
  t('...and the warning goes when it reports again', !(await a.$('#banners [data-b=feed]')));
  t('no page errors in the double-check and heartbeat paths', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
}
// 9: sending, the edges: no coins at all, and a dust leftover while a second coin remains (not "empties the wallet")
{
  const WL = await import(`${ROOT}lib/wallet.mjs`);
  const p = await profile({ seed: { 'reef:started': '1', 'reef:key': KEY, 'reef:vouched': VOUCHED } });
  const a = await p.open();
  await a.waitForFunction(() => /^tb1p/.test(document.getElementById('rcvaddr').value), null, { timeout: 30000 });
  await a.evaluate(
    ({ script }) => {
      window.__fake.emit('message', { type: 'synced', height: 152100, applied: true });
      window.__fake.emit('message', { type: 'coins', script, height: 152100, coins: [] });
    },
    { script: SCRIPT },
  );
  await a.waitForFunction(() => /^0\.00000000/.test(document.getElementById('avail').textContent), null, { timeout: 5000 });
  await a.evaluate(() => document.querySelector('[data-p=send]').click());
  const DEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
  await a.fill('#sendto', DEST);
  await a.fill('#sendamt', '0.0001');
  await a.click('#sendgo');
  await a.waitForFunction(() => document.getElementById('senderr').textContent.length > 0, null, { timeout: 5000 }).catch(() => {});
  const noCoins = await a.textContent('#senderr');
  t('with no coins, Send says why in words and opens nothing', /No coins yet/.test(noCoins) && !(await a.$('#ask[open]')), noCoins);
  // two coins of 20,000: a payment that leaves under 330 sat of the one it picks
  const vs = WL.estimateVsize(1, ['0014751e76e8199196d454941c45d1b3a323f1433bd6', SCRIPT]);
  const amount = 20000 - Math.ceil(vs) - 100;
  await a.evaluate(
    ({ script }) => {
      window.__fake.emit('message', {
        type: 'coins',
        script,
        height: 152100,
        coins: [
          { key: 'a1'.repeat(32) + ':0', value: 20000, height: 152000 },
          { key: 'b2'.repeat(32) + ':0', value: 20000, height: 152000 },
        ],
      });
    },
    { script: SCRIPT },
  );
  await a.waitForFunction(() => /^0\.00040000/.test(document.getElementById('avail').textContent), null, { timeout: 5000 });
  await a.click('#sendclear');
  await a.evaluate(() => (document.getElementById('senderr').textContent = ''));
  await a.fill('#sendto', DEST);
  await a.fill('#sendamt', (amount / 1e8).toFixed(8));
  await a
    .waitForFunction(() => /leftover/.test(document.getElementById('sendpreview').textContent), null, { timeout: 5000 })
    .catch(() => {});
  const prev = await a.textContent('#sendpreview');
  t(
    'a dust leftover with a second coin left: said as a leftover, not as emptying the wallet',
    /leftover too small/.test(prev) && !/empties/.test(prev),
    prev,
  );
  await a.click('#sendgo');
  await a.waitForSelector('#ask[open]', { timeout: 5000 });
  const conf = await a.textContent('#ask-b');
  t(
    '...and the confirmation does not say it empties the wallet either',
    /leftover/.test(conf) && !/empties/.test(conf),
    conf.slice(0, 200),
  );
  await a.click('#ask-cancel');
  // a key written down by hand can be marked backed up: Show, then its last four characters typed back
  await a.click('#banners [data-b=backup] button.act');
  await a.waitForSelector('#backup[open]', { timeout: 5000 });
  const before = await a.evaluate(() => ({
    done: document.getElementById('bk-done').disabled,
    hand: document.getElementById('bk-hand').hidden,
  }));
  await a.click('#bk-show');
  const wif = await a.inputValue('#bk-wif');
  await a.fill('#bk-last4', 'zzzz');
  const wrong = await a.evaluate(() => document.getElementById('bk-done').disabled);
  await a.fill('#bk-last4', wif.slice(-4));
  const after = await a.evaluate(() => ({
    disabled: document.getElementById('bk-done').disabled,
    checked: document.getElementById('bk-done').checked,
  }));
  await a.click('#bk-ok');
  const stored = await a.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('reef:backup:')));
  t(
    'a key written by hand: after Show, its last four characters typed back mark it backed up (a wrong four do not)',
    before.done && before.hand && wrong && !after.disabled && after.checked && stored,
    JSON.stringify({ before, wrong, after, stored }),
  );
  t('no page errors in the sending edges', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
}
// 10: a payment's change in a block above the signed tip; the tip then reaches that block: confirmed, the change spendable
{
  const p = await profile({ seed: { 'reef:started': '1', 'reef:key': KEY, 'reef:vouched': VOUCHED } });
  const a = await p.open();
  await a.waitForFunction(() => /^tb1p/.test(document.getElementById('rcvaddr').value), null, { timeout: 30000 });
  const COIN = 'cd'.repeat(32) + ':0';
  const tip = (height) =>
    a.evaluate((height) => {
      window.__fake.emit('message', {
        type: 'nostr',
        height,
        hash: 'ab'.repeat(32),
        agree: 3,
        diverged: false,
        live: true,
        created_at: Math.floor(Date.now() / 1000),
      });
    }, height);
  await a.evaluate(
    ({ script, COIN }) => {
      window.__fake.emit('message', { type: 'synced', height: 152100, applied: true });
      window.__fake.emit('message', { type: 'coins', script, height: 152100, coins: [{ key: COIN, value: 50000, height: 152000 }] });
    },
    { script: SCRIPT, COIN },
  );
  await tip(152100);
  await a.waitForFunction(() => /0\.00050000/.test(document.getElementById('avail').textContent), null, { timeout: 5000 });
  await a.evaluate(() => document.querySelector('[data-p=send]').click());
  await a.fill('#sendto', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
  await a.fill('#sendamt', '0.0001');
  await a.click('#sendgo');
  await a.waitForSelector('#ask[open]', { timeout: 5000 });
  await a.click('#ask-ok');
  await a.waitForFunction(() => (window.__relay ?? []).length === 1, null, { timeout: 15000 });
  const rec = JSON.parse((await ls(a, 'reef:sent:' + TAG)) ?? '[]')[0];
  const fmt = (x) => (x / 1e8).toFixed(8);
  await a.evaluate(
    ({ script, key, value }) => {
      window.__fake.emit('message', { type: 'synced', height: 152102, applied: true });
      window.__fake.emit('message', { type: 'coins', script, height: 152102, coins: [{ key, value, height: 152102 }] });
    },
    { script: SCRIPT, key: rec.txid + ':1', value: rec.change },
  );
  await a
    .waitForFunction((want) => document.getElementById('pending').textContent.startsWith(want), fmt(rec.change), { timeout: 5000 })
    .catch(() => {});
  const before = { avail: await a.textContent('#avail'), pending: JSON.parse(await ls(a, 'reef:sent:' + TAG))[0].pending };
  await tip(152102);
  await a
    .waitForFunction((want) => document.getElementById('avail').textContent.startsWith(want), fmt(rec.change), { timeout: 5000 })
    .catch(() => {});
  const after = { avail: await a.textContent('#avail'), pending: JSON.parse(await ls(a, 'reef:sent:' + TAG))[0].pending };
  t(
    'change above the signed tip waits; when the tip reaches its block the payment is confirmed and the change spendable',
    /^0\.00000000/.test(before.avail) && before.pending === true && after.avail.startsWith(fmt(rec.change)) && after.pending === false,
    JSON.stringify({ before, after }),
  );
  t('no page errors when the tip rises', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
}
// 11: a loader that is not the pinned file: one notice that says so, nothing run, no second "went wrong" banner
{
  const p = await profile({ seed: { 'reef:started': '1', 'reef:key': KEY }, tamper: true });
  const a = await p.open({ ready: false });
  await a.waitForSelector('#banners [data-b=fatal]', { timeout: 30000 }).catch(() => {});
  await a.waitForTimeout(1500);
  const bs = await a.evaluate(() => [...document.querySelectorAll('#banners [data-b]')].map((b) => b.dataset.b + ': ' + b.textContent));
  t(
    'a tampered node loader is refused: one notice, nothing run, no second banner',
    bs.length === 1 && /^fatal: Reef refused its node code/.test(bs[0]) && !(await a.evaluate(() => !!window.__fake)),
    bs.join(' | '),
  );
  await p.ctx.close();
}
// 12: a cached page of another release asks for another reef.js: one reload, then it runs; none when the session cannot
// remember it (no loop)
for (const noSession of [false, true]) {
  const p = await profile({ seed: { 'reef:started': '1', 'reef:key': KEY }, oldV: '2026-01-01.1', noSession });
  const page = await p.ctx.newPage();
  let loads = 0;
  page.on('load', () => loads++);
  await page.goto('http://localhost:8799/index.html#t');
  await page.waitForFunction(() => window.__fake, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const url = page.url();
  const want = noSession ? 1 : 2;
  t(
    noSession
      ? 'a mixed release with session storage blocked: no reload (it could not remember it), and the page runs'
      : 'a mixed release: one reload that keeps the #hash, then the page runs',
    loads === want && (await page.evaluate(() => !!window.__fake)) && (noSession || (/[?&]r=\d/.test(url) && url.endsWith('#t'))),
    `${loads} loads, ${url}`,
  );
  await p.ctx.close();
}
// 13: the page's record of the vouched height: an old bare number is not trusted; the record follows the node up, down and away
{
  const p = await profile({ seed: { 'reef:started': '1', 'reef:key': KEY, 'reef:vouched': '152100' } });
  const a = await p.open();
  await a.waitForFunction(() => /^tb1p/.test(document.getElementById('rcvaddr').value), null, { timeout: 30000 });
  await a.evaluate(
    ({ script }) => {
      window.__fake.emit('message', { type: 'synced', height: 152100, applied: true });
      window.__fake.emit('message', {
        type: 'coins',
        script,
        height: 152100,
        coins: [
          { key: 'cd'.repeat(32) + ':0', value: 20000, height: 152000 },
          { key: 'ef'.repeat(32) + ':1', value: 30000, height: 152080 },
        ],
      });
    },
    { script: SCRIPT },
  );
  await a.waitForTimeout(1200);
  t(
    'an old bare-number record of the vouched height is ignored: with no tip, money above the snapshot base waits',
    /^0\.00000000/.test(await a.textContent('#avail')),
    await a.textContent('#avail'),
  );
  const say = (vouchedTo) =>
    a.evaluate((vouchedTo) => {
      window.__fake.emit('message', {
        type: 'nostr',
        height: 152100,
        hash: 'ab'.repeat(32),
        agree: 3,
        diverged: false,
        live: true,
        created_at: Math.floor(Date.now() / 1000),
        vouchedTo,
      });
    }, vouchedTo);
  const stored = async () => JSON.parse((await ls(a, 'reef:vouched')) ?? 'null')?.height ?? null;
  await say(152100);
  await a.waitForFunction(() => /^0\.00050000/.test(document.getElementById('avail').textContent), null, { timeout: 5000 }).catch(() => {});
  const up = { rec: await stored(), avail: await a.textContent('#avail') };
  await say(152050);
  await a.waitForFunction(() => /^0\.00020000/.test(document.getElementById('avail').textContent), null, { timeout: 5000 }).catch(() => {});
  const down = { rec: await stored(), avail: await a.textContent('#avail') };
  await say(null);
  await a.waitForTimeout(500);
  const gone = { raw: await ls(a, 'reef:vouched') };
  t(
    "the record follows the node's vouched height: raised with it, lowered by a newer lower one (money above waits again), removed when the node has none",
    up.rec === 152100 &&
      up.avail.startsWith('0.00050000') &&
      down.rec === 152050 &&
      down.avail.startsWith('0.00020000') &&
      gone.raw === null,
    JSON.stringify({ up, down, gone }),
  );
  t('no page errors while the vouched height moves', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
}
// 14: a node that stops after a payment was made: raise, cancel, publish again and forget each say why, and nothing goes out
{
  const p = await profile({ seed: { 'reef:started': '1', 'reef:key': KEY, 'reef:vouched': VOUCHED } });
  const a = await p.open();
  await a.waitForFunction(() => /^tb1p/.test(document.getElementById('rcvaddr').value), null, { timeout: 30000 });
  await a.evaluate(
    ({ script }) => {
      window.__fake.emit('message', { type: 'synced', height: 152100, applied: true });
      window.__fake.emit('message', {
        type: 'coins',
        script,
        height: 152100,
        coins: [{ key: 'cd'.repeat(32) + ':0', value: 50000, height: 152000 }],
      });
    },
    { script: SCRIPT },
  );
  await a.waitForFunction(() => /0\.00050000/.test(document.getElementById('avail').textContent), null, { timeout: 5000 });
  await a.evaluate(() => document.querySelector('[data-p=send]').click());
  await a.fill('#sendto', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
  await a.fill('#sendamt', '0.0001');
  await a.click('#sendgo');
  await a.waitForSelector('#ask[open]', { timeout: 5000 });
  await a.click('#ask-ok');
  await a.waitForFunction(() => (window.__relay ?? []).length === 1, null, { timeout: 15000 });
  // the actions offered while the node runs; their buttons are kept (as a click that was already on its way would be)
  await a.evaluate(() => document.querySelector('[data-p=tx]').click());
  await a.waitForFunction(() => document.querySelectorAll('#txrows button[data-act]').length > 0, null, { timeout: 5000 }).catch(() => {});
  const before = await a.evaluate(() => {
    window.__kept = [...document.querySelectorAll('#txrows button[data-act]')];
    return window.__kept.map((b) => b.dataset.act);
  });
  await a.evaluate(() => {
    window.__fake.node.phase = 'error';
    window.__fake.emit('message', { type: 'error', text: 'the node did not wipe in time and is stopped', fatal: true });
  });
  await a.waitForTimeout(300);
  const after = await a.evaluate(() => [...document.querySelectorAll('#txrows button[data-act]')].map((b) => b.dataset.act));
  const tried = [];
  for (const act of ['bump', 'cancel', 'again', 'forget']) {
    if (!before.includes(act)) continue;
    await a.evaluate((act) => window.__kept.find((b) => b.dataset.act === act).click(), act);
    await a.waitForTimeout(300);
    tried.push({ act, dialog: !!(await a.$('#ask[open]')) });
    if (await a.$('#ask[open]')) await a.click('#ask-cancel');
  }
  const toasts = await a.evaluate(() => document.getElementById('toastwrap')?.textContent ?? '');
  t(
    'a stopped node: the payment actions are no longer offered, a click already on its way says why and opens nothing, and nothing is published',
    before.includes('bump') &&
      before.includes('cancel') &&
      !after.some((x) => x !== 'hide') &&
      tried.length >= 2 &&
      tried.every((x) => !x.dialog) &&
      /node is stopped/.test(toasts) &&
      (await a.evaluate(() => window.__relay.length)) === 1,
    JSON.stringify({ before, after, tried, toasts: toasts.slice(0, 160) }),
  );
  await p.ctx.close();
}
// 15: a file of the wallet's code that imports a full URL (its hash made to match) is still refused: nothing of it runs
{
  const p = await profile({ seed: { 'reef:started': '1', 'reef:key': KEY }, outsideImport: true });
  const page = await p.ctx.newPage();
  const fetched = [];
  page.on('request', (r) => /evil@/.test(r.url()) && fetched.push(r.url()));
  await page.goto('http://localhost:8799/index.html');
  await page.waitForSelector('#banners [data-b=walleterr]', { timeout: 30000 }).catch(() => {});
  const text = await page.evaluate(() => document.querySelector('#banners [data-b=walleterr]')?.textContent ?? '');
  t(
    "a wallet file importing a full URL is refused by the page's own check (the wallet does not start), and the URL is never fetched",
    /address\.mjs imports https:\/\/cdn\.jsdelivr\.net\/npm\/evil@1\.0\.0\/x\.js/.test(text) && !fetched.length,
    `${text.slice(0, 200)} | fetched ${fetched.join(', ')}`,
  );
  await p.ctx.close();
}
// 16: the newer-schema notice's Reload keeps the address (its query and #hash) and only sets a fresh v=
{
  const p = await profile({ seed: returning({ 'reef:schema': '99' }) });
  const page = await p.ctx.newPage();
  await page.goto('http://localhost:8799/index.html?keep=1#h');
  await page.waitForSelector('#banners [data-b=schema]', { timeout: 30000 });
  const nav = page.waitForNavigation({ timeout: 10000 }).catch(() => null);
  await page.evaluate(() =>
    [...document.querySelectorAll('#banners [data-b=schema] button')].find((b) => /Reload/.test(b.textContent)).click(),
  );
  await nav;
  const url = page.url();
  t(
    'a newer schema: Reload keeps the query and the #hash, and sets a fresh v=',
    /[?&]keep=1/.test(url) && /[?&]v=\d+/.test(url) && url.endsWith('#h'),
    url,
  );
  await p.ctx.close();
}
// 17: sending, the guards. A waiting payment's coins are never picked again; a world that moves while the confirm dialog is
// open (a disagreeing tip, other coins, a stopped node) sends nothing; storage that refuses the record sends nothing; the same
// payment made twice is refused; the raise and forget dialogs check the node again (and a question asked right after another is answered by its own buttons)
const DEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const CA = 'a1'.repeat(32) + ':0',
  CB = 'b2'.repeat(32) + ':0',
  CC = 'c3'.repeat(32) + ':0';
async function wallet(coins, extra = {}) {
  const p = await profile({ seed: { 'reef:started': '1', 'reef:key': KEY, 'reef:vouched': VOUCHED, ...extra } });
  const a = await p.open();
  await a.waitForFunction(() => /^tb1p/.test(document.getElementById('rcvaddr').value), null, { timeout: 30000 });
  const feed = (coins, height = 152100) =>
    a.evaluate(
      ({ script, coins, height }) => {
        window.__fake.emit('message', { type: 'synced', height, applied: true });
        window.__fake.emit('message', { type: 'coins', script, height, coins });
      },
      { script: SCRIPT, coins, height },
    );
  await feed(coins);
  await a.waitForFunction(() => !/^0\.00000000/.test(document.getElementById('avail').textContent), null, { timeout: 5000 });
  await a.evaluate(() => document.querySelector('[data-p=send]').click());
  // the confirm dialog for a payment of `amt` to DEST, open
  const confirm = async (amt) => {
    await a.evaluate(() => (document.getElementById('senderr').textContent = ''));
    await a.fill('#sendto', DEST);
    await a.fill('#sendamt', amt);
    await a.click('#sendgo');
    await a.waitForSelector('#ask[open]', { timeout: 5000 });
  };
  const said = () =>
    a
      .waitForFunction(() => document.getElementById('senderr').textContent.length > 0, null, { timeout: 5000 })
      .then(() => a.textContent('#senderr'))
      .catch(() => '');
  const relays = () => a.evaluate(() => (window.__relay ?? []).length);
  const records = async () => JSON.parse((await ls(a, 'reef:sent:' + TAG)) ?? '[]');
  const tipAgrees = (height = 152100) =>
    a.evaluate(
      (height) =>
        window.__fake.emit('message', {
          type: 'nostr',
          height,
          hash: 'cd'.repeat(32),
          agree: 3,
          diverged: false,
          live: true,
          created_at: Math.floor(Date.now() / 1000),
        }),
      height,
    );
  const stop = () =>
    a.evaluate(() => {
      window.__fake.node.phase = 'error';
      window.__fake.emit('message', { type: 'error', text: 'the node did not wipe in time and is stopped', fatal: true });
    });
  return { p, a, feed, confirm, said, relays, records, tipAgrees, stop };
}
{
  const w = await wallet([
    { key: CA, value: 50000, height: 152000 },
    { key: CB, value: 40000, height: 152000 },
  ]);
  const { a } = w;
  // a signed tip that disagrees arrives while the dialog is open
  await w.confirm('0.0001');
  await a.evaluate(() =>
    window.__fake.emit('message', {
      type: 'nostr',
      height: 152102,
      hash: 'ee'.repeat(32),
      agree: 0,
      diverged: true,
      live: true,
      created_at: Math.floor(Date.now() / 1000),
    }),
  );
  await a.click('#ask-ok');
  let e = await w.said();
  t(
    'a signed tip that disagrees while the confirm dialog is open: nothing is sent, and the disagreement is the reason given',
    /disagrees with the signed chain tip; nothing was sent/.test(e) && (await w.relays()) === 0,
    e,
  );
  await w.tipAgrees();
  // the coins change while it is open (the coin it would spend is gone)
  await w.confirm('0.0001');
  await w.feed([{ key: CB, value: 40000, height: 152000 }]);
  await a.click('#ask-ok');
  e = await w.said();
  t('the coins change while the confirm dialog is open: nothing is sent', /nothing was sent/.test(e) && (await w.relays()) === 0, e);
  await w.feed([
    { key: CA, value: 50000, height: 152000 },
    { key: CB, value: 40000, height: 152000 },
  ]);
  // the browser refuses to store the record: nothing leaves, nothing is kept, nothing is held
  await w.confirm('0.0001');
  await a.evaluate(() => {
    const orig = Storage.prototype.setItem;
    window.__setItem = orig;
    Storage.prototype.setItem = function (k, v) {
      if (String(k).startsWith('reef:sent:')) throw new DOMException('full', 'QuotaExceededError');
      return orig.call(this, k, v);
    };
  });
  await a.click('#ask-ok');
  e = await w.said();
  await a.evaluate(() => (Storage.prototype.setItem = window.__setItem));
  const availAfter = await a.textContent('#avail');
  t(
    'storage that refuses the record: nothing is sent, no record is kept and no coin is held',
    /could not be recorded/.test(e) && (await w.relays()) === 0 && (await w.records()).length === 0 && /^0\.00090000/.test(availAfter),
    `${e} / ${availAfter}`,
  );
  // two payments in a row: the second never spends the coin the first one holds
  await w.confirm('0.0001');
  await a.click('#ask-ok');
  await a.waitForFunction(() => (window.__relay ?? []).length === 1, null, { timeout: 15000 });
  await a.waitForTimeout(300);
  await w.confirm('0.0001');
  await a.click('#ask-ok');
  await a.waitForFunction(() => (window.__relay ?? []).length === 2, null, { timeout: 15000 }).catch(() => {});
  const recs = await w.records();
  const ins = recs.flatMap((r) => r.inputs);
  t(
    'a second payment while the first waits spends the other coin, never the one the first holds',
    recs.length === 2 && ins.length === 2 && new Set(ins).size === 2 && ins.includes(CA) && ins.includes(CB),
    JSON.stringify(recs.map((r) => r.inputs)),
  );
  // the node stops while the dialog is open (a third coin to spend)
  await w.feed([
    { key: CA, value: 50000, height: 152000 },
    { key: CB, value: 40000, height: 152000 },
    { key: CC, value: 30000, height: 152000 },
  ]);
  await a.waitForFunction(() => /^0\.00030000/.test(document.getElementById('avail').textContent), null, { timeout: 5000 });
  await w.confirm('0.0001');
  await w.stop();
  await a.waitForTimeout(200);
  if (await a.$('#ask[open]')) await a.click('#ask-ok');
  e = await w.said();
  t(
    'the node stops while the confirm dialog is open: nothing is sent, and the page says why',
    /stopped/.test(e) && /nothing was sent/.test(e) && (await w.relays()) === 2 && (await w.records()).length === 2,
    e,
  );
  t('no page errors in the send guards', !w.p.errors.length, w.p.errors.join(' | '));
  await w.p.ctx.close();
}
// the raise dialog: the node stops while it is open, and nothing is replaced or published
{
  const w = await wallet([{ key: CA, value: 50000, height: 152000 }]);
  const { a } = w;
  await w.confirm('0.0001');
  await a.click('#ask-ok');
  await a.waitForFunction(() => (window.__relay ?? []).length === 1, null, { timeout: 15000 });
  await a.evaluate(() => document.querySelector('[data-p=tx]').click());
  await a.waitForSelector('#txrows button[data-act=bump]', { timeout: 5000 });
  await a.click('#txrows button[data-act=bump]');
  await a.waitForSelector('#ask[open]', { timeout: 5000 });
  await w.stop();
  await a.waitForTimeout(200);
  if (await a.$('#ask[open]')) await a.click('#ask-ok');
  await a.waitForTimeout(800);
  const recs = await w.records();
  t(
    'the node stops while the raise dialog is open: nothing is replaced and nothing more is published',
    (await w.relays()) === 1 && recs.length === 1 && !recs[0].replacedBy,
    JSON.stringify({ relays: await w.relays(), n: recs.length }),
  );
  await w.p.ctx.close();
}
// forget, then the same payment again (the same coin, the same figures: the same transaction) is refused as already made; a second
// payment forgotten while the node stops in the dialog is not forgotten
{
  const w = await wallet([{ key: CA, value: 50000, height: 152000 }]);
  const { a } = w;
  await w.confirm('0.0001');
  await a.click('#ask-ok');
  await a.waitForFunction(() => (window.__relay ?? []).length === 1, null, { timeout: 15000 });
  await w.feed([{ key: CA, value: 50000, height: 152000 }], 152110);
  await w.tipAgrees(152110);
  const forget = async () => {
    await a.evaluate(() => document.querySelector('[data-p=tx]').click());
    await a.waitForSelector('#txrows button[data-act=forget]', { timeout: 5000 });
    await a.click('#txrows button[data-act=forget]');
    await a.waitForSelector('#ask[open]', { timeout: 5000 });
    if ((await a.textContent('#ask-t')) === 'This payment has not gone through') {
      await a.click('#ask-cancel'); // "Forget it…"
      await a.waitForFunction(() => document.getElementById('ask-t').textContent === 'Forget this payment', null, { timeout: 5000 });
    }
  };
  await forget();
  await a.click('#ask-ok');
  await a.waitForFunction((tag) => JSON.parse(localStorage.getItem('reef:sent:' + tag) ?? '[]')[0]?.abandoned, TAG, { timeout: 5000 });
  await a.evaluate(() => document.querySelector('[data-p=send]').click());
  await w.confirm('0.0001');
  await a.click('#ask-ok');
  const e = await w.said();
  t(
    'the same payment made again after it was forgotten (the same transaction) is refused as already made',
    /already made/.test(e) && (await w.relays()) === 1 && (await w.records()).length === 1,
    e,
  );
  // a different amount: a new payment, which spends the forgotten one's coin
  await w.confirm('0.0002');
  await a.click('#ask-ok');
  await a.waitForFunction(() => (window.__relay ?? []).length === 2, null, { timeout: 15000 });
  await w.feed([{ key: CA, value: 50000, height: 152000 }], 152120);
  await w.tipAgrees(152120);
  await a.evaluate(() => document.querySelector('[data-p=tx]').click());
  await a.waitForTimeout(300);
  const n0 = (await w.records()).filter((r) => r.abandoned).length;
  await forget();
  await w.stop();
  await a.waitForTimeout(200);
  if (await a.$('#ask[open]')) await a.click('#ask-ok');
  await a.waitForTimeout(500);
  t(
    'the node stops while the forget dialog is open: the payment is not forgotten',
    (await w.records()).filter((r) => r.abandoned).length === n0,
    JSON.stringify((await w.records()).map((r) => ({ a: !!r.abandoned, s: r.sats }))),
  );
  t('no page errors when forgetting', !w.p.errors.length, w.p.errors.join(' | '));
  await w.p.ctx.close();
}
// 18: the waits and the masks say what they mean. Before the coins are known the Overview says why (a status message does not
// clear it) and Send says why on a click; a stopped node's Send page says so; Mask values covers the Information tab's fees and
// gettxout for the wallet's own coin (printed in Knots' shape)
{
  const p = await profile({ seed: { 'reef:started': '1', 'reef:key': KEY, 'reef:vouched': VOUCHED } });
  const a = await p.open();
  await a.waitForFunction(() => /^tb1p/.test(document.getElementById('rcvaddr').value), null, { timeout: 30000 });
  await a.evaluate(() => window.__fake.emit('message', { type: 'status', phase: 'sync', text: 'validating' }));
  await a.waitForTimeout(300);
  const why = await a.textContent('#ovtrust');
  t('before the coins are known the Overview says why the balance waits, also after a status message', /balance known once/.test(why), why);
  await a.evaluate(() => document.querySelector('[data-p=send]').click());
  await a.fill('#sendto', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
  await a.fill('#sendamt', '0.0001');
  await a.click('#sendgo');
  const said = await a
    .waitForFunction(() => document.getElementById('senderr').textContent.length > 0, null, { timeout: 3000 })
    .then(() => a.textContent('#senderr'))
    .catch(() => '');
  t('Send pressed before the balance is known says why, in the error line', /up to date|checking/.test(said), said);
  // coins, one of ours in the mempool view, Mask values on
  const COIN = 'cd'.repeat(32) + ':0';
  await a.evaluate(
    ({ script, COIN }) => {
      window.__fake.emit('message', { type: 'synced', height: 152100, applied: true });
      window.__fake.emit('message', { type: 'coins', script, height: 152100, coins: [{ key: COIN, value: 50000, height: 152000 }] });
      window.__fake.emit('message', {
        type: 'mempool',
        count: 1,
        bytes: 150,
        fees: 300,
        height: 152100,
        stats: { refused: 0, dropped: 0 },
        txs: [{ txid: 'ab'.repeat(32), vsize: 150, fee: 300, fed: true, inputs: [COIN], outputs: [] }],
      });
    },
    { script: SCRIPT, COIN },
  );
  await a.waitForFunction(() => /^0\.000/.test(document.getElementById('total').textContent), null, { timeout: 5000 });
  const plain = await a.textContent('#i-mpmem');
  await a.evaluate(() => document.getElementById('m-mask').onclick());
  await a.waitForTimeout(200);
  const masked = await a.textContent('#i-mpmem');
  t(
    "Mask values hides the Information tab's mempool fees when the wallet's own transaction is among them, at once",
    /300 sat in fees/.test(plain) && /fees hidden/.test(masked) && !/300/.test(masked),
    `${plain} → ${masked}`,
  );
  await a.evaluate(
    ({ script, COIN }) =>
      window.__fake.emit('message', {
        type: 'coin',
        key: COIN,
        found: true,
        value: 50000,
        height: 152000,
        coinbase: false,
        scriptType: 'p2tr',
        address: 'tb1p…',
        scriptPubKey: script,
      }),
    { script: SCRIPT, COIN },
  );
  await a.waitForTimeout(200);
  const out = await a.textContent('#cout');
  t(
    "gettxout prints Knots' shape, the wallet's own value masked",
    /"confirmations": 101/.test(out) && /"value": "amount hidden"/.test(out) && /"scriptPubKey"/.test(out) && !/"type": "coin"/.test(out),
    out.slice(-300),
  );
  // the node stops: the Send page says so, and one notice says it
  await a.evaluate(() => {
    window.__fake.node.phase = 'error';
    window.__fake.node.error = 'the node did not wipe in time and is stopped';
    window.__fake.emit('message', { type: 'error', text: 'the node did not wipe in time and is stopped', fatal: true });
  });
  await a.waitForTimeout(300);
  const pv = await a.textContent('#sendpreview');
  const notices = await a.evaluate(
    () => [...document.querySelectorAll('#banners .banner')].filter((b) => /stopped/.test(b.textContent)).length,
  );
  t(
    'a stopped node: the Send page says so, and one notice says it',
    /node is stopped/.test(pv) && notices === 1,
    `${pv} / ${notices} notices`,
  );
  t('no page errors in the waits and masks', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
}
// 19: the policy is in force (not only written); files gone stop sending until a sync succeeds; a coinbase mature at the source's
// height but not at the vouched height is not spent; storage that refuses a replacement leaves the original as it was; an idle
// tab does not switch keys
{
  const w = await wallet([{ key: CA, value: 50000, height: 152000 }]);
  const { a } = w;
  const csp = await a.evaluate(async () => {
    // a string timer is the page's own eval (code typed into devtools is exempt from the policy, a page's timer is not)
    setTimeout('window.__evald = 1');
    await new Promise((r) => setTimeout(r, 300));
    const evalRefused = window.__evald !== 1;
    const seen = new Promise((r) => document.addEventListener('securitypolicyviolation', (e) => r(e.violatedDirective), { once: true }));
    const sc = document.createElement('script');
    sc.textContent = 'window.__inline = 1';
    document.head.append(sc);
    const v = await Promise.race([seen, new Promise((r) => setTimeout(() => r(null), 2000))]);
    return { evalRefused, ran: window.__inline === 1, v };
  });
  t(
    'the page runs under its policy: eval is refused, and an injected inline script does not run and is reported',
    csp.evalRefused && !csp.ran && /script-src/.test(csp.v ?? ''),
    JSON.stringify(csp),
  );
  // the node's files gone (site data cleared): sending stops until a sync succeeds again
  await a.evaluate(() =>
    window.__fake.emit('message', {
      type: 'error',
      name: 'NotFoundError',
      text: 'A requested file or directory could not be found at the time an operation was processed.',
      req: 'coins',
    }),
  );
  await a.waitForTimeout(300);
  await a.evaluate(() => (document.getElementById('senderr').textContent = ''));
  await a.fill('#sendto', DEST);
  await a.fill('#sendamt', '0.0001');
  await a.click('#sendgo');
  const e1 = await w.said();
  const gone = await a.evaluate(() => document.querySelector('#banners [data-b="nodeerr"]')?.textContent ?? '');
  t(
    "the node's files gone while it says it is up to date: nothing can be sent, and the notice says to reload",
    /stopped/.test(e1) && !(await a.$('#ask[open]')) && /gone or unreadable/.test(gone) && (await w.relays()) === 0,
    `${e1} / ${gone.slice(0, 80)}`,
  );
  await w.feed([{ key: CA, value: 50000, height: 152000 }]);
  await a.waitForTimeout(300);
  const reopened = await w
    .confirm('0.0001')
    .then(() => true)
    .catch(() => false);
  if (reopened) await a.click('#ask-cancel');
  t('a sync that succeeds clears it: the confirm dialog opens again', reopened);
  await w.p.ctx.close();
}
{
  // vouched at 152,099: a coinbase at 152,001 has 100 confirmations by the source's height (152,100) but 99 by the vouched one
  const w = await wallet(
    [
      { key: CA, value: 50000, height: 152000 },
      { key: CB, value: 5000000000, height: 152001, coinbase: true },
    ],
    { 'reef:vouched': JSON.stringify({ height: 152099, at: 1 }) },
  );
  const { a } = w;
  await a.fill('#sendto', DEST);
  await a.click('#sendall');
  await a.waitForFunction(() => Number(document.getElementById('sendamt').value) > 0, null, { timeout: 5000 }).catch(() => {});
  const amt = await a.inputValue('#sendamt');
  t(
    'Send everything leaves out a mined coin that is mature by the source but not by the signed chain tip',
    Number(amt) > 0 && Number(amt) < 0.0005,
    amt,
  );
  await w.p.ctx.close();
}
{
  const w = await wallet([{ key: CA, value: 50000, height: 152000 }]);
  const { a } = w;
  await w.confirm('0.0001');
  await a.click('#ask-ok');
  await a.waitForFunction(() => (window.__relay ?? []).length === 1, null, { timeout: 15000 });
  await a.evaluate(() => document.querySelector('[data-p=tx]').click());
  await a.waitForSelector('#txrows button[data-act=bump]', { timeout: 5000 });
  await a.click('#txrows button[data-act=bump]');
  await a.waitForSelector('#ask[open]', { timeout: 5000 });
  await a.evaluate(() => {
    const orig = Storage.prototype.setItem;
    window.__setItem = orig;
    Storage.prototype.setItem = function (k, v) {
      if (String(k).startsWith('reef:sent:')) throw new DOMException('full', 'QuotaExceededError');
      return orig.call(this, k, v);
    };
  });
  await a.click('#ask-ok');
  await a.waitForTimeout(600);
  await a.evaluate(() => (Storage.prototype.setItem = window.__setItem));
  const toasts = await a.evaluate(() => [...document.querySelectorAll('.toast')].map((x) => x.textContent).join(' | '));
  await a.evaluate(() => document.querySelector('[data-p=tx]').click());
  await a.waitForTimeout(300);
  const canRaise = !!(await a.$('#txrows button[data-act=bump]'));
  t(
    'storage that refuses a replacement: nothing more goes out, and the original can still be raised (it is not marked replaced)',
    (await w.relays()) === 1 && canRaise && !(await w.records())[0].replacedBy,
    `${toasts.slice(0, 120)} / raise offered: ${canRaise}`,
  );
  await w.p.ctx.close();
}
{
  const p = await profile({ seed: { 'reef:started': '1', 'reef:key': KEY, 'reef:keynew': '1', 'reef:vouched': VOUCHED } });
  const a = await p.open();
  await a.waitForFunction(() => /^tb1p/.test(document.getElementById('rcvaddr').value), null, { timeout: 30000 });
  await a.waitForFunction(() => window.__fake.starts > 0, null, { timeout: 15000 }); // this tab holds the node's lock first
  await a.waitForTimeout(500);
  const b = await p.open();
  await b.waitForFunction(() => document.body.classList.contains('idle'), null, { timeout: 15000 });
  await b.evaluate(() => {
    document.getElementById('m-options').click();
    document.querySelector('[data-o=wallet]').click();
  });
  const disabled = await b.evaluate(() => document.getElementById('o-importkey').disabled);
  // the field is disabled here; a value put in anyway (a script, an extension) is still refused by the handler
  await b.evaluate(() => (document.getElementById('o-importkey').value = '22'.repeat(32)));
  await b.click('#o-ok');
  await b.waitForTimeout(400);
  const warn = await b.textContent('#o-keywarn');
  t(
    'an idle tab does not switch keys, even a key never used here: the field is disabled, and a value forced in is refused',
    disabled && (await ls(b, 'reef:key')) === KEY && /another tab/.test(warn),
    `${disabled} / ${warn}`,
  );
  await p.ctx.close();
}
// 20: the last guards. A payment that reaches a node while the forget dialog is open is not forgotten; files gone stay gone
// whatever error comes next, until a sync succeeds; a files-gone error is told by its name whatever its words; a disagreeing tip
// while the raise dialog is open replaces nothing; the start says "starting the node" before the node's code is in; on a phone
// the notice that says the tab's state (and holds its one way on) is the one shown
{
  const w = await wallet([{ key: CA, value: 50000, height: 152000 }]);
  const { a } = w;
  await w.confirm('0.0001');
  await a.click('#ask-ok');
  await a.waitForFunction(() => (window.__relay ?? []).length === 1, null, { timeout: 15000 });
  await w.feed([{ key: CA, value: 50000, height: 152000 }], 152110);
  await w.tipAgrees(152110);
  const txid = (await w.records())[0].txid;
  await a.evaluate(() => document.querySelector('[data-p=tx]').click());
  await a.waitForSelector('#txrows button[data-act=forget]', { timeout: 5000 });
  await a.click('#txrows button[data-act=forget]');
  await a.waitForSelector('#ask[open]', { timeout: 5000 });
  if ((await a.textContent('#ask-t')) === 'This payment has not gone through') {
    await a.click('#ask-cancel');
    await a.waitForFunction(() => document.getElementById('ask-t').textContent === 'Forget this payment', null, { timeout: 5000 });
  }
  // a node takes it meanwhile: the feed lists it
  await a.evaluate(
    (txid) =>
      window.__fake.emit('message', {
        type: 'mempool',
        count: 1,
        stats: { refused: 0, dropped: 0 },
        bytes: 150,
        fees: 155,
        txs: [{ txid, inputs: ['a1'.repeat(32) + ':0'], outputs: [], fed: true, vsize: 150, fee: 155 }],
      }),
    txid,
  );
  await a.waitForTimeout(300);
  await a.click('#ask-ok');
  await a.waitForTimeout(500);
  t(
    'a payment that reaches a node while the forget dialog is open is not forgotten (its coins stay held)',
    !(await w.records())[0].abandoned,
    JSON.stringify((await w.records()).map((r) => ({ a: !!r.abandoned }))),
  );
  await w.p.ctx.close();
}
{
  const w = await wallet([{ key: CA, value: 50000, height: 152000 }]);
  const { a } = w;
  const tryConfirm = () =>
    w
      .confirm('0.0001')
      .then(async () => (await a.click('#ask-cancel'), true))
      .catch(() => false);
  // files gone, then an error of another kind (the source unreachable): still stopped, and the notice still says gone
  await a.evaluate(() =>
    window.__fake.emit('message', {
      type: 'error',
      name: 'NotFoundError',
      text: 'A requested file or directory could not be found at the time an operation was processed.',
    }),
  );
  await a.evaluate(() => window.__fake.emit('message', { type: 'error', name: 'TypeError', text: 'Failed to fetch' }));
  await a.waitForTimeout(300);
  const opened = await tryConfirm();
  const gone = await a.evaluate(() => document.querySelector('#banners [data-b="nodeerr"]')?.textContent ?? '');
  t(
    'files gone stay gone when another error follows: nothing can be sent, and the notice still says gone',
    !opened && /gone or unreadable/.test(gone) && (await w.relays()) === 0,
    `${opened} / ${gone.slice(0, 80)}`,
  );
  await w.feed([{ key: CA, value: 50000, height: 152000 }]);
  await a.waitForTimeout(300);
  t('a sync that succeeds lifts it', await tryConfirm());
  // told by its name whatever its words (a browser in another language)
  await a.evaluate(() =>
    window.__fake.emit('message', { type: 'error', name: 'NotFoundError', text: 'Eine angeforderte Datei wurde nicht gefunden.' }),
  );
  await a.waitForTimeout(300);
  t('a files-gone error is told by its name whatever its words: nothing can be sent', !(await tryConfirm()));
  await w.p.ctx.close();
}
{
  const w = await wallet([{ key: CA, value: 50000, height: 152000 }]);
  const { a } = w;
  await w.confirm('0.0001');
  await a.click('#ask-ok');
  await a.waitForFunction(() => (window.__relay ?? []).length === 1, null, { timeout: 15000 });
  await a.evaluate(() => document.querySelector('[data-p=tx]').click());
  await a.waitForSelector('#txrows button[data-act=bump]', { timeout: 5000 });
  await a.click('#txrows button[data-act=bump]');
  await a.waitForSelector('#ask[open]', { timeout: 5000 });
  await a.evaluate(() =>
    window.__fake.emit('message', {
      type: 'nostr',
      height: 152102,
      hash: 'ee'.repeat(32),
      agree: 0,
      diverged: true,
      live: true,
      created_at: Math.floor(Date.now() / 1000),
    }),
  );
  await a.waitForTimeout(200);
  if (await a.$('#ask[open]')) await a.click('#ask-ok');
  await a.waitForTimeout(800);
  const recs = await w.records();
  t(
    'a signed tip that disagrees arrives while the raise dialog is open: nothing is replaced and nothing more is published',
    (await w.relays()) === 1 && recs.length === 1 && !recs[0].replacedBy,
    JSON.stringify({ relays: await w.relays(), n: recs.length }),
  );
  await w.p.ctx.close();
}
{
  // the node's code takes three seconds to load: the line says so at once, not "checking whether another tab…"
  const p = await profile({ startMs: 3000, seed: { 'reef:started': '1', 'reef:key': KEY } });
  const a = await p.open();
  await a.waitForTimeout(1000);
  const line = await a.textContent('#syncmsg');
  t(
    'while the node is still loading its code, the status line already says it is starting',
    /starting the node/i.test(line) && !/checking whether another tab/.test(line),
    line,
  );
  await p.ctx.close();
}
{
  // on a phone only the first notice shows: the one that says the tab's state, whatever else is up
  const first = (pg) => pg.evaluate(() => document.querySelector('#banners')?.firstElementChild?.dataset.b ?? '');
  const p = await profile({ seed: returning() }); // a set-aside record: its notice is up too
  const a = await p.open();
  await a.setViewportSize({ width: 390, height: 844 });
  await a.waitForSelector('#banners [data-b=quarantine]', { timeout: 10000 });
  const b = await p.open();
  await b.setViewportSize({ width: 390, height: 844 });
  await b.waitForSelector('#banners [data-b=twotabs]', { timeout: 10000 });
  await b.waitForTimeout(500);
  t(
    'a phone, idle tab with a set-aside record: the "another tab runs the node" notice is the one shown',
    (await first(b)) === 'twotabs',
    await first(b),
  );
  await a.close();
  await b.waitForFunction(() => /Run it here/.test(document.querySelector('#banners [data-b=twotabs]')?.textContent ?? ''), null, {
    timeout: 15000,
  });
  t('a phone, the other tab closed: "Run it here" is the notice shown', (await first(b)) === 'twotabs', await first(b));
  await p.ctx.close();
  const q = await profile({ seed: {} }); // a first visit: the welcome
  const c = await q.open();
  await c.setViewportSize({ width: 390, height: 844 });
  await c.waitForSelector('#welcome[open]', { timeout: 10000 });
  await c.click('#wl-later');
  await c.waitForSelector('#banners [data-b=welcome]', { timeout: 5000 });
  await c.waitForTimeout(500);
  t('a phone, after Not now: the "not started" notice with Start is the one shown', (await first(c)) === 'welcome', await first(c));
  t('no page errors in the phone notices', !p.errors.length && !q.errors.length, [...p.errors, ...q.errors].join(' | '));
  await q.ctx.close();
}

await browser.close();
console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
