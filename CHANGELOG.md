# Changelog

All notable changes to **minimaCore Desktop** — the cross-platform (macOS / Windows / Linux) Electron app that runs
a full minimaCore node locally with a native-styled wallet + module suite. Newest first. Each release is tagged
`vX.Y.Z`; since 0.13.0 the installers (`.dmg` / `.exe` / `.AppImage`) are built on GitHub Actions and attached to the
matching [GitHub Release](../../releases).

---

## [0.18.210] — AtomiX: https-only network list, swap records kept, database files checked

- The AtomiX engine's outbound list checked only the host name, so a plain `http://` url to a listed ETH RPC host went out in clear text (anyone on the path could answer for the chain); it now requires https and no credentials in the url, and the engine's GETs follow no redirect (the list was checked on the first url only). A wallet replacement deleted `atomix.sqlite`, with the secrets and coin ids a claim or refund of a swap still in flight needs; it is now moved aside (`atomix.sqlite.replaced-<time>`) and logged. The SQLite shim (AtomiX and PandaPools, Desktop-only, not in the vendored manifest) opened an empty file as a new empty database, so the records read as none and the next save overwrote them; an empty or non-SQLite file is now refused and left as it is, and every save is synced to disk before the rename. Tests: `scripts/atomix-unit.js`.

## [0.18.209] — Vestr: state read strictly; no answer is not a failure

- A contract coin's state is anyone's (any wallet can make a coin at the shared covenant naming this one) and its values went into the collect transaction's commands as they were. A coin is now shown or collected only when the beneficiary is a whole 0x address, the amounts and blocks are plain numbers and every port is a bare value; others are left out and logged. The beneficiary typed for a new vest must be an address before it goes to `checkaddress`, and the reply must say true with a whole 0x address; the release cadence is a whole number of hours ("1e3", "-24" and "2.5" were taken). Every collect step must answer status true (an empty reply counted as success); a `txnpost` or lock `send` with no answer is reported as "may have been sent" rather than failed, so it is not repeated; the collected figure is exact decimal arithmetic. Test: `scripts/inject-test.cjs`.

## [0.18.208] — miniMall: the same reference from two buyers; a retry pays only after a refusal

- A second buyer's order carrying a reference already used was dropped, and a payment with that reference was counted for whichever order came first. Both orders are now kept (the second under the reference and that buyer's whole id, and replies and status updates still carry the reference the buyer knows), and neither can be paid automatically: both are marked to check by hand (an order already paid or confirmed before the copy arrived is left as it is). On the buyer side, Retry pays only after a payment the node refused, and an "in flight" mark is written to disk before each payment is sent and cleared when the node answers, so a quit or crash during a send blocks the retry as "may already have been sent". Test: `scripts/shop-test.cjs`.

## [0.18.207] — Chat: receipts and payments

- A peer's "delivered" receipt marked any message whose id it named, including another peer's, and a ref of `__proto__` wrote into `Object.prototype` (every object in the process gained `status: "delivered"`). The chat store's maps now have no prototype, `setStatus` looks up its own keys only, and a receipt moves only my outgoing message to that sender (a ref over 200 characters is ignored). A chat payment is now checked like Mail and miniMall payments: a plain amount above zero, a pay address of a valid form that the node accepts (`checkaddress`), a Minima send pinned clear of unsignable dust, "may have been sent; check before you try again" when the node does not answer, and a receipt that fails after the payment went is reported as a sent payment whose note did not go, not a failed payment. Test: `scripts/chat-peer-test.cjs`.

## [0.18.206] — miniMall: orders and payments made while the app was closed are read

- The miniMall scan read 256 blocks on its first pass and 64 after that, with the "done" mark kept in memory only, so orders and payments made while the app was closed for more than a few hours were never read. Like Mail, it now keeps the tip it last covered: the next pass reaches back to it (up to 1024 blocks), and an older gap is walked down by a paced backfill, 512 blocks more per pass, until it is covered or the node serves no deeper (then it stops and says so in the log). Test: `scripts/shop-test.cjs`.

## [0.18.205] — miniMall vendor: the payout address stays and every published one is read

- On every start the vendor side asked the node for an address (`getaddress` gives one of the wallet's default addresses at random) and read payments only at that one, while buyers pay the address written in the published .shop: after a restart their payments went unseen. The vendor address is now kept once chosen, and the payment scan (and coin notification) covers every distinct payout address of the shops made on this computer. Test: `scripts/shop-test.cjs`.

## [0.18.204] — Web Wallet: a failed read never decides the send path

- Whether an entered seed is the node's own wallet decides how a Web Wallet send is signed. A failed `keys action:list` answered "not the node's key" and a locked vault "no seed phrase", so the node's own seed could go down the foreign path and sign at the wrong key use. Either read failing now refuses: "Could not tell whether this is the node's own wallet … Nothing was sent." Test: `scripts/inject-test.cjs`.

## [0.18.203] — Web Wallet: key-use counters read strictly

- The Web Wallet's key-use counters were taken as empty on ANY read or parse error, so a damaged file made a foreign wallet sign at key use 0 again (reusing a one-time key exposes it) and the next write wiped every other address's counter; `ackKeyuses("1e309")` stored Infinity, written as null and read back as 0. Now only a missing file is a fresh start; an unreadable or damaged file (or a counter that is not a whole number of at least 0) refuses with the reason, nothing is signed and the file is left as it is; the acknowledged figure must be a whole number of at least 0; a send reads the counters once for both the acknowledgement and the reservation (the write was already atomic). Test: `scripts/inject-test.cjs`.

## [0.18.202] — small cleanups from the review

- The ETH key export checks that the wallet is ready before Touch ID is asked, and the Terminal gate checks the node first; the ungated `ethwallet.exportKey` export and the unused `seedFrom` are gone; the typed phrases live in one module (`main/phrases.js`); the currency to token mapping is one function (`ShopRules.tokenOfCurrency`) used by the shop, the listing check and the vendor side; the order's own coin list is the authority against counting a coin twice and the global list is cut from 100000 to the 5000 most recent ids; `clear()` forgets gathered dust; the backup password message names ";". Tests: `scripts/ethkey-test.cjs`, `scripts/shop-test.cjs`.

## [0.18.201] — the command channel's policy is one tested function; panels test in CI

- Everything `mcd:cmd` decides before a text reaches the node (empty text, control characters, a send that repeats amount, tokenid, address or fromaddress, the secret-command gate, the node running, the beacon-dust pin) is now one function, `cmdgate.checkCommand`, tested by its behaviour instead of by reading main.js. The red `scripts/panels-test.cjs` check was stale (it counted dialogs inserted with "beforeend" but not 'beforeend', so the backup dialog looked unstyled); it is fixed and `npm run test:panels` is now a CI step. Tests: `scripts/cmdgate-test.cjs`, `scripts/sendpin-test.cjs`, `scripts/panels-test.cjs`.

## [0.18.200] — Logs: one line buffer per node process

- The unfinished last line of the node's output was kept on the manager, shared by every node start: a late chunk of a stopped node could join the next node's first line. Each start now has its own buffer, the streams decode UTF-8 across chunks (a character split between two chunks stays whole), and the last unended line is logged before the "[app] node exited" line (and anything after exit on close). Test: `scripts/node-log-test.cjs`.

## [0.18.199] — Web Wallet: an unreachable key-use service is said plainly

- When the key-use service cannot be reached, Confirm and Check on-chain now say so plainly, and that nothing can be sent from this wallet until it can (a figure that is too low could lose funds). There is no way round it (owner decision). Test: `scripts/webwallet-ui-test.cjs`.

## [0.18.198] — the Touch ID refusal names the commonest reason first

- When Touch ID has worked before but cannot be asked now, the message now first says: if the lid is closed or your Touch ID keyboard is unplugged, open the lid or connect it and try again. Test: `scripts/ethkey-test.cjs`.

## [0.18.197] — command reading: quotes, brackets and sends the pin cannot read

- A `{` or `[` inside a quoted value (`password:"ab{c"`) opened a block in the parameter reader and hid every parameter after it from the repeat check and the send pin; the quote state is now tracked. A quoted first word now ends at its closing quote (`"txninput"id:a` lost its first parameter; ported from the development branch). The send pin leaves a send as written when its amount is not a plain number or it is a `multi:` send. Test: `scripts/sendpin-test.cjs`.

## [0.18.196] — the secret-command check hides secret values and allows long commands

- The check of a gated Terminal command printed the user's phrase, password or seed, and its 80-character limit made `vault action:restorekeys phrase:"…"` with a 24-word phrase, `vault action:wipekeys seed:0x…` and long `passwordlock` / `passwordunlock` impossible. The check now shows the command with the values of phrase, password, confirm and seed hidden; the confirmation window shows the whole (hidden-value) command, and only the Touch ID prompt, which cannot show more, refuses a command too long for it. The vault actions that change the keys or their lock (wipekeys, restorekeys, passwordlock, passwordunlock, resetkeys, testphrase) have their own kind and typed phrase, CHANGE KEYS, with wording that says so; their answer still goes to the dialog that closes itself. The pass stays bound to the exact raw text; a repeated parameter is refused before the phrase is asked. Test: `scripts/cmdgate-test.cjs` (the review's commands must be armable; every earlier variant stays gated).

## [0.18.195] — miniMall: orders stored by 0.18.69 are read safely

- A shop.json written by 0.18.69 has no coin lists and no listing check. An old half-paid order had its coin counted again on the first scan (a false PAID), phone orders stored with no items became Unchecked though paid, and old paid orders got an Unchecked banner. At load an old order now keeps its verdict when it is paid or confirmed, shipped or delivered (no re-check, no banner); an old order with money counted but no coin list is counted again from the coins the node still shows (the old figure kept for the screen; it errs towards underpaid and a check by hand, never towards paid); an old order without items says "the items were not kept by an older version of this app" and can be checked by hand. Test: `scripts/shop-migrate-test.cjs` (the review's 0.18.69 fixture).

## [0.18.194] — the Terminal echoes a command at once again

- Since 0.18.173 the Terminal ran a command first and showed it only when the node answered, so a send (up to three minutes) showed nothing and invited a second send. The Terminal now asks the main process what the text is first (`mcd:cmdKind`: the gate's own reading): an ordinary command is echoed and kept in the history at once; a command that shows a secret goes to its gate; a chain holding one is refused. While a signing command runs, the same text typed again only gets a note; typing it once more runs it. The main process refusal stays the gate. Test: `scripts/cmdgate-test.cjs`.

## [0.18.193] — source is checked out with LF everywhere

- The Windows CI runner checks files out with CRLF line ends, and the tests that read source text or lift a function out of it (looking for "\\n}\\n") then failed there ("shopDoPay is not defined", and, behind it, failures in the Web Wallet, secret-gate, send-pin and ETH-key suites). `.gitattributes` now checks every .js, .cjs, .mjs, .html, .css and .sh file out with LF on every platform (all are committed with LF, so nothing changed in the repository; the vendored PandaPools engine and `scripts/ethwallet-unit.js` keep their exact bytes). Proof: a clone made with `core.autocrlf=true` failed 8 tests before and passes them all after.

## [0.18.192] — off macOS the Touch ID marker is ignored

- Windows and Linux have no Touch ID, so no marker is ever written there, and a marker copied from a Mac is now ignored: a Windows or Linux user always gets the confirmation window and is never refused. (The 0.18.191 rule "an id that cannot be read counts as the same Mac" made a copied marker refuse on Linux, where the id is never readable; that is how the Linux CI leg failed.) The test injects the platform and the machine id instead of depending on the host. Test: `scripts/ethkey-test.cjs`.

## [0.18.191] — the Touch ID marker names the Mac by its hardware UUID

- The marker's machine identifier (0.18.186) was a hash of network-card addresses, which change when an adapter is plugged in. It is now the Mac's IOPlatformUUID, read once with `/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice` (absolute path, no shell) and cached; an identifier that cannot be read counts as the same Mac. Test: `scripts/ethkey-test.cjs`.

## [0.18.190] — miniMall vendor: an order's dust counts together

- Coins below the dust line (0.18.181) were never counted, so a 9.9 payment and two top-ups of 0.05 left a 10 order unpaid. An order's dust coins are now gathered in memory and counted together once their sum covers what is still due (in any order, and again after a restart, when the scanner sees them anew); a flood of dust that never covers the remainder still writes nothing (an order keeps its 1000 largest in memory). Test: `scripts/shop-test.cjs`.

## [0.18.189] — a parameter name glued after a quote counts

- Parameter names were read with quotes dropped, so a name glued after a closing quote (`keys action:"list"action:genkey`, `send … tokenid:"0xFF"tokenid:0x00`) ran together with the value before it and was not seen as a repeat. Names are now read with quotes as spaces and with whatever stands inside {…} or […] blanked (a key in a state's JSON is not a parameter); the send pin reads its values the same way. Tests: `scripts/cmdgate-test.cjs`, `scripts/sendpin-test.cjs`.

## [0.18.188] — plain reasons before a command, and quoted file paths

- A chat picture whose file name or folder holds ";" or a quote, and a Vestr password with ";", are now refused with a plain reason before anything is sent (0.18.177 refused them only at the command). The `file:` path of `keets action:fetch` and `keets action:publish` is now quoted: the app's data folder holds a space ("Application Support"), and the node's parser takes a quoted value whole and drops the quotes (as it does for `backup password:"x"`; not run against a node here). A picture's extension is checked (anything else becomes .jpg). Test: `scripts/inject-test.cjs`.

## [0.18.187] — a send that repeats a parameter is refused

- The node keeps the LAST of a repeated parameter, but the send pin read the first `tokenid:` and `amount:` and matched `fromaddress:` anywhere, also inside a state's JSON. `mcd:cmd` now refuses a send that names amount, tokenid, address or fromaddress more than once, with a plain message; the pin reads the last value of each and a top-level `fromaddress:` only. Test: `scripts/sendpin-test.cjs`.

## [0.18.186] — the Touch ID marker

- The marker that makes a Mac whose Touch ID cannot prompt refuse (0.18.176) was written before the prompt, even when it then failed, and held no sign of which Mac wrote it. It is now written only after a Touch ID prompt succeeded, holds an identifier of this Mac (a hash of its built-in network card address), and a marker from another Mac (a copied profile) is ignored. The refusal names the file's whole path and says what to do in both cases: Touch ID locked (lock the screen and log in with the password) or no longer on this Mac (quit the app and delete the file; the confirmation window is then used). Test: `scripts/ethkey-test.cjs`.

## [0.18.185] — miniMall vendor: dust is judged again; payments read oldest first

- A dust coin (0.18.181) was written to the counted list for good, and payment coins were read newest first, so a 9.95 payment and a 0.05 top-up seen together left a 10 order UNDERPAID for ever (the 0.05 was dust against 10 still due). A dust coin is now not remembered and nothing is saved for it: it is judged again later against what is then still due (once more in the same scan after another coin counted, and on every later scan). Payment coins are read oldest first (the larger first within one block). 5000 dust coins write nothing. Test: `scripts/shop-test.cjs` (the reviewer's proof, both orders, one scan and two).

## [0.18.184] — the secret-command check shows the whole command

- The Touch ID prompt showed the first 80 characters of a gated command (the confirmation window 600) and approved the whole text, and the node keeps the LAST of a repeated parameter: `keys action:list` + 70 spaces + `action:genkey` read as harmless and ran genkey. The check now shows the whole command (control and bidirectional characters as spaces, white space collapsed) after the words "show a seed phrase / a private key by running:"; a gated command longer than 80 characters is refused, and so is one that names any parameter twice (`main/cmdverb.js` `repeated`). The pass stays bound to the exact original text. Test: `scripts/cmdgate-test.cjs` (the reviewer's proof).

## [0.18.183] — miniMall: ids a peer writes read own entries only

- The store looked shops, orders and chat lines up with `map[id]`, so a buyer's `shopId:"__proto__"` found Object.prototype and passed as "a shop I made", and an order ref of `"__proto__"` let a payment write into the prototype. Every lookup by such an id now reads own entries only (`Object.hasOwn`); `"__proto__"` is never stored as a shop, order or chat id. The vendor order screen does not draw a stored null line (the stored order keeps it). Test: `scripts/shop-test.cjs`.

## [0.18.182] — CI runs the chat tests

- `npm run test:chat` (the chat schema and `scripts/chat-peer-test.cjs`) is now a step of the build workflow.

## [0.18.181] — miniMall vendor: dust cannot fill an order's coin list

- An order counts at most 1000 payment coins (0.18.163), so a buyer could fill that list with 1000 coins of almost nothing and block every later real payment. A coin below the larger of 1% of what is due and 0.000001 of the token is now dust: it is remembered (never looked at again), not counted and not put in the order's list; a coin of at least what is still due is never dust, however small. With nothing due by the listing, only the 0.000001 floor applies. Test: `scripts/shop-test.cjs`.

## [0.18.180] — Web Wallet: payments logged with whole identifiers

- The Web Wallet's log line for a sent payment cut the token id and the sending address to 10 characters and did not name the recipient. It now names the token id, the sending address and the recipient whole. Test: `scripts/inject-test.cjs`.

## [0.18.179] — Logs: a privatekey field is scrubbed

- A reply's `"privatekey":"…"` field (as `keys action:genkey` answers) is now redacted like `"phrase"` and `"seed"`, in any letter case. Test: `scripts/node-log-test.cjs`.

## [0.18.178] — screens refuse ; in typed text that goes into a node command

- The two restore screens (seed), the Web Wallet unlock (seed), the Settings resync (phrase, file, password) and the backup password put typed text into a node command through the Terminal's channel, where chains are allowed; a ";" in them started a second command. Each now refuses ";" with the quote and backslash it already refused. Test: `scripts/webwallet-ui-test.cjs`.

## [0.18.177] — a command the app builds is one command

- The node splits a command text on every ";", even inside quotes and JSON. A Web Wallet "seed" pasted with a ";" put a second command after `keys action:genkey phrase:"…"`; a Vestr contract coin (anyone can make one that names this wallet) whose state held a ";" did the same through `runscript … prevstate:` and `txnstate`; a peer's chat media ref (`keets://\\S+`) through `keets action:fetch`; a Vestr password through `send password:"…"`. `main/rpc.js` `oneCommand` now refuses any ";" and every command Mail, miniMall, Chat, Vestr and the Web Wallet build goes through it (nothing is sent); the Web Wallet phrase check also refuses ";" and DEL (any other phrase still passes: anyphrase); a media ref is `keets://` + path characters only. The Terminal's own chains (mcd:cmd) and the AtomiX, PandaPools and casino engines (their own `txnbasics;txnpost`) are not changed. Test: `scripts/inject-test.cjs` (`npm run test:inject`, in CI).

## [0.18.176] — one system check for every secret gate

- The seed, ETH-key and Terminal gates each asked Touch ID where it could prompt and otherwise went on with the typed phrase alone, so a Mac whose Touch ID was locked after failed tries fell back to the phrase. `main/syscheck.js` is now the one system check of all three (after the typed phrase): Touch ID where it can prompt, with a reason that names what is shown (a Terminal command by its text, cut to 80); once Touch ID has worked on this install a marker file in the data folder says so, and while it is there a Mac that cannot prompt now is REFUSED with a plain message; where Touch ID was never available a main-process dialog shows exactly what will be shown (the command) and must be confirmed. The ETH key, Settings seed, first-run seed and Terminal answer dialogs say "No Touch ID check took place" when Touch ID did not take place. Tests: `scripts/ethkey-test.cjs`, `scripts/cmdgate-test.cjs`.

## [0.18.175] — every verb check reads the command as the node does

- The beacon-dust send pin (`main/sendpin.js` and `mcd:cmd`) decided with `/^send\\s/` and `/\\bfromaddress:/`, and the RPC timeout with `startsWith`: `"send" …`, a leading control character, `s"en"d`, `amount : 1` or `fromaddress : 0x…` typed in the Terminal skipped them. They now read the verb and the parameters through `main/cmdverb.js` (the node's trim, quoted first word, quotes dropped, `:` spacing closed up). This version has no signing queue or coin reservation module. The AtomiX and casino send checks read commands their own engines build, never typed text, and are not changed. Tests: `scripts/sendpin-test.cjs`.

## [0.18.174] — the secret-command gate reads a command as the node does

- The 0.18.173 gate read the first word with a JS split, but the node trims every character U+0000 to U+0020, takes a "quoted" first word as the command, makes ":" a token of its own and, on its slow path, drops quotes: `"vault"`, U+0001 + `vault`, `"seedrandom" modifier:ethbridge`, `keys action :genkey`, `va"ul"t phrase:{}` and others were run by the node ungated (22 of the 68 texts the release review ran through minima-core's CommandRunner). `main/cmdverb.js` now over-approximates both of the node's readings (Java trim, case folded as equalsIgnoreCase does) and the gate uses it; all 68 texts and the node's reading of each are in the test. `mcd:cmd` refuses any command text holding a control character other than tab and line end. Any gate try, passed or not, clears an earlier pass. The refusal names vault, seedrandom and keys action:genkey. Chains holding one of them stay refused. Test: `scripts/cmdgate-test.cjs`.

## [0.18.173] — the Terminal gates the commands that show a seed or a private key

- Owner decision. On the general command channel (`mcd:cmd`: the Terminal and anything else in the window), `vault` (every action), `seedrandom` (every modifier) and `keys action:genkey` (prints a new private key) are refused, in any letter case and in any place of a `;` chain, unless a gate was just passed in the main process for that exact command (`main/cmdgate.js`, `mcd:cmdGate`): the typed phrase (SHOW SEED for vault, SHOW KEY for the others) and the Touch ID prompt where the Mac offers it, good for one run within 60 seconds and never again. A chain holding one of them is refused; it must be run on its own. The Terminal asks for the phrase when such a command is typed, runs it once, and shows the answer apart, as text, for 60 seconds at most and until the window is left; the command and its answer are not kept in the Terminal history, output or Copy. The first-run "Reveal my 24-word seed" now uses the Settings gate (0.18.165). Every other command is unchanged; the app's own main-process uses of these commands (Mail, miniMall, Web Wallet, AtomiX) do not use this channel. Test: `scripts/cmdgate-test.cjs` (`npm run test:cmdgate`, in CI).

## [0.18.172] — Chat: a peer's strings are cut to length

- A chat message's decoded strings had no length limit. Each is now cut, before anything uses or stores it, to a length that keeps any real message whole: the body 256 KB (one keets message carries at most that), name 200, media ref 2048, address 90, amount 80, token id 66, token name 200, transaction id 130, state 20 (`main/chat.js` `capDecoded`; `chatschema.js` stays identical to the canonical mds/keetchat copy). Test: `scripts/chat-peer-test.cjs` (in `npm run test:chat`).

## [0.18.171] — Mail: a peer's message is never stored as sent

- Mail stored a peer's `fromname`, `subject`, `message`, `randomid`, `amount`, `tokenid`, `tokenname`, `txpowid`, `image` and `payaddr` (and the `pa:` meta) as they came, so a nested object could break every save of `mail.json` (failures were swallowed) or stop the scan. Each is now a plain value cut to a length that keeps every real message whole (a coin carries at most 90,000 hex characters, so message and picture 45,000, subject 1,000, names 200, amount 80, ids 66 to 130, address 90); a picture is bare base64 or nothing; a pay address (and the `pa:` meta) is kept only when it is a Minima address; a message with no plain id is not stored; one stored message is at most 100 KB; each coin of the scan is read on its own (a failure is logged and the pass goes on); a failed save is logged. Test: `scripts/mail-peer-test.cjs` (in `npm run test:mail`, in CI).

## [0.18.170] — Vestr amounts never rounded; the vendor id whole

- Vestr showed every amount through `toLocaleString` with 8 decimals, which rounds (0.999999999 read 1), and its calculator through `toFixed`. `vFmt` now shows the node's figure as written (an exponent form written out exactly), and the calculator's estimates are cut to 6 and 8 decimals, never rounded. miniMall Studio showed the vendor id cut to 18 characters; it now shows the vendor id and payout address whole and click-to-copy. Test: `scripts/webwallet-ui-test.cjs`.

## [0.18.169] — Logs: a seed field is scrubbed

- A reply's `"seed":"…"` (the vault's seed), `"seedphrase"` and `"mnemonic"` fields are now redacted like `"phrase"`. Log files written before this version are not touched. Test: `scripts/node-log-test.cjs`.

## [0.18.168] — miniMall: listing problems name MxUSD

- A currency mismatch in an order check named the wire value ("USDT"); it now reads MxUSD. Test: `scripts/shop-test.cjs`.

## [0.18.167] — Logs: the last unended line is logged on close

- The node process's "exit" event can come before its streams have handed over their last chunk, so the unended last line (0.18.160) is now logged on "close" (`flushCarry`). Test: `scripts/node-log-test.cjs`.

## [0.18.166] — miniMall vendor: only the three statuses the screen offers

- `advanceStatus` took any status the window passed (and sent it to the buyer). It now accepts only CONFIRMED, SHIPPED and DELIVERED, the three the vendor screen offers; the screen has no cancel or refund state. Test: `scripts/shop-test.cjs`.

## [0.18.165] — Settings: the seed phrase is shown only through a gate

- Settings' "Reveal seed phrase" put the seed on the screen with one click. It now asks for the typed phrase SHOW SEED and, where the system offers it, the Touch ID prompt, both checked in the main process before the node is asked for its seed (`main/seedgate.js`, `mcd:seedReveal`). The phrase is shown as text, says when no system check took place, and hides itself after 60 seconds and when the window is left. No copy is offered (the screen never had one). Not changed: the Terminal still accepts `vault` and `seedrandom` (an open owner decision), and the first-run backup screen still shows the new seed with one click. Test: `scripts/ethkey-test.cjs`.

## [0.18.164] — miniMall: a peer's message is never stored as sent

- An order line was stored as the buyer sent it, so items nested 12,000 arrays deep made every later save of `shop.json` throw (the error was swallowed: nothing was saved for the session), and a nested `quantity` (or any field turned into text) threw and stopped the whole order scan. Every stored line is now rebuilt from capped primitives only (product 200, quantity 12, unitPrice 80, lineTotal 80, size 60, nftTokenId 66, nftStateIdx 12, nftBundle 12; anything else dropped); the buyer's amount (80) and every other string a peer sends are primitives cut to length, never converted or used as a key as they came (shopId, status, randomid, date too); one stored order is at most 48 KB; each coin of the scan is handled on its own (a failure is logged and the batch goes on); a save that fails is logged. Test: `scripts/shop-test.cjs`.

## [0.18.163] — miniMall vendor: a payment coin counts once, across restarts

- The scanner remembered the payment coins it had counted in memory only, so after a restart its backfill counted the same coin again and a half-paid order became PAID. Every counted coin id is now kept in `shop.json`: on the order (up to 1000) and in one global list (up to 100000, oldest first out) so one coin never counts for two orders; `recordPayment(ref, amount, token, coinid)` answers ALREADY for a counted coin and counts nothing without a coin id. A payment that arrives before its order is no longer marked seen, so it is matched once the order is in. Test: `scripts/shop-test.cjs` (from the reviewer's probe).

## [0.18.162] — the key audit reply is capped at 512 KB

- The KeyUses audit replies (`mcd:keyAudit`, `mcd:keyReuse`) were read up to netfetch's general 8 MB cap. They are now dropped, not parsed, above 512 KB, as the phone's AuditApi and the dev branch (0.19.137) do: `netfetch.fetchJson` `opts.maxBytes` may lower the cap, never raise it. Test: `scripts/netfetch-test.cjs`.

## [0.18.161] — no script reaches a node or a docker container by itself

- `scripts/atomix-unit.js` (run in CI), `atomix-boot-gate.js` and `atomix-s2-gate.js` ran `docker exec` into a fixed container name whenever docker answered; on the owner's machine that container is a custody wallet, and the scripts booted the AtomiX engine on it and read its seed. They now reach only a node the caller names (`scripts/test-node.cjs` from the dev branch 0.18.140 / 0.19.103: `AX_TEST_NODE_RPC`, optionally `AX_TEST_NODE_CONTAINER`, `AX_TEST_NODE_I_OWN_THIS=yes`, and for a node that holds funds `AX_TEST_NODE_ADDRESS` confirmed by that node; `balance` is sent first). With none named the gates refuse and atomix-unit skips its one live check, and atomix-unit fails if it starts any child process. No container name, address or port of any node is written in the scripts; the boot gate's expected Ethereum address is `AX_TEST_NODE_EXPECT_ETH`. `cdp-eval.js` names no app port (`AX_TEST_CDP_PORT`). Test: `scripts/test-node-test.cjs` (`npm run test:test-node`, in CI).

## [0.18.160] — Logs: whole lines only, so a split secret is still scrubbed

- The node's stdout and stderr arrive in chunks, and each chunk was logged as if it were whole lines: a line split across two chunks became two lines, so a secret split there passed the 0.18.153 scrub in two halves. `nodeSaid` (from the dev branch) keeps the unfinished last line of each stream for the next chunk and logs only whole lines (a line over 64K is cut there); what is left is logged when the node exits. Test: `scripts/node-log-test.cjs`.

## [0.18.159] — miniMall vendor: an order is due what the vendor's own listing says

- An incoming order's items, prices and total were the buyer's own figures, so a buyer could write a total of 0.000000001 for real goods, pay that and see the order PAID. `main/shop-listing.js` `check` now recomputes what is due from the vendor's OWN stored shop: each line a listed product (name, and NFT token id / edition / bundle where present), at the listed price, a whole quantity above zero within stock, plus the listed delivery fee, exact BigInt; the order's currency must be the shop's. `recordPayment` compares the coins with that figure only: PAID when received >= due > 0. An order that does not match is UNCHECKED ("Unchecked: the items or total do not match your shop; check by hand"), never paid by any amount, and Confirm / Ship / Deliver are refused (main process and screen) until the vendor answers an explicit "I checked this order by hand" question. Phone-placed orders (items as a JSON string, delivery by id) are now read; they were stored with no items before. Same rule as the phone Inbox 0.5.18 (`Listing.check`). Test: `scripts/shop-test.cjs`.

## [0.18.158] — Web Wallet and Vestr: a token is shown with its whole id

- Both screens showed a token by the name in its own metadata, so a token named "MINIMA" or "MxUSD" read as the real one, and the Web Wallet showed an unnamed token by the first 12 characters of its id. A token not known by its id is now its name (invisible, control and bidi characters taken out) with its whole token id beside it; a name that reads as Minima, MxUSD or USDT, or is only the start of the id, is not shown, the id alone is (`tokLabel`). Vestr's Collect button now escapes the token name it carries. Port of 0.19.124 (the dashes and table lookups of that commit have no counterpart here). Test: `scripts/webwallet-ui-test.cjs`.

## [0.18.157] — Settings: the deep key audit runs only on its button

- Opening Settings sent every public key of this node (and then their addresses) to the KeyUses service by itself, every minute it was reopened. The deep reuse audit now runs only when "Deep reuse audit" is pressed, and the card says what is sent and to whom. The privacy part of 0.19.127 (the released app keeps its card; the KeyUses app is not ported). Test: `scripts/webwallet-ui-test.cjs`.

## [0.18.156] — Web Wallet: the public key leaves only on a click

- Unlocking a foreign seed in the Web Wallet sent its public key to the key audit service (eurobuddha.com) by itself. Now nothing leaves at unlock: the on-chain key uses are read only when the user clicks Check on-chain or Confirm, the screen says before those buttons what is sent and to whom, and Confirm refuses while the figure is unread (it used to take an unreadable answer as 0, and a count that is too low reuses a one-time signature). The key audit requests follow no redirect (`netfetch.fetchJson` `noRedirect`). Port of 0.19.135. Tests: `scripts/webwallet-ui-test.cjs`, `scripts/netfetch-test.cjs`.

## [0.18.155] — Web Wallet: the UNKNOWN lock is kept per wallet address

- After a send the node did not confirm, the Web Wallet disabled Send until "I've checked", but Lock (or leaving the screen) reset that flag, so unlocking again offered Send at once with the possible first payment unchecked. The lock is now kept per wallet address across Lock and leaving the screen, only "I've checked" clears it, and the send itself refuses while it stands. Port of 0.19.123. Test: `scripts/webwallet-ui-test.cjs` (`npm run test:webwallet-ui`, in CI).

## [0.18.154] — a chain of commands is never given the send pin

- `main/sendpin.js` `pinMinimaSend` appended `fromaddress:` to the end of the command text, so for a Terminal chain (`send …; status`) it landed on the LAST command as a stray parameter while the send itself went out unpinned. A chain is now sent as typed. Port of the main-process part of 0.19.122 (the released Terminal has no pin note and keeps its own output handling). Test: `scripts/sendpin-test.cjs` (`npm run test:sendpin`, in CI).

## [0.18.153] — Logs: the RPC secret, bare seed words and bidi controls scrubbed

- The node prints its own start parameters, `-rpcpassword` among them, so the RPC secret went into the Logs view and `node.log`. `main/nodelog.js` `scrub` now takes it out of every line (only a secret of 8 characters or more is looked for), before the 400-character cut; a seed phrase given as bare words or as a reply's JSON is redacted as the quoted form was, without eating the rest of the line; bidirectional text controls are stripped. Port of 0.19.121 (the released app has no Save to file, so `forFile` is not ported). Test: `scripts/node-log-test.cjs` (`npm run test:node-log`, in CI).

## [0.18.152] — one gated way to the ETH private key

- Both `mcd:axExportKey` (AtomiX panel) and `mcd:ewExportKey` (ETH Wallet) handed the key to any caller in the window with no check. `mcd:axExportKey` and its bridge are removed; `mcd:ewExportKey` now needs the typed phrase SHOW KEY and, where the system offers it, the Touch ID prompt, both checked in the main process (`main/ethwallet.js` `exportKeyGated`). The AtomiX panel's Export key opens the same dialog and holds no key. The key is shown as text in one node, says when no system check took place, and closes after 60 seconds and when the window is left. A copied key goes to the clipboard through the main process and is cleared after 60 seconds and at quit, only if the clipboard still holds it (`main/clipsecret.js`). Port of 0.19.108 / 0.19.120. Test: `scripts/ethkey-test.cjs` (`npm run test:ethkey`, in CI); `scripts/panels-test.cjs` updated for the intended change.

## [0.18.151] — miniMall vendor: an order is paid in the shop's own token

- An incoming order took its token from the currency the BUYER wrote (`routeIncoming`, `tokenFor(w.currency)`): an order to an MxUSD shop that said "Minima" was marked PAID by a payment in Minima. The token, the currency and the new-order notification now come from the vendor's own stored shop. Orders and totals show the currency as MxUSD. Test: `scripts/shop-test.cjs`.

## [0.18.150] — miniMall pays the token its currency names

- A `.shop` that says Minima and carries the MxUSD token id (or any token id that is not its currency's) is refused on import, on opening a stored shop, before Pay and in the main process before the order message (`placeOrder`) and on Retry payment; the token paid is the one the currency names. Pay now asks first and shows the amount sent, the token id and the vendor's address whole, each on its own line. Prices and fees are plain decimals; totals are exact in BigInt (six decimals as before, the exact figure when a price has more). Product pictures are inline `data:image` pictures or nothing. The Studio currency button reads MxUSD. Rules shared by screen and main process in `renderer/shop-rules.js`. Port of 0.19.118. Test: `scripts/shop-test.cjs`.

## [0.18.149] — miniMall: a malformed order total is never paid

- `main/shop-store.js` `decCmp` returned 0 ("equal") when it could not read a figure, so an incoming order whose buyer-written total was malformed ("abc", "1e3") counted as PAID by any payment in the right token; a zero or negative total was accepted the same way. Figures are now plain decimals only, compared exactly in BigInt; a total that is not a figure above zero is `BAD_TOTAL` (shown as "invalid total") and is never paid. Test: `scripts/shop-test.cjs` (`npm run test:shop`, in CI).

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
