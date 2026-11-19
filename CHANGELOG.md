# Changelog

All notable changes to **minimaCore Desktop** — the cross-platform (macOS / Windows / Linux) Electron app that runs
a full minimaCore node locally with a native-styled wallet + module suite. Newest first. Each release is tagged
`vX.Y.Z`; since 0.13.0 the installers (`.dmg` / `.exe` / `.AppImage`) are built on GitHub Actions and attached to the
matching [GitHub Release](../../releases).

---

## [0.18.90] — History import: a file cannot push out, duplicate or outrank what the node gave

Review of 0.18.84.

- A file that would take the store past its 200,000 rows is refused whole, before anything is written, and the message gives the numbers. Before, the store trimmed its lowest blocks to make room, so a large or crafted file could remove real history, which is the only record of transactions the node has since pruned.
- The import is one write. Before, every 500 rows rewrote the whole database file.
- A transaction id must be `0x` and 64 hex digits (it was 1 to 128), and is held in upper case as the node writes it, so a lower-case id is the stored transaction and not a second copy.
- Every field of an imported row is rebuilt from a checked number, amount, id or address, down to each coin's token (a name and a decimals count only) and each state entry (port, type, data). A record with a wrong field is left out and counted in the result message. Before, a coin's token and state passed through as they were, and a null state entry made the detail screen fail.
- An imported row is marked. A sync does not treat it as already known, so when the node reports that transaction its own row replaces the imported one. If the store ever does have to trim for node rows, imported rows go first.
- `scripts/history-screen-test.cjs` runs the store itself (sql.js on a throwaway folder) for the refusal, the cap and the replacement.

## [0.18.89] — Settings: restyled, and the second command box removed

- Settings is laid out like the Node tab: a small heading and a card for each of This computer, Updates, Node, Signing keys, Address key uses, Address labels and History. Open at login is a switch.
- The Diagnostics card is removed. It was a second box for typing node commands; the Terminal is the one place for that.
- Updates, Open at login and the node choice no longer wait for the node to be running. The two key sections say "The node is stopped." while it is.
- An address label shows its whole address.
- Seed, resync and backup left Settings in 0.18.86 (Backup & Recovery); node settings are in Startup Params.
- The app is named "Minima Core" in the Settings text, as in the title bar.
- Dev preview: `?view=settings`.

## [0.18.88] — Key mode: recorded once, never switched, and nothing visible until the node supports it

Nothing changes for any wallet today. The node jars this build ships cannot run block-as-key-uses, so every wallet is classic and no new control appears. This release puts the rules in place for the day the jars can (see `docs/JAR_PROOF.md`).

- One function answers whether the bundled node supports `-blockaskeyuses`: it reads the flag's name out of the node jar's own parameter list, once, for whichever jar the chosen node kind runs. With today's jars the answer is no.
- The wallet's key mode ("classic" or "block") is recorded once in the config, before the node first starts for a new or restored wallet. An install that already holds node data, or a finished wallet, and has no record is classic for good; that is written down at the next launch. Nothing changes a recorded mode: saving settings cannot, and asking to record the other mode is refused.
- The node gets `-blockaskeyuses -lowram` only for a block wallet on a jar that supports it. A classic wallet gets neither.
- The node is refused a start, with the reason shown as the node's error, when: the wallet is block and this jar cannot run it (a downgrade; starting it classic would add classic keys to the wallet for good); the data folder holds a wallet of the other mode; no wallet has been set up; or a key-mode flag is in the extra arguments or in a `-conf` file.
- A block wallet's data folder carries a small marker file, so a lost config cannot turn it classic and a classic install pointed at that folder will not start on it.
- `-blockaskeyuses` and `-lowram` are refused in Extra arguments, on the screen and again when the config is saved. They are not in the parameter editor.
- Switching between the Parlons Node and the plain node is refused for a block wallet if the other jar cannot run it.
- Shown only when the node supports block keys: Startup Params on first run has the phone's "Classic mode" switch (off by default, so new wallets are block), and restoring from a seed asks which kind of wallet the words were used in. The same 24 words give different addresses in each mode; the wrong choice opens an empty wallet. On an install that already has a wallet, words of the other mode are refused, because the install is never switched.
- The tray's bottom line shows the wallet's real mode: "Classic mode" or "Block key uses · low-RAM node". The footer reads "Last key block" for a block wallet.
- New `scripts/keymode-test.cjs` covers both capability states by injecting the capability; the jars are only read. `npm run test:wallet` (and so CI) now also runs it and `scripts/core-screens-test.cjs`.
- Dev preview: `&block=1` (a node that can run block keys), `&mode=block`, `&state=refused`.

## [0.18.87] — First run: the phone's launcher, seed screen and word boxes

- A new install opens on the phone's launcher: the Minima mark, "MINIMA CORE", and three buttons: New Wallet, Restore Wallet, Startup Params. It replaces the "Set up your node" dialog. Startup Params opens the same screen as in the app, with Save only, and returns to the launcher.
- New Wallet starts the node, then shows "Your recovery seed" in the phone's orange-edged card. The next screen has the words typed back, one box per word, and the wallet opens only when they are this wallet's words; a wrong word is named by its position. Before, a tick box was enough.
- Restore Wallet is the phone's "Restore & resync": the seed in 24 boxes, key uses, and the MegaMMR node. The node is started and the seed applied with the same `megammrsync` command as before. The key uses field starts empty, so a number has to be typed.
- The word boxes are the phone's: each box accepts only one of Minima's 2048 words, completes a word once it is certain, offers matches, turns green or red, and counts ("7 of 24 words"). A pasted phrase is spread over the boxes and removed from the clipboard; numbers, commas and line breaks between words do not matter. "Hide words" masks them.
- "My phrase is not 24 list words" takes a free-form phrase, typed twice, with the phone's warning. It is refused when it is too short, starts with "-", holds a character the node cannot carry, or looks like list words with a mistake. A phrase made only of list words asks whether to use Minima's form or exactly what was typed.
- Words typed in the boxes are sent in Minima's own form (capitals, single spaces), so a wallet restored from words typed in lower case is the wallet those words made everywhere else. Before, lower-case words in the setup dialog made a different, empty wallet.
- "Rebuild wallet from seed phrase" under Backup & Recovery uses the same boxes.
- The seed is held in memory while it is needed and nowhere else: not in the config, not in any log, not in browser storage. Closing the first-run layer removes the words from the page.
- If the node fails to start during first run there is now a Back button; a failed restore offers Retry or Back.
- Wording that differs from the phone: "on your computer" for "in your pocket"; "I've saved it. Proceed" (no dash); the confirm screen is headed "Confirm your seed", because here it checks the words instead of setting them. The phone's Language button is left out: the desktop has no translations yet.
- Dev preview: `?fr=launcher|params|seed|confirm|confirm-typing|restore|restore-any|starting`. The preview's seed is the words TEST ONLY VOID ABANDON, repeated.

## [0.18.86] — Backup & Recovery: the phone's hub

- "Backup & Recovery" in the menu opens the phone's hub: Create backup, Restore from file, Chat backup, Mail backup, Resync node, Private keys. Each row opens its own screen; Back returns to the hub. While the node is stopped the rows are greyed and the hub says why.
- These are the operations that sat in Settings as the Wallet, Resync chain and Backup cards, and in the "Restore from a different seed" dialog. They have one home now and are gone from Settings.
- Create backup: the password is typed twice and must be letters and numbers only, which is what the node can carry. The command is the same (`backup password:"…"`). When the node reports the file, its whole path is shown with "Copy full path".
- Resync node, Restore from file and "Rebuild wallet from seed phrase" (under Private keys) all run `megammrsync`. The command is now built in one function that makes every check the old screens made (host, quotes, backslashes, line breaks, key uses, file path, password) before any command exists. Each asks for confirmation first, and the ones that replace the wallet say what is lost.
- A restore from a backup file now also drops the mail, AtomiX and pool identities derived from the old seed, as a seed restore always did. Before, only a seed restore did.
- Private keys: "Show seed phrase" reads the words from the node when pressed and "Hide seed phrase" removes them. Leaving the screen removes them from the page as well. They are never stored or logged.
- Key uses must be a whole number; "12abc" used to be read as 12.
- Chat backup and Mail backup open the same back-up and restore steps as their own apps.
- Left out, because the desktop has no code behind them yet: the phone's file name field and "save a copy" for a backup, its list of backup files, lock / unlock / wipe / restore private keys, and Copy seed phrase. The `keys:` option of a seed rebuild is in the Terminal only.
- Dev preview: `?view=backup`, `&bk=create|restore|resync|keys`. The preview's "seed" is the words PREVIEW FIXTURE NOT REAL.

## [0.18.85] — Startup Params: the phone's screen over the same settings

- "Startup Params" in the menu, and "Reconfigure node" on the Node tab, open the phone's screen instead of the old setup dialog: "Startup parameters", then a switch each for Server mode (-server), MegaMMR (-megammr) and Keets transport (-keets), the Extra arguments box, Save and Save & Restart Node.
- Save stores the settings for the next start ("Saved - applies when the node restarts"). Save & Restart Node asks first, then restarts the node. Opening the screen and pressing Save changes nothing.
- The Server switch is the old "Contribute to the network" choice: it sets the same flags and the same router port request.
- RPC has no switch here: this app talks to its own node over RPC, so it is always on. On the plain Minima node, "Copy RPC password" puts the password on the clipboard from the main process; the page never receives it. The Parlons Node takes no RPC password, so the button is not shown for it.
- "All parameters" holds what the old dialog had below its presets: the network (mainnet, solo, custom peer), the data folder and ports, and every startup parameter of the node.
- This screen no longer contains anything about the wallet. Creating or restoring a wallet is not a startup parameter.
- Left out: the phone's "Resync automatically when unhealthy" switch. The desktop has no health monitor behind it.
- New tests in `scripts/core-screens-test.cjs`. Dev preview: `?view=params`.

## [0.18.84] — History: the phone's screen, JSON export and import, chain inclusion

- The History tab is the phone's screen, over the same local store as before (`history.sqlite` is not migrated or rewritten, and how transactions are classified is unchanged). "Minima History" in orange, Sync, the options button, one status line ("11 transactions · synced to block 2428089 · now"), and the search field "Search address, id, token, amount…". It wears the phone's own dark and orange palette in light and dark alike. Search now also matches the amount.
- Each row is the phone's: the arrow, the signed amount and token in the direction's colour, then the other party's address, whose it is (YOURS, CONTRACT or EXTERNAL, from the node's own script list; no label until that list is known) and when ("31 minutes ago", then the date after a week). The address is shown whole; the phone shortens it. Bought / Sold, Split and Consolidation rows keep the desktop's wording.
- The right-hand word on every row is "Unverified", as on the phone: a row records a change in the wallet, which is not proof that it settled. Opening a transaction asks the node (`txpow onchain:`, read-only) and shows "Checking chain inclusion…" until it answers, then "In block #N · 2 confirmations", "Confirmed #N · 13 confirmations", "Not found on this node, unverified" or "Unverified". Only a reply whose block, tip and confirmations agree is believed. The old "Block #N · X conf" line, which was worked out from the height in the transaction's header, is gone; the height is now labelled "Created at height (not confirmation)".
- The options menu has the phone's four, in its order and words: "Export as JSON (backup)", "Export as CSV (spreadsheet)", "Import history (restore / merge)", "Hide foreign contract activity". Then the desktop's two: "Filter by direction and token" (the old filter bar, which the phone has no place for) and "Copy the listed rows".
- Export as JSON writes every stored row to one file. Import reads such a file, or one exported by the phone app, and adds only the transactions the store does not have; a row already stored is never overwritten, so importing twice or from another device is safe. Each record is rebuilt field by field and anything that is not a transaction is skipped. The file is chosen in a system dialog and may be at most 64 MB.
- "Hide foreign contract activity" leaves out rows that touch none of the wallet's own addresses. It is remembered, and does nothing until the wallet's addresses are known, so it can never blank the list.
- A sync that cannot read the node says so in the status line when nothing is stored; an empty store shows "0 transactions" and no placeholder text, as the phone.
- New tests in `scripts/history-screen-test.cjs`; `npm run test:wallet` runs them with the wallet money-path tests, and CI runs it.
- Dev preview: history rows of every kind, the options menu, the filter, a transaction still being checked, an empty history.

## [0.18.83] — Send: the phone's screen, the same send

- The Send screen is laid out as the phone's, in the phone's order and words: Token, the "sendable" figure for it, Amount with Max, To address, "Send Funds". The phone's Scan button is left out (no camera flow on the desktop screen).
- The address field wraps, so a pasted address can be read from end to end before sending. Enter does not add a line.
- Nothing about how a send is checked or built has changed. The handler is the 0.18.78 one, character for character apart from the button's label: the address, amount and token checks (a pasted address carrying extra parameters is refused), the check against the spendable figure, the node's `checkaddress`, the review that shows the whole address, then the same `send` command. `scripts/wallet-money-test.cjs` passes on the same recorded strings.
- The token list still shows each token's whole id beside its name, where the phone shows the name alone: two tokens can carry the same name.
- The review and the messages keep their existing wording.

## [0.18.82] — Receive: the phone's screen; Get Address no longer mints a key

- **Receive no longer creates a key on every press.** The button ran the node's `newaddress`, which makes the node generate and store a new key each time it is pressed. It is now the phone's "Get Address" and runs `getaddress`: the node hands back one of the wallet's existing default addresses and creates nothing. Coins sent to addresses made earlier with the old button are unaffected: those keys stay in the wallet. Nothing else in the app used `newaddress` from this screen; address labels are keyed by the address shown and work as before.
- The screen is the phone's: "Scan to receive", the QR code on its white card, the whole address beneath it, Copy, Get Address. The address is kept while the app runs, so coming back to Receive shows the same one until Get Address is pressed; it is dropped when the node stops or a seed is restored.
- The desktop's "Label this address" field is kept, below the phone's layout.
- A failed address read says so and shows no QR code; before, it showed the word "unavailable" as if it were an address, with a copy action on it.
- `scripts/wallet-money-test.cjs` pins it: opening Receive and pressing Get Address issue `getaddress` only, and no code in the renderer issues `newaddress`.

## [0.18.81] — Wallet: token rows reorder

- Token rows on the Wallet tab can be put in any order: drag a row, or focus it and press Alt+Up or Alt+Down (Up and Down alone walk the rows). Minima stays first. The order is saved on this computer and is replayed as the phone does it: tokens still held keep their saved place, a token received since goes to the end, and a token no longer held drops out.
- While a row is being dragged the 15 second refresh of the list waits, so the row is not pulled from under the pointer.

## [0.18.80] — Wallet: the coins dialog and coin detail; Split and Consolidate move into it

- Clicking a token on the Wallet tab opens the phone's coins dialog: "<token> coins", the exact sendable, locked and confirmed figures, then every coin the node holds for it with its amount and its whole coin id. A coin that is locked in a contract carries a LOCKED chip (a pool reserve or a registry beacon is named too). Under the list: the coin count, how many are locked, and the sum of the coins, with a warning if that sum is not the confirmed balance. "Copy token ID" copies the whole id and leaves the dialog open.
- Clicking a coin opens its detail, as the phone: coin id, amount, token amount, token id, address, mini address, whether it is sendable, created, age, MMR entry, spent, store state and state, each in full with its own Copy, then the coin's raw JSON and "Copy JSON".
- Split and Consolidate are two buttons in that dialog. Split opens the same form the Send screen had (amount, how many coins from 2 to 20) for the token whose dialog it is. Consolidate runs the same function as before: it asks first, checks the pool owner keys, and refuses if one cannot safely sign. Split is offered when the token has a spendable amount and is not a one-of-one; Consolidate when it has at least two spendable coins. The commands sent are unchanged (`scripts/wallet-money-test.cjs`).
- The Send screen no longer has the Send / Split / Consolidate switch.
- The older token page (description, supply, decimals, website, validation link) is kept behind "Token details" in the dialog, for tokens other than Minima. The phone has no such page. Its own coin list is removed: the dialog is that list.
- A coins read that fails says so in the dialog; it is not shown as "No coins for this token."
- Wording differs from the phone in two places because the shell rule bans the long dash: "Coin, sendable" / "Coin, locked" and "no, locked in a contract".

## [0.18.79] — Wallet: the phone's header and token rows

- The Wallet tab's header is the phone's: "Total balance" with an arrow at the right. The row opens and closes one line that says what the figure is made of: confirmed, locked, unconfirmed, the coin count and how long ago it was read. It is closed by default.
- Each token row is the phone's row and nothing else: the icon with its validated badge, the name, the spendable amount, and one faint line with what the amount leaves out ("5 coins", "locked 20 · 20 coins", "unconfirmed 4.25"). The line is left out when there is nothing to say. Amounts on the list are cut to six decimals and never rounded up; an amount smaller than that shows as "<0.000001", never as 0. The exact figures are one click away on the token.
- Split and Consolidate are no longer buttons on the rows, and the "Consolidate N spendable coins" button is gone from them too. Both are still on the Send screen, unchanged, and move into the token's coins dialog in the next version.
- A wallet that holds nothing shows a Minima row at 0, as the phone does. A balance that could not be read still says so, with no figure above it.
- New test file `scripts/wallet-money-test.cjs`: it runs the Send, Split and Consolidate handlers taken from the app against a stand-in node and pins the exact command each sends for a set of inputs, every check that stops a send (a pasted address carrying extra parameters, a bad amount, an amount over the spendable figure, an address the node cannot check, a declined review), and that Consolidate refuses when a pool owner key cannot safely sign. The expected strings were recorded from 0.18.78 before any screen was changed.
- Dev preview: fixtures for locked and unconfirmed amounts, a long token name, a zero balance, an empty wallet and a failed read; `--only=<name>` captures part of the set.

## [0.18.78] — shell review: the menu everywhere, hidden apps still count, nothing stale

- The overflow button was hidden inside a tray app (Mail, ETH Wallet and the rest) and on Send, Receive, Logs, Terminal and Settings, so from those screens there was no route to Logs, Terminal, Settings or Shutdown, and the "Update" marker disappeared. It now stays in the bar on every screen.
- Hiding an app also hid its unread count everywhere. A hidden app with unread items now lights the dot on the tray button (also while the tray is open, since its row is not in it), and MinimaMail and miniMall show their count beside their name on the Apps tab.
- After a Shutdown or a failed balance read, the Wallet kept the old total above the message. The total now reads "–", and a failed read says "The balance could not be read" where it used to say "No coins yet".
- After a restore, the Faucet kept the old wallet's address, and the footer's key uses and the Node tab's figures stayed the old wallet's until their timers ran out. All are cleared on a restore and when the node stops, and read again.
- In a narrow window the open tray lies over the screen. The screen under it is now `inert`, so Tab stays in the tray; Escape or a click outside closes it.
- The Wallet list is rebuilt every 15 seconds, which dropped keyboard focus. Focus now returns to the same token's row, or the same button on it.
- Tests: `scripts/shell-test.cjs` runs the tray-dot rule for shown and hidden apps with the tray open and closed, and checks that no rule hides the overflow button on a sub screen or in a tray app. New preview capture: the Apps tab with MinimaMail hidden and one unread.

## [0.18.77] — shell review: Shutdown says what it interrupts, and a stopped node looks stopped

- Shutdown (the overflow menu) asked the same plain question whether the wallet was idle or had a swap half way through. Before it asks, it now reads the AtomiX swap list, the saved AtomiX market and the PandaPools activity (the app's own records; no node command) and names what is in flight: the number of AtomiX swaps in progress ("a swap in progress cannot settle while the node is stopped and can time out"), an AtomiX market that is switched on, and pool transactions sent in the last hour that are not confirmed yet. If one of the three cannot be read within 5 seconds the dialog says which could not be checked, instead of looking idle.
- After a Shutdown the window still looked alive. While the node is stopped, every screen now carries a strip under the bar, "The node is stopped. Balances, swaps, pools, mail and chat are offline until it starts.", with a Start node button. The Wallet and the Faucet are redrawn the moment the node goes away, and read "The node is stopped." where they used to read "Waiting for the node…".
- Not done: the same warning when the whole app is quit. Quit runs in the main process and is also the path the updater and the operating system's own shutdown use, so a dialog there needs its own change.
- A PandaPools engine that has not started reports an empty activity list, which the dialog cannot tell from "nothing pending".
- Tests: `scripts/shell-test.cjs` runs the dialog's wording for an idle wallet, one and several swaps, a live and a withdrawn market, recent, old and failed pool rows, and three failed reads. The dev preview has `&state=stopped` and `&shutdown=1`, with captures of both.

## [0.18.76] — shell review: block time outside GMT and the US zones

- The node reports the tip's time as Java prints a date, for example `Thu Jul 16 14:54:04 BST 2026`. The shell handed that to JavaScript's date parser, which only knows GMT and the US zone names. On a computer in any other zone (BST, CET, JST and so on) the footer's "@ time" and the Node tab's "Block time" were empty. Both now take the clock and the date from the text itself: the footer shows `14:54:04`, the Node tab `Jul 16, 2026, 14:54:04 BST`. "NO BLOCKS YET" shows as "No blocks yet" on the Node tab and as no time in the footer.
- The dev preview hid this, because its fixture fed a JavaScript-format date. It now feeds the node's own format with a BST zone.
- `scripts/shell-test.cjs` was never run by anything. It is now `npm run test:shell` and a step in the CI build (it needs no donor repository). New tests run the real functions lifted from `renderer/app.js`: the footer clock and the block time for BST, CET, GMT and JST strings, "NO BLOCKS YET" and missing values; and which bar a view wears (tab, sub screen or tray app).

## [0.18.75] — signing queue: review fixes

- `sign` and `signfrom` now wait in the signing queue, as do `txnauto` and a `txnpost` with `burn:` (the node signs a burn as its own transaction). The pattern was checked against the node's command sources. Left out on purpose: `sendfrom` (the Web Wallet reserves that key's uses before it signs), a plain `txnpost`, and the commands that only build or view a transaction.
- A signing command that fails with a timeout or a dropped connection may still be running inside the node. The queue used to move on at once, so the next signer could overlap it. It now waits until the node answers a `block` read, asking again every 5 seconds for at most 10 minutes, then releases with a line in the log. A `status:false` reply, a refused connection and a failed login release at once, as before.
- AtomiX publish, withdraw and currency switch give up after 60 seconds. Their `send` could still be waiting in the queue and would sign later, after the user had been told it failed; a retry then signed twice. A send that is still queued when its action gives up is now dropped and never reaches the node. A send the node has already been given cannot be recalled.
- The comment in `main/rpc.js` said the RPC secret is read per call. It is the one the caller passed when the command was queued; the comment now says so.
- Tests: `scripts/rpc-test.cjs` has a table of commands that must and must not be queued, the hold after a timeout and after a dropped connection, the bound on the hold, and the dropped queued entry. `scripts/atomix-unit.js` checks that the four maker actions hand their abort signal to the publish send.

## [0.18.74] — P2P Chance: bets are settled even after the old "Disable"

- A wallet that pressed the old "Disable" after betting still has its bets on the chain, but the settle-only loop started only for an install whose saved setting was still on. Such a wallet's open offer stayed takeable, and a taken bet was never revealed, so the taker could claim the whole pot after the 1500-block timeout. Now, when the setting is off, the app looks at the covenant for this wallet's own bets once the node is running. The look is read-only (`coins` and `keys`). If it finds a bet, the settle-only loop starts and the Settings card appears. A failed look or an unreadable key list is repeated after a minute, and a clean "none" once an hour, because a node that is still syncing can show an empty covenant. A wallet with no bets still sends no casino write to the node.
- The wallet's key list is only ever added to. A short `keys` reply used to replace it, which made the wallet's own bets look like a stranger's until the next full reply. It is dropped only when the wallet itself is reset.
- The Settings card says bets in play are "settled automatically". It used to say "paid out", which is not true of a lost bet.
- Tests: `scripts/casino-glue-test.js` covers the read-only looks (failed scan, unreadable keys, strangers' bets only, empty covenant, own bets), the short key list and the card wording.

## [0.18.73] — shell: fixes from the side-by-side with the Fold

- After comparing each screen with the Fold captures: the toolbar title, the tray heading and the tray rows are Manrope 600 (the phone sets them in its system face at medium weight, which is heavier than Manrope 500), and the "MINIMA" label beside Total balance sits on the figure's baseline.
- `scripts/dev-preview/shots/` holds the final captures (fixture data): Wallet, Apps, Node, tray, overflow menu, ETH Wallet, Mail and Receive in dark and light, plus a 1440 x 900 window and a 680 px wide one.

## [0.18.72] — Node tab laid out as Pandamonium's

- The Node tab is the phone's: a NODE card (Status with its dot, Block, Block time, Connections, Incoming, Random peer) and an IDENTITY card (Key uses as the large figure, Minima version, App version). Key uses, the random peer and the incoming count come from the same three read-only commands the phone uses (`keys`, `peers`, `network`), at most every 30 seconds while the tab is showing.
- Everything the old Node card did is kept under "This computer": Role, Network help and the port-forward instructions, Public address, Network, RPC port, the error and port-owner lines, and the Restart, "Stop any node on port N and start", Contribute and Reconfigure buttons, then the log. The Restart button reads "Start node" after a Shutdown.

## [0.18.71] — Apps tab: Hide

- The Apps tab is the phone's Internal list: one row per integrated app with its icon, its state ("Always on", "In app drawer", "Hidden from drawer") and a Hide switch. Hiding an app takes its row out of the tray until it is switched back; the app keeps running, and a hidden app's unread count no longer lights the dot on the tray button. The choice is saved.
- Minima Core cannot be hidden (its switch is locked, as on the phone). The phone's second switch, Freeze, arrives with the engines in a later phase and is not drawn. There is no External list.

## [0.18.70] — the app tray can be reordered

- Drag a tray row to a new place, or focus it and press Alt+Up / Alt+Down. Up / Down alone walk the rows. Minima Core stays first, as on the phone. The order is saved and comes back on the next launch; an app added by a later version joins at the end.
- The rows are moved, never rebuilt, so the Mail and miniMall unread counts on them are not lost by a reorder.
- Tests: `scripts/shell-test.cjs` covers the saved-order rule (pinned first, each saved id once, removed apps ignored, new apps appended).

## [0.18.69] — the Pandamonium shell

Phase 1 of the Pandamonium overhaul. The app now wears Pandamonium's shell; every existing screen still works, in a new place. No money path is touched.

- **Look.** Pandamonium's own colours, type and corners (`apks/base` `colors.xml`, `values-night/colors.xml`, `type.xml`, `themes.xml`): orange `#FF4A2B`, dark `#0F1114` / light `#F4F5F7`, Manrope, cards 16, controls 12, buttons 13, sentence case. The grain overlay, the watermark, the mono chrome and the wide-window nav rail are gone.
- **Theme follows the system.** There is no theme button and no Appearance card any more; the saved `theme` setting is no longer read. Mail's own light/dark button is hidden for the same reason.
- **Toolbar, tabs, footer.** Tray button, "Minima Core" over "Pandamonium", overflow button. Six tabs with the phone's icons: Wallet, Dexicon, History, Apps, Chat, Node. Footer: a status dot and "Key uses: N" on the left (the phone's text for a classic-key node), "block @ time" on the right. The node pill and the version badge left the header; the node's state is in the footer and the Node tab.
- **App tray.** MinimaMail, ETH Wallet, Minima Vestr, Minima Faucet, miniMall, Web Wallet and Parlons open from the tray, under the phone's dark host bar; "Minima Core" returns to the tabs. The tray pushes the screen aside and stays open (remembered); below 720 px wide it overlays, as on the phone. Mail and miniMall show their unread counts on their rows, and the tray button carries a dot while the tray is closed.
- **Overflow menu.** Logs, Terminal, Backup & Recovery, Startup Params, Shutdown, Settings. An "Update to X" item appears at the top when the store feed has a newer build.
- **Where things went.** Balances is the Wallet tab, with Total balance and Send / Receive buttons; Receive and Send are screens with a back arrow. AtomiX and Pools share the Dexicon tab for now. The Faucet card left Settings and is its own screen. Apps lists the integrated apps.
- **Window.** Opens at 932 x 732 with the standard title bar (the Mac's inset traffic lights sat where the tray button is). The node status now carries the tip block's time.
- **Dev preview.** `node scripts/dev-preview/build.js [--shots]` opens the renderer in a plain browser against a stubbed `window.mcd` with invented data, so layouts can be checked without starting a node. Not shipped.
- Tests: `scripts/shell-test.cjs` pins the six tabs, the tray order, the menu, the badges and the exact tokens.

## [0.18.68] — P2P Chance removed

- **P2P Chance (the peer-to-peer coin flip / dice / roulette module) is no longer part of the app.** The tab, the game screens, the Settings card that enabled it, the 18+ gate and the MINIMA / MxUSD currency choice are gone, with `renderer/casino.js`, `renderer/casinoart.js` and `renderer/casino.css`. No new game can be created or taken from this app.
- **Nobody's money is left behind.** An install that had P2P Chance enabled keeps a settle-only background task (`main/casino.js`; the vendored engine under `main/casino/` is unchanged): it reveals and resolves bets already in play, claims a pot as soon as its timeout allows (this used to be a button in My Bets), and withdraws the wallet's own untaken offers — their stake comes back to the wallet — instead of renewing them. The node-command shim refuses every command that could put new value into the contract (`send`, and any contract output that is not a reveal), so it cannot create, take or re-post an offer even if a marker write fails.
- While something is still open, Settings shows one card: "P2P Chance has been removed", how many open offers and bets in play remain, and that they are withdrawn / settled automatically — keep the app open with the node running until the card disappears. Nothing to press.
- With nothing open the task stops driving the engine and takes one read-only look an hour (a node that is still syncing can show an empty contract; a look that stopped for good could cost a house a taken bet at the timeout). An install that never enabled P2P Chance runs nothing and sees nothing, including after a wallet reset (the reset used to start the loop for everyone).
- Bet secrets and the result history in the OS keychain are never deleted or rewritten. `casinoEnabled` stays in the config as the gate for the settle-only task and can no longer be changed from the app; `casinoAgeCertified` and `casinoDollar` are no longer used.
- Tests: `scripts/casino-glue-test.js` is now the settle-only proof (34 checks: the loop does not start unless already enabled, no create / take / renewal command reaches the node, offers are withdrawn, bets revealed, timeouts claimed, a failed scan is not "nothing open"); the engine parity, timeout and keepalive suites stay; the UI-only casino tests are removed.

## [0.18.60] — the node starts again after a pid reuse

- `reclaimStaleNode`: the pid in `node.pid` counts as "our node from an earlier launch" only while that pid still runs our jar. Pids are reused — DexiconPro (same code) hit it on 17 Nov 2026: the pidfile's pid had become a macOS XPC service, the start reported "port in use by ThemeWidgetControlViewService" and the node was never launched, with no log line. A refused start is now logged. Source fix; no installer cut yet.

## [0.18.59] — PandaPools parity manifest

- Same build as 0.18.58 plus the regenerated `scripts/pandapools-parity.manifest.json` (the committed digest of the vendored engine files, which CI verifies without the donor repo). 0.18.58 re-vendored `reserve-recovery.js` and `store.js` from pandapools-mds 0.6.44 without updating the manifest, so its CI matrix failed on all three platforms; v0.18.58 is not released.

## [0.18.58] — PandaPools upkeep: review fixes

- Review of the automatic upkeep: a reserve re-check of a recipe this node already holds no longer pauses owner signing for it (engine `reserve-recovery.js` from pandapools-mds 0.6.44); `autoUpkeep` retries next cycle instead of giving up when a restore is already running or storage is unavailable; the manual "Confirm wallet state" passes the chain tip, so it works for a restored block-mode key.

## [0.18.57] — PandaPools: pool upkeep is automatic

- Parity with native Dexicon 0.2.95 / 0.3.61 and PandaPools MDS 0.6.43. In `main/pandapools.js` (`autoUpkeep`, every scan cycle): a saved pool whose reserves this node cannot see recovers itself — once per session per pool, silently: re-track the covenant, verify and import both reserve coins (local node, then the archive); the service's keep-fresh then recreates them young so every light node sees the pool again. Only a pool whose owner key this node holds.
- A restored block-mode owner key (128^4 tree) is confirmed from the chain tip with no button: it signs leaf max(tip, uses+1), so once the tip has passed the recorded floor no leaf can repeat (`ReserveRecovery.counterSafe`). Legacy keys keep the attestation button. A confirmation never lowers the recorded floor.
- Vendored engine files `reserve-recovery.js` and `store.js` re-synced from pandapools-mds 0.6.43 (parity check: 19 byte-identical files).

## [0.18.35] — Chat backup

- KeetChat → **My address & QR → Back up chats / Restore chats**: one encrypted `.kbak` file with this
  computer's keets chat address (the sidecar keypair) and every chat contact and message. It is the same file
  the bears (PandaBear / BlackBear / Pandamonium 2.2.10) write, so chats move between phone and desktop in
  either direction. Restore shows every address in full, needs RESTORE typed, merges chats (rows already
  here win), replaces the keets address and restarts the node. A phone backup's MAX# identity is not used
  here (this app has no MAX# chat).

## [0.18.20] — MxUSD payments in KeetChat

- The in-chat payment now asks **Minima or MxUSD**. MxUSD (token id
  `0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90`) is sent with the node's
  `send … tokenid:` and travels on the existing payment wire fields (`tok`, `tokname`), which every
  KeetChat and Parlons renderer already showed; only the send path had Minima hard-coded.


## [0.18.19] — never wait on a dial that will fail

- **Keets sidecar 1.2.6.** A direct dial to a peer that cannot be reached (two devices on one
  router, or an asymmetric NAT) used to block for up to 15 s before the mailbox was tried. The
  direct dial now races the mailbox: after 1.5 s the message is also stored at the recipient's
  primary mailbox (which pushes it at once), and a peer whose last dial failed within 10 minutes
  goes mailbox-first with no grace. Receivers dedupe by message id, so a message that arrives by
  both paths is stored once.
- Inbox poll 5 s → 1.5 s, so a pushed message shows within about two seconds.


## [0.18.18] — instant keets delivery on the same Wi-Fi, double ticks that mean delivered

- **Keets sidecar 1.2.5.** Two devices behind one router cannot hole-punch each other, so every
  desktop → phone message fell back to a mailbox that the phone polled every five minutes
  (measured 1–5 min across one desk). The recipient now holds a live subscription to its primary
  mailbox and the mailbox pushes each stored message at once; senders store at that primary
  first. Poll fallback 5 min → 45 s. `resources/keets-sidecar` synced to the keets repo (1.2.5,
  adds `media-read.js`).
- **Delivered receipts.** When this app stores a message it tells the sender (`state:"delivered"`),
  and it applies the same receipt from Pandamonium 2.0.35+: one tick → two ticks when the message
  actually lands, not only when the thread is opened.
- **Contact names follow the sender** until you rename a contact yourself (auto-learned names are
  flagged in `chat.json`; a user-given name clears the flag and sticks).


## [0.18.17] — KeetChat on both node kinds, styled like the phone: keets chats come into KeetChat, Parlons chats stay in Parlons

- **The Chat tab is no longer hidden on the Parlons kind.** Until now the Parlons Node jar drained the
  keets inbox into Parlons (keets contacts showed up as Parlons threads, and anything its bridge did
  not understand was dropped). The desktop's own KeetChat (`main/chat.js`, `chat.json` store) is now
  the one drainer on BOTH kinds, with photos, voice notes, payments and read receipts.
- The Parlons kind launches the jar with **`-Dparlons.node.keetschat=off`**, the new switch in
  **Parlons Node 0.2.130** that keeps its `KeetsChatBridge` down (single-drainer rule: two drainers
  steal from each other). Parlons keeps its Maxima chats; a keets-only contact already sitting in
  Parlons stays there as history but new keets messages arrive in the Chat tab.
- `parlonsNode` pin 0.2.129 → 0.2.130. Tests: `scripts/keets-test.cjs` asserts the switch is passed,
  `chat.startLoop` no longer gates on kind and the renderer no longer hides the tab.
- **The Chat tab now looks exactly like the Pandamonium / BlackBear phone chat** (renderer/chat.js +
  chat.css rebuilt from the phone layouts): the "My address & QR" row, the thread list with the HSV
  avatars and blue unread badge, the blue new-chat FAB, the thread toolbar with its ⋮ menu, 14dp
  bubbles (outlined incoming, Minima-blue outgoing) with the phone's text ticks and light-blue read
  ticks, date pills, voice notes drawn with the WaveformView geometry, photos opening the black
  viewer, payment bubbles whose "Tap for txid" shows the full txid, and the pill input bar with the
  paperclip and mini send FAB. Light mode follows the app's own theme switch (`data-theme="light"`)
  with the phone's day palette.

## [0.17.35] — keets: the node is dialable by pubkey, even behind NAT

- **keets transport bundled and ON by default (minima kind).** The node now also speaks
  Hyperswarm/HyperDHT: it announces on the keets topic and becomes dialable by its Noise
  public key with **no port forwarding** — the DHT hole-punches in. Classic TCP peers are
  completely unaffected, and the toggle (`keets transport` in the params editor) turns it off.
- Ships the keets sidecar (`resources/keets-sidecar`, hyperswarm 4.17.2 exact-pinned) and runs
  it with the app's **own Electron binary** as the node runtime (`-keetsnode` +
  `ELECTRON_RUN_AS_NODE`) — no system Node.js dependency. Bootstrap defaults to the
  owner-run 7-node HyperDHT fleet baked into the jar; `-keetsbootstrap` overrides.
- `resources/minima.jar` rebuilt from minima-core `main` (`cad065feb7`: keets transport +
  `-keetsnode`). New params: `keets`, `keetsbootstrap`, `keetsconnect`, `keetsmaxconns`
  (sidecar path + runtime are app-managed). The Parlons kind refuses all keets flags — its
  embedded node line doesn't know them yet.

## [0.17.13] — PandaPools: say what recovery actually needs
- Engine re-copied from PandaPools MiniDapp **0.6.28**, mirroring native 0.9.61. The recovery notice said *"a seed or recipe alone is insufficient"*, which reads as though seed **plus** recipe were also insufficient. It is not. It now names the two working routes — a current MinimaCore wallet backup, **or** the pool recipe plus your seed phrase — and states plainly the part that is true: a seed phrase **alone** is not enough.
- Wording only; no behaviour change. 32 PandaPools tests pass; donor byte-parity and the digest manifest verify.

## [0.17.12] — PandaPools: the stranding fix and the collect queue reach the Desktop
- Engine re-copied from PandaPools MiniDapp **0.6.27**, which ports native 0.9.57, 0.9.56, 0.9.51 and 0.9.49.
- **The forward that stranded real funds is fixed here too.** Payout addresses now enter a durable `pp_pendingcollect` queue **before** any forward is attempted, and the sweep finishes only when the address reads **empty** — never because a forward reported that it posted. `Collect` is wired to that queue instead of the old fire-and-forget sweep, close enqueues its payout address, and the background service pass keeps at it after the window is closed. A payout address this wallet cannot sign for is now shown in MY LP with the address in full, instead of being silent.
- **Stranding notifications work here.** The Desktop MDS shim was `cmd`/`sql`/`log`/`init`/`net` only, with no `notify` — so the engine's new warning would have thrown inside the keep-fresh pass and taken refresh, stranding detection and the collect sweep down with it on every tick. The shim now implements `notify` with a real Electron notification, and the engine guards the call regardless.
- The signing gate names which of six problems it is, and a backup is verified before it is handed over.
- 32 PandaPools tests pass; donor byte-parity and the digest manifest verify.

## [0.17.11] — PandaPools: retire is reversible, and the owner-key signing hold stands
- Engine re-copied from PandaPools MiniDapp **0.6.25**, which reverts a signing-guard weakening: the backfill no longer clears the owner-key hold for a rediscovered pool. Holding the key is not holding the newest counter, and clearing it let keep-fresh sign **unattended** at leaves a previous device had already spent.
- **0.17.10 shipped the hide half of retire with no un-hide** — no listing, no bring-back, no automatic un-retire. A live funded pool rendering as unresolved (mid-resync, archive unreachable) was one click from leaving the UI permanently; the recipe survived in `pp_ownpools` and in backups, but there was no in-app way to find it again. Now a pool found live on chain is un-retired automatically, a "closed pool(s) kept for recovery" card lists them with **Bring back**, and close/migrate retire the old recipe as native and the MiniDapp already did.
- `setRetired` reads back instead of trusting an `UPDATE` that matched zero rows, so a missing recipe no longer reports success.
- 32 PandaPools tests pass (one new, pinning that retire has an un-retire); donor byte-parity and the digest manifest both verify.

## [0.17.10] — PandaPools: one card per pool, and closed pools put away
- Engine re-copied from PandaPools MiniDapp **0.6.24** (mirrors native 0.9.58/0.9.59).
- **The leaf-burning path is gone** from the shared engine (`poolmgr.js`: `restoreTarget` / `advanceKeyUses` / `burnTo`). It signed junk data with `sign publickey:` to push a Winternitz counter to a guessed target; advancing a counter cannot undo signatures made elsewhere, and guessing the target is the leak. Unexported and uncalled, so this removed a latent footgun.
- **Closed and migrated pools can be put away.** Recipes gain a `retired` flag — hidden from the pool list, never deleted, still returned by `ownAll` for backups and key classification.
- **The unresolved card names both identifiers**, labelled `Pool:` and `Owner key:`. As raw hex the two are indistinguishable, which is how one pool read as two problems on the phone.

## [0.17.3] — AtomiX currency toggle: switch on the first click, and keep the header honest
- **The switch is applied immediately.** `switchCurrency` used to write the kv row then fire `MDS_TIMER_60SECONDS` and hope; `service.js`'s `poll()` returns early when a pass is already in flight, and the switch has just spent up to 60 s tombstoning, so a pass usually *is* in flight — the nudge was swallowed and the engine kept the old currency for up to a minute. It now calls the service's own `reloadShared` directly (a vm global, the same access class as the `ctx.RPC.setUrl` the glue already uses), which re-reads the row, swaps the trading context, resets the maker and reconfigures every engine. Idempotent; deliberately **not** `POLLING = false`, which would defeat the fund-safety watchdog. Glue only — no engine edit, no donor round-trip, parity 40/40.
- **The next click is no longer a no-op.** `axSwitchCurrency` derived its target from a stale `axStatusCache`, so after the lag above it asked for the key the engine already held and the glue early-returned doing nothing — first click looked dead, second only resynced the label, third finally switched. It now derives the key once and re-reads status from the server before rendering. The button is also disabled while the tombstone posts, so a second click can't re-enter the switch.
- **The header refreshes itself.** `axStatusCache` was written in exactly one place (`renderAtomix`), which the live-update path never called — so when the engine did flip, the body showed the new currency while the header and "Switch to …" button kept the old one indefinitely. New `axRefreshStatus()` updates the status, the accent colour and the two header nodes in place, with no `innerHTML` on the body, and runs first on every live update — including the OTC and Wallet tabs, which previously fell through doing nothing. `renderAtomix` was the wrong tool for this: it awaits a 30 s book scan and rebuilds forms the user may be typing into.
- **A failed persist is reported.** `kvSet("trading_currency", …, () => cb(null))` discarded the error — `mdsw.js` names that exact key as the one write that must not fail silently. It is propagated now.
- 2 new AtomiX unit checks (22 total): a structural assertion that `switchCurrency` calls `reloadShared` and neither relies on the poll nudge nor drops the kv error (fails on the previous code), plus a guard that builds the real vm context with an inert shim and asserts `ctx.reloadShared` is reachable — so a future donor sync that wraps `service.js` in an IIFE cannot silently disable this fix.

## [0.17.2] — AtomiX publish: the actual cause, found in the node's Java and proved on-chain
- **`cmd failed: send … — undefined` is fixed — for real this time.** 0.16.90 (coin age) and 0.17.1 (`sendable:true`) were both wrong guesses; the user hit the identical failure on 0.17.1. The cause is in the node: `coins` defaults `checkmempool` to **false** (`coins.java:194`), so it still lists a coin already committed to an unconfirmed transaction, while `send` excludes exactly those coins unconditionally (`send.java:317-333`, and again inside `selectCoins`). The pin trusted `coins`, handed `fromaddress:` a coin `send` refuses, every input at that address was skipped, and the send died. Proved on the live wallet: two coins were each spent by two different txpows, 89 s and 17 minutes apart.
- **The shared pin now asks for `checkmempool:true`** (`main/sendpin.js`), which applies the *same two filters* `send` does — being mined (`TxPoWMiner.mMiningCoins`) or in the RAM mempool. The candidate list finally matches what the node will accept, and with the blocked coin gone the ranking moves to the next address by itself. Every pinned send benefits: mail, shop, vestr, casino, webwallet, AtomiX.
- **Why only a node restart used to clear it**: both blocking lists are RAM-only and don't self-heal promptly — `RamDB.checkForCoinID` ignores `isOnMainChain()`, so a coin stays blocked *even after its transaction confirms* until the ~30–60 min RAM-DB sweep, and `mMiningCoins` leaks permanently on a mine timeout. A restart rebuilds both. That is also why the Android APK is immune: it publishes **unpinned**, so `send` does its own selection.
- **The node was never silent — we read the wrong field.** `send.java:376-381` returns `{status:false, message:"Insufficient funds.. you only have 0 require:0.000000001"}` normally; `CommandRunner` only sets `error` on a thrown exception. `mdsw.js` reads `r.error`, hence `— undefined`. The cmd shim now copies `message` into `error`, so every such failure names its reason.
- **Candidate rotation.** `coins` and `send` remain separate code paths, so on a bare `{status:false}` the publish now retries pinned to the next signable address (up to 4), then falls back to unpinned, logging which happened. A real error (transport, auth) is surfaced immediately and never retried.
- 4 new AtomiX unit checks (20 total). Run against the previous code first: the `checkmempool` and `message`→`error` cases fail, proving they target the real bug. The casino glue mock was matching the exact old query string and now accepts the flag.

## [0.17.1] — AtomiX publish: stop pinning coins the node will not spend
- **`cmd failed: send … — undefined` on publish is fixed.** AtomiX had its own copy of the coin-pinning logic that had **drifted** from the shared `main/sendpin.js` every other send uses (mail, shop, vestr, webwallet, casino, terminal). The shared one gained three fixes this copy never got: it asks the node for `sendable:true` coins, it compares 44-decimal amounts exactly rather than as doubles, and it falls back to an address whose coins *total* cover the amount.
- **`sendable:true` is the one that broke publishing.** `coinage:` says how deep a coin is, not whether it can be spent — a coin already consumed by an unconfirmed transaction is still `relevant` and still old enough. So a republish inside the ~1 block after the previous publish re-picked that same coin, pinned `fromaddress:` to it, and the node refused the send with a bare `{status:false}` and no error text. That window is exactly what a node restart walks into: the engine publishes immediately on boot (`maker.js` `lastPublishMs = 0`), the user retries, and it fails until the block confirms — "fails a few times, then works".
- `pinPublishSend` is now a thin wrapper over `sendpin.pinMinimaSend(runner, cmd, { minCoinage })`; `sendpin` gained an optional `minCoinage` so the AtomiX-specific coin-age floor lives in the shared helper. Only *which* sends to pin stays in AtomiX. A test asserts the delegation structurally, so the fork cannot quietly return.
- 3 new AtomiX unit checks (16 total): the coins query must carry `sendable:true`; with no sendable coin the send goes unpinned rather than pinned to something unfundable; and the pin must not run its own coins query or signability probe.
- Fixed a stray **literal NUL byte** inside a regex at `main/atomix.js:740` (`.replace(/<NUL>+$/, "")`, now `/\x00+$/`). Semantically identical — it strips the trailing NULs of a fixed-width ERC-20 symbol field — but as a raw byte it made `file`, `grep` and graphify treat the entire file as binary, so it was invisible to search and mis-parsed by tooling. 136 ETH wallet checks confirm the decoder is unchanged.

## [0.17.0] — Stop the overnight crash: the pinned DNS lookup must call back asynchronously
- **The morning crash is fixed.** `connectPin` (added in 0.16.93 with the DNS-rebinding fix) called its callback **synchronously**. The real `dns.lookup` is always async and node's `net` depends on that: it runs `lookupAndConnect` from inside `request()` and only wires the socket's error listener a tick later — node's own source says "There are no event listeners registered yet so defer the error event". So a connect that fails at the syscall destroyed the socket before anything was listening. Waking a Mac does exactly that: DNS still answers from cache, but the route is not up, so `connect(2)` returns `EADDRNOTAVAIL` immediately — and macOS fires every overdue timer at once on wake, so the AtomiX poll burst hit a half-up network. The callback is now deferred with `setImmediate`. The SSRF pin itself is unchanged.
- The crashing endpoint was `172.66.150.162` = **`ethereum-rpc.publicnode.com`**, `FALLBACKS[0]` in `main/atomix/lib/ethrpc.js` and the sticky primary the AtomiX poll POSTs to every 12 s / 60 s. That is why AtomiX specifically died while the node kept running, and why the Android APK — which has none of this code — was unaffected.
- **Two distinct failure shapes, both fixed.** Over http the socket emitted `'error'` with nothing routing it to the request: uncaught exception, dead main process. Over **https** — the path AtomiX actually uses — `request()` threw `TypeError: Cannot read properties of null (reading 'setServername')` outright, so the fetch never settled and its concurrency slot was held forever; four of those wedge every outbound request in the app. `getCapped` and `postText` now settle exactly once on every path, with a watchdog above the read timeout as a backstop, so a slot can no longer be stranded.
- **A last-resort safety net** (`main/main.js`): `uncaughtException` and `unhandledRejection` are logged in full — with stack, into Settings → Logs, which already redacts seeds and private keys — and the app keeps running. An app supervising a node holding real funds should not die because a socket failed. It is a net, not a substitute for fixing faults, so it logs loudly.
- **Tests that drive a real socket** (`npm run test:netfetch`, now 9). The existing suite stubbed `http.request` entirely, which is exactly why this was invisible to CI — the fault was in *when* the lookup calls back, and a stubbed request never runs node's connect path. The new cases use `{address:'1.2.3.4', family:6}` to fail in `connect(2)` deterministically and offline; run against the old code they reproduce both the uncaught exception and the stranded slot. Verified live afterwards: MEXC, a TLS favicon and `ethereum-rpc.publicnode.com` all fetch, loopback still refused.

## [0.16.99] — Fix the Casino MINIMA ↔ MxUSD toggle, dead since 0.16.97
- **`casinoDollar` is declared in config `DEFAULTS` again, so the Casino currency toggle works.** 0.16.97 gave `config.save()` an allowlist that drops any key `DEFAULTS` does not name; `casinoDollar` had lived in the renderer only since 0.16.37, so the patch was dropped, `save()` returned the UNCHANGED config, the renderer reassigned `CFG` from that return value — wiping its own optimistic flip — and repainted the old label. The panel redrew and nothing else happened. It was the only renderer-persisted key affected; the other nine were already declared. No migration is needed: `load()` kept reading the on-disk value throughout, so the setting was frozen rather than lost, and the next toggle writes normally.
- **An unknown config key is now dropped LOUDLY** (`console.warn` naming it). The silent drop is what made a config bug look like a broken button.
- **New `npm run test:config-keys`, wired into CI**: every key `renderer/app.js` persists — via a `saveConfig({…})` literal, the first-run `const patch = {…}`, or a `CFG.<key> =` assignment — must exist in `DEFAULTS`. Checked against the broken tree first, where it fails naming exactly `casinoDollar`, so it reproduces the bug rather than passing vacuously.
- **Copying an identifier no longer triggers the row underneath it.** The delegated `[data-copy]` handler added in 0.16.96 ran on the bubble phase and only called `preventDefault()`, so clicking a maker's key in the AtomiX depth book *also* fired `.ax-half[data-take]` — jumping to the Swap tab with a side pre-selected. It now runs on the CAPTURE phase and stops the event: on bubble it ran last, after the row's own handler, so stopping it there would have been too late. All three `data-copy` render sites are copy-only elements, so nothing else is swallowed.
- **PandaPools ids no longer copy twice.** `wirePpCopy()` still set a per-node `onclick` on the same nodes the delegated handler already serves, so each click ran `copy()` twice and toasted repeatedly. Removed, along with its three call sites; the app-wide handler supersedes it.

## [0.16.98] — Quit can't hang, secrets stay out of the log, and CI gates the rest of the suites
- **`node.stop()` is bounded.** Its wait cleared only when the child went away, so if neither SIGTERM nor SIGKILL reaped it (a zombie, or `kill()` throwing EPERM) the promise never settled — and `before-quit` awaits it after `preventDefault()`, so the app hung on quit with no window left to close. There is a hard 35s deadline now.
- **Every secret is redacted from the startup log line, not just the RPC password.** `effectiveParams()` resolves the Keychain markers back to real values before they become argv, so a `-dbpassword` or `-mysqldb` DSN went into the Logs view; truncating each argument at 57 characters only clipped the tail and still showed the head of the credential. Values for any flag the manifest marks `type:"secret"` are replaced, in both the `-flag value` form and inside the single quoted `-Dparlons.node.args=` blob.
- The three remaining native `confirm()` dialogs — including the one in front of a wallet RESET — now use the app's own `showConfirm`, like everything else. A native modal also blocks the renderer while it is open.
- Casino result notifications name the token instead of calling every non-MINIMA bet "USD". True today, since **MxUSD** is the only other currency offered, and it would have started lying quietly the moment that changed.
- **CI now runs the suites it was skipping**: the ETH wallet guards (136 checks, including the RPC SSRF allowlist), the AtomiX glue units, the Casino glue, and the terminal autocomplete. A regression that reopened that allowlist could previously ship all three installers with nothing going red. `scripts/atomix-unit.js` skips — loudly — the one check that needs the minimega docker container instead of failing without it; the S1/S2 boot gates stay a local pre-release step, because they boot against a live mainnet node and compare the derived ETH identity with that peer's.

## [0.16.97] — Close the remaining command-interpolation gaps and two silent-loss bugs
- **New `main/validate.js`** — one home for the guards on anything interpolated into a node command. The node's parser is space-tokenised and LAST-WINS, so a value carrying a space and another `key:` rewrites the command around it; a length-only address check is what let `Mx… address:0x<attacker>` redirect funds once already. `main/webwallet.js` states the rule; these checks make it enforceable in one place instead of four near-copies that drift.
- **`vestr.js` now validates what it interpolates.** `tokenid` reached `send … tokenid:<x>` with no check at all, so `0x00 address:0xATTACKER` would have appended a second address that wins over CONTRACT; `coinid` reached `coins`/`txninput` the same way, and the wallet `password` was interpolated unquoted. All validated, and the password is quoted.
- **A `"` in the backup password no longer produces an unrestorable backup.** `backup password:"<pw>"` was unvalidated, so a quote closed the value early: the node encrypted under a DIFFERENT password than the user typed and reported success. They find out when a restore fails, with funds behind it. The resync handler forty lines above already guarded this.
- **`sendpin` decides coverage on decimal strings, not doubles.** Minima amounts run to 44 decimals, past a double's ~15–17 significant digits, so a coin fractionally short read as covering — and pinning `fromaddress:` to it makes the send unfundable, which is the exact failure this module exists to prevent. Address totals are summed as BigInt at a fixed scale. It also probes `checkaddress` once per ADDRESS rather than once per coin; several coins share an address and each probe is a round trip with a 30s ceiling.
- **miniMall stores the vendor address durably.** It was stashed with `store.order(ref).vendorAddress = …` after `upsertOrder`, which mutated the in-memory row without flushing — so a crash lost it and a retry fell back to `store.shop()`, the very source the stash exists to avoid trusting. It now goes into the object `upsertOrder` persists.
- `config.save()` accepts only keys it defines, coerces them to the declared type and range-checks `basePort`/`heapMb` — these values become `java` argv. It also no longer mutates the caller's object while rewriting secret markers.

## [0.16.96] — Identifiers stay recoverable, and the Wallet Send asks first
- **The vesting confirm shows the beneficiary IN FULL, on its own line.** It showed `0x1234abcd…ef12` — 12 visible characters — as the last thing between the user and a contract whose own text says it cannot be cancelled. That is precisely the shape an address-substitution swap is built to survive. The dialog now prints the whole address and asks the user to check it character by character.
- **The main Wallet Send now confirms before it sends.** Every other send path in the app already did — minimaMail pay, ETH send, AtomiX swap, the PandaPools actions, Vestr — and this is the one people use most. It validated, then went straight to the chain on one click, with the recipient nowhere on screen. The review shows the full address and the amount.
- **A truncated identifier is always one click from the complete one.** New `idHtml()` renders the short form but carries the whole value in `data-copy` and in the tooltip, and a delegated handler in `boot()` copies it — so this works in every view, not just the PandaPools ones that had their own wiring. Applied to the order-book maker key, LP coin ids, the sendable-coin list, and history coin ids and addresses.
- **Txid toasts no longer destroy the id.** `toast()` takes an optional full value: the toast becomes clickable, puts the COMPLETE id on the clipboard, and stays up 8s instead of 3.2s so there is time to click. A toast was the worst place to lose an identifier — it showed `0xab12…` briefly and nothing anywhere kept the rest. Covers the wallet send, mail pay, and the two AtomiX broadcast paths.
- Confirm dialogs wrap long values (`overflow-wrap:anywhere`) so a 64-character address fits rather than overflowing — the point is to show it whole, not to shorten it to fit.

## [0.16.95] — Release integrity: pin the node jar, mandate the update hash, verify the app we actually ship
- **The bundled Parlons Node jar is now pinned by digest in `package.json` (`parlonsNodeSha256`), not just by version.** `SHA256SUMS` ships from the same GitHub release as the jar, so checking one against the other proves the download arrived intact — not that it is the jar we meant to ship. The pin is the authority; the release sums stay as a transport check and must agree with it. Same discipline `main/pandapools` already has.
- **A verification that verified nothing now fails.** `grep " $NAME$" SHA256SUMS | sha256sum -c -` exits 0 on EMPTY stdin under GNU coreutils (macOS `shasum` exits 1), so a renamed or missing asset passed the gate and shipped on the Linux and Windows legs. Every match is asserted non-empty before it is trusted.
- **A stale local jar is detected instead of silently shipped.** `resources/parlons-node.jar` is gitignored, so it goes stale without a trace: the checked-in pin said 0.2.112 while this tree still held **0.2.108**, which would have put a different node in a local Mac DMG than in CI's Windows and Linux installers — exactly the drift the pin exists to stop. The script now re-fetches on any digest mismatch and skips the download when the jar already matches.
- **The update sha256 is mandatory.** `if (status.sha256)` meant a feed that omitted it produced an unverified installer in ~/Downloads, revealed for the user to run; on Windows and Linux the installers are unsigned, so nothing else stood behind it. A row without a valid hash is no longer even reported as an available update, and the download also checks the declared size.
- **https on every hop.** The scheme was only checked on the URL we were handed, so a single 302 could downgrade the whole transfer — including the feed, which is what tells the app that a new version exists and where to get it. Redirects are re-checked; only loopback may use http, for a self-hosted feed.
- `scripts/verify-mac.sh` now keys both artifacts to `package.json`'s version and refuses a `.app` whose `CFBundleShortVersionString` doesn't match: picking the app with `head -1` and the DMG with `sort -V | tail -1` could verify a leftover bundle while shipping a newly built DMG. `scripts/release-desktop.sh` runs that full verify instead of only `stapler validate` — stapled proves notarization, not a Developer ID signature, the hardened runtime, or Gatekeeper's verdict.
- 6 new updater tests (`npm run test:updater`), wired into CI. Fetch script exercised live: it detected the stale 0.2.108 jar, replaced it with the pinned 0.2.112, and is idempotent on re-run.

## [0.16.94] — AtomiX signing gate: a synchronous throw no longer latches it shut
- Re-copied `main/atomix/lib/signgate.js` from the donor at atomix-mds 0.1.30 (engine files are a copy, never a hand-edit — `npm run test:atomix` proves byte-parity). If a signing op threw before it reached the node, `next()` left the gate held with no callback pending, so every later claim, refund and publish queued behind a dead hold and silently never signed until the app restarted — for an HTLC leg that is a missed claim window. The gate is now freed on a synchronous throw, which is safe precisely because no signature was issued on that path, and the error still reaches the caller unchanged.
- No time-based release, and the header now says why instead of describing a "lazy stale-hold check" that was never implemented (`MAX_HOLD_MS` and `busySince` were assigned and never read; both are gone). Elapsed time cannot tell a lost callback from a slow one — the node's write timeout is already 180s — and freeing a hold whose signature is still in flight would sign one Winternitz leaf twice, which is the key-disclosing bug the gate exists to prevent. A wedged gate costs a missed claim; a wrong release costs the key.
- `multisig` is now gated: `multisig action:sign` signs but starts with neither 'sign' nor 'send', so prefix matching missed it entirely. AtomiX never calls it; it is listed so the gate stays honest for any host that does.
- Donor suite 583 pass (6 new), desktop AtomiX parity 40/40 files, glue units 14/14.

## [0.16.93] — SSRF guard: pin the vetted address (DNS-rebinding fix)
- `netfetch` vetted a hostname by resolving it, then handed the bare name to `http.request`, which resolved it AGAIN. An attacker-controlled resolver answers public for the check and `127.0.0.1` for the connect, so the request lands on the node's own RPC — which on the Parlons node takes commands with NO authentication. Token metadata is attacker-supplied and the wallet list fetches icons automatically, so a token sent to your address could run `send` with no user action. The vetted address is now PINNED for the connection (`vetHost` + `connectPin`); no second lookup can occur, on the first hop or any redirect. Same fix on `postText` (the ETH JSON-RPC path).
- A bracketed IPv6 literal (`new URL("http://[::1]/").hostname` keeps the brackets, which `net.isIP` rejects) skipped the literal-IP branch and reached the resolver. Brackets are stripped before the check.
- The pinned `lookup` answers both shapes node uses: `(err, address, family)` and, for Happy Eyeballs / `autoSelectFamily` (default-on since node 20, so the path electron 33 actually takes), an ARRAY under `{all:true}`. Getting that wrong would have broken every fetch.
- 6 new tests (`npm run test:netfetch`), wired into CI ahead of the installer build on all three legs. Verified live afterwards: MEXC JSON and a real favicon still fetch over TLS; loopback still refused.

## [0.16.87] — PandaPools engine parity: serial signing gate, CoinLock, `$OADR` funding exclusion
- Bring the Desktop PandaPools engine back to byte-equality with the MDS MiniDapp. `poolmgr.js` and `service.js` had drifted ~200 lines each with Desktop behind, missing the serial signing gate, the MiniDapp-wide `pp_signlock`, the `pp_coinlocks` CoinLock and the `$OADR` funding exclusion in five places — the complete 0.9.22 defect set, on the surface where one 12s poller drives scan, background worker, pending-sign resume and verify in a single vm context over a single sqlite file. Two transactions signing one key sign the same Winternitz leaf over different data, which discloses that leaf's private key.
- Expose `setInterval`/`clearInterval` to the engine's vm sandbox. The sign-lock heartbeat calls `setInterval` unconditionally, so without it every create, deposit, close, migrate and swap would fail; `service.js` guards with `typeof`, which would instead hold the lock with no heartbeat and let the TTL reap it mid-chain, silently.
- Stop a serialised fund action from posting after its caller gave up. The engine's queue makes an action wait where the glue's timeout cannot see it, so a slot could come up after the UI said "timed out — retry" and still post, letting the retry double-post against the same coins with both attempts signing. The glue now stamps a deadline before enqueueing and drops an abandoned slot without entering the engine.
- Enforce engine parity automatically: 14 files byte-checked against the donor, a committed sha256 manifest for CI (which cannot see the donor repo), `--update` refusing to launder local drift, `-text` on the copied files, and the gate wired ahead of the installer build on all three matrix legs.
- 31 PandaPools tests pass (24 pre-existing, 7 new); RPC and Parlons suites unaffected. Reverting the engine and shim fails 4 of the 7 new tests. No feature work. See [review](REVIEW-0.16.87.md).

## [0.16.54] — Durable pool recovery and verified signing state
- Keep unresolved owned pools visible with their full covenant address and a reserve-recovery action. Validate current local reserves, receiving-node coin proofs, and fresh MegaMMR proofs; failed imports never count as recovered.
- Preserve recipes, observed key-use floors and reserve-ID hints. Backups re-read live coins and discard proofs if reserves move during export. Proofs expire; recovery requires current complete wallet signing state and available chain proofs.
- Quarantine restored and legacy recipes until explicit current-wallet confirmation. Never regenerate owner keys or estimate/burn historic key use during restore. Verify actual signing keys immediately before owner and automatic signatures.
- Refresh using the oldest verified reserve leg and the covenant funding floor. Prevent tracking cleanup from undoing a concurrent restore.

## [0.16.39] — Verified activity, receipt recovery and public pool history
- Mirror Android activity fixes: real node confirmation counts, exact immutable transaction matching, cryptographic legacy receipt recovery, chronological receipt/history display and transaction timestamps in UTC.
- Preserve all existing receipts, including old failures; add Show more. Stop inferred reserve-snapshot transaction claims and label preserved observations accurately.
- Fetch actual public pool transactions separately from wallet accounting. Show read/lookup failures and keep incomplete history repair pending.
- 18 regression tests pass against both engines; shared-file parity, frontend checks and H2/SQLite validation pass. See [review](REVIEW-0.16.39.md).

## [0.16.38] — Pools: Withdraw/Add/Migrate re-read the live pool coin (fixes "the pool moved")
- **Fixed** Close/Withdraw (and Add, Migrate) in the Pools tab failing with *"an input coin was already spent (the pool moved) — nothing was posted"* on an active pool (parity with native **0.9.36 / 0.9.40** and MDS **0.6.21**). The desktop spent the pool's coin ids cached at the last scan; a counterparty swap — or its own keep-fresh (~every 900 blocks) — spends and recreates those coins, so the cached id is a spent coin and the tx dies at `txncheck` (`mmrproofs=false`). It now re-reads the LIVE covenant coin (fresh `coinidM/coinidT` + amounts) right before building close/add/migrate, retries close once if the pool moves, and re-derives Add's balanced token side from the live ratio. Covenant params (`opk/oadr/tok/kmin/address`) are untouched.

## [0.16.37] — casino: MxUSD (dollar) currency toggle
- (Casino change by another author — commit `65141da`; full entry pending from that author.)

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
