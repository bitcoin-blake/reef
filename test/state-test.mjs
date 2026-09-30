// The payment records through the orderings that matter: two tabs merging, a payment confirmed by its change or by the
// node's spend lookup, a replacement that wins or loses, a refused replacement, republishing, forgetting.
import * as S from '../lib/state.mjs';
let ok = 0, bad = 0; const t = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`); cond ? ok++ : bad++; };
const tx = (c) => c.repeat(64); const inA = tx('a') + ':0', inB = tx('b') + ':1';
const pay = (over = {}) => ({ txid: tx('1'), to: 'tb1pdest', toScript: '5120' + 'dd'.repeat(32), sats: 3000, fee: 155, change: 6845, kind: 'payment', hex: '00', inputs: [inA], values: [10000], tip: 152100, at: 1000, lastPub: 1000, relays: ['wss://r'], pending: true, ...over });
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---- merging two tabs' copies
{ const mine = [pay()]; const other = [pay({ replacedBy: tx('2') }), pay({ txid: tx('2'), fee: 400, change: 6600, replaces: tx('1'), at: 2000 })];
  const m = S.mergeSent(clone(mine), clone(other)); const orig = m.find((s) => s.txid === tx('1'));
  t('a replacement made in the other tab survives the merge: replacedBy is sticky and the replacement is added', orig.replacedBy === tx('2') && m.length === 2);
  const back = S.mergeSent(clone(other), clone(mine)); t('the merge is the same whichever side is "mine"', JSON.stringify(back.map((s) => [s.txid, s.replacedBy ?? null, s.pending])) === JSON.stringify(m.map((s) => [s.txid, s.replacedBy ?? null, s.pending])));
  t('merging with itself changes nothing (idempotent)', JSON.stringify(S.mergeSent(clone(m), clone(m))) === JSON.stringify(m));
  const settled = S.mergeSent([pay()], [pay({ pending: false, height: 152105 })]); t('a settlement learnt by either copy wins', settled[0].pending === false && settled[0].height === 152105);
  const rec = S.mergeSent([pay({ recovered: true, to: '(seen in the mempool)', hex: undefined, fee: 0 })], [pay()]); t('a hex-less copy recovered from the mempool does not replace the record with the signed transaction', rec[0].hex === '00' && rec[0].to === 'tb1pdest' && !rec[0].recovered && rec[0].fee === 155); }
{ const many = Array.from({ length: 400 }, (_, i) => pay({ txid: i.toString(16).padStart(64, '0'), pending: i >= 395, at: i, height: 152000 + i })); const kept = S.trimSent(many, 300);
  t('trimming keeps every pending payment and leaves a tombstone for each settled one dropped', kept.filter((s) => s.pending).length === 5 && kept.filter((s) => s.tomb).length === 95 && kept.length === 400 && kept.filter((s) => s.tomb).every((s) => !s.hex)); }

// ---- confirmation
{ const sent = [pay()]; const fx = S.onCoins({ sent, coins: [{ key: tx('1') + ':1', value: 6845, height: 152103 }] });
  t('a payment is confirmed by its change coin', !sent[0].pending && sent[0].height === 152103 && fx.some((e) => e.notice === 'Payment confirmed')); }
{ const sent = [pay({ change: 0 })]; const asked = new Set(); const fx = S.onCoins({ sent, coins: [], asked });
  t('without change, inputs gone: the node is asked which transaction spent them, once', fx.length === 1 && fx[0].ask === tx('1') && fx[0].input === inA && S.onCoins({ sent, coins: [], asked }).length === 0);
  const fx2 = S.onSpendAnswer(sent, tx('1'), { found: true, txid: tx('1'), height: 152104 }); t('the answer naming our transaction confirms it', !sent[0].pending && sent[0].height === 152104 && fx2[0].notice === 'Payment confirmed'); }
{ const sent = [pay({ change: 0 })]; const fx = S.onSpendAnswer(sent, tx('1'), { found: true, txid: tx('9'), height: 152104 });
  t('an answer naming a transaction we never made: the payment did not happen, said as a failure', !sent[0].pending && sent[0].replaced === tx('9') && fx[0].bad); }
t('a spend answer for a payment already settled changes nothing', S.onSpendAnswer([pay({ pending: false, height: 5 })], tx('1'), { found: true, txid: tx('9'), height: 6 }).length === 0);

// ---- replacements: who wins
{ const sent = [pay({ replacedBy: tx('2') }), pay({ txid: tx('2'), fee: 400, change: 6600, replaces: tx('1') })];
  S.onCoins({ sent, coins: [{ key: tx('2') + ':1', value: 6600, height: 152106 }] });
  t('the replacement is mined: it is confirmed, the original did not happen', !sent[1].pending && sent[1].height === 152106 && sent[0].replaced === tx('2') && !sent[0].pending); }
{ const sent = [pay({ replacedBy: tx('2') }), pay({ txid: tx('2'), kind: 'cancel', self: true, sats: 0, fee: 400, change: 9600, replaces: tx('1') })];
  const fx = S.onCoins({ sent, coins: [{ key: tx('1') + ':1', value: 6845, height: 152106 }] });
  t('the original wins over a cancel: the payment is confirmed, the cancel is marked not taken', !sent[0].pending && sent[0].height === 152106 && sent[1].replaced === tx('1') && S.stateOf(sent[1], { inMempool: () => false, height: 152106, now: 0 }) === 'cancel not taken' && fx[0].notice === 'Payment confirmed'); }
{ const sent = [pay({ replacedBy: tx('2') }), pay({ txid: tx('2'), fee: 400, change: 6600, replaces: tx('1') })];
  const fx = S.onRefused(sent, tx('2'), 'a replacement must pay at least 266 sat');
  t('a refused replacement stops being published and the original stands again', sent[1].refused && !sent[0].replacedBy && fx[0].bad && S.republishDue(sent, 1e12).map((s) => s.txid).join() === tx('1')); }

// ---- republishing and forgetting
{ const now = 5_000_000; const sent = [pay({ lastPub: now - 60e3 }), pay({ txid: tx('3'), lastPub: now - 11 * 60e3 }), pay({ txid: tx('4'), lastPub: 0, hex: undefined }), pay({ txid: tx('5'), lastPub: 0, replacedBy: tx('6') }), pay({ txid: tx('7'), lastPub: 0, abandoned: true })];
  t('republished: only waiting payments with their signed transaction, not replaced, not forgotten, after 10 minutes', S.republishDue(sent, now).map((s) => s.txid).join() === tx('3')); }
{ const sent = [pay({ tip: 152100 })]; const inMp = (id) => id === tx('1');
  t('a payment in the tab\'s mempool is never offered to forget', !S.forgettable(sent, sent[0], 152120, inMp));
  t('one waiting 6 blocks and not in the mempool may be forgotten; 5 blocks not yet', S.forgettable(sent, sent[0], 152106, () => false) && !S.forgettable(sent, sent[0], 152105, () => false)); }
{ const st = (s, o = {}) => S.stateOf(s, { inMempool: () => false, height: 152101, now: 2000, ...o });
  t('the states read in words', st(pay()) === 'published' && st(pay({ relays: [] })) === 'not yet handed to a relay: retrying' && st(pay(), { inMempool: () => true }) === 'waiting for a block' && st(pay({ replacedBy: 'x' })) === 'being replaced' && st(pay({ refused: 'x' })) === 'refused by the network' && st(pay({ abandoned: true })) === 'forgotten: its coins are released' && st(pay({ pending: false, height: 1 })) === 'confirmed' && st(pay(), { now: 2000 + 11 * 60e3 }) === 'not seen yet: published again every 10 minutes'); }

// ---- the page's version and version.json agree (a release that forgets one shows a false update banner)
{ const { readFileSync } = await import('node:fs'); const src = readFileSync(new URL('../reef.js', import.meta.url), 'utf8'); const v = src.match(/export const VERSION = '([^']+)'/)?.[1]; const j = JSON.parse(readFileSync(new URL('../version.json', import.meta.url), 'utf8'));
  t('reef.js VERSION matches version.json', v && v === j.version, `${v} vs ${j.version}`); }
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
