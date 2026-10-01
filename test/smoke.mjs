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
const forSmoke = (src) => {
  const real = src.match(/'siding\/lib\/relay\.mjs': '([0-9a-f]{64})'/)[1];
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
// version (a cached page of an older release); noSession: sessionStorage throws, as when site data is blocked
async function profile({ libDelay = 0, startMs = 50, seed = {}, tamper = false, oldV = null, noSession = false } = {}) {
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
      // checked against the commit by the release test)
      if (typeof p === 'string' && p.endsWith('/reef.js')) body = forSmoke(String(body));
      if (tamper && typeof p === 'string' && p.endsWith('/fake/tabnode.js')) body = String(body) + '\n// changed\n';
      if (oldV && typeof p === 'string' && p.endsWith('/index.html'))
        body = String(body).replace(/reef\.js\?v=[^"]+"/, `reef.js?v=${oldV}"`);
      if (libDelay && !u.startsWith('http://localhost:8799')) await new Promise((r) => setTimeout(r, libDelay));
      const name = typeof p === 'object' ? p.path : p;
      return route.fulfill({ status: 200, contentType: type(name), body, headers: { 'access-control-allow-origin': '*' } });
    }
    if (/^https:\/\/cdn\.jsdelivr\.net\/npm\//.test(u)) return route.continue(); // qrcode, webtorrent: pinned with SRI where loaded
    return route.fulfill({ status: 404, body: '' }); // the mirror over http: nothing leaves the test (relays are faked above)
  });
  await ctx.addInitScript((ms) => (window.__START_MS = ms), startMs);
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
      (m) => m.type() === 'error' && !/Content Security Policy|WebSocket|ERR_|404/.test(m.text()) && errors.push(m.text()),
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
  'reef:vouched': '152100', // a returning user's last signed tip: with none, coins above the snapshot base wait as pending
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
  const p = await profile({ seed: { 'reef:started': '1', 'reef:key': KEY, 'reef:vouched': '152100' } });
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
    (await a.evaluate(() => [...document.querySelectorAll('#txrows button')].map((b) => b.dataset.act).join())) === 'bump,again,cancel',
  );
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
// 8: money in a block above the signed tip is said as being double-checked; a silent broadcaster is warned about
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
    .waitForFunction(() => /double-checked/.test(document.getElementById('outgoing').textContent), null, { timeout: 5000 })
    .catch(() => {});
  t(
    'money in a block above the signed tip: not available, said as being double-checked, in the list too',
    (await a.textContent('#avail')).startsWith('0.00010000') &&
      /0\.00007000 tBTC in blocks still being double-checked/.test(await a.textContent('#outgoing')) &&
      /being double-checked/.test(await a.textContent('#recent')),
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
  const p = await profile({ seed: { 'reef:started': '1', 'reef:key': KEY, 'reef:vouched': '152100' } });
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
  t('no page errors in the sending edges', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
}
// 10: a payment's change in a block above the signed tip; the tip then reaches that block: confirmed, the change spendable
{
  const p = await profile({ seed: { 'reef:started': '1', 'reef:key': KEY, 'reef:vouched': '152100' } });
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
await browser.close();
console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
