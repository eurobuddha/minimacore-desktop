# Changelog

All notable changes to **minimaCore Desktop** — the cross-platform (macOS / Windows / Linux) Electron app that runs
a full minimaCore node locally with a native-styled wallet + module suite. Newest first. Each release is tagged
`vX.Y.Z`; since 0.13.0 the installers (`.dmg` / `.exe` / `.AppImage`) are built on GitHub Actions and attached to the
matching [GitHub Release](../../releases).

---

## [0.18.330] — P2P Chance: a settle-only mode for the offers and bets a wallet still has on chain

- Review of 0.18.329 (finding 1): 0.18.318 removed P2P Chance entirely, so a wallet with an open offer or bet at `0xD65ADBBB7AB5032D794B02CF5E8814C720BE3C9562CC6C07081DE41CCA665A6F` could no longer cancel, reveal, collect or claim it. An untaken offer has no deadline and can still be taken in another client; once taken, the house has the timeout (1500 blocks) to reveal or the taker takes the whole pot, and the house secret sat in the keychain with nothing to use it.
- main/casino-settle.js (new, written fresh: the removed engine is not restored). No bet, no offer, no take. Only for coins whose key the NODE lists as this wallet's (`keys`; addresses from `scripts`): (a) Cancel an open offer back to this wallet's own address (a button, and "Cancel all my open offers"); (b) reveal for a taken offer whose secret this computer holds; (c) collect a bet this wallet won; (d) claim a pot after the other side's timeout (phase 1 as the player, phase 2 as the house). (b), (c) and (d) run by themselves on each new block while the app is open, for a wallet that ever switched P2P Chance on, and each one is said in a notification with the whole coin id.
- Injection: every state value is checked to an exact shape before use (this wallet's key, the commit and the secrets: 0x and 64 hex; what the other side wrote and must be copied: 0x hex of whole bytes or a plain decimal; range and payout: whole numbers; addresses paid: 0x hex up to 32 bytes). Every command is one command, passes main/cmdverb.js `refuse`, and must match one of the module's own command shapes or it is not sent. A coin with any other value is left alone and listed as not settled automatically, with its whole coin id.
- The secret of an offer that is still open is never shown. A forged phase-1 coin can copy the key and commit of a live offer; a reveal for it would publish the secret and let the forger take the real offer with a winning pick. The covenant lets an offer be spent only by its owner's signature or by a real take, so the reveal is made only when the same confirmed coin scan holds no phase-0 coin with that commit and a key of this wallet (asked for by itself when the key list does not hold it); while one exists it is cancelled first and the reveal waits. A phase-1 coin that does not hold exactly bet x payout cannot be a taken offer of this app and is not revealed automatically.
- Outcome and payout as the covenant computes them (SHA3 of house secret and player secret, the first 4 bytes modulo the range, equal to the pick; winnings bet x payout, the rest to the house), in exact decimals. Every transaction path ends in `txndelete`; a posted transaction is written to casino-settle.json before the post and not built again for 10 blocks; an unanswered post is "sent, outcome unknown", not a failure.
- The window: one dialog, "P2P Chance was removed: your open offers and bets", from Settings and from the one-time notice: each coin with its phase, amount, token, blocks left before the other side can take the pot, whole coin id (click to copy), Cancel offer / Settle now. The one-time notice is now a dialog of the window (the text of a native message box could not be selected: the contract and the Terminal command copy on a click) and says what the app still does and does not do.
- Known limits, said in the list: a taker who writes text (not hex or a number) into ports 8-11 makes the reveal impossible here, as in 0.18.317; an offer or bet is settled only while the app is open with the node running; the node-stop warning does not count open offers and bets.
- Tests: scripts/casino-settle-test.cjs (`npm run test:casino-settle`, in CI): a stand-in node that splits on every ";", keeps the last duplicate parameter, never lists a spent coin, and judges each posted transaction by the covenant re-implemented from its script with Node's own SHA3. The module does not exist on 0.18.329. scripts/casino-removed-test.cjs CHANGED on purpose: the settle-only module, its six channels and the notice dialog are allowed; a tab, a view, a bet, an offer or a take are still refused.

## [0.18.329] — AtomiX: a market is never published as zero because a balance read failed

- Review of minimaCore Desktop 0.18.328 (MAJOR 2), the same code in all three desktop apps. `makerAvail` turned a failed read into 0 (`Number(b.minima) || 0`: `balances()` gives "0" when the `balance` RPC fails and "—" when the USDT read fails), and Save, Publish and the desk's republish then published a zero order: the market left every book and a key use was spent, with no error.
- main/makeravail.js (new): Save and Publish refuse on a failed read ("Your … balance could not be read just now …: nothing was published"); a real zero is still zero; Withdraw and the currency switch (a tombstone carries no size) go as before. `balances()` now says when the Minima-side read failed (`minimaErr`).
- Test: scripts/makeravail-test.cjs (in test:ethwallet) (the module does not exist on 0.18.328).

## [0.18.328] — AtomiX engine 0.1.71 re-vendored

- main/atomix/{service.js, lib/trading,mdsw,ethtx,htlc,boot,settle,peg,responder,maker,wallet,inspect,ui}.js copied byte-for-byte from atomix-mds 0.1.71 (git `fa5efa7e55fa679b066e231e5a451ad9d59d423c`, branch security/2026-11-07, clean tree); scripts/atomix-parity-check.sh passes (40 engine files identical to the donor; it failed on mdsw, htlc, peg and maker at 0.18.327). lib/ui.js is not loaded here and not in the parity list; copied so it no longer calls the removed `wallet.shortAddr`. Nothing in this app's glue calls `wallet.shortAddr` (its `shortAddr` fields already carry the full address).
- What it brings: 0.1.49-0.1.61 (spread and randomised sizes on the market editor, the order-book layout, security logging of refused commands, untrimmed HTLC validators); 0.1.62 the wallet keeper's split asks for coinage:3 and backs off, 0.1.68 and only to an address the node is proven to own, checked right before the send; 0.1.63 a password-locked plain node is said as locked; 0.1.64 and 0.1.69 a balance it could not read is never published as 0 and does not switch off the dead-feed safety; 0.1.65 identifiers shown whole; 0.1.66 the Minima dollar token is MxUSD everywhere (the stored key stays "mxusdt"); 0.1.67 and 0.1.70 an ETH gas price above 8000 gwei is refused before signing, decided on three quotes (this app's highest tier price is the 5000 gwei ceiling, 0.18.323).
- The engine's Ethereum RPC endpoint lists (lib/ethrpc.js FALLBACKS, lib/ethhtlc.js NET.rpcs) did not change, so main/atomix.js NET_HOSTS is unchanged.
- Test: scripts/engine-inject.test.cjs — the 8000 gwei signing ceiling sits above every tier this app offers, MxUSD, no 0 balance published, the keeper's coinage:3 split with its ownership proof; fails on 0.18.327.

## [0.18.327] — Chat: a peer's inbox sender or id, a recipient and a media ref reach a keets command only when plain

- main/chat.js: `keets action:ack id:` and `keets action:send to:` pasted the inbox entry's `id` and `from` as the node gave them; an entry whose sender is not 64 hex digits (with or without 0x) or whose id is not plain characters (`[A-Za-z0-9_.-]`, at most 128) is now skipped and logged, never put in a command. Every typed send (payments, photos, voice) checks its recipient (`sendTyped`), and a read receipt is sent only to a plain key.
- The media ref is checked at the IPC as well (`mcd:chatMedia`, main/main.js: keets:// and plain characters, at most 620) before chat.fetchMedia's whole check (since 0.18.177: no ";", ":", quotes or white space, bounded). A picked file path, and the app's media folder, with a ";", a quote or any control character (DEL included) is refused with a plain message. Together with main/rpc.js's refusal of ";" and control characters under every caller (0.18.317, 0.18.319).
- Mail: its only command with a pasted value is the constant chain-mail address; nothing from a peer reaches a command there.
- Test: scripts/chat-peer-test.cjs (in test:chat) — inbox entries with a parameter in the id or the sender send nothing with it, a plain one is acknowledged; bad refs, paths and recipients are refused before any command; fails on 0.18.326. scripts/inject-test.cjs: the path message now names control characters (CHANGED on purpose).

## [0.18.326] — PandaPools: a txnpost answered after a wallet identity change stays pending

- main/pandapools.js: an answer that arrives after `invalidate()` (a seed restore or wallet change bumps the epoch) was handed to the engine as a bare `{status:false}`, the engine's "refused, nothing was broadcast", which frees the posted inputs' claims. For a `txnpost` that request was sent: it now answers `{status:false, pending:true, error:"the node did not answer txnpost, …"}` like an unanswered post (0.18.324). Other commands answered then stay a plain failure.
- Test: scripts/pandapools-queue.test.cjs (in test:pandapools); fails on 0.18.325.

## [0.18.325] — PandaPools engine 0.6.51 re-vendored

- main/pandapools/{poolmgr,service,input-claims,runtime-guard}.js copied byte-for-byte from pandapools-mds 0.6.51 (git `349034920fb93210d02e77f7d3f5257995ccfe23`, branch security/2026-11-07); the other 15 engine files were already identical. scripts/pandapools-parity.manifest.json updated with `--update`; scripts/pandapools-parity-check.cjs passes against the donor.
- What it brings: the engine's command wrapper refuses ";" and every control character with the one regex `[;\x00-\x1f\x7f]` (0.6.47, as main/cmdverb.js); an all-zero pool token of any length is refused and KMIN must be below 2^64-1 (0.6.48); the headless service scan runs to its end (0.6.49); an unanswered txnpost keeps its inputs claimed (0.6.50, with this app's 0.18.324 shim); an unnamed token is labelled by its whole id (0.6.51).
- Test: scripts/engine-inject.test.cjs — the engine's UNSAFE_RE equals main/cmdverb.js's, the all-zero token check, donor 0.6.51 in the manifest; with the manifest, fails on 0.18.324.

## [0.18.324] — PandaPools: a txnpost the node did not answer keeps its inputs held

- The PandaPools shim (main/pandapools.js) answered every failed command `{status:false}`. For `txnpost` that is the engine's "the node refused it; nothing was broadcast", so poolmgr freed the posted inputs (PoolInputClaims.release) for a transaction that may be in the mempool, and the next swap could build on them. A `txnpost` whose request was sent but got no answer (a timeout, a reset, a cut or unreadable reply) now answers `{status:false, pending:true, error:"the node did not answer txnpost, so the transaction may have been posted: …"}`, which the engine keeps held. A post that never reached the node (main/rpc.js `notSent`: refused before sending, ECONNREFUSED, a wrong RPC password) and every other command stay a plain failure.
- Test: scripts/pandapools-queue.test.cjs (in test:pandapools); fails on 0.18.323.

## [0.18.323] — ETH: the AtomiX tab's Send takes the ETH Wallet's guarded path; fee tiers match the engine's ×9/8 with the ceiling after the multiplier

- The AtomiX tab's wallet Send (`mcd:axSend` / `axSendReview` / `axSendMax`) sent at the RPC's raw gas price with no ceiling (a hostile RPC set the fee), no EIP-55 check, no one-send-at-a-time guard and no "may have gone through" on a cut broadcast. It now calls the ETH Wallet tab's `ethSendReview` / `ethSendExecute` / `ethSendMax` at the Medium tier (ETH, or the USDT contract `0xdac17f958d2ee523a2206206994597c13d831ec7`, known to the send path even when removed from the ETH Wallet's token list). The sent toast names the transaction hash whole.
- Fee tiers: the vendored engine (AX.ethtx / AX.wallet since AtomiX 0.1.40) applies ×9/8 and floors at baseFee×9/8 + 0.2 gwei; the tier proxy still pre-divided by 1.2, so every tier broadcast about 6% under its preview, and the Max reserve (also ÷1.2) was below the High tier's cost. The proxy now pre-scales ×8/9; a tier's price is `ethCapGas(effBase × mult)` (the 5000 gwei ceiling AFTER the multiplier: High reached about 1.6× the ceiling); the reserve covers 175% with the ceiling, plus the floor tip, rounded up.
- Tests: scripts/ethwallet-unit.js (test:ethwallet) mirrors the engine's real ×9/8 arithmetic (CHANGED on purpose: it mirrored ×12/10); preview equals broadcast, the reserve covers High, no tier passes the ceiling, the AtomiX Send routes through the guarded path; 24 checks fail on 0.18.322.

## [0.18.322] — Vestr collect: one at a time per coin; only the node's own refusal of the post is a failure

- main/vestr.js `collect`: a per-coin in-flight set. A second collect of a coin (a second click, the list re-rendered) while the first is being built or posted is refused ("already being sent. Nothing more was sent.") instead of building a second transaction of the same coin.
- The post: only the node's own refusal (`status:false`, not pending) fails ("Nothing was collected"). No answer (a timeout, a reset, an unreadable reply) or a pending reply is "posted, outcome unknown": `{ ok:true, unknown:true }`, and the screen says to check History and wait for the list before collecting again (it said "Collect failed"). A post that never reached the node is still a failure: main/rpc.js marks those (`neverSent`: refused before sending, ECONNREFUSED, a wrong RPC password).
- Tests: scripts/inject-test.cjs (in test:inject) — the second collect refused while the first posts, one post; no answer and pending → unknown; refusal and never-sent → failure; rpcCall marks a refused and an unconnected call. V4 / V5 and the 0.18.209 line CHANGED on purpose. Fails on 0.18.321.

## [0.18.321] — the node-jar pin is checked on every build path and inside the built Mac app

- scripts/assert-jars.sh takes an optional directory (default resources/). scripts/verify-mac.sh runs it on the built app's `Contents/Resources`, so the jars checked are the jars that ship under the signature.
- `dist`, `dist:mac`, `dist:win` and `dist:linux` run it before electron-builder (`dist:mac:signed` and scripts/release-desktop.sh already did); CI runs it as one step after fetching parlons-node.jar, before the build.
- Test: scripts/assert-jars-test.cjs (`npm run test:jars`, in CI) — a stale jar in resources/ or in a built app is refused, the pinned ones pass, and each build path runs the check; fails on 0.18.320.

## [0.18.320] — miniMall: a payment coin seen before its order is read is kept at sight, so a spend first no longer loses it

- `coins` lists only unspent coins, and the vendor's wallet may spend a payment once it is 3 blocks old. A payment coin whose order message had not been read yet was left to be judged on a later pass, and if the wallet spent it first it was never counted (main/shop.js judgeOne, the two "not marked seen" returns).
- Such a coin is now recorded at first sight in shop.json (main/shop-store.js `holdUnmatched`: its full coin id, block, amount, token and state ports 1-2; flushed; at most 500, the oldest dropped) and judged with the listed coins on every pass, also after the wallet spent it, until it is judged against its order (then dropped). The store still counts each coin once.
- Test: scripts/shop-test.cjs (in test:shop) — the orders read fails while the payment is listed, the wallet spends the payment, the app restarts, the order is read: it is paid, once, and the coin is no longer kept; the list is bounded. Fails on 0.18.319.

## [0.18.319] — one refusal regex: every control character and DEL, not only CR, LF and NUL

- main/cmdverb.js `UNSAFE_RE = /[;\x00-\x1f\x7f]/` is the one test `refuse()` applies (main/rpc.js under every caller, the Terminal, and the PandaPools and AtomiX shims, which no longer keep their own `/[;\r\n\u0000]/` copy). A tab, ESC, vertical tab or DEL in a command is now refused like ";" and said in the same notification. The Terminal keeps its sentence: send the commands one at a time.
- Test: scripts/engine-inject.test.cjs (in test:inject) — each such character refused by `refuse` and by `rpcCall`, plain commands still pass, no shim keeps a regex of its own; fails on 0.18.318.

## [0.18.318] — P2P Chance (Zero Edge Casino) is removed, pending an audit and a rebuild

- Why: on 23 Nov 2026 the casino was found to put coin state written by a stranger into node commands (coin-state-to-command injection; 0.18.317 closed the hole under every caller). The owner's call: take the casino out entirely and audit and rebuild it later.
- Gone: the P2P Chance tab, view and Settings card (18+ gate), renderer/casino.js, casino.css and casinoart.js, every `mcd:casino*` IPC channel and preload method, main/casino.js and the vendored engine main/casino/ (its NEWBLOCK settle loop, offer keepalive, timeout-claim notifications, send pin, `checkmode` synthesis and keychain glue), its node-stop guard lines, its seed-change invalidation, the casino suites (glue, keepalive, timeout, parity, the Java oracles) and their CI step, and the three casino docs. PandaPools keeps its own `checkmode` answer on the plain node kind; AtomiX, PandaPools, the stop guard and the injection refusals are otherwise unchanged.
- Nothing a user stored is deleted: `casinoEnabled` / `casinoAgeCertified` / `casinoDollar` stay in config.json (out of DEFAULTS, so the window can no longer change them) and the casino's keychain secrets (bet preimages, history) are left in place. A wallet that ever switched the casino on is told once, after the window loads, that it was removed for a security fix, that its open offers and bets stay on chain at `0xD65ADBBB7AB5032D794B02CF5E8814C720BE3C9562CC6C07081DE41CCA665A6F`, that this app no longer cancels, renews, reveals, settles or claims them, and how the covenant's deadline works; with the Terminal command that lists its coins there.
- Restore: the last commit with the casino is `61df01e56d291dd623da4125b29e48ceecaeb84a` (0.18.317); `git checkout 61df01e56d291dd623da4125b29e48ceecaeb84a -- main/casino main/casino.js renderer/casino.js renderer/casino.css renderer/casinoart.js scripts/casino-*` and revert this commit's edits to main/main.js, main/preload.js, main/config.js, main/stopguard.js, renderer/app.js, renderer/index.html, renderer/app.css and the workflow. Donor: ~/Projects/archive/Ideas/universal-casino.
- Test: scripts/casino-removed-test.cjs (`npm run test:casino-removed`, in CI): no tab or view, no casino IPC channel or preload method, no casino file under main/ or renderer/ (all the packaged app code), the notice said once and only to a wallet that switched it on, and its config keys surviving a save; fails on 0.18.317.

## [0.18.317] — SECURITY: a stranger's coin state can no longer become a node command

- The node splits every command text on ";" (even inside quotes) and runs each piece. The released app's PandaPools engine read state ports 2-5 of any coin at the public sentinel unchecked into its discovery `runscript` (one payload in the tokenid ran four `send`s), and P2P Chance copied a taker's state 8-12 into `txnstate` / `hash` / `txnoutput` during auto-reveal and auto-resolve, all on the node's admin RPC.
- main/cmdverb.js `refuse(source, text)`: a command holding ";", CR, LF or NUL is refused, nothing is sent; under every caller in main/rpc.js `rpcCall`, and first in the PandaPools, AtomiX and P2P Chance shims, which a notification names (main/main.js). The Terminal refuses a chain before any gate: "send the commands one at a time".
- Re-vendored PandaPools engine 0.6.46 (beacon fields strict hex / number where read; its command wrapper refuses and logs) and P2P Chance service.js 2.9.4 (state read only as hex / number; txnbasics and txnpost as two commands). main/casino/engine.js: the same clean state reads, checks and split chains; the send pin reads the verb as the node does.
- PandaPools on the plain `minima` node kind: `checkmode` (an MDS command that jar answers "Command not found", which refused every pool write) is answered from `status` (WRITE, and the wallet lock).
- scripts/assert-jars.sh, run by `npm run dist:mac:signed` and scripts/release-desktop.sh: the bundled node jars must equal package.json `parlonsNodeSha256` / `minimaJarSha256` (new) — a stale gitignored resources/parlons-node.jar (0.2.152 here) can no longer be packaged.
- Tests: scripts/engine-inject.test.cjs (in test:inject) with scripts/node-standin.cjs (a stand-in node that splits commands like the real one); fails on 0.18.316. cmdgate-test's chain case expects the refusal; the casino fixtures use hex keys.

## [0.18.316] — PandaPools: swaps, deposits, new pools and migrations are no longer refused with "Could not identify the input signing key."

- Every PandaPools action the node signs for you (a swap, a deposit, creating a pool, migrating a pool, and the background keep-fresh and re-announce) stopped before signing with "Could not identify the input signing key." Nothing was signed or sent. The engine's signing check (`ReserveRecovery.checkSignature`, since 0.16.54) asked the node `scripts address:` with each coin's address in lower case; the node looks scripts up by the exact text and stores them in upper case, so it never found one. Closing a pool was not affected (it signs with the pool's owner key, not "auto"). Fixed at the source, PandaPools MiniDapp 0.6.45 (2c99fbb07c7d493e5ace025fe5284295b8e9cbc5): the address goes to the node exactly as the coin carries it, and the answer is still compared ignoring case. `main/pandapools/reserve-recovery.js` re-copied (the only engine file that changed), `scripts/pandapools-parity.manifest.json` re-pinned with `--update`. Same fix as Pandamonium Desktop 0.19.381.
- The tests' stand-in nodes answered `scripts address:` for any address in any case, which is why the tests passed. They now answer only the address exactly as the coins carry it, and otherwise "Script with that address not found", like the real node (scripts/pandapools-recovery.test.cjs, scripts/pandapools-signgate.test.cjs). New test in scripts/pandapools-recovery.test.cjs: an upper-case coin address is looked up once, upper-case, and signing is allowed (fails on 0.18.315 with "Could not identify the input signing key.").

## [0.18.315] — miniMall: a paid order keeps the note that another buyer's order has its reference

- Once an order with a secret was paid in full by its proved coins, every note on it was dropped (0.18.311), also the sentence that another buyer's order without a secret has its reference and was paid (0.18.309). So when a copier's order without a secret was paid by the real buyer's coin without its proof, and the real buyer then also paid with the proof, both orders ended PAID and neither said anything about the clash (review-desktop-r6 H4N1). Only the note of a coin without the order's proof is dropped now (it begins "a payment with this order's reference does not carry this order's proof"); the duplicate sentence stays.
- Tests (scripts/shop-test.cjs): N1 now wants the duplicate sentence kept on the real order once its proved coin pays it, the copier's order still paid (changed on purpose: it wanted the note gone; fails on 0.18.314); an order with only a no-proof note still loses it once paid in full (unchanged).

## [0.18.314] — miniMall: coins of two worthless tokens taking turns no longer write the store once per coin; part paid after a wrong coin is UNDERPAID

- The store was written whenever a coin of another token changed the token paid or the order's status, so coins of two worthless tokens taking turns wrote shop.json once per coin: 2000 such coins with an order's reference wrote it about 1000 times (0.8 MB each with a 400-order store), and again after every restart, as such coins are not remembered (review-desktop-r6 H5d). It is now written only when the order's status changes. The token paid is not shown anywhere.
- A coin of the right token that paid part of an order after a coin of another token left it WRONG_TOKEN (review-desktop-r6 H5c: 0.6 of 1 paid still said WRONG_TOKEN). As in Pandamonium Desktop, a count now replaces WRONG_TOKEN: it says UNDERPAID, then PAID.
- A comment in main/shop-store.js said 0.18.309 for the change of 0.18.310 (a coin given up on and counted after all); it now says 0.18.310.
- Tests (scripts/shop-test.cjs): H5d (2000 coins over two worthless tokens: at most 2 writes at first sight and at most 2 after a restart, WRONG_TOKEN, and the real payment still makes it PAID; 977 writes on 0.18.313); H5c (UNDERPAID after a wrong coin, unchanged by another wrong coin, then PAID; fails on 0.18.313).

## [0.18.313] — comments: no shortened address

- main/nodelog.js's header quoted the node's log line with the AtomiX HTLC address shortened; it now names it whole: 0x0CDCD61692F186EB0BBCFA289F438043F586FF7B3F6864193358E29166E8454A. main/atomix.js's comment on the publish pin named the PandaPools beacon address shortened; it now names it whole, 0x50414E4441504F4F4C53 ("PANDAPOOLS", main/pandapools/service.js SENTINEL). Comments only; nothing in the app changes.

## [0.18.312] — miniMall: coins of another token never fill an order's coin list

- A coin of another token with an order's reference went into the order's coin list (as a WRONG_TOKEN coin), and that list holds at most 1000 coins (ORDER_COINS_MAX). On an order without a secret, 2000 worthless-token coins with its reference in the block of the real payment filled it, and the real payment was never counted (review-desktop-r5 N2c2; not new in this series). As Pandamonium Desktop has it, a coin of another token is now never counted and never kept: the order still says WRONG_TOKEN with the token paid, as before, and a wrong coin seen again changes nothing and writes nothing (it wrote shop.json once per coin).
- Tests (scripts/shop-test.cjs): N2c2 (the order is paid, only the real coin on its list); only wrong coins: WRONG_TOKEN with the token, nothing counted, nothing written when one is seen again after a restart, and the right token still pays it. N2c2 fails on 0.18.311.

## [0.18.311] — miniMall: the no-proof note names the coin's amount and token; a paid order drops its note

- The note left on an order with a secret by a coin with its reference and without its proof named only the coin's id, so a vendor could not tell a stranger's dust or worthless token from a buyer's real payment made without the proof (review-desktop-r5). It now names the coin's amount exactly as the node gave it (never rounded) and its token id whole, or Minima: "a payment with this order's reference does not carry this order's proof (payment coin <id>, amount <amount>, token <token id or Minima>): check by hand". A note may now be 600 characters long (it was cut at 300), so no id in it is cut.
- A note says "check by hand", and it stayed on an order after it became PAID, where no check-by-hand button is offered. Once an order is paid in full by its proved coins, its note is dropped (the simpler of the two choices; notes are only ever on orders with a secret, which only proved coins pay). An unpaid order, also one only part paid, keeps its note.
- Tests (scripts/shop-test.cjs): the note with a 66-character coin id, a 63-character amount and a token id whole (over the old 300-character cut), kept while unpaid and part paid, dropped once paid; "Minima" with the amount's trailing zero kept; N1's note goes once its proved coin pays it. Changed on purpose: the no-proof sentence in the tests; "the note stays shown" on a paid order is now "the note goes"; S2a, S2b and S2d's paid orders carry no note. All fail on 0.18.310.

## [0.18.310] — miniMall: a coin given up on and counted after all no longer holds its order

- A payment coin whose judging threw on three passes is given up on and leaves "payment coin <id> could not be judged: check by hand" on its order (0.18.295). After a restart the coin is judged again and counted, but that problem still held the order: UNCHECKED, never PAID (review-desktop-r5 R6; the released app paid it). When a coin is counted for an order, that order's problem for exactly that coin now goes; when no problem is left, the order is checked against the listing again exactly as a fresh order is (what is due, and any way it departs from the listing, which still holds it), so it is paid as before. Any other problem on it still holds it.
- Tests (scripts/shop-test.cjs): R6 (paid after the restart); the same with a second buyer's order with the reference (still held, the coin counted); the same with the listing's price changed meanwhile (held by the listing check). R6 fails on 0.18.309.

## [0.18.309] — miniMall: a newcomer with a secret that leaves a paid order without one as it is says so in a note

- Since 0.18.306 a second buyer's order WITH a secret leaves a PAID order without one as it is. That newcomer was kept silent: PENDING, nothing said, and a check by hand was refused (review-desktop-r5 N1). When its buyer had paid outside the app without the proof, that coin paid the other order, and the vendor could neither see the clash nor act on the real order (the released app put the duplicate problem on it, so it could be checked by hand). It now carries the duplicate sentence as ONE note: "another buyer sent an order with the same reference …: a payment with it cannot be told apart, so check both orders by hand". A note holds nothing (its own proved coin still pays it), and an unpaid order with a note can be checked by hand.
- Tests (scripts/shop-test.cjs): N1 (the real order shows the note, can be checked by hand, and is still paid by its own proved coin); N1b (paid by its own proved coin: no note, the copier's order held as before); S5's newcomer now carries the note (changed on purpose). N1 and S5 fail on 0.18.308.

## [0.18.308] — miniMall: the review's nits (a coin given up on flags the order it would pay; held in the list; no shortened id)

- A payment coin given up on after three passes that threw (0.18.295) put its problem on the order kept under the coin's reference, also when the coin proves another buyer's copy of it (ref~buyer): it now lands on the order the coin would pay, whenever that is known. One whose reference could not be read names no order, so no check by hand cleared it from the status line: the status line's Dismiss now clears those. At most 64 coins given up on are said; the oldest go first (each was logged with its error, and its order keeps its problem).
- The order list showed a settling order as plain "paid", and only its page said it was held: the list row now carries a "held" mark beside its status.
- A shop.json written by the never-released 0.18.299 may carry its waiting list (`payWait`): it is dropped on load, never read.
- Comments: the settling comments said every order from the coin's block up was known read. That is not so on a first pass whose orders read was cut, nor after a backfill that ended with blocks it could not read: there an order settles as if those blocks had been read, as released 0.18.286 paid it at sight. The comments now say so; nothing there changes.
- No shortened id: the 0.18.303 entry above and the test's comment quoted the covenant's old shortened address, and renderer/app.js's Vestr header named it shortened; the header now names 0x3C432D5099AB27EA901079EF54D9A97AB4DB3BD1CFFF670296C31B7C83C1C8BE whole. The test of main/vestr.js checks that its pattern finds a shortened id, built in the test from CONTRACT's own first and last digits, so no shortened id is written in the test either.
- Tests (scripts/shop-test.cjs, scripts/inject-test.cjs): the coin given up on lands on the victim's copy, not the copier's order; 70 coins whose reference cannot be read: the newest 64 said, Dismiss clears them; a settling order is held in the list; payWait is dropped and not written back (fails on 0.18.307).

## [0.18.307] — miniMall: a check by hand made while an order settles does not outlast its hold

- A settling order can be checked by hand to move it on before its hold runs out (0.18.300). That check made it immune to the second order its hold was waiting for: the vendor checked a copier's settling order, the real order without a secret came 2 blocks later, and the copier's order stayed PAID and confirmable (review-desktop-r4 S3). The check now keeps the block the hold would have run to; a second order without a secret mined up to that block still unpays the order and holds both for a check by hand, unless it was already confirmed or moved on. The check-by-hand question for a settling order now says so: "Another order with this reference can still arrive until block N; it will put both orders back on a check by hand."
- Tests (scripts/shop-test.cjs): S3 with the real order at the hold's last two blocks (held; checked by hand again), one block later (the check stands), and after the vendor confirmed (left as it is); the question's sentence (fails on 0.18.306: the copier's order stays paid).

## [0.18.306] — miniMall: an order with a secret does not unpay a paid order without one

- A PAID order without a secret (not moved on, not checked by hand) was unpaid and held for a check by hand (0.18.289) by any second buyer's order with its reference, also one that came with a secret (review-desktop-r4 S5; released 0.18.286 kept it PAID). An order without a secret is paid only by coins without a proof, and an honest buyer with a secret pays with its proof, so that newcomer cannot be the one whose coin paid it: the paid order now stays PAID, and the newcomer is kept as its own order and waits for its own proved coin. A newcomer without a secret, or with one that cannot be read, still holds the paid order, as does any newcomer an order stored before 0.18.297 (paid by any coin with its reference).
- Tests (scripts/shop-test.cjs): S5 (the paid order stays paid and is confirmed; the newcomer is not paid and not held); a newcomer without a secret, with an unreadable one, or against an order stored before 0.18.297 still holds it (fails on 0.18.305).

## [0.18.305] — miniMall: a coin without an order's proof is a note, never a hold; coins of one block are judged by coin id

- An order with a secret is paid only by coins proving it (0.18.297). A coin with its reference that proved nothing and paid no order went through the duplicate rule: what is due was cleared and the order made UNCHECKED, so a stranger's coin with the reference (a worthless token's coin in the same block as the real payment, a dust coin between a half payment and its top-up, a coin with another proof before the payment) left the order unpaid and not confirmable (review-desktop-r4 S2a, S2b, S2d; released 0.18.286 paid all three). Now it is a note on the order, at most one, the first coin's id whole, shown on the order and in the check-by-hand question: it does not touch what is due, the status, or whether the order may be confirmed, and the proved payment pays the order as ever. An unpaid order with such a note can be checked by hand (a buyer who paid by hand without the proof).
- Coins of one block were judged the larger first, by Number() of the amount: that compared amounts of different tokens and rounded long decimals. They are now judged by coin id within the block; nothing depends on the amounts' order (a remainder judged before its payment is gathered as dust and counted on the second look, as before).
- Kept: a coin with the reference and without a proof never pays an order with a secret; a copier's order is never paid by the real buyer's proved coin in any of S4's five variants.
- Tests (scripts/shop-test.cjs): S2a, S2b, S2c, S2d paid by the proved coin with the note kept; an unpaid order with a note is checked by hand; S4 (five variants, and two copiers); coins of one block judged by coin id; the copier and two-secrets tests now expect a note where they expected a problem (CHANGED on purpose) (fails on 0.18.304: S2a not paid).

## [0.18.304] — miniMall: a settled order stays settled; a confirmed order is never held

- 0.18.300 settled an order without a proof of its secret by the last pass's orders read alone, kept in memory and with nothing kept on the order, and the hold did not look at the order's status. So a paid, settled order went back to settling after one failed orders read (it could not be confirmed until the next good pass), a CONFIRMED order could not be shipped after a restart until the first good pass, and a catch-up whose orders read was cut put a settled order back to settling (review-desktop-r4 S1a, S1b, S1c, R4; released 0.18.286 confirmed and shipped them). Now the first pass with a good orders read that finds a paid order settled marks it settled on the order (`settled`, kept on disk), and no failed or cut read, and no restart, takes that away. An order CONFIRMED or later is never held. An order paid before this version (no `settled` on it) is settled, as released.
- Kept: a fresh order without a secret still settles until a good orders read is 3 blocks past its newest coin; a PAID order not moved on that meets a second buyer's order with its reference is still unpaid and held for a check by hand (0.18.289), and that takes its settled mark away with the payment.
- Tests (scripts/shop-test.cjs): S1a, S1b, S1c and R4 settled before the gap: confirmable, shippable and deliverable throughout; a CONFIRMED or SHIPPED order with the mark unset is not held; an order paid before this version is settled; a latched order met by a second buyer's order is unpaid and held (fails on 0.18.303: "S1a: not held again by a failed read").

## [0.18.303] — Vestr: main/vestr.js names the covenant's address whole

- Its header wrote the shared covenant's address shortened, which cannot be copied or looked up. It now reads 0x3C432D5099AB27EA901079EF54D9A97AB4DB3BD1CFFF670296C31B7C83C1C8BE, the file's own CONTRACT. A comment only: nothing Vestr does changes.
- Tests (scripts/inject-test.cjs): the header names CONTRACT whole and no hexadecimal id in the file is shortened (fails on 0.18.302).

## [0.18.302] — miniMall: a payment coin given up on is no longer said once its order is checked by hand

- A coin whose judging threw three times is left for a check by hand (0.18.295): a problem on its order and "Payment coin <id> could not be judged: check by hand." on the status line. The line stayed for the rest of the session even after the vendor checked that order by hand. The coin is now kept with the order it flagged, and checking that order by hand takes it off the line.
- Tests (scripts/shop-test.cjs): the "always throws" test checks the order by hand at the end: the line is empty (fails on 0.18.301).

## [0.18.301] — miniMall: a tip that comes while a pass is running gets its own pass

- The poll took a new tip as scanned before scanOnce, which returns at once while a pass is running (`scanning`): a tip that came during a long pass got no pass of its own, and its blocks waited for the next one. Now a poll during a pass leaves the tip for the next poll (`tip !== lastTip && !scanning`).
- Tests (scripts/shop-test.cjs): a poll at 1002 while the pass at 1001 is reading its orders, then the next poll scans 1002 (fails with the old condition).

## [0.18.300] — miniMall: a payment is counted the first time it is read again; an order without a secret settles before it can be confirmed

- 0.18.289 to 0.18.299 left a payment coin unjudged (not counted, not marked) until tip block + 3, and while its orders were not read. `coins` lists unspent coins only and the vendor's own wallet may spend a coin 3 blocks old, so a coin still waiting after tip block + 3 (no pass at exactly that tip, an orders read that failed, a gap above the coin, a reorganisation) could be spent before it was ever counted, and its order stayed unpaid with nothing said (review-desktop-r3 R1, R2, R2b, R4; released 0.18.286 paid them). Now, as released, every payments read counts what it lists at once, in every pass, whatever the orders read did. The wait, the "counted after block N" line, the skipping of the payments read after a failed orders read and its waiting rule are gone; so is 0.18.299's list of waiting coins, with nothing left waiting.
- What the wait guarded is now the verdict's: an order without a proof of its secret (no secret, or stored before 0.18.297) that is paid in full SETTLES. It cannot be confirmed (the screen and advanceStatus say "Paid. Held until block N in case another order with the same reference arrives." / "This order's payment is held until block N in case another order with the same reference arrives. Check it by hand to move it on now.") until a pass whose orders read succeeded has reached N = the newest counted coin's block + 3, with every order from that coin's block up known read (no unread gap covers it). A copier's order mined after the payment is paid at sight but settling; the real order mined up to 3 blocks after the payment meets it as a second buyer's, and the paid one is held again (0.18.289's rule). A settling order can be checked by hand. A coin of unknown block, and an order stored before this version, settle at once, as before.
- An order whose payment proves its secret (0.18.297) does not settle: it is paid and confirmable at sight. A coin with its reference and no or another proof is never counted for it, and is now noted at sight (it was noted after the wait).
- Kept: the per-coin catch and 3 strikes (0.18.295), the "older than the order" hold (0.18.285), the duplicate rule, and the PAID order held again by a second order with its reference (0.18.289).
- Tests (scripts/shop-test.cjs): R1, R2, R2b and R4 from the review, for an order without and with a secret: PAID and confirmable (fail on 0.18.299); the copier sequences rewritten on purpose (the copier's order paid but settling, refused by advanceStatus, then both held); one buyer's order confirmable at tip block + 3 and settling at + 2, after a restart too; a failed orders read settles nothing and a settling order can be checked by hand; a cut orders read whose gap covers the coin settles nothing; R3a with a secret (closed by 0.18.297; without one it is as released). The 0.18.299 tests are removed with what they tested; the source check of the scan calls and its comment (it said 0.18.293 for 0.18.294's change) corrected.

## [0.18.299] — miniMall: a waiting payment coin that is spent before it was counted is said on its order, which can then be checked by hand

- A payment coin waits, not judged, for 3 blocks (0.18.293) or until its orders are read (0.18.294); the wait was kept in memory only, and a coin spent in that time (the vendor's own wallet after a missed pass, or a reorganisation) was never counted and never said: its order just stayed unpaid with nothing to check by hand. Now each waiting coin is kept with the store (`payWait`: coin id whole, block, the order it would pay) until it is judged. A later pass at tip >= its block + 3 that read every payout address (none failed, none skipped as not valid) to a depth covering its block, and no longer lists it, puts one problem on that order: "payment coin <id> seen at block <N> is no longer listed (spent before it was counted): check by hand", once per order. The order is then Unchecked and can be checked by hand.
- The list is bounded: at most 256 entries; past that the oldest goes first with one problem on its order ("payment coin <id> seen at block <N> could not be kept until it was counted (too many payments waiting): check by hand"), never in silence. Entries leave when judged, when their order is paid, or when it is gone.
- Tests (scripts/shop-test.cjs): a waiting coin spent after a restart (with and without a proof): nothing said after a failed read, then one problem, the order hand-checkable, said once; a payout address skipped as not valid or a read too shallow for the coin's block says nothing; a coin still listed is paid and leaves the list; 300 waiting coins keep 256 and say one problem. Both fail on 0.18.298.

## [0.18.298] — miniMall: the desktop buyer's order carries a secret and every payment of it carries the secret's proof

- Orders placed here carried no secret and their payments only the reference (state port 1), so a desktop buyer had none of the protection 0.18.297 gives an order with a secret, at a phone vendor or at a desktop one. Now placeOrder makes the secret as the phone Shop's `MerchMessage.newNonce` does (32 random bytes from `crypto.randomBytes`, `0x` and capital hexadecimal digits), sends it inside the sealed order (`nonce`, ORDER only, as the phone's `toWire`), and the payment carries its proof in state port 2: `0x` + the SHA-256 of the 32 bytes in capital hexadecimal digits, exactly what the phone Inbox (`DeliveryRules.settle`, `MerchDb.recordPaymentIn`) and this vendor check.
- The buyer's order keeps only the proof (`commit`), so a Retry sends the same proof; the secret itself is kept nowhere (not in shop.json, not in a log, not in what the screen is given). An order placed before 0.18.298 keeps no proof and its Retry carries none, as its order carried no secret. A stored proof that is not `0x` and 64 capital hexadecimal digits is refused before anything is sent.
- Tests (scripts/shop-test.cjs): the sealed order opened with the vendor's key carries the secret; the payment and its Retry both carry `{"1": ref, "2": proof}`; the secret is not stored, logged or given to the screen; a second order has another secret; the same coins at a desktop vendor pay the order; an order without a proof retries without port 2, and a tampered proof sends nothing. Fails on 0.18.297.

## [0.18.297] — miniMall: a payment counts for an order with a secret only when it carries that order's proof

- The phone Shop puts a secret in the sealed order (`nonce`: 0x and 64 hexadecimal digits) and its proof on the payment coin, state port 2: `0x` + the SHA-256 of the secret's 32 bytes in capital hexadecimal digits (base-vestr-2.2.76 `comms/MerchMessage.java` validNonce / commitment, `merchshop/PaymentFlow.java` stamp). This vendor ignored both and matched payments by the plain-text reference alone. Now an incoming order keeps the proof of its secret (`commit`; the secret itself is never stored or logged), and a payment coin pays only the order whose secret it proves: the one kept under the reference or another buyer's copy (`ref~buyer`). A copier who puts a payment's reference in an order of their own can never make that payment theirs, whatever order the coins and orders arrive in.
- An order with a secret is no longer held, nor unpaid, by another buyer's order with its reference (each is paid only by coins proving it), unless that order came with the very same proof; a payment proving the order's secret is not held as "older than the order". The 3-block wait and the orders-read rule are kept for every coin.
- A coin with the reference that pays no order (a different proof, or none, while no order without a secret is there to take it) is one check-by-hand problem on each unpaid order with a secret and that reference: "a payment with this order's reference does not carry this order's proof (payment coin <id>): check by hand", once per order; never on an order already paid by its proof.
- An order with no secret (an older Shop or this desktop before 0.18.298) keeps every rule of before, with the phone's one addition: a coin that carries anything in port 2 never pays it. An order stored before 0.18.297 (its secret, if any, was not read) is paid as before. A secret that is present and not 0x and 64 hexadecimal digits holds the order for a check by hand ("this order's secret cannot be read, so no payment can be proved to be its buyer's: check by hand"), never taken as an older Shop's.
- Tests (scripts/shop-test.cjs): the phone's own vectors (its Java run as it is); the copier sequence in every arrival order (copier first, real first, already paid, same block, real order's read failed, real order past the tree), with the copier with and without a secret; a copier copying both the reference and the proof; no-secret orders and orders stored before this version; nine malformed secrets; the secret in no file, log or screen reply; two orders with different secrets, the same secret re-sent, the same proof from another buyer, one without a secret. All seven fail on 0.18.296.

## [0.18.296] — Vestr: the node's mempool answer decides a second collect (the session list is gone)

- 0.18.291 kept the coins collected in this session and refused them again while the node still listed them. `checkmempool:true` already leaves out a coin that a collect is really spending, so the list refused exactly the collects that had NOT gone through (an unanswered post whose coin is still listed and not in the mempool), for the rest of the session. It is removed; both coin reads keep `checkmempool:true`.
- The phone's rule (base-vestr-2.2.76 `Contract.alreadySpending`): a clean, successful, empty answer to `coins coinid:<id> checkmempool:true` refuses with the phone's sentence, "A collect of this coin is already waiting for the chain, or the coin is already spent. Nothing was sent." — but not while the node has no tip (it then lists nothing): the tip refusal comes first. A failed or malformed answer does not block: the coin is read without the flag, and `txninput` and `txncheck` judge the collect; "Contract coin not found (already collected?)" only when neither read finds it.
- A comment still said the grace age is counted at the next block; it is counted at the tip (0.18.292).
- Tests (scripts/inject-test.cjs): the session-list tests replaced on purpose (V1: the clean empty answer, the tip first, five failed or malformed answers that do not block; the first Vestr test: a coin the node hides is refused, a post that did not take is collected again); V4, the review's scenario: an unanswered post, the coin still listed and not in the mempool, three list refreshes, collected again (refused on 0.18.295).

## [0.18.295] — miniMall: one payment coin whose judging throws no longer stops every newer one

- Since 0.18.289 a coin whose judging threw aborted the whole payments loop: every newer coin was left unjudged on every pass, the cursor never moved, and the status line said the node did not answer (it had). Now every coin is judged; a coin that threw is not marked seen, and the pass is a failed one for that coin (nothing advances, the same blocks are read again) with the line "Payment coin <id> could not be judged. It is judged again on the next block." (the id whole), never as the node not answering.
- After 3 passes that threw, the coin is marked seen, logged with its id whole and the error, and left for a check by hand: the problem "payment coin <id> could not be judged: check by hand" on its order (so it cannot advance automatically) and "Payment coin <id> could not be judged: check by hand." on the status line; the cursor then moves. The count is kept in memory for this session (after a restart a coin gets 3 passes again); one try per pass, since a pass with such a coin reads no backfill.
- Tests (scripts/shop-test.cjs): ORD-P1's coin always throws, the unrelated ORD-P2 is paid in the same pass, the cursor stays for two passes and moves on the third with the problem and the log line (on 0.18.294 ORD-P2 is never paid); the single-throw test changed on purpose (its sentence, the cursor).
- Comments of 0.18.294's changes named 0.18.293; corrected.

## [0.18.294] — miniMall: no payment is judged before the orders that may go with it are read

- When a pass's orders read failed, its payments were still judged, so "orders are read before payments" broke: payment 1010, a copier's order 1011, the real order 1013 and a channel read that failed at the judging tip paid the copier's order (PAID, may advance) until the next good pass. Now a pass, a backfill step or the read past the tree whose orders read failed judges no payment; the coins wait, unseen, for the next pass.
- Complete enough: a payment coin from block pb is judged only when every order from pb up to the tip is known read (the orders that may go with it are mined up to pb + 3). For the recent window that is from what this pass's orders read reached when it reached the last pass's tip (and then, with a backfill pending, from its floor), otherwise only what it reached; for a backfill step, from what its orders read reached (with what was read above the floor), and everything once it reaches the gap's target; past the tree, the root read judges what it lists (those orders are past what the node keeps), except that while a cut orders read is still tried again the coins below what it reached wait, and the try that ends the backfill judges them. A coin below that line waits, not judged and not marked seen; a later read of that range judges it.
- Tests (scripts/shop-test.cjs): the failed orders read at the judging tip (recent window and past the tree); a cut window, a cut step and a cut read past the tree each holding back the payment below what they reached until its real order is read (on 0.18.293 the copier's order is PAID after the first pass); a step that reaches its target judges what it lists below it. The source pin of the payments calls changed on purpose (`scanPayments(deep, tip, payFrom)`, still no floor).

## [0.18.293] — miniMall: a payment is judged at tip block + 3, before the wallet can spend it

- 0.18.289 judged a payment coin created at block pb only from tip pb + 4. The node's `send` may spend a coin from tip pb + 3 (coin age `MINIMA_CONFIRM_DEPTH` = 3), and `coins` lists unspent coins only, so any send of the vendor's own wallet (a miniMall reply, chat, Web Wallet, a Vestr lock, an AtomiX publish) could spend the fresh payment in block pb + 4 before it was ever counted: the honest order stayed unpaid, with no problem recorded and nothing to check by hand, and the "a payment has arrived" line vanished. A payment now waits only while the tip is below pb + 3 and is judged by the pass at tip pb + 3. Orders are still read first in every pass, so a real order mined up to block pb + 3 is held by then; a spend posted at tip pb + 3 is mined in block pb + 4 at the earliest. The waiting line says "It is counted after block pb + 2" (the same sentence, the figure one lower).
- The waiting line is cleared only by a payments read that read every payout address; a read that failed cleared it one pass early.
- Tests (scripts/shop-test.cjs): the two boundary tests changed on purpose (tip pb + 2 waits, pb + 3 judged); new: order 1009, payment 1010, the wallet's send at tip 1013 mined in 1014 — counted by the pass at 1013 (on 0.18.292 the order is never paid); the waiting line kept when the payout read fails at the judging tip. Both copier tests pass unchanged apart from the waiting figure.

## [0.18.292] — Vestr: the grace wait counted at the tip; a collect is posted only when txncheck's validtransaction is true

- 0.18.291 counted a coin's age at the next block (tip + 1 − created) and accepted `scripts:false` from `txncheck` for a collect valid only from the next block. Read in minima-core: the node's own relay check runs a txpow it just mined through the same handler as a peer's (`Main` MAIN_TXPOWMINED → `NIOMessage` MSG_TXPOW) and judges its scripts with `@BLOCK` = the tip; a non-monotonic transaction that fails there is kept but never forwarded, and nothing re-broadcasts the mempool. Such a collect never left the node. Now the age is taken at the tip (refused while tip < final block and tip − created < the grace blocks), as `txncheck`, the node and the phone's Vestr (`Contract.inGrace`) do, and a collect is posted only when `txncheck` answers status true with `response.validtransaction` the boolean true (as the phone's `Contract.txnCheckValid`). The list's Collect button reads the same figure (at coin age 0 with a grace of 1 block it now waits).

## [0.18.291] — Vestr: no second collect of a coin being collected; the node judges every collect before it is posted

- Both reads of contract coins (the list's `coins address:… relevant:true` and the collect's `coins coinid:`) send `checkmempool:true`: the node then leaves out a coin it is mining a transaction for or that a transaction in its mempool spends (`coins` → `TxPoWMiner.checkForMiningCoin` and `TxPoWDB.checkMempoolCoins`, one look through the mempool's inputs per coin listed). A second Collect before the first was mined was built, posted and reported as collected again. The app also keeps the ids of the coins it collected in this session and refuses a second collect of one while the node still lists it: "This contract coin was collected a moment ago and the node still lists it. Wait until it is gone from the list before you collect again. Nothing was sent."
- `txncheck` runs after the transaction is built and before `txnpost`: it goes on only when the node says the amounts, the basic checks and the MMR proofs are valid and `validtransaction` is true; otherwise the transaction is deleted and "The node checked this collect and judged it invalid, so it was not sent. Nothing was collected." (Corrected in 0.18.292: `scripts:false` is no longer accepted for a collect valid only from the next block.)
- Refusals come in this order: the coin's shape, then the tip (a tip that could not be read is refused: "The node's block height could not be read, so nothing was built. Nothing was sent."), then "Nothing available to collect yet", then the grace wait. The grace wait counted the coin's age at the next block (tip + 1 − created; corrected to the tip in 0.18.292). The list's Collect button reads the same figure, so at coin age 0 (where the contract maths' own mustwait is FALSE) it no longer offers a collect that the app then refuses.
- A pending reply to a collect step is no longer taken as success.

## [0.18.290] — miniMall: one "older than the order" problem per order; a re-sent order keeps its oldest block

- Each old payment coin carrying an order's reference added its own "a payment with this order's reference is older than the order" problem (the coin id made each text new) and a synchronous rewrite of `shop.json`: 2000 coins gave 2001 problems, 3001 rewrites and 1.35 s of blocked main thread. Now an order gets that problem once, naming the first coin whole, and a coin that adds nothing writes nothing.
- The same buyer's order sent again (a second coin, the same sealed sender): the order's block is now its oldest coin's. The node lists newest first, so the later copy set the block and a real payment mined between the two copies was held as "older than the order" (it failed safe: a check by hand). The sender is the sealed box's signer, so another buyer's coin with the same reference is a second buyer's order and never moves this one's block.

## [0.18.289] — miniMall: a copier's order is never paid by another buyer's coin

- A payment coin created at block N is judged only once the chain is past block N + 3 (`PAY_BEFORE_ORDER`); until then it is not judged and not marked seen, and a later pass reads it again (the payments read never skips what an earlier pass read, every window reaches at least 64 blocks below the tip, and the cursor is on disk, so a restart reads it too). Orders are read before payments in every pass, so the real order, mined within the 3-block allowance, is held by then: a copier who put the payment's plain-text reference into an order of their own mined the block after the payment had that order marked PAID before the real order arrived, and the vendor could ship to the copier. Now both orders meet as two buyers' orders with one reference, and neither moves on until the vendor checks it by hand.
- An order marked PAID (not confirmed or moved on, not checked by hand) that meets a second buyer's order with its reference is held again: unpaid, UNCHECKED, the duplicate problem first, what was received still counted. A confirmed, shipped or delivered order, or one checked by hand, is left as it is. Nothing was ever sent to the buyer for PAID.
- While a payment waits, the vendor's order says so: "A payment with this order's reference has arrived (payment coin <whole id> at block N). It is counted after block N+3, so that another order with the same reference is seen first."
- A payment coin whose judging threw is no longer kept as seen: the pass fails, as before, and the coin is judged again on the next pass.
- `main/rpc.js`'s header no longer says the node binds 0.0.0.0: since minima 1.1.2.3-euro8 its RPC binds 127.0.0.1 unless `-rpcbind` says otherwise (this app never passes it).

## [0.18.288] — Vestr: a collect at or just after the end block is no longer dropped by the chain

- The node's contract maths (`runscript` on CHECK_MATHS) works out its `change` before an expired contract's `cancollect` is raised to the whole coin, so at and just after the final block it reported a full payout AND a change (a sample contract coin, coin `0x23456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF01`, 100 MINIMA, final block 1000004: collect 100, change 1). The collect paid out 100 and returned 1 from a 100 coin: `txnpost` took it, the chain dropped it, and the app said it was collected. The change is now the coin less the payout in exact decimals, never the script's `change`: an expired contract collects the whole coin with no change output, a partly vested one returns the exact rest to the contract with its state as before. Nothing is built while the grace wait is in force (the node's `mustwait`, or the coin younger than the contract's minimum wait) or when the node's figure is more than the coin holds. Test: `scripts/inject-test.cjs`.

## [0.18.287] — The node jars with the command-injection fix and the RPC hardening

- `resources/minima.jar` is minima-core 1.1.2.3-euro8 (sha256 `fc63eb672374e7ceb7cfba17d0e098e3c2991c9a0ef124b0a14fae111c088ef9`) and the Parlons node pin moves to 0.2.162 (`parlonsNodeSha256` `65ee56a6ffb302ea0ffcb0d81c1af6ce3f64f0abd662f7885346863d80eb34c1`, maxima release `node-v0.2.162`). Built sub-commands are never re-parsed from text (no `;` / quote injection); the RPC binds 127.0.0.1 unless `-rpcbind`, checks Host and browser Origin and reads its body by bytes with a cap; a read-mode RPC user runs as non-admin; non-admin callers only create plain `.txn` files in the base folder. The app already uses its node on 127.0.0.1 and passes no flag the jars refuse.
- Not in these jars (owner, 21 Nov 2026): the wallet-key capacity guard; the node wallet's own keys still restart at leaf 0 past 262144 uses, as upstream.

## [0.18.286] — miniMall: the payments' own cause

- When the orders read past the node's tree was whole but the payments read was cut by the reply cap, the notice names the reply cap for the payments. Test: `scripts/shop-test.cjs`.

## [0.18.285] — miniMall: a payment older than its order is checked by hand

- A payment's reference is plain text on the chain. Someone could copy it into an order of their own while the real order was not known to the app (older than the node's recent blocks, or not read yet), and their order was marked paid by another buyer's coin. The app now keeps the block each order reached the chain at. A payment more than 3 blocks older than its order holds the order for a check by hand, naming the payment coin. A real buyer's app always sends the order before the payment, so real orders are not affected. Orders stored before this version have no block and are judged as before. Test: `scripts/shop-test.cjs`.

## [0.18.284] — key uses: a loose reading never raises the bound

- The single-signature bound (262143) applies only when every reading of the command's verb is one of the five single-signature verbs; a loosely quoted command is held to 250000. Test: `scripts/cmdgate-test.cjs`.

## [0.18.283] — miniMall: each read past the tree judged on its own

- Past the node's tree, an orders read cut by the reply cap is tried twice more and then said with that cause; it ended at once with the wrong cause. The retry count starts again for each gap. The notice says older orders "may not have been read", because a tree longer than 1024 blocks reads some of them. Test: `scripts/shop-test.cjs`.

## [0.18.282] — miniMall: a payment read before its order is counted

- Backfill and tree reads no longer skip payments above the point already read, so a payment seen while its order was still unknown is counted once the order is read. Counting is idempotent: a coin is counted once, dust totals once, and two buyers' orders with one reference stay unpaid. With this, an unspent payment of any age pays its order once the order is read, when the app was closed longer than the node's recent blocks. Known limit: with the app open and no backfill, a payment made more than 64 blocks before its order arrives is not read; under 0.18.285 such a payment could not pay the order automatically anyway, so it is left. Test: `scripts/shop-test.cjs`.

## [0.18.281] — miniMall: the scan follows the chain down

- While the chain is below what was read (a resync, or a reorganisation onto a lower branch), the scan position follows it down, so a fast catch-up no longer skips the new branch's orders and payments (a regression of 0.18.276). After a resync from scratch the notice may name blocks the node no longer holds. Test: `scripts/shop-test.cjs`.

## [0.18.280] — two money-safety tests restored

- "Two buyers' orders with the same reference are both kept and neither is paid automatically" and "a retry pays only after a refused payment" were deleted by mistake in 0.18.277 and are restored word for word. Test: `scripts/shop-test.cjs`.

## [0.18.279] — Web Wallet: the ceiling message first

- Confirming a key-use figure above 262143 is refused with the ceiling message even while the key-use service cannot be read; it said the chain's figure could not be read. Test: `scripts/inject-test.cjs`.

## [0.18.278] — key uses: "at least", and the single-signature verbs named

- The five single-signature commands (txnsign, sendfrom, signfrom, consolidatefrom, createtokenfrom) may name 262143; every other command that names keyuses: is held to 250000, so an unknown verb no longer gets the higher bound. The figure is "at least" the signatures already made, not "above" it, and the node's defaults are said as 100 to 1000. Known limit: restoresync's keyuses: is added to each key's uses in the backup, which the app cannot see, so 10000 bounds only the figure typed, not the result. Test: `scripts/cmdgate-test.cjs`.

## [0.18.277] — miniMall: payments made while closed are read again

- The node's in-memory tree holds 1024 to 1123 blocks, and its root keeps every unspent coin of this wallet from older history. When the app was closed longer than the tree, the scan now reads orders as far back as the tree holds and makes one payments read that reaches the root, so an unspent payment older than the tree pays its order when the order was read before (a payment read before its order was still skipped until 0.18.282). A backfill step reads at most 1024 blocks, so an order still inside the tree is read. A step the node's reply cap cuts short is tried twice more before the scan stops and says so. The notice shows only when a shop exists and can be dismissed; the log keeps it. Test: `scripts/shop-test.cjs`.

## [0.18.276] — miniMall: never claims older orders were read

- A resync that puts the chain below what was read before moves nothing and is not called a failure. A failed read is described as recent orders not being read. Corrected by 0.18.277: this version also took the node's in-memory tree as a fixed 1024 blocks and gave up on any gap that reached past it, so a payment made while the app was closed and older than the tree no longer paid its order (0.18.272 read it), and an order still inside the tree after a cut first window could be dropped. Test: `scripts/shop-test.cjs`.

## [0.18.275] — Web Wallet: "Nothing was saved" on a refused confirmation

- A refused confirmation now ends "Nothing was saved". A damaged count stored as 1e400 (Infinity) is read as too high, not as 0. Test: `scripts/inject-test.cjs`.

## [0.18.274] — Web Wallet: a chain figure at the limit is explained

- For a first confirmation the chain is read before the 262143 ceiling is checked, so a chain figure at the limit is explained instead of only "can be at most 262143". Test: `scripts/inject-test.cjs`.

## [0.18.273] — restore key uses: at most 250000

- A figure that sets every key's uses (megammrsync / archive / mysql resync and import, reset, vault resetkeys, keys createallkeys) is now at most 250000, and restoresync's figure, which adds to the backup's uses, at most 10000. A single signature (sendfrom and the other builders) may still name the last leaf, 262143. A restore at 262143 let every key sign once and then start again at leaf 0, because the node checks no capacity. The screens explain what the figure is for, give the usual small figure, and no longer advise setting it higher when unsure. Test: `scripts/cmdgate-test.cjs`.

## [0.18.272] — Web Wallet confirm: whole numbers, and the figure kept

- A typed key-use count that is not plain digits is refused instead of rounded down, and the confirmation says the figure main kept. Test: `scripts/webwallet-ui-test.cjs`.

## [0.18.271] — Web Wallet: limit messages that are true

- A chain figure at the limit is said as being at the limit, because it can count more uses than the key signed. The messages no longer name a wallet to move the funds with, since any wallet would sign with this same key. This app simply will not sign from that address, and says why. Test: `scripts/inject-test.cjs`.

## [0.18.270] — Web Wallet: a damaged old value read as a number

- A damaged entry's old value written as a decimal string is read as the number (rounded up, a floor); one above the limit gets the over-count explanation. Test: `scripts/inject-test.cjs`.

## [0.18.269] — key uses at most 262143 when restoring or resyncing

- The restore and resync key-uses fields, and any command that names keyuses: (it sets every key's uses on a restore or resync, is added to them by restoresync, or is the leaf a builder signs at), take a whole number from 0 to 262143. A higher figure, or 4294967296, which the node reads as 0, made every key sign at leaf 0 again. "262144abc" is no longer read as 262144. Superseded for restores by 0.18.273: 262143 was still unsafe for a figure that sets the wallet's key uses. Test: `scripts/cmdgate-test.cjs`.

## [0.18.268] — "PandaPools could not be asked"

- The stop question says PandaPools could not be asked when its read failed or was late; it said the engine had not started. Test: `scripts/stopguard-test.cjs`.

## [0.18.267] — Web Wallet: a damaged count's old figure is a floor

- A damaged key-use entry whose old value still reads as a whole number is confirmed again only at or above it, as well as at or above the chain's figure. Test: `scripts/inject-test.cjs`.

## [0.18.266] — the stop guard's hold is released only by the stop that took it

- pass() gives a stamp and only that stamp releases the hold; a Terminal quit keeps the hold when the node cuts its connection. Test: `scripts/stopguard-test.cjs`.

## [0.18.265] — Web Wallet key uses have a ceiling (262143)

- The node signs a Web Wallet send with a key of 262144 one-time leaves, numbered 0 to 262143, and at a leaf past the last it signs at leaf 0 again. A count above 262143 is refused, a chain figure past it is never adopted, and a send whose key has no leaf left is refused. That includes a count confirmed too high by an older version, which said over-estimating was safe: it is explained, never lowered. The screen's wording and the input's maximum match. This hole is also in the live 0.18.193. Test: `scripts/inject-test.cjs`.

## [0.18.264] — a refused stop releases the hold too

- When a stop the user agreed to is refused by the node (status:false, for example a restore with a wrong password) and the node keeps running, the next try is asked again; 0.18.257 did this only when the operation threw. Test: `scripts/stopguard-test.cjs`.

## [0.18.263] — Web Wallet: the chain's floor for every first confirmation

- A key-use count that is not yet confirmed (a first confirmation, or one after the counter file went missing) is accepted only at or above the chain's figure, checked in the main process, and refused while that figure cannot be read. Counts already confirmed are unchanged and need no new confirmation. Test: `scripts/inject-test.cjs`.

## [0.18.262] — Web Wallet: the chain's key-use figure is read in the main process

- The figure is read in the main process, for the key it derived itself, with the same pinned and bounded request as the window's check. A damaged counter is confirmed again only at or above that figure. Until now the floor was applied in the window only, so a faulty window could store a count below the chain's, and the next send would reuse a one-time signature key. Test: `scripts/inject-test.cjs`.

## [0.18.261] — sha3.js says "the same code"

- main/sha3.js's header now says it is the same code as Pandamonium Desktop's, its comment apart. Test: `scripts/shop-test.cjs`.

## [0.18.260] — multisig file with C:/

- A multisig file written with a drive letter and a forward slash (C:/dir/x.txn) runs, as one with a backslash does. Test: `scripts/cmdgate-test.cjs`.

## [0.18.259] — the stop question reads everything side by side

- AtomiX, PandaPools and P2P Chance are read in parallel, each with its own time limit, so a slow read no longer loses the others' answers. Test: `scripts/stopguard-test.cjs`.

## [0.18.258] — setup screen: the truth after a failed restart

- When a restart fails after it began, the screen reads the saved settings again and no longer says the changes are still on screen when the form is gone. Test: `scripts/stopguard-test.cjs`.

## [0.18.257] — a failed stop does not block a retry

- When what a stop was for fails without stopping the node (a wrong password, an import that fails at once), the next try is asked again instead of refused for 30 seconds (a refusal answered with status:false too, from 0.18.264). Test: `scripts/stopguard-test.cjs`.

## [0.18.256] — Terminal: Windows \\??\\UNC paths

- A file parameter written as \\??\\UNC\\host\\share or /??/UNC/host/share is refused as a file on another computer. Test: `scripts/cmdgate-test.cjs`.

## [0.18.255] — Terminal: decryptbackup output on another computer

- decryptbackup writes the decrypted backup, the wallet in plain text, to output:; an output on another computer is now refused. Test: `scripts/cmdgate-test.cjs`.

## [0.18.254] — AtomiX: a failing owed move is retried with a pause

- An owed move of the old wallet's swap database that keeps failing is tried again with a growing pause (12 seconds up to 10 minutes) instead of every 12 seconds, is said in the log once per reason, and config.json is rewritten only when the debt changes. Test: `scripts/atomix-unit.js`.

## [0.18.253] — one question, one stop

- Two stop or restart requests at once showed two questions and gave two stops. A request while the question is open, or after a yes before the node has stopped, is now refused with a plain reason. Test: `scripts/stopguard-test.cjs`.

## [0.18.252] — PandaPools: the opening price is in MxUSD

- Creating a pool shows its opening price as MxUSD/MINIMA, in the form and the confirmation. The MEXC market line keeps USDT/MINIMA, the market's own unit. Test: `scripts/panels-test.cjs`.

## [0.18.251] — an old invalid rescue node no longer breaks saving

- A -rescuenode saved by an older version that is not host:port is dropped when the settings are read, said once in the log and never passed to the node. Kept, it made Contribute, the setup screen and Enable MegaMMR fail to save. Test: `scripts/config-keys-test.cjs`.

## [0.18.250] — a refused restart keeps the setup screen's edits

- Apply & restart keeps the form on screen until the node really stops; if the restart is refused, the changes are still there and the screen says so. Test: `scripts/stopguard-test.cjs`.

## [0.18.249] — P2P Chance bets are counted before a stop

- The stop question counts this wallet's open P2P Chance offers and bets and asks only when one is open; it says "could not be checked" only when that read fails, instead of on every stop. Test: `scripts/stopguard-test.cjs`.

## [0.18.248] — Turkish dotted İ

- The node's JVM runs with an English locale on both node kinds, and the app folds İ to i, so a command written with İ (multİsig, sİgnfrom, archİve) is checked exactly like the plain command. Test: `scripts/cmdgate-test.cjs`.

## [0.18.247] — SHA-3 that works in the packaged app

- Electron's crypto has no SHA-3, so the miniMall payout-address checksum (0.18.227) never ran in the packaged app. A small built-in SHA3-256 now serves it. No other desktop code took SHA-3 from Node's crypto. Test: `scripts/shop-test.cjs`.

## [0.18.246] — Terminal: several hidden words as a count everywhere

- A command the node itself would refuse is masked with the word count too, so no echo, confirmation or reply shows one ••• per word. Test: `scripts/cmdgate-test.cjs`.

## [0.18.245] — Terminal: builder checks follow what is really pasted

- A rawfrom input's script and a multisig id run again (they are not pasted); a multisig file is checked, a drive letter allowed. Test: `scripts/cmdgate-test.cjs`.

## [0.18.244] — Terminal: no file on another computer, for every command

- Any file, folder or …file parameter that starts with two slashes of either kind is refused for every command, not a list (decryptbackup's output: from 0.18.255, Windows \\??\\UNC paths from 0.18.256). Test: `scripts/cmdgate-test.cjs`.

## [0.18.243] — Terminal: no array or object in a builder's state

- A state value that is an array or object is refused for the commands that paste it into a txnstate of their own; every builder is a sensitive verb. Test: `scripts/cmdgate-test.cjs`.

## [0.18.242] — Terminal: signfrom / postfrom transaction ids

- signfrom and postfrom take only 0x hex data whose transaction id is plain letters, digits, dots, dashes or underscores: the node pastes that id into commands it runs itself, and an id holding ";send …" ran a send with full rights. The app's own commands are held to the same checks. Test: `scripts/cmdgate-test.cjs`.

## [0.18.241] — PandaPools names the Minima dollar token MxUSD

- The activity labels and a swap's record name the Minima dollar token MxUSD by its id; they said USDT or the name its creator wrote on the chain. Test: `scripts/pandapools-queue.test.cjs`.

## [0.18.240] — a long command with non-ASCII text reaches any node whole

- A POST body is sent only when the command is plain ASCII, where bytes and characters agree. A command with any other character goes on the command line, percent-encoded; one too long for it (over 65,536 encoded characters) is refused before anything is sent. Test: `scripts/rpc-test.cjs`.

## [0.18.239] — superseded by 0.18.240

- Counted a long POST's Content-Length in characters, as the shipped node reads it. That would cut a non-ASCII command short on a node that reads bytes; 0.18.240 replaces it. Test: `scripts/rpc-test.cjs`.

## [0.18.238] — Web Wallet: "could not be read", not "cannot be reached"

- When the key-use service's figure cannot be used, Confirm and Check on-chain now say it could not be read from the key-use service (eurobuddha.com). "Cannot be reached" was not true when the service answered with an error, another key's row or a count that is not a whole number. Test: `scripts/webwallet-ui-test.cjs`.

## [0.18.237] — Terminal: no file on another computer

- A file parameter (file:, archivefile:, folder:) of the backup, restore, archive, reset, mysql and MegaMMR commands that names a file on another computer (a path starting with \\ or //) is refused: a Windows node would connect to that share. Local and drive-letter paths still run. Test: `scripts/cmdgate-test.cjs`.

## [0.18.236] — AtomiX: the old wallet's swap records are never opened by the new wallet

- If the old wallet's swap database cannot be moved aside after a wallet replacement, AtomiX does not start until it can be (it went on and opened the old records under the new wallet). The debt is written to config.json before the move, names the file it is for, survives a quit or a crash, and is cleared after the move; the new wallet's own database is never moved by mistake. Test: `scripts/atomix-unit.js`.

## [0.18.235] — the node log hides a private key in either form

- A privatekey: written in its Mx form, spaced, quoted or in another letter case is hidden in the node log as well as the plain 0x form. Test: `scripts/cmdgate-test.cjs`.

## [0.18.234] — ETH Wallet: a refused saved endpoint is said once

- A saved Ethereum endpoint that is refused (a name or password in its URL) is said in the log once, not again on every balance refresh; the URL is never logged. Test: `scripts/atomix-unit.js`.

## [0.18.233] — an empty database file is said and kept

- A 0-byte AtomiX, PandaPools or history database found on disk is said in the log with its path whole and kept under a dated name before a new database starts in its place; it opened as fresh with no word, so an emptied store went unnoticed. Test: `scripts/atomix-unit.js`.

## [0.18.232] — saved settings: no MDS, a rescue node is host:port

- An MDS parameter is never passed to the node, and -rescuenode takes host:port only, because the node pastes it into a command it runs; an unsafe value is refused when saved and never passed, and -rescuenode in the extra arguments is refused. Test: `scripts/config-keys-test.cjs`.

## [0.18.231] — Terminal: only a real escape is refused

- An escaped backslash followed by plain text (\\u003b) is ordinary text to the node and is no longer refused; a real \u escape of a semicolon or a control character still is. Test: `scripts/cmdgate-test.cjs`.

## [0.18.230] — Terminal: no value can rewrite the commands a builder makes

- The commands that build further commands from their values (sendfrom, rawfrom, rawtxnfrom, createtokenfrom, consolidatefrom, constructfrom, createfrom, signfrom, postfrom, multisig, multisigread, txnauto, sphincs) refuse a value with white space, a colon, a quote or a backslash escape where it would become part of those commands. multisig create takes only public keys of 0x and 64 hexadecimal digits (a crafted key made a multisig coin anyone could spend; a password with a space could add a hidden burn). A secret of several words is shown with its word count (also in a command the node would refuse from 0.18.246). Some of these checks refused too much: a rawfrom input's script and a multisig id run again from 0.18.245; state arrays and objects are refused from 0.18.243. Test: `scripts/cmdgate-test.cjs`.

## [0.18.229] — PandaPools: a stuck action no longer blocks every later one

- An error inside the engine's later answer (a key check, a post's answer) left the action's place in the queue taken, so every later add, withdraw and migrate waited for good. Such an error now ends that action with "it may have been posted: check Activity and your balance", and the next one runs. A new pool's and a migration's amounts must be plain numbers above zero. Test: `scripts/pandapools-queue.test.cjs`.

## [0.18.228] — Terminal: the node is never opened to someone else

- rpc with any parameter but the gated action:listusers (it could turn RPC authentication off, replace the app's password or add a login), slavenode enable:, webhooks action:add and mds actions other than list are refused. Test: `scripts/cmdgate-test.cjs`.

## [0.18.227] — miniMall: an invalid payout address no longer stalls the order scan

- A payout address with a wrong checksum is skipped for five minutes, logged and shown on the orders screen with the address whole; it held the scan for good before. miniMall Studio refuses to save such an address. In the packaged app the checksum check only works from 0.18.247: until then it used Node's SHA-3, which Electron does not have, and every address read as valid. Test: `scripts/shop-test.cjs`.

## [0.18.226] — miniMall: gathered dust is bounded and still pays

- At most 256 dust coins per order are gathered, with a running exact sum; a flood no longer costs a second per block, and gathered dust that covers what is due is counted (1000 coins never fit beside the order's other coins). Test: `scripts/shop-test.cjs`.

## [0.18.225] — a miniMall payment in progress is part of the stop question

- Stopping or restarting the node while a miniMall payment is at the node now asks first, and says to wait for its answer. Test: `scripts/stopguard-test.cjs`.

## [0.18.224] — miniMall: no second payment while the first is at the node

- "I checked my History: it was not sent" and Retry are refused while the order's payment is still being sent, and once the vendor has marked the order paid or later; the screens say the payment is being sent. A payment that went clears the unpaid mark. Test: `scripts/shop-test.cjs`.

## [0.18.223] — every node stop or restart asks first when work is in flight

- The tray's Restart node, the Node tab's Restart and Reclaim, the node kind switch, the setup screen's restart, Contribute, the Web Wallet's MegaMMR switch, a chat backup restore and Terminal commands that stop the node (quit, resyncs, imports, restores) now ask "Stop the node anyway / Keep it running" when AtomiX swaps, a market, OTC, recent pool transactions or P2P Chance could be interrupted or could not be checked. Settings are saved only when the restart goes ahead. Test: `scripts/stopguard-test.cjs`.

## [0.18.222] — Terminal: no secret is shown

- privatekey: is hidden like phrase, password, confirm and seed; the Terminal echoes commands with secret values hidden and keeps them out of the history; the node's reply never shows a secret of the typed command. rpc action:listusers, mds and sphincs action:generate need SHOW KEY. A gated command with an empty secret is refused. Test: `scripts/cmdgate-test.cjs`.

## [0.18.221] — Terminal: no second command through an escape code

- A \u escape that decodes to a semicolon or a control character is refused for every command; multisig spends and mds action:accept are not run from the Terminal; -mds… extra node arguments are refused. Test: `scripts/cmdgate-test.cjs`.

## [0.18.220] — Terminal: values the node pastes into its own commands

- reset, archive import, mysql reset / setlogin and txpow refuse a value with white space, a colon, a quote or a semicolon, which the node would turn into more parameters (a seed phrase among them) of a command it runs itself. Windows paths still run. Test: `scripts/cmdgate-test.cjs`.

## [0.18.219] — Terminal: commands are read exactly as the node reads them

- Every check now reads a command with a port of the node's own reader; a command that moves funds or keys and that the node would read differently from how it looks is refused. Test: `scripts/cmdgate-test.cjs`, `scripts/fixtures/node-command-reading.json`.

## [0.18.218] — small fixes from the review

- A second buyer's copy of a reference says which order shows the payments with that reference and how much has come in. An order whose older verdict was kept but that is not paid (for example confirmed or shipped by an older version without a payment this version sees) can be checked by hand; it could never move on. The amount a swap needs is cut exactly for an exponent form too (toFixed rounded it). Tests: `scripts/shop-test.cjs`, `scripts/shop-migrate-test.cjs`, `scripts/rpc-test.cjs`.

## [0.18.217] — miniMall buyer: an uncertain payment is shown, and can be marked not sent

- A payment still marked in flight (the app closed while it was being sent) blocked Retry but was not explained on the screen. Both an in-flight and a timed-out payment are now shown as "may already have gone through", with an explicit action, "I checked my History: it was not sent". Its confirmation shows the amount, the token id and the vendor's payment address whole, and only then are the marks cleared and Retry offered. Test: `scripts/shop-test.cjs`.

## [0.18.216] — ETH endpoint with a name or password: refused with a reason

- Since 0.18.210 the AtomiX network list refuses a url carrying a name or password, but the custom Ethereum endpoint setting still accepted one, so it was saved and then silently never used. It is now refused when set, with the reason, and a saved endpoint that is no longer allowed is dropped at load with a line in the log (the built-in endpoints are used). Test: `scripts/atomix-unit.js`.

## [0.18.215] — Web Wallet: a readable key list decides; one damaged counter is that address's problem

- Since 0.18.204 a locked vault refused every Web Wallet send even when the node's key list was readable and did not hold the derived key, which already shows the seed is foreign; now only an unreadable key list refuses. Since 0.18.203 one damaged entry in the key-use counters refused every address; now only that address is refused, its counter is unknown, and it must be confirmed again (the screen asks for a whole number at least as high as the chain shows); the other addresses are untouched. Test: `scripts/inject-test.cjs`.

## [0.18.214] — Terminal confirmation: what is glued after a secret is shown

- The confirmation hid an unquoted secret value up to the next space, so `vault seed:0xAB"action":"wipekeys"` showed as `vault seed:•••` and hid the action. An unquoted value now ends at a space or a quote, so the parameters glued after it are shown. Test: `scripts/cmdgate-test.cjs`.

## [0.18.213] — miniMall: a read the node did not answer is never taken as read

- The gap backfill of 0.18.206 took a failed node read (refused at every depth, timed out, or an error swallowed by `.catch`) as covered: the scan tip advanced and the backfill floor dropped, so the newest part of a gap was never read. Now any failed read in a pass advances nothing and the same blocks are read on the next pass; a gap that opens while an older backfill is pending is kept (the target stays the oldest unread block); a backfill step skips coins an earlier pass already read; and the orders screen says when older orders could not be read yet, while it is catching up, or when the node serves no deeper history. Test: `scripts/shop-test.cjs`.

## [0.18.212] — databases: an empty file is a fresh start again; no empty file is written

- sql.js saves a database with no tables as 0 bytes, and the app wrote such files whenever the AtomiX engine stopped before creating a table (a locked vault, a node not write-enabled, a quick quit). 0.18.210 refused every empty file, so AtomiX and the ETH Wallet would never start for those users. Now a 0-byte file opens as a fresh database (as SQLite treats it), only a file with content that is not SQLite or fails the check is refused and kept, a save with no tables writes nothing, and a database the app has let go (a wallet replacement, or an init overtaken by one) is disposed: its pending save is cancelled and it never writes again (a pending save of the old wallet could land in the new wallet's file). PandaPools and the history database use the same shim and get the same behaviour. Test: `scripts/atomix-unit.js`.

## [0.18.211] — whole identifiers, no reply body in errors, whole ETH files, no rounding

- An RPC reply that is not JSON was reported with its first 120 characters (a reply can carry a seed or a key); the error now gives only the HTTP status and the length. The ETH wallet showed a shortened address (`shortAddr`) and a token with no symbol a few characters of its contract; both now show the whole address. A token with no name in the Web Wallet and Vestr lists shows its whole token id. `ethtokens.json` and `ethrpc.json` are written to a temporary file and renamed. The amount a swap needs ("Need ≈ …") was rounded by `toFixed`; it is now cut to 6 decimals. Test: `scripts/rpc-test.cjs`.

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
