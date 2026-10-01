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
      st(pay({ pending: false, height: 1 })) === 'confirmed' &&
      /2 confirmations \(a block can still be undone\)/.test(st(pay({ pending: false, height: 152100 }))) &&
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
    'a refusal of our own original is a note: its coins stay held and it is still published',
    fx2.length === 1 &&
      sent[0].refusedNote &&
      !sent[0].refused &&
      S.republishDue(sent, 1e12).length === 1 &&
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
        /pay again/.test(S.stateOf(B, { inMempool: () => false, height: 152110, now: 0, sent })),
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
  const fx = S.onRecheck(sent, tx('1'), { found: false }, 152112);
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
    const fx2 = S.onRecheck(sent, tx('b'), { found: false }, 152112);
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
  S.onRecheck(sent, tx('a'), { found: false }, 152111);
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
  S.onRecheck(sent, tx('2'), { found: false }, 152111);
  t(
    'an undone block brings a forgotten payment back as waiting and forgotten (its coins first, not republished)',
    loser.pending && loser.abandoned && !loser.failed && winner.pending,
  );
}
{
  const sent = [pay({ inputs: [inA, inB], values: [5000, 5000] })];
  const asked = new Set();
  t(
    'the node is asked about a payment only when all its coins are gone, not one',
    S.onCoins({ sent, coins: [{ key: inB, value: 5000, height: 1 }], asked }).length === 0 &&
      S.onCoins({ sent, coins: [], asked }).length === 1,
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
console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
