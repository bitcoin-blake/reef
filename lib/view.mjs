// What the wallet's lists show, decided without the page: for each history row its icon, its state in words, whether it is
// struck through and why, the amount to show, and which actions it offers. The page only turns this into markup; the
// decisions are tested (test/view-test.mjs).
import * as S from './state.mjs';

const recordOf = (sent, r) => (r.kind === 'out' ? sent.find((x) => x.txid === r.txid) : null);
const count = (c, depth) => `${c} confirmation${c === 1 ? '' : 's'}${c < depth ? ' (a block can still be undone)' : ''}`;

// one history row → { icon, state, short, struck, tag, sats, block, actions }
// ctx: { sent, inMempool, height, now, idle, canAct, fmtCount? }
export function viewRow(r, ctx) {
  const s = recordOf(ctx.sent, r);
  const state = s
    ? S.stateOf(s, { inMempool: ctx.inMempool, height: ctx.height, now: ctx.now, sent: ctx.sent, idle: ctx.idle })
    : r.pending
      ? 'unconfirmed'
      : r.immature
        ? 'mined, spendable after 100 blocks'
        : r.conf != null
          ? count(r.conf, S.RECHECK_DEPTH)
          : 'confirmed';
  const struck = !!(s?.replaced || s?.failed || s?.abandoned);
  const icon =
    s?.replaced || s?.failed ? '✕' : s?.abandoned ? '⊘' : r.pending ? '⏳' : r.label === 'Mined' ? '⛏' : r.kind === 'in' ? '⬇' : '⬆';
  const tag = s?.failed
    ? 'did not happen'
    : s?.replaced
      ? s.kind === 'cancel'
        ? 'too late'
        : 'replaced'
      : s?.abandoned
        ? 'forgotten'
        : '';
  // a version that did not happen shows what it would have cost, struck through; the history's own figure is 0 for it
  const sats = struck ? -((s.self ? 0 : s.sats) + s.fee) : r.sats;
  const block = r.height && !s?.replaced && !s?.failed ? r.height : null;
  return {
    txid: r.txid,
    icon,
    state,
    short: block ? null : struck ? '' : state.split(':')[0],
    struck,
    tag,
    sats,
    block,
    actions: actionsFor(s, ctx),
  };
}

// what a person may do with a payment record from this tab, in this state
export function actionsFor(s, ctx) {
  if (!s || !ctx.canAct) return [];
  const out = [];
  const live = s.pending && s.hex && !s.replacedBy && !s.refused;
  if (live && !s.abandoned) out.push('bump', 'again');
  if (live && s.values && !(s.abandoned && S.conflictsOf(ctx.sent, s).some((x) => x.pending))) out.push('cancel');
  if (S.forgettable(ctx.sent, s, ctx.height, ctx.inMempool)) out.push('forget');
  if (!s.pending && (s.replaced || s.failed || s.recovered)) out.push('hide');
  return out;
}

// the Transactions page's filter: by kind and by text in the txid or the address
export function filterRows(rows, { type = 'all', query = '', sent = [] } = {}) {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    const s = recordOf(sent, r);
    const kindOk =
      type === 'all' ||
      (type === 'in' && r.kind === 'in' && r.label !== 'Mined') ||
      (type === 'out' && r.kind === 'out') ||
      (type === 'mined' && r.label === 'Mined') ||
      (type === 'pending' && r.pending && !s?.abandoned);
    return kindOk && (!q || r.txid.includes(q) || String(r.addr).toLowerCase().includes(q));
  });
}

// what a coin on the Receive page is doing, in words
export function coinNote(c, { height, sent, hitch = new Set(), quarantine = new Set(), held = new Set(), first = new Set(), mature }) {
  const parts = [];
  if (c.coinbase && !mature(c, height)) parts.push('mined, spendable after 100');
  if (sent.some((s) => c.key.startsWith(s.txid + ':'))) parts.push('change');
  if (hitch.has(c.key)) parts.push('reserved by Hitch');
  else if (quarantine.has(c.key)) parts.push('held by a set-aside record');
  else if (held.has(c.key)) parts.push('held by a waiting payment');
  else if (first.has(c.key)) parts.push("a forgotten payment's: spent first");
  return parts.map((p) => ` (${p})`).join('');
}
