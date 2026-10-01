// Reef's payment records as a state machine, pure: what the tab knows about each payment it made, how two tabs' copies
// merge, what the chain and the mempool say about them, when one is published again, when it may be forgotten. The page
// feeds it events and carries out what it returns; test/state-test.mjs drives it through the orderings that matter.
//
// A record: { txid, to, toScript, sats, fee, change, self, all, kind: 'payment'|'cancel', hex, inputs, values, tip,
//   at, lastPub, relays, pending, height, replaces, replacedBy, replaced, abandoned, refused, hidden, recovered, partial }
// a verdict's time: never earlier than any verdict already recorded, so a clock stepping back cannot make a stale one win
export const stamp = (sent) => Math.max(Date.now(), ...sent.map((x) => (x.vAt ?? 0) + 1));
export const RECHECK_DEPTH = 6; // confirmations shallower than this are checked again on every block: a reorganisation can undo them
export const REPUBLISH_MS = 10 * 60e3,
  FORGET_AFTER = 6; // publish a waiting payment again every 10 minutes; offer to forget one after 6 blocks unseen
const STICKY = ['replacedBy', 'refused', 'hex', 'values', 'toScript', 'change', 'relays'];
// the verdict on a payment (pending, confirmed at a height, or replaced by another) is whatever was learnt last: a reorganisation can undo an earlier one
const VERDICT = ['pending', 'height', 'replaced', 'failed', 'abandoned', 'wasAbandoned', 'hidden', 'vAt']; // also what a person decided (forget, remove): the later decision wins

// two copies of the same payment (this tab's and what another tab stored): nothing learnt by either is lost
export function mergeOne(a, b) {
  if (a.tomb && !b.tomb) [a, b] = [b, a]; // a tombstone never overrules a full record
  const m = { ...a };
  if (b.tomb) return m;
  for (const k of STICKY) if (m[k] == null && b[k] != null) m[k] = b[k];
  if (b.replacedBy && !a.replacedBy) m.replacedBy = b.replacedBy;
  const later = (b.vAt ?? 0) > (a.vAt ?? 0) || ((b.vAt ?? 0) === (a.vAt ?? 0) && a.pending && !b.pending) ? b : a;
  for (const k of VERDICT) {
    if (later[k] === undefined) delete m[k];
    else m[k] = later[k];
  }
  const lp = Math.max(a.lastPub ?? 0, b.lastPub ?? 0);
  if (lp) m.lastPub = lp;
  if (a.recovered || b.recovered) m.recovered = !!(a.recovered && b.recovered);
  if (a.recovered && !b.recovered) {
    for (const k of ['to', 'sats', 'fee', 'kind', 'self', 'all', 'tip', 'at']) if (b[k] != null) m[k] = b[k];
  }
  return m;
}
export function mergeSent(mine, stored) {
  const by = new Map(mine.map((s) => [s.txid, s]));
  // a record already in memory is updated in place: a flow holding it across a dialog keeps a live reference
  for (const o of stored) {
    const cur = by.get(o.txid);
    if (!cur) {
      by.set(o.txid, o);
      continue;
    }
    const m = mergeOne(cur, o);
    for (const k of Object.keys(cur)) if (!(k in m)) delete cur[k];
    Object.assign(cur, m);
  }
  // a replacement that was refused does not replace anything, whatever an older copy says
  for (const s of by.values()) if (s.replacedBy && by.get(s.replacedBy)?.refused) delete s.replacedBy;
  return [...by.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}
// what to keep in storage: everything pending, and the newest settled ones; a settled one dropped leaves a tombstone so its
// change is never taken for a receipt
export function trimSent(sent, keep = 300, tombs = 5000) {
  const pending = sent.filter((s) => s.pending);
  const settled = sent.filter((s) => !s.pending && !s.tomb);
  const old = [
    ...sent.filter((s) => s.tomb),
    ...settled
      .slice(0, Math.max(0, settled.length - keep))
      .map((s) => ({ txid: s.txid, pending: false, height: s.height ?? null, tomb: true, at: s.at })),
  ].slice(-tombs);
  return [...old, ...pending, ...settled.slice(-keep)].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

// the versions of one payment: the original and its replacements (the chain of `replaces`), all spending the same coins
const rootOf = (sent, s) => {
  let r = s;
  const seen2 = new Set();
  while (r.replaces && !seen2.has(r.txid)) {
    seen2.add(r.txid);
    const up = sent.find((x) => x.txid === r.replaces);
    if (!up) break;
    r = up;
  }
  return r.txid;
};
export const groupOf = (sent, s) => {
  const root = rootOf(sent, s);
  return sent.filter((x) => rootOf(sent, x) === root);
};
// other payments that spend a coin of this one without being a version of it: a payment made after a forget, which spent
// the forgotten coins on purpose. Only one of them can be mined; the other did not happen and its recipient was not paid.
export const conflictsOf = (sent, s) => {
  const g = new Set(groupOf(sent, s));
  return sent.filter((x) => !g.has(x) && !x.tomb && (x.inputs ?? []).some((k) => (s.inputs ?? []).includes(k)));
};
export const newestOf = (sent, s) => {
  let r = s;
  const seen2 = new Set();
  while (r.replacedBy && !seen2.has(r.txid)) {
    seen2.add(r.txid);
    const next = sent.find((x) => x.txid === r.replacedBy);
    if (!next) break;
    r = next;
  }
  return r;
};

// a payment's own transaction is in a block at `height`: it is confirmed, every other version of it did not happen
export function confirm(sent, s, height) {
  const out = [];
  const at = stamp(sent);
  const winnerWasForgotten = !!s.abandoned;
  if (winnerWasForgotten) s.wasAbandoned = true;
  s.pending = false;
  s.height = height;
  delete s.replaced;
  delete s.failed;
  delete s.abandoned;
  delete s.hidden;
  delete s.refusedNote;
  s.vAt = at;
  for (const o of groupOf(sent, s))
    if (o !== s && (o.pending || !o.replaced)) {
      o.pending = false;
      o.replaced = s.txid;
      delete o.height;
      o.vAt = at;
    }
  // a payment that spent coins of this one on purpose (after a forget) cannot also be mined: it did not happen
  const wasForgotten = winnerWasForgotten;
  const to = (x) => (x.self ? 'yourself' : `${String(x.to).slice(0, 14)}…`);
  for (const o of conflictsOf(sent, s))
    for (const v of groupOf(sent, o))
      if (v.pending || !v.failed) {
        v.wasAbandoned = !!v.abandoned;
        v.pending = false;
        v.failed = s.txid;
        delete v.height;
        v.vAt = at;
        if (v === newestOf(sent, o))
          out.push(
            v.wasAbandoned
              ? // the usual end of a forget: the payment made on purpose went through, the forgotten one never will
                {
                  notice: 'Forgotten payment settled',
                  body: `your forgotten payment of ${v.sats} sat to ${to(v)} never happened: its coins went into your payment to ${to(s)}, now in block ${height}. Pay ${to(v)} again if you still mean to.`,
                  sats: v.sats,
                }
              : {
                  notice: 'Payment did not happen',
                  body: `your payment of ${v.sats} sat to ${to(v)} was not made: ${wasForgotten ? 'the payment you had forgotten' : 'another payment'}, to ${to(s)}, was mined instead with the same coins. Pay again if you still mean to.`,
                  sats: v.sats,
                  bad: true,
                },
          );
      }
  const was = s.replaces ? sent.find((x) => x.txid === s.replaces) : null;
  out.push(
    s.kind === 'cancel'
      ? { notice: 'Payment cancelled', body: `the coins came back to you in block ${height}`, height }
      : {
          notice: 'Payment confirmed',
          body: s.self
            ? `your payment to yourself is in block ${height}`
            : `${s.sats} sat to ${String(s.to).slice(0, 14)}… in block ${height}${was ? ' (the version with the higher fee)' : ''}`,
          height,
          sats: s.sats,
        },
  );
  return out;
}

// the coins the node reports for the wallet: payments confirmed by their change, and questions to ask about the others
// (their inputs are gone but no change says which transaction took them)
// vouched: the height the signed chain tip vouches for (null: no limit known); a block above it does not confirm a payment yet
export function onCoins({ sent, coins, asked = new Set(), height = null, vouched = null }) {
  const effects = [];
  for (const s of sent)
    if (!s.pending && !s.tomb && (s.replaced || s.failed)) {
      const change = coins.find((c) => c.key.startsWith(s.txid + ':'));
      if (!change || (vouched != null && change.height > vouched)) continue;
      const g = groupOf(sent, s);
      const to = (x) => (x.self ? 'yourself' : `${String(x.to).slice(0, 14)}…`);
      const orig = g.find((x) => !x.replaces) ?? s;
      const again =
        !s.self &&
        s.kind !== 'cancel' &&
        sent.some(
          (x) =>
            x !== s &&
            !g.includes(x) &&
            !conflictsOf(sent, s).includes(x) &&
            x.toScript &&
            x.toScript === s.toScript &&
            (x.at ?? 0) > (s.at ?? 0) &&
            (x.pending || x.height != null) &&
            !x.replaced &&
            !x.failed,
        );
      effects.push(
        s.kind === 'cancel'
          ? {
              notice: 'Payment cancelled after all',
              body: `the cancel is in block ${change.height}: the payment to ${to(orig)} was not made after all, and its coins are back with you. Pay again if you still mean to.`,
              bad: true,
            }
          : s.replaced && g.length > 1 && g.some((x) => x !== s && x.kind === 'cancel')
            ? {
                // the cancel had won, then a block was undone and the payment itself was mined: it went out after all
                notice: 'The cancel was undone',
                body: `a block was replaced, and your payment to ${to(s)} is in block ${change.height} after all, not the cancel: the payment was made.${again ? ' You paid that address again since: it may have been paid twice.' : ''}`,
                bad: true,
              }
            : s.replaced && g.length > 1
              ? {
                  notice: 'An earlier version was mined',
                  body: `an earlier version of your payment to ${to(s)} is in block ${change.height}; the payment was made once.${again ? ' You paid that address again since: it may have been paid twice.' : ''}`,
                  bad: again,
                }
              : {
                  notice: 'A payment was mined after all',
                  body: `your payment of ${s.sats} sat to ${to(s)}, shown as not having happened, is in block ${change.height} after all.${again ? ' You paid that address again since: it may have been paid twice.' : ''}`,
                  bad: again,
                },
      );
      effects.push(...confirm(sent, s, change.height));
    }
  for (const s of sent)
    if (
      !s.pending &&
      !s.tomb &&
      !s.replaced &&
      !s.failed &&
      s.height != null &&
      (height == null || height >= s.height) &&
      (s.inputs ?? []).some((k) => coins.some((c) => c.key === k))
    )
      effects.push(...onRecheck(sent, s.txid, { found: false, to: height }, height) /* the coins are back: proof enough */);
  for (const s of sent)
    if (s.pending) {
      const change = coins.find((c) => c.key.startsWith(s.txid + ':'));
      if (change && vouched != null && change.height > vouched) continue; // the source's word alone: wait for the tip
      if (change) {
        effects.push(...confirm(sent, s, change.height));
        continue;
      }
      // any of its coins gone (not only all): something spent it, maybe another payment made with this key elsewhere
      const goneKey = (s.inputs ?? []).find((k) => !coins.some((c) => c.key === k));
      if (goneKey && !asked.has(s.txid)) {
        asked.add(s.txid);
        effects.push({ ask: s.txid, input: goneKey, from: Math.max(FIRST_BLAKE_HEIGHT, (s.tip ?? 0) - 1) });
      }
    }
  return effects;
}
// the node found the transaction that spent a payment's first input
// vouched: as in onCoins — an answer in a block above the signed tip gives no verdict yet (asked again later)
export function onSpendAnswer(sent, txid, answer, vouched = null) {
  const s = sent.find((x) => x.txid === txid);
  if (!s || !s.pending || !answer?.found) return []; // not found: the caller forgets it asked, so the next coins reply asks again
  if (vouched != null && answer.height > vouched) return [];
  const winner = sent.find((x) => x.txid === answer.txid);
  if (winner) return confirm(sent, winner, answer.height);
  const at = stamp(sent);
  for (const o of groupOf(sent, s))
    if (o.pending) {
      o.pending = false;
      o.replaced = answer.txid;
      o.vAt = at;
    }
  return [
    {
      notice: 'Payment did not happen',
      body: `its coins were spent by another transaction (${answer.txid.slice(0, 12)}…) in block ${answer.height}`,
      bad: true,
    },
  ];
}
// the tab's mempool refused a transaction: it counts only if it is the exact transaction we signed (a copy with a broken
// signature has the same txid). A refused replacement is let go and the original stands; a refused original keeps its coins
// held (another node may have taken it before) but is not announced again: a refusal is never routed around
export function onRefused(sent, txid, error, hex) {
  const s = sent.find((x) => x.txid === txid);
  if (!s || !s.pending || !s.hex || String(hex ?? '').toLowerCase() !== s.hex.toLowerCase() || s.replacedBy) return []; // an old version replayed after a newer one says nothing
  // not a judgement on the payment: its coins are already spent (by a block that mined it or its other version, which the coins
  // reply settles a moment later) or the tab's mempool is full; counting these would raise a false alarm
  if (/is not an unspent coin|mempool full/.test(String(error))) return [];
  if (!s.replaces) {
    if (s.refusedNote) return [];
    s.refusedNote = String(error).slice(0, 200);
    return [
      {
        notice: 'Payment refused here',
        body: `This tab's node would not take it (reason: ${s.refusedNote}). Its coins stay in your wallet, held for it; they leave only if a block takes it. Reef does not announce it again. To be sure it never goes through, cancel it on the Transactions page.`,
        bad: true,
      },
    ];
  }
  if (s.refused) return [];
  s.refused = String(error).slice(0, 200);
  const orig = sent.find((x) => x.txid === s.replaces);
  if (orig && orig.replacedBy === s.txid) delete orig.replacedBy;
  return [
    {
      notice: s.kind === 'cancel' ? 'Cancel not accepted' : 'Higher fee not accepted',
      body: `the network's rules refused it: ${s.refused}; the original payment stands`,
      bad: true,
    },
  ];
}
// a stored record is taken only if its signed transaction is what it says: the txid, the coins it spends and, for the
// page, a destination that matches its address. `check(hex)` → { txid, inputs } decodes; `scriptOf(address)` → script
export function validRecord(s, { check, scriptOf, ownScript = null }) {
  if (!s || typeof s.txid !== 'string' || !/^[0-9a-f]{64}$/.test(s.txid)) return false;
  if (s.hex != null) {
    let d = null;
    try {
      d = check(s.hex);
    } catch {}
    if (!d || d.txid !== s.txid || JSON.stringify(d.inputs) !== JSON.stringify(s.inputs ?? [])) return false;
    const outs = d.outputs ?? [];
    const outSum = outs.reduce((a, o) => a + o.value, 0);
    if (s.values && s.values.reduce((a, v) => a + v, 0) - outSum !== s.fee) return false;
    if (s.kind !== 'cancel' && s.toScript && !outs.some((o) => o.scriptPubKey === s.toScript && o.value === s.sats)) return false;
    // what the record says comes back to this wallet must be what its transaction pays this wallet; flags that older versions
    // recorded wrongly (a payment to oneself not marked as such) are corrected from the transaction rather than rejected
    if (ownScript) {
      const mine = outs.filter((o) => o.scriptPubKey === ownScript).reduce((a, o) => a + o.value, 0);
      if (s.kind === 'cancel' && (outs.length !== 1 || outs[0].scriptPubKey !== ownScript)) return false;
      if (s.kind !== 'cancel') s.self = s.toScript === ownScript;
      const back = (s.change ?? 0) + (s.self ? s.sats : 0);
      if (s.change != null && back !== mine && !(s.self && (s.change ?? 0) === mine)) return false;
    }
  }
  if (s.toScript != null && s.to && !s.to.startsWith('(') && scriptOf(s.to) !== s.toScript) return false;
  return true;
}
// confirmations shallower than RECHECK_DEPTH, to be checked again at this height (once per block each)
export const recheckDue = (
  sent,
  height, // (the page searches from RECHECK_DEPTH below the recorded height)
) =>
  sent.filter(
    (s) =>
      !s.pending &&
      !s.tomb &&
      !s.replaced &&
      !s.failed &&
      s.height != null &&
      height != null &&
      height - s.height + 1 < RECHECK_DEPTH &&
      s.checkedAt !== height &&
      (s.inputs ?? []).length,
  );
// the node's answer for a recent confirmation: still ours, or undone by a reorganisation (another transaction spent the coins, or none did)
export function onRecheck(sent, txid, answer, height, vouched = null) {
  const s = sent.find((x) => x.txid === txid);
  if (!s || s.pending) return [];
  // "not found" counts only from a search that reached this height; a short one is asked again at the next block
  if (!answer?.found && !(Number.isInteger(answer?.to) && height != null && answer.to >= height)) {
    delete s.checkedAt;
    return [];
  }
  s.checkedAt = height;
  // any verdict from a block above the vouched height waits (ours or a stranger's transaction): asked again later
  if (answer?.found && vouched != null && answer.height > vouched) {
    delete s.checkedAt;
    return [];
  }
  if (answer?.found && answer.txid === s.txid) {
    s.height = answer.height;
    return [];
  }
  const at = stamp(sent);
  const undo = () => {
    for (const v of sent)
      if (v.failed === s.txid || (v.replaced === s.txid && groupOf(sent, s).includes(v))) {
        v.pending = true;
        delete v.failed;
        delete v.replaced;
        delete v.height;
        if (v.wasAbandoned) v.abandoned = true;
        v.vAt = at;
      }
  };
  if (!answer?.found) {
    undo();
    for (const v of groupOf(sent, s)) {
      v.pending = true;
      delete v.height;
      delete v.replaced;
      if (v.wasAbandoned) v.abandoned = true;
      v.vAt = at;
      if (height != null) v.tip = height;
    }
    return [
      {
        notice: 'A block was undone',
        body: `the block that carried ${s.self ? 'your payment to yourself' : `your payment of ${s.sats} sat`} was replaced by the network; it is waiting for a block again`,
        bad: true,
      },
    ];
  }
  const winner = sent.find((x) => x.txid === answer.txid);
  if (winner) {
    undo();
    const fx = confirm(sent, winner, answer.height);
    return [
      { notice: 'A block was undone', body: 'the network replaced a recent block; the confirmations below are the new ones', bad: true },
      ...fx,
    ];
  }
  undo();
  for (const v of groupOf(sent, s)) {
    v.pending = false;
    v.replaced = answer.txid;
    delete v.height;
    v.vAt = at;
  }
  return [
    {
      notice: 'A block was undone',
      body: `${s.self ? 'your payment to yourself' : `your payment of ${s.sats} sat`} is no longer in the chain: its coins were spent by another transaction`,
      bad: true,
    },
  ];
}
// which payments to publish again now: waiting, from this tab (the signed transaction is here), not replaced, not refused,
// not forgotten, and not published in the last REPUBLISH_MS. Relays do not keep these events, and seeing one's own event
// in the tab's mempool proves only that a relay carried it, so this goes on until a block settles it (or this tab refuses it).
// may this record's signed transaction be handed to the relays (again)? waiting, signed here, not replaced, not refused
// anywhere (a refusal is never routed around), not forgotten. One rule for the timer, the button and the publisher.
export const publishable = (s) => !!(s && s.pending && s.hex && !s.replacedBy && !s.refused && !s.refusedNote && !s.abandoned);
// a time ahead of now came from a clock that was fast: due now, or it would wait as long as the clock was ahead
export const republishDue = (sent, now) =>
  sent.filter((s) => publishable(s) && (now - (s.lastPub ?? 0) >= REPUBLISH_MS || (s.lastPub ?? 0) > now + 60e3));
// forgetting: every waiting version of the payment is marked forgotten (their coins go first into the next payment)
export function forget(sent, s) {
  const at = stamp(sent);
  for (const o of groupOf(sent, s))
    if (o.pending) {
      o.abandoned = true;
      o.vAt = at;
    }
}
// hiding a row that never happened: a later stamp, so the hide wins over another tab's older copy
export function hide(sent, s) {
  s.hidden = true;
  s.vAt = stamp(sent);
}
// may the person forget a waiting payment (release its coins)? only when it has been waiting FORGET_AFTER blocks and no
// version of it is in the tab's mempool; the signed transaction could still be mined, which the page says
export const forgettable = (sent, s, height, inMempool) => {
  if (!s.pending || s.abandoned || height == null) return false;
  const g = groupOf(sent, s);
  const tip = Math.max(...g.map((o) => o.tip ?? height));
  return height - tip >= FORGET_AFTER && !g.some((o) => o.pending && inMempool(o.txid));
}; // measured from the newest version

// how a person should read a record now, with what they can do next
// a block at height h seen from `height` is still shallow (a reorganisation can undo it): one rule for every caller
export const shallow = (h, height) => h != null && height != null && height - h + 1 < RECHECK_DEPTH;
// under RECHECK_DEPTH a confirmation is still settling (a block can be undone): said as progress, not as a warning
export const confirmWords = (c) =>
  c < RECHECK_DEPTH ? `confirming (${c} of ${RECHECK_DEPTH})` : `${c.toLocaleString('en-US')} confirmation${c === 1 ? '' : 's'}`;
// one height the BLAKE2b chain starts at (the snapshot is the block before): nothing of this wallet is older
export const FIRST_BLAKE_HEIGHT = 150308;
export const shortTo = (to) => `${String(to).slice(0, 14)}…`;
export function stateOf(s, { inMempool, height, now, sent: sent_ = null, idle = false }) {
  if (s.failed) {
    const w = sent_ && sent_.find((x) => x.txid === s.failed);
    const wTo = w ? (w.self ? 'to yourself' : `to ${String(w.to).slice(0, 14)}…`) : '';
    // while that block is shallow it can still be undone: paying again then could pay twice
    const again = shallow(w?.height, height)
      ? `wait for ${RECHECK_DEPTH} confirmations (now ${height - w.height + 1}) before paying again`
      : 'pay again if you still mean to';
    return s.wasAbandoned
      ? `forgotten, never happened: its coins went into your payment ${wTo}; ${again}`
      : `did not happen: ${w ? `your payment ${wTo}` : 'another payment'} was mined with the same coins; ${again}`;
  }
  if (s.replaced) {
    if (s.kind === 'cancel') return 'cancel came too late: the payment went through';
    const w = sent_ && sent_.find((x) => x.txid === s.replaced);
    const settling = shallow(w?.height, height);
    const wait = settling
      ? ` (confirming ${height - w.height + 1} of ${RECHECK_DEPTH}: wait for ${RECHECK_DEPTH} before paying again)`
      : '';
    if (sent_ && !w) return 'did not happen: its coins were spent by another transaction; pay again if you still mean to';
    return w?.kind === 'cancel' ? `cancelled: the coins came back to you${wait}` : 'replaced: another version of this payment was mined';
  }
  if (!s.pending) {
    const c = height != null && s.height != null ? height - s.height + 1 : null;
    return c != null ? confirmWords(c) : 'confirmed';
  }
  if (s.abandoned) {
    const used = sent_ ? conflictsOf(sent_, s).find((x) => x.pending) : null;
    return used
      ? `forgotten: its coins went into your payment of ${used.sats} sat to ${String(used.to).slice(0, 14)}…, so only one of the two can happen`
      : 'forgotten: its coins go into your next payment, so it cannot also go through';
  }
  if (s.refused) return `not accepted, so the original stands (details: ${s.refused})`;
  if (s.refusedNote)
    return `this tab's node did not accept it, so Reef no longer announces it; cancel it to be sure it never goes through (details: ${s.refusedNote})`;
  if (s.replacedBy) {
    const w = sent_ && sent_.find((x) => x.txid === s.replacedBy);
    return w?.kind === 'cancel' ? 'being cancelled: waiting for a block' : 'replaced by a higher fee: waiting for a block';
  }
  if (idle && s.pending && !s.abandoned && !s.refused && !s.replacedBy) return 'waiting (followed in the tab that runs the node)';
  if (!s.hex)
    return inMempool(s.txid) ? 'made elsewhere with this key: waiting for a block' : 'made elsewhere with this key: not seen here now';
  if (!(s.relays ?? []).length) return 'not yet handed to a relay: retrying every 10 minutes';
  if (inMempool(s.txid))
    return height != null && s.tip != null && height - s.tip >= 3
      ? `not in a block after ${height - s.tip} blocks: raise the fee to hurry it`
      : 'waiting for a block';
  return now - (s.at ?? now) > 10 * 60e3
    ? 'no node has taken it yet: announced again every 10 minutes (the node that broadcasts payments may be down)'
    : 'handed to the relays';
}

// ---- storage: what is written never carries this tab's passing state; what is read is sorted into kept and set aside
const TRANSIENT = ['publishing', 'asked']; // fields of this tab's moment, never stored
export const forStorage = (sent) =>
  sent.map((x) => {
    const y = { ...x };
    for (const k of TRANSIENT) delete y[k];
    return y;
  });
// records read from storage: those that fail their check, or that claim to hold coins this wallet never saw, are set aside
// (quarantined, their coins still held); those set aside earlier come back when they now pass. → { keep, quarantine }
export function sortStored({ sent, quarantine = [], ok, seenHas }) {
  // a record without its transaction may claim only coins this wallet saw; one found on the chain or in the mempool with an
  // input from elsewhere (a Hitch funding with the peer's coin, say) is "at least" and needs one of ours
  const isBad = (x) =>
    !ok(x) ||
    (!x.hex && x.pending && !(x.recovered ? (x.inputs ?? []).some((k) => seenHas(k)) : (x.inputs ?? []).every((k) => seenHas(k))));
  const keep = [],
    out = [];
  for (const x of sent) (isBad(x) ? out : keep).push(x);
  for (const q of quarantine) {
    if (sent.some((y) => y.txid === q.txid && !y.pending && !y.tomb)) continue; // settled since: nothing left to hold
    const { quarantinedAt: _q, ...x } = q;
    if (!isBad(x)) {
      if (!keep.some((y) => y.txid === x.txid)) keep.push(x); // restored (once), and no longer set aside either way
    } else if (!out.some((y) => y.txid === q.txid)) out.push(q);
  }
  return { keep, quarantine: out.map((x) => ({ ...x, quarantinedAt: x.quarantinedAt ?? Date.now() })) };
}

// ---- payments found rather than made here: a coin (or a mempool transaction) that spends coins this wallet had seen, with
// no record of ours. The record was lost, or the payment was made elsewhere with this key (Hitch funds channels with it).
// What left is what went in (as far as this wallet knows its inputs) less what came back; "partial" when some inputs are
// not known, so the amount is a lower bound. One record per transaction, however many of its outputs come back.
// coins: [{ key, value, height, inputs, coinbase }]; seen: Map key → value; hitch: Set of keys Hitch held → [{ record, notice }]
export function recoverFromCoins({ coins, sent, seen, hitch = new Set(), now = Date.now() }) {
  const out = [];
  const has = (txid) => sent.some((s) => s.txid === txid) || out.some((o) => o.record.txid === txid);
  for (const c of coins) {
    const txid = c.key.slice(0, 64);
    if (c.coinbase || has(txid) || !c.inputs?.some((k) => seen.has(k))) continue;
    const back = coins.filter((x) => x.key.startsWith(txid + ':')).reduce((a, x) => a + x.value, 0);
    const known = c.inputs.filter((k) => seen.has(k));
    const inSum = known.reduce((a, k) => a + seen.get(k), 0);
    const partial = known.length < c.inputs.length;
    const viaHitch = c.inputs.some((k) => hitch.has(k));
    const sats = Math.max(0, inSum - back);
    out.push({
      record: {
        txid,
        to: viaHitch ? '(a channel funding by Hitch)' : '(recovered from the chain)',
        sats,
        fee: 0,
        change: back,
        partial,
        at: now,
        pending: false,
        height: c.height,
        inputs: c.inputs,
        tip: c.height,
        recovered: true,
      },
      notice: {
        notice: viaHitch ? 'Channel funding confirmed' : 'Payment confirmed',
        body: `${partial ? 'at least ' : ''}${sats} sat spent, in block ${c.height} (${viaHitch ? 'by Hitch, with this key' : 'recovered from the chain'})`,
      },
    });
  }
  return out;
}
// the same for a transaction in the tab's mempool: waiting, not confirmed. txs: [{ txid, inputs }]; toUs(t) → sats back to us
export function recoverFromMempool({ txs, sent, seen, hitch = new Set(), toUs, height, now = Date.now() }) {
  const out = [];
  for (const t of txs) {
    if (sent.some((x) => x.txid === t.txid) || out.some((x) => x.txid === t.txid)) continue;
    const known = t.inputs.filter((k) => seen.has(k));
    if (!known.length) continue;
    const back = toUs(t);
    out.push({
      txid: t.txid,
      to: t.inputs.some((k) => hitch.has(k)) ? '(a channel funding by Hitch)' : '(seen in the mempool)',
      sats: Math.max(0, known.reduce((a, k) => a + seen.get(k), 0) - back),
      fee: 0,
      change: back,
      partial: known.length < t.inputs.length,
      at: now,
      pending: true,
      height: null,
      inputs: t.inputs,
      tip: height,
      recovered: true,
    });
  }
  return out;
}

// payments still waiting to the same script, the newest version of each, the newest payment first; a refused replacement
// is not one (its original is). scriptOf decodes an address for records stored without their script
export function waitingTo(sent, script, scriptOf = () => null) {
  return sent
    .filter((s) => s.pending && !s.replaced && !s.replacedBy && !s.refused && (s.toScript ?? scriptOf(s.to)) === script)
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}
// payments to the same script that a cancel won, or that did not happen, while that is still shallower than RECHECK_DEPTH:
// a block undone could still let them through, so paying the address again now could pay it twice. A fee raise that
// was mined is not one of them (it did pay).
export function settlingTo(sent, script, height, scriptOf = () => null) {
  if (height == null) return [];
  return sent.filter((s) => {
    if (s.pending || s.self || (s.toScript ?? scriptOf(s.to)) !== script) return false;
    const w = s.failed ? sent.find((x) => x.txid === s.failed) : s.replaced ? sent.find((x) => x.txid === s.replaced) : null;
    if (!w || !shallow(w.height, height)) return false;
    return !!s.failed || w.kind === 'cancel';
  });
}
// ---- the records this wallet writes for what it signs: one shape, here, so what validRecord, balances and the lists later
// believe is decided in one place (and tested against signed transactions in test/wallet-test.mjs)
// a payment: plan from wallet.plan; { to, toScript, self, all } as read from the form
export function paymentRecord(p, { txid, hex, to, toScript, self = false, all = false, tip, now = Date.now() }) {
  return {
    txid,
    to,
    toScript,
    sats: p.amount,
    fee: p.fee,
    change: p.change,
    all,
    self,
    at: now,
    hex,
    inputs: p.picked.map((c) => c.key),
    values: p.picked.map((c) => c.value),
    tip,
    pending: true,
    kind: 'payment',
    relays: [],
  };
}
// a replacement of `s` (a higher fee, or a cancel paying the coins back to this wallet): pr from wallet.planReplace
export function replacementRecord(s, pr, { cancel, txid, hex, address, script, tip, now = Date.now() }) {
  return {
    txid,
    to: cancel ? address : s.to,
    toScript: cancel ? script : s.toScript,
    sats: cancel ? 0 : pr.amount,
    fee: pr.fee,
    change: cancel ? pr.amount : pr.change,
    all: s.all,
    at: now,
    hex,
    inputs: s.inputs,
    values: s.values,
    tip,
    pending: true,
    kind: cancel ? 'cancel' : 'payment',
    replaces: s.txid,
    self: cancel || !!s.self,
    relays: [],
  };
}
