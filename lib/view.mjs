// What the wallet's lists show, decided without the page: for each history row its icon, its state in words, whether it is
// struck through and why, the amount to show, and which actions it offers. The page only turns this into markup; the
// decisions are tested (test/view-test.mjs).
import * as S from './state.mjs';

// money in a block above the vouched height, said one way everywhere (the lists, the balance line, notices): the full
// words and the few a list has room for
export const ABOVE_TIP = 'the signed chain tip has not reached';
export const ABOVE_TIP_SHORT = 'waiting for the signed chain tip';
// a row whose address is this wallet's own (money in, or a payment to oneself): shown and searched as "your address"
export const isOwnAddressRow = (r) => r.kind === 'in' || r.label === 'Payment to yourself';
const recordOf = (sent, r) => (r.kind === 'out' ? sent.find((x) => x.txid === r.txid) : null);
const count = (c) => S.confirmWords(c);
// the few words a list has room for: the state before its explanation, and never a cut-off "(details"
const shortState = (s, state) =>
  s?.refusedNote ? 'not accepted here' : s?.refused ? 'higher fee not accepted' : state.replace(/\s*\(details:.*$/, '').split(':')[0];

// one history row → { icon, state, short, struck, tag, sats, block, actions }
// ctx: { sent, inMempool, height, now, idle, canAct, vouched?, tipStale? }
export function viewRow(r, ctx) {
  const s = recordOf(ctx.sent, r);
  let state = s
    ? S.stateOf(s, { inMempool: ctx.inMempool, height: ctx.height, now: ctx.now, sent: ctx.sent, idle: ctx.idle })
    : r.pending
      ? 'unconfirmed'
      : r.immature
        ? 'mined, spendable after 100 blocks'
        : r.conf != null
          ? count(r.conf)
          : 'confirmed';
  const struck = !!(s?.replaced || s?.failed || s?.abandoned);
  // a block above the vouched height (ctx.vouched) is vouched for by the block source alone: not counted as confirmations
  // yet. "Usually within a block" only while the signed chain tip is moving (ctx.tipStale: it has not for a while)
  const unvouched = !struck && r.height != null && ctx.vouched != null && r.height > ctx.vouched;
  if (unvouched)
    state = `in block ${r.height.toLocaleString('en-US')}, which ${ABOVE_TIP} yet — ${
      ctx.tipStale ? 'the tip has not moved for a while, so this can take longer' : 'usually within a block'
    }`;
  const icon =
    s?.replaced || s?.failed ? '✕' : s?.abandoned ? '⊘' : r.pending ? '⏳' : r.label === 'Mined' ? '⛏' : r.kind === 'in' ? '⬇' : '⬆';
  const tag = s?.failed
    ? 'did not happen'
    : s?.replaced
      ? s.kind === 'cancel'
        ? 'too late'
        : !ctx.sent.some((x) => x.txid === s.replaced)
          ? 'did not happen'
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
    short: struck ? tag : unvouched ? ABOVE_TIP_SHORT : shortState(s, state), // the same few words on the Overview and on Transactions
    struck,
    tag,
    sats,
    block,
    actions: actionsFor(s, ctx),
  };
}

// a payment to yourself moves nothing but its fee: its amount is marked "(fee)" wherever it is listed, so it never reads as
// money lost (a struck one shows what it would have cost instead)
export const feeOnly = (r, v) => r.label === 'Payment to yourself' && !v.struck;

// what a person may do with a payment record from this tab, in this state
function actionsFor(s, ctx) {
  if (!s || !ctx.canAct) return [];
  const out = [];
  const live = s.pending && s.hex && !s.replacedBy && !s.refused;
  // a cancel waiting is raised as a cancel (a higher fee back to yourself); it has nothing to cancel itself
  if (live && !s.abandoned) out.push('bump');
  if (S.publishable(s)) out.push('again'); // refused here: never announced again
  if (live && s.kind !== 'cancel' && s.values && !(s.abandoned && S.conflictsOf(ctx.sent, s).some((x) => x.pending))) out.push('cancel');
  if (S.forgettable(ctx.sent, s, ctx.height, ctx.inMempool)) out.push('forget');
  if (!s.pending && (s.replaced || s.failed || s.recovered)) out.push('hide');
  return out;
}

// the Transactions page's filter: by kind, and by text in anything the row shows: the txid, the address, the label, the
// status and its tag, and the amount (shown(r): the page's own words and figures for the row, in the display unit and in sat)
export function filterRows(rows, { type = 'all', query = '', sent = [], shown: shownOf = () => '' } = {}) {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    const s = recordOf(sent, r);
    const kindOk =
      type === 'all' ||
      (type === 'in' && r.kind === 'in' && r.label !== 'Mined') ||
      (type === 'out' && r.kind === 'out') ||
      (type === 'mined' && r.label === 'Mined') ||
      (type === 'pending' && r.pending && !s?.abandoned);
    // what the list shows is searchable too: the label, and "your address" for money to this wallet
    const shown = `${r.label} ${isOwnAddressRow(r) ? 'your address' : ''} ${shownOf(r)}`.toLowerCase();
    return kindOk && (!q || r.txid.includes(q) || String(r.addr).toLowerCase().includes(q) || shown.includes(q));
  });
}

// what a coin on the Receive page is doing, in words
export function coinNote(
  c,
  { height, sent, hitch = new Set(), quarantine = new Set(), held = new Set(), above = new Set(), first = new Set(), mature },
) {
  const parts = [];
  if (c.coinbase && !mature(c, height)) parts.push('mined, spendable after 100');
  const from = sent.find((s) => c.key.startsWith(s.txid + ':'));
  if (from) parts.push(from.self && c.value === from.sats ? 'paid to yourself' : 'change');
  if (hitch.has(c.key)) parts.push('reserved by Hitch');
  else if (quarantine.has(c.key)) parts.push('held: a payment record Reef could not verify');
  else if (above.has(c.key))
    parts.push(ABOVE_TIP_SHORT); // said the same way as on the Overview and Transactions
  else if (held.has(c.key)) parts.push('held by a waiting payment');
  else if (first.has(c.key)) parts.push("a forgotten payment's: spent first");
  return parts.map((p) => ` (${p})`).join('');
}

// an address shortened for a list, start and end kept (the parts people compare); the full one goes in a title
export const shortAddr = S.shortAddr;
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
export const recentLabel = (r) => (isOwnAddressRow(r) ? r.label : `${r.label} ${shortAddr(r.addr)}`);
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

// the confirm dialog of a payment, line by line: what goes where, what it costs, and the warnings in order of weight.
// money(sats) formats an amount; trustWarn is the chain-status sentence when it is a warning; reuse the forgotten-coin note;
// waitingSame the payments still waiting to the same address
export function confirmLines({
  to,
  self = false,
  all = false,
  rate,
  p,
  money,
  trustWarn = null,
  reuse = '',
  waitingSame = [],
  settlingSame = [],
  suggested = null, // the rate payments waiting now pay (the tab's mempool), when enough are waiting to say
  allAmount = null, // what Send everything would pay the recipient, when this payment leaves a leftover
}) {
  const base = Math.ceil(rate * p.vsize);
  const leftover = !all && !p.change && p.fee > base ? p.fee - base : 0;
  const lines = [
    `To: ${grouped(to)}${self ? ' (your own address)' : ''}`,
    ...(self ? [] : [`Check the start (${to.slice(0, 8)}) and the end (${to.slice(-6)}) against where you got the address.`]),
    `Amount: ${money(p.amount)}${all ? ' (everything spendable, after the fee)' : ''}`,
    leftover
      ? `Fee: ${money(p.fee)} — ${money(base)} (${p.vsize} vB at ${rate} sat/vB) + ${money(leftover)} leftover`
      : `Fee: ${money(p.fee)} — ${p.vsize} vB at ${rate} sat/vB`,
    // a leftover under 330 sat cannot come back as change (nobody could spend it): it is added to the fee, and said
    ...(leftover
      ? [
          `${money(leftover)} of that fee is a leftover too small to come back as change.` +
            (allAmount != null ? ` This empties the wallet; Send everything would pay the recipient ${money(allAmount)} instead.` : ''),
        ]
      : []),
    self
      ? `Only the fee leaves the wallet; ${money(p.amount + (p.change ?? 0))} comes back to you.`
      : `Total leaving the wallet: ${money(p.amount + p.fee)}${p.change ? `; ${money(p.change)} comes back as change` : ''}`,
    'It is signed here and handed to relays for a node to broadcast. Until a block takes it, it can be replaced with a higher fee or cancelled.',
  ];
  const at = self ? 3 : 4; // the warnings about the fee go right after the fee line
  if (trustWarn) lines.push(`${trustWarn}: the coins may already be spent on the real chain, and this payment may never confirm.`);
  // a high rate is said against what payments waiting now pay (or 1 sat/vB when the tab cannot tell)
  if (rate >= 10 && !(suggested && rate <= suggested))
    lines.splice(
      at,
      0,
      `This fee rate (${rate} sat/vB) is much higher than ${suggested ? `payments waiting now pay (about ${suggested} sat/vB)` : 'txbt4 blocks need today (1 sat/vB)'}. Choose Back, then Change… next to the fee, unless you mean it.`,
    );
  if (p.fee > p.amount)
    lines.splice(at, 0, `The fee is more than the amount: even a small payment costs about ${money(base)} at this rate.`);
  else if (p.fee > 100000) lines.splice(at, 0, 'The fee is high: check the rate (Back, then Change… next to the fee).');
  if (reuse && !waitingSame.some((x) => x.abandoned)) lines.push(reuse);
  // a payment to this address that was cancelled, or did not happen, only a few blocks ago: a block can still be undone
  if (settlingSame.length)
    lines.unshift(
      `A payment of ${money(settlingSame[0].sats)} to this address was cancelled or did not happen only recently. If that block is undone, both could go through: waiting until it has 6 confirmations is safer.`,
    );
  const first = waitingSame[0];
  if (first) {
    const shares = p.picked.some((c) => (first.inputs ?? []).includes(c.key));
    lines.unshift(
      first.abandoned && shares
        ? `A payment of ${money(first.sats)} to this address was forgotten. This payment spends one of its coins, so only one of the two can ever go through.`
        : first.abandoned
          ? `A payment of ${money(first.sats)} to this address was forgotten but may still be mined, and this payment does not spend its coins: this would be a second payment.`
          : `A payment of ${money(first.sats)} to this address is still waiting. This would be a second, separate payment.`,
    );
  }
  return lines;
}

// why nothing can be spent, from the balance's parts (b as from wallet.balances; incoming: unconfirmed to us); money(sats)
export function noCoinsWhy(b, { incoming = 0, money }) {
  const parts = [];
  if (b.immature) parts.push(`${money(b.immature)} is mined coins, spendable after 100 blocks`);
  if (incoming) parts.push(`${money(incoming)} is on its way to you and can be spent once a block includes it`);
  if (b.unvouched) parts.push(`${money(b.unvouched)} is in blocks ${ABOVE_TIP} yet`);
  if (b.outgoing || b.returning > 0) parts.push('some is held by a payment of yours still waiting (see Transactions)');
  if (b.elsewhere) parts.push(`${money(b.elsewhere)} is reserved by Hitch or by a payment record Reef could not verify`);
  return parts.length ? `Nothing can be spent right now: ${parts.join('; ')}.` : 'No coins yet: your address is on the Receive page.';
}
// the line under the balance: what is leaving, in blocks above the signed chain tip, reserved elsewhere and by what
export function reservedText(b, { hitch = false, quarantine = false, money }) {
  return [
    b.outgoing ? `${money(b.outgoing)} leaving in payments not yet confirmed` : '',
    b.unvouched ? `${money(b.unvouched)} in blocks ${ABOVE_TIP} yet` : '',
    b.elsewhere
      ? `${money(b.elsewhere)} reserved elsewhere: ${[hitch ? 'a Hitch channel funding (to release it, close Reef, open Hitch and cancel the funding there)' : '', quarantine ? 'a payment record Reef could not verify (see the notice above)' : ''].filter(Boolean).join('; ')}`
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
