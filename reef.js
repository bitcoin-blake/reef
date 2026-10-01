// Reef: the Qt face over blaketestnode's browser node. The worker is the node's own (pinned by commit), loaded through a
// blob so this stays one page; the page drives its phases (fetch, hash, verify, sync) and shows them the way a node does.
// The wallet's rules (amounts, destinations, fees, coin selection, balances, history, key formats) are lib/wallet.mjs,
// tested against the kernel; this file is the host: storage, the node, the relays, the window. Every string that comes
// from outside (relays, the mempool, the chain, links, options) reaches the page as text, never as markup.
const $ = (id) => document.getElementById(id);
export const VERSION = '2026-10-01.19';
const SCHEMA = 2; // the storage layout this version writes
const NODE = 'https://cdn.jsdelivr.net/gh/bitcoin-blake/blaketestnode@5550637a7f31866e61ce215e1c2bd7b30a12ab80';
const LIB = 'https://cdn.jsdelivr.net/gh/sidestr/spec@fe689e9c723f9bf43393d2dd5b6f924a701c8a18/siding/lib',
  CDN = 'https://cdn.jsdelivr.net/gh/bitcoin-desktop/schema@b8cbf6337c7450fe14ddc5bce00c7280059aab5d';
// the engine's rule files by content as well as by commit: a CDN that served other rules would validate another chain
// (sha256 of each file at the pinned commit; test/state-test.mjs checks them against the checkout)
export const RULES_SHA256 = {
  'schema/core.jsonld': 'fb5f3e2b984bfaa36eee6d5e6a6a191c3865cc09cadb4ffee16fae76a54e6ef5',
  'schema/proof.jsonld': '0defcdc32d7421d1440628681027564a7e5590f62d351cc5f075b6cd57c4d1e0',
  'schema/script.jsonld': 'c3a28b41ceae1c1f83288fe1755d1550989e5c5a3e51f1bf8c729a6e42db73a8',
  'schema/chain.jsonld': 'ccbdb40f9ffd72c0686c6303ab8899f79f6c651735bdfcef431af6c23efec821',
  'schema/validate.jsonld': '4eb6792d4330397631d14dc4a8734ddb28fdd2459a3f98fc2bf822596a95bfb0',
  'schema/overlays/knots-blake2b.jsonld': 'b5b76b03a8b1159b4dd304a9b3b65b9a5891204f81fa0b26e4b42692d0a2022e',
};
const EXPLORER = 'https://mempool.guide/testnet4',
  REPO = 'https://github.com/bitcoin-blake/reef';
const DEFAULT_RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://nostr.oxtr.dev'];
const TIP_RELAYS = ['wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.nostr.band'];
const DEFAULT_SNAP = 'https://melvin.me/public/txbt4/utxo-knots-150307.dat',
  DEFAULT_BLOCKS = 'https://melvin.me/public/txbt4/txbt4-blocks';
const RETURNING = (() => {
  try {
    return !!localStorage.getItem('reef:started') || (!!localStorage.getItem('reef:key') && !localStorage.getItem('reef:keynew'));
  } catch {
    return false;
  }
})(); // someone who used Reef before: no welcome step (a key made by a visit that chose Not now does not count)
// records written by a newer Reef: this copy never starts the node or writes anything (read before anything else runs)
const NEWER_SCHEMA = (() => {
  try {
    return Number(localStorage.getItem('reef:schema') ?? 0) > SCHEMA;
  } catch {
    return false;
  }
})();
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LS = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
      return true;
    } catch {
      return false;
    }
  },
  del: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};
const SS = {
  get: (k) => {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      sessionStorage.setItem(k, v);
    } catch {}
  },
};
const OPT_DEFAULTS = { unit: 'tbtc', feeRate: 1, notify: true, mask: false, relays: DEFAULT_RELAYS, torrent: false, seed: false };
const OPT = (() => {
  try {
    return { ...OPT_DEFAULTS, ...JSON.parse(LS.get('reef:options') ?? '{}') };
  } catch {
    return { ...OPT_DEFAULTS };
  }
})();
if (!['tbtc', 'mtbtc', 'sats'].includes(OPT.unit)) OPT.unit = 'tbtc';
// each option of the shape it must have: a string where a list belongs would be spread into letters
if (!Array.isArray(OPT.relays) || !OPT.relays.every((r) => typeof r === 'string' && /^wss:\/\//.test(r))) OPT.relays = DEFAULT_RELAYS;
if (!(Number.isInteger(OPT.feeRate) && OPT.feeRate >= 1)) OPT.feeRate = 1;
for (const k of ['notify', 'mask', 'torrent', 'seed']) OPT[k] = !!OPT[k];
const saveOptions = () => {
  if (IDLE) {
    // an idle tab changes only how things look; the rest stays what the running tab stored
    let stored = {};
    try {
      stored = JSON.parse(LS.get('reef:options') ?? '{}') ?? {};
    } catch {}
    return LS.set('reef:options', JSON.stringify({ ...stored, unit: OPT.unit, mask: OPT.mask }));
  }
  return LS.set('reef:options', JSON.stringify(OPT));
};
const RELAYS = () => (OPT.relays?.length ? OPT.relays : DEFAULT_RELAYS);
const q = new URLSearchParams(location.search);
const embedded = q.get('embedded') === '1' || q.get('frame') === '0';
if (embedded) document.body.classList.add('embedded');
const keepQuery = () => (q.get('frame') === '0' ? '?frame=0' : q.get('embedded') === '1' ? '?embedded=1' : '');
// the sources: what Options set, or the defaults. A link may propose others (?snapshot=, ?blocks=); they are used only
// for this visit and only after the person agrees in the page, and never stored
const proposed = { snapshot: q.get('snapshot'), blocks: q.get('blocks') };
const accepted = (k) => proposed[k] && SS.get('reef:accept:' + k) === proposed[k];
const SNAP_URL = (accepted('snapshot') ? proposed.snapshot : null) ?? LS.get('reef:snapshot') ?? DEFAULT_SNAP;
const BLOCKS_URL = (accepted('blocks') ? proposed.blocks : null) ?? LS.get('reef:blocks') ?? DEFAULT_BLOCKS;
const fmt = (t) =>
  t
    ? new Date(t * 1000).toLocaleString(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '…';
const txLink = (txid, text = txid) => `<a href="${EXPLORER}/tx/${esc(txid)}" target="_blank" rel="noopener">${esc(text)}</a>`;

// ---- banners: one line each at the top of the window, for what the person must know now
const dismissed = new Set();
const STICKY = new Set(['fatal', 'nodeerr', 'walleterr', 'schema', 'savefail', 'keygone', 'lockfail', 'badkey', 'nokey', 'trustbad']);
// spoken from where the reader is: inside an open dialog or the (modal) node window, everything else is inert and silent
function sayOnce(text, urgent = false) {
  const host =
    document.querySelector('dialog[open]') ??
    (document.getElementById('nw')?.classList.contains('open') ? document.getElementById('nw') : document.body);
  const id = (urgent ? 'say-alert' : 'say-status') + (host === document.body ? '' : '-' + (host.id || 'dlg'));
  let r = document.getElementById(id);
  if (!r) {
    r = document.createElement('div');
    r.id = id;
    r.className = 'sr';
    r.setAttribute('role', urgent ? 'alert' : 'status');
    host.appendChild(r);
  }
  // one child per message, removed after a while: two notices close together are both read, neither overwrites the other
  const m = document.createElement('p');
  setTimeout(() => {
    m.textContent = text;
    r.appendChild(m);
  }, 50);
  setTimeout(() => m.remove(), 15e3);
}
function banner(id, cls, text, actions = []) {
  if (dismissed.has(id)) return;
  let el = document.querySelector(`#banners [data-b="${id}"]`);
  if (el && el.dataset.text === cls + text) return;
  if (!el) {
    el = document.createElement('div');
    el.dataset.b = id;
    $('banners').appendChild(el);
  }
  el.dataset.text = cls + text;
  el.className = 'banner ' + cls;
  el.onclick = null;
  // the notices themselves are not live regions (a region created and filled at once is often not read, and its buttons
  // would be read with it): the words are said once, an alert only for the ones that stop the tab
  el.removeAttribute('role');
  sayOnce(text, STICKY.has(id) && cls === 'bad');
  el.textContent = '';
  const t = document.createElement('span');
  t.textContent = text;
  if (text.includes('\n')) t.style.whiteSpace = 'pre-line';
  el.appendChild(t);
  for (const [label, fn] of actions) {
    const b = document.createElement('button');
    b.className = 'q';
    b.type = 'button';
    b.textContent = label;
    b.onclick = fn;
    el.appendChild(b);
  }
  {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'q more';
    more.textContent = 'More';
    more.setAttribute('aria-expanded', 'false');
    more.onclick = () => {
      const f = el.classList.toggle('full');
      more.setAttribute('aria-expanded', String(f));
      more.textContent = f ? 'Less' : 'More';
    };
    el.appendChild(more);
  }
  // every notice can be put away once read, except the ones that say the tab must not be used as it is
  if (!STICKY.has(id)) {
    const x = document.createElement('button');
    x.className = cls === 'bad' ? 'q' : 'q x';
    x.type = 'button';
    x.textContent = cls !== 'bad' ? '×' : id === 'backup' ? 'Remind me later' : 'Got it';
    if (cls !== 'bad') x.setAttribute('aria-label', 'Hide this notice for now');
    else x.title = id === 'backup' ? 'until Reef is opened again' : 'hide this notice for now';
    x.onclick = () => {
      dismissed.add(id);
      el.remove();
    };
    el.appendChild(x);
  }
  const all = [...$('banners').children];
  const rank = (b) => (b.classList.contains('bad') ? 0 : b.classList.contains('warn') ? 1 : 2);
  all.sort((a, b) => rank(a) - rank(b)).forEach((b) => $('banners').appendChild(b));
}
const unbanner = (id) => document.querySelector(`#banners [data-b="${id}"]`)?.remove();
function showFatal(text) {
  $('syncmsg').textContent = text;
  banner('fatal', 'bad', text, [['Reload', () => location.reload()]]);
}

// errors nobody caught: said, and kept (the last 20) for Copy diagnostics, instead of a page silently stuck
const pageErrors = [];
const caught = (what) => {
  const text = String(what?.message ?? what ?? 'unknown error').slice(0, 300);
  pageErrors.push({ at: Date.now(), text });
  if (pageErrors.length > 20) pageErrors.shift();
  banner(
    'pageerr',
    'warn',
    `Something in the page went wrong (${text.slice(0, 120)}). If Reef stops responding, reload; Help → Copy diagnostics records it.`,
    [['Reload', () => location.reload()]],
  );
};
addEventListener('error', (e) => caught(e.error ?? e.message));
addEventListener('unhandledrejection', (e) => caught(e.reason));
// a cached page and its script from different releases: before anything is imported (an old page's security policy names
// the old node pin, so the import itself would fail), reload once per pair of versions
{
  const asked = document.querySelector('script[src*="reef.js"]')?.src.match(/v=([^&]+)/)?.[1];
  const mixKey = 'reef:mixed:' + decodeURIComponent(asked ?? '') + '>' + VERSION; // once per pair of versions, not once per tab
  if (asked && decodeURIComponent(asked) !== VERSION && !SS.get(mixKey)) {
    SS.set(mixKey, '1');
    location.replace(location.pathname + (keepQuery() ? keepQuery() + '&' : '?') + 'v=' + encodeURIComponent(VERSION));
    await new Promise(() => {}); // nothing more runs in a page being replaced (no lock, no worker, no import)
  }
}
// ---- the libraries; a CDN outage is said in words, not as a dead page
let createTabNode, mib, secs, n, WL, S, V, T;
try {
  // a CDN that hangs rather than fails would leave "starting" for ever: twenty seconds, then said
  ({ createTabNode, mib, secs, n } = await Promise.race([
    import(`${NODE}/browser/tabnode.js`),
    new Promise((_, no) => setTimeout(() => no(new Error('no answer in 20 seconds')), 20e3)),
  ]));
  WL = await import(`./lib/wallet.mjs?v=${VERSION}`);
  S = await import(`./lib/state.mjs?v=${VERSION}`);
  V = await import(`./lib/view.mjs?v=${VERSION}`);
  T = await import(`./lib/trust.mjs?v=${VERSION}`);
} catch (e) {
  showFatal(
    `Reef could not load its node code (${e.message}). The CDN (cdn.jsdelivr.net) may be unreachable: check the connection and reload.`,
  );
  throw e;
}
const T0 = Date.now();
$('startup').textContent = fmt(Math.floor(T0 / 1000));
$('i-snapurl').textContent = SNAP_URL;
$('i-blocks').textContent = `${BLOCKS_URL}.dat, mirrored into OPFS`;
for (const k of ['snapshot', 'blocks'])
  if (proposed[k] && !accepted(k) && proposed[k] !== (k === 'snapshot' ? SNAP_URL : BLOCKS_URL))
    banner(
      'src-' + k,
      'warn',
      `This link asks Reef to read the ${k === 'snapshot' ? 'snapshot' : 'blocks'} from ${proposed[k]}. A source you do not trust can show you a chain that is not the real one. It is ignored unless you choose it, for this visit only.`,
      [
        [
          'Use it for this visit',
          () => {
            SS.set('reef:accept:' + k, proposed[k]);
            location.reload();
          },
        ],
        ['Ignore', () => unbanner('src-' + k)],
      ],
    );
if (SNAP_URL !== DEFAULT_SNAP || BLOCKS_URL !== DEFAULT_BLOCKS)
  banner(
    'src',
    'warn',
    `Reef is reading from a source other than the default (${BLOCKS_URL !== DEFAULT_BLOCKS ? BLOCKS_URL : SNAP_URL}). Balances are only as good as that source; the default is restored in Options → Main.`,
  );

// ---- node state, filled by the worker's messages
const tn = createTabNode({ base: NODE, snapshotUrl: SNAP_URL, blocksUrl: BLOCKS_URL, torrent: OPT.torrent, seed: OPT.seed });
const node = tn.node;
const post = (m) => tn.post(m);
let lastPhase = null;
function setSync(msg, pct, eta) {
  $('syncmsg').textContent = msg;
  const phase = node.error ? 'error' : node.synced ? 'synced' : node.phase;
  if (phase !== lastPhase) {
    lastPhase = phase;
    sayOnce(msg);
  }
  document.title = node.error
    ? 'Reef · stopped'
    : node.synced
      ? `Reef · txbt4 · ${n(node.height)}`
      : pct != null
        ? `Reef · ${phase === 'fetch' ? 'fetching' : phase === 'sync' ? 'syncing' : 'checking'} ${pct.toFixed(0)}%`
        : 'Reef · starting';
  const pb = $('pb');
  if (pct == null) {
    pb.hidden = true;
    $('synceta').textContent = '';
  } else {
    pb.hidden = false;
    const v = Math.max(0, Math.min(100, pct));
    $('pbi').style.width = v.toFixed(1) + '%';
    pb.setAttribute('aria-valuenow', v.toFixed(0));
    pb.setAttribute('aria-valuetext', `${v.toFixed(0)}%: ${$('syncmsg').textContent}`);
    $('synceta').textContent = `${pct.toFixed(0)}%${eta ? ' · ' + eta : ''}`;
  }
  renderStatus();
}
function renderHist() {
  $('i-hist').innerHTML =
    node.hist.map(([k, v]) => `<span class="l">${esc(k)}</span><span class="v">${esc(secs(v))}</span>`).join('') +
    `<span class="l" style="font-weight:600">total</span><span class="v">${esc(secs(node.hist.reduce((a, [, v]) => a + v, 0)))}</span>`;
}
function renderInfo() {
  const st = node.st;
  if (st) {
    $('i-datadir').textContent =
      `origin private file system (OPFS), ${st.usage ? mib(st.usage) + ' used' : 'usage unknown'}${st.quota ? ' of ' + (st.quota / 1073741824).toFixed(1) + ' GiB' : ''}`;
    $('i-snapdisk').textContent =
      st.dat < 0
        ? 'absent'
        : st.dat >= st.expect.bytes
          ? `complete, ${mib(st.dat)}`
          : `${mib(st.dat)} of ${mib(st.expect.bytes)}${st.partial ? ' (resumable)' : ''}`;
    $('i-sha').textContent = st.sha
      ? st.sha === st.expect.sha256
        ? st.sha + ' — matches the pinned value'
        : 'MISMATCH ' + st.sha
      : 'not checked yet';
    if (st.idx > 0 && !node.hs) $('i-hs').textContent = `${st.expect.txoutsetHash} — verified on an earlier visit; index ${mib(st.idx)}`;
    if (!node.coins) $('i-coins').textContent = `${n(st.expect.coins)} expected`;
  }
  if (node.hs) $('i-hs').textContent = `${node.hs} — recomputed from the file, ${node.hsOk ? 'matches' : 'MISMATCH'}`;
  if (node.coins) $('i-coins').textContent = `${n(node.coins)} in ${n(node.txids)} txids`;
  $('i-height').textContent = node.height != null ? n(node.height) : '…';
  $('lbt').textContent = fmt(node.time);
  $('i-hash').innerHTML = node.hash
    ? `<a href="${EXPLORER}/block/${esc(node.hash)}" target="_blank" rel="noopener">${esc(node.hash)}</a>`
    : '…';
  $('i-heap').textContent = performance.memory
    ? `${Math.round(performance.memory.usedJSHeapSize / 1048576)} MB heap (page)`
    : 'not exposed by this browser';
  if (node.nostr)
    $('i-nostr').textContent =
      `${n(node.nostr.height)} · ${node.nostr.hash.slice(0, 16)}… · ${node.nostr.relay ?? ''} · ${node.nostr.diverged ? 'DIVERGES from the block file' : node.nostr.agree ? 'agrees with the block file' : 'not yet compared'}${node.nostr.live ? ' · live' : ''}`;
  $('tr-recv').textContent = `${(node.recv / 1e6).toFixed(2)} MB`;
  $('tr-sent').textContent = `${(node.sent / 1e6).toFixed(2)} MB`;
  renderStatus();
}
// how far the chain the tab follows is confirmed by someone other than its block source: a signed tip (NIP-333)
const trust = () =>
  T.trustOf(
    {
      idle: IDLE,
      synced: node.synced,
      nostr: node.nostr,
      time: node.time,
      lastSync: node.lastSync,
      height: node.height,
      error: node.error,
      syncedAt: node.syncedAt,
    },
    Date.now(),
  );
let srcErrSince = null;
// after the tab is up to date, only errors of the network pass by themselves (the node retries every 30 s); anything else —
// a file, a rule, a disagreement with the signed tip — stops and is said as such
const NETWORK =
  /Failed to fetch|NetworkError|network|no data for|no answer in|block index \d|block file \d|short read|Load failed|aborted|timed? ?out|ECONN|50[234]/i;
const srcPassing = () => !!node.error && node.synced && NETWORK.test(node.error) && !/disagree|mismatch/i.test(node.error);
function renderStatus() {
  $('wt').textContent = IDLE ? 'Reef — txbt4 · idle: the node runs in another tab' : 'Reef — txbt4, BLAKE2b testnet4 · a node in this tab';
  const tr = trust();
  const ok = tr.level === 'ok';
  const ico = $('st-sync');
  ico.dataset.s = node.error ? (srcPassing() ? 'warn' : 'bad') : tr.level;
  $('st-btn').setAttribute('aria-label', 'Chain status: ' + (node.error ? 'error: ' + node.error : tr.text));
  ico.setAttribute('aria-label', node.error ? 'error: ' + node.error : tr.text);
  ico.querySelector('title').textContent = node.error ? 'error: ' + node.error : tr.text;
  const nConn = 1 + TIP_RELAYS.length + RELAYS().length;
  const connText = IDLE
    ? 'connections: none in this tab, the node runs in another tab'
    : `connections: 1 block mirror and ${nConn - 1} relays (a tab does not speak the peer-to-peer protocol)`;
  $('st-conn').querySelector('title').textContent = connText;
  $('st-conn').setAttribute('aria-label', connText);
  if (node.synced && !node.error && tr.level === 'bad') banner('trustbad', 'bad', tr.text);
  else unbanner('trustbad');
  if (node.synced && !node.error && tr.level === 'warn') banner('trust', 'warn', tr.text);
  else unbanner('trust');
  // the node that broadcasts payments is judged by its heartbeat (the mirror's mempool file, rewritten every pass), not by
  // how many transactions it relays: a quiet chain is not a dead broadcaster
  const beat = node.mempool?.feedFileAt;
  if (node.synced && beat && Date.now() - beat > 10 * 60e3)
    banner(
      'feed',
      'warn',
      `The txbt4 node that broadcasts payments has not reported since ${new Date(beat).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Payments made now may wait; raising the fee will not help until it is back.`,
    );
  else unbanner('feed');
  // after the tab is up to date, a failed fetch from the block source is retried every 30 s by the node: a warning, not a
  // stop, and no reload (a reload would index the snapshot again for nothing)
  const passing = srcPassing();
  if (passing) {
    srcErrSince ??= node.lastSync ?? Date.now(); // the last time the source did answer
    banner(
      'srcwait',
      'warn',
      `The block source has not answered since ${new Date(srcErrSince).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}; the tab keeps trying every 30 seconds. Balances are as of block ${n(node.height)}.`,
    );
  } else {
    srcErrSince = null;
    unbanner('srcwait');
  }
  // a node that has not answered for a while (often a laptop waking) is a warning that clears itself, not a stop
  if (node.unresponsive)
    banner('unresponsive', 'warn', 'The node has not answered for two minutes. It usually comes back by itself; if it does not, reload.', [
      ['Reload', () => location.reload()],
    ]);
  else unbanner('unresponsive');
  if (node.error && !passing && !node.unresponsive)
    banner('nodeerr', 'bad', plainError(node.error), [
      ['Retry', () => location.reload()],
      ['Wipe and fetch again…', () => wipeAsk()],
    ]);
  else unbanner('nodeerr');
  $('ovtrust').textContent = IDLE ? IDLE_TEXT : W && W.coinsKnown && tr.level !== 'ok' && tr.level !== 'none' ? tr.text : '';
  $('ovtrust').classList.toggle('mut', tr.level === 'none');
  $('ovtrust').classList.toggle('warnt', tr.level !== 'none');
}
// node errors in words a person can act on
function plainError(e) {
  const s = String(e);
  if (/another tab|NoModificationAllowedError|access handle|InvalidStateError/i.test(s))
    return "Another tab of this site is using the node's files (Reef, Bight, Winch or Hitch). Close it and retry.";
  if (/quota|QuotaExceeded|out of space|not enough space/i.test(s))
    return 'The browser refused more storage: Reef needs about 1.1 GB for the snapshot and its index. Free disk space or allow more for this site, then retry.';
  if (/sha256 does not match|MISMATCH|hash_serialized/i.test(s))
    return 'The snapshot on disk is not the one the node expects (damaged or from another source). Wipe it and fetch again.';
  if (/Failed to fetch|NetworkError|network|ERR_|load failed/i.test(s))
    return 'The block source could not be reached. Check the connection; the download resumes where it stopped when you retry.';
  if (/OPFS|getDirectory|createSyncAccessHandle/i.test(s))
    return 'This browser does not offer the private file system Reef needs. Use a current Chrome, Edge, Brave or Firefox.';
  return 'The node stopped: ' + s.slice(0, 160);
}
window.reef = { node, tn, OPT, VERSION };
function onMessage(m) {
  unbanner('slowstart'); // the node spoke
  if (m.type === 'status' || m.type === 'verified') renderInfo();
  else if (m.type === 'synced') {
    node.syncedAt ??= Date.now();
    if (!node.mempoolOn) {
      node.mempoolOn = true;
      const relays = [...new Set([...RELAYS(), ...TIP_RELAYS])];
      tn.followMempool({ relays });
      $('i-conn').textContent = `1 mirror, ${relays.length} relays`;
    }
    renderInfo();
    document.title = `Reef · txbt4 · ${n(m.height)}`;
    if (m.applied || !W?.coinsKnown) askCoins();
    tick();
  } else if (m.type === 'nostr') {
    node.nostr = m;
    renderInfo();
  } else if (m.type === 'mempool') {
    $('i-mp').textContent = `${n(m.count)} (${m.stats.refused} refused, ${m.stats.dropped} dropped since the tab opened)`;
    $('i-mpmem').textContent = `${n(m.bytes)} vB, ${n(m.fees)} sat in fees`;
    if (document.querySelector('#nwtabs [role=tab][aria-selected=true]')?.dataset.t === 'mempool') renderMempool();
    walletMempool();
  } else if (m.type === 'coin') cprint(JSON.stringify(m, null, 2));
  else if (m.type === 'coins') onCoins(m);
  else if (m.type === 'spend' && typeof m.req === 'string' && m.req.startsWith('sent:')) onSpendAnswer(m);
  else if (m.type === 'spend' && typeof m.req === 'string' && m.req.startsWith('recheck:')) {
    if (W && !IDLE) {
      carryOut(S.onRecheck(sent, m.req.slice(8), m, W.height));
      saveSent();
      renderWallet();
    }
  } else if (m.type === 'spend' && typeof m.req === 'string' && m.req.startsWith('rcpt:')) {
    const r = ledger.get(m.req.slice(5));
    if (W && !IDLE && r) {
      if (WL.onReceiptAnswer(ledger, r.txid, m, W.height) === 'removed')
        notify(
          'A received payment went back to waiting',
          `${amtSay(WL.receiptSats(r))} received in block ${n(r.height)} is no longer in a block: the chain was reorganised. A payment like this usually confirms again in a later block; if it does not, ask the sender.`,
          true,
        );
      saveLedger();
      renderWallet();
    }
  } else if (m.type === 'refused') onRefusedTx(m);
  else if (m.type === 'block' && typeof m.req === 'string' && m.req.startsWith('time:')) {
    // a received payment's date: its block's own time
    const r = ledger.get(m.req.slice(5));
    if (r && m.header?.time && !IDLE) {
      r.time = m.header.time * 1000;
      saveLedger();
      renderWallet();
    }
  } else if (m.type === 'block') {
    const b = {
      hash: m.hash,
      confirmations: m.confirmations,
      height: m.height,
      version: m.header.version,
      merkleroot: m.header.merkleRoot ?? m.header.merkleroot,
      time: m.header.time,
      nonce: m.header.nonce,
      bits: typeof m.header.bits === 'number' ? m.header.bits.toString(16) : m.header.bits,
      nTx: m.nTx,
      previousblockhash: m.previousblockhash,
      nextblockhash: m.nextblockhash,
      size: m.size,
      pow: 'BLAKE2b',
      validated_by: 'this tab',
      tx: m.txids,
    };
    cprint(m.req === 'hash' ? `getblockhash ${n(m.height)} → ${m.hash}` : `getblock ${n(m.height)} →\n` + JSON.stringify(b, null, 2));
  }
}

// ---- the window: floating on a large screen, maximized on a small one, movable by its title bar, resizable at every
// edge, zoomed by the green dot or a double-click on the title, geometry remembered; inside Glass (?embedded=1) the host frames it
const win = $('win');
const geom = {
  get: () => {
    try {
      return JSON.parse(LS.get('reef:geometry') ?? 'null');
    } catch {
      return null;
    }
  },
  set: (g) => LS.set('reef:geometry', JSON.stringify(g)),
};
const narrow = () => innerWidth < 760;
function applyGeometry(g) {
  win.style.left = g.x + 'px';
  win.style.top = g.y + 'px';
  win.style.width = g.w + 'px';
  win.style.height = g.h + 'px';
}
function clampGeometry(g) {
  const W = innerWidth,
    H = innerHeight;
  g.w = Math.max(Math.min(720, W), Math.min(g.w, W));
  g.h = Math.max(Math.min(420, H), Math.min(g.h, H));
  g.x = Math.max(0, Math.min(g.x, W - Math.min(g.w, 120)));
  g.y = Math.max(0, Math.min(g.y, H - 40));
  return g;
}
function defaultGeometry() {
  const w = Math.min(1180, innerWidth - 48),
    h = Math.min(780, innerHeight - 48);
  return { x: Math.round((innerWidth - w) / 2), y: Math.round((innerHeight - h) / 2), w, h };
}
function layoutWindow() {
  if (embedded) return;
  const small = innerWidth < 1100 || innerHeight < 700;
  const saved = geom.get();
  const max = narrow() || (saved?.max ?? small);
  win.classList.toggle('max', max);
  if (!max) applyGeometry(clampGeometry(saved?.g ?? defaultGeometry()));
}
function saveGeometry() {
  if (embedded) return;
  const max = win.classList.contains('max');
  const g = max ? (geom.get()?.g ?? defaultGeometry()) : { x: win.offsetLeft, y: win.offsetTop, w: win.offsetWidth, h: win.offsetHeight };
  geom.set({ max, g });
}
function toggleZoom() {
  if (embedded || narrow()) return;
  const max = !win.classList.contains('max');
  win.classList.toggle('max', max);
  if (!max) applyGeometry(clampGeometry(geom.get()?.g ?? defaultGeometry()));
  saveGeometry();
  setTimeout(() => fitNode(), 0);
}
if (!embedded) {
  layoutWindow();
  addEventListener('resize', () => {
    if (narrow()) {
      win.classList.add('max');
      return;
    }
    if (!win.classList.contains('max'))
      applyGeometry(clampGeometry({ x: win.offsetLeft, y: win.offsetTop, w: win.offsetWidth, h: win.offsetHeight }));
  });
  $('dot-zoom').onclick = (e) => {
    e.stopPropagation();
    toggleZoom();
  };
  $('wtitle').ondblclick = (e) => {
    if (!e.target.closest('.dots, .badge')) toggleZoom();
  };
  $('dot-close').onclick = (e) => {
    e.stopPropagation();
    hideWindow();
  };
  $('dot-min').onclick = (e) => {
    e.stopPropagation();
    hideWindow();
  };
  $('wtitle').onpointerdown = (e) => {
    if (win.classList.contains('max') || e.target.closest('.dots, .badge')) return;
    const sx = e.clientX - win.offsetLeft,
      sy = e.clientY - win.offsetTop;
    const move = (ev) => applyGeometry(clampGeometry({ x: ev.clientX - sx, y: ev.clientY - sy, w: win.offsetWidth, h: win.offsetHeight }));
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      saveGeometry();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    e.preventDefault();
  };
  win.querySelectorAll(':scope > .rs').forEach((h) => {
    h.onpointerdown = (e) => {
      if (win.classList.contains('max')) return;
      const d = h.dataset.rs,
        x0 = e.clientX,
        y0 = e.clientY,
        g0 = { x: win.offsetLeft, y: win.offsetTop, w: win.offsetWidth, h: win.offsetHeight };
      const move = (ev) => {
        const dx = ev.clientX - x0,
          dy = ev.clientY - y0;
        const g = { ...g0 };
        if (d.includes('e')) g.w = g0.w + dx;
        if (d.includes('s')) g.h = g0.h + dy;
        if (d.includes('w')) {
          g.w = g0.w - dx;
          g.x = g0.x + dx;
        }
        if (d.includes('n')) {
          g.h = g0.h - dy;
          g.y = g0.y + dy;
        }
        if (g.w < 720) {
          if (d.includes('w')) g.x = g0.x + g0.w - 720;
          g.w = 720;
        }
        if (g.h < 420) {
          if (d.includes('n')) g.y = g0.y + g0.h - 420;
          g.h = 420;
        }
        applyGeometry(g);
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        saveGeometry();
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      e.preventDefault();
      e.stopPropagation();
    };
  });
}

// ---- menus: a menubar a keyboard can drive (Enter or Down opens, arrows move, Escape closes)
const menus = [...document.querySelectorAll('#menu > [data-m]')];
const menuItems = (m) => [...m.querySelectorAll('.dd > [role^=menuitem]')];
function closeMenus(except) {
  for (const m of menus)
    if (m !== except) {
      m.classList.remove('open');
      m.setAttribute('aria-expanded', 'false');
    }
}
// a dialog closed gives focus back to what opened it; a menu item is hidden by then, so to its menu's title; a row button
// re-rendered meanwhile, to the page's toolbar button
{
  const show = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function () {
    const a = document.activeElement;
    this._opener = a?.closest?.('.dd') ? a.closest('.dd').parentElement : a;
    return show.call(this);
  };
  for (const d of document.querySelectorAll('dialog'))
    d.addEventListener('close', () => {
      const o = d._opener;
      d._opener = null;
      if (document.querySelector('dialog[open]')) return;
      setTimeout(() => {
        if (o && o.isConnected && o.offsetParent !== null && o !== document.body) o.focus();
        else document.querySelector('.tool button.on')?.focus();
      }, 0);
    });
}
function openMenu(m, focusFirst = false, last = false) {
  closeMenus(m);
  m.classList.add('open');
  m.setAttribute('aria-expanded', 'true');
  // the first (or last) item, disabled or not: the arrows stop on disabled items too, and they say why
  if (focusFirst)
    menuItems(m)
      .at(last ? -1 : 0)
      ?.focus();
}
for (const it of document.querySelectorAll('.dd [aria-disabled=true]')) {
  const why = it.getAttribute('title');
  if (why) it.setAttribute('aria-description', why);
}
for (const it of document.querySelectorAll('.dd .k')) {
  it.parentElement.setAttribute('aria-keyshortcuts', it.textContent.replace(/\s/g, ''));
  it.setAttribute('aria-hidden', 'true');
}
for (const m of menus) {
  m.onclick = (e) => {
    if (e.target.closest('.dd')) return;
    m.classList.contains('open') ? closeMenus() : openMenu(m);
    e.stopPropagation();
  };
  m.onkeydown = (e) => {
    const items = menuItems(m);
    const i = items.indexOf(document.activeElement);
    const mi = menus.indexOf(m);
    if (e.target === m && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown')) {
      e.preventDefault();
      openMenu(m, true);
    } else if (e.target === m && e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu(m, true, true);
    } else if ((e.key === 'Home' || e.key === 'End') && i >= 0) {
      e.preventDefault();
      items.at(e.key === 'Home' ? 0 : -1).focus();
    } else if (i >= 0 && e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // a letter jumps to the next item starting with it
      const k = e.key.toLowerCase();
      const order = [...items.slice(i + 1), ...items.slice(0, i + 1)];
      order.find((x) => x.textContent.trim().toLowerCase().startsWith(k))?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMenus();
      m.focus();
    } else if (e.key === 'ArrowDown' && i >= 0) {
      e.preventDefault();
      items[(i + 1) % items.length].focus();
    } else if (e.key === 'ArrowUp' && i >= 0) {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length].focus();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = menus[(mi + (e.key === 'ArrowRight' ? 1 : -1) + menus.length) % menus.length];
      next.focus();
      if (m.classList.contains('open')) openMenu(next, true);
    } else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) {
      e.preventDefault();
      items[i].click();
    }
  };
  for (const it of menuItems(m))
    it.addEventListener('click', (e) => {
      if (it.getAttribute('aria-disabled') === 'true') {
        e.stopImmediatePropagation();
        return;
      }
      closeMenus();
    });
}
document.addEventListener('click', () => closeMenus());
$('menu').addEventListener('focusout', (e) => {
  if (!$('menu').contains(e.relatedTarget)) closeMenus();
});
menus.forEach((m, i) => {
  m.tabIndex = i ? -1 : 0;
  m.addEventListener('focus', () =>
    menus.forEach((x) => {
      x.tabIndex = x === m ? 0 : -1;
    }),
  );
});
// tabs (the node window, Options): role=tab, arrows move, Enter or Space selects
function tabs(listId, onSelect, panelPrefix) {
  const list = $(listId);
  const all = [...list.querySelectorAll('[role=tab]')];
  const select = (t, via = 'click') => {
    for (const x of all) {
      const on = x === t;
      x.setAttribute('aria-selected', String(on));
      x.tabIndex = on ? 0 : -1;
      x.classList.toggle('on', on);
    }
    onSelect(t, via);
  };
  for (const t of all) {
    const name = t.dataset.t ?? t.dataset.o;
    t.id ||= `${listId}-${name}`;
    const panel = $(panelPrefix + name);
    if (panel) {
      panel.setAttribute('role', 'tabpanel');
      panel.tabIndex = 0; // a panel taller than its window scrolls with the keyboard
      panel.setAttribute('aria-labelledby', t.id);
      t.setAttribute('aria-controls', panel.id);
    }
    t.onclick = () => select(t);
    t.onkeydown = (e) => {
      const i = all.indexOf(t);
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const nx =
          e.key === 'Home' ? all[0] : e.key === 'End' ? all.at(-1) : all[(i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length];
        nx.focus();
        select(nx, 'key');
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select(t, 'enter');
      }
    };
  }
  return (name) => select(all.find((t) => (t.dataset.t ?? t.dataset.o) === name) ?? all[0]);
}
const nwTab = tabs(
  'nwtabs',
  (t, via) => {
    document.querySelectorAll('.tp').forEach((p) => p.classList.toggle('on', p.id === 't-' + t.dataset.t));
    if (t.dataset.t === 'traffic') drawTraffic();
    if (t.dataset.t === 'console' && via !== 'key') $('cin').focus();
    if (t.dataset.t === 'peers') renderPeers();
    if (t.dataset.t === 'mempool') renderMempool();
  },
  't-',
);
const optTab = tabs(
  'otabs',
  (t) => document.querySelectorAll('.op').forEach((p) => p.classList.toggle('on', p.id === 'o-' + t.dataset.o)),
  'o-',
);
// the toolbar pages
function showPage(p) {
  document.querySelectorAll('.tool button[data-p]').forEach((x) => {
    const on = x.dataset.p === p;
    x.classList.toggle('on', on);
    if (on) x.setAttribute('aria-current', 'page');
    else x.removeAttribute('aria-current');
  });
  document.querySelectorAll('.page').forEach((pg) => pg.classList.toggle('on', pg.id === 'p-' + p));
}
const toolBtns = [...document.querySelectorAll('.tool button[data-p]')];
toolBtns.forEach((b, i) => {
  b.tabIndex = i ? -1 : 0;
  b.addEventListener('focus', () =>
    toolBtns.forEach((x) => {
      x.tabIndex = x === b ? 0 : -1;
    }),
  );
  b.onclick = () => showPage(b.dataset.p);
  b.onkeydown = (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const nx = toolBtns[(i + (e.key === 'ArrowRight' ? 1 : -1) + toolBtns.length) % toolBtns.length];
      nx.focus();
      showPage(nx.dataset.p);
    }
  };
});
document.querySelectorAll('[data-go]').forEach((a) => {
  a.onclick = (e) => {
    e.preventDefault();
    showPage(a.dataset.go);
  };
});
// the node window
let nodeOpener = null;
const behind = () => [...win.children].filter((c) => c.id !== 'nw' && !c.classList.contains('rs'));
// the node window stays inside the main window, whose edges clip it: moved in, then shrunk if it still does not fit
const fitNode = () => {
  const nw = $('nw');
  if (narrow() || !nw.classList.contains('open')) return;
  const W0 = win.clientWidth,
    H0 = win.clientHeight;
  if (nw.offsetLeft + nw.offsetWidth > W0) nw.style.left = Math.max(0, W0 - nw.offsetWidth - 2) + 'px';
  if (nw.offsetTop + nw.offsetHeight > H0) nw.style.top = Math.max(0, H0 - nw.offsetHeight - 2) + 'px';
  if (nw.offsetWidth > W0 - 2) nw.style.width = W0 - 2 + 'px';
  if (nw.offsetHeight > H0 - 2) nw.style.height = H0 - 2 + 'px';
};
addEventListener('resize', fitNode);
const openNode = () => {
  if (win.style.display === 'none') showWindow(); // from the tray: the window comes back first
  // modal at every width: Tab stays in it, so what it covers is inert too (a reader's cursor no longer wanders under it)
  behind().forEach((c) => {
    c.inert = true;
  });
  nodeOpener = document.activeElement?.closest?.('.dd') ? document.querySelector('#menu > [data-m=window]') : document.activeElement;
  $('nw').classList.add('open');
  fitNode();
  $('nw').querySelector('[role=tab][aria-selected=true]')?.focus();
};
const closeNode = () => {
  if (!$('nw').classList.contains('open')) return;
  $('nw').classList.remove('open');
  behind().forEach((c) => {
    c.inert = false;
  });
  (nodeOpener && nodeOpener !== document.body && document.contains(nodeOpener)
    ? nodeOpener
    : toolBtns.find((b) => b.classList.contains('on'))
  )?.focus?.();
};
$('m-node').onclick = openNode;
$('nwclose').onclick = closeNode;
$('nw').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeNode();
  // Tab stays in the node window, as in a separate window: the page underneath is covered by it
  if (e.key === 'Tab') {
    const f = [...$('nw').querySelectorAll('button, [href], input, select, textarea, [tabindex="0"]')].filter(
      (x) => !x.disabled && x.offsetParent !== null,
    );
    if (!f.length) return;
    if (!e.shiftKey && document.activeElement === f.at(-1)) {
      e.preventDefault();
      f[0].focus();
    } else if (e.shiftKey && document.activeElement === f[0]) {
      e.preventDefault();
      f.at(-1).focus();
    }
  }
});
(() => {
  const nw = $('nw'),
    t = $('nwt');
  try {
    const g = JSON.parse(LS.get('reef:node-geometry') ?? 'null');
    if (g && !narrow()) {
      nw.style.left = g.x + 'px';
      nw.style.top = g.y + 'px';
      nw.style.width = g.w + 'px';
      nw.style.height = g.h + 'px';
    }
  } catch {}
  const save = () =>
    LS.set('reef:node-geometry', JSON.stringify({ x: nw.offsetLeft, y: nw.offsetTop, w: nw.offsetWidth, h: nw.offsetHeight }));
  t.onpointerdown = (e) => {
    if (e.target.closest('button') || narrow()) return;
    const sx = e.clientX - nw.offsetLeft,
      sy = e.clientY - nw.offsetTop;
    const move = (ev) => {
      // inside the main window, whose edges clip it
      nw.style.left = Math.max(0, Math.min(ev.clientX - sx, win.clientWidth - nw.offsetWidth - 2)) + 'px';
      nw.style.top = Math.max(0, Math.min(ev.clientY - sy, win.clientHeight - nw.offsetHeight - 2)) + 'px';
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      save();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    e.preventDefault();
  };
  nw.querySelector('.rs.se').onpointerdown = (e) => {
    const x0 = e.clientX,
      y0 = e.clientY,
      w0 = nw.offsetWidth,
      h0 = nw.offsetHeight;
    const move = (ev) => {
      nw.style.width = Math.max(560, Math.min(w0 + ev.clientX - x0, win.clientWidth - nw.offsetLeft - 2)) + 'px';
      nw.style.height = Math.max(320, Math.min(h0 + ev.clientY - y0, win.clientHeight - nw.offsetTop - 2)) + 'px';
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      save();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    e.preventDefault();
    e.stopPropagation();
  };
})();
document.querySelector('a.skip')?.addEventListener('click', (e) => {
  e.preventDefault();
  const pg = document.querySelector('.page.on');
  pg.tabIndex = -1;
  pg.focus();
});
$('st-btn').onclick = () => {
  const tr = trust();
  notify('Chain status', node.error ? plainError(node.error) : tr.text, tr.level === 'bad');
};
$('m-readme').onclick = () => window.open(REPO + '#readme', '_blank', 'noopener');
$('m-source').onclick = () => window.open(REPO, '_blank', 'noopener');
$('m-issue').onclick = () => window.open(REPO + '/issues/new', '_blank', 'noopener');
$('about-src').href = REPO;
$('about-issues').href = REPO + '/issues';
$('about-ok').onclick = () => $('about').close();
$('m-about').onclick = () => {
  $('about-pins').textContent =
    `Reef ${VERSION} · node blaketestnode@${NODE.slice(-40, -33)} · lib sidestr/spec@${LIB.match(/@([0-9a-f]{7})/)[1]} · engine schema@${CDN.slice(-40, -33)}` +
    (node.height != null ? ` · height ${n(node.height)}` : '');
  $('about').showModal();
};
$('m-mask').onclick = () => {
  OPT.mask = !OPT.mask;
  saveOptions();
  applyDisplay();
  sayOnce(OPT.mask ? 'Amounts hidden' : 'Amounts shown');
};
$('m-exit').onclick = () => hideWindow();
$('m-min').onclick = () => hideWindow();
$('m-zoom').onclick = () => toggleZoom();
$('m-main').onclick = () => {
  showWindow();
  closeNode();
};
$('m-backup').onclick = () => openBackup();
$('m-diag').onclick = () => copyDiagnostics();
// ---- the tray: closing or minimizing the window keeps the node running while the tab is open, and leaves a small card to come back through; inside Glass the host is told and keeps its dock
let unseen = 0;
function hideWindow() {
  if (embedded) {
    try {
      parent.postMessage({ source: 'reef', type: 'minimize' }, '*');
    } catch {}
    return;
  }
  win.style.display = 'none';
  document.querySelector('.skip')?.setAttribute('hidden', '');
  unseen = 0;
  $('tray-badge').hidden = true;
  $('tray').hidden = false;
  trayRefresh();
  $('tray').focus();
}
function showWindow() {
  win.style.display = '';
  document.querySelector('.skip')?.removeAttribute('hidden');
  $('tray').hidden = true;
  unseen = 0;
  $('tray-badge').hidden = true;
  document.querySelector('.tool button.on')?.focus();
}
function trayRefresh() {
  if ($('tray').hidden) return;
  const sd = tn.seeding?.t ? ` · seeding to ${tn.seeding.t.wires.filter((w) => !w.destroyed && w.type !== 'webSeed').length}` : '';
  $('tray-l').textContent = IDLE
    ? 'idle: the node runs in another tab'
    : node.error
      ? 'stopped: open for details'
      : node.synced
        ? `up to date · ${n(node.height)}${sd}`
        : node.phase === 'fetch'
          ? 'fetching the snapshot'
          : node.phase === 'hash'
            ? 'checking the snapshot'
            : node.phase === 'verify'
              ? 'verifying the snapshot'
              : node.phase === 'sync'
                ? `syncing · ${n(node.height ?? 0)}`
                : 'starting';
  $('tray-dot').className = IDLE ? 'idle' : node.error ? (srcPassing() ? 'sync' : 'bad') : node.synced ? 'ok' : 'sync';
}
$('tray').onclick = () => showWindow();
setInterval(trayRefresh, 1000);
document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  // Alt+Shift: Ctrl+Shift+D (bookmark all tabs) and Ctrl+Shift+M (the profile menu) belong to the browser
  const typing = e.target?.matches?.('input, textarea, select, [contenteditable]');
  if (document.querySelector('dialog[open]')) return; // a dialog has the keyboard: no window shortcuts behind it
  if (e.altKey && e.shiftKey && !e.ctrlKey && !typing && (e.code === 'KeyM' || k === 'm')) {
    e.preventDefault();
    $('m-mask').onclick();
  } else if (e.ctrlKey && !e.shiftKey && !typing && k === 'm') {
    // one key, both ways: to the tray when the window shows, back from it when it does not
    e.preventDefault();
    win.style.display === 'none' ? $('m-main').onclick() : hideWindow();
  } else if (e.altKey && e.shiftKey && !e.ctrlKey && !typing && (e.code === 'KeyN' || k === 'n')) {
    e.preventDefault();
    $('nw').classList.contains('open') ? closeNode() : openNode();
  }
});

// ---- a question in the page (never a browser dialog): resolves true on the confirming button
// third: an optional third button { label, value, focus } (a choice that is neither yes nor no, like "Keep waiting")
function ask(title, lines, okLabel = 'OK', danger = false, cancelLabel = 'Cancel', escNull = false, focusOk = false, third = null) {
  return new Promise((resolve) => {
    $('ask-cancel').textContent = cancelLabel;
    $('ask-third').hidden = !third;
    $('ask-third').textContent = third?.label ?? '';
    const d = $('ask');
    $('ask-t').textContent = title;
    const b = $('ask-b');
    b.textContent = '';
    for (const l of lines) {
      if (l instanceof Node) {
        b.appendChild(l);
        continue;
      }
      const p = document.createElement('p');
      p.textContent = l;
      b.appendChild(p);
    }
    const ok = $('ask-ok');
    ok.disabled = false;
    ok.textContent = okLabel;
    ok.classList.toggle('danger', danger);
    const done = (v) => {
      ok.onclick = null;
      $('ask-cancel').onclick = null;
      $('ask-third').onclick = null;
      d.onclose = null;
      d.close();
      resolve(v);
    };
    ok.onclick = () => done(true);
    $('ask-cancel').onclick = () => done(false);
    if (third) $('ask-third').onclick = () => done(third.value);
    d.onclose = () => resolve(escNull ? null : false);
    d.showModal();
    (third?.focus ? $('ask-third') : focusOk ? ok : $('ask-cancel')).focus();
  });
}
async function wipeAsk() {
  if (IDLE) return notify('Not here', 'the node runs in another tab: wipe from there', true);
  if (
    await ask(
      'Wipe the snapshot',
      [
        "This removes the snapshot and its index from this browser's storage (about 1.1 GB). The next start fetches the 830 MB snapshot again: a few minutes on a fast connection, longer on a slow one.",
        'The wallet key is not touched.',
      ],
      'Wipe',
      true,
    )
  ) {
    // reload only once the node says its files are gone; a node that does not answer is said, not reloaded over
    setSync('wiping the snapshot…', null);
    try {
      const r = await tn.wipe();
      if (r?.failed?.length)
        notify(
          'Not all removed',
          `${r.failed.length} file(s) could not be removed; they will be replaced as the snapshot is fetched again`,
          true,
        );
      location.reload();
    } catch (e) {
      notify('Not wiped', `${e.message}. Close other tabs of this site and try again.`, true);
    }
  }
}
$('m-wipe').onclick = () => wipeAsk();

// ---- Options: one dialog, four tabs, values kept in reef:options (the snapshot and blocks URLs keep their own keys)
// a rate from the tab's mempool only when enough is waiting to mean something, and capped: two odd transactions are not a market
const suggestedRate = () => {
  const mr = mempoolRate();
  return mr != null && (node.mempool?.count ?? 0) >= 10 ? Math.min(Math.max(1, Math.round(mr)), 50) : null;
};
function fillOptions(
  o = OPT,
  urls = { snapshot: LS.get('reef:snapshot') ?? DEFAULT_SNAP, blocks: LS.get('reef:blocks') ?? DEFAULT_BLOCKS },
) {
  $('o-snapshot').value = urls.snapshot;
  $('o-blocks').value = urls.blocks;
  $('o-feerate').value = o.feeRate;
  $('o-notify').checked = !!o.notify;
  $('o-torrent').checked = !!o.torrent;
  const mr = suggestedRate();
  $('o-feeuse').style.display = mr != null ? '' : 'none';
  $('o-feesugg').textContent =
    mr != null
      ? `the tab's mempool: ${node.mempool.count} transactions waiting, a middle rate of ${mr} sat/vB`
      : '1 sat/vB is what txbt4 blocks take today (too few waiting transactions to suggest more)';
  $('o-seed').checked = !!o.seed;
  // seeding needs two readers on the snapshot file at once, which only some browsers allow
  tn.seedSupported?.()
    .then((yes) => {
      if (yes === false) {
        $('o-seed').checked = false;
        $('o-seed').disabled = true;
        $('o-seednote').textContent = 'this browser cannot share the snapshot while the node reads it, so it cannot seed';
      }
    })
    .catch(() => {});
  $('o-seednote').textContent = tn.seeding?.t
    ? `seeding now: ${tn.seeding.t.wires.filter((w) => !w.destroyed).length} peer(s), ${mib(tn.seeding.t.uploaded)} uploaded`
    : fileReady()
      ? 'the snapshot is here; turn this on to serve it'
      : 'starts once the snapshot is here and checked';
  $('o-relays').value = (o.relays ?? DEFAULT_RELAYS).join('\n');
  $('o-unit').value = o.unit;
  $('o-mask').checked = !!o.mask;
  $('o-mirror').textContent = urls.blocks + '.dat';
  $('o-address').value = W?.address ?? '…';
  if (W) renderOldKeys();
  $('o-importkey').value = '';
  delete $('o-importkey').dataset.use;
  $('o-err').textContent = '';
  $('o-keywarn').textContent = '';
  $('o-geomnote').textContent = '';
  $('o-backedup').textContent = W
    ? backedUp()
      ? `backed up on ${new Date(Number(LS.get(backupKey()))).toLocaleDateString()}`
      : 'NOT backed up yet'
    : '…';
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  $('o-perm').textContent =
    perm === 'granted'
      ? 'the browser allows notifications from this page'
      : perm === 'denied'
        ? 'the browser has blocked notifications from this page; change that in the site settings'
        : perm === 'default'
          ? 'the browser has not been asked yet'
          : 'this browser has no notifications';
  $('o-allow').style.display = perm === 'default' ? '' : 'none';
  const lp = loadJSON('reef:lastpublish', null) ?? o.lastPublish;
  $('o-relaylast').textContent = lp
    ? Object.entries(lp.results)
        .map(([u, r]) => `${u.replace('wss://', '')} ${r === 'ok' ? 'ok' : 'failed'}`)
        .join(', ') + ` (${fmt(Math.floor(lp.at / 1000))})`
    : 'none yet';
  navigator.storage
    ?.estimate?.()
    .then((e) => {
      $('o-storage').textContent = `${mib(e.usage ?? 0)} in use of ${mib(e.quota ?? 0)} the browser allows`;
    })
    .catch(() => {
      $('o-storage').textContent = 'unknown';
    });
  navigator.storage
    ?.persisted?.()
    .then((p) => {
      $('o-persist').textContent = p
        ? 'persistent: the browser will not evict it under pressure'
        : 'best effort: the browser may evict it when disk is short; back up the key';
    })
    .catch(() => {
      $('o-persist').textContent = 'unknown';
    });
}
function openOptions(tab = 'main') {
  fillOptions();
  $('options').classList.toggle('idle', IDLE);
  $('o-idlenote').hidden = !IDLE;
  for (const el of $('options').querySelectorAll(
    '#o-main input, #o-main button, #o-wallet input, #o-wallet textarea, #o-wallet button, #o-network input, #o-network textarea',
  ))
    el.disabled = IDLE;
  optTab(tab);
  $('options').showModal();
  $('otabs').querySelector('[aria-selected=true]')?.focus();
  $('o-reset').disabled = IDLE;
}
$('m-options').onclick = () => openOptions();
$('o-cancel').onclick = () => $('options').close();
$('o-reset').onclick = () => fillOptions(OPT_DEFAULTS, { snapshot: DEFAULT_SNAP, blocks: DEFAULT_BLOCKS });
$('o-feeuse').onclick = () => {
  const r = suggestedRate();
  if (r != null) $('o-feerate').value = r;
};
$('o-allow').onclick = () => {
  Notification.requestPermission().then(() => fillOptions());
};
$('o-backup').onclick = () => {
  $('options').close();
  openBackup();
};
$('o-newkey').onclick = () => {
  if (!W) return;
  $('o-importkey').value = W.signer.randomKey();
  $('o-importkey').dataset.generated = '1'; // made here, so not a restored backup
  $('o-keywarn').textContent = 'a new key: press OK to use it in this tab';
};
const keyProblem = (v) =>
  /^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(v)
    ? 'that is a MAINNET key (it starts with K, L or 5): never paste a real key into a test wallet'
    : !WL.parseKey(v, W.hash.sha256)
      ? 'not a key: 64 hex characters, or a WIF starting with c'
      : null;
$('o-importkey').oninput = () => {
  delete $('o-importkey').dataset.use;
  delete $('o-importkey').dataset.generated;
  if (!W) return;
  const v = $('o-importkey').value.trim();
  $('o-keywarn').textContent = v ? (keyProblem(v) ?? 'press OK to switch to this key') : '';
};
$('o-wipe').onclick = () => {
  $('options').close();
  wipeAsk();
};
$('o-resetgeom').onclick = () => {
  LS.del('reef:geometry');
  LS.del('reef:node-geometry');
  $('o-geomnote').textContent = 'reset; takes effect on reload';
};
$('o-ok').onclick = async () => {
  // an earlier key chosen with "Use it again" is held aside, never shown in the field
  const raw = $('o-importkey').value.trim() || $('o-importkey').dataset.use || '';
  // a never-used key made here can be replaced without the node (restoring a backup after "Not now"); otherwise only where
  // the wallet runs
  const unusedHere = !!LS.get('reef:keynew') && !ledger.size && !sent.length;
  if (raw && (IDLE || PROBING || !W || (!RUNNING && !unusedHere))) {
    optTab('wallet');
    $('o-keywarn').textContent =
      !RUNNING && !IDLE
        ? 'start the node in this tab first: keys are switched only where the wallet runs'
        : 'the wallet runs in another tab: switch keys there';
    return;
  }
  const key = raw && !keyProblem(raw) ? WL.parseKey(raw, W.hash.sha256) : null;
  if (raw && !key) {
    optTab('wallet');
    $('o-keywarn').textContent = keyProblem(raw);
    return;
  }
  if (key) {
    let pubOk = false;
    try {
      pubOk = /^[0-9a-f]{64}$/.test(W.signer.pubkeyOf(key));
    } catch {}
    if (!pubOk) {
      optTab('wallet');
      $('o-keywarn').textContent = 'that number is not a valid private key';
      return;
    }
  }
  const lines = $('o-relays')
    .value.split(/\s+/)
    .map((r) => r.trim())
    .filter(Boolean);
  const relays = lines.filter((r) => /^wss:\/\/[^\s<>"]+$/.test(r));
  const notRelays = lines.filter((r) => !relays.includes(r));
  if (notRelays.length) {
    optTab('network');
    $('o-relays').focus();
    $('o-err').textContent =
      `Not a relay address (each must start with wss://): ${notRelays.slice(0, 3).join(', ')}${notRelays.length > 3 ? '…' : ''}`;
    return;
  }
  const rate = Number($('o-feerate').value);
  if (!(Number.isInteger(rate) && rate >= 1 && rate <= WL.MAX_RATE)) {
    optTab('wallet');
    $('o-feerate').focus();
    $('o-err').textContent = `The fee rate must be a whole number from 1 to ${WL.MAX_RATE} sat/vB.`;
    return;
  }
  if (key && key !== W.key) {
    const waiting = [
      ...sent.filter((s) => s.pending && !s.abandoned),
      ...loadJSON('reef:quarantine:' + scriptTag(), []).filter((q) => q.pending && !q.released),
    ];
    const forgotten = sent.filter((s) => s.pending && s.abandoned);
    if (waiting.length) {
      optTab('wallet');
      $('o-keywarn').textContent =
        `${waiting.length} payment${waiting.length === 1 ? ' is' : 's are'} still waiting with this key; switching would stop following ${waiting.length === 1 ? 'it' : 'them'}. Wait until confirmed, or cancel or forget ${waiting.length === 1 ? 'it' : 'them'} first.`;
      return;
    }
    // a key this browser made and never used can be replaced at once (restoring a backup in a new browser); any other key
    // only once the tab knows what it holds
    const fresh = !!LS.get('reef:keynew') && !ledger.size && !sent.length && !(W.coins ?? []).length;
    if (!W.coinsKnown && !fresh) {
      optTab('wallet');
      $('o-keywarn').textContent = 'Wait until the tab is up to date before switching: Reef does not know yet what the current key holds.';
      return;
    }
    const b = fresh && !W.coinsKnown ? 0 : WL.balances({ coins: W.coins, sent, height: W.height }).total;
    const restoring = !$('o-importkey').dataset.generated && !$('o-importkey').dataset.use;
    $('options').close();
    const ok = await ask(
      'Switch to another key',
      [
        `This tab will use the new key from now on. The current key, which ${b ? `holds ${exact(b)}` : 'holds no coins this tab can see (coins from before block 150,307 are not shown)'}, stays in this browser's list of earlier keys (Options → Wallet), but this browser is not a backup.`,
        fresh
          ? 'The current key was made in this browser and has never been used.'
          : backedUp()
            ? 'The current key is backed up.'
            : 'The current key is NOT backed up. Back it up first unless it is empty.',
        'Coins sent to a key before the snapshot at block 150,307 are not shown by a tab.',
        ...(forgotten.length
          ? [
              `${forgotten.length} forgotten payment(s) may still be mined, and after the switch nothing spends their coins first. To settle one, pay yourself from this key before switching.`,
            ]
          : []),
        ...(hitchHeld().size ? ["Hitch holds some of this key's coins for a channel funding; Hitch keeps following them."] : []),
      ],
      'Switch',
      !backedUp() && !fresh,
    );
    if (!ok) return;
    const old = (() => {
      try {
        return JSON.parse(LS.get('reef:oldkeys') ?? '[]');
      } catch {
        return [];
      }
    })();
    if (!old.some((x) => x.key === W.key)) old.push({ key: W.key, address: W.address, at: Date.now() });
    // the current key is replaced only once its copy in the earlier keys is stored and reads back
    const kept = JSON.stringify(old.filter((x) => x.key !== key));
    if (!LS.set('reef:oldkeys', kept) || LS.get('reef:oldkeys') !== kept || !LS.set('reef:key', key)) {
      notify(
        'Not switched',
        'this browser refused to save the earlier key (storage full or blocked); the current key stays in use. Free storage, back up the key and try again.',
        true,
      );
      return;
    }
    // a key pasted in came from a backup kept outside this browser: it is not "not backed up"
    if (restoring) LS.set('reef:backup:' + W.signer.pubkeyOf(key).slice(0, 16), String(Date.now()));
    LS.del('reef:keynew');
    location.search = keepQuery();
    return;
  }
  if (IDLE) {
    const stored = (() => {
      try {
        return JSON.parse(LS.get('reef:options') ?? '{}');
      } catch {
        return {};
      }
    })();
    Object.assign(OPT, stored, { unit: $('o-unit').value, mask: $('o-mask').checked });
    LS.set('reef:options', JSON.stringify({ ...stored, unit: OPT.unit, mask: OPT.mask }));
    $('options').close();
    applyDisplay();
    return;
  }
  OPT.feeRate = rate;
  const turnedOn = !OPT.notify && $('o-notify').checked;
  OPT.notify = $('o-notify').checked;
  OPT.torrent = $('o-torrent').checked;
  OPT.seed = $('o-seed').checked;
  tn.setTorrent(OPT.torrent);
  tn.setSeed(OPT.seed);
  OPT.relays = relays.length ? relays : DEFAULT_RELAYS;
  OPT.unit = $('o-unit').value;
  OPT.mask = $('o-mask').checked;
  saveOptions();
  if (turnedOn && 'Notification' in window && Notification.permission === 'default') {
    LS.set('reef:notifyasked', '1');
    Notification.requestPermission().catch(() => {});
  }
  const snap = $('o-snapshot').value.trim() || DEFAULT_SNAP,
    blocks = $('o-blocks').value.trim() || DEFAULT_BLOCKS;
  const urlsChanged = snap !== (LS.get('reef:snapshot') ?? DEFAULT_SNAP) || blocks !== (LS.get('reef:blocks') ?? DEFAULT_BLOCKS);
  if (urlsChanged) {
    if (!/^https:\/\//.test(snap) || !/^https:\/\//.test(blocks)) {
      optTab('main');
      $('o-err').textContent = 'Only https:// addresses can be used for the snapshot and the blocks.';
      return;
    }
    if (snap === DEFAULT_SNAP) LS.del('reef:snapshot');
    else LS.set('reef:snapshot', snap);
    if (blocks === DEFAULT_BLOCKS) LS.del('reef:blocks');
    else LS.set('reef:blocks', blocks);
  }
  $('options').close();
  if (urlsChanged) {
    location.search = keepQuery();
    return;
  }
  if (!$('sendamt').value.trim()) $('sendunit').value = OPT.unit;
  applyDisplay();
  renderPeers();
  updatePreview();
};

// ---- the wallet: one key kept in this tab; coins from the tab's own UTXO set (created since the snapshot); payments
// built, signed and checked here, then published for a sidestr producer's node to broadcast. The records of payments are
// lib/state.mjs (merge, confirm, replace, republish, forget), tested; this section carries out what it decides.
let IDLE_TEXT = 'The balance is shown in the tab that runs the node.';
let W = null,
  sent = [],
  seen = new Map(),
  ledger = new Map(),
  mpSeen = new Set(),
  sending = false,
  IDLE = false,
  PROBING = true,
  RUNNING = false;
const asked = new Set();
const canAct = () => !IDLE && !PROBING && W && W.coinsKnown; // the tab that runs the node is the only one that changes the wallet
const scriptTag = () => W.script.slice(4, 20);
// a stored value of the wrong shape (an object where a list belongs) would stop the wallet on every load: it is moved aside
// to reef:corrupt:<key> (kept, not lost) and the default used
const loadJSON = (k, d) => {
  const raw = LS.get(k);
  let v = null;
  try {
    v = JSON.parse(raw ?? 'null');
  } catch {}
  if (v == null) {
    if (raw != null) LS.set('reef:corrupt:' + k, raw);
    return d;
  }
  if (Array.isArray(d) !== Array.isArray(v) || typeof v !== typeof d) {
    LS.set('reef:corrupt:' + k, raw);
    return d;
  }
  return v;
};
const writable = () => !IDLE && RUNNING && !(Number(LS.get('reef:schema') ?? 0) > SCHEMA); // the running tab, not overtaken by a newer Reef
const sentKey = () => 'reef:sent:' + scriptTag(),
  seenKey = () => 'reef:seen:' + scriptTag(),
  ledgerKey = () => 'reef:ledger:' + scriptTag(),
  backupKey = () => 'reef:backup:' + W.pub.slice(0, 16);
const backedUp = () => !!(W && LS.get(backupKey()));
const saveFailed = () =>
  banner(
    'savefail',
    'bad',
    "This browser refused to save the wallet's records (storage full or blocked). A payment made now might be forgotten on reload: free storage before sending.",
  );
const store = (k, v) => {
  if (!LS.set(k, v)) {
    saveFailed();
    return false;
  }
  unbanner('savefail');
  return true;
};
// two tabs of the same origin share the storage but not their memory: merge with what is stored, field by field, before writing
let quarantined = new Set(),
  quarantineRecs = [],
  pendingSort = null;
const saveSent = () => {
  if (!writable()) return false; // an idle tab, or a newer Reef has taken over the records since this tab started
  const qk0 = 'reef:quarantine:' + scriptTag();
  const qStored = loadJSON(qk0, []);
  const missing = quarantineRecs.filter((x) => quarantined.has(x.txid) && !qStored.some((y) => y.txid === x.txid));
  if (missing.length && !store(qk0, JSON.stringify([...qStored, ...missing].slice(-500)))) return false; // set aside before dropping, or not at all
  // what another tab stored is sorted by the same rule as at startup (lib/state.mjs sortStored): a record that fails it is
  // set aside, written there before it is left out of the records, and its coins stay held
  const stored = loadJSON(sentKey(), []).filter((x) => !quarantined.has(x.txid));
  const sorted = W.validRecord
    ? S.sortStored({ sent: stored, ok: W.validRecord, seenHas: (k) => seen.has(k) })
    : { keep: stored, quarantine: [] };
  const failing = sorted.quarantine;
  if (failing.length) {
    const q = loadJSON(qk0, []);
    const next = [...q, ...failing.filter((x) => !q.some((y) => y.txid === x.txid))].slice(-500);
    if (!store(qk0, JSON.stringify(next))) return false;
    for (const x of failing) quarantined.add(x.txid);
    quarantineRecs = [...quarantineRecs, ...failing];
  }
  sent = S.trimSent(S.mergeSent(sent, sorted.keep), 300, 1000);
  return store(sentKey(), JSON.stringify(S.forStorage(sent)));
};
const saveSeen = () => {
  if (!writable()) return;
  for (const [k, v] of loadJSON(seenKey(), [])) if (!seen.has(k)) seen.set(k, v);
  const need = new Set([...W.coins.map((c) => c.key), ...sent.filter((s) => s.pending).flatMap((s) => s.inputs ?? [])]);
  const all = [...seen];
  const keep = all.filter(([k]) => need.has(k)).concat(all.filter(([k]) => !need.has(k)).slice(-3000));
  store(seenKey(), JSON.stringify(keep));
};
const saveLedger = () => {
  if (writable()) store(ledgerKey(), JSON.stringify([...ledger.values()].slice(-2000)));
};
const unit = () => ({ key: OPT.unit, ...WL.UNITS[OPT.unit] });
const money = (sats) => (OPT.mask ? '•••••' : WL.formatAmount(sats, OPT.unit)); // where shown as HTML, maskedHtml says "hidden" to a reader
const amt = (sats) => `${money(sats)} ${unit().label}`;
const when = (ms) =>
  new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const amtSay = (sats) => (OPT.mask ? 'amount hidden' : amt(sats)); // what a screen reader hears for an amount
const say = (text) => String(text ?? '').replace(/(\d+) sat\b(?!\/)/g, (_, v) => amtSay(Number(v))); // "N sat" from the libraries, in the person's unit
const HIDDEN = '<span aria-hidden="true">•••••</span><span class="sr">amount hidden</span>';
const moneyHtml = (sats) => (OPT.mask ? HIDDEN : esc(WL.formatAmount(sats, OPT.unit)));
const amtHtml = (sats) => (OPT.mask ? HIDDEN + ' ' + esc(unit().label) : esc(amt(sats)));
const exact = (sats) => `${WL.formatAmount(sats, OPT.unit)} ${unit().label}`; // what a person confirms is never masked
// in the tab's mempool *from a node* (the estate's feed), not merely echoed back by a relay: only that says a node has it
const inMempool = (txid) => !!node.mempool?.txs.some((t) => t.txid === txid && (t.fed ?? true));
function applyDisplay() {
  document.querySelectorAll('.unit').forEach((e) => {
    e.textContent = unit().label;
  });
  $('m-mask-tick').textContent = OPT.mask ? '✓' : '';
  $('m-mask').setAttribute('aria-checked', String(!!OPT.mask));
  const rate = Math.max(1, Number(OPT.feeRate) || 1);
  // in money first: a typical payment (one coin in, payment and change out) is about 155 vB
  // the hint follows the tab's mempool when enough is waiting to say something
  const sug = node?.mempool ? suggestedRate() : null;
  $('feehint').textContent =
    rate > 1 && !(sug && sug >= rate)
      ? `You pay ${rate} sat/vB; ${sug ? `payments waiting now pay about ${sug}` : '1 sat/vB is enough today'}. Change… to lower it.`
      : sug && sug > rate
        ? `Payments waiting now pay about ${sug} sat/vB; choose Change… to match, or keep ${rate} and wait longer.`
        : 'A block comes about every 20 minutes; the lowest rate, 1 sat/vB, is enough today.';
  if (WL)
    $('feerate').textContent =
      `about ${exact(Math.ceil(rate * WL.estimateVsize(1, ['5120' + '00'.repeat(32), '5120' + '00'.repeat(32)])))} for a typical payment (${rate} sat/vB)`;
  if (W) renderWallet();
}
// the wallet's code and the chain's rules: the sidestr library and the engine at their pinned commits, the rule files
// checked by hash before use
async function loadKernel() {
  const [{ makeSigner }, txsign, addr, relay, secp, hash, { createKernel }, { knotsBlake2b }] = await Promise.all([
    import(`${LIB}/schnorr.mjs`),
    import(`${LIB}/txsign.mjs`),
    import(`${LIB}/address.mjs`),
    import(`${LIB}/relay.mjs`),
    import(`${CDN}/codec/secp256k1.js`),
    import(`${CDN}/codec/hash.js`),
    import(`${CDN}/codec/kernel.js`),
    import(`${CDN}/codec/overlays/knots-blake2b.js`),
  ]);
  const j = async (p) => {
    const r = await fetch(`${CDN}/${p}`);
    if (!r.ok) throw new Error(`the engine's ${p} could not be fetched (${r.status})`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const got = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (got !== RULES_SHA256[p])
      throw new Error(`the engine's ${p} from the CDN is not the pinned file (sha256 ${got.slice(0, 12)}…); nothing was loaded`);
    return JSON.parse(new TextDecoder().decode(bytes));
  };
  // the five files at once (they were fetched one after another)
  const [core, proof, script0, chain, validate] = await Promise.all(
    ['core', 'proof', 'script', 'chain', 'validate'].map((f) => j(`schema/${f}.jsonld`)),
  );
  const k = createKernel({
    core,
    proof,
    script: script0,
    chain,
    validate,
    network: 'btc:testnet4-blake2b',
    overlays: [knotsBlake2b(await j('schema/overlays/knots-blake2b.jsonld'))],
  });
  return { makeSigner, txsign, addr, relay, secp, hash, k };
}
async function walletInit() {
  const { makeSigner, txsign, addr, relay, secp, hash, k } = await loadKernel();
  const signer = makeSigner({ hash, secp });
  const valid = (x) => {
    try {
      return /^[0-9a-f]{64}$/.test(x ?? '') && /^[0-9a-f]{64}$/.test(signer.pubkeyOf(x));
    } catch {
      return false;
    }
  };
  // the key: made once, under a lock, so two first-visit tabs cannot each make one and lose the other's
  let key = LS.get('reef:key');
  if (!valid(key)) {
    const make = () => {
      let k2 = LS.get('reef:key');
      if (valid(k2)) return k2;
      if (k2) {
        const old = loadJSON('reef:oldkeys', []);
        old.push({ key: k2, bad: true, at: Date.now() });
        if (!LS.set('reef:oldkeys', JSON.stringify(old)))
          throw new Error(
            'the key stored in this browser could not be read, and storage refused to keep a copy of it, so no new key was made over it: free storage and reload',
          );
        setTimeout(
          () =>
            banner(
              'badkey',
              'bad',
              'The key stored in this browser could not be read, so Reef made a new one. The unreadable value is kept in this browser (Copy diagnostics names where); restore your wallet from your backup (Settings → Options → Wallet → Use another key).',
            ),
          0,
        );
      }
      k2 = signer.randomKey();
      if (!LS.set('reef:key', k2))
        banner(
          'nokey',
          'bad',
          'This browser did not keep the wallet key (a private window, or storage blocked). Anything sent to this address would be lost on reload. Use a normal window.',
        );
      else LS.set('reef:keynew', String(Date.now()));
      return k2;
    };
    key = navigator.locks ? await navigator.locks.request('reef:key', make) : make();
  }
  const pub = signer.pubkeyOf(key),
    script = '5120' + pub,
    address = addr.scriptToAddress(script, 'tb');
  W = {
    k,
    hash,
    secp,
    signer,
    txsign,
    addr,
    relay,
    events: relay.makeEvents({ signer, hash }),
    key,
    pub,
    script,
    address,
    coins: [],
    height: null,
    coinsKnown: false,
    unified: k?.params?.unifiedSighashParam != null,
  };
  W.backedUpAtLoad = backedUp(); // remembered, so a storage clear while open can write the mark back
  // element by element too: one malformed entry is dropped, not the reason the wallet cannot start
  seen = new Map(
    loadJSON(seenKey(), []).filter((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && Number.isFinite(e[1])),
  );
  ledger = new Map(
    loadJSON(ledgerKey(), [])
      .filter((r) => r && typeof r === 'object' && /^[0-9a-f]{64}$/.test(r.txid) && Number.isInteger(r.height))
      .map((r) => [r.txid, r]),
  );
  // earlier versions kept one list for every key: take over the sends that spent this key's coins
  const migrated = LS.get(sentKey()) != null;
  const isRec = (x) => x && typeof x === 'object' && typeof x.txid === 'string';
  sent = (
    migrated
      ? loadJSON(sentKey(), [])
      : loadJSON('reef:sent', [])
          .filter((s) => isRec(s) && (s.inputs ?? []).some((x) => seen.has(x)))
          .map((s) => {
            const { asked: _a, ...r } = s;
            return r;
          })
  ).filter(isRec);
  const check = (hex) => {
    const t = k.codec.decode('Transaction', hex);
    return {
      txid: k.codec.txid(t),
      inputs: t.inputs.map((i) => `${i.prevout.txid}:${i.prevout.vout}`),
      outputs: t.outputs.map((o) => ({ value: o.value, scriptPubKey: o.scriptPubKey })),
    };
  };
  const scriptOf = (a) => addr.decodeAddress(a)?.script ?? null;
  // stored records sorted into kept and set aside, and both written back at once, so a save cannot bring a set-aside one back
  {
    const qk = 'reef:quarantine:' + scriptTag();
    const q0 = loadJSON(qk, []);
    const r = S.sortStored({
      sent,
      quarantine: q0,
      ok: (x) => S.validRecord(x, { check, scriptOf, ownScript: script }),
      seenHas: (k2) => seen.has(k2),
    });
    sent = r.keep;
    quarantined = new Set(r.quarantine.map((x) => x.txid));
    quarantineRecs = r.quarantine;
    // written only by the tab that runs the node, once it knows it does: the records first, then the quarantine without the ones restored
    pendingSort = () => {
      if (
        store(
          sentKey(),
          JSON.stringify(
            S.forStorage(
              S.mergeSent(
                sent,
                loadJSON(sentKey(), []).filter((x) => !quarantined.has(x.txid)),
              ),
            ),
          ),
        )
      )
        LS.set(qk, JSON.stringify(r.quarantine.slice(-500)));
    };
    const held = r.quarantine.filter((x) => x.pending && !x.released);
    if (held.length)
      setTimeout(
        () =>
          banner(
            'quarantine',
            'warn',
            `${held.length} stored payment record(s) could not be verified against their own transactions, so Reef set them aside (kept in this browser); the coins they spend are held so nothing is paid twice.`,
            [
              [
                'Release their coins…',
                async () => {
                  if (
                    await ask(
                      'Release held coins',
                      [
                        'These records did not match their own transactions, so Reef cannot tell whether they were ever sent. If one was, and is mined later, its coins are spent; releasing them lets a new payment use them, and only one of the two can then go through.',
                      ],
                      'Release',
                      true,
                      'Keep them held',
                    )
                  ) {
                    // only the tab that runs the wallet writes; the release is kept in memory too, and said only once stored
                    if (!writable()) return notify('Not here', 'release them in the tab that runs the node', true);
                    const q = loadJSON(qk, []).map((x) => ({ ...x, released: true }));
                    if (!store(qk, JSON.stringify(q))) return;
                    quarantineRecs = quarantineRecs.map((x) => ({ ...x, released: true }));
                    unbanner('quarantine');
                    renderWallet();
                  }
                },
              ],
            ],
          ),
        0,
      );
  }
  W.validRecord = (x) => S.validRecord(x, { check, scriptOf, ownScript: script });
  wireWalletPage(address);
  // the node may have started first and waited: once loaded, the stored records are sorted and written (never skipped)
  if (RUNNING && pendingSort) {
    pendingSort();
    pendingSort = null;
  }
}
// the Receive page and the Send form, once the wallet has its address
function wireWalletPage(address) {
  $('rcvaddr').value = address;
  $('rcvfull').textContent = V.grouped(address); // the whole address, in fours, to read against the payer's copy
  try {
    const qr = qrcode(0, 'M');
    qr.addData('bitcoin:' + address);
    qr.make();
    $('rcvqr').innerHTML = qr.createSvgTag({
      cellSize: 4,
      margin: 0,
      alt: 'QR code of ' + address,
      title: "QR code of this wallet's address",
    });
  } catch {
    $('rcvqr').textContent = 'The QR code could not be drawn (its library did not load): copy the address instead.';
  }
  $('rcvcopy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(address);
      $('rcvcopy').textContent = 'Copied';
      setTimeout(() => {
        $('rcvcopy').textContent = 'Copy';
      }, 1500);
    } catch {
      $('rcvaddr').select();
    }
  };
  navigator.storage
    ?.persisted?.()
    .then((p) => {
      $('rcvpersist').textContent = p
        ? ''
        : "This browser keeps the key only as long as it keeps this site's data (a private window forgets it on close): back it up before you receive.";
    })
    .catch(() => {});
  $('sendall').onclick = () => {
    const on = $('sendall').getAttribute('aria-pressed') !== 'true';
    $('sendall').setAttribute('aria-pressed', String(on));
    $('sendamt').disabled = on;
    // the amount typed is kept aside and comes back when Send everything is turned off; meanwhile the field shows the amount
    if (on) $('sendamt').dataset.typed = $('sendamt').value;
    else $('sendamt').value = $('sendamt').dataset.typed ?? '';
    updatePreview();
  };
  $('sendclear').onclick = () => {
    $('sendto').value = '';
    $('sendamt').value = '';
    $('sendamt').disabled = false;
    $('sendall').setAttribute('aria-pressed', 'false');
    $('sendout').textContent = '';
    updatePreview();
  };
  $('sendgo').onclick = () => {
    if ($('sendgo').getAttribute('aria-disabled') === 'true')
      return sendError($('sendout').textContent || 'Sending is not possible in this tab.');
    sendFlow().catch((e) => sendError(e.message));
  };
  $('sendpaste').onclick = async () => {
    try {
      $('sendto').value = (await navigator.clipboard.readText()).trim();
      updatePreview();
    } catch {
      sendError('the browser did not allow reading the clipboard: paste with Ctrl+V');
    }
  };
  let pv;
  for (const id of ['sendto', 'sendamt'])
    $(id).addEventListener('input', () => {
      $('sendpreview').setAttribute('aria-live', 'off');
      updatePreview();
      clearTimeout(pv);
      pv = setTimeout(() => {
        $('sendpreview').setAttribute('aria-live', 'polite');
        const t = $('sendpreview').textContent;
        $('sendpreview').textContent = '';
        $('sendpreview').textContent = t;
      }, 800);
    });
  // a change of unit converts the amount typed, so the digits never silently mean a thousand times more
  let lastUnit = OPT.unit;
  $('sendunit').value = OPT.unit;
  $('sendunit').addEventListener('change', () => {
    const v = $('sendamt').value.trim();
    if (v) {
      try {
        $('sendamt').value = WL.formatAmount(WL.parseAmount(v, lastUnit), $('sendunit').value, { grouping: false }).replace(
          /\.?0+$/,
          (m) => (m.startsWith('.') ? '' : m),
        );
      } catch {}
    }
    lastUnit = $('sendunit').value;
    updatePreview();
  });
  $('feechoose').onclick = () => (IDLE ? sendError('The fee rate is set in the tab that runs the wallet.') : feeFlow());
  applyDisplay();
  renderWallet();
  if (LS.get('reef:keynew') && !ledger.size) setTimeout(() => backupNudge(), 1500);
  else backupNudge();
  if (node.synced) askCoins();
}
function askCoins() {
  if (W && !IDLE) post({ type: 'coins', script: W.script });
}
const incomingTxs = () => {
  if (!W || !node.mempool) return [];
  return node.mempool.txs
    .map((t) => ({ txid: t.txid, ...ourTx(t) }))
    .filter((x) => x.toUs && !x.spendsOurs && !sent.some((s) => s.txid === x.txid));
};
function ourTx(t) {
  const mine = (k) => seen.has(k) || W.coins.some((c) => c.key === k);
  return { spendsOurs: t.inputs.some(mine), toUs: t.outputs.reduce((a, o) => a + (o.scriptPubKey === W.script ? o.value : 0), 0) };
}
const hitchHeld = () => {
  try {
    return new Set(JSON.parse(LS.get('hitch:held:' + scriptTag()) ?? '[]'));
  } catch {
    return new Set();
  }
};
const quarantineStored = () => (W ? loadJSON('reef:quarantine:' + scriptTag(), []) : []);
const quarantineHeld = () =>
  new Set(
    loadJSON('reef:quarantine:' + scriptTag(), [])
      .filter((q) => q.pending && !q.released && !q.abandoned && !q.refused && !q.refusedNote)
      .flatMap((q) => q.inputs ?? []),
  );
const wallBal = () =>
  WL.balances({
    coins: W.coins,
    sent,
    height: W.height,
    reserved: new Set([...hitchHeld(), ...quarantineHeld()]),
    incoming: incomingTxs().reduce((a, x) => a + x.toUs, 0),
    vouched: T.signedHeight(node.nostr),
  });
function carryOut(effects) {
  for (const e of effects) {
    if (e.notice) notify(e.notice, say(e.body), !!e.bad);
    if (e.ask) post({ type: 'spend', key: e.input, from: e.from, req: 'sent:' + e.ask });
  }
}
function onCoins(m) {
  if (!W || m.script !== W.script) return;
  const first = !W.coinsKnown;
  W.coins = m.coins;
  W.height = m.height;
  W.coinsKnown = true;
  for (const c of W.coins) if (!seen.has(c.key)) seen.set(c.key, c.value);
  // a coin whose transaction spent coins of ours, with no record here: recovered from the chain (lib/state.mjs)
  for (const { record, notice } of S.recoverFromCoins({ coins: W.coins, sent, seen, hitch: hitchHeld() })) {
    sent.push(record);
    if (!first) carryOut([notice]);
  }
  const added = WL.recordReceipts(ledger, W.coins, (t) => sent.some((s) => s.txid === t));
  const undone = WL.undoneReceipts(ledger, W.coins, W.height);
  for (const r of undone) ledger.delete(r.txid);
  if (undone.length)
    notify(
      'A mined block was replaced',
      `${amtSay(undone.reduce((a, r) => a + WL.receiptSats(r), 0))} from block ${undone.map((r) => n(r.height)).join(', ')} is no longer yours: another block took its place in the chain (this happens on a test chain).`,
      true,
    );
  if (!first) {
    const mined = added.filter((r) => r.coinbase),
      got = added.filter((r) => !r.coinbase);
    const vouchedAt = T.signedHeight(node.nostr);
    for (const r of got)
      notify(
        'Payment received',
        `${amtSay(WL.receiptSats(r))} in block ${n(r.height)}${vouchedAt != null && r.height > vouchedAt ? ': the signed chain tip has not reached that block yet, so it counts as pending until it does' : ''}`,
      );
    if (got.length) offerNotify();
    if (mined.length)
      notify(
        'Mined coins',
        `${amtSay(mined.reduce((a, r) => a + WL.receiptSats(r), 0))} in ${mined.length} block${mined.length === 1 ? '' : 's'}; spendable after 100 confirmations`,
      );
  }
  const fx = S.onCoins({ sent, coins: W.coins, asked, height: W.height, vouched: T.signedHeight(node.nostr) });
  if (first) {
    carryOut(fx.filter((e) => !e.notice));
    const news = fx.filter((e) => e.notice && e.bad);
    if (news.length) banner('whileclosed', 'bad', 'While Reef was closed:\n' + news.map((e) => `• ${e.notice}: ${say(e.body)}`).join('\n'));
  } else carryOut(fx);
  if (!IDLE) {
    for (const r of S.recheckDue(sent, W.height)) {
      r.checkedAt = W.height;
      post({ type: 'spend', key: r.inputs[0], from: Math.max(S.FIRST_BLAKE_HEIGHT, r.height - S.RECHECK_DEPTH), req: 'recheck:' + r.txid });
    }
    // received payments without a date: their block's time, asked once each per load
    for (const r of ledger.values())
      if (!r.time && !timeAsked.has(r.txid)) {
        timeAsked.add(r.txid);
        post({ type: 'block', height: r.height, req: 'time:' + r.txid });
      }
    // received payments whose coins went without a payment of ours: spent elsewhere, or undone (asked once per block)
    for (const q of WL.receiptsToCheck(ledger, W.coins, sent, W.height)) {
      ledger.get(q.txid).checkedAt = W.height;
      post({ type: 'spend', key: q.key, from: q.from, req: 'rcpt:' + q.txid });
    }
  }
  saveSeen();
  saveLedger();
  saveSent();
  post({
    type: 'watch',
    scripts: [W.script],
    outpoints: [...W.coins.map((c) => c.key), ...sent.filter((s) => s.pending).flatMap((s) => s.inputs ?? [])],
  });
  if (W.coins.length || ledger.size) LS.del('reef:keynew');
  if ((W.coins.length || ledger.size) && !backedUp()) backupNudge(true);
  if (first && W.coins.length) navigator.storage?.persist?.().catch(() => {});
  renderWallet();
}
function onSpendAnswer(m) {
  if (!W || IDLE) return;
  const txid = m.req.slice(5);
  asked.delete(txid);
  carryOut(S.onSpendAnswer(sent, txid, m));
  saveSent();
  renderWallet();
}
function onRefusedTx(m) {
  if (!W || IDLE) return;
  const fx = S.onRefused(sent, m.txid, m.error, m.hex);
  if (fx.length) {
    carryOut(fx);
    saveSent();
    renderWallet();
  }
}
function walletMempool() {
  if (!W || !node.mempool) return;
  const first = !W.mpReady;
  W.mpReady = true;
  const hh = hitchHeld();
  let added = false;
  if (!IDLE) {
    const found = S.recoverFromMempool({
      txs: node.mempool.txs.filter((t) => ourTx(t).spendsOurs),
      sent,
      seen,
      hitch: hh,
      toUs: (t) => ourTx(t).toUs,
      height: node.height,
    });
    sent.push(...found);
    added = found.length > 0;
  }
  for (const t of node.mempool.txs) {
    const { spendsOurs, toUs } = ourTx(t);
    if (spendsOurs || sent.some((x) => x.txid === t.txid)) continue;
    if (toUs && !mpSeen.has(t.txid)) {
      mpSeen.add(t.txid);
      if (mpSeen.size > 500) mpSeen.delete(mpSeen.values().next().value);
      if (!first) notify('Payment on its way', `${amtSay(toUs)} to you, unconfirmed`);
    }
  }
  if (added) saveSent();
  renderWallet();
}
// the balance and the history; "…" until the node has answered, never a zero it does not know
let lastAvail = null;
function renderWallet() {
  if (!W) return;
  const fx = document.activeElement?.dataset?.tx
    ? { tx: document.activeElement.dataset.tx, act: document.activeElement.dataset.act }
    : null;
  renderWalletInner();
  if (fx) document.querySelector(`#txrows button[data-tx="${fx.tx}"][data-act="${fx.act}"]`)?.focus();
}
function renderWalletInner() {
  const known = W.coinsKnown;
  if (!known) {
    for (const id of ['avail', 'pending', 'immature', 'total', 'sendbal'])
      $(id).textContent = IDLE ? (id === 'total' ? '— (other tab)' : '—') : '…';
    $('ovtrust').textContent = IDLE
      ? IDLE_TEXT
      : node.notStarted
        ? 'the node is not started: the balance is known once it is up to date'
        : node.error
          ? 'the node stopped: see the notice above'
          : `balance known once the tab is up to date (${node.synced ? 'reading the coins' : ({ fetch: 'fetching the snapshot', hash: 'checking the snapshot', verify: 'verifying the snapshot', sync: 'validating the blocks since' }[node.phase] ?? 'starting') + ($('synceta').textContent ? ', ' + $('synceta').textContent : '')})`;
  } else {
    const b = wallBal();
    if (lastAvail != null && lastAvail !== b.available && !OPT.mask) sayOnce(`Available: ${amtSay(b.available)}`);
    lastAvail = b.available;
    $('avail').innerHTML = amtHtml(b.available);
    $('immature').innerHTML = amtHtml(b.immature);
    $('pending').innerHTML = amtHtml(b.pending);
    $('total').innerHTML = amtHtml(b.total);
    $('sendbal').innerHTML = amtHtml(b.available);
    $('outgoing').textContent = [
      b.outgoing ? `${amtSay(b.outgoing)} leaving in payments not yet confirmed` : '',
      b.elsewhere
        ? `${amtSay(b.elsewhere)} reserved elsewhere: ${hitchHeld().size ? 'a Hitch channel funding (to release it, close Reef, open Hitch and cancel the funding there)' : ''}${hitchHeld().size && quarantineHeld().size ? '; ' : ''}${quarantineHeld().size ? 'a payment record Reef could not verify (see the notice above)' : ''}`
        : '',
    ]
      .filter(Boolean)
      .join(' · ');
    renderStatus();
  }
  // an idle tab shows no history, as it shows no balance: the running tab is the one that knows
  const rows = IDLE
    ? []
    : WL.history({
        coins: W.coins,
        sent: sent.filter((s) => !s.hidden),
        mempoolIn: incomingTxs(),
        height: W.height,
        address: W.address,
        ledger,
      });
  const vctx = {
    inMempool,
    height: W.height,
    now: Date.now(),
    sent,
    idle: IDLE,
    canAct: canAct(),
    signedHeight: T.signedHeight(node.nostr),
  };
  const views = new Map(rows.map((r) => [r, V.viewRow(r, vctx)]));
  const recOf = (r) => (r.kind === 'out' ? sent.find((x) => x.txid === r.txid) : null);
  const recent = V.recentRows(rows, views);
  $('recent').setAttribute('role', 'list');
  $('recent').innerHTML = recent.length
    ? recent
        .map((r) => {
          const v = views.get(r);
          return `<div class="r" role="listitem"><span aria-hidden="true">${v.icon}</span><span title="${v.block ? 'block ' + esc(n(v.block)) : ''}">${esc(say(v.short))}</span><span class="addr" title="${esc(r.addr)}">${txLink(r.txid, V.recentLabel(r))}</span><span class="amt ${r.pending ? 'pend' : r.kind === 'in' ? 'in' : 'out'}">${amtHtml(v.sats)}</span></div>`;
        })
        .join('')
    : `<div class="r" role="listitem"><span></span><span class="mut" style="grid-column:2/5">${esc(V.recentEmpty({ known, idle: IDLE, any: rows.length > 0 }))}${known && !IDLE && !rows.length ? ': <a href="#" data-go2="receive">your address is on the Receive page</a>' : ''}</span></div>`;
  $('recent')
    .querySelectorAll('[data-go2]')
    .forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        showPage(a.dataset.go2);
      };
    });
  const shown = V.filterRows(rows, { type: $('txtype').value, query: $('txsearch').value, sent });
  $('txrows').innerHTML = shown.length
    ? shown
        .map((r) => {
          const s = recOf(r);
          const v = views.get(r);
          // what a screen reader hears names the row as it is shown: its kind, where to, and the amount in the row
          const who = s
            ? `the ${v.tag ? v.tag + ' ' : ''}${r.label.toLowerCase()}${r.label === 'Payment to yourself' ? '' : ' ' + V.shortAddr(s.to)} (${amtSay(v.sats)})`
            : '';
          const btn = {
            bump: ['Raise the fee…', 'Raise the fee on', 'Pay a higher fee so a block takes it sooner'],
            again: ['Announce again', 'Announce again', 'Hand the same signed payment to the relays again; it cannot pay twice'],
            cancel: ['Cancel…', 'Cancel', 'Pay the coins back to yourself instead, if no block has taken it yet'],
            forget: ['Forget…', 'Forget', 'Stop waiting for it and free its coins'],
            hide: ['Hide', 'Hide from the list', 'Hide this row: it never happened, and hiding it changes nothing'],
          };
          const acts = v.actions
            .map(
              (k) =>
                `<button class="q sm" data-act="${k}" data-tx="${esc(s.txid)}" title="${esc(btn[k][2])}" aria-label="${esc(k === 'hide' ? `Hide ${who} from the list` : `${btn[k][1]} ${who}`)}">${btn[k][0]}</button>`,
            )
            .join('');
          return `<tr><td class="when">${r.at ? esc(when(r.at)) : '—'}</td><td title="${esc(say(v.state))}"><span aria-hidden="true">${v.icon}</span><span class="state" aria-hidden="true">${esc(
            say(v.short),
          )}</span><span class="sr">${esc(say(v.state))}</span></td><td>${v.block ? esc(n(v.block)) : '—'}</td><td>${esc(r.label)}</td><td class="addr" title="${esc(r.addr)}">${txLink(r.txid, r.kind === 'in' || r.label === 'Payment to yourself' ? 'your address' : V.shortAddr(r.addr))}</td><td class="amt ${r.kind === 'in' ? 'in' : 'out'}${v.struck ? ' struck' : ''}">${moneyHtml(v.sats)}<span class="cardunit"> ${esc(unit().label)}</span><span class="sr">${v.tag ? esc(` (${v.tag})`) : ''}</span></td><td class="acts">${acts}</td></tr>`;
        })
        .join('')
    : `<tr><td colspan="7" class="mut">${IDLE ? 'shown in the tab that runs the node' : known ? (rows.length ? 'nothing matches' : 'no transactions since the snapshot') : 'waiting for the node'}</td></tr>`;
  $('txrows')
    .querySelectorAll('button[data-act]')
    .forEach((b) => {
      b.onclick = () => {
        const s = sent.find((x) => x.txid === b.dataset.tx);
        if (!s || !canAct()) return;
        const a = b.dataset.act;
        (a === 'bump'
          ? replaceFlow(s, s.kind === 'cancel')
          : a === 'cancel'
            ? replaceFlow(s, true)
            : a === 'again'
              ? publishAgain(s, true)
              : a === 'forget'
                ? forgetFlow(s)
                : Promise.resolve().then(() => {
                    S.hide(sent, s);
                    saveSent();
                    renderWallet();
                  })
        ).catch((e) => notify('Not done', e.message, true));
      };
    });
  const onWay = incomingTxs();
  $('rcvincoming').textContent = onWay.length
    ? `On its way to you: ${amtSay(onWay.reduce((a, x) => a + x.toUs, 0))} in ${onWay.length} unconfirmed payment${onWay.length === 1 ? '' : 's'}.`
    : '';
  const bb = wallBal(),
    hh = hitchHeld(),
    qh = quarantineHeld(),
    rf = WL.reuseFirst(sent, quarantineStored());
  $('rcvrows').innerHTML = W.coins.length
    ? W.coins
        .slice()
        .sort((a, b) => b.height - a.height)
        .map(
          (c) =>
            `<tr><td>${esc(n(c.height))}</td><td class="mono">${txLink(c.key.slice(0, 64), c.key.slice(0, 20) + '…:' + c.key.slice(65))}</td><td>${W.height != null ? esc(n(W.height - c.height + 1)) : '…'}${esc(V.coinNote(c, { height: W.height, sent, hitch: hh, quarantine: qh, held: bb.held, first: rf, mature: WL.isMature }))}</td><td class="amt">${moneyHtml(c.value)}</td></tr>`,
        )
        .join('')
    : `<tr><td colspan="4" class="mut">${known ? 'nothing received since the snapshot' : IDLE ? 'shown in the tab that runs the node' : 'waiting for the node'}</td></tr>`;
}
for (const id of ['txtype', 'txsearch']) $(id).addEventListener('input', () => renderWallet());
$('txexport').onclick = () => {
  if (!W) return;
  if (IDLE) return notify('Not here', 'the history is exported from the tab that runs the node', true);
  const rows = WL.history({
    coins: W.coins,
    sent: sent.filter((s) => !s.hidden),
    mempoolIn: incomingTxs(),
    height: W.height,
    address: W.address,
    ledger,
  });
  const vctx = { inMempool, height: W.height, now: Date.now(), sent, idle: IDLE, signedHeight: T.signedHeight(node.nostr) }; // as the lists
  const csv = [V.EXPORT_HEAD, ...rows.map((r) => V.exportRow(r, vctx))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `reef-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
};

// ---- sending: the plan shown as it is typed, a confirmation with every figure, then build, sign, check, publish
function sendError(m) {
  $('sendout').textContent = '';
  $('senderr').textContent = say(m);
}
function sendInfo(m, cls = '', action = null) {
  $('senderr').textContent = '';
  const out = $('sendout');
  out.className = 'tiny ' + cls;
  out.textContent = m;
  if (action) {
    const a = document.createElement('button');
    a.type = 'button';
    a.className = 'link';
    a.textContent = action[0];
    a.onclick = action[1];
    out.append(' ', a);
  }
}
// a payment that spends a coin of a forgotten one says so: only one of the two can happen
function reuseNote(p) {
  const first = WL.reuseFirst(sent, quarantineStored());
  const hit = p.picked.find((c) => first.has(c.key));
  if (!hit) return '';
  const f = sent.find((x) => x.pending && x.abandoned && (x.inputs ?? []).includes(hit.key));
  return f
    ? `This uses a coin of the forgotten payment of ${exact(f.sats)} to ${String(f.to).slice(0, 14)}…, so only one of the two can happen: if that one is mined first, this one fails and Reef tells you.`
    : '';
}
// nothing spendable: say what the coins are doing instead
function noCoinsWhy() {
  const b = wallBal();
  const parts = [];
  if (b.immature) parts.push(`${amtSay(b.immature)} is mined coins, spendable after 100 blocks`);
  const incoming = incomingTxs().reduce((a, x) => a + x.toUs, 0);
  if (incoming) parts.push(`${amtSay(incoming)} is on its way to you and can be spent once a block includes it`);
  if (b.outgoing || b.pending - incoming > 0) parts.push('some is held by a payment of yours still waiting (see Transactions)');
  if (b.elsewhere) parts.push(`${amtSay(b.elsewhere)} is reserved by Hitch or by a payment record Reef could not verify`);
  return parts.length ? `Nothing can be spent right now: ${parts.join('; ')}.` : 'No coins yet: your address is on the Receive page.';
}
function readSend() {
  if (!W) throw new Error('the wallet is not ready');
  if (IDLE) throw new Error('Reef runs in another tab of this browser: send from there');
  if (!W.coinsKnown) throw new Error('wait until the tab is up to date: the balance is not known yet');
  const to = $('sendto').value.trim();
  if (!to) throw new Error('enter the address to pay');
  const dec = W.addr.decodeAddress(to);
  const chk = WL.checkDestination(dec, { ownScript: W.script });
  if (chk.error) throw new Error(chk.error);
  const all = $('sendall').getAttribute('aria-pressed') === 'true';
  const amount = all ? null : WL.parseAmount($('sendamt').value, $('sendunit').value);
  const rate = Math.max(1, Math.round(Number(OPT.feeRate) || 1));
  const coins = WL.spendable(W.coins, W.height, wallBal().held, WL.reuseFirst(sent, quarantineStored()));
  if (!coins.length) throw new Error(noCoinsWhy());
  const p = WL.plan({ coins, amount, rate, destSpk: dec.script, changeSpk: W.script, all });
  return { to, dec, self: chk.self, all, rate, p };
}
function updatePreview() {
  const el = $('sendpreview');
  if (!W) return;
  if (IDLE) {
    el.textContent = '';
    return;
  }
  if (!W.coinsKnown) {
    el.className = 'tiny mut';
    el.textContent = 'Sending is possible once the tab is up to date and knows the balance.';
    return;
  }
  if (!$('sendto').value.trim() && !$('sendamt').value.trim() && $('sendall').getAttribute('aria-pressed') !== 'true') {
    el.textContent = '';
    return;
  }
  try {
    const r = readSend();
    const fg = reuseNote(r.p);
    el.className = 'tiny';
    el.textContent = r.self
      ? `${fg ? fg + ' ' : ''}To yourself: only the fee leaves the wallet (${exact(r.p.fee)}). Nothing else changes.`
      : `${fg ? fg + ' ' : ''}${r.all ? 'Everything: ' : ''}${exact(r.p.amount)} to the address, ${exact(r.p.fee)} fee, ${exact(r.p.amount + r.p.fee)} in all${r.p.change ? `; ${exact(r.p.change)} comes back as change` : ''}.`;
    if (r.all) $('sendamt').value = WL.formatAmount(r.p.amount, $('sendunit').value, { grouping: false });
  } catch (e) {
    el.className = 'tiny mut';
    const m = say(e.message);
    // short of coins: the way out is to send what there is
    let most = '';
    if (e.short)
      try {
        const dest = W.addr.decodeAddress($('sendto').value.trim());
        const coins = WL.spendable(W.coins, W.height, wallBal().held, WL.reuseFirst(sent, quarantineStored()));
        const all = WL.plan({
          coins,
          amount: null,
          rate: Math.max(1, Math.round(Number(OPT.feeRate) || 1)),
          destSpk: dest.script,
          changeSpk: W.script,
          all: true,
        });
        most = ` To send all you can, press Send everything (${exact(all.amount)} after the fee).`;
      } catch {}
    el.textContent = m.charAt(0).toUpperCase() + m.slice(1) + (/[.?!]$/.test(m) ? '' : '.') + most;
  }
}
async function signCheck(tx, prevouts) {
  W.txsign.signKeyPath({ k: W.k, hash: W.hash, signer: W.signer }, tx, prevouts, W.key);
  for (let i = 0; i < tx.inputs.length; i++) {
    const v = W.k.interpreter.verifyInput(tx, i, prevouts[i], prevouts, null, { unifiedSighash: W.unified });
    if (v.ok !== true)
      throw new Error(`the transaction did not pass the script check (${v.error ?? v.reason ?? 'input ' + i}); nothing was sent`);
  }
  return { hex: W.k.codec.encodeHex('Transaction', tx), txid: W.k.codec.txid(tx), vsize: WL.vsizeOf(W.k, tx) };
}
async function publishHex(hex) {
  const event = W.events.parentTxEvent(W.signer.randomKey(), 'sidestr:tally', hex);
  let results = {};
  try {
    results = await W.relay.publish({ relays: RELAYS(), event });
  } catch (e) {
    results = { error: e.message };
  }
  LS.set('reef:lastpublish', JSON.stringify({ at: Date.now(), results }));
  return {
    event,
    ok: Object.entries(results)
      .filter(([, r]) => r === 'ok')
      .map(([u]) => u),
  };
}
// the fee rate from the Send page: one number, the figures follow; kept in Options (the same setting)
async function feeFlow() {
  const box = document.createElement('div');
  const field = document.createElement('label');
  field.className = 'row';
  field.innerHTML = `<span>Fee rate:</span><input type="number" min="1" max="${WL.MAX_RATE}" step="1" style="width:90px;flex:none" aria-describedby="feeflow-note"><span>sat/vB</span>`;
  const inp = field.querySelector('input');
  inp.value = Math.max(1, Math.round(Number(OPT.feeRate) || 1));
  const note = document.createElement('p');
  note.id = 'feeflow-note';
  const typical = (r) => Math.ceil(r * WL.estimateVsize(1, ['5120' + '00'.repeat(32), '5120' + '00'.repeat(32)]));
  const paint = () => {
    const r = Number(inp.value);
    const okRate = Number.isInteger(r) && r >= 1 && r <= WL.MAX_RATE;
    $('ask-ok').disabled = !okRate;
    const sug = node.mempool ? suggestedRate() : null;
    const avail = W?.coinsKnown ? wallBal().available : null;
    note.textContent = okRate
      ? `About ${exact(typical(r))} for a typical payment. ${sug ? `Payments waiting now pay about ${sug} sat/vB.` : 'A block comes about every 20 minutes; 1 sat/vB is enough today.'}` +
        (r >= 10 && !(sug && r <= sug)
          ? ` ${r} sat/vB is much more than blocks need today, and it stays for every payment until changed.`
          : '') +
        (avail != null && typical(r) > avail ? ' At this rate the fee alone is more than you can spend.' : '')
      : `A whole number from 1 to ${WL.MAX_RATE}.`;
  };
  inp.oninput = paint;
  // the rate field has the focus, and Enter applies a valid rate
  inp.onkeydown = (e) => {
    if (e.key === 'Enter' && !$('ask-ok').disabled) {
      e.preventDefault();
      $('ask-ok').click();
    }
  };
  setTimeout(() => inp.focus(), 0);
  box.append(field, note);
  setTimeout(paint, 0);
  if (!(await ask('Fee rate', [box], 'Use this rate', false, 'Cancel'))) return;
  const r = Number(inp.value);
  if (!(Number.isInteger(r) && r >= 1 && r <= WL.MAX_RATE)) return;
  OPT.feeRate = r;
  saveOptions();
  applyDisplay();
  updatePreview();
}
async function sendFlow() {
  if (sending || !canAct()) return;
  const r = readSend();
  const { p } = r;
  if (trust().level === 'bad') throw new Error('the block source disagrees with the signed chain tip: sending waits until that clears');
  const waitingSame = S.waitingTo(sent, r.dec.script, (a) => W.addr.decodeAddress(a)?.script);
  const lines = V.confirmLines({
    to: r.to,
    self: r.self,
    all: r.all,
    rate: r.rate,
    p,
    money: exact,
    trustWarn: trust().level === 'warn' ? trust().text : null,
    reuse: reuseNote(p),
    waitingSame,
    settlingSame: S.settlingTo(sent, r.dec.script, W.height, (a) => W.addr.decodeAddress(a)?.script),
  });
  if (!(await ask('Confirm the payment', lines, 'Send', false, 'Back'))) return;
  // the world may have moved while the dialog was open: the same coins and the same figures, or nothing is sent
  let again;
  try {
    again = readSend();
  } catch (e) {
    throw new Error('the payment changed while it was being confirmed (' + e.message + '); nothing was sent');
  }
  if (trust().level === 'bad') throw new Error('the block source disagrees with the signed chain tip; nothing was sent');
  if (
    again.p.fee !== p.fee ||
    again.p.amount !== p.amount ||
    again.p.picked.map((c) => c.key).join() !== p.picked.map((c) => c.key).join() ||
    sending
  )
    throw new Error('the coins or the figures changed while the payment was being confirmed; nothing was sent: check and send again');
  sending = true;
  $('sendgo').disabled = true;
  sendInfo('signing and checking…');
  try {
    const tx = WL.unsignedTx(p);
    const prevouts = p.picked.map((c) => ({ value: c.value, scriptPubKey: W.script }));
    const { hex, txid, vsize } = await signCheck(tx, prevouts);
    if (p.fee < Math.ceil(r.rate * vsize))
      throw new Error(
        `the signed payment came out larger than estimated (${vsize} vB), so the fee is below the rate; nothing was sent: send again`,
      );
    // the coins are held before anything is published, so a second click or another tab cannot spend them again
    const s = S.paymentRecord(p, { txid, hex, to: r.to, toScript: r.dec.script, self: r.self, all: r.all, tip: W.height });
    if (sent.some((x) => x.txid === txid)) throw new Error('this payment was already made');
    sent.push(s);
    for (const c of p.picked) seen.set(c.key, c.value);
    saveSeen();
    if (!saveSent()) {
      sent = sent.filter((x) => x !== s);
      throw new Error(
        'the payment could not be recorded in this browser (storage full or blocked), so it was not sent: free storage and try again',
      );
    }
    renderWallet();
    sendInfo('handing it to the relays…');
    $('sendto').value = '';
    $('sendamt').value = '';
    $('sendamt').disabled = false;
    $('sendall').setAttribute('aria-pressed', 'false');
    updatePreview();
    const pub = await publishHex(hex);
    s.relays = pub.ok;
    s.lastPub = Date.now();
    saveSent();
    if (!pub.ok.length)
      sendInfo(
        'The payment is made and kept, but no relay took it yet. Reef publishes it again every 10 minutes: do not send it again. Check the relays in Settings → Options → Network.',
        'bad',
      );
    else
      sendInfo(
        r.self
          ? `Sent to yourself. It shows as confirmed when a block includes it, usually within 20 minutes.`
          : `Sent. ${exact(p.amount)} to ${V.shortAddr(r.to)} is on its way and shows as confirmed when a block includes it, usually within 20 minutes.`,
        'good',
        ['See it on the Transactions page', () => showPage('tx')],
      );
    cprint(`· payment of ${amtSay(p.amount)} made (fee ${p.fee} sat): ${txid.slice(0, 16)}…`, 'log');
    offerNotify();
    return { txid };
  } finally {
    sending = false;
    $('sendgo').disabled = false;
    renderWallet();
  }
}
// browser notifications are offered when they first mean something (a payment made or a coin received), not at the start
function offerNotify() {
  if (!OPT.notify || !('Notification' in window) || Notification.permission !== 'default' || LS.get('reef:notifyasked')) return;
  banner(
    'notifyask',
    'info',
    'Get a browser notification when a payment confirms or a coin arrives, even with this tab in the background?',
    [
      [
        'Allow',
        () => {
          LS.set('reef:notifyasked', '1');
          unbanner('notifyask');
          Notification.requestPermission().catch(() => {});
        },
      ],
      [
        'No thanks',
        () => {
          LS.set('reef:notifyasked', '1');
          unbanner('notifyask');
        },
      ],
    ],
  );
}
const inFlight = new Set();
const timeAsked = new Set();
async function publishAgain(s, manual = false) {
  if (!canAct()) return;
  if (!S.publishable(s)) throw new Error('this payment is no longer one to announce (replaced, refused, forgotten or settled)');
  if (!s.hex) throw new Error('this payment was not made from this tab; nothing to publish again');
  if (inFlight.has(s.txid)) return;
  inFlight.add(s.txid);
  s.lastPub = Date.now();
  let pub;
  try {
    pub = await publishHex(s.hex);
  } finally {
    inFlight.delete(s.txid);
  }
  s.lastPub = Date.now();
  s.relays = [...new Set([...(s.relays ?? []), ...pub.ok])];
  saveSent();
  renderWallet();
  if (manual)
    notify(
      pub.ok.length ? 'Published again' : 'Not published',
      pub.ok.length
        ? `sent to ${pub.ok.length} relay${pub.ok.length === 1 ? '' : 's'}; a node will pick it up`
        : 'no relay took it; check Settings → Options → Network',
      !pub.ok.length,
    );
}
// replace a waiting payment (BIP 125): a higher fee from its change (from the amount, for a payment of everything), or
// cancel it by paying everything back to this key; sized for the outputs it really has, and capped like any payment
async function replaceFlow(s, cancel) {
  if (!canAct()) return;
  if (!s.pending || !s.values) throw new Error('only a waiting payment made from this tab can be replaced');
  if (s.replacedBy) throw new Error('this version was already replaced; act on the newest one');
  if (trust().level === 'bad') throw new Error('the block source disagrees with the signed chain tip: wait until that clears');
  if (sending) return;
  const picked = s.inputs.map((k2, i) => ({ key: k2, value: s.values[i] }));
  let rate0 = WL.raiseRate({ s, ownSpk: W.script, optRate: OPT.feeRate, mempoolRate: mempoolRate() });
  const plain = !cancel && !s.all;
  const linesFor = ({ fee, amount, rate }) =>
    cancel
      ? [
          `A new transaction spends the same coins back to you with a fee of ${exact(fee)} (the original paid ${exact(s.fee)}). If a block takes it first, the payment is cancelled and ${exact(amount)} is yours again.`,
          'If a node already has the original, the original may still be mined; the Transactions page says which one was.',
        ]
      : plain
        ? [
            `The same payment of ${exact(amount)} to ${s.to} is sent again with a fee of ${exact(fee)} (${rate} sat/vB) instead of ${exact(s.fee)}; the ${exact(fee - s.fee)} more comes out of your change.`,
            'Whichever version a block takes, the payment is made once.',
          ]
        : [
            `This payment sent everything, so a higher fee comes out of what the recipient receives: ${exact(amount)} instead of ${exact(s.sats)}, with a fee of ${exact(fee)} (${rate} sat/vB) instead of ${exact(s.fee)}.`,
            'Whichever version a block takes, the payment is made once.',
          ];
  // the rate can be chosen in the dialog: the figures follow as it is typed, and OK is off while it cannot be made
  let pr = WL.planReplace(s, { cancel, rate: rate0, ownSpk: W.script });
  const box = document.createElement('div');
  const text = document.createElement('div');
  const field = document.createElement('label');
  field.className = 'row';
  field.innerHTML = `<span>Fee rate:</span><input type="number" min="1" max="${WL.MAX_RATE}" step="1" style="width:90px;flex:none"><span>sat/vB</span>`;
  const inp = field.querySelector('input');
  inp.value = rate0;
  const paint = () => {
    text.textContent = '';
    let lines;
    try {
      const r = Number(inp.value);
      if (!(Number.isInteger(r) && r >= 1 && r <= WL.MAX_RATE)) throw new Error(`a whole number from 1 to ${WL.MAX_RATE}`);
      pr = WL.planReplace(s, { cancel, rate: r, ownSpk: W.script });
      rate0 = r;
      lines = linesFor(pr);
      if (pr.fee > 100000) lines.push('The new fee is high: check the rate.');
      $('ask-ok').disabled = false;
    } catch (e) {
      lines = [say(e.message)];
      $('ask-ok').disabled = true;
    }
    for (const l of lines) {
      const p = document.createElement('p');
      p.textContent = l;
      text.appendChild(p);
    }
  };
  inp.oninput = paint;
  box.append(text, field);
  paint();
  if (
    !(await ask(
      s.kind === 'cancel' ? 'Raise the fee of the cancel' : cancel ? 'Cancel the payment' : 'Raise the fee',
      [box],
      cancel ? 'Cancel the payment' : 'Raise the fee',
      cancel,
      'Keep it as it is',
    )) ||
    sending ||
    !s.pending ||
    s.replacedBy ||
    !canAct()
  )
    return;
  if (trust().level === 'bad') throw new Error('the block source disagrees with the signed chain tip: wait until that clears');
  const { outputs, fee, amount, change } = pr;
  {
    const again = WL.planReplace(s, { cancel, rate: rate0, ownSpk: W.script });
    if (again.fee !== fee || again.amount !== amount) throw new Error('the figures changed while you were deciding; nothing was sent');
  }
  sending = true;
  try {
    const tx = WL.unsignedTx({ picked, outputs });
    const { hex, txid, vsize } = await signCheck(
      tx,
      picked.map((c) => ({ value: c.value, scriptPubKey: W.script })),
    );
    if (fee < s.fee + vsize)
      throw new Error(
        `the signed replacement came out larger than estimated (${vsize} vB), so its fee is too low to replace; nothing was sent`,
      );
    const r = S.replacementRecord(s, pr, { cancel, txid, hex, address: W.address, script: W.script, tip: W.height });
    s.replacedBy = txid;
    sent.push(r);
    if (!saveSent()) {
      delete s.replacedBy;
      sent = sent.filter((x) => x !== r);
      throw new Error('the replacement could not be recorded in this browser (storage full or blocked), so it was not sent');
    }
    renderWallet();
    const pub = await publishHex(hex);
    r.lastPub = Date.now();
    r.relays = pub.ok;
    saveSent();
    renderWallet();
    notify(
      cancel ? 'Cancel sent' : 'Fee raised',
      pub.ok.length
        ? 'the replacement is with the relays; the Transactions page shows which version a block takes'
        : 'no relay took the replacement yet; it is published again every 10 minutes',
      !pub.ok.length,
    );
  } finally {
    sending = false;
    renderWallet();
  }
}
// forget a payment that has waited long and is nowhere to be seen: its coins are released for other payments
async function forgetFlow(s0) {
  if (!canAct() || !S.forgettable(sent, s0, W.height, inMempool)) return;
  const s = S.newestOf(sent, s0);
  const worth = s.values ? s.values.reduce((a, v) => a + v, 0) : (s.inputs ?? []).reduce((a, k2) => a + (seen.get(k2) ?? 0), 0);
  if (s.hex && s.values) {
    const a = await ask(
      'This payment has not gone through',
      [
        `It has waited ${n(W.height - s.tip)} blocks and no node here has it. The safe way out is to cancel it: a new transaction pays its coins back to you, and once that is in a block the old one can never go through.`,
        'Forgetting it instead frees its coins at once, without a new transaction.',
      ],
      'Cancel the payment (safe)…',
      false,
      'Forget it…',
      true,
      false,
      { label: 'Keep waiting', value: null, focus: true },
    );
    if (a === true) return replaceFlow(s, true);
    if (a === null) return;
  }
  if (
    !(await ask(
      'Forget this payment',
      [
        `Forgetting it makes its coins (${exact(worth)}) spendable again. The signed transaction may still exist somewhere, so your next payment will spend one of these coins first: then only one of the two can ever go through, and you cannot pay twice by accident.`,
        'If the forgotten one is mined after all, Reef shows it as confirmed.',
      ],
      'Forget it',
      true,
      'Keep waiting',
    ))
  )
    return;
  S.forget(sent, s);
  saveSent();
  renderWallet();
}
// every minute: payments not yet in a block are published again (relays do not keep these events)
function tick() {
  guardKey();
  if (!canAct()) return;
  for (const s of S.republishDue(sent, Date.now())) publishAgain(s).catch(() => {});
  renderWallet();
}
setInterval(tick, 60000);

// ---- the key: shown, exported in the forms other wallets read, backed up before it holds anything that matters
function openBackup() {
  if (!W) return;
  const wif = WL.toWif(W.key, W.hash.sha256);
  let handled = false;
  const arm = () => {
    handled = true;
    $('bk-done').disabled = false;
  };
  $('bk-addr').textContent = W.address;
  $('bk-wif').value = '•'.repeat(52);
  $('bk-desc').value = '•'.repeat(40);
  $('bk-show').setAttribute('aria-pressed', 'false');
  $('bk-wif').setAttribute('aria-label', 'Key, hidden: choose Show');
  $('bk-desc').setAttribute('aria-label', 'Descriptor, hidden: choose Show');
  $('bk-show').textContent = 'Show';
  $('bk-done').checked = backedUp();
  $('bk-done').disabled = !backedUp();
  $('bk-note').textContent = backedUp() ? '' : 'Show, copy or save the key first; then tick the box.';
  $('bk-show').onclick = () => {
    const shown = !$('bk-wif').value.startsWith('•');
    $('bk-wif').value = shown ? '•'.repeat(52) : wif;
    $('bk-desc').value = shown ? '•'.repeat(40) : WL.rawtrDescriptor(wif);
    $('bk-show').textContent = shown ? 'Show' : 'Hide';
    $('bk-show').setAttribute('aria-pressed', String(!shown));
    $('bk-wif').setAttribute('aria-label', shown ? 'Key, hidden: choose Show' : 'Key (WIF)');
    $('bk-desc').setAttribute('aria-label', shown ? 'Descriptor, hidden: choose Show' : 'Descriptor');
    // seeing the key is not saving it: the box is ticked only after Copy or Save
  };
  $('bk-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(wif);
      arm();
      $('bk-note').textContent =
        'the key (WIF) is on the clipboard: paste it into your password manager now, then copy something else over it';
    } catch {
      $('bk-note').textContent = 'the browser did not allow copying: use Show and copy it by hand';
    }
  };
  $('bk-file').onclick = () => {
    const txt = `Reef wallet key — txbt4 (BLAKE2b testnet4) test coins\nKeep this private: anyone with it can spend the coins.\n\naddress:    ${W.address}\nWIF:        ${wif}\ndescriptor: ${WL.rawtrDescriptor(wif)}\nhex:        ${W.key}\n\nThe address is the key-path output of the key itself (rawtr), not a BIP 86 tr() address.\nSaved ${new Date().toISOString()} from ${location.origin}${location.pathname}\n`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain' }));
    a.download = `reef-key-${W.address.slice(0, 12)}.txt`;
    a.click();
    arm();
    $('bk-note').textContent = 'saved as a file: keep it somewhere only you can read, off this computer too';
  };
  const close = () => {
    $('bk-wif').value = '';
    $('bk-desc').value = '';
    $('backup').close();
  };
  $('bk-ok').onclick = () => {
    if ($('bk-done').checked && (handled || backedUp())) {
      LS.set(backupKey(), String(Date.now()));
      unbanner('backup');
    } else if (!$('bk-done').checked) LS.del(backupKey());
    close();
    backupNudge();
  };
  $('bk-cancel').onclick = close;
  $('backup').onclose = () => {
    $('bk-wif').value = '';
    $('bk-desc').value = '';
  };
  $('backup').showModal();
}
function backupNudge(urgent = false) {
  if (!W || backedUp() || IDLE) {
    unbanner('backup');
    return;
  }
  const has = W.coins.length > 0 || ledger.size > 0 || sent.length > 0;
  banner(
    'backup',
    has || urgent ? 'bad' : 'warn',
    has
      ? `This wallet holds coins and its key is not backed up. The key lives only in this browser: clearing site data, or the browser freeing space, would lose the coins.`
      : 'Back up your wallet key before you receive anything: it lives only in this browser.',
    [['Back up now…', () => openBackup()]],
  );
}
// the keys this browser used before: listed in Options, switched back to, or copied
const oldKeys = () => loadJSON('reef:oldkeys', []).filter((x) => /^[0-9a-f]{64}$/.test(x.key ?? '') && x.key !== W?.key);
const badKeys = () => loadJSON('reef:oldkeys', []).filter((x) => !/^[0-9a-f]{64}$/.test(x.key ?? ''));
function renderOldKeys() {
  const list = oldKeys();
  const bk = (x) =>
    !!LS.get(
      'reef:backup:' +
        (() => {
          try {
            return W.signer.pubkeyOf(x.key).slice(0, 16);
          } catch {
            return '';
          }
        })(),
    );
  $('o-oldkeys').innerHTML = list.length
    ? list
        .map(
          (x, i) =>
            `<div class="row wrap"><span class="mono">${esc(x.address ?? '(an address)')}</span><span class="note">${x.at ? new Date(x.at).toLocaleDateString() : ''} · ${bk(x) ? 'backed up' : 'NOT backed up'}</span><button type="button" data-ok="${i}" data-a="copy">Copy its key…</button><button type="button" data-ok="${i}" data-a="use">Use it again</button><button type="button" data-ok="${i}" data-a="del">Remove…</button></div>`,
        )
        .join('')
    : '<span class="note">none</span>';
  if (badKeys().length)
    $('o-oldkeys').insertAdjacentHTML(
      'beforeend',
      `<div class="note">${badKeys().length} unreadable stored value(s) kept in this site's storage under reef:oldkeys; they may be a damaged key: keep a copy of the site data before clearing it.</div>`,
    );
  $('o-oldkeys')
    .querySelectorAll('button')
    .forEach((b) => {
      b.onclick = async () => {
        const x = oldKeys()[b.dataset.ok];
        if (!x) return;
        if (b.dataset.a === 'copy') {
          try {
            await navigator.clipboard.writeText(WL.toWif(x.key, W.hash.sha256));
            b.textContent = 'Copied';
            $('o-keywarn').textContent = 'the earlier key is on the clipboard: paste it where it belongs, then copy something else over it';
          } catch {}
        } else if (IDLE || !RUNNING) {
          $('o-keywarn').textContent = 'keys are managed in the tab that runs the node';
        } else if (b.dataset.a === 'use') {
          $('o-importkey').value = '';
          $('o-importkey').dataset.use = x.key;
          $('o-keywarn').textContent =
            `press OK to switch back to the key of ${x.address ?? 'that address'}; coins sent to the other address later will not show while this key is in use`;
        } else {
          $('options').close();
          if (
            await ask(
              'Remove an earlier key',
              [
                `${x.address ?? 'This key'} ${bk(x) ? 'is backed up' : 'is NOT backed up'}. Removing it from this browser loses any coins at its address unless you have a copy (Keep it, then Copy its key…). Its payment history in this browser goes with it.`,
                ...((() => {
                  try {
                    return loadJSON('reef:sent:' + W.signer.pubkeyOf(x.key).slice(0, 16), []).some((r) => r.pending);
                  } catch {
                    return false;
                  }
                })()
                  ? [
                      'It still has a payment waiting or forgotten: its signed transaction may yet be mined. Keep the key until that is settled.',
                    ]
                  : []),
              ],
              'Remove it',
              true,
              'Keep it',
            )
          ) {
            LS.set('reef:oldkeys', JSON.stringify(loadJSON('reef:oldkeys', []).filter((y) => y.key !== x.key)));
            try {
              const pk = W.signer.pubkeyOf(x.key);
              const tg = pk.slice(0, 16);
              for (const k3 of ['sent', 'seen', 'ledger', 'quarantine']) LS.del(`reef:${k3}:${tg}`);
              LS.del('reef:backup:' + pk.slice(0, 16));
            } catch {}
          }
          openOptions('wallet');
        }
      };
    });
}
// ---- notices: a toast in the page and, if allowed, a browser notification
function notify(title, body, bad = /not |did not|failed|stopped/i.test(title)) {
  cprint(`· ${title}: ${body}`, 'log');
  if (!$('tray').hidden) {
    unseen++;
    $('tray-badge').textContent = unseen;
    $('tray-badge').setAttribute('aria-label', `${unseen} new notice${unseen === 1 ? '' : 's'}`);
    $('tray-badge').hidden = false;
  }
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' badt' : '');
  const b = document.createElement('b');
  b.textContent = title;
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'tx';
  x.textContent = '×';
  x.setAttribute('aria-label', 'Dismiss notice: ' + title);
  // a toast that goes away while it holds the focus hands it on, never to <body>
  const gone = () => {
    const had = el.contains(document.activeElement);
    el.remove();
    if (had) (document.querySelector('.toast .tx') ?? document.querySelector('.tool button.on'))?.focus();
  };
  x.onclick = gone;
  el.append(b, document.createElement('br'), document.createTextNode(body), x); // the words first: a live region reads in order
  (bad ? $('toasts-alert') : $('toasts')).appendChild(el);
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        el.classList.add('out');
        setTimeout(gone, 400);
      },
      bad ? 30000 : 20000,
    );
  };
  // hovered or focused, it stays (focusin/focusout are events, not on* properties)
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('focusin', () => clearTimeout(timer));
  el.addEventListener('mouseleave', arm);
  el.addEventListener('focusout', arm);
  arm();
  if (OPT.notify && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(`Reef · ${title}`, { body: OPT.mask ? 'open Reef to see the details' : body, icon: 'og.png' });
    } catch {}
  }
}
// ---- the node window's pages
function renderMempool() {
  const m = node.mempool;
  if (!m) return;
  const now = Math.floor(Date.now() / 1000);
  const med = mempoolRate();
  $('mp-sum').textContent =
    `${n(m.count)} transaction${m.count === 1 ? '' : 's'} · ${n(m.bytes)} vB · ${n(m.fees)} sat in fees${med != null ? ` · median ${med} sat/vB` : ''} · at height ${n(m.height ?? 0)}`;
  $('mprows').innerHTML = m.txs.length
    ? m.txs
        .map((t) => {
          const o = W ? ourTx(t) : { spendsOurs: false, toUs: 0 };
          const age = Math.max(0, now - t.at);
          return `<tr><td class="mono">${txLink(t.txid, t.txid.slice(0, 16) + '…')}</td><td>${age < 60 ? age + ' s' : age < 3600 ? Math.round(age / 60) + ' min' : (age / 3600).toFixed(1) + ' h'}</td><td class="amt">${esc(n(t.vsize))}</td><td class="amt">${esc(n(t.fee))}</td><td class="amt">${Number(t.feeRate).toFixed(1)}</td><td>${o.spendsOurs ? 'from you' : o.toUs ? 'to you: ' + amtHtml(o.toUs) : ''}</td></tr>`;
        })
        .join('')
    : '<tr><td colspan="6" class="mut">empty</td></tr>';
}
function mempoolRate() {
  const m = node.mempool;
  if (!m || !m.txs.length) return null;
  const r = m.txs.map((t) => t.feeRate).sort((a, b) => a - b);
  return Math.max(1, Math.ceil(r[Math.floor(r.length / 2)]));
}
const fileReady = () => !!(node.sha || node.st?.idx > 0);
function renderPeers() {
  const rows = [
    [BLOCKS_URL.replace(/^https?:\/\//, ''), 'mirror', 'block file, Range', `${(node.recv / 1e6).toFixed(2)} MB`],
    ...TIP_RELAYS.map((r) => [r.replace('wss://', ''), 'relay', 'signed chain tips (NIP-333)', '—']),
    ...RELAYS().map((r) => [r.replace('wss://', ''), 'relay', 'payments (kind 23503)', '—']),
    ...(tn.seeding?.t
      ? tn.seeding.t.wires
          .filter((w) => !w.destroyed)
          .map((w) => [
            w.peerId ? w.peerId.slice(0, 20) + '…' : '(peer)',
            w.type === 'webSeed' ? 'webseed' : 'swarm peer',
            'snapshot pieces (WebRTC)',
            `${(w.uploaded / 1e6).toFixed(2)} MB sent`,
          ])
      : []),
  ];
  // a grid: one tab stop, Up and Down move, Enter or Space shows the details; the selection and focus survive the refresh
  const hadFocus = $('peerrows').contains(document.activeElement);
  peerSel = Math.min(peerSel, rows.length - 1);
  $('peerrows').closest('table').setAttribute('role', 'grid');
  $('peerrows').innerHTML = rows
    .map(
      (p, i) =>
        `<tr data-i="${i}" tabindex="${i === Math.max(0, peerSel) ? 0 : -1}" aria-selected="${i === peerSel}" class="${i === peerSel ? 'sel' : ''}"><td>${i + 1}</td><td>${Math.round((Date.now() - T0) / 60000)} min</td><td>Outbound</td><td>${esc(p[2])}</td><td>${esc(p[1])}</td><td>—</td><td>${p[1] === 'swarm peer' ? esc(p[3].replace(' sent', '')) : '0 MB'}</td><td>${p[1] === 'swarm peer' ? '—' : esc(p[3])}</td><td class="mono">${esc(p[0])}</td></tr>`,
    )
    .join('');
  const trs = [...document.querySelectorAll('#peerrows tr')];
  const pick = (i) => {
    peerSel = i;
    trs.forEach((x, j) => {
      x.classList.toggle('sel', j === i);
      x.setAttribute('aria-selected', String(j === i));
      x.tabIndex = j === i ? 0 : -1;
    });
    const p = rows[i];
    $('pd').innerHTML =
      `<div class="kv"><span class="l">Peer</span><span class="v">${esc(p[0])}</span><span class="l">Kind</span><span class="v">${esc(p[1])}: ${esc(p[2])}</span><span class="l">Note</span><span class="v">a tab does not speak the peer-to-peer protocol; it reads a mirror's block file and signed tip announcements, and validates everything itself</span></div>`;
  };
  trs.forEach((tr, i) => {
    tr.onclick = () => pick(i);
    tr.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick(i);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const j =
          e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? trs.length - 1
              : Math.max(0, Math.min(trs.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
        trs[i].tabIndex = -1;
        trs[j].tabIndex = 0;
        trs[j].focus();
      }
    };
  });
  if (hadFocus) trs[Math.max(0, peerSel)]?.focus({ preventScroll: true });
}
let peerSel = -1;
renderPeers();
// ---- console, answering from the tab's state in the shapes Knots uses
const cout = $('cout'),
  cin = $('cin');
const chist = [];
let hi = 0;
const err = (code, message) => ({ __err: { code, message } });
function cprint(s, cls) {
  const el = document.createElement('span');
  if (cls) el.className = cls;
  el.textContent = s + '\n';
  cout.appendChild(el);
  while (cout.childNodes.length > 2000) cout.removeChild(cout.firstChild);
  cout.scrollTop = cout.scrollHeight;
}
const ANS = {
  getblockchaininfo: () => ({
    chain: 'testnet4',
    blocks: node.height,
    headers: node.nostr?.height ?? node.height,
    bestblockhash: node.hash,
    time: node.time,
    verificationprogress: node.synced ? 1 : 0,
    initialblockdownload: !node.synced,
    pruned: false,
    size_on_disk: node.st?.dat ?? null,
    warnings: [
      `synced from the verified UTXO snapshot at 150307 (hash_serialized_3 ${node.hs ? node.hs.slice(0, 16) + '…' : 'pending'}); BLAKE2b blocks since the fork validated in this tab`,
      trust().text,
    ],
  }),
  getblockcount: () => node.height,
  getbestblockhash: () => node.hash,
  getsnapshotinfo: () => ({
    base_height: 150307,
    base_hash: node.st?.expect.baseHash,
    hash_serialized_3: node.hs ?? node.st?.expect.txoutsetHash,
    verified: node.hsOk ?? node.st?.idx > 0,
    sha256: node.sha ?? node.st?.sha ?? null,
    coins: node.coins ?? node.st?.expect.coins,
    txids: node.txids ?? null,
    bytes: node.st?.expect.bytes,
    source: SNAP_URL,
    sync_history: Object.fromEntries(node.hist.map(([k, v]) => [k, +(v / 1000).toFixed(1)])),
  }),
  gettxoutsetinfo: () => ({
    height: node.height,
    bestblock: node.hash,
    txouts: node.coins,
    hash_serialized_3: node.hs ?? '(not recomputed at the tip; the snapshot base is)',
    note: "the count is the snapshot's plus the blocks applied since; a full recount at the tip is not offered by the tab yet",
  }),
  getnetworkinfo: () => ({
    version: 1,
    subversion: `/Reef:${VERSION}/`,
    networkactive: true,
    connections: 1 + TIP_RELAYS.length,
    networks: [
      { name: 'mirror', reachable: true, url: BLOCKS_URL },
      { name: 'nostr', reachable: true, relays: TIP_RELAYS },
    ],
    warnings: ['a tab reads a mirror and relays; it does not speak the peer-to-peer protocol'],
  }),
  getpeerinfo: () => [
    { id: 0, addr: BLOCKS_URL, kind: 'mirror', bytesrecv: node.recv },
    ...TIP_RELAYS.map((r, i) => ({ id: i + 1, addr: r, kind: 'relay' })),
  ],
  getmempoolinfo: () =>
    node.mempool
      ? {
          loaded: true,
          size: node.mempool.count,
          bytes: node.mempool.bytes,
          usage: node.mempool.bytes,
          total_fee: node.mempool.fees / 1e8,
          mempoolminfee: 0.00001,
          minrelaytxfee: 0.00001,
          refused: node.mempool.stats.refused,
          dropped: node.mempool.stats.dropped,
          note: "this tab's own mempool: transactions heard on relays and validated here",
        }
      : err(-28, 'the mempool is followed once the tab is up to date'),
  getrawmempool: (a) =>
    node.mempool
      ? a[0] === 'true'
        ? Object.fromEntries(
            node.mempool.txs.map((t) => [t.txid, { vsize: t.vsize, fees: { base: t.fee / 1e8 }, time: t.at, feerate: t.feeRate }]),
          )
        : node.mempool.txs.map((t) => t.txid)
      : err(-28, 'the mempool is followed once the tab is up to date'),
  getmempoolentry: (a) => {
    const t = node.mempool?.txs.find((x) => x.txid === String(a[0] ?? '').toLowerCase());
    return t
      ? { txid: t.txid, vsize: t.vsize, fees: { base: t.fee / 1e8 }, time: t.at, feerate: t.feeRate, inputs: t.inputs, outputs: t.outputs }
      : err(-5, 'Transaction not in mempool');
  },
  getnostrtip: () =>
    node.nostr
      ? {
          height: node.nostr.height,
          hash: node.nostr.hash,
          relay: node.nostr.relay,
          created_at: node.nostr.created_at,
          agree: node.nostr.agree,
          diverged: !!node.nostr.diverged,
          live: !!node.nostr.live,
        }
      : err(-1, 'no tip announcement seen yet'),
  gettxout: (a) => {
    if (!/^[0-9a-f]{64}$/i.test(a[0] ?? '') || !/^\d+$/.test(a[1] ?? '')) return err(-8, 'gettxout "txid" n');
    post({ type: 'coin', key: `${a[0].toLowerCase()}:${a[1]}` });
    return '(asked the node; the answer prints when it arrives)';
  },
  getblockhash: (a) => {
    const h = Number(a[0]);
    if (!/^\d+$/.test(a[0] ?? '')) return err(-8, 'getblockhash height');
    if (h === 150307) return node.st?.expect.baseHash;
    if (!node.synced) return err(-28, 'still syncing');
    if (h < 150308 || h > node.height)
      return err(
        -8,
        `Block height out of range: this tab holds ${n(150308)} to ${n(node.height)} (the BLAKE2b blocks; the snapshot base is 150307)`,
      );
    post({ type: 'block', height: h, req: 'hash' });
    return '(reading the block file…)';
  },
  getblock: (a) => {
    if (!node.synced) return err(-28, 'still syncing');
    if (/^[0-9a-f]{64}$/i.test(a[0] ?? '')) post({ type: 'block', hash: a[0].toLowerCase(), req: 'block' });
    else if (/^\d+$/.test(a[0] ?? '')) post({ type: 'block', height: Number(a[0]), req: 'block' });
    else return err(-8, 'getblock "blockhash" (or a height)');
    return '(reading the block file…)';
  },
  getblockheader: (a) => ANS.getblock(a),
  uptime: () => Math.floor((Date.now() - T0) / 1000),
  getbalance: () => (W?.coinsKnown ? wallBal().available / 1e8 : err(-18, 'wallet not ready')),
  getwalletinfo: () =>
    W?.coinsKnown
      ? {
          walletname: 'reef',
          format: 'one key in this tab (rawtr)',
          balance: wallBal().available / 1e8,
          unconfirmed_balance: wallBal().pending / 1e8,
          immature_balance: wallBal().immature / 1e8,
          txcount: ledger.size + sent.length,
          keypoolsize: 1,
          descriptors: true,
          backed_up: backedUp(),
          note: 'coins created since the snapshot; the tab does not scan the snapshot itself for a script',
        }
      : err(-18, 'wallet not ready'),
  getnewaddress: () => (W ? W.address : err(-18, 'wallet not ready')),
  getaddressinfo: (a) => {
    if (!W) return err(-18, 'wallet not ready');
    const d = W.addr.decodeAddress(a[0] ?? '');
    return d
      ? {
          address: a[0],
          scriptPubKey: d.script,
          ismine: d.script === W.script,
          iswitness: true,
          witness_version: d.version,
          witness_program: d.program,
          sendable: !WL.checkDestination(d).error,
        }
      : err(-5, 'Invalid address');
  },
  listunspent: () =>
    W
      ? W.coins.map((c) => ({
          txid: c.key.slice(0, 64),
          vout: Number(c.key.slice(65)),
          address: W.address,
          scriptPubKey: W.script,
          amount: c.value / 1e8,
          confirmations: W.height != null ? W.height - c.height + 1 : null,
          spendable: WL.isMature(c, W.height),
          coinbase: !!c.coinbase,
        }))
      : err(-18, 'wallet not ready'),
  sendtoaddress: () => err(-4, 'send from the Send page, where the payment is shown and confirmed before it leaves'),
  listsent: () => sent.map(({ hex, ...s }) => s),
  help: () =>
    `== Blockchain ==\ngetbestblockhash\ngetblock "blockhash" | height\ngetblockchaininfo\ngetblockcount\ngetblockhash height\ngetsnapshotinfo\ngettxout "txid" n\ngettxoutsetinfo\n\n== Control ==\nhelp\nuptime\n\n== Mempool ==\ngetmempoolentry "txid"\ngetmempoolinfo\ngetrawmempool [true]\n\n== Network ==\ngetnetworkinfo\ngetnostrtip\ngetpeerinfo\n\n== Wallet ==\ngetaddressinfo "address"\ngetbalance\ngetnewaddress\ngetwalletinfo\nlistsent\nlistunspent`,
};
cin.onkeydown = (e) => {
  if (e.key === 'ArrowUp') {
    hi = Math.max(0, hi - 1);
    cin.value = chist[hi] ?? '';
  } else if (e.key === 'ArrowDown') {
    hi = Math.min(chist.length, hi + 1);
    cin.value = chist[hi] ?? '';
  } else if (e.ctrlKey && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    cout.textContent = '';
  } else if (e.key === 'Enter') {
    const line = cin.value.trim();
    cin.value = '';
    if (!line) return;
    chist.push(line);
    hi = chist.length;
    cprint('> ' + line, 'cmd');
    const [cmd, ...args] = line.split(/\s+/);
    const f = Object.hasOwn(ANS, cmd) ? ANS[cmd] : null;
    // the log itself is quiet for screen readers; each answer is said once, in one line
    const say1 = (t) => sayOnce(`${cmd}: ${String(t).split('\n')[0].slice(0, 140)}`);
    if (!f) return cprint('Method not found (code -32601)', 'err'), say1('error: method not found');
    if (IDLE && !['help', 'uptime'].includes(cmd))
      return (
        cprint('The node runs in another tab of this browser: ask there (code -1)', 'err'), say1('error: the node runs in another tab')
      );
    let a;
    try {
      a = f(args.map((x) => x.replace(/^"|"$/g, '')));
    } catch (x) {
      return cprint(x.message, 'err'), say1('error: ' + x.message);
    }
    if (a && a.__err) return cprint(`${a.__err.message} (code ${a.__err.code})`, 'err'), say1('error: ' + a.__err.message);
    const out = typeof a === 'string' ? a : JSON.stringify(a, null, 2);
    cprint(out);
    say1(typeof a === 'object' && a ? `${Object.keys(a).length} fields, shown in the console` : out);
  }
};
// received bytes sampled every five seconds: the rate drawn as a line, the same in words for a screen reader
const trafficSamples = [];
setInterval(() => {
  trafficSamples.push({ t: Date.now(), recv: node.recv ?? 0 });
  if (trafficSamples.length > 360) trafficSamples.shift();
  if (document.querySelector('#nwtabs [role=tab][aria-selected=true]')?.dataset.t === 'traffic') drawTraffic();
}, 5000);
function drawTraffic() {
  const c = $('trc'),
    dpr = devicePixelRatio;
  c.width = c.clientWidth * dpr;
  c.height = 260 * dpr;
  const x = c.getContext('2d');
  const css = getComputedStyle(document.body);
  x.clearRect(0, 0, c.width, c.height);
  x.strokeStyle = css.getPropertyValue('--line2') || '#ddd';
  for (let i = 1; i < 5; i++) {
    x.beginPath();
    x.moveTo(0, (c.height * i) / 5);
    x.lineTo(c.width, (c.height * i) / 5);
    x.stroke();
  }
  const rates = trafficSamples
    .slice(1)
    .map((s2, i) => Math.max(0, (s2.recv - trafficSamples[i].recv) / ((s2.t - trafficSamples[i].t) / 1000)));
  const top = Math.max(1024, ...rates);
  if (rates.length > 1) {
    x.strokeStyle = css.getPropertyValue('--green') || '#2a8c3a';
    x.lineWidth = 2 * dpr;
    x.beginPath();
    rates.forEach((r, i) => {
      const px = (i / (rates.length - 1)) * c.width,
        py = c.height - (r / top) * (c.height - 24 * dpr);
      i ? x.lineTo(px, py) : x.moveTo(px, py);
    });
    x.stroke();
  }
  const now = rates.at(-1) ?? 0;
  const words = `received ${(node.recv / 1e6).toFixed(2)} MB in this session; now ${(now / 1024).toFixed(1)} KB/s, peak ${(top / 1024).toFixed(1)} KB/s over the last ${Math.round((trafficSamples.length * 5) / 60)} minutes`;
  x.fillStyle = css.getPropertyValue('--mut') || '#555';
  x.font = `${12 * dpr}px DejaVu Sans, sans-serif`;
  x.fillText(words, 8 * dpr, 16 * dpr);
  c.setAttribute('aria-label', 'Network traffic: ' + words);
}
// ---- diagnostics a person can paste into an issue: no key, no addresses of others
async function copyDiagnostics() {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => null);
  const d = {
    reef: VERSION,
    node: NODE.slice(-40),
    lib: LIB.match(/@([0-9a-f]{40})/)?.[1],
    engine: CDN.slice(-40),
    ua: navigator.userAgent,
    embedded,
    storage: est ? { usage: est.usage, quota: est.quota } : null,
    persisted,
    phase: node.phase,
    synced: !!node.synced,
    height: node.height,
    error: node.error ?? null,
    lastError: node.lastError ?? null,
    trust: trust(),
    hist: node.hist,
    mempool: node.mempool
      ? {
          count: node.mempool.count,
          stats: node.mempool.stats,
          following: node.mempool.following ?? null,
          lastFeedAt: node.mempool.lastFeedAt ?? null,
          feedFileAt: node.mempool.feedFileAt ?? null,
        }
      : null,
    nodeState: {
      unresponsive: !!node.unresponsive,
      seedUnsupported: !!node.seedUnsupported,
      retryAt: node.retryAt ?? null,
      lockError: node.lockError ?? null,
    },
    sources: { snapshot: SNAP_URL === DEFAULT_SNAP ? 'default' : SNAP_URL, blocks: BLOCKS_URL === DEFAULT_BLOCKS ? 'default' : BLOCKS_URL },
    wallet: W
      ? {
          coins: W.coins.length,
          pending: sent.filter((s) => s.pending).length,
          backedUp: backedUp(),
          setAside: quarantineStored().length,
          lastPublish: loadJSON('reef:lastpublish', null),
        }
      : null,
    pageErrors,
    tab: { idle: IDLE, running: RUNNING, schema: LS.get('reef:schema'), schemaHere: SCHEMA, online: navigator.onLine },
    time: { now: Date.now(), skewMs: clockSkew, tipTime: node.time, lastSync: node.lastSync ?? null },
    tip: node.nostr
      ? { height: node.nostr.height, created_at: node.nostr.created_at, live: !!node.nostr.live, relay: node.nostr.relay }
      : null,
    options: {
      relays: OPT.relays ? (OPT.relays.join() === DEFAULT_RELAYS.join() ? 'default' : OPT.relays.length) : 'default',
      torrent: !!OPT.torrent,
      seed: !!OPT.seed,
    },
    log: [...cout.childNodes].slice(-200).map((x) =>
      x.textContent
        .trim()
        .replace(/\b(tb1|bc1|bcrt1)[0-9a-z]{20,}/gi, '<address>')
        .replace(/\b[0-9a-f]{64}\b/g, '<txid>'),
    ),
  };
  const text = JSON.stringify(d, null, 1);
  try {
    await navigator.clipboard.writeText(text);
    notify('Diagnostics copied', 'paste them into an issue on GitHub; they hold no key');
  } catch {
    // no clipboard: the text in a dialog, selected, to copy by hand
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.readOnly = true;
    ta.rows = 12;
    ta.style.width = '100%';
    ta.setAttribute('aria-label', 'Diagnostics');
    setTimeout(() => ta.select(), 50);
    await ask(
      'Diagnostics',
      ['The browser did not allow copying. Select the text below and copy it (it holds no key):', ta],
      'Done',
      false,
      'Close',
    );
  }
}
// ---- a newer Reef: checked every hour, offered, never forced
// "2026-10-01.19" → comparable: a stale copy at the web host never offers an older version as newer
const versionKey = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})\.(\d+)$/.exec(String(v ?? ''));
  return m ? [+m[1], +m[2], +m[3], +m[4]] : null;
};
const newer = (a, b) => {
  const x = versionKey(a),
    y = versionKey(b);
  if (!x || !y) return false;
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
let clockSkew = null;
async function checkVersion() {
  try {
    const r = await fetch('version.json', { cache: 'no-cache' });
    // the web host's clock against this one: a clock far off makes relays refuse payments and live feeds go quiet
    const served = Date.parse(r.headers.get('date') ?? '');
    if (Number.isFinite(served)) {
      clockSkew = Date.now() - served;
      if (Math.abs(clockSkew) > 120e3)
        banner(
          'clock',
          'warn',
          `This computer's clock is ${Math.round(Math.abs(clockSkew) / 60e3)} minutes ${clockSkew > 0 ? 'ahead' : 'behind'}. Relays may refuse payments and live updates may stop: set the clock automatically in the system settings.`,
        );
      else unbanner('clock');
    }
    const v = await r.json();
    if (v.version && newer(v.version, VERSION))
      banner(
        'update',
        'info',
        `A newer Reef is available (${v.version}). Reload to use it; the node and the wallet carry on where they are. The web host can take up to ten minutes to serve it everywhere.`,
        [
          [
            'Reload',
            () => {
              location.search = (keepQuery() ? keepQuery() + '&' : '?') + 'v=' + encodeURIComponent(v.version);
            },
          ],
        ],
      );
  } catch {}
}
setTimeout(checkVersion, 5e3);
setInterval(checkVersion, 3600e3);

// ---- start: one tab of this origin runs the node and the wallet; the first visit asks before fetching 830 MB
const walletStarting = walletInit();
walletStarting.then(() => unbanner('walleterr')).catch(() => {}); // a slow CDN that answers after all: the notice goes
const walletReady = Promise.race([
  walletStarting,
  new Promise((_, no) =>
    setTimeout(() => no(new Error('its code did not load in 30 seconds (the CDN, cdn.jsdelivr.net, may be unreachable)')), 30e3),
  ),
]).catch((e) => {
  cprint('wallet could not start: ' + e.message, 'err');
  $('rcvaddr').value = 'the wallet could not start: ' + e.message;
  banner('walleterr', 'bad', 'The wallet could not start: ' + e.message + '. Reload to try again.', [['Reload', () => location.reload()]]);
});
tn.on('message', onMessage);
tn.on('sync', ({ msg, pct, eta }) => {
  setSync(msg, pct, eta);
  if (W && !W.coinsKnown) renderWallet();
});
tn.on('hist', renderHist);
tn.on('log', ({ text, level }) => cprint(level === 'err' ? text : '· ' + text, level));
tn.on('seeding', () => {
  if (document.querySelector('#nwtabs [aria-selected=true]')?.dataset.t === 'peers') renderPeers();
  renderInfo();
});
applyDisplay();
document.querySelectorAll('label').forEach((l) => {
  if (l.htmlFor || l.querySelector('input,select,textarea')) return;
  const nx = l.nextElementSibling;
  const inp = nx?.matches?.('input,textarea,select') ? nx : nx?.querySelector?.('input,textarea,select');
  if (inp?.id) l.htmlFor = inp.id;
});
if (embedded && document.hasStorageAccess)
  document
    .hasStorageAccess()
    .then((ok) => {
      if (!ok)
        banner(
          'embedded',
          'warn',
          'Inside this page the browser gives Reef separate storage: a different wallet key and a second copy of the snapshot than Reef opened on its own. To use your wallet, open Reef in its own tab.',
          [['Open Reef', () => window.open('https://bitcoin-blake.github.io/reef/', '_blank', 'noopener')]],
        );
    })
    .catch(() => {});
// the idle tab: one path, whether the probe or the loader found the node taken; it waits for the lock and offers to take over
// a tab that does not run the wallet: what would change it stays focusable where it explains itself, and says why
function readOnlyPage() {
  for (const id of ['sendto', 'sendamt', 'sendunit', 'sendall', 'sendpaste']) $(id).disabled = true;
  for (const [id, why] of [
    ['sendgo', 'sendout'],
    ['feechoose', 'sendout'],
    ['txexport', null],
  ]) {
    $(id).setAttribute('aria-disabled', 'true');
    if (why) $(id).setAttribute('aria-describedby', why);
    $(id).title = 'the wallet runs in another tab: do this there';
  }
  $('cin').disabled = true;
  $('cin').placeholder = 'the node runs in another tab: use its console';
}
function goIdle() {
  IDLE = true;
  // the key is shared: an idle tab can still say whether it is backed up, next to the address it shows
  walletReady.then(() => {
    if (W && !backedUp())
      $('rcvpersist').textContent =
        'This key is not backed up: back it up in the tab that runs the node (Settings → Back up the wallet key).';
  });
  document.body.classList.add('idle');
  $('nwidle').hidden = false;
  unbanner('backup');
  $('m-wipe').setAttribute('aria-disabled', 'true');
  $('m-wipe').classList.add('off');
  $('m-wipe').setAttribute('aria-description', 'the node runs in another tab: wipe from there');
  $('m-wipe').title = 'the node runs in another tab: wipe from there';
  readOnlyPage();
  sendInfo('The node and the wallet run in another tab of this browser: send from there.');
  setSync('idle: the node runs in another tab of this browser', null);
  document.title = 'Reef · idle (open in another tab)';
  renderWallet();
  updatePreview();
  renderStatus();
  banner(
    'twotabs',
    'warn',
    "Reef is already open in another tab of this browser, or Bight, Winch or Hitch runs the node there. This tab stays idle and changes nothing: two tabs would fight over the node's files and could spend the same coins twice. It takes over as soon as the other tab closes.",
    [['Check again', () => location.reload()]],
  );
  const wait = () =>
    navigator.locks
      ?.request('bitcoin-blake:node', () => {})
      .then(() =>
        setTimeout(async () => {
          const q2 = await navigator.locks.query().catch(() => null);
          if ((q2?.held ?? []).some((l) => l.name === 'bitcoin-blake:node')) return wait();
          IDLE_TEXT = 'The other tab has closed: choose Run it here to run the node and the wallet in this tab.';
          setSync('the other tab has closed: this tab can run the node', null);
          renderWallet();
          renderStatus();
          banner('twotabs', 'info', 'The other tab has closed: this one can run the node now.', [['Run it here', () => location.reload()]]);
        }, 3500),
      )
      .catch(() => {});
  wait();
}
// the key in storage gone (site data cleared, a clear-on-exit in another window) while this tab still holds it: written back,
// and the person told to back it up now, since the next visit would otherwise make a new, empty key without a word
function guardKey() {
  if (!W || LS.get('reef:key') === W.key) return;
  // an idle tab holds the same key: it writes back the key alone (the records are the running tab's to write)
  if (IDLE || !RUNNING) return void LS.set('reef:key', W.key);
  const back = LS.set('reef:key', W.key);
  // everything this tab still holds goes back too: the records, what it has seen, the layout marker, that it has started
  if (back) {
    LS.set('reef:started', String(Date.now()));
    LS.set('reef:schema', String(SCHEMA));
    if (W.backedUpAtLoad) LS.set(backupKey(), String(Date.now()));
    saveSent();
    saveSeen();
    saveLedger();
  }
  banner(
    'keygone',
    'bad',
    back
      ? "This browser's storage was cleared while Reef was open. The key was written back from this tab, but the payment records may be gone: back up the key now with the button here."
      : "This browser's storage was cleared and refuses to keep the key. Back it up now with the button here before closing this tab, or the coins are lost with it.",
    [['Back up the key…', () => openBackup()]],
  );
}
addEventListener('storage', (e) => {
  if (e.key === null || e.key === 'reef:key') guardKey();
});
// clearing site data from the browser's settings fires no event here: check whenever the page may be left or reloaded
addEventListener('pagehide', () => guardKey());
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && guardKey());
addEventListener('storage', (e) => {
  if (!IDLE || !W || e.key !== sentKey()) return;
  try {
    const stored = JSON.parse(e.newValue ?? '[]').filter((x) => x && typeof x.txid === 'string');
    sent = W.validRecord ? S.sortStored({ sent: stored, ok: W.validRecord, seenHas: (k) => seen.has(k) }).keep : stored;
    renderWallet();
  } catch {}
});
async function startNode(force = false) {
  unbanner('welcome');
  try {
    const started = await tn.start({ force });
    if (started === false) {
      if (node.lockError) return lockFailed(node.lockError);
      goIdle();
    } else {
      // the stored records are sorted by walletInit, which may still be loading: write nothing until it has finished
      await walletReady;
      if (IDLE) return;
      RUNNING = true;
      LS.set('reef:schema', String(SCHEMA)); // only the tab that runs the node marks the layout
      // ask on every start, not only the first: a browser under disk pressure evicts a site it was not asked to keep
      navigator.storage
        ?.persist?.()
        .then((kept) => {
          if (kept === false && W && !backedUp())
            banner(
              'evictable',
              'warn',
              "This browser may clear the wallet and the node's files when the disk gets full. Back up the key, and if the browser offers it, allow this site to keep its data.",
              [['Back up the key…', () => openBackup()]],
            );
        })
        .catch(() => {});
      pendingSort?.();
      pendingSort = null;
      renderWallet();
      // a node whose code hangs while loading never says a word: after a minute of silence, that is said
      setTimeout(() => {
        if (!node.synced && !node.error && (node.phase === 'starting' || !node.phase))
          banner(
            'slowstart',
            'warn',
            'The node has said nothing for a minute: its code may not have loaded from the CDN (cdn.jsdelivr.net). Reload to try again.',
            [['Reload', () => location.reload()]],
          );
      }, 60e3);
    }
  } catch (e) {
    showFatal(plainError(e.message));
  }
}
function lockFailed(err) {
  setSync('not started: the browser refused the lock that keeps one node per browser', null);
  banner(
    'lockfail',
    'bad',
    `This browser refused the lock that keeps Reef to one tab (${err}). Running anyway is safe only if no other tab of Reef, Bight, Winch or Hitch is open.`,
    [
      [
        'Run anyway in this tab',
        () => {
          unbanner('lockfail');
          startNode(true);
        },
      ],
    ],
  );
}
function newerSchema() {
  IDLE = true;
  IDLE_TEXT = 'This copy of Reef is older than the one that wrote the wallet records here: reload for the newer version.';
  document.body.classList.add('idle');
  readOnlyPage();
  setSync('read-only: a newer Reef wrote the wallet records in this browser', null);
  banner(
    'schema',
    'bad',
    "This browser's wallet records were written by a newer Reef. This older copy stays read-only so it cannot damage them: reload to get the newer version.",
    [['Reload', () => location.replace(location.pathname + '?v=' + Date.now())]],
  );
  walletReady.then(() => (renderWallet(), updatePreview(), renderStatus()));
}
// what the node needs from the browser, checked before anything is downloaded: a browser without one of these would stop
// part-way through 830 MB
function missingFeatures() {
  const miss = [];
  if (!navigator.storage?.getDirectory) miss.push('a private file system for sites (OPFS)');
  if (typeof Worker === 'undefined') miss.push('web workers');
  if (typeof WebAssembly === 'undefined') miss.push('WebAssembly');
  if (!window.isSecureContext) miss.push('a secure (https) page');
  return miss;
}
const timeoutSignal = (ms) => {
  if (AbortSignal.timeout) return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
};
async function begin() {
  const miss = missingFeatures();
  if (miss.length) {
    PROBING = false;
    node.notStarted = true;
    setSync('not started: this browser lacks what the node needs', null);
    return banner(
      'nofeature',
      'bad',
      `This browser cannot run the node: it lacks ${miss.join(', ')}. Use a recent Chrome, Edge, Brave or Firefox, outside a private window.`,
    );
  }
  if (!navigator.locks) {
    PROBING = false;
    return lockFailed('this browser has no Web Locks');
  }
  try {
    await navigator.storage.getDirectory();
  } catch (e) {
    PROBING = false;
    node.notStarted = true;
    setSync('not started: this window cannot keep files', null);
    return banner(
      'nofeature',
      'bad',
      `This window cannot keep the node's files (${e?.name || e}): a private window cannot run the node, and its key would be gone when it closes. Open Reef in an ordinary window.`,
    );
  }
  // Safari deletes a site's storage after seven days without a visit, the key with it
  // (every browser on an iPhone or iPad is Safari underneath, with the same rule)
  if (/^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent) || /iPhone|iPad|iPod/.test(navigator.userAgent))
    banner(
      'safari',
      'warn',
      "Safari deletes this site's data after seven days without a visit: the wallet key, and the 830 MB the node fetched. Back the key up before you receive anything.",
      [['Back up the key…', () => openBackup()]],
    );
  // a reload of this same tab can find the lock still held by the page it replaces for a moment: wait up to three seconds for it
  let sole = true,
    lockErr = null;
  if (navigator.locks) {
    sole = await navigator.locks
      .request('bitcoin-blake:node', { signal: timeoutSignal(3000) }, () => true)
      .catch((e) => {
        if (e?.name !== 'AbortError' && e?.name !== 'TimeoutError') lockErr = e?.message || String(e);
        return false;
      });
  }
  if (lockErr) {
    PROBING = false;
    return lockFailed(lockErr);
  }
  if (NEWER_SCHEMA) {
    PROBING = false;
    return newerSchema();
  }
  PROBING = false;
  if (!sole) return goIdle();
  if (LS.get('reef:started') || RETURNING) {
    LS.set('reef:started', String(Date.now()));
    return startNode();
  }
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const free = est ? est.quota - est.usage : null;
  $('wl-space').textContent =
    free == null
      ? 'The browser does not say how much space it allows.'
      : free < 1.2e9
        ? `The browser allows ${mib(free)} more for this site, less than the 1.1 GB needed: free disk space first, or the fetch will stop part-way.`
        : `The browser allows ${mib(free)} for this site; 1.1 GB is needed.`;
  $('wl-start').onclick = async () => {
    $('welcome').close();
    node.notStarted = false;
    LS.set('reef:started', String(Date.now()));
    navigator.storage?.persist?.().catch(() => {});
    startNode();
  };
  $('wl-later').onclick = () => {
    $('welcome').close();
    node.notStarted = true;
    renderWallet();
    setSync('not started: nothing is downloaded until you choose Start', null);
    banner('welcome', 'info', 'The node is not started. Nothing is downloaded until you start it.', [
      ['Start the node…', () => $('welcome').showModal()],
    ]);
  };
  $('welcome').oncancel = (e) => {
    e.preventDefault();
    $('wl-later').onclick();
  };
  $('welcome').showModal();
}
begin().catch((e) => {
  PROBING = false;
  showFatal('Reef could not start: ' + (e?.message || e) + '. Reload to try again.');
});
