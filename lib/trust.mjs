// How far the chain the tab follows is vouched for by someone other than its block source: the signed chain tip (NIP-333),
// the age of the newest block, how lately the source answered. Pure: the page passes what the node reports, and the
// level decides what the page allows ('bad' stops sending) and says. Tested in test/trust-test.mjs.
const n = (x) => Number(x).toLocaleString('en-US');
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const ago = (sec) =>
  sec < 5400 ? `${Math.round(sec / 60)} minutes` : sec < 172800 ? `${Math.round(sec / 3600)} hours` : `${Math.round(sec / 86400)} days`;
export function trustOf(
  {
    idle = false,
    synced = false,
    nostr: t = null,
    time = null,
    lastSync = null,
    height = null,
    error = null,
    syncedAt = null,
    unresponsive = false,
  } = {},
  nowMs = Date.now(),
) {
  if (idle) return { level: 'idle', text: 'idle: the node runs in another tab of this browser' };
  if (!synced) return { level: 'sync', text: 'syncing: the balance is known once the tab is up to date' };
  const now = nowMs / 1000;
  // a source that stopped without an error looks "up to date" at an old height: the newest block's own time says otherwise
  const quiet = time ? now - time : 0;
  // a node that has not answered lately: the balance and coins shown may be out of date (said before sending too)
  if (unresponsive && !t?.diverged)
    return { level: 'warn', text: 'the node has not answered for two minutes: the balance and coins shown may be out of date' };
  if (t?.diverged)
    return {
      level: 'bad',
      text: `the block source DISAGREES with the signed chain tip at ${n(t.height)}: do not trust the balance or confirmations until this clears`,
    };
  if (lastSync && nowMs - lastSync > 180e3 && !error)
    return {
      level: 'warn',
      text: `the node has not heard from the block source since ${clock(lastSync)}: balances are as of block ${n(height)}`,
    };
  if (quiet > 5400 && !(t && t.height > height))
    return {
      level: 'warn',
      text: `no new block for ${ago(quiet)} (the last is ${n(height)}): the block source or the chain may have stopped, so a payment made now waits until blocks come again`,
    };
  // no signed tip after two minutes up to date: every block is the block source's word alone, and that is said
  if (!t && syncedAt && nowMs - syncedAt > 120e3)
    return {
      level: 'warn',
      text: `no signed chain tip has reached this browser (its relays may be blocked here): blocks up to ${n(height)} are the block source's word alone, so a payment received may not be real until one does`,
    };
  if (!t)
    return {
      level: 'none',
      text: `Up to date (block ${n(height)}). Reef could not get a second, independent check of the latest block (a signed chain tip); this is usually harmless.`,
    };
  if (t.height > height + 2)
    return {
      level: 'warn',
      text: `the tab is ${n(t.height - height)} blocks behind the signed chain tip (${n(t.height)}): the block source may be stale`,
    };
  if (t.created_at && now - t.created_at > 3 * 3600 && t.height < height)
    return {
      level: 'none',
      text: `Up to date (block ${n(height)}). The signed chain tip that double-checks it has not been refreshed for ${ago(now - t.created_at)}; its publisher may be down. This is usually harmless.`,
    };
  // a live signed tip should not trail the block source by two blocks: if it does, those blocks are the source's word alone
  if (t.height < height - 1 && (t.live || (t.created_at && now - t.created_at < 1800)))
    return {
      level: 'warn',
      text: `the block source is ${n(height - t.height)} blocks ahead of the signed chain tip (${n(t.height)}): those blocks, and payments in them, are not yet vouched for`,
    };
  if (t.height < height - 1)
    return {
      level: 'none',
      text: `up to date with the block source at ${n(height)}; the latest signed chain tip reaching this browser is older (${n(t.height)}), so the last ${n(height - t.height)} blocks are confirmed by the block source alone`,
    };
  if (!(t.agree > 0))
    return {
      level: 'none',
      text: `Up to date (block ${n(height)}). The signed chain tip has not been checked against these blocks yet.`,
    };
  if (t.height < height)
    return {
      level: 'none',
      text: `Up to date (block ${n(height)}). The newest block is not yet vouched for by the signed chain tip (at ${n(t.height)}).`,
    };
  return { level: 'ok', text: `up to date: block ${n(height)}, matching the signed chain tip` };
}

// the height up to which confirmations are vouched for by the signed tip (null when there is no agreeing tip)
export const signedHeight = (t) => (t && t.agree > 0 && !t.diverged ? t.height : null);
// the height to count confirmations and money up to. With an agreeing tip, the tip. With a tip that does not vouch for
// these blocks (they lie outside its headers, or it disagrees with them), never "no limit": the last height a tip did vouch
// for (lastGood), else the snapshot base, so a block source cannot raise it by serving blocks the tip does not cover.
// With no tip at all (not yet, or relays blocked), the same: the last vouched height, else the snapshot base; money above
// it waits as pending until a tip vouches for it (the chain status says why).
export const vouchedHeight = (t, lastGood = null, baseHeight = null) => {
  // the node's own record (the highest applied height ever matched to signed headers, capped at a disagreement) wins
  if (t && Number.isInteger(t.vouchedTo)) return t.vouchedTo;
  const h = signedHeight(t);
  if (h != null) return lastGood != null ? Math.max(h, lastGood) : h;
  return lastGood ?? baseHeight;
};
