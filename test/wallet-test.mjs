// The wallet's rules against the real kernel: every payment built here is signed and run through the interpreter.
//   SCHEMA=<bitcoin-desktop/schema> BLAKETESTNODE=<path> SIDESTR_LIB=<siding/lib> node test/wallet-test.mjs
import { homedir } from 'node:os';
const H = (p) => p.replace(/^~/, homedir());
const SCHEMA = H(process.env.SCHEMA ?? '~/bitcoin-desktop/schema'),
  BTN = H(process.env.BLAKETESTNODE ?? '~/remote/github.com/bitcoin-blake/blaketestnode'),
  LIB = H(process.env.SIDESTR_LIB ?? '~/remote/github.com/sidestr/spec/siding/lib');
const [{ loadEngine }, hash, secp, { makeSigner }, txsign, addr, W] = await Promise.all([
  import(`${BTN}/lib/engine.mjs`),
  import(`${SCHEMA}/codec/hash.js`),
  import(`${SCHEMA}/codec/secp256k1.js`),
  import(`${LIB}/schnorr.mjs`),
  import(`${LIB}/txsign.mjs`),
  import(`${LIB}/address.mjs`),
  import('../lib/wallet.mjs'),
]);
const k = await loadEngine('btc:testnet4-blake2b');
const signer = makeSigner({ hash, secp });
const unified = k?.params?.unifiedSighashParam != null;
let ok = 0,
  bad = 0;
const t = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`);
  cond ? ok++ : bad++;
};
const throws = (f, re) => {
  try {
    f();
    return false;
  } catch (e) {
    return re ? re.test(e.message) : true;
  }
};

// ---- payment requests (BIP 21): what a link or a pasted bitcoin: URI asks for, read exactly; nothing else is a request
{
  const A = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
  const r = W.parsePaymentUri(`bitcoin:${A}?amount=0.001&label=Table%207&message=buy-in+for+seat+3`);
  t(
    'a request gives the address, the amount exactly and its words',
    r.address === A && r.sats === 100000 && r.label === 'Table 7' && r.message === 'buy-in for seat 3',
    JSON.stringify(r),
  );
  t('a request with no amount leaves the amount to the person', W.parsePaymentUri(`bitcoin:${A}`).sats === null);
  t(
    'the scheme in any case, and an address in capitals (a QR code) read in lower case',
    W.parsePaymentUri(`BITCOIN:${A.toUpperCase()}?AMOUNT=1.00000001`).address === A &&
      W.parsePaymentUri(`BITCOIN:${A.toUpperCase()}?AMOUNT=1.00000001`).sats === 100000001,
  );
  t(
    'a plain address, or other text, is not a request',
    W.parsePaymentUri(A) === null && W.parsePaymentUri('lightning:x') === null && W.parsePaymentUri('') === null,
  );
  t('an unknown optional parameter is ignored', W.parsePaymentUri(`bitcoin:${A}?amount=0.5&lightning=lnbc1&foo=bar`).sats === 50000000);
  t(
    'a required parameter Reef does not know refuses the request',
    throws(() => W.parsePaymentUri(`bitcoin:${A}?req-pop=x`), /req-pop/),
  );
  t(
    'an amount with a comma, grouping, a sign, a unit or too many decimals is refused',
    ['1,5', '1 000', '-1', '0.001BTC', '1e-3', '0.000000001'].every((a) =>
      throws(() => W.parsePaymentUri(`bitcoin:${A}?amount=${encodeURIComponent(a)}`)),
    ),
  );
  t(
    'an amount of 0 is refused',
    throws(() => W.parsePaymentUri(`bitcoin:${A}?amount=0.0`), /nothing/),
  );
  t(
    'the amount named twice is refused',
    throws(() => W.parsePaymentUri(`bitcoin:${A}?amount=1&amount=2`), /twice/),
  );
  t(
    'no address is refused',
    throws(() => W.parsePaymentUri('bitcoin:?amount=1'), /no address/),
  );
  t(
    'a broken % escape is refused in words',
    throws(() => W.parsePaymentUri(`bitcoin:${A}?label=%E0%A4%A`), /escape/),
  );
  t('the words are capped', W.parsePaymentUri(`bitcoin:${A}?label=${'x'.repeat(500)}`).label.length === 200);
}

// ---- amounts: exact, in every unit, with the mistakes people make refused in words
t(
  '0.001 tBTC is 100,000 sat, exactly (no float)',
  W.parseAmount('0.001') === 100000 && W.parseAmount('0.1', 'tbtc') + W.parseAmount('0.2', 'tbtc') === 30000000,
);
t(
  'amounts that floats get wrong come out exact',
  W.parseAmount('0.29') === 29000000 &&
    W.parseAmount('1.00000001') === 100000001 &&
    W.parseAmount('20999999.99999999') === 2099999999999999,
);
t(
  'grouping and a decimal comma are read',
  W.parseAmount('1,000', 'sats') === 1000 &&
    W.parseAmount('0,5', 'mtbtc') === 50000 &&
    W.parseAmount('1 000 000', 'sats') === 1000000 &&
    W.parseAmount('.5') === 50000000,
);
t(
  'too many decimals are refused, not rounded',
  throws(() => W.parseAmount('0.000000001'), /decimals/) && throws(() => W.parseAmount('1.5', 'sats'), /whole/),
);
t(
  'garbage, negatives, exponents and empty are refused',
  ['abc', '-1', '1e3', '', '.', '0x10', '1.2.3'].every((s) => throws(() => W.parseAmount(s))),
);
t(
  'more than 21 million is refused',
  throws(() => W.parseAmount('21000001'), /21 million/),
);
t(
  'formatting is exact and round-trips',
  W.formatAmount(100000001) === '1.00000001' &&
    W.formatAmount(123456789, 'sats') === '123,456,789' &&
    W.formatAmount(-50000, 'mtbtc') === '-0.50000' &&
    W.parseAmount(W.formatAmount(2099999999999999, 'tbtc', { grouping: false })) === 2099999999999999,
);

// ---- destinations
const keyA = hash.bytesToHex(hash.sha256(new TextEncoder().encode('reef-a'))),
  keyB = hash.bytesToHex(hash.sha256(new TextEncoder().encode('reef-b')));
const pubA = signer.pubkeyOf(keyA),
  pubB = signer.pubkeyOf(keyB);
const spkA = '5120' + pubA,
  spkB = '5120' + pubB;
const addrB = addr.scriptToAddress(spkB, 'tb');
t('a tb1p address of this chain is accepted', W.checkDestination(addr.decodeAddress(addrB)).ok === true);
t(
  'sending to my own address is flagged',
  W.checkDestination(addr.decodeAddress(addr.scriptToAddress(spkA, 'tb')), { ownScript: spkA }).self === true,
);
t(
  'a mainnet address is refused with the reason',
  /mainnet/.test(W.checkDestination(addr.decodeAddress(addr.scriptToAddress(spkB, 'bc'))).error ?? ''),
);
t(
  'a regtest or other-network address is refused',
  /not a txbt4/.test(W.checkDestination(addr.decodeAddress(addr.scriptToAddress(spkB, 'bcrt'))).error ?? ''),
);
t(
  'a typo (broken checksum) is refused',
  /not a valid address/.test(W.checkDestination(addr.decodeAddress(addrB.slice(0, -1) + (addrB.endsWith('q') ? 'p' : 'q'))).error ?? ''),
);
t(
  'a witness v1 program that is not 32 bytes (unspendable) is refused',
  /could never be spent/.test(
    W.checkDestination({ hrp: 'tb', version: 1, program: 'ab'.repeat(20), script: '5114' + 'ab'.repeat(20) }).error ?? '',
  ),
);
t(
  'a future witness version is refused',
  /lost/.test(W.checkDestination({ hrp: 'tb', version: 2, program: 'ab'.repeat(32), script: '5220' + 'ab'.repeat(32) }).error ?? ''),
);
t(
  'p2wpkh and p2wsh destinations are accepted',
  W.checkDestination({ hrp: 'tb', version: 0, program: 'ab'.repeat(20), script: '0014' + 'ab'.repeat(20) }).ok &&
    W.checkDestination({ hrp: 'tb', version: 0, program: 'ab'.repeat(32), script: '0020' + 'ab'.repeat(32) }).ok,
);

// ---- coin selection and the payment, signed and verified under the interpreter
const pay2 = (o) => ({ to: 'x', sats: 1000, fee: 100, inputs: [], ...o });
const coin = (i, value, extra = {}) => ({
  key: hash.bytesToHex(hash.sha256(new TextEncoder().encode('coin' + i))) + ':' + (i % 3),
  value,
  height: 152000 + i,
  ...extra,
});
const coins = [coin(1, 50000), coin(2, 20000), coin(3, 7000), coin(4, 300000, { coinbase: true, height: 152080 })];
const height = 152100;
t(
  'immature coinbase coins and held coins are not spendable',
  W.spendable(coins, height).length === 3 &&
    W.spendable(coins, height, new Set([coins[0].key])).length === 2 &&
    W.spendable(coins, 152180).length === 4,
);
{
  // sendCoins: the one choice behind every payment
  const keys = (cs) => cs.map((c) => c.key).join(',');
  const all = W.sendCoins({ coins, height: 152180 });
  t('sendCoins: every mature coin, largest first', keys(all) === keys([coins[3], coins[0], coins[1], coins[2]]), keys(all));
  t(
    'sendCoins: a coin held by a waiting payment is never offered',
    !W.sendCoins({ coins, height, held: new Set([coins[0].key]) }).some((c) => c.key === coins[0].key),
  );
  t(
    'sendCoins: a mined coin counts its maturity at the vouched height, not the source height',
    W.sendCoins({ coins, height: 152180 }).some((c) => c.coinbase) &&
      !W.sendCoins({ coins, height: 152180, vouched: 152100 }).some((c) => c.coinbase) &&
      W.sendCoins({ coins, height: 152180, vouched: 152200 }).some((c) => c.coinbase),
  );
  const fp = W.sendCoins({ coins, height, first: new Set([coins[2].key]), prefer: new Set([coins[1].key]) });
  t(
    'sendCoins: preferred coins before first ones, first ones before the rest',
    keys(fp.slice(0, 2)) === keys([coins[1], coins[2]]),
    keys(fp),
  );
  t('sendCoins: nothing to send from', W.sendCoins({ coins: [], height }).length === 0);
}
{
  // the boundaries a guard sits on: each side of it, so a guard moved by one is caught
  const est = (n) => Math.ceil(1 * W.estimateVsize(n, [spkB, spkA]));
  const one = (v, i = 7) => coin(i, v);
  t(
    'exactly 21 million coins is an amount; one satoshi more is not',
    W.parseAmount('21000000') === 2100000000000000 && throws(() => W.parseAmount('21000000.00000001'), /21 million/),
  );
  t(
    'a fee rate of exactly the cap plans; one more does not',
    !!W.plan({ coins: [one(5000000)], amount: 10000, rate: 1000, destSpk: spkB, changeSpk: spkA }) &&
      throws(() => W.plan({ coins: [one(5000000)], amount: 10000, rate: 1001, destSpk: spkB, changeSpk: spkA }), /between 1 and 1000/),
  );
  {
    // a coin that covers the amount and the fee exactly is enough on its own: the next coin is not taken too
    const amount = 10000,
      fee = est(1);
    const p = W.plan({ coins: [one(amount + fee + 330), one(9999, 8)], amount, rate: 1, destSpk: spkB, changeSpk: spkA });
    t(
      'a coin covering amount, fee and a change of exactly the dust limit: one coin, and the change kept as an output',
      p.picked.length === 1 && p.outputs.length === 2 && p.change === 330,
      JSON.stringify({ n: p.picked.length, out: p.outputs.length, change: p.change }),
    );
    const q = W.plan({ coins: [one(amount + fee), one(9999, 8)], amount, rate: 1, destSpk: spkB, changeSpk: spkA });
    t('a coin covering amount and fee exactly: it alone is spent', q.picked.length === 1, String(q.picked.length));
  }
  {
    // a raise needs a payment of at least the smallest relayed amount
    const s0 = { inputs: [one(1).key], values: [100000], sats: 546, fee: 200, change: 99000, toScript: spkB, kind: 'payment' };
    t(
      'a payment of exactly the smallest amount can be raised; one satoshi less cannot',
      !!W.planReplace(s0, { rate: 5, ownSpk: spkA }) &&
        throws(() => W.planReplace({ ...s0, sats: 545 }, { rate: 5, ownSpk: spkA }), /cannot be raised/),
    );
  }
  {
    // a cancel says what it is in the history, in each of its states
    const base = { to: 'tb1pdest', toScript: spkB, sats: 0, fee: 300, inputs: [one(1).key], kind: 'cancel', at: 1 };
    const label = (o) => W.history({ coins: [], sent: [{ txid: 'c1'.repeat(32), ...base, ...o }], height, address: 'tb1pme' })[0]?.label;
    t(
      'the three cancel labels: waiting, done, and an attempt that was replaced',
      label({ pending: true }) === 'Cancel (waiting)' &&
        label({ pending: false, height: 152090 }) === 'Cancelled payment' &&
        label({ pending: false, replaced: 'c2'.repeat(32) }) === 'Cancel attempt',
      [label({ pending: true }), label({ pending: false, height: 152090 }), label({ pending: false, replaced: 'x' })].join(' / '),
    );
  }
}
function signAndCheck(p) {
  const tx = W.unsignedTx(p);
  const prevouts = p.picked.map((c) => ({ value: c.value, scriptPubKey: spkA }));
  txsign.signKeyPath({ k, hash, signer }, tx, prevouts, keyA);
  const verified = tx.inputs.every(
    (_, i) => k.interpreter.verifyInput(tx, i, prevouts[i], prevouts, null, { unifiedSighash: unified }).ok === true,
  );
  return { tx, verified, vsize: W.vsizeOf(k, tx) };
}
{
  // round 16: the boundaries of coin choice, "send everything", a replacement's change and the size estimate
  const A = 20000,
    feeOf = (n, outs = [spkB, spkA]) => Math.ceil(W.estimateVsize(n, outs));
  const three = [coin(31, A + 50), coin(32, 30000), coin(33, 5000)];
  const p3 = W.plan({ coins: three, amount: A, rate: 1, destSpk: spkB, changeSpk: spkA });
  t(
    'a coin that covers the amount less the fee but not the amount plus the fee: a second coin is taken',
    p3.picked.length === 2 && p3.outputs[0].value === A,
    `${p3.picked.length} picked`,
  );
  const exact = [coin(34, A + feeOf(1)), coin(35, 9000)];
  const pe = W.plan({ coins: exact, amount: A, rate: 1, destSpk: spkB, changeSpk: spkA });
  t(
    'a coin that is exactly the amount plus the fee: it alone is taken, no change',
    pe.picked.length === 1 && pe.change === 0 && pe.outputs.length === 1,
    `${pe.picked.length} picked, change ${pe.change}`,
  );
  const allFee = feeOf(1, [spkB]);
  const pa = W.plan({ coins: [coin(36, W.MIN_SEND + allFee)], rate: 1, destSpk: spkB, all: true });
  t(
    'send everything that leaves exactly the smallest payment is allowed; one satoshi less is not',
    pa.amount === W.MIN_SEND &&
      throws(() => W.plan({ coins: [coin(36, W.MIN_SEND + allFee - 1)], rate: 1, destSpk: spkB, all: true }), /does not cover/),
  );
  const rv = W.estimateVsize(1, [spkB, spkA]);
  const rs = {
    sats: A,
    toScript: spkB,
    inputs: ['ab'.repeat(32) + ':0'],
    values: [A + 200 + Math.ceil(rv) + W.DUST],
    fee: 200,
    change: 400,
  };
  const rr = W.planReplace(rs, { rate: 1, ownSpk: spkA });
  t(
    'a replacement whose change is exactly DUST keeps the change output',
    rr.change === W.DUST && rr.outputs.length === 2,
    `change ${rr.change}, ${rr.outputs.length} outputs`,
  );
  const sizes = [];
  for (const nIn of [1, 2, 8])
    for (const outs of [[spkB], [spkB, spkA]]) {
      const picked = Array.from({ length: nIn }, (_, i) => coin(40 + i, 100000));
      const outputs = outs.map((spk) => ({ value: 1000, scriptPubKey: spk }));
      const real = signAndCheck({ picked, outputs }).vsize;
      sizes.push([nIn, outs.length, W.estimateVsize(nIn, outs), real]);
    }
  t(
    'the size estimate is the signed size, or at most one vbyte over (1, 2 and 8 inputs, 1 and 2 outputs)',
    sizes.every(([, , e, r]) => e - r >= 0 && e - r <= 1),
    JSON.stringify(sizes),
  );
}
{
  const p = W.plan({ coins: W.spendable(coins, height), amount: 30000, rate: 1, destSpk: spkB, changeSpk: spkA });
  const s = signAndCheck(p);
  t(
    'a payment picks the largest coin, pays change back, and verifies under the interpreter',
    p.picked.length === 1 && p.outputs.length === 2 && p.outputs[0].value === 30000 && p.outputs[1].scriptPubKey === spkA && s.verified,
  );
  t(
    'value is conserved: inputs = outputs + fee',
    p.picked.reduce((a, c) => a + c.value, 0) === p.outputs.reduce((a, o) => a + o.value, 0) + p.fee,
  );
  t(
    'the estimated size is the real signed size (the fee rate is honest)',
    p.vsize >= s.vsize && p.vsize - s.vsize <= 1,
    `estimate ${p.vsize} real ${s.vsize}`,
  );
  t(
    'every input signals replacement',
    s.tx.inputs.every((i) => i.sequence === 0xfffffffd),
  );
}
{
  const p = W.plan({ coins: W.spendable(coins, height), amount: 60000, rate: 3, destSpk: spkB, changeSpk: spkA });
  const s = signAndCheck(p);
  t(
    'a larger payment takes two coins and the fee scales with the rate and size',
    p.picked.length === 2 && p.fee === Math.ceil(3 * p.vsize) && s.verified && p.vsize - s.vsize <= 1,
    `vsize ${p.vsize}/${s.vsize}`,
  );
}
{
  const all = W.spendable(coins, height);
  const inSum = all.reduce((a, c) => a + c.value, 0);
  const p = W.plan({ coins: all, all: true, rate: 2, destSpk: spkB, changeSpk: spkA });
  const s = signAndCheck(p);
  t(
    'send-all spends every spendable coin to one output, no change, fee from the real size',
    p.outputs.length === 1 && p.amount === inSum - p.fee && p.fee === Math.ceil(2 * p.vsize) && s.verified && p.vsize - s.vsize <= 1,
  );
}
{
  const p = W.plan({ coins: [coin(9, 10400)], amount: 10000, rate: 1, destSpk: spkB, changeSpk: spkA });
  t('change below dust goes to the fee instead of a dust output', p.outputs.length === 1 && p.fee === 400 && p.change === 0);
}
t(
  'not enough coins says how much is missing',
  throws(
    () => W.plan({ coins: W.spendable(coins, height), amount: 100000, rate: 1, destSpk: spkB, changeSpk: spkA }),
    /not enough: 77000 sat can be spent, \d+ sat is needed/,
  ),
);
t(
  'below the minimum, a zero rate and an absurd rate are refused',
  throws(() => W.plan({ coins, amount: 100, rate: 1, destSpk: spkB, changeSpk: spkA }), /546/) &&
    throws(() => W.plan({ coins, amount: 1000, rate: 0, destSpk: spkB, changeSpk: spkA }), /fee rate/) &&
    throws(() => W.plan({ coins, amount: 1000, rate: 5000, destSpk: spkB, changeSpk: spkA }), /fee rate/),
);
t(
  'send-all with a balance under the fee is refused',
  throws(() => W.plan({ coins: [coin(8, 600)], all: true, rate: 1, destSpk: spkB, changeSpk: spkA }), /does not cover/),
);
{
  const p = W.plan({ coins: [coin(7, 9000)], amount: 5000, rate: 1, destSpk: '0014' + 'ab'.repeat(20), changeSpk: spkA });
  const s = signAndCheck(p);
  t('a payment to a p2wpkh address is sized for its shorter output', p.vsize - s.vsize <= 1 && s.verified && p.vsize >= s.vsize);
}

// ---- history
{
  const txid = (c) => c.key.slice(0, 64);
  const change = { key: 'cc'.repeat(32) + ':1', value: 19000, height: 152095 };
  const sent = [
    { txid: 'cc'.repeat(32), to: addrB, sats: 30000, fee: 154, pending: false, height: 152095 },
    { txid: 'dd'.repeat(32), to: addrB, sats: 1000, fee: 111, pending: true },
  ];
  const h = W.history({
    coins: [...coins, change, { ...coins[1], key: txid(coins[0]) + ':2', value: 1 }],
    sent,
    mempoolIn: [{ txid: 'ee'.repeat(32), toUs: 4000 }],
    height,
    address: 'tb1pme',
  });
  t('change of my own payment is not shown as a receipt', !h.some((r) => r.kind === 'in' && r.txid === 'cc'.repeat(32)));
  t(
    'two outputs of one incoming transaction are one row with their sum',
    h.filter((r) => r.txid === txid(coins[0])).length === 1 && h.find((r) => r.txid === txid(coins[0])).sats === 50001,
  );
  t(
    'pending rows come first; a payment shows amount plus fee as the outflow',
    h[0].pending && h.find((r) => r.txid === 'cc'.repeat(32)).sats === -30154,
  );
  t('an immature mined coin is marked', h.find((r) => r.label === 'Mined').immature === true);
  t('an unconfirmed incoming transaction is shown once', h.filter((r) => r.txid === 'ee'.repeat(32)).length === 1);
}
// ---- balances: a waiting payment never makes the total negative; its change counts as pending
{
  const c1 = coin(21, 10000);
  const sent = [{ txid: 'aa'.repeat(32), sats: 3000, fee: 155, change: 6845, pending: true, inputs: [c1.key] }];
  const b = W.balances({ coins: [c1], sent, height });
  t(
    'one coin of 10,000, a waiting send of 3,000: available 0, pending 6,845, total 6,845 (never negative)',
    b.available === 0 && b.pending === 6845 && b.total === 6845 && b.outgoing === 3155,
    JSON.stringify(b),
  );
  const b2 = W.balances({ coins: [c1, coin(22, 500000, { coinbase: true, height: 152090 })], sent: [], height, incoming: 4000 });
  t(
    'immature coinbase and unconfirmed incoming are counted apart and in the total',
    b2.available === 10000 && b2.immature === 500000 && b2.pending === 4000 && b2.total === 514000,
  );
  {
    const up = coin(23, 7000, { height: height - 1 });
    const b3 = W.balances({ coins: [c1, up], sent: [], height, vouched: height - 5 });
    t(
      'a coin above the signed chain tip is held and listed apart as above (no payment holds it)',
      b3.above.has(up.key) && b3.held.has(up.key) && !b3.above.has(c1.key) && b3.unvouched === 7000,
    );
  }
  {
    const self = W.balances({ coins: [c1], sent: [{ ...sent[0], self: true }], height });
    t(
      'a waiting payment to my own address costs only the fee: total 9,845',
      self.total === 9845 && self.outgoing === 155,
      JSON.stringify(self),
    );
  }
  {
    const r = [{ ...sent[0] }, { ...sent[0], txid: 'bb'.repeat(32), fee: 400, change: 6600 }];
    r[0].replacedBy = r[1].txid;
    const b3 = W.balances({ coins: [c1], sent: r, height });
    t(
      'a payment and its fee-raised replacement count once, at the worse of the two',
      b3.pending === 6600 && b3.outgoing === 3400 && b3.total === 6600,
      JSON.stringify(b3),
    );
  }
  {
    const r = [
      { ...sent[0] },
      { txid: 'bb'.repeat(32), sats: 0, fee: 400, change: 9600, self: true, kind: 'cancel', pending: true, inputs: [c1.key] },
    ];
    r[0].replacedBy = r[1].txid;
    const b4 = W.balances({ coins: [c1], sent: r, height });
    t('a cancel does not raise the balance before a block says it won', b4.total === 6845 && b4.outgoing === 3155, JSON.stringify(b4));
  }
  t('a refused payment holds nothing', W.balances({ coins: [c1], sent: [{ ...sent[0], refused: 'x' }], height }).available === 10000);
  {
    const r = W.balances({ coins: [c1, coin(23, 4000)], sent: [], height, reserved: new Set([c1.key]) });
    t(
      'coins another app reserves are not available, are counted apart and in the total',
      r.available === 4000 && r.elsewhere === 10000 && r.total === 14000 && r.held.has(c1.key),
    );
  }
  t(
    'an abandoned send no longer holds its coins',
    W.balances({ coins: [c1], sent: [{ ...sent[0], abandoned: true }], height }).available === 10000,
  );
}

// ---- the key for other wallets: WIF and a rawtr() descriptor, both round-tripping and checked against known vectors
{
  const sha = (b) => hash.sha256(b);
  const wif = W.toWif('0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d', sha);
  t(
    'the well-known compressed WIF of the textbook key decodes to it when mainnet is allowed, is refused by the wallet, and the testnet WIF starts with c',
    W.fromWif('KwdMAjGmerYanjeui5SHS7JkmpZvVipYvB2LJGU1ZxJwYvP98617', sha, { mainnet: true }) ===
      '0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d' &&
      W.fromWif('KwdMAjGmerYanjeui5SHS7JkmpZvVipYvB2LJGU1ZxJwYvP98617', sha) === null &&
      /^c/.test(wif),
    wif,
  );
  t(
    'a WIF decodes back to the key, a corrupted one does not',
    W.fromWif(wif, sha) === '0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d' &&
      W.fromWif(wif.slice(0, -1) + (wif.endsWith('x') ? 'y' : 'x'), sha) === null,
  );
  t(
    'a key is read from hex or WIF, anything else refused',
    W.parseKey(keyA.toUpperCase(), sha) === keyA &&
      W.parseKey(W.toWif(keyA, sha), sha) === keyA &&
      W.parseKey('hello', sha) === null &&
      W.parseKey('ab'.repeat(31), sha) === null,
  );
  t("the descriptor checksum matches BIP 380's example", W.descriptorChecksum('raw(deadbeef)') === '89f8spxm');
  t('the rawtr descriptor carries its checksum', /^rawtr\(c[1-9A-HJ-NP-Za-km-z]+\)#[a-z0-9]{8}$/.test(W.rawtrDescriptor(wif)));
}

// ---- the ledger keeps receipts after their coins are spent
{
  const ledger = new Map();
  const a = coin(31, 7000),
    b = { ...coin(31, 3000), key: coin(31, 1).key.slice(0, 65) + '5' };
  const added = W.recordReceipts(ledger, [a, b], () => false);
  t(
    'two outputs of one transaction are one receipt of their sum',
    added.length === 1 && W.receiptSats(ledger.get(a.key.slice(0, 64))) === 10000,
  );
  W.recordReceipts(ledger, [], () => false);
  const h = W.history({ coins: [], sent: [], height, address: 'x', ledger });
  t('once spent, the receipt is still in the history', h.length === 1 && h[0].sats === 10000 && h[0].kind === 'in');
  t('change of my own payment is never a receipt', W.recordReceipts(new Map(), [a], () => true).length === 0);
}
// ---- freeing coins never allows paying twice: a forgotten payment's coins go into the next payment first
{
  const small = coin(41, 3000),
    big = coin(42, 90000);
  const sent = [{ txid: 'fe'.repeat(32), sats: 2000, fee: 155, change: 845, pending: true, abandoned: true, inputs: [small.key] }];
  const first = W.reuseFirst(sent);
  const p = W.plan({
    coins: W.spendable([small, big], height, W.balances({ coins: [small, big], sent, height }).held, first),
    amount: 5000,
    rate: 1,
    destSpk: spkB,
    changeSpk: spkA,
  });
  t(
    'the next payment spends a coin of the forgotten one first, though a larger coin alone would do',
    p.picked[0].key === small.key && p.picked.length === 2,
  );
  t(
    "a refused payment's coins go first too",
    W.reuseFirst([{ ...sent[0], abandoned: false, refused: 'x' }]).has(small.key) && !W.reuseFirst([{ ...sent[0], abandoned: false }]).size,
  );
}
// ---- replacements: BIP 125 fees, who pays, signed and checked
{
  const c = coin(51, 100000);
  const p0 = W.plan({ coins: [c], amount: 30000, rate: 1, destSpk: spkB, changeSpk: spkA });
  const s = { inputs: [c.key], values: [c.value], sats: p0.amount, fee: p0.fee, change: p0.change, toScript: spkB };
  const r = W.planReplace(s, { rate: 1, ownSpk: spkA });
  const tx = W.unsignedTx({ picked: [c], outputs: r.outputs });
  const prev = [{ value: c.value, scriptPubKey: spkA }];
  txsign.signKeyPath({ k, hash, signer }, tx, prev, keyA);
  const vs = W.vsizeOf(k, tx);
  t(
    'a fee raise pays at least the old fee plus 1 sat/vB on its own size, and a higher rate, from the change',
    r.fee >= s.fee + vs &&
      r.fee / vs > s.fee / p0.vsize &&
      r.outputs[0].value === 30000 &&
      r.outputs[1].value === s.change - (r.fee - s.fee) &&
      k.interpreter.verifyInput(tx, 0, prev[0], prev, null, { unifiedSighash: unified }).ok === true,
    `fee ${r.fee} old ${s.fee} vsize ${vs}`,
  );
  const r2 = W.planReplace({ ...s, fee: r.fee, change: r.change }, { rate: 1, ownSpk: spkA });
  t('a raise of a raise climbs again', r2.fee >= r.fee + r2.vsize);
  const cx = W.planReplace(s, { cancel: true, rate: 1, ownSpk: spkA });
  t(
    "a cancel pays the coins back to the wallet, less a fee above the original's",
    cx.outputs.length === 1 && cx.outputs[0].scriptPubKey === spkA && cx.amount === 100000 - cx.fee && cx.fee >= s.fee + cx.vsize,
  );
  t(
    'a payment without change cannot be raised: cancel instead',
    throws(() => W.planReplace({ ...s, change: 0 }, { rate: 1, ownSpk: spkA }), /cancel it instead/),
  );
  const all = W.planReplace({ ...s, all: true, change: 0, sats: 100000 - s.fee }, { rate: 1, ownSpk: spkA });
  t(
    'raising the fee on a payment of everything says the recipient receives less',
    all.reducesRecipient && all.amount === 100000 - all.fee && all.outputs.length === 1,
  );
  t(
    'a raise with too little change is refused with the way out',
    throws(() => W.planReplace({ ...s, sats: 100000 - s.fee - 50, change: 50 }, { rate: 1, ownSpk: spkA }), /too small/),
  );
}

// ---- round 7: a comma that could mean a thousand times more, sizes past 252 inputs, no-change payments, released coins
t(
  '"0,001" is a decimal comma: 0.001, never 1',
  W.parseAmount('0,001') === 100000 && W.parseAmount('0,500') === 50000000 && W.parseAmount(',5') === 50000000,
);
t(
  '"1,500" alone is refused in tBTC and mtBTC (1500 or 1.5?), read in sat, and read with a dot',
  throws(() => W.parseAmount('1,500'), /dot for decimals/) &&
    throws(() => W.parseAmount('2,500', 'mtbtc'), /dot/) &&
    W.parseAmount('1,500', 'sats') === 1500 &&
    W.parseAmount('1,000.5') === 100050000000 &&
    W.parseAmount('12,5') === 1250000000,
);
{
  // 253 inputs: the input count takes three bytes; the estimate must not be below the real size (the fee would miss 1 sat/vB)
  const many = Array.from({ length: 253 }, (_, i) => coin(1000 + i, 1000));
  const p = W.plan({ coins: many, amount: 0, rate: 1, destSpk: spkB, changeSpk: spkA, all: true });
  const tx = W.unsignedTx(p);
  txsign.signKeyPath(
    { k, hash, signer },
    tx,
    p.picked.map((c) => ({ value: c.value, scriptPubKey: spkA })),
    keyA,
  );
  const real = W.vsizeOf(k, tx);
  t(
    '253 inputs: the size estimate is not below the signed size, so the fee meets the rate',
    p.vsize >= real && p.fee >= real,
    `estimate ${p.vsize}, real ${real}`,
  );
  const few = Array.from({ length: 252 }, (_, i) => coin(2000 + i, 1000));
  t(
    '252 inputs: one byte less in the count (the estimate steps by the varint)',
    W.estimateVsize(253, [spkB]) - W.estimateVsize(252, [spkB]) >= 60 && W.estimateVsize(252, [spkB]) - W.estimateVsize(251, [spkB]) <= 58,
    String(few.length),
  );
}
{
  const one = [coin(9, 10000)];
  const p = W.plan({ coins: one, amount: 9870, rate: 1, destSpk: spkB, changeSpk: spkA });
  t(
    'a payment the coins cover only without change is made without change, the rest to the fee',
    p.outputs.length === 1 && p.change === 0 && p.fee === 130 && p.fee >= p.vsize,
    JSON.stringify({ fee: p.fee, vsize: p.vsize }),
  );
  t(
    '...and one they cannot cover even then is still refused',
    throws(() => W.plan({ coins: one, amount: 9950, rate: 1, destSpk: spkB, changeSpk: spkA }), /not enough/),
  );
  t(
    'change of exactly 330 sat is kept as an output (dust is below it)',
    W.plan({ coins: one, amount: 10000 - 330 - 155, rate: 1, destSpk: spkB, changeSpk: spkA }).outputs.length === 2,
  );
  t(
    'the smallest payment is 546 sat: 545 is refused, 546 made',
    throws(() => W.plan({ coins: one, amount: 545, rate: 1, destSpk: spkB, changeSpk: spkA }), /smallest payment is 546 sat/) &&
      W.plan({ coins: one, amount: 546, rate: 1, destSpk: spkB, changeSpk: spkA }).amount === 546,
  );
}
t(
  'coins of a released set-aside record, and of a payment only refused here, go first',
  (() => {
    const f = W.reuseFirst(
      [{ pending: true, refusedNote: 'x', inputs: ['r:0'] }],
      [
        { pending: true, released: true, inputs: ['q:0'] },
        { pending: true, inputs: ['h:0'] },
      ],
    );
    return f.has('r:0') && f.has('q:0') && !f.has('h:0');
  })(),
);
t(
  'a coinbase is mature at exactly 100 confirmations, not 99',
  W.isMature({ coinbase: true, height: 100 }, 199) && !W.isMature({ coinbase: true, height: 100 }, 198),
);
{
  const L = new Map([
    ['m1', { txid: 'm1', outs: { 0: 5e9 }, height: 152090, coinbase: true }],
    ['m2', { txid: 'm2', outs: { 0: 5e9 }, height: 152095, coinbase: true }],
    ['r1', { txid: 'r1', outs: { 0: 1000 }, height: 152095, coinbase: false }],
  ]);
  const left = [{ key: 'm2:0', value: 5e9, height: 152095, coinbase: true }];
  const u = W.undoneReceipts(L, left, 152100);
  t(
    'a mined block whose immature coin is gone was undone; one still there, and a spent receipt, are not',
    u.length === 1 && u[0].txid === 'm1',
    JSON.stringify(u),
  );
  t(
    'a mature coinbase that is gone was spent, not undone',
    W.undoneReceipts(L, left, 152190 + 100).every((r) => r.txid !== 'm1'),
  );
  const hist = W.history({
    coins: left,
    sent: [{ txid: 's1', to: 'me', self: true, sats: 5000, fee: 155, pending: false, height: 152099 }],
    height: 152100,
    address: 'me',
    ledger: L,
  });
  t('a payment to yourself costs only its fee in the history', hist.find((r) => r.txid === 's1').sats === -155);
}
{
  const L = new Map();
  const tx = 'aa'.repeat(32);
  W.recordReceipts(L, [{ key: tx + ':0', value: 10, height: 100 }], () => false);
  W.recordReceipts(L, [{ key: tx + ':0', value: 10, height: 101 }], () => false);
  t('a receipt mined again in another block takes the new height', L.get(tx).height === 101);
}
{
  // the same 38 bytes with a valid checksum but a flag byte other than 01 (compressed): refused
  const body = Uint8Array.from([0xef, ...hash.hexToBytes(keyA), 0x02]);
  const sha = (b) => hash.sha256(b);
  const all = Uint8Array.from([...body, ...sha(sha(body)).slice(0, 4)]);
  let n = BigInt('0x' + hash.bytesToHex(all)),
    w = '';
  while (n > 0n) {
    w = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[Number(n % 58n)] + w;
    n /= 58n;
  }
  t(
    'a WIF with a valid checksum but no compressed flag is refused',
    W.fromWif(w, sha) === null && W.fromWif(W.toWif(keyA, sha), sha) === keyA,
  );
}
{
  const s0 = { inputs: ['a:0'], values: [100000], sats: 30000, fee: 155, change: 100000 - 30000 - 155, toScript: spkB };
  const r = W.planReplace({ ...s0, values: [10_000_000], change: 10_000_000 - 30000 - 155 }, { rate: 5000, ownSpk: spkA });
  t('a raise is capped at the highest fee rate', r.fee === W.MAX_RATE * r.vsize, JSON.stringify({ fee: r.fee, vsize: r.vsize }));
  t(
    'a cancel that would leave dust is refused',
    throws(
      () => W.planReplace({ ...s0, values: [400], fee: 100, sats: 0, change: 300 }, { cancel: true, rate: 1, ownSpk: spkA }),
      /cover the fee/,
    ),
  );
  const r2 = W.planReplace({ ...s0, values: [30000 + 155 + 355], change: 355 }, { rate: 1, ownSpk: spkA });
  t(
    'a raise that would leave dust change gives it to the fee: no dust output',
    r2.outputs.length === 1 && r2.fee === 510 && r2.change === 0,
    JSON.stringify(r2),
  );
}
{
  // the rate a raise starts from
  const s2 = { inputs: ['a:0'], fee: 155, change: 1000, toScript: spkB };
  const old = 155 / W.estimateVsize(1, [spkB, spkA]);
  t('a raise starts at least half again above the old rate', W.raiseRate({ s: s2, ownSpk: spkA }) === Math.ceil(old * 1.5));
  t(
    'the mempool cannot push it past three times the old rate',
    W.raiseRate({ s: s2, ownSpk: spkA, mempoolRate: 362 }) === Math.ceil(old * 3),
  );
  t("the person's own higher rate wins", W.raiseRate({ s: s2, ownSpk: spkA, optRate: 7 }) === 7);
  const allS = { inputs: ['a:0'], fee: 112, change: 0, all: true, toScript: spkB };
  t(
    'a payment of everything is sized with one output',
    W.raiseRate({ s: allS, ownSpk: spkA }) === Math.ceil((112 / W.estimateVsize(1, [spkB])) * 1.5),
  );
}
{
  // round 8
  const c = { kind: 'cancel', inputs: ['a:0'], values: [10000], sats: 0, change: 9600, fee: 400, toScript: spkA };
  t(
    'raising the fee on a cancel as if it were a payment is refused (it would pay 0 to yourself)',
    throws(() => W.planReplace(c, { rate: 1, ownSpk: spkA }), /raised as a cancel/),
  );
  const cc = W.planReplace(c, { cancel: true, rate: 5, ownSpk: spkA });
  t(
    'a cancel raised as a cancel pays everything back with a higher fee, one output',
    cc.outputs.length === 1 && cc.fee > 400 && cc.outputs[0].value === 10000 - cc.fee,
  );
  t(
    'no replacement has an output below dust',
    throws(
      () =>
        W.planReplace(
          { inputs: ['a:0'], values: [500], sats: 300, fee: 100, change: 100, toScript: spkB, all: false, kind: 'payment' },
          { cancel: true, rate: 1, ownSpk: spkA },
        ),
      /cover|too small/,
    ),
  );
  const orig = { txid: 'o', pending: true, inputs: ['k:0'], sats: 3000, fee: 155, change: 6845 };
  const ref = { txid: 'r', pending: true, refused: 'x', replaces: 'o', inputs: ['k:0'], sats: 3000, fee: 2000, change: 5000 };
  const bal = W.balances({ coins: [], sent: [orig, ref], height: 1 });
  t(
    'a replacement refused here still counts in the worse figures (it may be mined elsewhere)',
    bal.pending === 5000 && bal.outgoing === 5000,
    JSON.stringify(bal),
  );
  const H = W.history({
    coins: [],
    sent: [
      { txid: 'w'.repeat(64), to: 'x', sats: 1, fee: 1, pending: false, height: 100, at: 5 },
      { txid: 'l'.repeat(64), to: 'x', sats: 1, fee: 1, pending: false, replaced: 'w'.repeat(64), at: 4 },
      { txid: 'n'.repeat(64), to: 'x', sats: 1, fee: 1, pending: false, height: 101, at: 6 },
    ],
    height: 110,
    address: 'me',
  });
  t(
    'a version that did not happen sits right under the one that won, not at the top',
    H.map((r) => r.txid[0]).join('') === 'nwl',
    H.map((r) => r.txid[0]).join(''),
  );
  const L = new Map();
  W.recordReceipts(L, [{ key: 'ab'.repeat(32) + ':0', value: 1, height: 1 }], () => false, 777);
  t('a receipt remembers when this wallet first saw it', L.get('ab'.repeat(32)).at === 777);
}
{
  const T1 = '11'.repeat(32),
    T2 = '22'.repeat(32),
    T3 = '33'.repeat(32),
    T4 = '44'.repeat(32);
  const L = new Map([
    [T1, { txid: T1, outs: { 0: 5 }, height: 100 }],
    [T2, { txid: T2, outs: { 1: 5 }, height: 100 }],
    [T3, { txid: T3, outs: { 0: 5 }, height: 100 }],
    [T4, { txid: T4, outs: { 0: 5 }, height: 100, spentElsewhere: true }],
  ]);
  const q = W.receiptsToCheck(L, [{ key: T1 + ':0', value: 5, height: 100 }], [{ inputs: [T2 + ':1'] }], 105);
  t(
    'a receipt is asked about only when its coins went without a payment of ours, once',
    q.length === 1 && q[0].txid === T3 && q[0].key === T3 + ':0' && q[0].from === 100,
    JSON.stringify(q),
  );
  L.get(T3).checkedAt = 105;
  t(
    '...not again in the same block, and not past 100 blocks',
    W.receiptsToCheck(L, [], [], 105).every((x) => x.txid !== T3) && W.receiptsToCheck(L, [], [], 200).length === 0,
  );
}
{
  // round 8: boundaries
  const s10 = { inputs: ['a:0'], fee: 1550, change: 100000, toScript: spkB };
  const old = 1550 / W.estimateVsize(1, [spkB, spkA]);
  t(
    'a raise from about 10 sat/vB starts at half again (not a fifth again)',
    W.raiseRate({ s: s10, ownSpk: spkA }) === Math.ceil(old * 1.5),
    String(W.raiseRate({ s: s10, ownSpk: spkA })),
  );
  t(
    'the starting rate is sized on the payment as it was (two outputs, not one)',
    W.raiseRate({ s: s10, ownSpk: spkA }) === Math.ceil((1550 / W.estimateVsize(1, [spkB, spkA])) * 1.5) &&
      W.raiseRate({ s: { ...s10, all: true, change: 0 }, ownSpk: spkA }) === Math.ceil((1550 / W.estimateVsize(1, [spkB])) * 1.5) &&
      W.raiseRate({ s: s10, ownSpk: spkA }) !== W.raiseRate({ s: { ...s10, all: true, change: 0 }, ownSpk: spkA }),
  );
  t('the starting rate never passes the highest rate', W.raiseRate({ s: { ...s10, fee: 10_000_000 }, ownSpk: spkA }) === W.MAX_RATE);
  t(
    'raising a payment of everything that would leave less than 546 sat is refused',
    throws(
      () =>
        W.planReplace(
          { inputs: ['a:0'], values: [800], sats: 600, fee: 200, change: 0, all: true, toScript: spkB },
          { rate: 1, ownSpk: spkA },
        ),
      /minimum/,
    ),
  );
  t(
    'a replacement needs the value of every coin it spends',
    throws(
      () =>
        W.planReplace({ inputs: ['a:0', 'b:0'], values: [800], sats: 600, fee: 200, change: 0, toScript: spkB }, { rate: 1, ownSpk: spkA }),
      /only a waiting payment/,
    ),
  );
  t(
    'a cancel never says it reduces the recipient',
    W.planReplace(
      { inputs: ['a:0'], values: [100000], sats: 600, fee: 200, change: 0, all: true, toScript: spkB },
      { cancel: true, rate: 1, ownSpk: spkA },
    ).reducesRecipient === false,
  );
  const T = 'ef'.repeat(32);
  const L = new Map([[T, { txid: T, outs: { 0: 5 }, height: 100, coinbase: true }]]);
  t(
    'an undone mined block is judged only while its coin is immature (at 99, not 100, confirmations)',
    W.undoneReceipts(L, [], 198).length === 1 && W.undoneReceipts(L, [], 199).length === 0,
  );
  t('with no height known, nothing is judged undone', W.undoneReceipts(L, [], null).length === 0);
  const L2 = new Map();
  W.recordReceipts(L2, [{ key: T + ':0', value: 5, height: 100 }], () => false);
  W.recordReceipts(L2, [{ key: T + ':1', value: 7, height: 100 }], () => false);
  t('a second output of the same receipt is added to it', W.receiptSats(L2.get(T)) === 12);
  const H = W.history({
    coins: [],
    sent: [],
    height: 198,
    address: 'me',
    ledger: new Map([[T, { txid: T, outs: { 0: 5 }, height: 100, coinbase: true }]]),
  });
  t(
    'a mined coin is immature at 99 confirmations and mature at 100',
    H[0].immature === true &&
      W.history({
        coins: [],
        sent: [],
        height: 199,
        address: 'me',
        ledger: new Map([[T, { txid: T, outs: { 0: 5 }, height: 100, coinbase: true }]]),
      })[0].immature === false,
  );
}
{
  // the records the page writes for what it signs pass the stored-record check against their own signed transactions
  const S = await import('../lib/state.mjs');
  const check = (hex) => {
    const t2 = k.codec.decode('Transaction', hex);
    return {
      txid: k.codec.txid(t2),
      inputs: t2.inputs.map((i) => `${i.prevout.txid}:${i.prevout.vout}`),
      outputs: t2.outputs.map((o) => ({ value: o.value, scriptPubKey: o.scriptPubKey })),
    };
  };
  const scriptOf = (a) => addr.decodeAddress(a)?.script ?? null;
  const toB = addr.scriptToAddress(spkB, 'tb');
  const p = W.plan({ coins: [coin(77, 100000)], amount: 30000, rate: 1, destSpk: spkB, changeSpk: spkA });
  const tx = W.unsignedTx(p);
  txsign.signKeyPath(
    { k, hash, signer },
    tx,
    p.picked.map((c) => ({ value: c.value, scriptPubKey: spkA })),
    keyA,
  );
  const hex = k.codec.encodeHex('Transaction', tx);
  const rec = S.paymentRecord(p, { txid: k.codec.txid(tx), hex, to: toB, toScript: spkB, tip: 152100 });
  t(
    'a payment record built from a signed payment passes the stored-record check',
    S.validRecord({ ...rec }, { check, scriptOf, ownScript: spkA }),
    JSON.stringify({ to: toB }),
  );
  const pr = W.planReplace(rec, { cancel: true, rate: 3, ownSpk: spkA });
  const tx2 = W.unsignedTx({ picked: p.picked, outputs: pr.outputs });
  txsign.signKeyPath(
    { k, hash, signer },
    tx2,
    p.picked.map((c) => ({ value: c.value, scriptPubKey: spkA })),
    keyA,
  );
  const ownAddr = addr.scriptToAddress(spkA, 'tb');
  const cx = S.replacementRecord(rec, pr, {
    cancel: true,
    txid: k.codec.txid(tx2),
    hex: k.codec.encodeHex('Transaction', tx2),
    address: ownAddr,
    script: spkA,
    tip: 152101,
  });
  t(
    'a cancel record built from a signed cancel passes the check, as a cancel to yourself',
    S.validRecord({ ...cx }, { check, scriptOf, ownScript: spkA }) && cx.kind === 'cancel' && cx.self && cx.replaces === rec.txid,
  );
  const pr2 = W.planReplace(rec, { rate: 3, ownSpk: spkA });
  const tx3 = W.unsignedTx({ picked: p.picked, outputs: pr2.outputs });
  txsign.signKeyPath(
    { k, hash, signer },
    tx3,
    p.picked.map((c) => ({ value: c.value, scriptPubKey: spkA })),
    keyA,
  );
  const up = S.replacementRecord(rec, pr2, {
    cancel: false,
    txid: k.codec.txid(tx3),
    hex: k.codec.encodeHex('Transaction', tx3),
    address: ownAddr,
    script: spkA,
    tip: 152101,
  });
  t(
    'a fee-raise record passes the check and keeps the recipient',
    S.validRecord({ ...up }, { check, scriptOf, ownScript: spkA }) && up.to === toB && up.sats === 30000 && up.fee > rec.fee,
  );
}
{
  const T = 'ab'.repeat(32);
  const mk = () => new Map([[T, { txid: T, outs: { 0: 5 }, height: 100, checkedAt: 105 }]]);
  let L = mk();
  t(
    'a receipt found spent elsewhere is kept and not asked about again',
    W.onReceiptAnswer(L, T, { found: true }, 105) === 'spent' && L.get(T).spentElsewhere,
  );
  L = mk();
  t(
    '"not found" from a search that reached our height removes it as undone',
    W.onReceiptAnswer(L, T, { found: false, to: 105 }, 105) === 'removed' && !L.has(T),
  );
  L = mk();
  t(
    '"not found" from a search that stopped short proves nothing: kept, asked again',
    W.onReceiptAnswer(L, T, { found: false, to: 104 }, 105) === 'ignore' && L.has(T) && L.get(T).checkedAt == null,
  );
  L = mk();
  t('...nor does an answer without how far it searched', W.onReceiptAnswer(L, T, { found: false }, 105) === 'ignore' && L.has(T));
}
t(
  'coins of a set-aside record that was forgotten or refused here go first too (its transaction may still be mined)',
  (() => {
    const f = W.reuseFirst(
      [],
      [
        { pending: true, abandoned: true, inputs: ['f:0'] },
        { pending: true, refusedNote: 'x', inputs: ['g:0'] },
        { pending: true, inputs: ['h:0'] },
      ],
    );
    return f.has('f:0') && f.has('g:0') && !f.has('h:0');
  })(),
);
{
  const T1 = 'c1'.repeat(32);
  const L = new Map();
  W.recordReceipts(L, [{ key: T1 + ':0', value: 5e9, height: 152000, coinbase: true }], () => false);
  t('a mined reward is recorded as mined (the flag the undone-block check needs)', L.get(T1).coinbase === true);
  const H = W.history({
    coins: [],
    sent: [pay2({ txid: 'f'.repeat(64), failed: 'g'.repeat(64), pending: false })],
    height: 152100,
    address: 'me',
  });
  t('a payment that did not happen counts 0 in the history (and the export)', H[0].sats === 0);
  t(
    'a tombstone is not a row',
    W.history({ coins: [], sent: [{ txid: 'a'.repeat(64), tomb: true }], height: 1, address: 'me' }).length === 0,
  );
  const one = [coin(31, 10000)];
  const exact = 10000 - Math.ceil(W.estimateVsize(1, [spkB, spkA]));
  t(
    'a payment that uses the coin to the last sat (exactly amount + fee) is made',
    W.plan({ coins: one, amount: exact, rate: 1, destSpk: spkB, changeSpk: spkA }).amount === exact,
  );
}
{
  const cs = [
    { key: 'a:0', value: 1000, height: 152100 },
    { key: 'b:0', value: 5000, height: 152101 },
  ];
  const b = W.balances({ coins: cs, sent: [], height: 152101, vouched: 152100 });
  t(
    'a coin in a block above the signed tip is pending, not available, and not spendable',
    b.available === 1000 && b.unvouched === 5000 && b.pending === 5000 && b.total === 6000 && b.held.has('b:0'),
  );
  t('with no limit known, every coin counts as before', W.balances({ coins: cs, sent: [], height: 152101 }).available === 6000);
  t(
    '"1.000.000" is refused in tBTC (dots as thousands), "1.000" stays one',
    throws(() => W.parseAmount('1.000.000'), /one dot/) && W.parseAmount('1.000') === 100000000,
  );
}
{
  // the two halves together: a waiting payment whose change is in a block above the signed tip
  const S = await import('../lib/state.mjs');
  const T1 = 'e1'.repeat(32);
  const p = { txid: T1, pending: true, inputs: ['in:0'], sats: 3000, fee: 155, change: 6845, hex: '00' };
  const coins = [{ key: T1 + ':1', value: 6845, height: 152102 }];
  S.onCoins({ sent: [p], coins, height: 152102, vouched: 152101 });
  const b = W.balances({ coins, sent: [p], height: 152102, vouched: 152101 });
  t(
    "a waiting payment's change above the signed tip is counted once (as coming back), not twice",
    p.pending && b.pending === 6845 && b.total === 6845 && b.unvouched === 0,
    JSON.stringify(b),
  );
}
{
  const cs = [
    { key: 'a:0', value: 900000, height: 1 },
    { key: 'b:0', value: 300000, height: 1 },
    { key: 'c:0', value: 50000, height: 1 },
  ];
  const order = W.spendable(cs, 200, new Set(), new Set(['a:0', 'b:0']), new Set(['b:0']))
    .map((c) => c.key)
    .join();
  t(
    "paying a forgotten payment's recipient again spends that payment's own coin before any other forgotten one",
    order === 'b:0,a:0,c:0',
    order,
  );
}
// ---- round 13: guards the mutation run found unpinned
t(
  'a version-0 address with a 25-byte program is refused (only 20 and 32 bytes are segwit v0)',
  /not a valid segwit/.test(
    W.checkDestination({ hrp: 'tb', version: 0, program: 'ab'.repeat(25), script: '0019' + 'ab'.repeat(25) }).error ?? '',
  ),
);
{
  // a transaction in the tip block has one confirmation, in both ways the history is built (from coins, from the ledger)
  const tip = 152100;
  const c = { key: 'a1'.repeat(32) + ':0', value: 5000, height: tip };
  const fromCoins = W.history({ coins: [c], sent: [], height: tip, address: 'tb1pme' });
  const ledger = new Map([['a1'.repeat(32), { txid: 'a1'.repeat(32), height: tip, outs: [{ n: 0, value: 5000 }], value: 5000 }]]);
  const fromLedger = W.history({ coins: [c], sent: [], height: tip, address: 'tb1pme', ledger });
  t(
    'a transaction in the tip block has 1 confirmation (not 0), from coins and from the ledger',
    fromCoins[0]?.conf === 1 && fromLedger[0]?.conf === 1,
    JSON.stringify([fromCoins[0]?.conf, fromLedger[0]?.conf]),
  );
  // a mined coin of the tip block is immature in the ledger rows too, and mature exactly 100 blocks on
  const mined = new Map([
    ['a2'.repeat(32), { txid: 'a2'.repeat(32), height: tip, coinbase: true, outs: [{ n: 0, value: 5000 }], value: 5000 }],
  ]);
  t(
    'a mined coin in the ledger is immature until its 100th confirmation, and mature at it',
    W.history({ coins: [], sent: [], height: tip + 98, address: 'x', ledger: mined })[0].immature === true &&
      W.history({ coins: [], sent: [], height: tip + 99, address: 'x', ledger: mined })[0].immature === false,
  );
}
t(
  'maturity is counted at the vouched height when it is lower (a source that inflates its height matures nothing early)',
  W.maturityHeight(152200, 152100) === 152100 && W.maturityHeight(152100, 152200) === 152100 && W.maturityHeight(152100, null) === 152100,
);
t(
  'a mined coin counts as available only once mature at the vouched height',
  W.balances({
    coins: [{ key: 'b1'.repeat(32) + ':0', value: 7000, height: 152000, coinbase: true }],
    sent: [],
    height: 152099,
    vouched: 152098,
  }).available === 0 &&
    W.balances({
      coins: [{ key: 'b1'.repeat(32) + ':0', value: 7000, height: 152000, coinbase: true }],
      sent: [],
      height: 152099,
      vouched: 152099,
    }).available === 7000,
);
// ---- round 14: the exact limits of a replacement, and the transaction's version and lock time
{
  const tx = W.unsignedTx({ picked: [coin(61, 5000)], outputs: [{ value: 4000, scriptPubKey: spkB }] });
  t(
    'a payment is version 2 with lock time 0, and every input signals replacement (not version 3, not a future lock time)',
    tx.version === 2 && tx.lockTime === 0 && tx.inputs.every((i) => i.sequence === 0xfffffffd),
    JSON.stringify({ version: tx.version, lockTime: tx.lockTime }),
  );
  const s0 = { inputs: ['a:0'], sats: 30000, fee: 155, change: 1, toScript: spkB };
  // a cancel: what comes back must be at least DUST, exactly
  const vsC = W.estimateVsize(1, [spkA]),
    feeC = s0.fee + vsC;
  const cancelAt = (back) => () => W.planReplace({ ...s0, values: [feeC + back] }, { cancel: true, rate: 1, ownSpk: spkA });
  t(
    'a cancel that pays back exactly DUST is made; one sat less is refused',
    cancelAt(W.DUST)().amount === W.DUST && throws(cancelAt(W.DUST - 1), /cover the fee/),
  );
  // a payment of everything: the recipient must receive at least MIN_SEND, exactly
  const vsA = W.estimateVsize(1, [spkB]),
    feeA = s0.fee + vsA;
  const allAt = (left) => () => W.planReplace({ ...s0, all: true, change: 0, values: [feeA + left] }, { rate: 1, ownSpk: spkA });
  t(
    'raising a payment of everything that leaves exactly MIN_SEND is made; one sat less is refused',
    allAt(W.MIN_SEND)().amount === W.MIN_SEND && throws(allAt(W.MIN_SEND - 1), /less than the minimum/),
  );
  // a raise from the change: change of exactly 0 is made (no change output), -1 is refused
  const vsR = W.estimateVsize(1, [spkB, spkA]),
    feeR = s0.fee + vsR;
  const raiseAt = (ch) => () => W.planReplace({ ...s0, values: [s0.sats + feeR + ch] }, { rate: 1, ownSpk: spkA });
  const r0 = raiseAt(0)();
  t(
    'a raise that uses up the change exactly is made with one output; a sat short is refused',
    r0.outputs.length === 1 && r0.change === 0 && r0.fee === feeR && throws(raiseAt(-1), /too small to raise/),
    JSON.stringify(r0),
  );
}
// ---- round 14: the worse-case balance counts a refused replacement only while its original still waits
{
  const a = coin(71, 50000),
    b = coin(72, 40000);
  const orig = { txid: 'o'.repeat(64), inputs: [a.key], values: [a.value], sats: 20000, fee: 200, change: 29800, pending: true, at: 1 };
  // the replacement pays more fee and returns less: refused here, it may still be mined elsewhere
  const repl = { ...orig, txid: 'r'.repeat(64), fee: 2000, change: 28000, refused: 'x', replaces: orig.txid };
  const base = W.balances({ coins: [a, b], sent: [orig], height: 152100 });
  const both = W.balances({ coins: [a, b], sent: [orig, repl], height: 152100 });
  t(
    'a refused replacement of a waiting payment is counted in the worse case: the least coming back, the most going out',
    base.returning === 29800 &&
      base.outgoing === 20200 &&
      both.returning === 28000 &&
      both.outgoing === 22000 &&
      both.total === base.total - 1800,
    JSON.stringify({ base, both }),
  );
  const shapes = [
    ['not pending', { ...repl, pending: false }],
    ['abandoned', { ...repl, abandoned: true }],
    ['not a replacement', { ...repl, replaces: undefined }],
    ['of another payment (no shared coin)', { ...repl, inputs: [b.key] }],
  ];
  const same = (r) => JSON.stringify(W.balances({ coins: [a, b], sent: [orig, r], height: 152100 })) === JSON.stringify(base);
  t(
    'a refused one that is not pending, abandoned, not a replacement, or of another payment changes nothing',
    shapes.every(([, r]) => same(r)),
    shapes
      .filter(([, r]) => r && !same(r))
      .map(([n]) => n)
      .join(', '),
  );
  // and with its original abandoned, a refused replacement has nothing to stand beside
  const origGone = { ...orig, abandoned: true };
  t(
    'a refused replacement whose original is no longer waiting is not counted',
    JSON.stringify(W.balances({ coins: [a, b], sent: [origGone, repl], height: 152100 })) ===
      JSON.stringify(W.balances({ coins: [a, b], sent: [origGone], height: 152100 })),
  );
}

// ---- round 14: a version that did not happen moves no money in the list, whether it was replaced or failed
{
  const won = { txid: 'a1'.repeat(32), to: 'tb1pthem', sats: 5000, fee: 300, pending: false, height: 152090, inputs: ['x:0'] };
  const rows = (o) =>
    W.history({
      coins: [],
      sent: [won, { txid: 'b2'.repeat(32), to: 'tb1pthem', sats: 5000, fee: 200, pending: false, inputs: ['x:0'], ...o }],
      height: 152100,
      address: 'tb1pme',
    });
  const lost = (o) => rows(o).find((r) => r.txid === 'b2'.repeat(32));
  t(
    'a replaced version (not failed) and a failed one both show 0, and the version that won shows what it cost',
    lost({ replaced: won.txid }).sats === 0 &&
      lost({ failed: won.txid }).sats === 0 &&
      rows({ replaced: won.txid }).find((r) => r.txid === won.txid).sats === -5300,
    JSON.stringify(lost({ replaced: won.txid })),
  );
}

console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
