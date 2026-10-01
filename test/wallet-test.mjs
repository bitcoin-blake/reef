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
    throws(() => W.plan({ coins: one, amount: 545, rate: 1, destSpk: spkB, changeSpk: spkA }), /at least 546/) &&
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
console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
