// The chain status: what the block source, the signed chain tip and the clock together vouch for. 'bad' stops sending.
import * as T from '../lib/trust.mjs';
let ok = 0,
  bad = 0;
const t = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`);
  cond ? ok++ : bad++;
};
const NOW = 1_800_000_000_000;
const base = { synced: true, height: 152100, time: NOW / 1000 - 600, lastSync: NOW - 20e3 };
const tip = (o = {}) => ({ height: 152100, agree: 3, diverged: false, live: true, created_at: NOW / 1000 - 600, ...o });
const L = (o, tipo) => T.trustOf({ ...base, ...o, nostr: tipo === undefined ? tip() : tipo }, NOW);
t(
  'an idle tab and a syncing one say so',
  T.trustOf({ idle: true }, NOW).level === 'idle' && T.trustOf({ synced: false }, NOW).level === 'sync',
);
t('in step with an agreeing signed tip: ok', L({}).level === 'ok');
t(
  'a signed tip that disagrees stops everything',
  L({}, tip({ diverged: true })).level === 'bad' && /DISAGREES/.test(L({}, tip({ diverged: true })).text),
);
t(
  'a disagreement outranks every other state (even a stalled source)',
  L({ lastSync: NOW - 600e3 }, tip({ diverged: true })).level === 'bad',
);
t(
  'the source silent for over three minutes warns',
  L({ lastSync: NOW - 181e3 }).level === 'warn' && L({ lastSync: NOW - 179e3 }).level === 'ok',
);
t('...unless the node already reports an error (said elsewhere)', L({ lastSync: NOW - 181e3, error: 'x' }).level !== 'warn');
t(
  'no new block for over 90 minutes warns, unless the signed tip is ahead (the source is behind, said separately)',
  L({ time: NOW / 1000 - 5401 }).level === 'warn' && L({ time: NOW / 1000 - 5399 }).level === 'ok',
);
t('no signed tip at all: up to date, quietly', L({}, null).level === 'none' && /usually harmless/.test(L({}, null).text));
t(
  'the tab more than two blocks behind the signed tip warns',
  L({}, tip({ height: 152103 })).level === 'warn' && L({}, tip({ height: 152102, agree: 0 })).level !== 'warn',
);
t(
  'a live tip trailing the source by two blocks warns: those blocks are not vouched for',
  L({}, tip({ height: 152098 })).level === 'warn' && /not yet vouched for/.test(L({}, tip({ height: 152098 })).text),
);
t(
  '...a stale (not live, old) tip trailing is said quietly',
  L({}, tip({ height: 152098, live: false, created_at: NOW / 1000 - 7200 })).level === 'none',
);
t(
  'a tip not refreshed for three hours is said quietly',
  /not been refreshed/.test(L({}, tip({ height: 152099, live: false, created_at: NOW / 1000 - 3 * 3600 - 1 })).text),
);
t('a tip not yet checked against these blocks is not ok', L({}, tip({ agree: 0 })).level === 'none');
t(
  'one block above an agreeing tip: not "matching", the newest block not yet vouched for',
  L({}, tip({ height: 152099 })).level === 'none' && /not yet vouched/.test(L({}, tip({ height: 152099 })).text),
);
t(
  'the vouched-for height is the tip only when it agrees',
  T.signedHeight(tip()) === 152100 &&
    T.signedHeight(tip({ agree: 0 })) === null &&
    T.signedHeight(tip({ diverged: true })) === null &&
    T.signedHeight(null) === null,
);
t('durations read in minutes, hours, days', T.ago(600) === '10 minutes' && T.ago(7200) === '2 hours' && T.ago(3 * 86400) === '3 days');
t(
  'no signed tip two minutes after being up to date warns',
  T.trustOf({ ...base, nostr: null, syncedAt: NOW - 121e3 }, NOW).level === 'warn' &&
    T.trustOf({ ...base, nostr: null, syncedAt: NOW - 60e3 }, NOW).level === 'none',
);
t('vouched: an agreeing tip vouches up to its height', T.vouchedHeight(tip(), null, 150307) === 152100);
t(
  'vouched: a tip that does not cover these blocks keeps the last vouched height, never "no limit"',
  T.vouchedHeight(tip({ agree: 0 }), 152090, 150307) === 152090 && T.vouchedHeight(tip({ agree: 0 }), null, 150307) === 150307,
);
t('vouched: a disagreeing tip holds to the last vouched height', T.vouchedHeight(tip({ diverged: true }), 152090, 150307) === 152090);
t('vouched: no tip at all is no limit (said as a warning elsewhere)', T.vouchedHeight(null, 152090, 150307) === null);
t('vouched: a lower agreeing tip does not lower the bar', T.vouchedHeight(tip({ height: 152080 }), 152090, 150307) === 152090);
// round 11: the boundaries the mutants slipped past
t(
  'an unresponsive node is a warning that reaches the confirm dialog, a disagreement still outranks it',
  L({ unresponsive: true }).level === 'warn' && L({ unresponsive: true }, tip({ diverged: true })).level === 'bad',
);
t('the source quiet exactly three minutes is not yet a warning', L({ lastSync: NOW - 180e3 }).level === 'ok');
t(
  'no new block for exactly 90 minutes is not yet a warning, and the tip being ahead keeps it quiet',
  L({ time: NOW / 1000 - 5400 }).level === 'ok' && L({ time: NOW / 1000 - 6000 }, tip({ height: 152101 })).level !== 'warn',
);
t(
  'two blocks behind the tip is not yet "behind"; three is',
  L({}, tip({ height: 152102 })).level !== 'warn' && L({}, tip({ height: 152103 })).level === 'warn',
);
t(
  'a tip trailing by two: recent by its time (not live) still warns',
  L({}, tip({ height: 152098, live: false, created_at: NOW / 1000 - 600 })).level === 'warn',
);
t('a tip trailing by exactly one is not a "trailing" warning', L({}, tip({ height: 152099, live: true })).level !== 'warn');
t(
  'a tip three hours old but at the same height as the tab is not "not refreshed"',
  !/not been refreshed/.test(L({}, tip({ live: false, created_at: NOW / 1000 - 4 * 3600 })).text),
);
t('no tip at exactly two minutes is still quiet', T.trustOf({ ...base, nostr: null, syncedAt: NOW - 120e3 }, NOW).level === 'none');
t(
  "vouched: the node's own vouchedTo wins over the page's record, even when lower (a disagreement caps it)",
  T.vouchedHeight(tip({ vouchedTo: 152095 }), 152100, 150307) === 152095 &&
    T.vouchedHeight(tip({ vouchedTo: 152101, diverged: true }), 152090, 150307) === 152101,
);
t("vouched: without vouchedTo the page's record is the fallback", T.vouchedHeight(tip({ agree: 0 }), 152090, 150307) === 152090);
console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
