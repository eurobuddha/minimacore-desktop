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

Phase 0 change of scope: the data folder is not pinned, because the app is not being renamed (D2).
Known failures that predate this branch (fail on `origin/master` 0.18.64): `scripts/panels-test.cjs` "overlay sites";
`scripts/atomix-unit.js` "frozen quote issues a replayable quoteId".

Owner decisions added 19 Nov 2026 (evening):
- The Parlons node stays the base node. A block-capable `parlons-node.jar` is being built (see `docs/JAR_PROOF.md`).
- Parlons opens in the system browser from the tray (the node's one-time ticket link), not in an embedded view.
  Phase 4 removes the embedded webview and its media-permission code. Calls and call notifications then belong to
  the browser tab.
- The app keeps a notifier for Parlons calls and messages while the panel lives in the browser: a desktop
  notification (and dock/taskbar attention for a call) raised by the app; clicking it opens the Parlons panel in the
  browser. Phase 4 must find how the app learns of them from the node without the embedded view.

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
