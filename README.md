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
# 1. bundle a minimal JRE (Apple Silicon):
jlink --add-modules java.se,jdk.unsupported --strip-debug --no-header-files --no-man-pages --output resources/jre
# 2. package:
./node_modules/.bin/electron-builder --mac        # → dist/minimaCore-<ver>-arm64.dmg
```
The bundled node jar lives at `resources/minima.jar` (copied from `minima-core/jar/minima.jar`).

## Notes / TODO
- Currently an **arm64** (Apple Silicon), **unsigned** build. Universal (x64) needs an x64 JRE; distribution
  wants Developer ID signing + notarization.
- Pin the **updater repo** (the minima-core releases that publish `minima.jar`) and confirm the default
  **mainnet peer / MegaMMR host** (`31.125.188.214:9001`).

MIT licensed — see `LICENSE`.
