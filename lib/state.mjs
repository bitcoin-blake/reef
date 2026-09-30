// Reef's payment records as a state machine, pure: what the tab knows about each payment it made, how two tabs' copies
// merge, what the chain and the mempool say about them, when one is published again, when it may be forgotten. The page
// feeds it events and carries out what it returns; test/state-test.mjs drives it through the orderings that matter.
//
// A record: { txid, to, toScript, sats, fee, change, self, all, kind: 'payment'|'cancel', hex, inputs, values, tip,
//   at, lastPub, relays, pending, height, replaces, replacedBy, replaced, abandoned, refused, hidden, recovered, partial }
export const REPUBLISH_MS = 10 * 60e3, FORGET_AFTER = 6; // publish a waiting payment again every 10 minutes; offer to forget one after 6 blocks unseen
const STICKY = ['replacedBy', 'replaced', 'abandoned', 'refused', 'hidden', 'hex', 'values', 'toScript', 'change', 'relays'];

// two copies of the same payment (this tab's and what another tab stored): nothing learnt by either is lost
export function mergeOne(a, b) {
  const m = { ...a };
  for (const k of STICKY) if (m[k] == null && b[k] != null) m[k] = b[k];
  if (b.replacedBy && !a.replacedBy) m.replacedBy = b.replacedBy; if (b.hidden) m.hidden = true; if (b.abandoned) m.abandoned = true;
  if (!b.pending || !a.pending) { m.pending = false; m.height = a.height ?? b.height ?? null; }
  const lp = Math.max(a.lastPub ?? 0, b.lastPub ?? 0); if (lp) m.lastPub = lp; if (a.recovered || b.recovered) m.recovered = !!(a.recovered && b.recovered);
  if (a.recovered && !b.recovered) { for (const k of ['to', 'sats', 'fee', 'kind', 'self', 'all', 'tip', 'at']) if (b[k] != null) m[k] = b[k]; }
  return m;
}
export function mergeSent(mine, stored) {
  const by = new Map(mine.map((s) => [s.txid, s]));
  for (const o of stored) by.set(o.txid, by.has(o.txid) ? mergeOne(by.get(o.txid), o) : o);
  return [...by.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}
// what to keep in storage: everything pending, and the newest settled ones; a settled one dropped leaves a tombstone so its
// change is never taken for a receipt
export function trimSent(sent, keep = 300) { const pending = sent.filter((s) => s.pending); const settled = sent.filter((s) => !s.pending); const old = settled.slice(0, Math.max(0, settled.length - keep)).map((s) => ({ txid: s.txid, pending: false, height: s.height ?? null, tomb: true, at: s.at })); return [...old, ...pending, ...settled.slice(-keep)].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)); }

// the versions of one payment: the original and its replacements, all spending the same coins
export const groupOf = (sent, s) => sent.filter((x) => (x.inputs ?? []).some((k) => (s.inputs ?? []).includes(k)));

// a payment's own transaction is in a block at `height`: it is confirmed, every other version of it did not happen
export function confirm(sent, s, height) {
  const out = [];
  s.pending = false; s.height = height; s.replaced = undefined;
  for (const o of groupOf(sent, s)) if (o !== s && (o.pending || !o.replaced)) { o.pending = false; o.replaced = s.txid; o.height = undefined; }
  const was = s.replaces ? sent.find((x) => x.txid === s.replaces) : null;
  out.push(s.kind === 'cancel' ? { notice: 'Payment cancelled', body: `the coins came back to you in block ${height}`, height } : { notice: 'Payment confirmed', body: s.self ? `your payment to yourself is in block ${height}` : `${s.sats} sat to ${String(s.to).slice(0, 14)}… in block ${height}${was ? ' (the version with the higher fee)' : ''}`, height, sats: s.sats });
  return out;
}

// the coins the node reports for the wallet: payments confirmed by their change, and questions to ask about the others
// (their inputs are gone but no change says which transaction took them)
export function onCoins({ sent, coins, asked = new Set() }) {
  const effects = [];
  for (const s of sent) if (s.pending) {
    const change = coins.find((c) => c.key.startsWith(s.txid + ':')); if (change) { effects.push(...confirm(sent, s, change.height)); continue; }
    const gone = (s.inputs ?? []).length && s.inputs.every((k) => !coins.some((c) => c.key === k));
    if (gone && !asked.has(s.txid)) { asked.add(s.txid); effects.push({ ask: s.txid, input: s.inputs[0], from: Math.max(150308, (s.tip ?? 0) - 1) }); } }
  return effects;
}
// the node found the transaction that spent a payment's first input
export function onSpendAnswer(sent, txid, answer) {
  const s = sent.find((x) => x.txid === txid); if (!s || !s.pending || !answer?.found) return [];
  const winner = sent.find((x) => x.txid === answer.txid);
  if (winner) return confirm(sent, winner, answer.height);
  for (const o of groupOf(sent, s)) if (o.pending) { o.pending = false; o.replaced = answer.txid; }
  return [{ notice: 'Payment did not happen', body: `its coins were spent by another transaction (${answer.txid.slice(0, 12)}…) in block ${answer.height}`, bad: true }];
}
// the tab's mempool refused a transaction of ours: stop publishing it; a refused replacement leaves the original standing
export function onRefused(sent, txid, error) {
  const s = sent.find((x) => x.txid === txid); if (!s || !s.pending || s.refused) return [];
  s.refused = String(error).slice(0, 200);
  const orig = s.replaces ? sent.find((x) => x.txid === s.replaces) : null; if (orig && orig.replacedBy === s.txid) orig.replacedBy = undefined;
  return [{ notice: s.replaces ? (s.kind === 'cancel' ? 'Cancel not accepted' : 'Higher fee not accepted') : 'Payment refused', body: `the network's rules refused it: ${s.refused}${orig ? '; the original payment stands' : ''}`, bad: true }];
}
// which payments to publish again now: waiting, from this tab (the signed transaction is here), not replaced, not refused,
// not forgotten, and not published in the last REPUBLISH_MS. Relays do not keep these events, and seeing one's own event
// in the tab's mempool proves only that a relay carried it, so this goes on until a block settles it.
export const republishDue = (sent, now) => sent.filter((s) => s.pending && s.hex && !s.replacedBy && !s.refused && !s.abandoned && now - (s.lastPub ?? 0) >= REPUBLISH_MS);
// may the person forget a waiting payment (release its coins)? only when it has been waiting FORGET_AFTER blocks and no
// version of it is in the tab's mempool; the signed transaction could still be mined, which the page says
export const forgettable = (sent, s, height, inMempool) => s.pending && !s.abandoned && height != null && height - (s.tip ?? height) >= FORGET_AFTER && !groupOf(sent, s).some((o) => o.pending && inMempool(o.txid));

// how a person should read a record now
export function stateOf(s, { inMempool, height, now }) {
  if (s.replaced) return s.kind === 'cancel' ? 'cancel not taken' : 'did not happen (another version was mined)';
  if (!s.pending) return 'confirmed';
  if (s.abandoned) return 'forgotten: its coins are released';
  if (s.refused) return 'refused by the network';
  if (s.replacedBy) return 'being replaced';
  if (!(s.relays ?? []).length && s.hex) return 'not yet handed to a relay: retrying';
  if (inMempool(s.txid)) return height != null && s.tip != null && height - s.tip >= 3 ? `valid, not in a block after ${height - s.tip} blocks: published again` : 'waiting for a block';
  return now - (s.at ?? now) > 10 * 60e3 ? 'not seen yet: published again every 10 minutes' : 'published';
}
