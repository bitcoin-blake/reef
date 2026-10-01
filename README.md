# Reef

**A Knots-style Bitcoin node and wallet in a browser tab.** The familiar window: Overview, Send, Receive, Transactions, and the Node window with its Information, Console, Network Traffic and Peers tabs.

Live: https://bitcoin-blake.github.io/reef/

## Status: node and wallet are real; test coins only

The page runs [blaketestnode](https://github.com/bitcoin-blake/blaketestnode)'s browser node: its worker, pinned by commit and loaded from the CDN, fetches the fork-point UTXO snapshot (830 MB, 14.2 million coins) into the tab's private file system, checks its sha256, recomputes `hash_serialized_3`, builds a txid index, then validates every BLAKE2b block since the fork from a mirror and keeps following the chain tip. A first visit asks before it downloads anything and says how much space the browser allows; errors are said in words with Retry and Wipe; only one tab of a browser runs the node, for Reef, Bight, Winch and Hitch together (a second tab stays idle, read-only, and takes over when the other closes; Bight, Winch and Hitch load the same node pin and share the lock). The status bar shows each phase with a progress bar and an estimate, and whether the chain the tab follows matches the signed chain tip (NIP-333) published for txbt4: a disagreement, or a tab far behind, is shown at the top of the window.

**The wallet** is one key made in the tab and kept in this browser. Reef asks you to back it up before it holds anything, and insists once it does: Settings → Back up the wallet key shows it as a WIF and as a `rawtr()` descriptor (the address is the key's own output, not a BIP 86 `tr()` address), copies it, or saves it as a file. Options → Wallet switches to another key (hex or WIF) after a confirmation, keeping the previous one in the browser's list of earlier keys. The balance is read from the tab's own validated UTXO set (coins created since the snapshot) and is shown as unknown until the node has answered, never as a zero it does not know. Available, Pending (unconfirmed incoming and the change of your payments not yet in a block) and Immature (mined coins under 100 confirmations) add up to the Total; payments on their way out are listed below it.

**Sending**: the Send page shows the fee, the total and the change as you type; amounts are read exactly (no floating point), in tBTC, mtBTC or sat; addresses of other networks, typos and outputs nobody could spend are refused with the reason; *Send everything* spends every spendable coin with the fee computed from the real size. Send asks for confirmation with every figure, then builds, signs and checks the transaction against the chain's script rules in the tab, holds its coins, and hands it to relays (a Nostr kind 23503 event) for a node that serves txbt4 to broadcast. Until a block carries it, the Transactions page shows it as waiting, publishes it again every few minutes, and offers *Raise the fee* and *Cancel* (both replace it, BIP 125) and *Publish again*; a payment that has waited six blocks and is nowhere to be seen is offered a *Cancel* first and, failing that, can be *forgotten*: its coins then go first into your next payment, so the two can never both go through. A refusal by this tab's node counts only for the exact bytes Reef signed (a copy with a broken signature has the same txid): an original stays held and published, since another node may take it; a refused replacement is let go and the original stands. Stored payment records are checked against their own transaction when read. Until a block says which version of a replaced payment won, the balance assumes the worse one. A replacement the network's rules refuse is reported and the original stands. A payment counts as confirmed only when its own transaction is seen in a block; if its coins are spent by another transaction, it says so.

**History**: every transaction that paid the wallet is kept, also after its coins are spent, so the list adds up; the Transactions page filters by kind, searches, and exports CSV. Notices (in the page, and as browser notifications when allowed) announce a payment received, on its way, confirmed, replaced or not made.

**The tab's mempool**: once up to date the tab follows kind 23404 events (a node on the estate publishing its mempool) and kind 23503 events, validates each transaction against its own UTXO set, and never relays one onward; the Node window has a Mempool tab and the console answers `getmempoolinfo`, `getrawmempool` and `getmempoolentry`. What a tab does not do: scan the snapshot for a script, so coins from before block 150,307 are not seen.

**Safety of the page**: every string from outside (relays, the mempool, the chain, links, options) reaches the page as text, never as markup; a Content Security Policy allows scripts only from this site and the exact pinned paths on the CDN (the node, the two library commits and the engine by commit, the QR library and WebTorrent by version; a test checks the policy names the pins the page loads); the QR library also carries an integrity hash. A link cannot change where Reef reads the chain from: `?snapshot=` and `?blocks=` are offered in a banner, used for that visit only if you agree, and never stored. Help → Copy diagnostics puts a report without the key on the clipboard for an issue. A newer Reef is announced in a banner; nothing reloads by itself.

**Inside Glass** (or any host page) the browser gives Reef separate storage: a different key and a second copy of the snapshot. The page says so and offers to open Reef in its own tab.

The rest as before: Options for the fee rate, relays, units and value masking; *Snapshot over WebTorrent* and *Seed the snapshot* on the Network tab; closing or minimizing the window keeps the node running while the tab is open and leaves a tray card (Ctrl+M brings the window back). The menus, tabs, dialogs and tray work from the keyboard; the page follows the system's dark mode and fits a phone.

**Tests**: `npm test` runs `test/view-test.mjs` (what each row of the lists shows and offers), `test/state-test.mjs` (the payment records as a state machine: two tabs merging field by field, confirmation by change or by the node's spend lookup, a replacement or a cancel that wins or loses, a refused replacement, republishing, forgetting, and that `reef.js` and `version.json` carry the same version) and `test/wallet-test.mjs` (with `SCHEMA`, `BLAKETESTNODE` and `SIDESTR_LIB` pointing at checkouts, defaults under `~`) runs the wallet's rules against the kernel: exact amounts, destination checks, sizes and fees measured on signed transactions, coin selection, send-everything, dust, balances with waiting payments and replacements, the key formats (WIF, descriptor checksum) and the history. `node test/smoke.mjs` (needs `npm i --no-save playwright-core` and a Chromium) loads the page itself in headless Chromium with the node replaced by `test/fake/tabnode.js`: the startup order (a set-aside record stays set aside whichever of the wallet and the node is ready first), a newer schema leaving everything untouched, the idle second tab, and that nothing claims a balance before the node answers. CI also runs it, checks the formatting (Prettier), and fails a push that changes the code without bumping `version.json`. `.github/workflows/pins.yml` fetches the four published apps (Reef, Bight, Winch, Hitch) daily and on every push and fails if their node pins differ.

## Releasing

1. Change the code; run `npm test` (also run on every push by `.github/workflows/test.yml`, with the node, library and engine checked out at the pinned commits) (the syntax of `reef.js`, the payment state machine, the wallet against the kernel, and the release checks: `VERSION` in `reef.js`, `version.json` and `reef.js?v=` in `index.html` agree, and the security policy names the exact node, library and engine pins, including the ones the node worker itself imports).
2. Bump `VERSION` in all three places together, so a cached page never mixes versions and open tabs are offered the new one.
3. A new node pin goes into `reef.js`, the policy in `index.html`, and the other apps of the origin (Bight, Winch, Hitch) in the same sitting: they share the node's files and its lock.
4. Push; GitHub Pages serves the new files within about ten minutes.

## What a tab cannot protect

The wallet key is kept in this browser's storage for the site `bitcoin-blake.github.io`, which every page published from the bitcoin-blake organisation shares. A compromised dependency or a script-injection bug in any of those pages could read it. Reef's own page loads only pinned code under a strict policy, but that does not cover its neighbours. For test coins this is accepted; for anything of value the wallet would need its own origin or a key encrypted under a passphrase. A tab is only watching while it is open, and it trusts its block source as far as the signed chain tip it can reach confirms it.

## Name

It looks like Knots and runs a chain Knots defined, but it is not Knots, and the name is its own: a reef knot. The About box says what it is.

## Glass

Reef is meant to be a pane in [Glass](https://solid-apps.github.io/glass/), the one-file desktop, where it gets a window frame and a dock icon; registration in the solid-apps registry is the next step.

## Licence

AGPL-3.0-or-later.
