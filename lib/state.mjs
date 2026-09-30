// Reef's payment records as a state machine, pure: what the tab knows about each payment it made, how two tabs' copies
// merge, what the chain and the mempool say about them, when one is published again, when it may be forgotten. The page
// feeds it events and carries out what it returns; test/state-test.mjs drives it through the orderings that matter.
//
// A record: { txid, to, toScript, sats, fee, change, self, all, kind: 'payment'|'cancel', hex, inputs, values, tip,
//   at, lastPub, relays, pending, height, replaces, replacedBy, replaced, abandoned, refused, hidden, recovered, partial }
export const REPUBLISH_MS = 10 * 60e3, FORGET_AFTER = 6; // publish a waiting payment again every 10 minutes; offer to forget one after 6 blocks unseen
const STICKY = ['replacedBy', 'abandoned', 'refused', 'hidden', 'hex', 'values', 'toScript', 'change', 'relays'];
// the verdict on a payment (pending, confirmed at a height, or replaced by another) is whatever was learnt last: a reorganisation can undo an earlier one
const VERDICT = ['pending', 'height', 'replaced', 'vAt'];

// two copies of the same payment (this tab's and what another tab stored): nothing learnt by either is lost
export function mergeOne(a, b) {
  if (a.tomb && !b.tomb) [a, b] = [b, a]; // a tombstone never overrules a full record
  const m = { ...a };
  for (const k of STICKY) if (m[k] == null && b[k] != null) m[k] = b[k];
  if (b.replacedBy && !a.replacedBy) m.replacedBy = b.replacedBy; if (b.hidden) m.hidden = true; if (b.abandoned) m.abandoned = true;
  const later = (b.vAt ?? 0) > (a.vAt ?? 0) || ((b.vAt ?? 0) === (a.vAt ?? 0) && a.pending && !b.pending) ? b : a; for (const k of VERDICT) { if (later[k] === undefined) delete m[k]; else m[k] = later[k]; }
  const lp = Math.max(a.lastPub ?? 0, b.lastPub ?? 0); if (lp) m.lastPub = lp; if (a.recovered || b.recovered) m.recovered = !!(a.recovered && b.recovered);
  if (a.recovered && !b.recovered) { for (const k of ['to', 'sats', 'fee', 'kind', 'self', 'all', 'tip', 'at']) if (b[k] != null) m[k] = b[k]; }
  return m;
}
export function mergeSent(mine, stored) {
  const by = new Map(mine.map((s) => [s.txid, s]));
  for (const o of stored) by.set(o.txid, by.has(o.txid) ? mergeOne(by.get(o.txid), o) : o);
  // a replacement that was refused does not replace anything, whatever an older copy says
  for (const s of by.values()) if (s.replacedBy && by.get(s.replacedBy)?.refused) delete s.replacedBy;
  return [...by.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}
// what to keep in storage: everything pending, and the newest settled ones; a settled one dropped leaves a tombstone so its
// change is never taken for a receipt
export function trimSent(sent, keep = 300, tombs = 5000) { const pending = sent.filter((s) => s.pending); const settled = sent.filter((s) => !s.pending && !s.tomb); const old = [...sent.filter((s) => s.tomb), ...settled.slice(0, Math.max(0, settled.length - keep)).map((s) => ({ txid: s.txid, pending: false, height: s.height ?? null, tomb: true, at: s.at }))].slice(-tombs); return [...old, ...pending, ...settled.slice(-keep)].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)); }

// the versions of one payment: the original and its replacements, all spending the same coins
export const groupOf = (sent, s) => sent.filter((x) => (x.inputs ?? []).some((k) => (s.inputs ?? []).includes(k)));

// a payment's own transaction is in a block at `height`: it is confirmed, every other version of it did not happen
export function confirm(sent, s, height) {
  const out = [];
  const at = Date.now(); s.pending = false; s.height = height; delete s.replaced; s.vAt = at;
  for (const o of groupOf(sent, s)) if (o !== s && (o.pending || !o.replaced)) { o.pending = false; o.replaced = s.txid; delete o.height; o.vAt = at; }
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
  const s = sent.find((x) => x.txid === txid); if (!s || !s.pending || !answer?.found) return []; // not found: the caller forgets it asked, so the next coins reply asks again
  const winner = sent.find((x) => x.txid === answer.txid);
  if (winner) return confirm(sent, winner, answer.height);
  for (const o of groupOf(sent, s)) if (o.pending) { o.pending = false; o.replaced = answer.txid; o.vAt = Date.now(); }
  return [{ notice: 'Payment did not happen', body: `its coins were spent by another transaction (${answer.txid.slice(0, 12)}…) in block ${answer.height}`, bad: true }];
}
// the tab's mempool refused a transaction: it counts only if it is the exact transaction we signed (a copy with a broken
// signature has the same txid). A refused replacement is let go and the original stands; an original keeps its coins held
// and keeps being published, because another node's rules may accept what this tab's refused: the refusal is only shown
export function onRefused(sent, txid, error, hex) {
  const s = sent.find((x) => x.txid === txid); if (!s || !s.pending || !s.hex || hex !== s.hex) return [];
  if (!s.replaces) { if (s.refusedNote) return []; s.refusedNote = String(error).slice(0, 200); return [{ notice: 'Payment refused here', body: `this tab's node refused it (${s.refusedNote}); another node may still accept it, so it is kept and published again. Cancel it to be sure it never goes through.`, bad: true }]; }
  if (s.refused) return []; s.refused = String(error).slice(0, 200);
  const orig = sent.find((x) => x.txid === s.replaces); if (orig && orig.replacedBy === s.txid) delete orig.replacedBy;
  return [{ notice: s.kind === 'cancel' ? 'Cancel not accepted' : 'Higher fee not accepted', body: `the network's rules refused it: ${s.refused}; the original payment stands`, bad: true }];
}
// a stored record is taken only if its signed transaction is what it says: the txid, the coins it spends and, for the
// page, a destination that matches its address. `check(hex)` → { txid, inputs } decodes; `scriptOf(address)` → script
export function validRecord(s, { check, scriptOf }) {
  if (!s || typeof s.txid !== 'string' || !/^[0-9a-f]{64}$/.test(s.txid)) return false;
  if (s.hex != null) { let d = null; try { d = check(s.hex); } catch {} if (!d || d.txid !== s.txid || JSON.stringify(d.inputs) !== JSON.stringify(s.inputs ?? [])) return false; }
  if (s.toScript != null && s.to && !s.to.startsWith('(') && scriptOf(s.to) !== s.toScript) return false;
  return true;
}
// which payments to publish again now: waiting, from this tab (the signed transaction is here), not replaced, not refused,
// not forgotten, and not published in the last REPUBLISH_MS. Relays do not keep these events, and seeing one's own event
// in the tab's mempool proves only that a relay carried it, so this goes on until a block settles it.
export const republishDue = (sent, now) => sent.filter((s) => s.pending && s.hex && !s.replacedBy && !s.refused && !s.abandoned && now - (s.lastPub ?? 0) >= REPUBLISH_MS);
// may the person forget a waiting payment (release its coins)? only when it has been waiting FORGET_AFTER blocks and no
// version of it is in the tab's mempool; the signed transaction could still be mined, which the page says
export const forgettable = (sent, s, height, inMempool) => { if (!s.pending || s.abandoned || height == null) return false; const g = groupOf(sent, s); const tip = Math.max(...g.map((o) => o.tip ?? height)); return height - tip >= FORGET_AFTER && !g.some((o) => o.pending && inMempool(o.txid)); }; // measured from the newest version

// how a person should read a record now, with what they can do next
export function stateOf(s, { inMempool, height, now }) {
  if (s.replaced) return s.kind === 'cancel' ? 'cancel came too late: the payment went through' : 'replaced: another version of this payment was mined';
  if (!s.pending) return 'confirmed';
  if (s.abandoned) return 'forgotten: its coins go into your next payment, so it cannot also go through';
  if (s.refused) return `not accepted (${s.refused}): the original stands`;
  if (s.refusedNote) return `refused by this tab's node (${s.refusedNote}); kept and published in case another node takes it: cancel it to be sure`;
  if (s.replacedBy) return 'replaced by a higher fee: waiting for a block';
  if (!s.hex) return inMempool(s.txid) ? 'made elsewhere with this key: waiting for a block' : 'made elsewhere with this key: not seen here now';
  if (!(s.relays ?? []).length) return 'not yet handed to a relay: retrying every 10 minutes';
  if (inMempool(s.txid)) return height != null && s.tip != null && height - s.tip >= 3 ? `not in a block after ${height - s.tip} blocks: raise the fee to hurry it` : 'waiting for a block';
  return now - (s.at ?? now) > 10 * 60e3 ? 'not seen yet: published again every 10 minutes' : 'handed to the relays';
}
