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
console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
