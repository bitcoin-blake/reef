# Reef

**A Knots-style Bitcoin node in a browser tab.** One HTML file, the familiar window: Overview, Send, Receive, Transactions, and the Node window with its Information, Console, Network Traffic and Peers tabs.

Live: https://bitcoin-blake.github.io/reef/

## Status: the node is real, the wallet is not yet

Since 28 September 2026 (evening) the page is wired to [blaketestnode](https://github.com/bitcoin-blake/blaketestnode)'s browser node: its worker, pinned by commit and loaded from the CDN, fetches the fork-point UTXO snapshot (870 MB, 14.2 million coins) into the tab's private file system, checks its sha256, recomputes `hash_serialized_3`, builds a txid index, then syncs the BLAKE2b blocks since the fork from a mirror and validates every one, and keeps following the tip. The status bar shows each phase with a progress bar and an estimate, the way a node does; the Node window's Information tab shows the live figures and a sync history with the seconds each phase took; the Console answers `getblockchaininfo`, `getblockcount`, `getbestblockhash`, `getblockhash`, `getsnapshotinfo`, `gettxoutsetinfo`, `gettxout`, `getnetworkinfo`, `getpeerinfo`, `getnostrtip` and `uptime` from the tab's own state, in the shapes Knots uses, and says "Method not found (code -32601)" to the rest. Measured on the machine that runs the estate, snapshot from a local server: fetch 0.5 s, sha256 9 s, parse and index 14 s, 1,621 blocks validated in 28.5 s.

The wallet is real too, in the simplest form: one key made in the tab and kept in its storage, its Taproot key-path address with a QR on Receive, a balance read from the tab's own validated UTXO set (coins created since the snapshot; the worker's `coins` command), and a Send that builds, signs and checks the transaction in the tab and publishes it as a kind 23503 event, which a sidestr producer with a txbt4 node broadcasts if its node's policy accepts it. `getblock` reads the mirrored block file through the worker's `block` command. What a tab does not do: scan the snapshot itself for a script (the index is by txid), so coins from before the fork are not seen, and follow a mempool, so a payment shows only once a validated block carries it. The tab needs about 1.1 GB of storage; a first visit downloads the snapshot (`?snapshot=` and `?blocks=` override the sources; Settings → Options edits them; File → Wipe removes the files from the tab).

## Name

It looks like Knots and runs a chain Knots defined, but it is not Knots, and the name is its own: a reef knot. The About box says what it is.

## Glass

Reef is meant to be a pane in [Glass](https://solid-apps.github.io/glass/), the one-file desktop, where it gets a window frame and a dock icon; registration in the solid-apps registry is the next step.

## Licence

AGPL-3.0-or-later.
