// The page itself in a headless browser, with the node replaced by test/fake/tabnode.js and the pinned libraries served from
// local checkouts (the same ones the unit tests use). It checks the startup order and the read-only paths that unit tests
// cannot see. Needs playwright-core and a Chromium: CHROME=<path> or `npx playwright-core install chromium-headless-shell`.
//   SCHEMA=<bitcoin-desktop/schema> SIDESTR_LIB=<siding/lib> node test/smoke.mjs
import { readFileSync, existsSync } from 'node:fs';
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
  [/^https:\/\/cdn\.jsdelivr\.net\/gh\/sidestr\/spec@[0-9a-f]+\/(.*)$/, (m) => `${SPEC}/${m[1]}`],
  [/^https:\/\/cdn\.jsdelivr\.net\/gh\/bitcoin-desktop\/schema@[0-9a-f]+\/(.*)$/, (m) => `${SCHEMA}/${m[1]}`],
  [/^http:\/\/localhost:8799\/seed$/, () => null],
  [/^http:\/\/localhost:8799\/([^?]*)/, (m) => `${ROOT}${m[1] || 'index.html'}`],
];
const type = (p) =>
  p.endsWith('.html') ? 'text/html' : /\.json(ld)?$/.test(p) ? 'application/json' : p.endsWith('.css') ? 'text/css' : 'text/javascript';
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});

// one browser profile: seed its storage, then open Reef in one or more pages
async function profile({ libDelay = 0, startMs = 50, seed = {} } = {}) {
  const ctx = await browser.newContext();
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    for (const [re, f] of MAP) {
      const m = u.match(re);
      if (!m) continue;
      const p = f(m);
      if (p === null) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>seed</title>' });
      if (!existsSync(p)) return route.fulfill({ status: 404, body: '' });
      if (libDelay && !u.startsWith('http://localhost:8799')) await new Promise((r) => setTimeout(r, libDelay));
      return route.fulfill({ status: 200, contentType: type(p), body: readFileSync(p), headers: { 'access-control-allow-origin': '*' } });
    }
    if (/^https:\/\/cdn\.jsdelivr\.net\/npm\//.test(u)) return route.continue(); // qrcode, webtorrent: pinned with SRI where loaded
    return route.fulfill({ status: 404, body: '' }); // the mirror, relays over http: nothing leaves the test
  });
  await ctx.addInitScript((ms) => (window.__START_MS = ms), startMs);
  const s = await ctx.newPage();
  await s.goto('http://localhost:8799/seed');
  await s.evaluate((seed) => {
    localStorage.clear();
    for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
  }, seed);
  await s.close();
  const errors = [];
  const open = async () => {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on(
      'console',
      (m) => m.type() === 'error' && !/Content Security Policy|WebSocket|ERR_|404/.test(m.text()) && errors.push(m.text()),
    );
    await page.goto('http://localhost:8799/index.html');
    await page.waitForFunction(() => window.__fake, null, { timeout: 30000 });
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
  await page.waitForTimeout(opts.startMs + 1000);
  const q = JSON.parse((await ls(page, 'reef:quarantine:' + TAG)) ?? '[]');
  const stored = JSON.parse((await ls(page, 'reef:sent:' + TAG)) ?? '[]');
  t(
    `${name}: the failing record is kept in the set-aside list`,
    q.some((x) => x.txid === BAD.txid),
    JSON.stringify({ q, stored }),
  );
  await coins(page);
  await page.waitForTimeout(400);
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
  await page.waitForTimeout(4000);
  t('a newer schema: the node is not started', (await page.evaluate(() => window.__fake.starts)) === 0);
  t(
    'a newer schema: the records and the marker are untouched',
    (await ls(page, 'reef:sent:' + TAG)) === seed['reef:sent:' + TAG] &&
      (await ls(page, 'reef:schema')) === '99' &&
      !(await ls(page, 'reef:quarantine:' + TAG)),
  );
  t(
    'a newer schema: sending is disabled and a notice says why',
    (await page.isDisabled('#sendgo')) && !!(await page.$('#banners [data-b=schema]')),
  );
  await p.ctx.close();
}

// 4, 5: before the node answers the wallet does not claim "no coins"; a second tab is idle and read-only
{
  const p = await profile({ seed: { 'reef:started': '1', 'reef:key': KEY } });
  const a = await p.open();
  await a.waitForTimeout(2500);
  const recent = await a.textContent('#recent');
  t('before the node answers, the recent list says it is waiting', /waiting for the node/.test(recent), recent);
  const b = await p.open();
  await b.waitForTimeout(4500);
  t(
    'a second tab is idle: sending disabled, the node not started there',
    (await b.isDisabled('#sendgo')) &&
      (await b.evaluate(() => document.body.classList.contains('idle'))) &&
      (await b.evaluate(() => window.__fake.starts)) <= 1,
  );
  t('the running tab is not marked idle', !(await a.evaluate(() => document.body.classList.contains('idle'))));
  const shown = await a.evaluate(() =>
    [...document.querySelectorAll('[hidden]')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.id || e.className),
  );
  t('every element marked hidden is hidden (no style overrides it)', !shown.length, shown.join(', '));
  t('no page errors', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
}
await browser.close();
console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
