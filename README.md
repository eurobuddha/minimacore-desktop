# minimaCore Desktop (macOS)

A native Mac app that runs the **minimaCore** node locally and wears the same UI as the Minima native
Android apps — starting with a self-custody wallet. It's a thin **wrapper around an ever-updating
`minima.jar`**: the app bundles a known-good jar + a JRE, launches the node headless with RPC, and can pull
newer jars from GitHub releases as the project develops.

> Development software. Not affiliated with Minima Global. Use at your own risk — always back up your seed.

## What it does
- **Runs the node** for you (`java -jar minima.jar … -rpcenable true -rpcpassword <secret> -daemon`), with a
  **bundled JRE** so no system Java is needed. RPC is localhost-only with a password kept in the macOS Keychain.
- **First-run node wizard**: pick network (Mainnet / Solo-test / Custom peer) + advanced (data folder, port,
  full-history).
- **Wallet** over the node's RPC: Balances, Receive (address + QR), Send · Split · Consolidate, Settings
  (reveal seed, encrypted backup, key-uses, diagnostics, theme).
- **Wallet seed onboarding**: New (fresh seed, backed up) or **Restore from seed** — fast-syncs via
  `megammrsync` (seconds), with the WOTS **key-uses** attestation (0 for new, your prior count for a restore).
- **Node updater**: checks a GitHub releases feed for a newer `minima.jar`, verifies sha256, swaps, and restarts.

## Design
Reuses the native `Design.java` look via `renderer/style.css` (the 1:1 CSS port shared with the PandaPools
MiniDapp): dark `#0A0A0F`, Minima-orange `#F7931A`, with light/dark/original themes.

## Develop
```
npm install
npm start                 # runs against a bundled minima.jar
```

## Build the .dmg
```
# 1. bundle a minimal JRE (Apple Silicon). jdk.httpserver is REQUIRED: the Parlons Node's admin RPC,
#    wallet gateway and the account's web panel are com.sun.net.httpserver servers.
jlink --add-modules java.se,jdk.unsupported,jdk.httpserver --strip-debug --no-header-files --no-man-pages --output resources/jre
# 2. fetch the Parlons Node jar (the node-v* release of eurobuddha/maxima, checksum-verified):
npm run fetch:parlons                              # → resources/parlons-node.jar (gitignored)
# 3. package:
npm run dist:mac:signed                           # → dist/minimaCore-<ver>-arm64.dmg, notarized + verified
```
Two node jars ship: `resources/minima.jar` (the plain node, copied from `minima-core/jar/minima.jar`) and
`resources/parlons-node.jar` (the same node fork + a Maxima relay + wallet gateway + the user's Parlons
account, from https://github.com/eurobuddha/maxima/releases node-v*). `nodeKind` in the app config picks
which one runs (new installs: the Parlons Node; an older install keeps the plain node until it switches in
Settings → Node). The Parlons Node takes no argv: node-manager passes -D properties and puts Minima's own
flags in one quoted `-Dparlons.node.args` string. Ports on the default base 12001: P2P 12001 - which, when contributing, ALSO carries the Parlons/Maxima
relay (the node hands relay clients over by their greeting: one public port, the one you already forward);
admin RPC 12005 (loopback), wallet gateway 12585 (loopback), Parlons web panel 12587 (loopback).

## 0.16.32
parlons-node 0.2.54: one-port review fixes. The relay hand-off now runs on the node's own network thread
(it can never leave the chain node in a blocking read), frames pipelined behind a greeting are replayed
whole, "Your relay: verified" now needs a PUBLIC inbound peer (a LAN node no longer counts), and a changed
public address (dynamic IP) is re-learned every 10 minutes and re-adopted.

## 0.16.31
parlons-node 0.2.53: the Parlons Node page refreshes itself while open.

## 0.16.30
parlons-node 0.2.52: the account reaches its own relay over loopback (routers rarely hairpin) and "Your relay"
turns reachable on the node's own evidence - an incoming chain peer on the port you forward.

## 0.16.29
One public port. The Parlons relay inside the node now rides the Minima P2P port (parlons-node 0.2.51,
`-Dparlons.relay.port=shared`), so the port you already forward for the chain carries the relay and the
account too; the second mapping (12501) is gone.

## 0.16.28
The Parlons tab is the panel alone - no native strip above it (the strip only speaks while the account is
starting or in error). parlons-node 0.2.50: a contributing desktop's own relay is adopted after the node
learns its public address and anchors the permanent address once proven reachable; the panel's Node page
shows "Your relay" with its state and connections.

## In-app updates (0.16.27)
The app reads a one-app store feed - `https://eurobuddha.com/pandaapps/minimacore-desktop.json` (manifest
only, the PandaApps convention; the DMG lives on the GitHub release `v<ver>`) - at launch and every 6 h
(`main/updater.js`). A newer build shows an "Update x.y.z" pill next to the version, a Settings → Updates
card and a tray line; Download saves the file to ~/Downloads, verified against the feed's sha256, and
reveals it. Nothing installs by itself. Publish with `scripts/publish-desktop.sh <ver> "<notes>"` after
`npm run dist:mac:signed`. `updateFeed` in the app config points a self-hoster at their own feed.

## The Parlons tab (0.16.26)
The tab is the account's own web panel (parlons-node 0.2.48): a full chat window - chats, conversations
with photos, contacts, devices (pairing QR), node, settings - live over server-sent events. The app only
embeds it (one hardened `<webview>` on the loopback panel) and adds the strip above it.

## Node lifecycle (0.16.25)
The node must never outlive the app, and the app must never fight a node it left behind. `node-manager`
writes `<userData>/node.pid` on spawn; every start first reclaims a stale node (the pidfile's pid and
whoever listens on the base port, when its command line is a minima/parlons node on our port or data
folder: RPC quit → SIGTERM → SIGKILL, bounded), and refuses to start when the port belongs to something
else (the Node tab names it). `will-quit` / `process.exit` SIGKILL the child as a last resort. Seen live
2026-09-07: a java left behind by a crashed launch held port 12001 and the H2 databases, and the next
launch died with "Database may be already in use".

## Notes / TODO
- Currently an **arm64** (Apple Silicon), **unsigned** build. Universal (x64) needs an x64 JRE; distribution
  wants Developer ID signing + notarization.
- Pin the **updater repo** (the minima-core releases that publish `minima.jar`) and confirm the default
  **mainnet peer / MegaMMR host** (`31.125.188.214:9001`).

MIT licensed — see `LICENSE`.
