// The lists' decisions: which actions each payment offers in each state, the words, the amounts, the filter.
import * as V from '../lib/view.mjs';
let ok = 0,
  bad = 0;
const t = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`);
  cond ? ok++ : bad++;
};
const tx = (c) => c.repeat(64);
const inA = tx('a') + ':0',
  inB = tx('b') + ':1';
const pay = (o = {}) => ({
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
  relays: ['r'],
  pending: true,
  ...o,
});
const row = (s) => ({
  kind: 'out',
  txid: s.txid,
  label: 'Sent to',
  addr: s.to,
  sats: -(s.sats + s.fee),
  pending: !!s.pending,
  height: s.height ?? null,
});
const ctx = (sent, o = {}) => ({ sent, inMempool: () => false, height: 152101, now: 2000, idle: false, canAct: true, ...o });

{
  const s = pay();
  const v = V.viewRow(row(s), ctx([s]));
  t(
    'a waiting payment offers raise, publish again and cancel, not forget yet',
    v.actions.join() === 'bump,again,cancel' && v.icon === '⏳' && !v.struck,
  );
}
t(
  'in an idle tab, or before the wallet can act, no payment offers anything',
  V.viewRow(row(pay()), ctx([pay()], { canAct: false })).actions.length === 0,
);
{
  const s = pay({ tip: 152090 });
  t('a payment waiting six blocks and unseen also offers forget', V.viewRow(row(s), ctx([s])).actions.includes('forget'));
}
{
  const s = pay({ replacedBy: tx('2') });
  const r2 = pay({ txid: tx('2'), replaces: tx('1') });
  t(
    'a version that was replaced offers nothing; its replacement offers the actions',
    V.viewRow(row(s), ctx([s, r2])).actions.length === 0 && V.viewRow(row(r2), ctx([s, r2])).actions.join() === 'bump,again,cancel',
  );
}
{
  const f = pay({ abandoned: true });
  t('a forgotten payment offers only cancel (not raise or publish)', V.viewRow(row(f), ctx([f])).actions.join() === 'cancel');
  const n = pay({ txid: tx('3'), inputs: [inA, inB], to: 'tb1pother' });
  t('...and not even cancel once its coins went into another waiting payment', V.viewRow(row(f), ctx([f, n])).actions.length === 0);
}
{
  const s = pay({ refused: 'x', replaces: tx('0') });
  t('a refused replacement offers nothing', V.viewRow(row(s), ctx([s])).actions.length === 0);
}
{
  const s = pay({ pending: false, replaced: tx('2'), vAt: 1 });
  const v = V.viewRow(row(s), ctx([s]));
  t(
    'a version that did not happen is struck, says why, shows what it would have cost, and can be removed',
    v.struck && v.tag === 'replaced' && v.sats === -3155 && v.actions.join() === 'hide' && v.block === null,
  );
}
{
  const s = pay({ pending: false, height: 152100 });
  const v = V.viewRow(row(s), ctx([s]));
  t(
    'a confirmed payment shows its block and the undo caveat while shallow',
    v.block === 152100 && /2 confirmations \(a block can still be undone\)/.test(v.state) && v.actions.length === 0,
  );
}
{
  const r = { kind: 'in', txid: tx('9'), label: 'Received', addr: 'me', sats: 5000, pending: false, height: 152099, conf: 3 };
  const v = V.viewRow(r, ctx([]));
  t('a receipt reads its confirmations with the caveat', /3 confirmations \(a block/.test(v.state) && v.icon === '⬇');
}
{
  const rows = [
    row(pay()),
    row(pay({ txid: tx('4'), abandoned: true })),
    { kind: 'in', txid: tx('5'), label: 'Mined', addr: 'me', sats: 1, pending: false },
    { kind: 'in', txid: tx('6'), label: 'Received', addr: 'tb1pfriend', sats: 1, pending: false },
  ];
  const sent = [pay(), pay({ txid: tx('4'), abandoned: true })];
  t(
    'the filter: waiting leaves out forgotten ones; mined, received and search work',
    V.filterRows(rows, { type: 'pending', sent }).length === 1 &&
      V.filterRows(rows, { type: 'mined', sent }).length === 1 &&
      V.filterRows(rows, { type: 'in', sent }).length === 1 &&
      V.filterRows(rows, { query: 'FRIEND', sent }).length === 1,
  );
}
{
  const c = { key: tx('7') + ':0', value: 1, height: 1 };
  const m = () => true;
  t(
    'a coin says what holds it, first match wins',
    V.coinNote(c, { height: 5, sent: [], hitch: new Set([c.key]), held: new Set([c.key]), mature: m }) === ' (reserved by Hitch)' &&
      V.coinNote(c, { height: 5, sent: [{ txid: tx('7') }], mature: m }) === ' (change)',
  );
}

// ---- round 7: the details the first checks let through
{
  const mined = { kind: 'in', txid: tx('m'), label: 'Mined', addr: 'me', sats: 5e9, pending: false, height: 152000, conf: 101 };
  t('a mined row has the pick icon', V.viewRow(mined, ctx([])).icon === '⛏');
  const c = pay({ kind: 'cancel', pending: false, replaced: tx('2') });
  t('a cancel that came too late says so', V.viewRow(row(c), ctx([c])).tag === 'too late');
  const me = pay({ self: true, pending: false, replaced: tx('2') });
  t('a replaced payment to yourself shows only its fee struck through', V.viewRow(row(me), ctx([me])).sats === -155);
  const f = pay({ pending: false, failed: tx('2'), height: 152100 });
  const vf = V.viewRow(row(f), ctx([f]));
  t(
    'a payment that did not happen shows no block, is struck, and says "did not happen"',
    vf.block === null && vf.struck && vf.tag === 'did not happen',
  );
  const ab = pay({ abandoned: true });
  t('a forgotten payment is struck with its own icon', V.viewRow(row(ab), ctx([ab])).struck && V.viewRow(row(ab), ctx([ab])).icon === '⊘');
  const w = V.viewRow(row(pay()), ctx([pay()]));
  t("a waiting row's short state is the part before the colon", w.short && !w.short.includes(':') && w.state.startsWith(w.short));
  const rec = pay({ pending: false, recovered: true, height: 152090 });
  t(
    'a recovered record can be hidden once settled, not while waiting',
    V.viewRow(row(rec), ctx([rec])).actions.includes('hide') &&
      !V.viewRow(row(pay({ recovered: true })), ctx([pay({ recovered: true })])).actions.includes('hide'),
  );
  const at6 = { kind: 'in', txid: tx('6'), label: 'Received', addr: 'me', sats: 1, pending: false, height: 1, conf: 6 };
  t(
    'at six confirmations the undo caveat is gone',
    V.viewRow(at6, ctx([])).state === '6 confirmations' && /undone/.test(V.viewRow({ ...at6, conf: 5 }, ctx([])).state),
  );
}
{
  const rows = [
    { kind: 'in', txid: tx('7'), label: 'Received', addr: 'tb1pa', sats: 1, pending: false },
    { kind: 'in', txid: tx('8'), label: 'Received', addr: 'tb1pb', sats: 1, pending: false },
  ];
  const hit = V.filterRows(rows, { query: '8888' });
  t('search finds a transaction by its id, and only that one', hit.length === 1 && hit[0].txid === tx('8'));
}
{
  const c = { key: tx('7') + ':0', value: 1, height: 152050, coinbase: true };
  const k = new Set([c.key]);
  t(
    'an immature mined coin says when it can be spent',
    /spendable after 100/.test(V.coinNote(c, { height: 152100, sent: [], mature: () => false })) &&
      !/spendable/.test(V.coinNote(c, { height: 152200, sent: [], mature: () => true })),
  );
  t(
    'a coin held by a set-aside record says so before a waiting payment, and a waiting payment before "spent first"',
    V.coinNote(c, { height: 1, sent: [], quarantine: k, held: k, first: k, mature: () => true }) === ' (held by a set-aside record)' &&
      V.coinNote(c, { height: 1, sent: [], held: k, first: k, mature: () => true }) === ' (held by a waiting payment)',
  );
}
{
  const ok1 = { kind: 'out', txid: tx('a'), label: 'Sent to', addr: 'tb1pdest', sats: -1, pending: false, height: 5 };
  const gone = { ...ok1, txid: tx('b') };
  const views = new Map([
    [ok1, { struck: false }],
    [gone, { struck: true }],
  ]);
  t('the Overview leaves out versions that did not happen', V.recentRows([gone, ok1], views).length === 1);
  t(
    'the empty Overview never claims "no coins" before the node answers, nor in an idle tab',
    V.recentEmpty({ known: false }) === 'waiting for the node' &&
      /other|runs/.test(V.recentEmpty({ known: true, idle: true })) &&
      V.recentEmpty({ known: true }) === 'no coins yet',
  );
  const a = 'tb1pek62mqazspfx5almtzpw0nv4elkgu4s4ty95dwwlredvc527672qts7wxz';
  t(
    'a long address is shortened keeping both ends; grouping keeps every character',
    V.shortAddr(a) === 'tb1pek62mq…qts7wxz' && V.grouped(a).replace(/ /g, '') === a && V.grouped('abcdefgh') === 'abcd efgh',
  );
  t(
    'a payment to yourself needs no address in the Overview',
    V.recentLabel({ kind: 'out', label: 'Payment to yourself', addr: a }) === 'Payment to yourself' &&
      V.recentLabel({ kind: 'out', label: 'Sent to', addr: a }) === 'Sent to tb1pek62mq…qts7wxz',
  );
}
console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
