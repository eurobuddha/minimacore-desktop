# Pandamonium Desktop — plan (draft for owner sign-off, 19 Nov 2026)

Pandamonium Desktop replaces Minima Core Desktop. Reference: Pandamonium 2.2.52
(`apks/base`, branch `companion-chooser-2026-11-10`, commit `be7c8be407efc85000d19eac0846bbcbcb3398c5`).
Work happens in this worktree: `desktop/pandamonium-desktop`, branch `pandamonium-desktop`,
started from `origin/master` 0.18.64 (`def5e8e`).

Status: research done. Nothing built. Owner decisions D1–D7 below are open.

## 1. What the research found

- Every Minima Core Desktop tab except Parlons was redrawn by hand; none reuses its original's
  screens. The shell uses a desktop-only palette that matches no original.
- Chat, Mail and AtomiX styles already match their Pandamonium versions. The shell and Pools do not.
- Mail is 20 versions behind the Android app (desktop matches 0.5.8; Android is 0.5.28): no six-word
  addresses, no MxUSD payments, no full threads, no text selection.
- Three identifier or naming defects exist today and are fixed in phase 0: the ETH Wallet card and
  History rows shorten identifiers; Vestr shortens its contract address
  (`0x3C432D5099AB27EA901079EF54D9A97AB4DB3BD1CFFF670296C31B7C83C1C8BE`); miniMall says "mxUSDT".
- The app's data folder is named after `productName` ("minimaCore") and nothing pins it. A rename
  would orphan every user's swaps, pools, mail, chat and history.
- The desktop node jar has no block-as-key-uses mode. Pandamonium defaults to it. The same 24 words
  give different keys in the two modes.

## 2. The reference: what Pandamonium is

- Toolbar "Minima Core" / "Pandamonium"; footer with block height and key count.
- Tabs: Wallet · Dexicon · History · Apps · Chat · Node. Chat hides when Keets is off; Dexicon hides
  when switched off.
- Apps: a list of integrated apps, each with On/Off and freeze, drag to reorder, order saved.
- Overflow menu: Logs, Terminal, Backup, Startup Params, App lock, Shutdown, Reset, Language.
- Look: Manrope; orange `#FF4A2B`, blue `#2F6BF6`; dark `#0F1114` / light `#F4F5F7`, following the
  system; cards 16 radius, 1px outline, no shadow; controls 12; buttons sentence case; 8-unit grid.
- Each integrated app keeps its own design inside the shell: Mail is warm paper with orange
  `#F7931A`; Dexicon, AtomiX and Pools use Dexicon's night palette with Inter and JetBrains Mono.

## 3. How each screen gets built

"Host" = the original MiniDapp's own files run unchanged in a sandboxed frame, with a small `mds.js`
bridge (the pattern DexiconPro already uses for the Exchange). "Reproduce" = rebuild the native
Android screens in HTML, screen for screen, from the Java and XML.

| Screen | Original | Method | Engine / data |
|---|---|---|---|
| Wallet, Receive, Send | `apks/base` core views | Reproduce | existing RPC code |
| History | `apks/history` 0.3.18 | Reproduce | keep `history.sqlite` |
| Node | `apks/base` Home view | Reproduce | existing |
| Settings, Startup Params, Backup, first run | `apks/base` | Reproduce | existing node-manager, config |
| Dexicon ① MxUSD | `apks/dexicon` 0.3.62 AtomiX screens | Reproduce | existing `main/atomix.js`, `atomix.sqlite` unchanged |
| Dexicon ② Pools | `apks/dexicon` PandaPools five tabs | Reproduce | existing `main/pandapools.js`, `pandapools.sqlite` unchanged |
| Dexicon ③ Exchange | `mds/dexicon` | Host | new engine, `userData/dexicon/dexicon.sqlite` |
| Chat | `apks/base` chat | Reproduce (already close) | keep `chat.json` |
| Parlons | `parlons-node.jar` panel | Already hosted | unchanged |
| MinimaMail | `apks/mail` 0.5.28 + Pandamonium 2.2.52 | Reproduce (catch up 20 versions) | keep `mail.json`, keychain identity |
| ETH Wallet | `apks/ethwallet` 0.2.15 | Reproduce | shared AtomiX ETH engine |
| Minima Vestr | `apks/vestr` 0.4.12 (orange, as in Pandamonium) | Reproduce | existing `main/vestr.js` |
| Future Cash Next | `mds/futurecash-next` 3.2.1 | Host (needs sql, keypair, background service) | new |
| Minima Explorer | `apks/blockexplorer` 0.1.10 | Reproduce (no MiniDapp exists) | read-only |
| Entropy | `apks/entropy` 0.1.14 | Reproduce (no local MiniDapp) | nothing stored |
| KeyUses | `mds/keyuses` 0.1.55 | Host | read-only |
| Minima Faucet | `mds/minimafaucetminidapp` 1.0.5 | Host | existing `main/faucet.js` |
| Web Wallet | Web Wallet 2.5.2 | Reproduce, keeping desktop safeguards | existing `main/webwallet.js` |
| Terminal | `mds/terminalIDE` | Host | `MDS.cmd` only |
| Logs | `apks/base` Logs view | Reproduce | existing `main/nodelog.js` |

Web Wallet is not hosted because the original's "Remember me" stores the seed in plain text.

## 4. Phases

Each phase is a run of small versions: one change, one version, one commit.

**Phase 0 — Safe foundations (no visible redesign yet)**
1. Pin the data folder to the existing `minimaCore` location before any rename. Test: upgrade keeps
   swaps, pools, mail, chat, history.
2. One signing queue for the whole process (DexiconPro's `main/noderun.js`); AtomiX and PandaPools go
   through it. This is the highest-risk change and lands before a third signer exists.
3. Fix the identifier and MxUSD defects listed in section 1.
4. Remove P2P Chance. A user with an open bet keeps the settle/reclaim path until it clears; keychain
   entries are never wiped.

**Phase 1 — The shell**
Pandamonium tokens, toolbar, tab bar, Apps list (On/Off, reorder), overflow menu, footer, system
light/dark. Existing tabs sit inside it unchanged at first.

**Phase 2 — Core screens**
Wallet, Receive, Send, History, Node, Settings / Startup Params / Backup, first run.

**Phase 3 — Dexicon**
Exchange hosted (public service: auto-cross on, no DexiconPro gates, user's relay list). Then ① and
② reproduced from the Android Dexicon screens over the existing engines. Old Pools and AtomiX tabs
are removed only after a parity audit of ① and ②.

**Phase 4 — Messaging**
Mail up to 0.5.28; Chat gaps (voice recording, files, retry); Parlons placement per D4.

**Phase 5 — Apps**
ETH Wallet, Vestr, Faucet, KeyUses, Terminal, Logs, Web Wallet, then the three new ones: Future Cash
Next, Explorer, Entropy.

**Phase 6 — Languages and release**
zh / ru / uk as in Pandamonium. Release on all three platforms through `scripts/release-desktop.sh`;
mac DMG signed and notarized.

## 5. Risks

| Risk | Guard |
|---|---|
| Data folder moves on rename | Pinned in phase 0, upgrade test before anything else |
| Three engines signing at once reuse a one-time key | One signing queue, phase 0 |
| Key mode switch cuts users off from live swaps and pools | Existing installs never change mode (D1) |
| Auto-cross trades against the user's own pool | Verify the guard before the Exchange ships |
| Open casino bet stranded | Settle path kept until clear |
| Local-only history lost (`mail.json`, `chat.json`, `shop.json`, `history.sqlite`) | Files untouched; no app is re-keyed |
| Future Cash Next covenant or transaction order altered | Hosted unchanged; service runs verbatim |
| ETH sends starve gas for swaps in flight | Keep the shared ETH send queue |

## 6. Owner decisions (answered 19 Nov 2026)

- **D1 Key mode.** Decided: NEW wallets use block-as-key-uses; EXISTING wallets keep classic keys. See section 7. Needs a node jar with the flag, proven on desktop first (Phase 2).
- **D2 Name.** The name stays **Minima Core Desktop**. No rename. (The data folder is still pinned in phase 0 as a guard.)
- **D3 Dexicon.** Not the existing desktop AtomiX and Pools screens. MxUSD and Pools must look exactly like Dexicon
  and PandaPools in Pandamonium.
- **D4 Chat and Parlons.** Separate. The Chat tab is Keets chat; Parlons is Parlons. They are not merged.
- **D5 Terminal and Logs.** In the overflow menu only, exactly where Pandamonium has them.
- **D6 miniMall.** Kept (read from the owner's dictated "keep minimal"; confirm).
- **D7 Split/Consolidate.** Merged: 0.18.65 (`7ec5964`).
- **Layout.** Exact Pandamonium, reference 2.2.53 on the unfolded Fold. Screens expand to the window. The app tray
  pushes the screen aside instead of covering it.

## 7. Block-as-key-uses on the desktop

Nothing in principle stops it. Two practical things do today:

1. The desktop's bundled node jar (sha256 `8cb690406b31d68ff218066c4986c67bfbf488d394fe25c879ace62501c42ea9`) is built
   from a line without the `-blockaskeyuses` flag. Pandamonium's jar (`apks/base/app/libs/minima.jar`, sha256
   `32f29846c07874dc530feda958b9fdbb4c0bbfabaadee463063b54d90ff2fdc9`) has block mode, low-RAM mode and keets, but it
   is the Android build: it does not bundle BouncyCastle or H2, so the desktop must supply them. Unproven on desktop.
2. The same 24 words give different keys in the two modes. An existing desktop wallet switched to block mode would
   lose sight of its funds and could no longer sign for its live swaps and pools.

So: new wallets can be block mode by default with a Classic mode switch, as in Pandamonium; existing wallets stay
classic unless the user deliberately moves (drain swaps, close pools, send funds to the new wallet).

## 8. Standing order and progress

Owner, 19 Nov 2026: build all phases in order; code-review after each phase; fix the findings; move on; loop until
complete. miniMall is kept. Nothing is pushed or released without the owner's word.

| Version | Phase | What |
|---|---|---|
| 0.18.65 | 0 | Split/Consolidate merged (D7) |
| 0.18.66 | 0 | Identifiers in full (ETH Wallet card), MxUSD label in miniMall, Vestr address whole |
| 0.18.67 | 0 | One signing queue for the whole app, under `rpcCall` |
| 0.18.69 | 1 | The shell: Pandamonium tokens, toolbar, six tabs, footer, app tray (pushes the screen aside), overflow menu, host bar, system light/dark; existing views moved into their places; dev preview under scripts/dev-preview |
| 0.18.70 | 1 | Tray rows reorder by drag or Alt+Up / Alt+Down; Minima Core pinned; order saved |
| 0.18.71 | 1 | Apps tab: Internal list with a Hide switch per app (saved); Minima Core locked; no Freeze, no External |
| 0.18.72 | 1 | Node tab as the phone: NODE card (Status, Block, Block time, Connections, Incoming, Random peer), IDENTITY card (Key uses, Minima, App version), then the desktop controls and log |
| 0.18.73 | 1 | Comparison round against the Fold captures: toolbar and tray title weight, MINIMA label baseline; preview captures refreshed |
| 0.18.74 | 0 review | P2P Chance: a wallet with the setting off but bets on the chain is found by a read-only look and settled; the key cache only grows; the card says "settled" |
| 0.18.75 | 0 review | Signing queue: `sign`, `signfrom`, `txnauto` and `txnpost burn:` queued; a signer lost to a timeout holds the queue until `block` answers; a queued AtomiX publish send is dropped once its action has given up |
| 0.18.76 | 1 review | Block time read from the node's Java date text (blank outside GMT/US zones before); the dev preview feeds the node's real format; `test:shell` wired into package.json and CI with executed tests |
| 0.18.77 | 1 review | Shutdown names the AtomiX swaps, live market and unconfirmed pool transactions it would interrupt (or says what it could not check); a stopped node shows a strip with Start node on every screen. Quit path not covered |
| 0.18.78 | 1 review | Overflow menu kept on sub screens and in tray apps; a hidden app's unread still lights the tray dot and shows on its Apps row; Wallet total, Faucet address, footer key uses and Node figures cleared on stop and restore; narrow tray is modal (`inert`); Wallet rows keep keyboard focus across the 15 s rebuild |
| 0.18.79 | 2a | Wallet tab: "Total balance" with the expand arrow and its breakdown; token rows carry icon, name, amount and the phone's one-line breakdown only (Split / Consolidate off the rows); `scripts/wallet-money-test.cjs` pins the send, split and consolidate command strings and guards from 0.18.78 |
| 0.18.80 | 2a | Coins dialog (exact figures, every coin with its whole id, LOCKED chips, sum check, Copy token ID) and coin detail (every field with Copy, raw JSON); Split and Consolidate are two buttons in the dialog with their forms and checks unchanged; the Send screen loses its mode switch; the old token page kept behind "Token details" |
| 0.18.81 | 2a | Token rows reorder by drag or Alt+Up / Alt+Down; Minima pinned; order saved and replayed as the phone's TokenOrder |
| 0.18.82 | 2a | Receive as the phone (Scan to receive, QR card, whole address, Copy, Get Address); the button runs `getaddress`, not `newaddress` (no new key per press); label field kept below |
| 0.18.83 | 2a | Send as the phone (Token, sendable, Amount with Max, To address, Send Funds; no Scan); handler unchanged from 0.18.78 apart from the button label, command strings pinned |
| 0.18.84 | 2b | History tab as the phone (header, Sync, status line, search incl. amount, rows with YOURS / CONTRACT / EXTERNAL and "Unverified", own dark palette); options: Export JSON, Export CSV, Import / merge (phone and desktop files, never overwrites), Hide foreign contract activity, plus the desktop's filter and copy; detail asks `txpow onchain:` ("Checking chain inclusion…"); store and normalisation untouched |
| 0.18.85 | 2c | Startup Params as the phone (Server, MegaMMR, Keets switches, extra arguments, Save / Save & Restart Node) over the reconfigure logic; RPC shown as always on with a main-process "Copy RPC password"; network, core fields and the full parameter editor under "All parameters"; no wallet fields on this screen; auto-resync switch left out (nothing behind it) |
| 0.18.86 | 2c | Backup & Recovery hub as the phone (Create backup, Restore from file, Chat backup, Mail backup, Resync node, Private keys), each its own screen; the Settings Wallet / Resync / Backup cards and the restore dialog moved here; `megammrsync` built in one function with every old check; backup password typed twice, letters and numbers; seed shown on request only and cleared on leaving |
| 0.18.87 | 2c | First run as the phone: launcher (New Wallet, Restore Wallet, Startup Params), "Your recovery seed", the words typed back in 24 boxes before the wallet opens, "Restore & resync" with guided word entry and the free-form phrase option; `renderer/wordentry.js` is the port of WordEntry / SeedEntry; same save, start and `megammrsync` sequence as the old wizard; Language button left out |
| 0.18.88 | 2c | Key mode (D1), capability-gated: `main/keymode.js` reads block support from the node jar (false for today's jars); mode recorded once by `config.recordKeyMode`, never changed by any save; `-blockaskeyuses -lowram` only for a block wallet on a supporting jar; start refused on a downgrade, a folder of the other mode, no wallet, or a hand-passed key-mode flag; flags refused in extra arguments; Classic switch and the restore mode question only when supported; tray line shows the true mode |
| 0.18.89 | 2c | Settings restyled with the shell tokens (eyebrow and card per section, Open at login as a switch); the Diagnostics command box removed (Terminal is the one command line); app-only sections no longer wait for the node |
| 0.18.90 | 2a/2b review | History import: refused whole when it would pass the 200,000 row cap (nothing written, numbers shown), one write, ids `0x` + 64 hex in upper case, every field rebuilt from checked values (bad records left out and counted), imported rows marked so the node's own row replaces them on sync and they are trimmed first |
| 0.18.91 | 2a review | Wallet list: drag re-checked after the balance read, a drag whose row is gone or a node stop clears it (no frozen list); coins dialog: a failed sendable read claims nothing (no "sendable" title or line, footer says so); footer sum compared with a fresh confirmed + unconfirmed, warning only from two agreeing reads |
| 0.18.92 | 2a/2b review | Split dialog: focus in and back, one at a time, no close or second submit while the split is with the node, no lookup on the closed dialog; coins dialog and coin detail open once; every confirm queued one at a time with focus on Cancel and Escape; Tab kept inside these dialogs (`modalTab`); dashes out of the Send, Split, Consolidate and History detail text |
| 0.18.93 | key-mode audit | Audit H1, H2, M3: `keymode.argvProblem` checks the finished argv of either node kind (the Parlons args string tokenised as the jar does): key-mode tokens exactly the recorded mode's, `-data` / `-basefolder` the install's own; parameter values starting with a dash refused; `-blockaskeyuses true -lowram true` with explicit values; managed parameters and `-conf` refused in extra arguments; every `-conf` file read and checked; node spawned without `MINIMA_*`, `PARLONS_*` and JVM option variables |
| 0.18.94 | key-mode audit | Audit H4, M5: block folder marked at every start before java (folder change, lost config, older config, deleted marker all tested; an unmarked folder with data is refused, never guessed); `verifyKeyMode` reads the running node's key shapes with `keys` before the app calls it running and stops it on a mismatch, with a blocking message and no restart in that run; the node's block-mode boot line kills a classic wallet's node |
| 0.18.95 | key-mode audit | Audit H3, M4: Restore from file asks the backup's key mode on every node and the main process (`main/restore.js`, `mcd:restoreBackup`) refuses a mismatch with the recorded mode, and a block backup on a classic-only jar with what to do instead; `restore`, `restoresync` and `megammrsync file:` refused on the general command channel; the backup file is encrypted throughout, so it cannot reveal its mode; the wrong-mode note corrected |
| 0.18.96 | key-mode audit | Audit M1: wallet replacement (file, seed, first run, Terminal) refused in the main process while AtomiX swaps, a maker order, OTC work, unconfirmed PandaPools transactions or P2P Chance bets are open, each named in full, unreadable = refused; `atomix.sqlite` and `mail.json` moved aside as `…-legacy-keys-YYYYMMDD` instead of deleted / emptied; `pandapools.sqlite`, chat and shop untouched |
| 0.18.97 | key-mode audit | Audit M2 and lows: every `megammrsync action:resync` runs through `node.runResync` (the node's own shutdown is expected; restart by the ordinary guarded start; refused or unanswered resync restarts nothing); footer and screens say what the node is doing; `;` refused in the restore file path, password and seed phrase; backup password rule and the restore command built and checked in the main process |
| 0.18.98 | 3a | Dexicon engine vendored: 37 files byte for byte from `mds/dexicon` 0.0.89 (`security/2026-11-07`, `500dd24344a3739472eccbefb0c684bed2aa2930`) under `main/dexicon/`; donor parity script, committed digest manifest (overall digest `3e424587a087fa888edc0b28b94f994d98b22d052e2123571994cb325ece1e12`), `npm run test:dexicon` in CI; nothing loads it yet |
| 0.18.99 | 3a | Dexicon engine hosted (`main/dexicon.js`, public port of DexiconPro's host): node only through `rpcCall`, https to the user's relays and `api.mexc.com`, store `userData/dexicon/dexicon.sqlite`; starts and stops with the node; wallet replacement refused while Dexicon orders or takes are open, store moved aside afterwards; `dxCommand` bridge with a 21-verb allow-list; auto-cross as in the MiniDapp (owner: own pool allowed), a LIMIT that would fill an own order refused in the bridge; analysis in `docs/DEXICON_ENGINE_NOTES.md`; 15 tests on a stand-in node. No screens |
| 0.18.100 | 3b | Dexicon chrome: full screen with no shell bars; header, version pill (engine 0.0.89), Dexicon's own dark / light theme, ✕; status strip with the block; room pills ① MxUSD ② Pools ③ Exchange (① ② = the existing panels, unchanged, until 3c / 3d); bottom tab bar for ③ with per-room tab memory |
| 0.18.101 | 3b | ③ Exchange, Trade: reproduced from the Android screen (the MiniDapp page was captured beside it and does not match); the page runs unchanged and hidden in a sandboxed `dxroom://` frame as the taker's engine (pinned by `scripts/dexicon-page.manifest.json`, no network, no `window.mcd`), driven through nine named actions; one-click FAST takes with the review shown before the click; on-chain trades confirmed by the page's own review text; amounts cut, never rounded |
| 0.18.102 | 3b | ③ Exchange, Orders and History: open orders (takes sent, FAST, on-chain) with reviewed change-price and cancel; the market maker card, its dialogs hosted from the page (the mirror of the Android dialog); fills marked WAITING until a block holds them; the net of settled trades; Export CSV with the Android column names |
| 0.18.103 | 3b | ③ Exchange, Activity / Assets / Settings: activity lines with the engine's own stage machine (`lib/activity.js`, verbatim) so posted is never shown as done; funds with their breakdown, receive address and trading ID whole; relays with add, discover, remove and their state |
| 0.18.104 | 3b | Comparison round against the Fold and phone captures (Dexicon dark and light, 932 x 704 and 1440 x 900); a message no longer follows the user across tabs; differences kept on purpose listed in the changelog |
| 0.18.105 | 3 engine | Dexicon engine and page re-vendored from `mds/dexicon` 0.0.91 (`9a95eb114ad35d3e18692a60c248529762fd72d5`; 38 engine files, digest `9dcf6fa233f9f74c7ae3113cdbbe90b58cb65758c2c2d94fdb8dbf232122ab08`; 20 page files): an order routes past the user's own on-chain orders (`lib/ownskip.js`), the bridge's own LIMIT refusal removed; MEXC price via CoinGecko when MEXC cannot be reached (`api.coingecko.com`, one path, GET), source carried in the read model |
| 0.18.106 | review | HIGH: old Dexicon store trading on a new wallet. Stores reset by the main process inside `runResync` with the node stopped (mail, PandaPools, AtomiX, Dexicon, P2P Chance), also when the result is unknown; the engine is dropped at every node stop; a store of another identity is never READY (moved aside, clean start); a failed move blocks the start and is said on screen; `mcd:dxInvalidate` removed |
| 0.18.107 | review | MEDIUM: a signing command still queued when an engine is stopped or its wallet replaced is never sent: an `AbortController` per engine epoch, its signal on every `rpcCall`, in `main/dexicon.js` and `main/atomix.js`, the same one-field signal in `main/pandapools.js`; `main/atomix.js` also gained the entry check it lacked, for commands and SQL) |
| 0.18.108 | review | MEDIUM: Dexicon's relay traffic takes no slot of the shared four-slot net pool (`ownCap`); its own lanes in `main/dexicon.js`: WORK 2, POLL 3 (the long polls); refusals to takers low priority, at most 32 waiting, oldest dropped, nothing signed ever dropped; 30 s backstop per request |
| 0.18.109 | review | The taker's hidden page is made as soon as the engine is ready on any tab, kept across tabs, remade when the engine changes (`dxStatus().epoch`), retried and reported in the status strip when it does not load; `activeWork()` counts takes awaiting an answer from the store; the Shutdown warning names them (`mcd:dxWork`). Not as reported: the service already voided unanswered takes without the page (`voidSweep`) |
| 0.18.110 | review | Lows: the screens' SQL is an allow-list (`ax_kv` statements and one read of `fill_state`); the identity secret is derived in main and put straight into the page's frame, never an IPC answer; a Dexicon that cannot be checked no longer blocks a restore for ever (named, then skippable after a warning, re-checked in main); SSRF guard decodes IPv6-embedded IPv4 in every spelling; the loader header says the vm is not a boundary; the on-chain engine's start never overlaps its retry. Not done: removing the raw verb path from the frame (the page signs its own takes) |
| 0.18.111 | 3c | Room ① is AtomiX as the phone draws it, over the desktop's own engine and data (`renderer/dexicon-ax.js`): its bottom bar, the ⇄ currency pill, the launch banner (no automatic switch: a switch signs) and Swap (Sell / Buy, You send ⇅ You receive, slippage 2 / 4.2 / custom, review with every maker key whole, YOUR SWAP, IN PROGRESS with Refund now, Check now and hide). The old panel is no longer drawn. Calls pinned old against new in `scripts/dexicon-ax.test.cjs` |
| 0.18.112 | 3c | ① Market: YOUR OFFER, the order book with maker keys whole and tap-to-take (opens Swap on that side, as the old panel), Edit my order / Publish / Withdraw, the old editor's every field with the same `axMakerSave` arguments (pinned against the old editor), the price chart, the "buys declined" coin warning |
| 0.18.113 | 3c | ① OTC: my availability (Go live / Update / Withdraw), the LP board with ids whole and Buy / Sell, my deals with Accept / Counter / Reject; the old panel's four calls with the same arguments (its own propose function run beside the new one); Counter added on the engine's existing call |
| 0.18.114 | 3c | AtomiX in the shared screens: swaps (taker and maker) in Activity and History with Check now, Refund now and hide; the AtomiX CSV byte for byte the old file; the Ethereum wallet in Assets (address whole, Fund / QR, Send ETH and USDT through `axSendReview` then `axSend`, Export key), coins and Consolidate (the wallet's own); the AtomiX card in Settings |
| 0.18.115 | 3c | The identity halt shown at last: `status().halt` (read only) and the phone's halt card with the keys whole, Export the stale ETH key and Sweep to the node wallet; trading refused while halted, settlement never; no reset offered (none exists that keeps the claim secrets in place); the Market offline alert with Start the node |
| 0.18.116 | review | M2: a wallet-replacing megammrsync holds AtomiX, PandaPools and Dexicon first (`hold()` / `release()`), and the stores are set aside only when the wallet is another one (`node-manager.walletMark` before and after, `walletSettle`); a failed, refused or repeated restore on the same wallet moves nothing; an unanswered command stays watched |
| 0.18.117 | review | H3: `dexicon.stop()` drains (what is at the node and on its way to a relay ends before the engine is dropped; the node is told to quit after it); a maker's `txnpost` the node never answered is recorded as an `unknown` fill, the order reduced, and settled from the chain (`settleUnknown`); AtomiX and PandaPools wait for their commands before `quit` |
| 0.18.118 | review | H1 + H2: the Trade ticket plans on the page's own FAST book (`mds.js` report `fast`), `place` carries `expect` / `take` / `worst` and the page re-checks its own `crossing()` before signing; a reviewed take cannot become a resting order; one money action at a time on the screens and in the page; the amount field follows the page after a FAST action; room ① Refund now and wallet actions one at a time |
| 0.18.119 | review | H4 + M1: a relay message may be 256K characters (`netfetch.postText` `opts.maxBody`, passed only by the Dexicon host past its relay allow-list); the page's 25 s long-poll hold is cut to 10 s in `mds.js`, under netfetch's 15 s idle limit |
| 0.18.120 | review | M3 + M4: the Dexicon store is `dexicon-<trading identity>.sqlite`, one per wallet, with a one-time rename of `dexicon.sqlite`; `main/dexicon-signgate.js`: a `txnsign` / `txnpost` from the page is forwarded only for a transaction the page created that the node shows as paying this wallet alone, or as a take of a live order the service knows, inside the trade just reviewed on the native screen (`op: "reviewed"`) |
| 0.18.121 | review | Lows: "pay at most" sums the per-take round-ups (`plan.pay` / `plan.get`); ladder Total cut (`levelTotal`); `editChain` refuses more than 6 decimals; a number with a comma or two points is refused, not repaired (`entryProblem`, room ① `cleanNum`); bridge calls carry and are checked against the engine epoch; the page's notices are shown on Orders (`pageSays`) |
| 0.18.122 | 3d | Room ② and Swap: `renderer/dexicon-pp.js` (Core / Act / screens, as `dexicon-ax.js`) over the same `ppQuote` then `ppSwap(quoteId)`; the five PandaPools tabs in `DexCore.ROOMS`; one gate `DexCore.money` for rooms ①, ② and ③; glue read-only additions `status()` and `lastNodeFailure()` (`mcd:ppStatus`, `mcd:ppWhy`); the old panel no longer drawn; `scripts/dexicon-pp.test.cjs` | |
| 0.18.123 | 3d | Pools list: `poolCard` / `combinedCard` / `poolsSummary` over `ppPools`, `ppAggregate`, `ppScan`; addresses whole with `data-copy` | |
| 0.18.124 | 3d | My LP: `lpSummary` / `lpRows`; `Act.deposit` / `withdraw` / `collect` / `collectNow` / `recover` / `retire` / `unretire` / `confirmSigning` / `statement` over the old panel's calls (`ppDeposit`, `ppClose`, `ppCollect`, `ppRecoverSaved`, `ppRetirePool`, `ppConfirmSigning`, `ppStatement` then `exportCsv`), each behind `DexCore.money`; the calculator is `renderer/poolcalc.js` unchanged | |
| 0.18.125 | 3d | Backup, restore, recovery: `Act.backup` (`ppSaveBackup(password)` after `backupProblem`), `loadFile` / `extractNode` (`ppLoadBackup(password[, true])`), `restore` (`ppRestore(json)`), `archiveGet` / `archiveSave`; `ppCompleteBackupRequired` read and said; `plainCode` strips internal codes | |
| 0.18.126 | 3d | Create in four steps (`STEPS`, `Act.createOpen` / `createPriced` / `createManual`: `ppCreateAnchor`, `ppCreatePreview`, `ppCreate(tokenid, decimals, x, y)` with the old `derive`), then the forced backup; `Act.migrate` (`ppMigrate(address, a, b)`), then the backup; BACKUP_REQUIRED returns the flow to the owed backup | |
| 0.18.127 | 3d | Wallet: `walletCard` over `balance` and `getaddress`; Consolidate through `consolidateToken` (app.js: confirm, `ppConsolidationCheck`, `consolidate tokenid:`) behind `DexCore.money`; a balance opens `showCoins` | |
| 0.18.128 | 3d | Activity: `actItem` / `feedItem` over `ppActivity` and `ppFeed`; `DexPools.part("activity" | "history")` in the shared screens; glue `activeWork()` (rows, `[]` with no store, `null` = could not be checked) used by `walletWork` (restore gate) and `mcd:ppWork` (Shutdown warning) | |
| 0.18.129 | 3d | Comparison round: Collect moved into the recovery tools (phone order), token marks on the Wallet cards; all room ② captures retaken (`scripts/dev-preview/shots/*-pp-*.png`); node checks added to section 9 | |
| 0.18.130 | 3c | Review H1: `whileHalted` beside `whileHeld` on swapExecute, makerSave, makerPublish, otcGoLive, otcPropose, otcDealAction accept/counter (live `identitywatch.halted()`), a per-part check in a sweep, `gateEngine` wrapping the engine's `executeOtc` (the ACCEPT-in-poll path); notify raises update; `maker.js` + `peg.js` re-copied from atomix-mds 0.1.60 (03d5665); tests in `scripts/dexicon-ax.test.cjs` (H1 x3) | |
| 0.18.131 | 3c | Review M2: `prelock()` / `takeResult` in `renderer/dexicon-ax.js` (known pre-lock refusals only say "Nothing was locked"); `swapExecute` buy sweep returns `reasons`; test "M2" in `scripts/dexicon-ax.test.cjs` | |
| 0.18.132 | 3c | Review M3 + M4 + M5: `historyList` (finished and hidden, Unhide); `haltCard(h, swaps)` rewritten from the facts (which key, settles / does not, each unfinished swap with hash and deadline, tools for every instruction); `stoppedNote` / `offline(…, swaps)` with the count and the nearest deadline, swaps read with the node off; `projectRow` adds `timelock`, `legIsMinima`; tests M3, M4, M5 | |
| 0.18.133 | 3c | Review M6 + lows: `lpPick` (LP by id and sizes, checked twice); `terminal()` leaves an in-window ERROR unfinished (`inWindow` from the glue); `launch` computed (`status().otcOffer`); `otcWithdraw` returns `posted`; save / publish failure wording; `rungSize`; `busyWhile` (no private gate); switch clears `S.otc` and the offline flag; tests "M6" and "lows" x4 | |
| 0.18.134 | 3c | Wide-layout comparison for room ① (captures `09b`, `09c`, `10b` of 19 Nov): phone wording on Market and OTC, `midLine`, explainers open until folded, maker keys at the outer edges, OTC fields as a line; all dev-preview shots retaken; test "wide layout" | |
| 0.18.135 | 3d review | Review H (token identity): `tokLabel` marks every token but the real id "(not MxUSD)", `pairName` carries the whole token id, `skeleton` / `imitates` (NFKD, zero-width and control stripped, Cyrillic and Greek look-alikes) add the review's warning line, `pairs` puts MxUSD first, `chosen` holds the selection by token id (a lost id selects nothing); glue `labelById` / `relabelSwap` label records by id, `mx()` no longer applied to records; tests "a look-alike token is never MxUSD", "the glue labels a token in a record by its id" | |
| 0.18.136 | 3d review | Review H (Add liquidity): one MINIMA field; `depositToken` (the engine's rule, cut to the token's decimals) as the live estimate and in the review; empty or zero refused before the question; glue `depositUsed` returns `minima` / `token` and writes them into the ADD record; swap review and result print `q.totalIn`; tests "Add liquidity: one MINIMA amount…", "swap: the review and the result print the amount the pools take" | |
| 0.18.137 | 3d review | Review H (restore gate): `status().error` / `waitedMs` and `setAsideStore()` in `main/pandapools.js` and `main/atomix.js`; `pandapools.ownPools()`; `restore.activeWorkList` names an unopenable or stuck AtomiX / PandaPools store with the skip hint, lists own open pools with `CONFIRM_HINT`; `restore.skipWarning`; `mcd:engineSetAside`; `DexCore.storeError` shown in rooms ① and ②; `invalidate()` moves an unopenable pool store aside; tests "a pool store that cannot be opened", "AtomiX's store gets the same treatment", "a live pool of this wallet" | |
| 0.18.138 | 3d review | Review mediums: `Act.createRefresh` (anchor and balances re-read at Review; old vs new, review again; `createAnchor` returns `at`); glue `withTimeout` on `statement`, `restore` / `recoverSaved`, `retirePool`, `confirmSigning` with `NO_ANSWER`; `reading()` for the statement and the reserve check (no money gate); `noAnswer()` in the screen; coins dialog refused while `C.gate.on`; tests "create: the opening price and the balances are read again at Review", "a glue call the engine never answers ends with 'no answer'" | |
| 0.18.139 | 3d review | Review lows + room ① residual: `UNAVAILABLE_KEY_MSG` and `whereConfirm` (the button is on the pool card); `backupEnd` and `form()` resolve `{ pending: true }` when closed while working; `gateEngine` ends a halted OTC execute through `otc.reject` (REJECTED, REJECT message), tested with the halt cleared and `expireStale` run 11 minutes on; tests "a message never sends the reader to a menu entry that does not exist", H1 extended in `scripts/dexicon-ax.test.cjs` | |
| 0.18.140 | 3e | No script reaches a node unnamed: `scripts/test-node.cjs` (`AX_TEST_NODE_RPC`, `AX_TEST_NODE_CONTAINER`, `AX_TEST_NODE_I_OWN_THIS=yes`, plan printed first), the two AtomiX gates and `cdp-eval.js` behind it; `atomix-unit.js` frozen quote hermetic on `mockNode()`; `scripts/no-reach.cjs`; `scripts/hermetic-test.cjs` (7); `scripts/dev-run.sh` + `docs/DEV_RUN.md`; `main/testprofile.js` (TEST profile: userData, keychain service, app name, no login item, no update feed, TEST title / tag / badge) |
| 0.18.141 | 3e | `docs/DEXICON_PARITY_AUDIT.md` (237 items); restores (OTC Withdraw always, recover message kept, requote on engine update, K/KMIN number, stop-other-copies sentence, statement progress, chart on theme change, `ax_theme` read once); fonts moved to `dexicon.css`; removed `renderer/atomix-ui.js`, `atomix-ui.css`, `pools.js`, `pools.css` and their wiring; fixtures `scripts/fixtures/old-atomix-panel.json`, `old-pools-panel.json`; `panels-test.cjs` rewritten (9 tests); `keets-test.cjs` split (deps required in CI / `KEETS_REQUIRE_DEPS=1`); `pandapools-parity-check.cjs` and `pandapools-recovery.test.cjs` read room ② |
| 0.18.142 | 3e | Quit warning: `main/inflight.js` (`inFlight`, `decideQuit`) for Shutdown and Quit; `before-quit` asks ("Quit anyway" / "Stay open"), not for a system quit (`powerMonitor` shutdown, `session-end`) or a stopped node; `mcd:inFlight` replaces `mcd:ppWork` and `mcd:dxWork`; `atomix.activeWork()` gains `nearestMs` / `nearestApprox`, `dexicon.activeWork()` gains `unknown`; `shutdownWarning` removed from `app.js`; `scripts/inflight-test.cjs` (8) |

Phase 0 change of scope: the data folder is not pinned, because the app is not being renamed (D2).
Known failures that predate this branch (fail on `origin/master` 0.18.64): `scripts/panels-test.cjs` "overlay sites";
`scripts/atomix-unit.js` "frozen quote issues a replayable quoteId" (0.18.140: it "failed" only where the container
it ran `docker exec` into was missing; it is hermetic now and passes everywhere).

Owner decisions added 19 Nov 2026 (evening):
- The Parlons node stays the base node. A block-capable `parlons-node.jar` is being built (see `docs/JAR_PROOF.md`).
- Parlons opens in the system browser from the tray (the node's one-time ticket link), not in an embedded view.
  Phase 4 removes the embedded webview and its media-permission code. Calls and call notifications then belong to
  the browser tab.
- The app keeps a notifier for Parlons calls and messages while the panel lives in the browser: a desktop
  notification (and dock/taskbar attention for a call) raised by the app; clicking it opens the Parlons panel in the
  browser. Phase 4 must find how the app learns of them from the node without the embedded view.

Owed items (recorded 19 Nov 2026 with the room ② review; none of these is built or fixed here):
- Pool recovery tools the phone has and the desktop lacks: "Check a backup file", "Recover & withdraw" and
  "Recover on existing wallet". The desktop has Collect, Back up, Restore pools from a file, Archive connection and
  the guide.
- Android gaps reported by the review (other repos; not checked or changed from this branch):
  - `apks/atomix` and `apks/dexicon`: OTC propose and counter have no engine-level halt check.
  - `apks/dexicon`: `OtcTab.refuse()` does not check the halt at all.
  - `apks/dexicon`, `apks/pandadex`, `mds/pandadex-mds`: on-chain routing over the user's own orders.
- A store set aside because it could not be opened (0.18.137) gets the dated name of a replaced wallet's store
  (`-legacy-keys-YYYYMMDD`); a name of its own is owed.
- Look-alike token names outside Cyrillic and Greek get the "(not MxUSD)" mark and the token id, but not the extra
  warning line (0.18.135).

## 9. Checks that need a real node (owner, on the dev node; nothing here is proven yet)

Phases 0 to 2 were verified by tests and a browser preview only. The app has not been launched.

- [ ] The app starts, shows the shell, and every moved view opens (tabs, tray apps, overflow menu).
- [ ] Drag to reorder: tray rows and Wallet token rows.
- [ ] Send, Split and Consolidate on small amounts; Receive's Get Address.
- [ ] History: sync, export, import of the exported file, a transaction's chain-inclusion check.
- [ ] Shutdown warning names a live swap / maker order / pool operation; Start node afterwards.
- [ ] Block time and footer time show in the local timezone.
- [ ] `-blockaskeyuses true -lowram true` is accepted by the new jars, inside the Parlons args string too.
- [ ] `keys` over the Parlons admin RPC shows 64/3 (classic) or 128/4 (block) on real wallets, and nothing else.
- [ ] The node starts with the stripped environment, including the keets sidecar.
- [ ] megammrsync: whether the node exits, and that the app restarts it cleanly, including a sync over 180 s.
- [ ] Restore from seed and from a backup file end to end; the mode question; the refusal while a swap is open.
- [ ] P2P Chance settle-only on a wallet that has an open offer (it should be withdrawn automatically).
- [ ] `pandapools.activity()` rows carry `txpowid` and `confirmed:false` while pending (the Shutdown warning uses it).
- [ ] Dexicon engine (0.18.99, never run on a node): it boots with the node (log line "booted" with the public id in full), reads the keys, the on-chain book and the pools; the price line is fresh.
- [ ] Dexicon relays: publish, the inbox long poll, a take from another node co-signed and settled; the three default relays answer over https without a redirect.
- [ ] Dexicon and the other engines on one wallet: a coin chosen by two engines at once ends in a refused `txnpost` (expected `status:false`), a `txndelete`, and no stuck claim.
- [ ] Dexicon on a block-key wallet: `keys action:list` lists the keys that own the user's on-chain orders (the own-order rule and My orders depend on it).
- [ ] Dexicon after a wallet restore: `dexicon.sqlite-legacy-keys-YYYYMMDD` is beside a new, empty `dexicon.sqlite`; the refusal while an order is on the chain.
- [ ] Dexicon page frame: `dxroom://exchange/index.html` loads in the packaged app (asar), the page boots its identity, and no console error about the content security policy appears.
- [ ] Dexicon Trade on the dev node: a FAST order rests and shows on a second node; a FAST take against another node's order co-signs and settles; a take the maker never answers is voided after 5 minutes; an on-chain trade through a pool shows the page's review and settles.
- [ ] Dexicon relays: add, discover and remove; the page's relay traffic passes the host's allow-list for a relay added a moment ago (the service takes up to one tick to learn it).
- [ ] Dexicon market maker: the page's dialog opens over the screen in both themes, saves, and STOP withdraws the ladder.
- [ ] Dexicon Export CSV: the save dialog, and the file read by the reconciliation tool.
- [ ] **First (0.18.110):** the Dexicon page gets its trading identity. Open Dexicon after the node is running: the Trade screen must not say "The trading identity could not be read", and Assets shows the trading ID. The seed is put into the `dxroom://` frame by the main process (`executeJavaScript` in a sandboxed frame under its CSP); this was never run in Electron. If it fails, FAST trading does not start (nothing falls back).
- [ ] Engine 0.0.91 (0.18.105): with an own on-chain order at the best price and another party's behind it, a BUY / SELL "BOOK / POOL" fills the other party's; with only own orders inside the limit the screen says "Only your own orders are at this price…" in the ordinary colour and nothing is sent.
- [ ] Price fallback (0.18.105): with `api.mexc.com` blocked (hosts file or firewall), the Trade screen and Settings read "MEXC price via CoinGecko" and the market maker's feed line says "MEXC via CoinGecko mid (MEXC direct unreachable)"; unblocked, they go back to "MEXC price".
- [ ] Wallet replacement (0.18.106), each on the dev node with a live FAST order and the market maker on: (a) restore a seed and close the window while megammrsync runs; (b) quit the app in the middle and start it again. Afterwards the log has "wallet replaced: … were reset in the main process" or "NOT STARTING on this store … moved aside", `dexicon.sqlite-legacy-keys-YYYYMMDD` exists, Orders is empty, the market maker is OFF, and no order of the old wallet is republished (watch the relay book for 2 minutes).
- [ ] megammrsync (0.18.106): after the node answers, the app stops it itself, resets the stores, then starts it. Check that the node's own shutdown and the app's `quit` do not collide (no "node exited unexpectedly"), and that `seedrandom` after the restart is the NEW wallet's (Assets, trading ID differs from before).
- [ ] After any node restart (0.18.106): Dexicon comes back by itself within a few seconds ("booted" in its log again); a FAST order placed before the restart is still in Orders.
- [ ] Refused SQL (0.18.110): after using every Exchange tab, the market maker dialogs and one take, Dexicon's log has no "refused SQL from a screen" line. If it has one, that statement must be added to the allow-list in `main/dexicon.js`.
- [ ] Relay long polls (0.18.108): the page asks a relay to hold a poll for 25 s; the app ends an idle request at 15 s. Check the relays' state in Settings stays "OK" over five minutes and the log has no "inbox poll … failed" every 15 s.
- [ ] Lanes (0.18.108): while Dexicon is polling, an AtomiX swap's Ethereum calls are not delayed (AtomiX log: no gaps of more than a few seconds between its RPC lines).
- [ ] Taker's page without a visit (0.18.109): start the app, stay on the Wallet tab for a minute, then open Dexicon: Trade is ready at once (no "still starting"), and a take left unanswered before the restart is gone from Orders after 5 minutes.
- [ ] Shutdown (0.18.109): with a take sent and not yet answered, Shutdown names "1 Dexicon trade is sent and not yet answered".
- [ ] Restore override (0.18.110): rename `dexicon.sqlite` to a text file's content (a damaged store), start, wait two minutes, try Restore from seed: the refusal offers to go on, the warning is shown, and after it the damaged file is beside a new store under its dated name.
- [ ] Room ① (0.18.111 to 0.18.115, never run on a node): with swaps in flight from the old panel, open Dexicon after the update: every swap is in Activity with the same amounts, and settles; the ⇄ pill shows the market the engine is on.
- [ ] Room ① Swap: a buy and a sell of a small amount, one part and two parts; the review lists the makers; after "Start swap" the stages and the IN PROGRESS card move to DONE; a quote older than two minutes is refused with "review the swap again".
- [ ] Room ① Market: Edit my order, Save & publish, the offer shows "Live" with its levels within a block or two; Withdraw asks, then the offer leaves the book; pegged mode follows the price line.
- [ ] Room ① OTC between two nodes: Go live, a proposal, a counter, accept; the deal settles as a swap in Activity. Reject on the other side.
- [ ] Room ① Assets: Send a small ETH and a small USDT amount (the transaction hash in the message is the one on the explorer), Max, Export key, Fund / QR, Show coins, Consolidate.
- [ ] Room ① AtomiX CSV: the file opens in the reconciliation tool (`tools/dexHistory`) with no column error.
- [ ] Room ① ⇄ switch with a live market: the old market is withdrawn first, the room changes colour, the MINIMA banner appears after a restart while that market is live.
- [ ] Room ① halt card: cannot be provoked safely on a funded wallet; on the dev node, restore another seed under a running AtomiX store copy and check the card, Export the stale ETH key and Sweep.
- [ ] Room ① Market offline: stop the node with a market published: the card appears, Start the node brings the market back.
- [ ] Restore, same wallet (0.18.116): with a FAST order and a finished AtomiX swap in the stores, Restore from seed with the SAME phrase: after the restart `atomix.sqlite`, `pandapools.sqlite` and the Dexicon store are the same files (no `-legacy-keys-` copy made), the swap history and the order are still there, and the log says "the wallet is the same one as before".
- [ ] Restore, another wallet (0.18.116): Restore from seed with another phrase: the log says "the node now holds ANOTHER wallet" before the node is shown as running, each store has a dated `-legacy-keys-` copy, and the engines start empty.
- [ ] Restore, megammrsync longer than 180 s (0.18.116): the screen says the node did not answer; AtomiX, PandaPools and Dexicon go on meanwhile; when the node has finished and is restarted the stores are set aside only if the wallet changed. Also confirm `seedrandom modifier:minimacore-desktop-wallet-mark-v1` answers on a block-key node and what it answers on a password-locked one.
- [ ] Stop during a fill (0.18.117): two nodes, one with a FAST order; take it from the other and press Stop node on the maker within the same second. After the restart the maker's History holds the fill (WAITING, then DONE), the order shows the reduced amount, and the taker saw "co-signed". Repeat by killing the java process instead: the fill shows UNKNOWN, the order is reduced, and it turns DONE or LOST by itself.
- [ ] Stop while idle (0.18.117): Stop node and Quit with Dexicon open and nothing in flight take no longer than before (the log has no "still working after 15 s" line).
- [ ] FAST review (0.18.118): with two nodes, review a BUY against the other node's ask, cancel that ask on the other node, then click: the screen says "The book changed since you reviewed this" and no order appears in My open orders. The reverse: review a resting order, publish a crossing ask from the other node, click: refused the same way.
- [ ] Double click (0.18.118): double-click and hold Enter on BUY / SELL for a resting FAST order: exactly one order in My open orders. After a partial sweep the amount field shows only the remainder the log names as not traded.
- [ ] Large take (0.18.119): take a FAST order with a wallet whose coins force three or more inputs (or a multi-key order): the take is answered; the log has no "no relay accepted the take". Note the real size of a take (the service logs "take received … (N bytes)").
- [ ] Quiet book (0.18.119): leave Dexicon open for five minutes on a book with no changes: the Trade screen stays "● live", Settings shows the relays as answering, and the relay's access log shows a poll about every 10 s per relay, each answered 200.
- [ ] **First (0.18.120): a FAST take still goes through.** Take a FAST order as BUY and as SELL. If the Trade log says "Refused by the app's signing check", copy the whole line: the check reads `txnlist id:` and expects each coin with `address`, `tokenid` and, for MxUSD, `tokenamount`. Dexicon's log must have no "REFUSED from the Dexicon page" line after ordinary use (takes, a void after 5 minutes, a cancel).
- [ ] Void (0.18.120): send a take to an order whose maker is offline; after 5 minutes the page voids it (a self-send is signed and posted without any review).
- [ ] Store per wallet (0.18.120): after the update the folder `dexicon/` holds `dexicon-0x….sqlite` and no `dexicon.sqlite`, with the orders and fills of before. Point the node at another data folder: a second file appears and the first is unchanged; back again: the first wallet's orders and History are there.
- [ ] Lows (0.18.121): type 1,234.5 in Amount: the field keeps it, the ticket says why, the button is off. In Orders, open the market maker, save a ladder with the node's MEXC price unavailable (or any refused save): the page's sentence appears on the Orders tab.
- [ ] Room ② carry-over (0.18.122 to 0.18.129, never run on a node): with a live pool made by the old panel, open Dexicon ② after the update: My LP shows the same pool, address and owner key; `pandapools.sqlite` is the same file; the pool is still found by another node; an old backup file still restores.
- [ ] Room ② swap: sell and buy MINIMA against a pool; the amounts in "Confirm swap" are the amounts that arrive; Activity goes from Confirming to on-chain. Move a pool between the review and the click (a second node): the swap is refused and the balance is unchanged.
- [ ] Room ② create: with no pool, create one (four steps); the backup dialog follows; cancel it: My LP says a backup is required and a second create stops at step 1; save the backup: the second create goes through. Check the pool on the phone app with the same seed.
- [ ] Room ② add, migrate, close, collect: each once on a small pool; after Close the reserves reach the wallet by themselves, or by Collect withdrawn funds (now in Back up / restore pools).
- [ ] Room ② failure wording: provoke a failure (lock the wallet, or stop the node mid-action) and read the alert: it says whether funds moved, and "The node's last answer while this ran" names the real command and reason. Confirm no unrelated scan failure is shown there.
- [ ] Room ② Wallet: Consolidate with a healthy pool goes through; with an owner key paused it is refused with the reason and nothing is sent.
- [ ] One gate: start a pool swap and, while "Confirm swap" is open or the swap is posting, try Publish in ① Market and BUY in ③ Trade: neither does anything until the swap has answered.
- [ ] Shutdown and restore with pools: Shutdown right after a pool swap names 1 pool transaction; Shutdown and Restore from seed within the first seconds after the node starts (PandaPools not started) say the pool operations could not be checked, and the restore goes through once it has started.
- [ ] Halt (0.18.130, needs a node whose keys were replaced under a running AtomiX, dev node only): with the halt card up, Review swap, Publish, Save & publish, OTC Go live, Buy/Sell from an LP, Accept and Counter each answer "AtomiX is halted…" and nothing is sent; Refund now, Check now, Withdraw (market and OTC) and Reject still work. Propose an OTC deal, halt, let the LP accept: the deal stays "Agreed", no swap appears, `OTC execute failed` is in the log.
- [ ] Take outcome (0.18.131): review a swap, wait over two minutes, Start: "quote has expired … Nothing was locked." Start a buy with the Ethereum RPC unreachable (dev wallet, tiny amount): the alert names the reason and says "No lock was confirmed. Look at In progress before trying again.", never "nothing was spent".
- [ ] Truthfulness (0.18.132): hide a swap in flight: it is in History with Check now, Refund now (when due) and Unhide, and Unhide returns it to Swap and Activity. Stop the node with a swap in flight: the notice counts it and names the nearest deadline. Halt card on the dev node (keys replaced under a running AtomiX): read it against the real state of each swap.
- [ ] OTC rows (0.18.133): with two LPs on the board, focus a size field, wait for the board to change order, click Buy on a row: the dialog and the offer name the LP whose card was clicked, or "That LP's offer changed or left the board". Editor: type size 1234567.89: the rungs read 1234567.89. Close the editor during Save: the outcome is said on Market and the buttons are not usable meanwhile.
- [ ] Room ① wide (0.18.134): at the Fold's size, Market and OTC read beside the phone: explainer open, price line with bid / ask and age, keys at the outer edges, OTC fields as lines; fold an explainer and it stays folded after a restart.
- [ ] Token identity (0.18.135, dev node): create a token named "MxUSD " and a pool for it deeper than the MxUSD pools: Swap still opens on MINIMA / MxUSD; the other pair reads "MxUSD (not MxUSD) · token <whole id>" in the list, the pool line, Pools and the review, and the review carries "This token is not MxUSD. Its name imitates it."; select it, close its pool, rescan: nothing is selected and the screen says so. A swap of it reads "… (not MxUSD, token <id>)" in Activity.
- [ ] Add liquidity (0.18.136, dev node, small amounts): My LP, Add: one MINIMA field with the MxUSD estimate under it; Review with the field empty is refused in the form; add a small amount: the result line and the Activity record give the MINIMA and the MxUSD the pool took, and the wallet's MxUSD fell by that figure.
- [ ] Restore gate (0.18.137, dev node only, a COPY of a data folder): with a pool open, Backup & Recovery, restore another seed: the question lists the pool's whole address and reserves with "These pools belong to the wallet you are replacing…"; Cancel changes nothing. Restore the SAME seed and go on: the pool is still in My LP afterwards. With the app closed, overwrite `pandapools.sqlite` with junk and open: room ② shows why it cannot start; "Set the store aside and start empty" leaves `pandapools.sqlite-legacy-keys-<date>` beside a new store; the same for `atomix.sqlite` in room ①.
- [ ] Stale price (0.18.138, dev node): open Create a pool, reach Amounts, leave it open until MEXC has moved (or switch the network off for the second case), press Review: the old and new price are shown and Review must be pressed again; with no network, "could not be read again … Nothing was sent". While a swap is confirming its question, room ② Wallet's balance cards do not open the coins dialog. Export statement works while another room's action is open.
- [ ] Lows (0.18.139, dev node): with a pool whose signing is paused, Close: the refusal names "Confirm wallet signing state" on the pool's card. Start a pool backup and press Esc while it is being made: the note says it is not known yet, and the "backup required" notice goes away by itself once the file is checked. Halt + OTC (needs the halted dev node of the 0.18.130 check and a second node as LP): agree a deal as the proposer while halted: nothing is locked, the deal shows as rejected on both nodes, and it stays so after the halt is gone.
- [ ] TEST copy (0.18.140, owner): `scripts/dev-run.sh` on a new profile: it prints the folder, ports, Java and jar sha256, then a window titled "Minima Core — TEST PROFILE" with the red tag and the Dock badge opens while the installed app keeps running untouched. In Keychain Access: a `minimaCore TEST Safe Storage` entry and (after first run) entries under `com.eurobuddha.minimacore.rpc.test.…`; the real `com.eurobuddha.minimacore.rpc` entries and `minimaCore Safe Storage` unchanged (dates). Run it again with the TEST node still up from a kill -9: it refuses on the busy port.
- [ ] Live gates (0.18.140, owner, a throwaway node only): `AX_TEST_NODE_RPC=http://127.0.0.1:<port> AX_TEST_NODE_I_OWN_THIS=yes npm run gate:atomix` prints what it will send (the seed read first) and passes; without the variables it refuses.
- [ ] Removal (0.18.141, dev node): Dexicon ①, ② and ③ are drawn in Inter and JetBrains Mono as before (not the system font). ① OTC: with no offer live, Withdraw is there and posts a withdrawal. ② My LP: a pool card reads "K/KMIN 1.2 · healthy"; a paused pool says to stop other signing copies; Export statement says "Building the statement…" first; Check for reserves with the archive unreachable keeps its error on screen. ② Swap: type an amount, wait for another pool trade: the quote changes without typing. Switch the theme on ① Market: the chart's axis changes colour at once.
- [ ] Quit warning (0.18.142, dev node, small amounts): with an AtomiX swap in progress press Cmd-Q: the question names the swap and a clock time; "Stay open" (and Esc) leaves the app and the node running; "Quit anyway" quits after the node has stopped. With nothing in flight Cmd-Q quits with no question. Right after a start, before the engines are up: the question says "Could not be checked". After Shutdown from the menu, Quit asks nothing. Log out of the Mac with a swap in progress: no question is shown, the logout is not blocked for more than the node's stop, and Logs has "[app] quit asked by the system" with what was in flight (NOT proven here: that `powerMonitor` reports a logout before the quit arrives; if it does not, the question appears and the Mac says the app interrupted the logout). On Windows or Linux: closing the window asks the same question with the window still open.
