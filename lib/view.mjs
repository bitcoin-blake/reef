// What the wallet's lists show, decided without the page: for each history row its icon, its state in words, whether it is
// struck through and why, the amount to show, and which actions it offers. The page only turns this into markup; the
// decisions are tested (test/view-test.mjs).
import * as S from './state.mjs';

const recordOf = (sent, r) => (r.kind === 'out' ? sent.find((x) => x.txid === r.txid) : null);
const count = (c) => S.confirmWords(c);

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
          ? count(r.conf)
          : 'confirmed';
  const struck = !!(s?.replaced || s?.failed || s?.abandoned);
  const icon =
    s?.replaced || s?.failed ? '✕' : s?.abandoned ? '⊘' : r.pending ? '⏳' : r.label === 'Mined' ? '⛏' : r.kind === 'in' ? '⬇' : '⬆';
  const tag = s?.failed
    ? 'did not happen'
    : s?.replaced
      ? s.kind === 'cancel'
        ? 'too late'
        : ctx.sent.find((x) => x.txid === s.replaced)?.kind === 'cancel'
          ? 'cancelled'
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
  // a cancel waiting is raised as a cancel (a higher fee back to yourself); it has nothing to cancel itself
  if (live && !s.abandoned) out.push('bump');
  if (live && !s.abandoned && !s.refusedNote) out.push('again'); // refused here: never announced again
  if (live && s.kind !== 'cancel' && s.values && !(s.abandoned && S.conflictsOf(ctx.sent, s).some((x) => x.pending))) out.push('cancel');
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
  const from = sent.find((s) => c.key.startsWith(s.txid + ':'));
  if (from) parts.push(from.self && c.value === from.sats ? 'paid to yourself' : 'change');
  if (hitch.has(c.key)) parts.push('reserved by Hitch');
  else if (quarantine.has(c.key)) parts.push('held: a payment record Reef could not verify');
  else if (held.has(c.key)) parts.push('held by a waiting payment');
  else if (first.has(c.key)) parts.push("a forgotten payment's: spent first");
  return parts.map((p) => ` (${p})`).join('');
}

// an address shortened for a list, start and end kept (the parts people compare); the full one goes in a title
export const shortAddr = (a) => {
  const s = String(a ?? '');
  return s.length > 22 ? `${s.slice(0, 10)}…${s.slice(-7)}` : s;
};
// an address in groups of four, for reading it against another copy
export const grouped = (a) => String(a ?? '').replace(/(.{4})(?=.)/g, '$1 ');
// the Overview's recent list: what happened, newest first; versions that did not happen stay on the Transactions page
export const recentRows = (rows, views, max = 6) => rows.filter((r) => !views.get(r)?.struck).slice(0, max);
// what the recent list says when it has nothing to show
export const recentEmpty = ({ known, idle, any = false }) =>
  idle
    ? 'shown in the tab that runs the node'
    : !known
      ? 'waiting for the node'
      : any
        ? 'nothing settled yet: see Transactions'
        : 'no coins yet';
// the words of a recent row: a payment to yourself needs no address; others show the short address
export const recentLabel = (r) => (r.label === 'Payment to yourself' || r.kind === 'in' ? r.label : `${r.label} ${shortAddr(r.addr)}`);
// one line of the CSV export: the same state words as the lists; the amount is what the history counts (0 for a version
// that did not happen); a text cell that a spreadsheet would run as a formula is quoted with a leading apostrophe
export function exportRow(r, ctx) {
  const v = viewRow(r, { ...ctx, canAct: false });
  const cells = [
    r.at ? new Date(r.at).toISOString() : '',
    r.height ?? '',
    v.state + (v.tag ? ` (${v.tag})` : ''),
    r.label,
    r.addr ?? '',
    r.sats,
    r.txid,
  ];
  return cells
    .map((x) => (typeof x === 'string' && /^[=+@\t\r-]/.test(x) ? `'${x}` : x))
    .map((x) => `"${String(x).replace(/"/g, '""')}"`)
    .join(',');
}
export const EXPORT_HEAD = 'date,block,status,type,address,amount_sat,txid';
