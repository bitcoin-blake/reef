// The payment records through the orderings that matter: two tabs merging, a payment confirmed by its change or by the
// node's spend lookup, a replacement that wins or loses, a refused replacement, republishing, forgetting.
import * as S from '../lib/state.mjs';
let ok = 0,
  bad = 0;
const t = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`);
  cond ? ok++ : bad++;
};
const tx = (c) => c.repeat(64);
const inA = tx('a') + ':0',
  inB = tx('b') + ':1';
const pay = (over = {}) => ({
  txid: tx('1'),
  to: 'tb1pdest',
  toScript: '5120' + 'dd'.repeat(32),
  sats: 3000,
  fee: 155,
  change: 6845,
  kind: 'payment',
  hex: '00',
  inputs: [inA],
  values: [10000],
  tip: 152100,
  at: 1000,
  lastPub: 1000,
  relays: ['wss://r'],
  pending: true,
  ...over,
});
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---- merging two tabs' copies
{
  const mine = [pay()];
  const other = [pay({ replacedBy: tx('2') }), pay({ txid: tx('2'), fee: 400, change: 6600, replaces: tx('1'), at: 2000 })];
  const m = S.mergeSent(clone(mine), clone(other));
  const orig = m.find((s) => s.txid === tx('1'));
  t(
    'a replacement made in the other tab survives the merge: replacedBy is sticky and the replacement is added',
    orig.replacedBy === tx('2') && m.length === 2,
  );
  const back = S.mergeSent(clone(other), clone(mine));
  t(
    'the merge is the same whichever side is "mine"',
    JSON.stringify(back.map((s) => [s.txid, s.replacedBy ?? null, s.pending])) ===
      JSON.stringify(m.map((s) => [s.txid, s.replacedBy ?? null, s.pending])),
  );
  t('merging with itself changes nothing (idempotent)', JSON.stringify(S.mergeSent(clone(m), clone(m))) === JSON.stringify(m));
  const settled = S.mergeSent([pay()], [pay({ pending: false, height: 152105 })]);
  t('a settlement learnt by either copy wins', settled[0].pending === false && settled[0].height === 152105);
  const rec = S.mergeSent([pay({ recovered: true, to: '(seen in the mempool)', hex: undefined, fee: 0 })], [pay()]);
  t(
    'a hex-less copy recovered from the mempool does not replace the record with the signed transaction',
    rec[0].hex === '00' && rec[0].to === 'tb1pdest' && !rec[0].recovered && rec[0].fee === 155,
  );
}
{
  const many = Array.from({ length: 400 }, (_, i) =>
    pay({ txid: i.toString(16).padStart(64, '0'), pending: i >= 395, at: i, height: 152000 + i }),
  );
  const kept = S.trimSent(many, 300);
  t(
    'trimming keeps every pending payment and leaves a tombstone for each settled one dropped',
    kept.filter((s) => s.pending).length === 5 &&
      kept.filter((s) => s.tomb).length === 95 &&
      kept.length === 400 &&
      kept.filter((s) => s.tomb).every((s) => !s.hex),
  );
}

// ---- confirmation
{
  const sent = [pay()];
  const fx = S.onCoins({ sent, coins: [{ key: tx('1') + ':1', value: 6845, height: 152103 }] });
  t(
    'a payment is confirmed by its change coin',
    !sent[0].pending && sent[0].height === 152103 && fx.some((e) => e.notice === 'Payment confirmed'),
  );
}
{
  const sent = [pay({ change: 0 })];
  const asked = new Set();
  const fx = S.onCoins({ sent, coins: [], asked });
  t(
    'without change, inputs gone: the node is asked which transaction spent them, once',
    fx.length === 1 && fx[0].ask === tx('1') && fx[0].input === inA && S.onCoins({ sent, coins: [], asked }).length === 0,
  );
  const fx2 = S.onSpendAnswer(sent, tx('1'), { found: true, txid: tx('1'), height: 152104 });
  t(
    'the answer naming our transaction confirms it',
    !sent[0].pending && sent[0].height === 152104 && fx2[0].notice === 'Payment confirmed',
  );
}
{
  const sent = [pay({ change: 0 })];
  const fx = S.onSpendAnswer(sent, tx('1'), { found: true, txid: tx('9'), height: 152104 });
  t(
    'an answer naming a transaction we never made: the payment did not happen, said as a failure',
    !sent[0].pending && sent[0].replaced === tx('9') && fx[0].bad,
  );
}
t(
  'a spend answer for a payment already settled changes nothing',
  S.onSpendAnswer([pay({ pending: false, height: 5 })], tx('1'), { found: true, txid: tx('9'), height: 6 }).length === 0,
);

// ---- replacements: who wins
{
  const sent = [pay({ replacedBy: tx('2') }), pay({ txid: tx('2'), fee: 400, change: 6600, replaces: tx('1') })];
  S.onCoins({ sent, coins: [{ key: tx('2') + ':1', value: 6600, height: 152106 }] });
  t(
    'the replacement is mined: it is confirmed, the original did not happen',
    !sent[1].pending && sent[1].height === 152106 && sent[0].replaced === tx('2') && !sent[0].pending,
  );
}
{
  const sent = [
    pay({ replacedBy: tx('2') }),
    pay({ txid: tx('2'), kind: 'cancel', self: true, sats: 0, fee: 400, change: 9600, replaces: tx('1') }),
  ];
  const fx = S.onCoins({ sent, coins: [{ key: tx('1') + ':1', value: 6845, height: 152106 }] });
  t(
    'the original wins over a cancel: the payment is confirmed, the cancel is marked not taken',
    !sent[0].pending &&
      sent[0].height === 152106 &&
      sent[1].replaced === tx('1') &&
      /too late/.test(S.stateOf(sent[1], { inMempool: () => false, height: 152106, now: 0 })) &&
      fx[0].notice === 'Payment confirmed',
  );
}
{
  const sent = [pay({ replacedBy: tx('2') }), pay({ txid: tx('2'), fee: 400, change: 6600, replaces: tx('1') })];
  const fx = S.onRefused(sent, tx('2'), 'a replacement must pay at least 266 sat', '00');
  t(
    'a refused replacement stops being published and the original stands again',
    sent[1].refused &&
      !sent[0].replacedBy &&
      fx[0].bad &&
      S.republishDue(sent, 1e12)
        .map((s) => s.txid)
        .join() === tx('1'),
  );
}

// ---- republishing and forgetting
{
  const now = 5_000_000;
  const sent = [
    pay({ lastPub: now - 60e3 }),
    pay({ txid: tx('3'), lastPub: now - 11 * 60e3 }),
    pay({ txid: tx('4'), lastPub: 0, hex: undefined }),
    pay({ txid: tx('5'), lastPub: 0, replacedBy: tx('6') }),
    pay({ txid: tx('7'), lastPub: 0, abandoned: true }),
  ];
  t(
    'republished: only waiting payments with their signed transaction, not replaced, not forgotten, after 10 minutes',
    S.republishDue(sent, now)
      .map((s) => s.txid)
      .join() === tx('3'),
  );
}
{
  const sent = [pay({ tip: 152100 })];
  const inMp = (id) => id === tx('1');
  t("a payment in the tab's mempool is never offered to forget", !S.forgettable(sent, sent[0], 152120, inMp));
  t(
    'one waiting 6 blocks and not in the mempool may be forgotten; 5 blocks not yet',
    S.forgettable(sent, sent[0], 152106, () => false) && !S.forgettable(sent, sent[0], 152105, () => false),
  );
}
{
  const st = (s, o = {}) => S.stateOf(s, { inMempool: () => false, height: 152101, now: 2000, ...o });
  t(
    'the states read in words, each with what to do next',
    st(pay()) === 'handed to the relays' &&
      /retrying/.test(st(pay({ relays: [] }))) &&
      st(pay(), { inMempool: () => true }) === 'waiting for a block' &&
      /raise the fee/.test(st(pay({ tip: 152097 }), { inMempool: () => true })) &&
      /higher fee/.test(st(pay({ replacedBy: 'x' }))) &&
      /original stands/.test(st(pay({ refused: 'too cheap' }))) &&
      /cancel it/.test(st(pay({ refusedNote: 'fee' }))) &&
      /next payment/.test(st(pay({ abandoned: true }))) &&
      /made elsewhere/.test(st(pay({ hex: undefined }))) &&
      /^[0-9,]+ confirmations$/.test(st(pay({ pending: false, height: 1 }))) &&
      /confirming \(2 of 6\)/.test(st(pay({ pending: false, height: 152100 }))) &&
      /every 10 minutes/.test(st(pay(), { now: 2000 + 11 * 60e3 })),
  );
}

// ---- round three: the persist round trip the page performs
{
  const stored = [pay({ replacedBy: tx('2') }), pay({ txid: tx('2'), fee: 400, change: 6600, replaces: tx('1') })];
  const mem = clone(stored);
  S.onRefused(mem, tx('2'), 'too cheap', '00');
  const merged = S.mergeSent(mem, clone(stored));
  const orig = merged.find((s) => s.txid === tx('1'));
  t(
    'a refused replacement, merged with the copy stored before the refusal, still leaves the original standing and published again',
    !orig.replacedBy &&
      S.republishDue(merged, 1e12)
        .map((s) => s.txid)
        .join() === tx('1'),
  );
}
{
  const full = pay({ pending: true });
  const tomb = { txid: tx('1'), pending: false, tomb: true, at: 1 };
  const m = S.mergeSent([tomb], [clone(full)]);
  t('a tombstone never overrules a full record', m[0].hex === '00' && !m[0].tomb);
}
{
  let list = [];
  for (let r = 0; r < 4; r++)
    list = S.trimSent(
      [
        ...list,
        ...Array.from({ length: 200 }, (_, i) =>
          pay({ txid: (r * 1000 + i).toString(16).padStart(64, '0'), pending: false, at: r * 1000 + i }),
        ),
      ],
      100,
      250,
    );
  t('tombstones are capped', list.filter((s) => s.tomb).length === 250 && list.filter((s) => !s.tomb).length === 100);
}
{
  const sent = [pay({ change: 0 })];
  t(
    'a spend answer that found nothing changes nothing (the page asks again later)',
    S.onSpendAnswer(sent, tx('1'), { found: false }).length === 0 && sent[0].pending,
  );
}
// ---- refusals are only of the exact bytes we signed; an original is never let go by one
{
  const sent = [pay()];
  const fx = S.onRefused(sent, tx('1'), 'input 0: bad signature', 'ff');
  t(
    'a refusal of a copy with other bytes (a broken signature, same txid) changes nothing',
    fx.length === 0 && !sent[0].refused && !sent[0].refusedNote,
  );
  const fx2 = S.onRefused(sent, tx('1'), 'fee too low', '00');
  const W2 = await import('../lib/wallet.mjs');
  t(
    'a refusal of our own original is a note: its coins stay held, and it is not announced again (a refusal is never routed around)',
    fx2.length === 1 &&
      sent[0].refusedNote &&
      !sent[0].refused &&
      S.republishDue(sent, 1e12).length === 0 &&
      W2.balances({ coins: [{ key: inA, value: 10000, height: 1 }], sent, height: 10 }).available === 0,
  );
}
// ---- stored records are checked against their own transaction
{
  const check = (hex) =>
    hex === '00'
      ? {
          txid: tx('1'),
          inputs: [inA],
          outputs: [
            { value: 3000, scriptPubKey: '5120' + 'dd'.repeat(32) },
            { value: 6845, scriptPubKey: '5120' + 'ee'.repeat(32) },
          ],
        }
      : { txid: tx('9'), inputs: [] };
  const scriptOf = (a) => (a === 'tb1pdest' ? '5120' + 'dd'.repeat(32) : null);
  t('a record whose hex is its own transaction is kept', S.validRecord(pay(), { check, scriptOf }));
  t(
    'a record whose hex is another transaction, or whose destination does not match its address, is dropped',
    !S.validRecord(pay({ hex: 'deadbeef' }), { check, scriptOf }) &&
      !S.validRecord(pay({ toScript: '5120' + 'ee'.repeat(32) }), { check, scriptOf }) &&
      !S.validRecord({ txid: 'x' }, { check, scriptOf }),
  );
}
// ---- a reorganisation: the verdict learnt last wins the merge
{
  const P = pay({ replacedBy: tx('2') }),
    R = pay({ txid: tx('2'), fee: 400, change: 6600, replaces: tx('1') });
  const a = [P, R];
  S.confirm(a, R, 152106);
  const stored = clone(a);
  await new Promise((r) => setTimeout(r, 5));
  S.confirm(a, P, 152107);
  const m = S.mergeSent(a, stored);
  t(
    'after a reorganisation mines the original instead, the merge keeps the newer verdict',
    !m.find((x) => x.txid === tx('1')).replaced &&
      m.find((x) => x.txid === tx('1')).height === 152107 &&
      m.find((x) => x.txid === tx('2')).replaced === tx('1'),
  );
}
// ---- forgetting is measured from the newest version of a payment
{
  const sent = [pay({ tip: 152100, replacedBy: tx('2') }), pay({ txid: tx('2'), tip: 152105, replaces: tx('1') })];
  t(
    'a payment raised at 152,105 is not forgettable at 152,107 though the original is old',
    !S.forgettable(sent, sent[0], 152107, () => false) && S.forgettable(sent, sent[0], 152111, () => false),
  );
}
// ---- round four: a payment made after a forget is not a version of the forgotten one
{
  const mk = () => {
    const A = pay({ txid: tx('a'), to: 'tb1px', abandoned: true, inputs: [inA] });
    const B = pay({ txid: tx('b'), to: 'tb1py', sats: 5000, inputs: [inA, inB], at: 3000 });
    return [A, B];
  };
  {
    const sent = mk();
    const fx = S.onCoins({ sent, coins: [{ key: tx('a') + ':1', value: 6845, height: 152110 }] });
    const [A, B] = sent;
    t(
      'the forgotten payment is mined after all: it is confirmed and no longer marked forgotten',
      !A.pending && A.height === 152110 && !A.abandoned,
    );
    t(
      'the payment that spent its coins did not happen, and the notice says its recipient was not paid',
      !B.pending &&
        B.failed === tx('a') &&
        !B.replaced &&
        fx.some((e) => e.bad && /was not made/.test(e.body) && /Pay again/.test(e.body)) &&
        /pay(ing)? again/.test(S.stateOf(B, { inMempool: () => false, height: 152110, now: 0, sent })),
    );
  }
  {
    const sent = mk();
    S.onCoins({ sent, coins: [{ key: tx('b') + ':1', value: 1000, height: 152111 }] });
    const [A, B] = sent;
    t(
      'the next payment is mined: it is confirmed, the forgotten one did not happen',
      !B.pending && B.height === 152111 && !A.pending && A.failed === tx('b'),
    );
  }
  {
    const sent = mk();
    t(
      "the two are not versions of each other; each is the other's conflict",
      S.groupOf(sent, sent[0]).length === 1 &&
        S.conflictsOf(sent, sent[0])[0] === sent[1] &&
        /went into your payment/.test(S.stateOf(sent[0], { inMempool: () => false, height: 1, now: 0, sent })),
    );
  }
}
{
  const sent = [
    pay({ replacedBy: tx('2') }),
    pay({ txid: tx('2'), replaces: tx('1'), replacedBy: tx('3') }),
    pay({ txid: tx('3'), replaces: tx('2') }),
  ];
  t(
    'the newest version of a twice-raised payment is found from the original',
    S.newestOf(sent, sent[0]).txid === tx('3') && S.groupOf(sent, sent[2]).length === 3,
  );
}
// ---- round four (funds): reorganisations, replays, tombstones, records, clocks
{
  const sent = [pay()];
  S.confirm(sent, sent[0], 152110);
  t(
    'a confirmation two blocks deep is checked again at the next block, once',
    S.recheckDue(sent, 152111).length === 1 &&
      ((sent[0].checkedAt = 152111), S.recheckDue(sent, 152111).length === 0) &&
      S.recheckDue(sent, 152116).length === 0,
  );
  const fx = S.onRecheck(sent, tx('1'), { found: false, to: 152112 }, 152112);
  t(
    'a reorganisation that leaves the coins unspent puts the payment back to waiting, and says so',
    sent[0].pending && sent[0].height === undefined && fx[0].bad,
  );
}
{
  const P = pay({ replacedBy: tx('2') }),
    C = pay({ txid: tx('2'), kind: 'cancel', self: true, sats: 0, fee: 400, change: 9600, replaces: tx('1') });
  const sent = [P, C];
  S.confirm(sent, C, 152110);
  const fx = S.onRecheck(sent, tx('2'), { found: true, txid: tx('1'), height: 152111 }, 152111);
  t(
    'a cancel confirmed, then a reorganisation mines the original: the payment is confirmed, the cancel undone, and the person told',
    !P.pending &&
      P.height === 152111 &&
      C.replaced === tx('1') &&
      fx.some((e) => e.notice === 'A block was undone') &&
      fx.some((e) => e.notice === 'Payment confirmed'),
  );
}
{
  const O = pay({ replacedBy: tx('2') }),
    r1 = pay({ txid: tx('2'), replaces: tx('1'), replacedBy: tx('3') }),
    r2 = pay({ txid: tx('3'), replaces: tx('2') });
  const sent = [O, r1, r2];
  t(
    'an old version replayed and refused after a newer one leaves the chain of versions as it is',
    S.onRefused(sent, tx('2'), 'a replacement must pay more', '00').length === 0 && O.replacedBy === tx('2') && r1.replacedBy === tx('3'),
  );
}
t('a refusal in another hex case is recognised', S.onRefused([pay({ hex: 'ab' })], tx('1'), 'x', 'AB').length === 1);
{
  const m = S.mergeSent([pay()], [{ txid: tx('1'), pending: false, tomb: true, at: 1 }]);
  t("a tombstone's verdict never wins over a waiting record", m[0].pending === true && !m[0].tomb);
}
{
  const check = (hex) => ({
    txid: tx('1'),
    inputs: [inA],
    outputs: [
      { value: 3000, scriptPubKey: '5120' + 'ff'.repeat(32) },
      { value: 6845, scriptPubKey: '5120' + 'ee'.repeat(32) },
    ],
  });
  const scriptOf = () => '5120' + 'dd'.repeat(32);
  t('a record whose destination is not an output of its own transaction is dropped', !S.validRecord(pay(), { check, scriptOf }));
  const check2 = () => ({
    txid: tx('1'),
    inputs: [inA],
    outputs: [
      { value: 3000, scriptPubKey: '5120' + 'dd'.repeat(32) },
      { value: 6000, scriptPubKey: '5120' + 'ee'.repeat(32) },
    ],
  });
  t('a record whose fee does not match its transaction is dropped', !S.validRecord(pay(), { check: check2, scriptOf }));
}
{
  const sent = [pay({ vAt: Date.now() + 60e3 })];
  t("a verdict's time never goes back, even if the clock does", S.stamp(sent) > sent[0].vAt);
}
// ---- round five: the words at the end of a forget, and a reorganisation that undoes it
{
  const mk = () => [
    pay({ txid: tx('a'), to: 'tb1pold', sats: 7000, abandoned: true, inputs: [inA] }),
    pay({ txid: tx('b'), to: 'tb1pnew', sats: 5000, inputs: [inA, inB], at: 3000 }),
  ];
  {
    const sent = mk();
    const fx = S.onCoins({ sent, coins: [{ key: tx('b') + ':1', value: 1000, height: 152111 }] });
    const n = fx.find((e) => e.notice === 'Forgotten payment settled');
    t(
      'the payment made on purpose goes through: the notice calls the old one forgotten and is not an alarm',
      n &&
        !n.bad &&
        /forgotten payment of 7000 sat to tb1pold/.test(n.body) &&
        /went into your payment to tb1pnew/.test(n.body) &&
        /forgotten, never happened/.test(S.stateOf(sent[0], { inMempool: () => false, height: 152111, now: 0, sent })),
    );
    const fx2 = S.onRecheck(sent, tx('b'), { found: false, to: 152112 }, 152112);
    t(
      'then its block is undone: both are waiting again and the old one is forgotten again (its coins go first again)',
      sent[1].pending && sent[0].pending && sent[0].abandoned && !sent[0].failed && fx2[0].bad,
    );
  }
  {
    const sent = mk();
    const fx = S.onCoins({ sent, coins: [{ key: tx('a') + ':1', value: 6845, height: 152111 }] });
    const n = fx.find((e) => e.notice === 'Payment did not happen');
    t(
      'the forgotten one is mined after all: the new payment did not happen, said as a failure naming its recipient',
      n && n.bad && /payment of 5000 sat to tb1pnew/.test(n.body) && /payment you had forgotten/.test(n.body),
    );
  }
}
t(
  'an idle tab says the waiting is followed elsewhere',
  /followed in the tab that runs the node/.test(S.stateOf(pay(), { inMempool: () => false, height: 1, now: 0, idle: true })),
);
// ---- round five (funds): references survive a save; final verdicts revisited; deep reorganisations
{
  const sent = [pay()];
  const held = sent[0];
  const merged = S.mergeSent(sent, [pay({ lastPub: 9e12 })]);
  held.replacedBy = tx('2');
  t(
    'a record held across a dialog is the same object after a save: what the flow writes is not lost',
    merged[0] === held && merged[0].replacedBy === tx('2'),
  );
}
{
  const sent = [pay({ pending: false, replaced: tx('9'), vAt: 1 })];
  const fx = S.onCoins({ sent, coins: [{ key: tx('1') + ':1', value: 6845, height: 152120 }], height: 152120 });
  t(
    'a payment marked as not having happened whose change appears is confirmed after all, said without an alarm when nothing was paid again',
    !sent[0].pending &&
      sent[0].height === 152120 &&
      !sent[0].replaced &&
      fx.some((e) => e.notice === 'A payment was mined after all' && !/paid twice/.test(e.body)),
  );
  const sent2 = [pay({ pending: false, replaced: tx('9'), vAt: 1 }), pay({ txid: tx('5'), inputs: [inB], at: 5000 })];
  const fx2 = S.onCoins({ sent: sent2, coins: [{ key: tx('1') + ':1', value: 6845, height: 152120 }], height: 152120 });
  t(
    '...and with the warning when the same address was paid again since with other coins',
    fx2.some((e) => /paid twice/.test(e.body) && e.bad),
  );
}
{
  const sent = [pay({ pending: false, height: 152000, vAt: 1 })];
  const fx = S.onCoins({ sent, coins: [{ key: inA, value: 10000, height: 151990 }], height: 152120 });
  t(
    'a confirmation undone by a reorganisation deeper than six blocks is noticed when its coins come back',
    sent[0].pending && sent[0].tip === 152120 && fx.some((e) => e.notice === 'A block was undone'),
  );
}
{
  const a = [pay({ pending: false, height: 5, vAt: 10 })];
  const stored = [pay({ abandoned: true, vAt: 5 })];
  const m = S.mergeSent(a, stored);
  t('a later confirmation clears a forgotten mark that an older stored copy still has', !m[0].abandoned && m[0].pending === false);
}
{
  const own = '5120' + 'ee'.repeat(32);
  const check = () => ({
    txid: tx('1'),
    inputs: [inA],
    outputs: [
      { value: 3000, scriptPubKey: '5120' + 'dd'.repeat(32) },
      { value: 6845, scriptPubKey: own },
    ],
  });
  const scriptOf = () => '5120' + 'dd'.repeat(32);
  t(
    'a record must match its own transaction in change and kind too',
    S.validRecord(pay(), { check, scriptOf, ownScript: own }) &&
      !S.validRecord(pay({ change: 9999 }), { check, scriptOf, ownScript: own }) &&
      !S.validRecord(pay({ kind: 'cancel' }), { check, scriptOf, ownScript: own }),
  );
  const selfCheck = () => ({
    txid: tx('1'),
    inputs: [inA],
    outputs: [
      { value: 3000, scriptPubKey: own },
      { value: 6845, scriptPubKey: own },
    ],
  });
  const old = pay({ toScript: own, to: 'tb1pme', self: false });
  t(
    'an older record of a payment to oneself, not marked so, is corrected rather than rejected',
    S.validRecord(old, { check: selfCheck, scriptOf: () => own, ownScript: own }) && old.self === true,
  );
}
// ---- round six: storage
{
  const rec = pay({ publishing: true, asked: true });
  const out = S.forStorage([rec]);
  t(
    'passing state (publishing, asked) is never written to storage',
    !('publishing' in out[0]) && !('asked' in out[0]) && rec.publishing === true,
  );
}
{
  const good = pay(),
    bad = pay({ txid: tx('7'), hex: undefined, inputs: ['ff'.repeat(32) + ':0'] }),
    wasBad = pay({ txid: tx('8'), quarantinedAt: 1 });
  const r = S.sortStored({ sent: [good, bad], quarantine: [wasBad, bad], ok: () => true, seenHas: (k) => k === inA });
  t(
    'a record claiming coins this wallet never saw is set aside once; one set aside earlier that now passes comes back',
    r.keep
      .map((x) => x.txid)
      .sort()
      .join() === [tx('1'), tx('8')].sort().join() &&
      r.quarantine.length === 1 &&
      r.quarantine[0].txid === tx('7') &&
      !('quarantinedAt' in r.keep.find((x) => x.txid === tx('8'))),
  );
  const again = S.sortStored({ sent: r.keep, quarantine: r.quarantine, ok: () => true, seenHas: (k) => k === inA });
  t(
    'sorting again changes nothing (no churn)',
    again.keep.length === 2 && again.quarantine.length === 1 && again.quarantine[0].quarantinedAt === r.quarantine[0].quarantinedAt,
  );
}
// ---- round six (ux): what 'mined after all' means, and a forgotten winner undone
{
  const P = pay({ pending: false, replaced: tx('2'), vAt: 1, replacedBy: tx('2') }),
    C = pay({
      txid: tx('2'),
      kind: 'cancel',
      self: true,
      sats: 0,
      change: 9600,
      replaces: tx('1'),
      pending: false,
      height: 152110,
      vAt: 1,
    });
  const sent = [P, C];
  S.confirm(sent, P, 152110);
  const fx = S.onCoins({ sent, coins: [{ key: tx('2') + ':0', value: 9600, height: 152111 }], height: 152112 });
  t(
    'a cancel marked too late whose output appears: the payment was cancelled after all, not paid twice',
    fx.some((e) => e.notice === 'Payment cancelled after all') && !fx.some((e) => /paid twice/.test(e.body ?? '')),
  );
}
{
  const P = pay({ pending: false, replaced: tx('2'), vAt: 1, replacedBy: tx('2') }),
    R = pay({ txid: tx('2'), replaces: tx('1'), pending: false, height: 152110, vAt: 1 });
  const sent = [P, R];
  const fx = S.onCoins({ sent, coins: [{ key: tx('1') + ':1', value: 6845, height: 152111 }], height: 152112 });
  t(
    'an earlier version of a raised payment mined: made once, no alarm',
    fx.some((e) => e.notice === 'An earlier version was mined' && !e.bad),
  );
}
{
  const A = pay({ txid: tx('a'), abandoned: true, inputs: [inA] }),
    B = pay({ txid: tx('b'), to: 'tb1py', inputs: [inA, inB], at: 3000 });
  const sent = [A, B];
  S.onCoins({ sent, coins: [{ key: tx('a') + ':1', value: 6845, height: 152110 }] });
  S.onRecheck(sent, tx('a'), { found: false, to: 152111 }, 152111);
  t(
    'a forgotten payment that won and was then undone is forgotten again (not published again)',
    A.pending && A.abandoned && S.republishDue(sent, 1e13).every((x) => x.txid !== tx('a')),
  );
}
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

// ---- round 7: refusals that only say the coins are spent, a fast clock, boundaries the mutations slipped past
{
  const sent = [pay()];
  t(
    'a refusal saying the coins are already spent (a block mined it) raises no alarm and marks nothing',
    S.onRefused(sent, tx('1'), `input ${inA} is not an unspent coin`, '00').length === 0 && !sent[0].refusedNote,
  );
  t('...nor does a full mempool', S.onRefused(sent, tx('1'), 'mempool full', '00').length === 0 && !sent[0].refusedNote);
  const first = S.onRefused(sent, tx('1'), 'fee 1 below 2 sat/vB', '00');
  t(
    'a real refusal is said once, not on every echo',
    first.length === 1 && S.onRefused(sent, tx('1'), 'fee 1 below 2 sat/vB', '00').length === 0,
  );
}
{
  const now = 10_000_000;
  t(
    'a payment published "in the future" by a fast clock is due again now, not after the clock catches up',
    S.republishDue([pay({ lastPub: now + 24 * 3600e3 })], now).length === 1,
  );
  t(
    'republishing is due at exactly ten minutes',
    S.republishDue([pay({ lastPub: now - S.REPUBLISH_MS })], now).length === 1 &&
      S.republishDue([pay({ lastPub: now - S.REPUBLISH_MS + 1 })], now).length === 0,
  );
  const m = S.mergeSent([pay({ lastPub: 1000 })], [pay({ lastPub: 5000 })]);
  t('two tabs merging keep the later publish time', m[0].lastPub === 5000);
}
{
  const check = () => ({
    txid: tx('1'),
    inputs: [inA],
    outputs: [
      { value: 3000, scriptPubKey: '5120' + 'dd'.repeat(32) },
      { value: 6845, scriptPubKey: '5120' + 'ee'.repeat(32) },
    ],
  });
  t(
    'a record whose address does not encode its script is dropped',
    !S.validRecord(pay(), { check, scriptOf: () => '5120' + 'ff'.repeat(32) }) &&
      S.validRecord(pay(), { check, scriptOf: () => '5120' + 'dd'.repeat(32) }),
  );
}
{
  const at = (h) => [pay({ pending: false, height: 152100, tip: 152100 })].map((x) => S.recheckDue([x], h).length)[0];
  t(
    `confirmations are checked again below ${S.RECHECK_DEPTH}, not at it`,
    at(152100 + S.RECHECK_DEPTH - 2) === 1 && at(152100 + S.RECHECK_DEPTH - 1) === 0,
  );
}
{
  // a forgotten payment lost to its replacement-by-another; the block that mined the other is undone: the forgotten one is back as forgotten
  const winner = pay({ txid: tx('2'), pending: false, height: 152110, inputs: [inA], to: 'tb1pother' });
  const loser = pay({ pending: false, failed: tx('2'), wasAbandoned: true });
  const sent = [loser, winner];
  S.onRecheck(sent, tx('2'), { found: false, to: 152111 }, 152111);
  t(
    'an undone block brings a forgotten payment back as waiting and forgotten (its coins first, not republished)',
    loser.pending && loser.abandoned && !loser.failed && winner.pending,
  );
}
{
  const sent = [pay({ inputs: [inA, inB], values: [5000, 5000] })];
  const asked = new Set();
  t(
    'the node is asked about a payment as soon as one of its coins is gone, and only once',
    S.onCoins({ sent, coins: [{ key: inB, value: 5000, height: 1 }], asked }).length === 1 &&
      S.onCoins({ sent, coins: [], asked }).length === 0,
  );
}
{
  const s0 = pay({ pending: false, height: 152110 });
  const fx = S.onCoins({ sent: [s0], coins: [{ key: inA, value: 10000, height: 152000 }], height: 152110 });
  t(
    'a confirmed payment whose coins are back at its own height is undone',
    s0.pending && fx.some((e) => e.notice === 'A block was undone'),
  );
}
{
  const o = pay({ replacedBy: tx('2') });
  const r = pay({ txid: tx('2'), replaces: tx('1'), fee: 400 });
  const settled = pay({ txid: tx('3'), pending: false, height: 152000, inputs: [inB] });
  const sent = [o, r, settled];
  S.forget(sent, r);
  t('forgetting marks every waiting version, and nothing settled', o.abandoned && r.abandoned && !settled.abandoned && o.vAt && r.vAt);
  const h = pay({ pending: false, replaced: tx('9'), vAt: 5 });
  const mine = [h];
  S.hide(mine, h);
  const m = S.mergeSent(mine, [pay({ pending: false, replaced: tx('9'), vAt: 5 })]);
  t('a hidden row stays hidden when merged with an older copy from another tab', m[0].hidden === true);
}
{
  // payments found rather than made here
  const seen = new Map([
    [inA, 10000],
    [inB, 5000],
  ]);
  const T = tx('7');
  const coins = [
    { key: T + ':1', value: 3000, height: 152100, inputs: [inA, inB] },
    { key: T + ':2', value: 1000, height: 152100, inputs: [inA, inB] },
  ];
  const r = S.recoverFromCoins({ coins, sent: [], seen });
  t(
    'a transaction found spending our coins is one record, whatever comes back counted once',
    r.length === 1 && r[0].record.sats === 15000 - 4000 && r[0].record.change === 4000 && !r[0].record.partial,
    JSON.stringify(r[0]?.record),
  );
  const p = S.recoverFromCoins({ coins: [{ key: T + ':0', value: 100, height: 1, inputs: [inA, tx('z') + ':0'] }], sent: [], seen });
  t('with an input this wallet never saw, the amount is "at least"', p[0].record.partial && /^at least/.test(p[0].notice.body));
  const h = S.recoverFromCoins({ coins, sent: [], seen, hitch: new Set([inB]) });
  t('a coin Hitch held makes it a channel funding', /Hitch/.test(h[0].record.to) && h[0].notice.notice === 'Channel funding confirmed');
  t(
    'nothing is recovered for a payment already recorded, a mined coin, or coins never seen',
    S.recoverFromCoins({ coins, sent: [{ txid: T }], seen }).length === 0 &&
      S.recoverFromCoins({ coins: [{ ...coins[0], coinbase: true }], sent: [], seen }).length === 0 &&
      S.recoverFromCoins({ coins, sent: [], seen: new Map() }).length === 0,
  );
  const m = S.recoverFromMempool({
    txs: [
      { txid: T, inputs: [inA] },
      { txid: T, inputs: [inA] },
    ],
    sent: [],
    seen,
    toUs: () => 2000,
    height: 5,
  });
  t(
    'one in the mempool is waiting, change counted, not doubled',
    m.length === 1 && m[0].pending && m[0].sats === 8000 && m[0].change === 2000 && m[0].tip === 5,
  );
}
{
  // round 8
  const sent = [pay(), pay({ txid: tx('c'), kind: 'cancel', replaces: tx('1'), sats: 0, change: 9600, fee: 400 })];
  sent[0].replacedBy = tx('c');
  t(
    'a payment being cancelled says so while it waits',
    S.stateOf(sent[0], { inMempool: () => true, height: 152101, now: 2000, sent }) === 'being cancelled: waiting for a block',
  );
  const won = [pay({ pending: false, replaced: tx('c') }), pay({ txid: tx('c'), kind: 'cancel', pending: false, height: 152102 })];
  t(
    'a payment whose cancel won reads as cancelled, not as "another version was mined"',
    S.stateOf(won[0], { inMempool: () => false, height: 152110, now: 2000, sent: won }) === 'cancelled: the coins came back to you',
  );
  const rec = { txid: tx('r'), recovered: true, partial: true, pending: true, inputs: [inA, tx('z') + ':0'], sats: 1, fee: 0 };
  const sorted = S.sortStored({ sent: [rec], ok: () => true, seenHas: (k) => k === inA });
  t('a found payment with one input from elsewhere is kept, not set aside', sorted.keep.length === 1 && !sorted.quarantine.length);
  const none = S.sortStored({ sent: [{ ...rec, inputs: [tx('z') + ':0'] }], ok: () => true, seenHas: (k) => k === inA });
  t('...but one claiming no coin of ours at all is set aside', none.quarantine.length === 1);
  const q = S.sortStored({
    sent: [pay({ pending: false, height: 5 })],
    quarantine: [{ ...pay({ hex: 'bad' }), quarantinedAt: 1 }],
    ok: (x) => x.hex === '00',
    seenHas: () => true,
  });
  t('a set-aside record whose payment has settled is no longer held', q.quarantine.length === 0 && q.keep.length === 1);
  t(
    'confirmations under six read as progress',
    S.confirmWords(5) === 'confirming (5 of 6)' && S.confirmWords(6) === '6 confirmations' && S.confirmWords(1).includes('1 of 6'),
  );
}
{
  // round 8: boundaries the mutations slipped past
  const check = () => ({
    txid: tx('1'),
    inputs: [inA],
    outputs: [
      { value: 3000, scriptPubKey: '5120' + 'dd'.repeat(32) },
      { value: 6845, scriptPubKey: '5120' + 'ee'.repeat(32) },
    ],
  });
  const scriptOf = () => '5120' + 'dd'.repeat(32);
  t(
    "a record whose coins differ from its transaction's is dropped (it would hold other coins)",
    !S.validRecord(pay({ inputs: [inB] }), { check, scriptOf }) && S.validRecord(pay(), { check, scriptOf }),
  );
  t(
    'a txid one character short is dropped',
    !S.validRecord(pay({ txid: tx('1').slice(1) }), { check: () => ({ ...check(), txid: tx('1').slice(1) }), scriptOf }),
  );
  const st = (o, h) => S.stateOf(pay(o), { inMempool: () => true, height: h, now: 2000, sent: [] });
  t(
    'the hint to raise the fee comes at exactly three blocks waiting, not two',
    /raise the fee/.test(st({ tip: 152100 }, 152103)) && !/raise the fee/.test(st({ tip: 152100 }, 152102)),
  );
  const c1 = pay({ hidden: true, refusedNote: 'x' });
  S.confirm([c1], c1, 152101);
  t('a confirmed payment is shown again and its refusal note goes', !c1.hidden && !c1.refusedNote && c1.height === 152101);
  const asked = new Set();
  const fx = S.onCoins({ sent: [pay({ tip: 152100 })], coins: [], asked });
  t('the spend search starts one block before the payment was made', fx[0].from === 152099);
  const fx0 = S.onCoins({ sent: [pay({ tip: 100 })], coins: [], asked: new Set() });
  t('...and never before the BLAKE2b chain begins', fx0[0].from === S.FIRST_BLAKE_HEIGHT);
  t(
    'a payment with no coins recorded is not asked about',
    S.onCoins({ sent: [pay({ inputs: [] })], coins: [], asked: new Set() }).length === 0,
  );
  const q = S.sortStored({ sent: [pay()], quarantine: [{ ...pay(), quarantinedAt: 1 }], ok: () => true, seenHas: () => true });
  t('a set-aside record that now passes is restored once, not twice', q.keep.length === 1 && q.quarantine.length === 0);
  const q2 = S.sortStored({
    sent: [],
    quarantine: [{ ...pay({ hex: 'bad' }), quarantinedAt: 7 }],
    ok: (x) => x.hex === '00',
    seenHas: () => true,
  });
  t('a record still failing keeps the time it was first set aside', q2.quarantine[0].quarantinedAt === 7);
  const h = pay({ pending: false, replaced: tx('9') });
  S.hide([h], h);
  t('hiding stamps the record (so the hide wins a merge)', h.hidden && h.vAt > 0);
  t(
    'a payment already forgotten is not offered "forget" again',
    !S.forgettable([pay({ abandoned: true, tip: 1 })], pay({ abandoned: true, tip: 1 }), 152100, () => false),
  );
  const seen = new Map([[inA, 1000]]);
  const neg = S.recoverFromCoins({ coins: [{ key: tx('5') + ':0', value: 5000, height: 1, inputs: [inA] }], sent: [], seen });
  t('a found payment that brought back more than went in counts 0, not a negative', neg[0].record.sats === 0);
  const mp = S.recoverFromMempool({
    txs: [
      { txid: tx('6'), inputs: [tx('z') + ':0'] },
      { txid: tx('7'), inputs: [inA, tx('z') + ':1'] },
    ],
    sent: [],
    seen,
    hitch: new Set([inA]),
    toUs: () => 0,
    height: 1,
  });
  t(
    'a mempool transaction spending none of our coins is not ours; one with some is partial, and a Hitch coin makes it a funding',
    mp.length === 1 && mp[0].txid === tx('7') && mp[0].partial && /Hitch/.test(mp[0].to),
  );
}
{
  t(
    'one rule says what may be announced: waiting, signed here, not replaced, refused or forgotten',
    S.publishable(pay()) &&
      !S.publishable(pay({ refusedNote: 'x' })) &&
      !S.publishable(pay({ refused: 'x' })) &&
      !S.publishable(pay({ abandoned: true })) &&
      !S.publishable(pay({ replacedBy: tx('2') })) &&
      !S.publishable(pay({ pending: false })) &&
      !S.publishable(pay({ hex: null })),
  );
}
{
  // a cancel that won, then a block undone and the payment mined instead, after paying the same address again
  const dest = '5120' + 'dd'.repeat(32);
  const P = pay({ txid: tx('a'), pending: false, replaced: tx('c'), replacedBy: tx('c'), at: 1, toScript: dest });
  const C = pay({
    txid: tx('c'),
    kind: 'cancel',
    replaces: tx('a'),
    pending: false,
    height: 152101,
    sats: 0,
    change: 9600,
    at: 2,
    toScript: '5120' + 'ee'.repeat(32),
    self: true,
  });
  const P2 = pay({ txid: tx('b'), pending: true, at: 3, inputs: [inB], toScript: dest });
  const fx = S.onCoins({ sent: [P, C, P2], coins: [{ key: tx('a') + ':1', value: 6845, height: 152101 }], height: 152102 });
  const n = fx.find((e) => e.notice);
  t(
    'a cancel undone by a reorganisation is said, and paying the same address since is flagged as maybe twice',
    n?.notice === 'The cancel was undone' && n.bad && /paid twice/.test(n.body),
    JSON.stringify(n),
  );
  const st = S.stateOf(pay({ pending: false, replaced: tx('c') }), {
    inMempool: () => false,
    height: 152102,
    now: 1,
    sent: [pay({ txid: tx('c'), kind: 'cancel', replaces: tx('a'), pending: false, height: 152101, self: true })],
  });
  t(
    'a cancel still settling says to wait six confirmations before paying again',
    /confirming 2 of 6: wait for 6 before paying again/.test(st),
    st,
  );
}
{
  const d = '5120' + 'dd'.repeat(32);
  const w = S.waitingTo(
    [
      pay({ txid: tx('1'), at: 1 }),
      pay({ txid: tx('2'), at: 5 }),
      pay({ txid: tx('3'), refused: 'x', replaces: tx('1'), at: 9 }),
      pay({ txid: tx('4'), pending: false }),
      pay({ txid: tx('5'), toScript: null, to: 'old', at: 3 }),
    ],
    d,
    (a) => (a === 'old' ? d : null),
  );
  t(
    'payments waiting to an address: newest first, refused replacements and settled ones left out, old records decoded',
    w.map((x) => x.txid[0]).join('') === '251',
  );
  // stamps: a later change always wins a merge
  const a = [pay({ vAt: 5, pending: true })];
  const b = [pay({ vAt: 9, pending: false, height: 152101 })];
  t(
    "of two tabs' copies, the later stamped verdict wins",
    S.mergeSent(a, b)[0].pending === false && S.mergeSent(b, [pay({ vAt: 5, pending: true })])[0].pending === false,
  );
  t(
    'a stamp is always later than any already given and than now',
    (() => {
      const s0 = [pay({ vAt: Date.now() + 1e6 })];
      return S.stamp(s0) > s0[0].vAt;
    })(),
  );
  // the shapes: a cancel's figures and the order of coins
  const p2 = {
    amount: 3000,
    fee: 200,
    change: 1000,
    picked: [
      { key: inB, value: 2500 },
      { key: inA, value: 1700 },
    ],
  };
  const pr = S.paymentRecord(p2, { txid: tx('9'), hex: '00', to: 'x', toScript: d, tip: 7, now: 1 });
  t(
    'a payment record keeps the coins in the order signed',
    pr.inputs.join() === [inB, inA].join() && pr.values.join() === '2500,1700' && pr.tip === 7,
  );
  const cx = S.replacementRecord(
    { ...pr, all: true },
    { amount: 4000, fee: 200, change: 0 },
    { cancel: true, txid: tx('8'), hex: '00', address: 'me', script: 'ms', tip: 8, now: 2 },
  );
  t(
    "a cancel record: nothing to the recipient, the coins back as change, the payment's all flag and the new tip",
    cx.sats === 0 && cx.change === 4000 && cx.all === true && cx.tip === 8 && cx.to === 'me' && cx.toScript === 'ms',
  );
}
{
  const d = '5120' + 'dd'.repeat(32);
  const raise = [
    pay({ txid: tx('a'), pending: false, replaced: tx('b'), toScript: d }),
    pay({ txid: tx('b'), replaces: tx('a'), pending: false, height: 152100, toScript: d }),
  ];
  t('a fee raise that was mined is not "cancelled or did not happen"', S.settlingTo(raise, d, 152101).length === 0);
  const cancelled = [
    pay({ txid: tx('a'), pending: false, replaced: tx('c'), toScript: d }),
    pay({ txid: tx('c'), kind: 'cancel', replaces: tx('a'), pending: false, height: 152100, self: true }),
  ];
  t(
    'a cancel that won within six blocks makes the address settling; at six it no longer does',
    S.settlingTo(cancelled, d, 152104).length === 1 && S.settlingTo(cancelled, d, 152105).length === 0,
  );
  const failed = [
    pay({ txid: tx('f'), pending: false, failed: tx('g'), toScript: null, to: 'old' }),
    pay({ txid: tx('g'), pending: false, height: 152100, to: 'x' }),
  ];
  t(
    'a payment that did not happen counts, its address decoded when the record has no script',
    S.settlingTo(failed, d, 152101, (a) => (a === 'old' ? d : null)).length === 1,
  );
  t('with no height known, nothing is settling', S.settlingTo(cancelled, d, null).length === 0);
}
{
  const r = pay({ pending: false, height: 152100 });
  const sent = [r];
  const fx = S.onRecheck(sent, r.txid, { found: false, to: 152104 }, 152105);
  t(
    'a recheck whose search stopped short of this height undoes nothing and is asked again',
    fx.length === 0 && !r.pending && r.checkedAt == null,
  );
  const moved = pay({ pending: false, height: 152100 });
  S.onRecheck([moved], moved.txid, { found: true, txid: moved.txid, height: 152102 }, 152103);
  t('a recheck that finds the payment in another block moves it there', moved.height === 152102 && !moved.pending);
}
{
  // round 10: reorganisation paths and the "paid twice" conditions
  const d = '5120' + 'dd'.repeat(32);
  // a payment shown as not having happened, whose change then appears: mined after all
  const f = pay({ txid: tx('f'), pending: false, failed: tx('w'), toScript: d, at: 1 });
  const w = pay({
    txid: tx('w'),
    pending: false,
    height: 152100,
    inputs: [inA],
    to: 'tb1pother',
    toScript: '5120' + 'ee'.repeat(32),
    at: 2,
  });
  const fx = S.onCoins({ sent: [f, w], coins: [{ key: tx('f') + ':1', value: 6845, height: 152101 }], height: 152102 });
  t(
    'a payment shown as "did not happen" whose change appears is mined after all',
    !f.failed && f.height === 152101 && fx.some((e) => e.notice === 'A payment was mined after all'),
  );
  // paid twice: only a later payment to the same address, made by this wallet, still standing
  const mk = (o) => pay({ txid: tx('m'), pending: false, failed: tx('w'), toScript: d, at: 5, ...o });
  const later = pay({ txid: tx('n'), pending: false, height: 152101, inputs: [inB], toScript: d, at: 9 });
  const earlier = pay({ txid: tx('o'), pending: false, height: 152099, inputs: [inB], toScript: d, at: 1 });
  const notice = (sent) =>
    S.onCoins({ sent, coins: [{ key: tx('m') + ':1', value: 6845, height: 152101 }], height: 152102 }).find((e) => e.notice);
  t(
    '"paid twice" when the same address was paid again later',
    notice([mk(), w, later])?.bad === true && /paid twice/.test(notice([mk(), w, pay({ ...later })]).body),
  );
  t('...not for an earlier payment to it', notice([mk(), w, earlier])?.bad === false);
  t('...not for a payment to yourself', notice([mk({ self: true }), w, pay({ ...later })])?.bad === false);
  t('...not for a later one that itself did not happen', notice([mk(), w, pay({ ...later, failed: tx('x') })])?.bad === false);
  // confirm stamps the winner, so a stale copy from another tab cannot win the merge back
  const c1 = pay({ vAt: 3 });
  S.confirm([c1], c1, 152101);
  const merged = S.mergeSent([c1], [pay({ vAt: 3 })]);
  t('a confirmation is stamped: an older pending copy from another tab does not undo it', merged[0].pending === false && c1.vAt > 3);
  // a coins reply from before the payment's block undoes nothing
  const r = pay({ pending: false, height: 152105 });
  S.onCoins({ sent: [r], coins: [{ key: inA, value: 10000, height: 152000 }], height: 152104 });
  t('a coins reply older than the block a payment is in does not undo it', !r.pending && r.height === 152105);
}
{
  const s1 = pay();
  const fx = S.onCoins({ sent: [s1], coins: [{ key: tx('1') + ':1', value: 6845, height: 152102 }], height: 152102, vouched: 152101 });
  t('a payment whose change is in a block above the signed tip is not confirmed yet', s1.pending && !fx.length);
  S.onCoins({ sent: [s1], coins: [{ key: tx('1') + ':1', value: 6845, height: 152102 }], height: 152102, vouched: 152102 });
  t('...and is once the tip reaches it', !s1.pending && s1.height === 152102);
  const s2 = pay({ inputs: [inA, inB], values: [5000, 5000] });
  const fx2 = S.onCoins({ sent: [s2], coins: [{ key: inA, value: 5000, height: 1 }], asked: new Set() });
  t('a waiting payment with one of its coins gone is asked about (that coin)', fx2.length === 1 && fx2[0].input === inB);
}
{
  const s1 = pay({ inputs: [inA], change: 0, all: true });
  t(
    'a spend answer in a block above the signed tip gives no verdict yet',
    S.onSpendAnswer([s1], s1.txid, { found: true, txid: s1.txid, height: 152105 }, 152103).length === 0 && s1.pending,
  );
  t(
    '...and confirms once at or below it',
    S.onSpendAnswer([s1], s1.txid, { found: true, txid: s1.txid, height: 152103 }, 152103).length > 0 && !s1.pending,
  );
  const r = pay({ pending: false, height: 152100 }),
    w = pay({ txid: tx('w'), pending: false, height: null, inputs: [inA] });
  const fx = S.onRecheck([r, w], r.txid, { found: true, txid: tx('w'), height: 152106 }, 152106, 152104);
  t('a recheck whose winner is above the signed tip changes nothing yet', fx.length === 0 && !r.pending && r.height === 152100);
}
{
  const w = pay({ txid: tx('w'), pending: false, height: 152100 });
  const f = pay({ pending: false, failed: tx('w') });
  t(
    'did not happen, while the winner is shallow: wait before paying again',
    /wait for 6 confirmations \(now 2\)/.test(S.stateOf(f, { inMempool: () => false, height: 152101, now: 0, sent: [f, w] })),
  );
  t(
    '...and once it is deep: pay again',
    /pay again if you still mean to/.test(S.stateOf(f, { inMempool: () => false, height: 152105, now: 0, sent: [f, w] })),
  );
  t(
    'shallow: under six confirmations, and not with an unknown height',
    S.shallow(152100, 152104) && !S.shallow(152100, 152105) && !S.shallow(null, 152100) && !S.shallow(152100, null),
  );
}
{
  const r = pay({ pending: false, height: 152100 });
  const fx = S.onRecheck([r], r.txid, { found: true, txid: 'ee'.repeat(32), height: 152103 }, 152103, 152101);
  t(
    'a stranger spending our coins in a block above the vouched height changes nothing yet',
    fx.length === 0 && !r.pending && !r.replaced && r.height === 152100 && r.checkedAt == null,
  );
  const moved = pay({ pending: false, height: 152100 });
  S.onRecheck([moved], moved.txid, { found: true, txid: moved.txid, height: 152103 }, 152103, 152101);
  t('...nor does our own payment found again above it', moved.height === 152100);
  const f = pay({ txid: tx('f'), pending: false, failed: tx('w') });
  const w = pay({ txid: tx('w'), pending: false, height: 152100, inputs: [inA], to: 'x' });
  S.onCoins({ sent: [f, w], coins: [{ key: tx('f') + ':1', value: 6845, height: 152105 }], height: 152105, vouched: 152102 });
  t('a "did not happen" payment whose change shows above the vouched height is not turned into made yet', !!f.failed && f.height == null);
}
console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
