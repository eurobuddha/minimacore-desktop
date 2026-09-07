# Changelog

All notable changes to **minimaCore Desktop** — the cross-platform (macOS / Windows / Linux) Electron app that runs
a full minimaCore node locally with a native-styled wallet + module suite. Newest first. Each release is tagged
`vX.Y.Z`; since 0.13.0 the installers (`.dmg` / `.exe` / `.AppImage`) are built on GitHub Actions and attached to the
matching [GitHub Release](../../releases).

---

## [0.16.36] — CI fetch works on every runner; installer names fixed
- **Fixed** the CI matrix's Parlons Node fetch so every runner completes it: `sha256sum` on Windows (no `shasum` there), no unauthenticated releases-API call when the node version is pinned (the shared Mac runner was rate-limited to a 403), and the job token passed to the fetch step (`GH_TOKEN: ${{ github.token }}`).
- **Fixed** the installer names to `minimaCore-<ver>-x64.exe` / `minimaCore-<ver>-x64.AppImage` (electron-builder rendered `${arch}` as `x86_64` for the AppImage; the artifact name now carries the literal `x64`).
- Repaired `package.json` (stray trailing text after the closing brace). First release since 0.16.30 to ship all three platforms.

## [0.16.35] — All three platforms, every release
- **Added** `scripts/release-desktop.sh <ver> "<notes>"`: tags `v<ver>`, waits for the CI matrix, uploads the signed DMG over CI's unsigned one, adds the Windows and Linux rows to the update feed via the new `scripts/publish-desktop-platforms.sh`, and exits non-zero unless the feed lists `mac-arm64`, `win-x64` and `linux-x64`. 0.16.31–0.16.34 had gone out Mac-only because CI's Parlons Node fetch died on an unauthenticated `gh` and nothing noticed.
- The Parlons Node version bundled by every platform is pinned in `package.json` (`parlonsNode`). Windows and Linux builds are unsigned.

## [0.16.34] — Parlons Node 0.2.58: share a contact; Port forwarding card
- **Added** contact sharing in the Parlons panel: Copy address, Send to a contact…; a received contact card offers Add contact.
- **Added** a Port forwarding card on the panel's Node page: the TCP port, the LAN address to forward it to, the router's admin link, your public address and whether the internet has actually reached the port.

## [0.16.33] — Parlons Node 0.2.55: own sends mirror live to every device
- **Fixed** cross-device echo: a message sent from the phone now appears in the desktop Parlons panel at once, with its ticks, and one sent from the panel appears on the phone. Before, the other device only showed it on its next reload of that conversation.

## [0.16.32] — Parlons Node 0.2.54: one-port review fixes
- **Fixed** the relay hand-off to run on the node's own network (selector) thread, so it can never leave the chain node in a blocking read; frames pipelined behind a greeting are replayed whole.
- **Fixed** "Your relay: verified" to require a PUBLIC inbound peer (a LAN node no longer counts), and a changed public address (dynamic IP) is re-learned every 10 minutes and re-adopted.

## [0.16.31] — Parlons Node 0.2.53: the Node page refreshes itself
- **Changed** the panel's Node page to refresh while open. Also `scripts/fetch-parlons-node-jar.sh` now prefers `gh`'s consistent release list — the releases API lags a just-created release by minutes, which is how 0.16.31's first build bundled 0.2.52.

## [0.16.30] — Parlons Node 0.2.52: own relay over loopback
- **Fixed** the account reaching its own relay: it now connects over loopback (routers rarely hairpin), and "Your relay" turns reachable on the node's own evidence — an incoming chain peer on the port you forward.

## [0.16.29] — One public port
- **Changed** the Parlons relay inside the node to ride the Minima P2P port (Parlons Node 0.2.51, `-Dparlons.relay.port=shared` when contributing). The one port you already forward for the chain now carries the relay and the account too; the second router mapping (12501) is gone.

## [0.16.28] — The Parlons tab is the panel alone
- **Changed** the Parlons tab to show the account's web panel with no native strip above it; the strip only speaks while the account is starting or in error.
- Parlons Node 0.2.50: a contributing desktop's own relay is adopted after the node learns its public address, and the permanent address is anchored once the relay is proven reachable; the panel's Node page shows "Your relay" with its state and connections.

## [0.16.27] — In-app updates from the minimaCore store feed
- **Added** `main/updater.js`: the app reads the one-app, manifest-only feed at `https://eurobuddha.com/pandaapps/minimacore-desktop.json` at launch and every 6 h. A newer build shows an "Update x.y.z" pill beside the version, a Settings → Updates card and a tray line. Download saves the installer to ~/Downloads, verifies it against the feed's sha256 (a wrong hash is refused) and reveals it in Finder. Nothing installs by itself. `updateFeed` in the app config points a self-hoster at their own feed.
- **Added** `scripts/publish-desktop.sh <ver> "<notes>"` (after `npm run dist:mac:signed`): validates the stapled DMG, creates or updates the GitHub release, rewrites the feed and pushes it to the host.
- The Parlons strip explains the address's directory anchor; Parlons Node 0.2.49 (the panel is the Parlons app).

## [0.16.26] — The Parlons tab is the full chat window
- **Changed** the Parlons tab to embed the account's own web panel (Parlons Node 0.2.48): chats, conversations with photos, contacts, devices (pairing QR), node and settings, live over server-sent events. The app only hosts it in one hardened `<webview>` on the loopback panel and adds the strip above it.

## [0.16.25] — A node that outlives the app is reclaimed, never fought
- **Fixed** node lifecycle: `node-manager` writes `<userData>/node.pid` on spawn, and every start first reclaims a stale node — the pidfile's pid and whoever listens on the base port, when its command line is a minima/parlons node on our port or data folder — via RPC quit → SIGTERM → SIGKILL, bounded. A port owned by something else refuses the start and the Node tab names the owner. `will-quit` / `process.exit` SIGKILL the child as a last resort. Seen live 2026-09-07: a java left behind by a crashed launch held port 12001 and the H2 databases, and the next launch died with "Database may be already in use".
- **Added** plain-language fatal hints for the H2 "already in use" and port-in-use cases.

## [0.16.24] — The Parlons Node hosts your account
- **Added** a node kind: Settings → Node kind switches the bundled node to `parlons-node.jar`, launched with `-D` properties plus one quoted flag string. The Parlons tab shows the account's loopback panel in a hardened `<webview>`, with an address strip and Open in browser. When contributing, the cape port is mapped alongside the chain port.
- **Added** `scripts/fetch-parlons-node-jar.sh` for the build; the bundled JRE gains `jdk.httpserver`.

## [0.16.23] — Signed and notarized Mac build
- **Changed** the macOS build to a Developer ID-signed, hardened-runtime, notarized and stapled DMG (`npm run dist:mac:signed`, `scripts/notarize-dmg.sh`, checked by `scripts/verify-mac.sh`) — it installs with no Gatekeeper warning. CI signs when the secrets exist; otherwise the signed local DMG is uploaded over CI's unsigned one.

## [0.16.22] — Pools: a what-if pool calculator
- **Added** a **pool calculator** to the Pools tab's My LP view (parity with native PandaPools **0.9.30** / MDS **0.6.20**): a "Pool calculator" card, plus "What if the price moves? ›" on each of your pool cards, which opens it seeded with that pool's live reserves. Enter a starting pool, move the MINIMA price — type it, drag the log slider (÷10,000 … ×10,000) or tap a ÷100 … ×100 chip — and see the MINIMA and token in the pool, their ratio, the value versus simply holding, the price move from entry, and the pool's point on its constant-product curve. Display only: nothing touches the node or the chain.
- **Fees as a variable**: the swap fee rate (0.5 % by default — the covenant's) and the volume traded through the pool give the fees kept, K with fees, the reserves and value with fees folded in, and the volume needed to break even with holding at that price. Fees are valued at the current price (√K′ = √K + fees ÷ 2√P); the dialog says so.
- New `renderer/poolcalc.js` — a byte-identical copy of the MDS `calc.js` (maths + curve + the form itself); `app.js` only supplies the modal and the seed.

## [0.16.21] — AtomiX: refunds say why, correctly for your role
- **Fixed** refund notifications (parity with native AtomiX **0.1.44** / MDS **0.1.24**). The Minima-leg refund said only "Timelock passed — reclaimed your X" with no reason, and the reason text used elsewhere — "the counterparty never locked their side" — was wrong when you were the responder: your counter-leg only existed because the counterparty DID lock; what failed was their claim. Both refund paths now state the role-correct reason ("locked their side but never claimed yours" for a responder), and a stored mismatch note still takes precedence. Prompted by a live 2026-08-27 case where diagnosing a 438 USDT first-time buyer's silent no-claim took on-chain archaeology.

## [0.16.20] — AtomiX: ignored inbound OTC offers now age out
- **Fixed** inbound OTC offers sitting forever (parity with native AtomiX **0.1.43** / MDS **0.1.23**). An offer awaiting YOUR move (PROPOSED/COUNTERED, your turn) was exempt from `expireStale` — only deals waiting on the peer expired (1h). Since the proposer's side did expire after 1h, any older inbound offer was a zombie: accepting would hit their terminal deal and be ignored, while the displayed price only got staler. Offers untouched for 24h (`INBOUND_EXPIRE_MS`) now expire and then prune on the normal terminal path. The `otcVerify*` fund gate is untouched.

## [0.16.19] — Casino: playing once no longer adopts every bet on the network into your balance
- **Fixed** the one-play-pollutes-forever trap (parity with native ZeroEdge Casino **0.6.8** / MDS **2.8.9**). The casino is ONE shared covenant address for every player, and it was registered `newscript trackall:true` — so a single play made the node count every bet by every player, forever, as your own locked balance. The covenant is now registered `trackall:false` everywhere (the script ROW is what `txnbasics` needs for ScriptProofs — it is track-flag-blind), the shim mutator that force-appended `trackall:true` now normalises to `trackall:false` (a stale donor copy can never re-promote the row), and a launch hygiene sweep drops relevance from bet coins this wallet is not a party to (state ports 0/1/8/9 vs wallet keys + simple addresses; abort with zero writes when ownership can't be proven — a wrong `cointrack` on an existing coin is permanent, core only re-checks relevance when a block first processes a coin). Your own bets stay relevant without tracking: core matches wallet keys/addresses against the coin's HEX state.
- **Fixed** a latent donor keys-parse bug: on a bare-array `keys` response, `res.response.keys` resolved to `Array.prototype.keys` (a truthy method), silently parsing ZERO keys — disabling auto-reveal/auto-resolve and the sweep on such nodes.
- **Bounded** every `coins address:<contract>` scan at `depth:4096` — a cap deliberately ABOVE stock Minima's 2048 cascade so old claimable timeout coins (carried in the tree root) are never hidden. Never lower it below the stock cascade.
- Glue test extended: asserts `trackall:false` (and that no `newscript` carries `trackall:true`), the depth cap, and that the sweep untracks ONLY foreign bet coins and never one carrying an own key/address.

> Ledger note: 0.16.16 (AtomiX MA-19 command-injection guards), 0.16.17 and 0.16.18 shipped without changelog entries — see git log / releases.

## [0.16.15] — Pools: a swap no longer adopts the pool into your wallet balance
- **Fixed** the one-swap-pollutes-forever trap in the Pools tab (parity with native PandaPools **0.9.27** / MDS **0.6.19**). Every swap ran `newscript trackall:true` on every routed pool — only so `txnbasics` could attach the covenant's ScriptProof — making the pool address permanently *relevant*, so a stranger's pool reserves counted into the wallet's `confirmed` balance (and the Wallet tab's `locked = confirmed − sendable` figure) forever.
- **Swap path now registers foreign pools with `trackall:false`** (`ensureTrackedForSwap` in `main/pandapools/poolmgr.js`): txnbasics reads the script table regardless of the track flag, so swaps build and post exactly as before, but the pool's coins never become relevant. A row already on the node — any track value — is left untouched (`newscript` REPLACES an existing row; re-registering would downgrade an LP's own `trackall:true`). Owner flows (create/deposit/close/refresh/migrate/restore) still assert `trackall:true`.
- **Added a launch hygiene sweep** (`cleanForeign` in `main/pandapools/service.js`, after `retrackOwn`): demotes every tracked covenant whose owner key is provably not this wallet's (`keys` + `pp_ownpools`; unreadable/empty reads → zero writes) back to `trackall:false` using the row's **verbatim** script, then `cointrack enable:false` on its lingering relevant coins. Full effect after the next node restart — core keeps a demoted address in its in-memory relevance cache until then, which is why the sweep re-runs every launch.
- **Fixed** the `retrackOwn` gate to check the row's **track flag**, not mere existence — a swap's `track:false` row must not block re-upgrading an own pool to `trackall:true`. Also corrected the service header, which still described the long-removed track-on-discovery behaviour.
- Swapped pools stay visible and swappable while their owner keeps them fresh (the `track:false` script row still feeds Source-1 discovery); only the wallet-balance pollution is gone.
- Hardened after independent adversarial review: only the node's AFFIRMATIVE "not found" reply triggers the swap-path registration — an ambiguous failure writes nothing (`newscript` REPLACES rows); the sweep re-reads `pp_ownpools` immediately before writing so a restore landing mid-sweep is never demoted; a pending-shaped demote reply aborts the demote loop; the coin pass runs one bounded `coins relevant:true address:` query per foreign address. Desktop-specific: an in-app node restart now re-fires the PandaPools service boot (`onNodeRestarted` → `inited`), so the hygiene sweep re-runs right when the node's relevance cache has actually been rebuilt, instead of waiting for the next full app launch. Also synced `book.js` comments and `history.js` to the MDS revision (mirror discipline). Verified by 33 mock-node sim assertions of this exact JS.

## [0.16.14] — Terminal: IDE-style parameter autocomplete (port from Terminal IDE)
- **Added** full-depth autocomplete to the Terminal tab, ported line-for-line from the Terminal IDE APK's completion stack (`apks/terminalide` — `CommandRegistry.java` + `ParamDocs.java` + `Suggest.java`). A dropdown appears as you type (not Tab-only) and completes whichever token the caret is in: command names (prefix matches before substring matches), then that command's parameters (required first, already-used ones skipped), then a parameter's legal values (`coins order:` → `asc`/`desc`; `help command:` → every command with its one-line description). Works mid-line, inside `;` chains (each segment completes independently), and stays quiet while the caret is inside an unclosed quoted string. A one-line usage hint for the active command sits above the input.
- New `renderer/termcomplete.js` (engine + 115-command registry copied verbatim from the node source extraction) and generated `renderer/termhelp.js` (the node's own `help command:x` pages, offline) — the dropdown carries per-parameter descriptions and required flags mined from the node's help. Keys: type to suggest, ↑/↓ navigate (history when the dropdown is closed), Tab accepts and flows command → params → values, Esc closes, Enter always submits. Styled entirely with the existing theme tokens, so light and dark both work.
- **Removed** the old first-token-only Tab cycler and its lazy `help`-parsing command list (`TERM_CMDS`/`FALLBACK_CMDS`) — the static registry replaces them, which also fixes the old list never retrying when the node wasn't up on first visit.
- Autocomplete only — the Terminal IDE's Scripts/Txns/Logs panels and danger-warning guards are intentionally not ported. New headless test: `npm run test:termcomplete` (31 checks).

## [0.16.13] — bundled node moves to 1.1.2.4 (upstream super-parent fix)
- **Changed** the bundled node from **1.1.2.3** to **1.1.2.4**, keeping the `Wallet.signData` fix from 0.16.12. The two builds differ by exactly two classes: upstream commit `7b5994a` corrects a wrong loop variable in `TxPoWChecker`'s super-parent check (`getSuperParent(blocksup)` → `getSuperParent(i)`), plus the version stamp. That is an upstream fix by Spartacus Rex, not a fork change.
- Verified before shipping: identical entry count (3278) and bundled H2 (1033), `signData` and `updateUses` still synchronized, and the node boots reporting `Pure Minima 1.1.2.4` with no class-loading errors under the app's own bundled JRE.

## [0.16.12] — SECURITY: bundled node jar carries the Wallet.signData fix; in-app jar updater removed
- **SECURITY / Fixed** the bundled `resources/minima.jar` was built without the `Wallet.signData` synchronization fix, so the desktop node ran the unsynchronized read-modify-write of the key `uses` counter — the Winternitz one-time-signature reuse documented in `minima-core/UPSTREAM_CHANGES.md`. The Android fork has shipped the fix since vc35; the desktop never had it. `signData` **and** `updateUses` are now synchronized in the shipped jar, verified by reflection on the bundled JRE.
- The jar is otherwise the build it replaces: same 3278 entries, same 1033 bundled H2 classes, same `Main-Class`, same Java 8 target, and the class exposes the same 63 members — the only difference is those two access flags. `Wallet.java` has exactly one commit in its history beyond its introduction, and that commit is the fix.
- **Removed** the in-app node-jar updater. It defaulted to a GitHub releases feed at `eurobuddha/minima-core` — a **private** repo with **no releases** — so "Check for update" could never find anything; and had that repo been opened up, desktop users would have been moved onto fork jars without meaning to. The button is gone and the IPC handlers now return a clear disabled answer rather than being unregistered.
- **Fixed** a related trap: `jarPath()` preferred an updater-downloaded copy in `userData` over the bundled jar, so anyone who had ever run the updater would keep booting that old jar forever and never receive this fix. The shipped jar is now the only jar the app runs; a stale `userData` copy is ignored, not deleted.

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
