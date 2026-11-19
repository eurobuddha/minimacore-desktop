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

Phase 0 change of scope: the data folder is not pinned, because the app is not being renamed (D2).
Known failures that predate this branch (fail on `origin/master` 0.18.64): `scripts/panels-test.cjs` "overlay sites";
`scripts/atomix-unit.js` "frozen quote issues a replayable quoteId".
