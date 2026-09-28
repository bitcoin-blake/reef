# Reef

**A Knots-style Bitcoin node in a browser tab.** One HTML file, the familiar window: Overview, Send, Receive, Transactions, and the Node window with its Information, Console, Network Traffic and Peers tabs.

Live: https://bitcoin-blake.github.io/reef/

## Status: mockup

This is the mockup, made 28 September 2026. It opens on the Overview of the BLAKE2b testnet4 (`txbt4`) at block 151,927, and the chain figures are real: the tip, the snapshot's hashes, the mempool, the peers as the mirror's node saw them. The wallet, its coins and the console's answers are frozen samples, and the window says so in the corner.

The real node it will front is [blaketestnode](https://github.com/bitcoin-blake/blaketestnode)'s `browser/` page: the fork-point UTXO snapshot (870 MB, 14.2 million coins) is fetched into the tab's private file system, its sha256 and `hash_serialized_3` recomputed against the pinned values, a txid index built, and every BLAKE2b block since the fork validated in a worker. Measured on the machine that runs the estate: about 63 seconds from a snapshot on disk to a validated tip in a tab (datstr `bench/`).

Wiring the mockup to that node means replacing the frozen samples with the worker's messages and the tab's indexes: the console's `getblockchaininfo`, `getblock`, `gettxoutsetinfo` and `getsnapshotinfo` are answerable from the tab as it stands; `getpeerinfo` and the traffic graph become the mirror and the relays it reads from. Send and Receive come from the sidestr wallet.

## Name

It looks like Knots and runs a chain Knots defined, but it is not Knots, and the name is its own: a reef knot. The About box says what it is.

## Glass

Reef is meant to be a pane in [Glass](https://solid-apps.github.io/glass/), the one-file desktop, where it gets a window frame and a dock icon; registration in the solid-apps registry is the next step.

## Licence

AGPL-3.0-or-later.
