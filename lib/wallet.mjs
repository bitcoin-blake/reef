// Reef's wallet, pure: amounts, destinations, sizes, coin selection and the unsigned payment. No DOM, no storage, no
// network, so every rule that decides how much money moves where is tested (test/wallet-test.mjs) against the kernel.
// Amounts are integers of satoshis everywhere; a typed amount is parsed as a decimal string, never through a float.
export const UNITS = { tbtc: { label: 'tBTC', dp: 8 }, mtbtc: { label: 'mtBTC', dp: 5 }, sats: { label: 'sat', dp: 0 } };
export const DUST = 330,
  MIN_SEND = 546,
  MAX_SATS = 21e14,
  MAX_RATE = 1000;
export const COINBASE_MATURITY = 100;

// "0.001", "1 000", ".5", "0,5" in a unit with `dp` decimals → satoshis; throws with a sentence a person can act on.
// A comma is a decimal comma ("0,5", "0,001") unless the number has a dot too ("1,000.5") or the unit is sat; "1,500" alone
// could mean either, a thousand times apart, so it is refused rather than guessed
export function parseAmount(text, unit = 'tbtc') {
  const u = UNITS[unit] ?? UNITS.tbtc;
  let s = String(text ?? '')
    .trim()
    .replace(/[\s_']/g, '');
  if (!s) throw new Error('enter an amount');
  if (/^\d{1,3}(,\d{3})+\.\d*$/.test(s) || (!u.dp && /^\d{1,3}(,\d{3})+$/.test(s)))
    s = s.replace(/,/g, ''); // 1,000.5, or 1,000 sat
  else if (/^0?,\d+$/.test(s))
    s = s.replace(',', '.'); // 0,001: a decimal comma
  else if (u.dp && /^\d{1,3}(\.\d{3})+$/.test(s) && s.split('.').length > 2)
    throw new Error(`is ${s} meant as ${s.replace(/\./g, '')}? Write it with one dot for decimals and no thousands separator`);
  else if (/^\d{1,3}(,\d{3})+$/.test(s))
    throw new Error(
      `is ${s} meant as ${s.replace(/,/g, '')} or as ${s.replace(',', '.')}? Write it with a dot for decimals and no thousands separator`,
    );
  else if (/^\d+,\d+$/.test(s)) s = s.replace(',', '.'); // 12,5: a decimal comma
  if (!/^\d*\.?\d*$/.test(s) || s === '.') throw new Error('an amount is a number, like 0.001');
  const [int = '', frac = ''] = s.split('.');
  if (frac.length > u.dp) throw new Error(u.dp ? `at most ${u.dp} decimals in ${u.label}` : 'whole satoshis only');
  const sats = BigInt(int || '0') * 10n ** BigInt(u.dp) + BigInt((frac + '0'.repeat(u.dp)).slice(0, u.dp) || '0');
  if (sats > BigInt(MAX_SATS)) throw new Error('more than 21 million coins');
  return Number(sats);
}
// satoshis → a string in the unit, exact (no float), with the unit's decimals
export function formatAmount(sats, unit = 'tbtc', { grouping = true } = {}) {
  const u = UNITS[unit] ?? UNITS.tbtc;
  const neg = sats < 0;
  const a = BigInt(Math.abs(Math.round(sats)));
  const d = 10n ** BigInt(u.dp);
  const int = (a / d).toString(),
    frac = u.dp ? (a % d).toString().padStart(u.dp, '0') : '';
  const g = grouping ? int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : int;
  return (neg ? '-' : '') + g + (u.dp ? '.' + frac : '');
}

// a destination decoded by the sidestr address library ({ hrp, version, program, script }) checked for this chain:
// refuses what nobody could ever spend and what belongs to another network; warns when it is this wallet's own address
export function checkDestination(dec, { ownScript = null, hrp = 'tb' } = {}) {
  if (!dec) return { error: 'not a valid address: check it was copied whole (a typo breaks the checksum)' };
  if (dec.hrp !== hrp)
    return {
      error:
        dec.hrp === 'bc'
          ? 'that is a mainnet address (bc1…): this wallet holds test coins on txbt4, send to a tb1… address'
          : `not a txbt4 address (${dec.hrp}1…): use a tb1… address`,
    };
  const len = dec.program.length / 2;
  if (dec.version === 0 && len !== 20 && len !== 32) return { error: 'not a valid segwit address' };
  if (dec.version === 1 && len !== 32)
    return { error: 'a taproot address has a 32-byte program; coins sent to this one could never be spent' };
  if (dec.version > 1)
    return { error: `a witness version ${dec.version} address: no wallet can spend from it yet, coins sent there would be lost` };
  return { ok: true, self: ownScript != null && dec.script === ownScript };
}

// virtual size of a payment spending `nIn` key-path taproot inputs to outputs with the given scriptPubKeys (hex);
// the signature carries a sighash byte on this chain (65 bytes), so each input is 41 bytes plus 67/4 of witness
export const outputBytes = (spk) => 8 + 1 + spk.length / 2;
const varintExtra = (n) => (n < 253 ? 0 : n <= 0xffff ? 2 : 4); // the counts take 1 byte below 253, 3 bytes up to 65,535
export const estimateVsize = (nIn, outSpks) =>
  Math.ceil(10.5 + varintExtra(nIn) + varintExtra(outSpks.length) + nIn * (41 + 67 / 4) + outSpks.reduce((a, s) => a + outputBytes(s), 0));
// the real virtual size of a signed transaction from its two encodings
export function vsizeOf(k, tx) {
  const full = k.codec.encodeHex('Transaction', tx).length / 2;
  const stripped = k.codec.encodeHex('Transaction', { ...tx, witness: [] }).length / 2;
  return Math.ceil((stripped * 3 + full) / 4);
}

export const isMature = (c, height) => !c.coinbase || (height != null && height + 1 - c.height >= COINBASE_MATURITY);
// the coins a payment may use: mature, not held by a payment still waiting, largest first
// `first`: coins of a payment that was forgotten or refused here but may still exist out there; they go first, so the next
// payment spends one of them and the old one can then never also be mined (paying twice is impossible, not just unlikely)
// prefer: coins of a forgotten payment to the same address as the one being made; they go before every other coin, so
// paying that recipient again spends the forgotten payment's own coin and the two can never both be mined
// the height a coinbase's maturity is counted at: the block source's height, but never above what the signed tip vouches for
// (a source that inflates its height would otherwise make mined coins spendable early, in a payment no node accepts)
export const maturityHeight = (height, vouched = null) => (vouched != null ? Math.min(height, vouched) : height);
export const spendable = (coins, height, held = new Set(), first = new Set(), prefer = new Set()) =>
  coins
    .filter((c) => isMature(c, height) && !held.has(c.key))
    .sort(
      (a, b) =>
        (prefer.has(b.key) ? 1 : 0) - (prefer.has(a.key) ? 1 : 0) ||
        (first.has(b.key) ? 1 : 0) - (first.has(a.key) ? 1 : 0) ||
        b.value - a.value ||
        (a.key < b.key ? -1 : 1),
    );
// the coins that must go first: inputs of payments set aside (forgotten or refused) while unconfirmed, and of stored records
// whose coins the person released (quarantine with released: true): if one of them was sent after all, only one can be mined
// a set-aside record whose coins are still held: waiting, and not released, forgotten or refused (those go first instead)
export const quarantineHolds = (q) => !!(q && q.pending && !(q.released || q.abandoned || q.refused || q.refusedNote));
export const reuseFirst = (sent, quarantine = []) =>
  new Set([
    ...sent.filter((s) => s.pending && (s.abandoned || s.refused || s.refusedNote)).flatMap((s) => s.inputs ?? []),
    // set aside and no longer held (released, forgotten or refused here), yet its signed transaction may still be mined
    ...quarantine.filter((q) => q.pending && !quarantineHolds(q)).flatMap((q) => q.inputs ?? []),
  ]);

// pick coins for `amount` to `destSpk` at `rate` sat/vB with change to `changeSpk`; `all` sends everything (no change)
// → { picked, outputs, fee, change, amount, vsize } or throws with how much is missing
export function plan({ coins, amount, rate, destSpk, changeSpk, all = false }) {
  if (!Number.isFinite(rate) || rate < 1 || rate > MAX_RATE) throw new Error(`the fee rate must be between 1 and ${MAX_RATE} sat/vB`);
  if (!coins.length) throw new Error('no spendable coins yet');
  if (all) {
    const inSum = coins.reduce((a, c) => a + c.value, 0);
    const vsize = estimateVsize(coins.length, [destSpk]);
    const fee = Math.ceil(rate * vsize);
    const value = inSum - fee;
    if (value < MIN_SEND) throw new Error(`the balance does not cover the fee: ${inSum} sat available, ${fee} sat in fees`);
    return { picked: coins.slice(), outputs: [{ value, scriptPubKey: destSpk }], fee, change: 0, amount: value, vsize };
  }
  if (!Number.isInteger(amount) || amount < MIN_SEND)
    throw new Error(`the smallest payment is ${MIN_SEND} sat: smaller ones are not relayed`);
  const picked = [];
  let inSum = 0,
    fee = 0,
    vsize = 0;
  for (const c of coins) {
    picked.push(c);
    inSum += c.value;
    vsize = estimateVsize(picked.length, [destSpk, changeSpk]);
    fee = Math.ceil(rate * vsize);
    if (inSum >= amount + fee) break;
  }
  if (inSum < amount + fee) {
    // without a change output the payment is smaller: if every coin covers it that way, what is left over goes to the fee
    const vs0 = estimateVsize(coins.length, [destSpk]),
      fee0 = Math.ceil(rate * vs0);
    if (inSum >= amount + fee0)
      return { picked, outputs: [{ value: amount, scriptPubKey: destSpk }], fee: inSum - amount, change: 0, amount, vsize: vs0 };
    const total = coins.reduce((a, c) => a + c.value, 0);
    throw Object.assign(new Error(`not enough: ${total} sat can be spent, ${amount + fee} sat is needed including the fee`), {
      short: amount + fee - total,
    });
  }
  let change = inSum - amount - fee;
  const outputs = [{ value: amount, scriptPubKey: destSpk }];
  if (change >= DUST) outputs.push({ value: change, scriptPubKey: changeSpk });
  else {
    vsize = estimateVsize(picked.length, [destSpk]);
    fee = inSum - amount;
    change = 0;
  } // dust change goes to the fee rather than make an output nobody would spend
  return { picked, outputs, fee, change, amount, vsize };
}
// the unsigned transaction for a plan; every input signals replacement (BIP 125), so a stuck payment can be replaced
export function unsignedTx(p) {
  return {
    version: 2,
    inputs: p.picked.map((c) => ({
      prevout: { txid: c.key.slice(0, 64), vout: Number(c.key.slice(65)) },
      scriptSig: '',
      sequence: 0xfffffffd,
    })),
    outputs: p.outputs.map((o) => ({ ...o })),
    lockTime: 0,
    witness: [],
  };
}

// the wallet's history from what the node and this tab know: coins (the tab's own validated UTXO set), payments this
// tab made (sent), incoming transactions in the mempool; one row per transaction, newest first
// newest first: unconfirmed at the top, then by block; a version that did not happen right under its winner
const key = (r) => (r.order !== undefined ? r.order : r.height) ?? Infinity;
const byNewest = (a, b) => key(b) - key(a) || (a.after ? 1 : 0) - (b.after ? 1 : 0) || (a.txid < b.txid ? -1 : 1);
export function history({ coins, sent, mempoolIn = [], height, address, ledger = null }) {
  const bySent = (txid) => sent.find((s) => s.txid === txid);
  const rows = [];
  for (const x of mempoolIn)
    if (!bySent(x.txid))
      rows.push({
        kind: 'in',
        label: 'Received (unconfirmed)',
        addr: address,
        sats: x.toUs,
        height: null,
        pending: true,
        txid: x.txid,
        conf: 0,
      });
  for (const s of sent)
    if (!s.tomb)
      rows.push({
        kind: 'out',
        label: s.recovered
          ? s.partial
            ? 'Sent (at least)'
            : 'Sent'
          : s.kind === 'cancel'
            ? s.replaced
              ? 'Cancel attempt'
              : s.pending
                ? 'Cancel (waiting)'
                : 'Cancelled payment'
            : s.self || s.to === address
              ? 'Payment to yourself'
              : 'Sent to',
        addr: s.to,
        sats: s.replaced || s.failed ? 0 : -((s.self || s.to === address ? 0 : s.sats) + s.fee),
        height: s.height ?? null,
        // a version that did not happen sits just under the one that did, not at the top for ever
        order: s.replaced || s.failed ? (bySent(s.replaced || s.failed)?.height ?? null) : (s.height ?? null),
        after: !!(s.replaced || s.failed),
        pending: !!s.pending,
        txid: s.txid,
        at: s.at ?? null,
      });
  if (ledger) {
    for (const r of ledger.values())
      if (!bySent(r.txid))
        rows.push({
          kind: 'in',
          label: r.coinbase ? 'Mined' : 'Received',
          addr: address,
          sats: receiptSats(r),
          height: r.height,
          pending: false,
          txid: r.txid,
          conf: height != null ? height - r.height + 1 : null,
          immature: r.coinbase && height != null && height + 1 - r.height < COINBASE_MATURITY,
          at: r.time ?? r.at ?? null, // the block's own time once known, else when this wallet first saw it
        });
    return rows.sort(byNewest);
  }
  const txOf = (c) => c.key.slice(0, 64);
  const grouped = new Map();
  for (const c of coins) {
    const t = txOf(c);
    if (bySent(t)) continue;
    const g = grouped.get(t) ?? {
      kind: 'in',
      label: c.coinbase ? 'Mined' : 'Received',
      addr: address,
      sats: 0,
      height: c.height,
      pending: false,
      txid: t,
      conf: height != null ? height - c.height + 1 : null,
      immature: c.coinbase && !isMature(c, height),
    };
    g.sats += c.value;
    grouped.set(t, g);
  }
  rows.push(...grouped.values());
  return rows.sort(byNewest);
}

// ---- balances from the tab's view: coins (validated), payments of mine still waiting, incoming unconfirmed
// available: mature, not held by a waiting payment; pending: what comes back to me from waiting payments (their change)
// plus unconfirmed incoming; total never counts a held coin twice and never goes negative from a send
// vouched: the height up to which the signed chain tip vouches for blocks (null: no such limit is known); a coin in a block
// above it is the block source's word alone, so it is pending, not available, until the tip reaches it
export function balances({ coins, sent, height, incoming = 0, reserved = new Set(), vouched = null }) {
  // reserved: coins another app (Hitch) holds for itself
  // payments still waiting, grouped by the coins they spend: an original and its replacements are one payment, and until a
  // block says which version won, the balance assumes the worse one (the least coming back, the most going out)
  const live = sent.filter((s) => s.pending && !s.abandoned && !s.refused);
  const held = new Set(live.flatMap((s) => s.inputs ?? []));
  // a replacement refused here may still be mined elsewhere: the worse figures include it (it holds no coins of its own)
  const counted = [
    ...live,
    ...sent.filter(
      (s) =>
        s.pending &&
        !s.abandoned &&
        s.refused &&
        s.replaces &&
        live.some((o) => (o.inputs ?? []).some((k) => (s.inputs ?? []).includes(k))),
    ),
  ];
  const groups = [];
  for (const s of counted) {
    const g = groups.find((x) => x.some((o) => (o.inputs ?? []).some((k) => (s.inputs ?? []).includes(k))));
    g ? g.push(s) : groups.push([s]);
  }
  const back = (s) => (s.change ?? 0) + (s.self ? s.sats : 0),
    out = (s) => (s.self ? 0 : s.sats) + s.fee;
  let returning = 0,
    outgoing = 0;
  for (const g of groups) {
    returning += Math.min(...g.map(back));
    outgoing += Math.max(...g.map(out));
  }
  let unvouched = 0;
  const above = new Set();
  let available = 0,
    immature = 0,
    elsewhere = 0;
  // a coin that is the change of a payment still counted as waiting is already in `returning`: never counted twice
  const waitingTx = new Set(counted.map((s) => s.txid));
  for (const c of coins) {
    if (held.has(c.key)) continue;
    if (waitingTx.has(c.key.slice(0, 64))) continue;
    if (reserved.has(c.key)) {
      elsewhere += c.value;
      continue;
    }
    if (vouched != null && c.height > vouched) {
      unvouched += c.value;
      above.add(c.key); // not spendable either, until the tip reaches it
      continue;
    }
    isMature(c, maturityHeight(height, vouched)) ? (available += c.value) : (immature += c.value);
  }
  return {
    available,
    immature,
    pending: returning + incoming + unvouched,
    returning, // the change (and payments to yourself) of payments still waiting
    unvouched,
    outgoing,
    elsewhere,
    total: available + immature + elsewhere + returning + incoming + unvouched,
    held: new Set([...held, ...reserved, ...above]),
  };
}

// ---- the key in forms other wallets read: testnet WIF (compressed) and a rawtr() descriptor with its checksum.
// The address is the key-path output of the untweaked x-only key, which is rawtr(), not tr(): tr() would tweak it.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const hexToBytes = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
function b58encode(bytes) {
  let n = BigInt('0x' + (bytesToHex(bytes) || '0'));
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b) break;
    s = '1' + s;
  }
  return s;
}
function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let h = n.toString(16);
  if (h.length % 2) h = '0' + h;
  const lead = s.match(/^1*/)[0].length;
  return Uint8Array.from([...new Array(lead).fill(0), ...(n ? hexToBytes(h) : [])]);
}
export function toWif(keyHex, sha256) {
  const body = Uint8Array.from([0xef, ...hexToBytes(keyHex), 0x01]);
  const chk = sha256(sha256(body)).slice(0, 4);
  return b58encode(Uint8Array.from([...body, ...chk]));
}
export function fromWif(wif, sha256, { mainnet = false } = {}) {
  const b = b58decode(String(wif).trim());
  if (!b || b.length !== 38) return null;
  const body = b.slice(0, 34),
    chk = b.slice(34);
  const want = sha256(sha256(body)).slice(0, 4);
  if (!chk.every((x, i) => x === want[i])) return null;
  if (body[0] !== 0xef && !(mainnet && body[0] === 0x80)) return null;
  /* a test wallet takes testnet keys only */ if (body[33] !== 0x01) return null;
  return bytesToHex(body.slice(1, 33));
}
// a key typed or pasted: 64 hex characters or a WIF → hex, or null
export function parseKey(text, sha256) {
  const t = String(text ?? '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return t.toLowerCase();
  return fromWif(t, sha256);
}
// BIP 380 descriptor checksum
const INPUT_CHARSET = '0123456789()[],\'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#"\\ ';
const CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(c, val) {
  const c0 = c >> 35n;
  c = ((c & 0x7ffffffffn) << 5n) ^ BigInt(val);
  if (c0 & 1n) c ^= 0xf5dee51989n;
  if (c0 & 2n) c ^= 0xa9fdca3312n;
  if (c0 & 4n) c ^= 0x1bab10e32dn;
  if (c0 & 8n) c ^= 0x3706b1677an;
  if (c0 & 16n) c ^= 0x644d626ffdn;
  return c;
}
export function descriptorChecksum(desc) {
  let c = 1n,
    cls = 0,
    clscount = 0;
  for (const ch of desc) {
    const pos = INPUT_CHARSET.indexOf(ch);
    if (pos === -1) return null;
    c = polymod(c, pos & 31);
    cls = cls * 3 + (pos >> 5);
    if (++clscount === 3) {
      c = polymod(c, cls);
      cls = 0;
      clscount = 0;
    }
  }
  if (clscount > 0) c = polymod(c, cls);
  for (let j = 0; j < 8; j++) c = polymod(c, 0);
  c ^= 1n;
  let r = '';
  for (let j = 0; j < 8; j++) r += CHECKSUM_CHARSET[Number((c >> (5n * BigInt(7 - j))) & 31n)];
  return r;
}
export const rawtrDescriptor = (wif) => {
  const d = `rawtr(${wif})`;
  return `${d}#${descriptorChecksum(d)}`;
};

// ---- the ledger: every transaction that paid this wallet, kept after its coins are spent, so the history adds up
// ledger: Map txid → { txid, sats, height, coinbase }; coins add to it, nothing removes from it
export function recordReceipts(ledger, coins, isOurPayment, now = Date.now()) {
  const byTx = new Map();
  for (const c of coins) {
    const t = c.key.slice(0, 64);
    if (isOurPayment(t)) continue;
    const g = byTx.get(t) ?? { txid: t, outs: {}, height: c.height, coinbase: !!c.coinbase, at: now };
    g.outs[c.key.slice(65)] = c.value;
    byTx.set(t, g);
  }
  let added = [];
  for (const [t, g] of byTx) {
    const have = ledger.get(t);
    if (!have) {
      ledger.set(t, g);
      added.push(g);
    } else {
      Object.assign(have.outs, g.outs);
      have.height = g.height;
    }
  }
  return added;
}
// a block this wallet mined that is no longer in the chain: its coinbase coin cannot be spent for 100 blocks, so if it is
// gone from the coins before then, a reorganisation undid it. → the ledger rows to remove (the caller removes and says so)
export function undoneReceipts(ledger, coins, height) {
  if (height == null) return [];
  const have = new Set(coins.map((c) => c.key));
  const gone = (r) => !Object.keys(r.outs ?? {}).some((v) => have.has(`${r.txid}:${v}`));
  return [...ledger.values()].filter((r) => r.coinbase && height + 1 - r.height < COINBASE_MATURITY && gone(r));
}
// a received payment whose coins are all gone, not spent by a payment of ours and not known to be spent elsewhere: either
// something else spent it (a channel funding) or a reorganisation undid it. The node's spend lookup tells which; these are
// the ones to ask about, once per block, while younger than `depth` blocks → [{ txid, key, from }]
export function receiptsToCheck(ledger, coins, sent, height, depth = 100) {
  if (height == null) return [];
  const have = new Set(coins.map((c) => c.key));
  const ours = new Set(sent.flatMap((s) => s.inputs ?? []));
  const out = [];
  for (const r of ledger.values()) {
    if (r.coinbase || r.spentElsewhere || r.checkedAt === height || height - r.height >= depth) continue;
    const keys = Object.keys(r.outs ?? {}).map((v) => `${r.txid}:${v}`);
    if (!keys.length || keys.some((k) => have.has(k) || ours.has(k))) continue;
    out.push({ txid: r.txid, key: keys[0], from: r.height });
  }
  return out;
}
// the node's answer about a receipt whose coins went (receiptsToCheck): found → spent elsewhere, keep it; not found → undone,
// but only if the node searched up to this wallet's height (a search that stopped short proves nothing)
export function onReceiptAnswer(ledger, txid, answer, height) {
  const r = ledger.get(txid);
  if (!r || !answer) return 'ignore';
  if (answer.found) {
    r.spentElsewhere = true;
    return 'spent';
  }
  if (!(Number.isInteger(answer.to) && height != null && answer.to >= height)) {
    delete r.checkedAt; // asked again at the next block
    return 'ignore';
  }
  ledger.delete(txid);
  return 'removed';
}
export const receiptSats = (r) => Object.values(r.outs ?? {}).reduce((a, v) => a + v, 0);

// the rate a raise starts from: at least half again the old rate (on the old payment's real shape), the person's own rate,
// and the tab's mempool rate, but never more than three times the old rate because of the mempool (two odd transactions
// are not a market)
// the rate a waiting payment pays now, sat/vB (from its fee and its measured size)
export function rateOf(s, ownSpk) {
  const outs = s.all || !s.change ? [s.toScript ?? ownSpk] : [s.toScript ?? ownSpk, ownSpk];
  return s.fee / estimateVsize((s.inputs ?? []).length, outs);
}
export function raiseRate({ s, ownSpk, optRate = 1, mempoolRate = null }) {
  const oldRate = rateOf(s, ownSpk);
  return Math.min(
    MAX_RATE,
    Math.max(1, Math.round(Number(optRate) || 1), Math.min(mempoolRate ?? 1, Math.ceil(oldRate * 3)), Math.ceil(oldRate * 1.5)),
  );
}
// ---- replacing a waiting payment (BIP 125): the same coins, a fee higher by at least the relay fee on the new size (and so a
// higher rate). A raise comes out of the change; for a payment of everything, out of what the recipient receives; a payment
// without change cannot be raised (it would quietly pay the recipient less): cancel it instead. A cancel pays the coins back.
// s: { inputs, values, sats, fee, change, all, toScript }; → { outputs, fee, amount, change, rate, vsize, reducesRecipient }
export function planReplace(s, { cancel = false, rate = 1, ownSpk }) {
  if (!s.values || s.values.length !== (s.inputs ?? []).length)
    throw new Error('only a waiting payment made from this tab can be replaced');
  if (!cancel && !s.all && !s.change)
    throw new Error('this payment has no change to pay a higher fee from; cancel it instead (and pay again), or wait');
  if (!cancel && s.kind === 'cancel') throw new Error('a cancel is raised as a cancel');
  if (!cancel && !s.all && !(s.sats >= MIN_SEND)) throw new Error(`a payment of less than ${MIN_SEND} sat cannot be raised`);
  const inSum = s.values.reduce((a, v) => a + v, 0);
  const outs = cancel ? [ownSpk] : s.all ? [s.toScript] : [s.toScript, ownSpk];
  const vsize = estimateVsize(s.inputs.length, outs);
  let fee = Math.max(Math.ceil(Math.min(MAX_RATE, Math.max(1, rate)) * vsize), s.fee + vsize),
    amount = s.sats,
    change = 0,
    outputs;
  if (cancel) {
    amount = inSum - fee;
    if (amount < DUST) throw new Error('the coins would not cover the fee of a cancel');
    outputs = [{ value: amount, scriptPubKey: ownSpk }];
  } else if (s.all) {
    amount = inSum - fee;
    if (amount < MIN_SEND) throw new Error('raising the fee would leave the recipient less than the minimum');
    outputs = [{ value: amount, scriptPubKey: s.toScript }];
  } else {
    change = inSum - amount - fee;
    if (change < 0) throw new Error('the change of this payment is too small to raise the fee; cancel it instead, or wait');
    outputs = [{ value: amount, scriptPubKey: s.toScript }];
    if (change >= DUST) outputs.push({ value: change, scriptPubKey: ownSpk });
    else {
      fee += change;
      change = 0;
    }
  }
  // a last line: the checks above already keep every output at DUST or more (MIN_SEND > DUST), so no case reaches it today
  if (outputs.some((o) => o.value < DUST)) throw new Error('the replacement would have an output too small to spend');
  return { outputs, fee, amount, change, vsize, rate: +(fee / vsize).toFixed(1), reducesRecipient: !cancel && !!s.all };
}
