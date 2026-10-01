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
  const v = V.viewRow(row(s), ctx([s, pay({ txid: tx('2'), replaces: tx('1'), pending: false, height: 152101 })]));
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
    v.block === 152100 && /confirming \(2 of 6\)/.test(v.state) && v.actions.length === 0,
  );
}
{
  const r = { kind: 'in', txid: tx('9'), label: 'Received', addr: 'me', sats: 5000, pending: false, height: 152099, conf: 3 };
  const v = V.viewRow(r, ctx([]));
  t('a receipt reads its confirmations with the caveat', /confirming \(3 of 6\)/.test(v.state) && v.icon === '⬇');
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
    'search reaches what the page shows for a row (its amount, its status), through shown(r)',
    V.filterRows(rows, { query: '0.000697', sent, shown: (r) => (r === rows[0] ? 'confirming (2 of 6) 0.00069700 69700' : '') }).length ===
      1 &&
      V.filterRows(rows, { query: 'confirming', sent, shown: (r) => (r === rows[0] ? 'confirming (2 of 6)' : '') }).length === 1 &&
      V.filterRows(rows, { query: '0.000697', sent }).length === 0,
  );
  t(
    'the filter: waiting leaves out forgotten ones; mined, received and search work',
    V.filterRows(rows, { type: 'pending', sent }).length === 1 &&
      V.filterRows(rows, { type: 'mined', sent }).length === 1 &&
      V.filterRows(rows, { type: 'in', sent }).length === 1 &&
      V.filterRows(rows, { query: 'FRIEND', sent }).length === 1,
  ); // which rows, not only how many: a filter that swapped the received row for the mined one would keep the count
  const ids = (type) => V.filterRows(rows, { type, sent }).map((r) => r.txid);
  t(
    'the filter picks the right rows: Waiting is the live payment (not the forgotten one), Received the receipt (not the mined coins)',
    ids('pending').join() === tx('1') && ids('in').join() === tx('6') && ids('mined').join() === tx('5'),
    JSON.stringify({ pending: ids('pending'), in: ids('in'), mined: ids('mined') }),
  );
}
{
  // "(fee)" goes on a payment to yourself that happened, and on nothing else
  const self = { label: 'Payment to yourself' },
    other = { label: 'Sent' };
  t(
    'only a payment to yourself that happened is marked "(fee)"',
    V.feeOnly(self, { struck: false }) === true &&
      V.feeOnly(self, { struck: true }) === false &&
      V.feeOnly(other, { struck: false }) === false &&
      V.feeOnly(other, { struck: true }) === false,
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
    V.viewRow(at6, ctx([])).state === '6 confirmations' && V.viewRow({ ...at6, conf: 5 }, ctx([])).state === 'confirming (5 of 6)',
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
    V.coinNote(c, { height: 1, sent: [], quarantine: k, held: k, first: k, mature: () => true }) ===
      ' (held: a payment record Reef could not verify)' &&
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
{
  const s = pay({ pending: false, replaced: tx('2') });
  const line = V.exportRow(
    { ...row(s), sats: 0, label: '=HYPERLINK("x")' },
    ctx([s, pay({ txid: tx('2'), replaces: tx('1'), pending: false, height: 152101 })]),
  );
  t(
    'the export says what the lists say, counts a replaced version as 0, and quotes a formula',
    /replaced: another version/.test(line) && /\(replaced\)/.test(line) && line.includes(',"0",') && line.includes(`"'=HYPERLINK(""x"")"`),
    line,
  );
  const conf = { kind: 'in', txid: tx('c'), label: 'Received', addr: 'me', sats: 5, pending: false, height: 10, conf: 2 };
  t('a receipt is exported with its confirmations, not just "confirmed"', /confirming \(2 of 6\)/.test(V.exportRow(conf, ctx([]))));
}
{
  // round 8
  const c = pay({ txid: tx('c'), kind: 'cancel', replaces: tx('1'), sats: 0, change: 9600 });
  t('a waiting cancel offers a higher fee (as a cancel) but not "Cancel…"', V.viewRow(row(c), ctx([c])).actions.join() === 'bump,again');
  const r = pay({ refusedNote: 'fee too low' });
  t(
    'a payment refused here is not offered "Announce again"',
    !V.viewRow(row(r), ctx([r])).actions.includes('again') && V.viewRow(row(r), ctx([r])).actions.includes('cancel'),
  );
  const o = pay({ pending: false, replaced: tx('c') });
  const w = pay({ txid: tx('c'), kind: 'cancel', pending: false, height: 152101 });
  t('a payment whose cancel won is tagged "cancelled"', V.viewRow(row(o), ctx([o, w])).tag === 'cancelled');
  const me = pay({ txid: tx('m'), self: true, sats: 5000, change: 4845 });
  t(
    'the output of a payment to yourself is "paid to yourself", the other "change"',
    V.coinNote({ key: tx('m') + ':0', value: 5000, height: 1 }, { height: 5, sent: [me], mature: () => true }) === ' (paid to yourself)' &&
      V.coinNote({ key: tx('m') + ':1', value: 4845, height: 1 }, { height: 5, sent: [me], mature: () => true }) === ' (change)',
  );
  const at = { kind: 'out', txid: tx('d'), label: 'Sent to', addr: 'a', sats: -1, pending: false, height: 3, at: Date.UTC(2026, 9, 1, 12) };
  t(
    'the export carries the date first',
    V.exportRow(at, ctx([])).startsWith('"2026-10-01T12:00:00.000Z","3"') && V.EXPORT_HEAD.startsWith('date,'),
  );
}
{
  const nr = pay({ relays: [] });
  const v = V.viewRow(row(nr), ctx([nr]));
  t('a short state is the words before the colon', v.state.includes(':') && v.short === v.state.split(':')[0] && !v.short.includes(':'));
  const f = pay({ abandoned: true });
  const settled = pay({ txid: tx('3'), inputs: [inA], pending: false, height: 152101, to: 'tb1pother' });
  t(
    'a forgotten payment can still be cancelled once the payment that took its coins has settled',
    V.viewRow(row(f), ctx([f, settled])).actions.includes('cancel'),
  );
}
{
  const s = pay({ pending: false, replaced: tx('e') });
  const v = V.viewRow(row(s), ctx([s]));
  t(
    'a payment whose coins another (not ours) transaction spent reads "did not happen", not "replaced"',
    /^did not happen/.test(v.state) && v.tag === 'did not happen' && v.struck,
  );
}
{
  // the confirm dialog's lines
  const money = (x) => `${x} sat`;
  const p = { amount: 3000, fee: 155, change: 6845, vsize: 155, picked: [{ key: inA }] };
  const to = 'tb1pdestinationaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const L = V.confirmLines({ to, rate: 1, p, money });
  t(
    'the plain case: address in fours, a check of its ends, amount, fee, total',
    L[0].startsWith('To: tb1p dest') &&
      /start \(tb1pdest\)/.test(L[1]) &&
      /Amount: 3000 sat/.test(L[2]) &&
      /Fee: 155 sat/.test(L[3]) &&
      /Total leaving the wallet: 3155 sat; 6845 sat comes back/.test(L[4]),
  );
  const me = V.confirmLines({ to, self: true, rate: 1, p, money });
  t(
    'to yourself: no check of the ends, and only the fee leaves',
    !me.some((l) => /Check the start/.test(l)) && me.some((l) => /Only the fee leaves the wallet; 9845 sat comes back/.test(l)),
  );
  const hi = V.confirmLines({ to, rate: 20, p: { ...p, fee: 200000, amount: 1000 }, money });
  t(
    'a high rate and a fee above the amount are said right after the fee line',
    /more than the amount: even a small payment/.test(hi[4]) && /much higher than txbt4 blocks need/.test(hi[5]),
  );
  t(
    'a chain-status warning is added at the end',
    /may never confirm/.test(V.confirmLines({ to, rate: 1, p, money, trustWarn: 'behind' }).at(-1)),
  );
  const w = V.confirmLines({ to, rate: 1, p, money, waitingSame: [{ sats: 500, inputs: [inB] }] });
  t(
    'a payment still waiting to the same address comes first: a second, separate payment',
    /still waiting\. This would be a second, separate payment/.test(w[0]),
  );
  const f1 = V.confirmLines({ to, rate: 1, p, money, waitingSame: [{ sats: 500, abandoned: true, inputs: [inA] }], reuse: 'note' });
  t(
    'a forgotten one whose coin this spends: only one can go through, and the reuse note is not repeated',
    /only one of the two can ever go through/.test(f1[0]) && !f1.includes('note'),
  );
  const f2 = V.confirmLines({ to, rate: 1, p, money, waitingSame: [{ sats: 500, abandoned: true, inputs: [inB] }] });
  t(
    'a forgotten one whose coins this does not spend: this would be a second payment',
    /does not spend its coins: this would be a second payment/.test(f2[0]),
  );
  t(
    'the reuse note is added when no forgotten payment to the same address',
    V.confirmLines({ to, rate: 1, p, money, reuse: 'note' }).includes('note'),
  );
}
{
  const money = (x) => `${x} sat`;
  const p = { amount: 3000, fee: 155, change: 6845, vsize: 155, picked: [{ key: inA }] };
  const L = V.confirmLines({
    to: 'tb1pdestinationaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    rate: 1,
    p,
    money,
    settlingSame: [{ sats: 3000 }],
  });
  t('paying an address whose payment was cancelled only recently is warned first', /cancelled or did not happen only recently/.test(L[0]));
  const r = { kind: 'in', txid: tx('u'), label: 'Received', addr: 'me', sats: 5, pending: false, height: 152105, conf: 3 };
  t(
    'a receipt in a block above the signed chain tip is not counted as confirmed',
    /in block 152,105, which the signed chain tip has not reached yet/.test(V.viewRow(r, { ...ctx([]), vouched: 152104 }).state) &&
      /confirming/.test(V.viewRow(r, { ...ctx([]), vouched: 152105 }).state),
  );
}
{
  for (const bad of ['-1+1', '\tcmd', '+SUM(1)', '@x'])
    t(
      `the export quotes a cell starting with ${JSON.stringify(bad[0])}`,
      V.exportRow({ kind: 'in', txid: tx('q'), label: bad, addr: 'a', sats: 1, pending: false }, ctx([])).includes(
        `"'${bad.replace(/"/g, '""')}"`,
      ),
    );
}
{
  // round 10: the survivors that mattered
  const conf = { kind: 'in', txid: tx('v'), label: 'Received', addr: 'me', sats: 5, pending: false, height: 152100, conf: 2 };
  t(
    'with no signed tip (null), confirmations are shown as usual, not "not yet vouched for"',
    /confirming/.test(V.viewRow(conf, { ...ctx([]), vouched: null }).state),
  );
  const rn = pay({ refusedNote: 'x' }),
    rf = pay({ refused: 'y', replaces: tx('0') });
  t(
    'short states: refused here, a higher fee not accepted',
    V.viewRow(row(rn), ctx([rn])).short === 'not accepted here' && V.viewRow(row(rf), ctx([rf])).short === 'higher fee not accepted',
  );
  const above = V.viewRow(conf, { ...ctx([]), vouched: 152099 });
  t('a block above the signed tip reads "waiting for the signed chain tip" in a list', above.short === 'waiting for the signed chain tip');
  t(
    'above the signed tip: "usually within a block" only while the tip moves',
    /usually within a block/.test(above.state) &&
      /has not moved for a while/.test(V.viewRow(conf, { ...ctx([]), vouched: 152099, tipStale: true }).state),
  );
  const struck = pay({ pending: false, replaced: tx('e') });
  t(
    'a struck row keeps its own words even above the signed tip',
    /^did not happen/.test(V.viewRow({ ...row(struck), height: 152101 }, { ...ctx([struck]), vouched: 152099 }).state),
  );
  const rows = [{ kind: 'in', txid: tx('i'), label: 'Received', addr: 'a', sats: 1, pending: false }, row(pay())];
  t(
    'the "sent" filter shows only payments out',
    V.filterRows(rows, { type: 'out' }).length === 1 && V.filterRows(rows, { type: 'out' })[0].kind === 'out',
  );
}
{
  // round 11: the confirm dialog's leftover line, and the balance sentences
  const money = (x) => `${x} sat`;
  const to = 'tb1pdestinationaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const dust = V.confirmLines({ to, rate: 1, p: { amount: 9000, fee: 362, change: 0, vsize: 200, picked: [{ key: inA }] }, money });
  t(
    'a leftover too small for change is said, with its amount',
    dust.some((l) => /162 sat of that fee is a leftover/.test(l)),
  );
  t(
    '...not when the fee is exactly the rate',
    !V.confirmLines({ to, rate: 1, p: { amount: 9000, fee: 200, change: 0, vsize: 200, picked: [] }, money }).some((l) =>
      /leftover/.test(l),
    ),
  );
  t(
    '...not for a payment of everything',
    !V.confirmLines({ to, all: true, rate: 1, p: { amount: 9000, fee: 362, change: 0, vsize: 200, picked: [] }, money }).some((l) =>
      /leftover/.test(l),
    ),
  );
  t(
    '...not when there is change',
    !V.confirmLines({ to, rate: 1, p: { amount: 9000, fee: 362, change: 500, vsize: 200, picked: [] }, money }).some((l) =>
      /leftover/.test(l),
    ),
  );
  const b = { immature: 0, outgoing: 0, pending: 3000, elsewhere: 0, unvouched: 3000 };
  t(
    'nothing spendable names money in blocks the signed chain tip has not reached, and does not blame a waiting payment for it',
    /3000 sat is in blocks the signed chain tip has not reached yet/.test(V.noCoinsWhy(b, { money })) &&
      !/payment of yours/.test(V.noCoinsWhy(b, { money })),
  );
  t(
    'nothing spendable while change is on its way back blames the waiting payment',
    /payment of yours/.test(V.noCoinsWhy({ immature: 0, outgoing: 0, pending: 800, returning: 800, elsewhere: 0 }, { money })),
  );
  t('nothing at all: no coins yet', /No coins yet/.test(V.noCoinsWhy({ immature: 0, outgoing: 0, pending: 0, elsewhere: 0 }, { money })));
  t(
    'the balance line names what is leaving, above the signed chain tip and reserved',
    V.reservedText({ outgoing: 10, unvouched: 20, elsewhere: 30 }, { hitch: true, quarantine: true, money }) ===
      '10 sat leaving in payments not yet confirmed · 20 sat in blocks the signed chain tip has not reached yet · 30 sat reserved elsewhere: a Hitch channel funding (to release it, close Reef, open Hitch and cancel the funding there); a payment record Reef could not verify (see the notice above)',
  );
}
{
  const money = (x) => `${x} sat`;
  const to = 'tb1pdestinationaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const L = V.confirmLines({ to, rate: 1, p: { amount: 9000, fee: 362, change: 0, vsize: 200, picked: [] }, money, allAmount: 9150 });
  t(
    'the fee line splits rate and leftover, and says what Send everything would pay instead',
    L.some((l) => l === 'Fee: 362 sat — 200 sat (200 vB at 1 sat/vB) + 162 sat leftover') &&
      L.some((l) => /Send everything would pay the recipient 9150 sat instead/.test(l)),
  );
  const hiOk = V.confirmLines({ to, rate: 20, p: { amount: 9000, fee: 300, change: 100, vsize: 15, picked: [] }, money, suggested: 25 });
  t('a high rate is not called high when payments waiting pay as much', !hiOk.some((l) => /much higher/.test(l)));
  const hi = V.confirmLines({ to, rate: 40, p: { amount: 9000, fee: 600, change: 100, vsize: 15, picked: [] }, money, suggested: 25 });
  t(
    '...and is, against what they pay, when above it',
    hi.some((l) => /payments waiting now pay \(about 25 sat\/vB\)/.test(l)),
  );
}
{
  // one phrase for money above the signed chain tip, wherever it is said, and the own-address rows named once
  const { readFileSync } = await import('node:fs');
  const src =
    readFileSync(new URL('../reef.js', import.meta.url), 'utf8') + readFileSync(new URL('../lib/view.mjs', import.meta.url), 'utf8');
  t('no older wording for money above the signed chain tip is left in the page', !/double-checked|second check/.test(src));
  t(
    'own-address rows: money in and payments to oneself, nothing else',
    V.isOwnAddressRow({ kind: 'in', label: 'Received' }) &&
      V.isOwnAddressRow({ kind: 'out', label: 'Payment to yourself' }) &&
      !V.isOwnAddressRow({ kind: 'out', label: 'Sent' }),
  );
  t(
    'a long address is shortened to its start and its end; a short one is kept whole',
    V.shortAddr('tb1q' + 'a'.repeat(30) + 'xyz1234') === 'tb1qaaaaaa…xyz1234' && V.shortAddr('tb1qshort') === 'tb1qshort',
  );
}
console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
