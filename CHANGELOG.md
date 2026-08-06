# Changelog

All notable changes to **minimaCore Desktop** — the cross-platform (macOS / Windows / Linux) Electron app that runs
a full minimaCore node locally with a native-styled wallet + module suite. Newest first. Each release is tagged
`vX.Y.Z`; since 0.13.0 the installers (`.dmg` / `.exe` / `.AppImage`) are built on GitHub Actions and attached to the
matching [GitHub Release](../../releases).

---

## [0.16.11] — PandaPools: stop the runaway owner-key hunt (bounded, remembered, provable)
- **Fixed** the owner-key hunt minting keys without limit (parity with native **0.9.24** / MiniDapp **0.6.18**): a persistent per-(seed, opk) hunt ledger caps lifetime mints at 256, charged per REAL mint only (a failed `newaddress` never charges), persisted per mint so interrupted hunts resume with only their remainder.
- **Added** `kidx` (owner key derivation index) to recipes and backup **format v3** — hunts become exact, and a wallet already past the index proves a foreign seed with **zero** mints. Values hard-coerced against malformed backups.
- Unreachable keys are reported honestly on every surface: Withdraw/Migrate reject with "belongs to a different seed", Collect reports skipped pools, the restore panel shows the foreign count AND any key-usage warning (previously never displayed) and stays open when either is present.
- **Fixed** a late-spend hazard: the serial hunt gate could delay a Withdraw/Migrate past its own UI timeout, firing a real spend after the user was told to retry — spends now abort if the owner-key check outlives the caller's deadline.
- Owner-key hunt section stays byte-identical to the MiniDapp copy.

## [0.16.6] — AtomiX: serial signing gate + unique txn ids
- **Added** the serial signing gate to the bundled AtomiX engine (parity with AtomiX native 0.1.14 / MiniDapp 0.1.14). Only one signing command is in flight at a time, so the node can't issue the same one-time key leaf for two different messages.
- **Fixed** an AtomiX transaction-id collision: ids were millisecond-granular, so two settlement actions starting in the same millisecond shared a node-side txid and their commands merged into one transaction. Now carries a monotonic counter.
- Engine files stay byte-identical to the MiniDapp per the reuse rule.

## [0.16.5] — PandaPools: carry the owner key's signature count through backup and restore
- **Fixed** the last key-reuse path (parity with native 0.9.23 / MiniDapp 0.6.11). A pool's owner key is minted with `newaddress`, so a seed-only re-sync doesn't bring it back, and the node re-mints every new key at `uses = 0` — so the next owner action re-signed leaves already spent on-chain. Signing one Winternitz leaf twice leaks its private key.
- **Added** `opkuses` + `atblock` to the backup (**format v2**), and a restore pass that winds each regenerated key forward to `count + elapsed blocks ÷ 900 + slack` before anything can sign with it. Advanced by burning leaves via `sign`, so it needs no forked node.
- Engine files stay byte-identical to the MiniDapp per the loader's reuse rule.

## [0.16.4] — PandaPools: persistent history + the per-pool statement
- **Added** a permanent, txpowid-keyed history mirror (`pp_history`) and the **per-pool statement** on the Pools → My LP tab: what you put in, your own trades against it, what is in the pool now, and the profit, exported as CSV.
- A routed swap is **split across the pools it actually touched** (`Σ(outputs at pool) − Σ(inputs at pool)`), with the split checked against the wallet's own movement; a row that doesn't tie is flagged and excluded rather than mis-booked. Two labelled profit figures: **pool profit (vs holding)** and **change in market value**.
- **History pages at 512 per request here.** The 256 KB reply cap that forces the phone app down to `max:1` lives in the Android broadcast receiver, not in the node — this app talks straight to the node's HTTP RPC, which imposes no size limit at all. Set through the MDS shim (`historyPageMax`), so the reused engine files stay byte-identical to the MiniDapp.
- Parity with PandaPools native 0.9.19/0.9.20 and MiniDapp 0.6.10; engine files `store.js`, `history.js`, `statement.js` copied verbatim.

## [0.16.3] — Balances: the full breakdown + an untruncated, tagged coin list
- **Fixed** the Balances cards hiding the numbers that explain them. `locked` and `pending` appeared only when non-zero, and `confirmed` was never shown — so a wallet with everything committed to a pool or a script showed a spendable figure and nothing accounting for the rest. Every figure now shows unconditionally, zeros included: `confirmed X · locked ≈ Y · unconfirmed Z · N coins · updated Ns ago · click for coins`. The headline stays **spendable** for the reason it always has.
- **Changed** the coin list: the 50-coin cap is gone and coinids are shown in **full** — it is an audit view, and an elided id can't be looked up. Added a *copy all coins* action alongside the existing per-row copy.
- **Added** `pool` and `beacon` tags to coins, resolved from the live PandaPools engine (`ppPools`) and the registry sentinel — so the gap between confirmed and spendable is named, not merely stated.
- Parity with PandaPools native 0.9.20 and MiniDapp 0.6.9. The **Web Wallet** tab is deliberately untouched: it mirrors the original webWallet and shows `confirmed` on purpose (a foreign megammr seed reports `sendable:0`).

## [0.16.2] — PandaPools: Individual | Combined pool view toggle
- **Added** a toggle on the Pools tab to fold every pool of a token into one collective-pool card (summed reserves + aggregate price + count + tradeable depth), via a Decimal-exact read-model helper. Display-only; the byte-identical PandaPools engine files are untouched. 3-way with native 0.9.17 + MDS 0.6.8.

## [0.16.0] – [0.16.1] — ETH Wallet tab
- **Added** a standalone **ETH Wallet** tab on the same seed-derived address AtomiX uses — ERC20 tokens (add-by-contract), send with Low/Med/High fee tiers, receive/QR, export key, Etherscan links, custom RPC. Reuses AtomiX's ETH engine (no new crypto).
- **Fixed** (0.16.1, after a deep fund-safety review): the fee-tier selector (engine floor was masking the tiers), a hostile-RPC gas-drain path (gas + base fee both clamped), duplicate-send lock, broadcast-ambiguity handling, EIP-55 checksum, and a token-file DoS. Executable test harness added.

## [0.15.x] — Web Wallet + AtomiX CSV + clipboard
- **Added** a **Web Wallet** tab: a local, MegaMMR-gated wallet-from-seed (keys stay on-device) (0.14.0, 0.15.3+).
- **Added** AtomiX "export my trading history to CSV" (maker + taker) (0.15.9).
- **Fixed** clipboard copy now routes through the main process — the renderer's `navigator.clipboard` was silently failing when unfocused, so "Copied ✓" lied (0.15.8).
- **Fixed** Web Wallet balance display — show **confirmed** (not sendable) so a funded foreign seed no longer reads zero (0.15.4–0.15.7).

## [0.13.0] — cross-platform builds
- **Added** Windows (NSIS `.exe`) and Linux (`.AppImage`) builds via the GitHub Actions matrix, alongside the macOS `.dmg`. The desktop is now mac/win/linux.

## [0.11.x] — Vestr + AtomiX preimage fix
- **Added** a **Vestr** token-vesting tab (shared covenant, 3-way interop) (0.11.0).
- **Fixed** (critical) AtomiX now verifies a harvested HTLC preimage hashes to the lock before pinning it (0.11.2).
- **Changed** removed the Casino tab (code preserved) (0.11.1).

## [0.9.x] – [0.10.x] — miniMall + AtomiX market-maker
- **Added** **miniMall** — an on-chain shop + vendor inbox + studio (3rd interop peer of the native miniMall apps) (0.9.0–0.9.2).
- **Changed** the AtomiX market-maker pane to full native "My market / ladder" parity (cockpit + twin bid/ask ladders, live preview) (0.10.1–0.10.4).

## [0.8.x] — AtomiX module + shared-node fund fixes
- **Added** the **AtomiX** atomic-swap tab (the 3rd interoperating AtomiX peer; reuses the byte-identical MDS engine) with full Swap + Market + maker parity (0.8.0–0.8.7).
- **Fixed** shared-node fund hazards: pin order/mail sends to a signable coin so anyone-can-spend beacon dust can't NPE the signer (0.8.8, 0.8.10); PandaPools owner-key self-heal before Withdraw/Migrate/Collect (0.8.3); and a node RPC POST bug where large commands silently no-op'd (missing `Content-Length`) (0.8.11).

## [0.7.x] — rich history + key-uses + icon
- **Added** deep, locally-owned transaction history in SQLite, with search/filter and per-token deltas (0.7.0).
- **Added** a per-address WOTS key-uses safety checker (0.7.1).
- **Fixed** pool-swap history now captures both legs (MINIMA + real mxUSDT `tokenamount`) and reads Bought/Sold correctly (0.7.2–0.7.3).
- **Changed** app icon to the Minima orange outlined mark (0.7.4–0.7.5).

## [0.6.x] — TERMINAL visual overhaul
- **Changed** a full "TERMINAL" design-system reskin (black/white/orange, Manrope + Geist Mono, dark default + light toggle) (0.6.0); adaptive wide nav-rail + sliding tab indicator + version pill (0.6.1).

## [0.4.x] – [0.5.x] — PandaPools + wallet polish
- **Added** the **PandaPools** AMM "Pools" tab (a 3rd parity peer, reusing the MDS engine byte-identical) (0.4.0), brought to full frozen-quote swap + USDT-anchored create parity with the dapp (0.4.1–0.4.2).
- **Changed** wallet balances to spendable-first with a rich token-detail modal (0.5.1–0.5.2); scrollable tab bar (0.5.3).

## [0.2.x] – [0.3.x] — first modules
- **Added** the first in-wrapper modules: a **Faucet** (Settings) and the full **minimaMail** on-chain encrypted messenger (0.2.1), brought to 100% feature parity with the native Mail APK — in-chat sends, rename/archive, QR scan, passphrase backup/restore (0.3.0).

## [0.1.x] — foundation
- **Added** the initial self-custodial wallet over the local node's HTTP RPC: Terminal, History, token icons/validation, coin basics, anyphrase restore, and a first-run startup-parameter editor (0.1.3–0.1.9).
