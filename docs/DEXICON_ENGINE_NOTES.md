# Dexicon engine in the desktop: notes and safety analysis (Phase 3a)

Updated with 0.18.105 for engine 0.0.91 (own orders, price fallback).

Written 19 Nov 2026 with 0.18.99. Nothing here was tried on a node or against a relay: every statement is from
reading the code and from tests on a stand-in node (`scripts/dexicon-host.test.cjs`). What could not be proven that
way is listed at the end and in `PANDAMONIUM_DESKTOP_PLAN.md` section 9.

## What is where

| Part | File | Origin |
|---|---|---|
| Engine, 38 files | `main/dexicon/{lib,crypto,vendor,resting}/` | byte for byte from `mds/dexicon` 0.0.91, branch `security/2026-11-07`, commit `9a95eb114ad35d3e18692a60c248529762fd72d5` (0.18.98 to 0.18.104: 37 files of 0.0.89, `500dd24344a3739472eccbefb0c684bed2aa2930`); gate: `scripts/dexicon-parity-manifest.cjs` (CI) and `scripts/dexicon-parity-check.cjs` (donor) |
| Service | `main/dexicon/service.desktop.js` | hand mirror of the donor's `service.js`; its header lists every difference |
| Loader | `main/dexicon/loader.js` | DexiconPro's, without its two injected hooks. The vm gives the engine its own scope, **not a confinement** (its header, corrected in 0.18.110) |
| Host | `main/dexicon.js` | DexiconPro's `main/dexicon.js` + the `room.dex` part of `main/rooms.js`, as the public build |
| Store | `userData/dexicon/dexicon-<trading identity, whole>.sqlite`, one per wallet since 0.18.120 (before: one `dexicon.sqlite`, renamed once to its owner's name) | new; the SQL shim is `main/pandapools/sqlshim.js` (the one DexiconPro uses) |
| IPC | `mcd:dxStatus`, `mcd:dxBook`, `mcd:dxMine`, `mcd:dxCommand`, event `mcd:dexicon` (`mcd:dxInvalidate` removed in 0.18.106) | `main/main.js`, `main/preload.js` |

The donor working tree had uncommitted changes only under `graphify-out/` and untracked notes; none in the engine. The
copy was taken from the commit (`git archive HEAD`), not from the working tree.

## (a) Own orders and own pools

**Owner's decision, 19 Nov 2026.** Auto-crossing an exchange order against pools is allowed, **including the user's
own pool**. Reason given: a pool trade routes across several pools, a fee is paid, and a liquidity provider may
legitimately want to bring an out-of-line pool back into line before someone else does. What must never happen is a
user's order filling against their **own order** (an own FAST order or an own on-chain order).

What the engine does, case by case:

| Path | Can it fill the user's own ORDER? | Where |
|---|---|---|
| Auto-cross (`lib/autocross.js`) | **No.** It plans with an empty order book: `g.PandaComposite.plan([], pools, !sell, want, limit, 0)` (`lib/autocross.js:44`), and funds the trade only from the crossed rungs' own coins (`ownCoins`, `lib/autocross.js:284`). It takes from pools and from nothing else. | tested: "auto-cross runs as in the MiniDapp…" |
| Auto-cross against the user's own POOL | Yes, and allowed (decision above). `decide` (`lib/autocross.js:19`) walks every funded MxUSD pool and never looks at the pool's owner key `opk`. | |
| A FAST take built by the taker (`lib/fill.js`) | **No.** `plan` throws when the order lists a coin at one of the taker's own addresses (`lib/fill.js:88`); `takerGuard` refuses an order that lists one of the taker's own scripts or addresses (`lib/fill.js:189`, `:190`). The MiniDapp page also leaves its own orders out of what it takes (`ui/app.js:63`, not part of 3a). | engine |
| A FAST take arriving at the maker (`handleTake` → `AX.fill.cosign` / `verifyAsMaker`) | Only if the same node built it, which the line above refuses. The maker side has no check of its own for "the taker is me". | engine |
| The FAST ladder (`lib/ladder.js`) and `AX.maker` | They publish and re-back orders; they take nothing. | engine |
| The on-chain ladder (`resting/maker.js`, `PDService.makerOnBook`) and the processor | They post, re-price and renew orders; they take nothing. | engine |
| **A LIMIT order on the Exchange page (`PDService.limitWithPoolsInner`)** | **No, since engine 0.0.91.** `lib/ownskip.js` wraps `PandaComposite.plan` and `PandaBook.plan` (installed by the service with `PDService.isMine` and `PDService.keysUsable`, and by the page with its own list): this node's own orders are taken out of the book before either plans, so the plan routes past them inside the same limit. While the key list is unread a non-empty book is not planned at all. Up to 0.0.89 the engine did not prevent it and the host refused instead. | engine; tested through the host |

**Own orders and a LIMIT, since 0.18.105.** The host's own rule of 0.18.99 (`selfTrade`: refuse a LIMIT that could
reach an own order) is **removed** (owner, 19 Nov 2026: "market orders should not be refused if we have orders in the
stack"). What happens now, all in the engine:

- An own order at the best price and a third party's behind it: the plan takes the third party's (test: "an own order
  at the best price…", through `mcd:dxCommand` on the mock node).
- Nothing but own orders inside the limit, and no pool: the service answers with `AX.ownskip.ONLY_OWN` ("Only your own
  orders are at this price, so there is nothing to trade against. Nothing was sent.") as an `ERROR` packet and a stage
  line, and `PDService.action` is not called (`onlyOwnOrders` in `service.desktop.js`, the donor's text). The screens
  show that sentence as plan feedback, not as an error (`DexCore.feedbackKind`).
- The page's own preview and its "does this cross" test use the same wrapped planners (`ui/pd_app.js`), and
  `renderer/dexicon/mds.js` asks `AX.ownskip.onlyOwn` before an on-chain order so the same sentence is given there.
- Pools are untouched, the user's own pool included.

Auto-cross therefore runs as in the MiniDapp: the user's own saved setting (`mm_config.autoCross`, off by default,
behind the page's warning text) switches it on.

Not looked at here: room 2 (the PandaPools engine) swapping through the user's own pool. That is existing behaviour
of another engine and is covered by the same decision.

## (b) Every node command the engine can issue

All go through `MDS.cmd` → the host's `cmd` → `rpcCall` (`main/rpc.js`), which puts the one signing queue
(`main/noderun.js`) under them. `checkmode` is answered by the host and never sent.

| Command | Kind | Issued by |
|---|---|---|
| `block` | read | `lib/fill.js`, `lib/maker.js`, `resting/pd_service.js`, the host's block watch |
| `balance tokenid:…` (`address:…`) | read | `resting/funding.js` |
| `coins …` (`relevant:true`, `checkmempool:true`, `coinid:`, `tokenid:`, `address:`, `simplestate:true`, `order:desc`, `depth:`, `coinage:`, `sendable:true`) | read | `lib/maker.js`, `lib/fill.js`, `lib/autocross.js`, `resting/{book,pool,funding,input-claims,verifier,pd_service}.js`, `service.desktop.js` |
| `getaddress` | read | `lib/maker.js`, `lib/ladder.js`, `resting/pd_service.js`, `service.desktop.js` |
| `keys`, `keys action:list` | read | `resting/funding.js`, `resting/pd_service.js` |
| `scripts` | read | `lib/fill.js`, `lib/maker.js` |
| `history relevant:…`, `txpow onchain:…`, `txpow txpowid:…` | read | `resting/history.js` |
| `random size:8`, `random size:64` | read | `lib/mdsw.js`, `lib/prng.js` |
| `runscript script:"…"` | read | `resting/{funding,pool,pd_service}.js` |
| `seedrandom modifier:dexicon-identity-v1` | read (a one-way derivation; the phrase and seed are never read) | `service.desktop.js` |
| `txncheck id:…`, `txnview data:…`, `txnexport id:…` | read | `lib/fill.js`, `resting/txn.js` |
| `newscript script:"…" trackall:false` | write (registers a script) | `lib/fill.js`, `resting/txn.js`, `resting/pd_service.js` |
| `txncreate`, `txninput`, `txnoutput`, `txnstate`, `txnbasics`, `txnimport`, `txndelete` | write (the node's own transaction table) | `lib/{fill,maker,ladder}.js`, `resting/txn.js` |
| `txnpost id:…` (never `auto:`, `burn:` or `mine:`) | write (broadcast) | `lib/{fill,maker,ladder}.js`, `resting/txn.js` |
| **`txnsign id:… publickey:auto`** | **signing** | `lib/maker.js:111` (relock), `lib/ladder.js:274` (split) |
| **`txnsign id:… publickey:<key>`** | **signing** | `lib/fill.js:218` (taker), `:327` (maker co-sign), `resting/txn.js:68` |
| **`send address:… amount:… [tokenid:…] split:10`** | **signing** | `resting/split.js:19` |
| **`send amount:… address:… [tokenid:…] state:{…}`** | **signing** | `resting/txn.js:132` (place an on-chain order) |
| **`consolidate tokenid:…`** | **signing** | `service.desktop.js` `consolidate` |

Each of the five signing forms matches `SIGNING` in `main/noderun.js` (`send`, `txnsign`, `consolidate`); the pattern
needed no change. Tested two ways: a table test of the forms (and a scan that the engine uses no other signing verb:
no `sendpoll`, `txnauto`, `tokencreate`, `multisig`, `signfrom`, `txnpost auto:` / `burn:`), and an order test in
which two FAST relocks and a `consolidate` started together overlap at the node without the queue and never overlap
with it.

Not issued here although the donor's `service.js` can: `vault action:seed` (see the service header, NO VAULT).

One difference that matters for signing: in the MiniDapp the FAST layer's signing is also serialised inside the engine
by `doors/signgate.js` (`AX.signgate`, used by `lib/mdsw.js` `cmdR`). The doors are not loaded here, so `AX.signgate`
does not exist and the FAST layer relies on the host's queue alone. The RESTING layer keeps its own `PandaSignLock`
as well.

## (c) Three engines, one wallet: who takes which coin

What each engine holds for itself:

- Dexicon FAST: an order only **names** its backing coins; nothing is locked on the chain. Coins backing another live
  order are left out when backing a new one (`coinsBackingOthers`, `allocate`, `lib/maker.js:125`, `:300`); a take in
  progress holds its order's coins for 3 minutes in memory (`lockCoins` in the service). Coin choice asks the node
  with `checkmempool:true`, state-free coins at simple addresses only (`walletCoins`, `lib/maker.js`).
- Dexicon RESTING: `PandaFunding.select` (`resting/funding.js:21`: `relevant:true sendable:true checkmempool:true
  coinage:3`, state-free only), `PandaCoinLock` (in memory, 180 s), `PoolInputClaims` (durable, table
  `pp_posted_inputs` in **dexicon.sqlite**), and `PandaSignLock`.
- PandaPools: its own `pp_coinlocks` and `pp_posted_inputs` in **pandapools.sqlite**. AtomiX: its own swap database.

**Nothing is shared between the three engines.** Each reservation lives in that engine's own memory or store. What
stands between them is the node:

1. A coin spent by a transaction already in the mempool is not returned by a `checkmempool:true` read, so an engine
   choosing after another has posted does not pick that coin.
2. The signing queue makes signatures one at a time. It does not make a whole build, sign, post chain atomic.
3. So there is a window: engine A chooses coin X, engine B chooses X before A has posted. Both sign (two key uses
   are spent, on different leaves, because the queue serialises them). A's `txnpost` goes through. B's is expected to
   be refused by the node as a double spend.

What B then does, by path (every one ends in `txndelete`):

| Path | On a refused build / sign / check / post |
|---|---|
| RESTING, every chain (`T.checkPost`, `resting/txn.js:48`) | `T.run` deletes on a failed step; a failed `txncheck` deletes; a `txnpost` that is `status:false` and not pending deletes **and releases its input claims** (`PoolInputClaims.release`); an unanswered or uncertain post keeps the claims, and the service frees them after 10 minutes once the node shows the coin unspent and out of the mempool (`sweepUnposted`) |
| FAST relock (`lib/maker.js:104`) and split (`lib/ladder.js:259`) | a failed step deletes and reports; the post's callback deletes whether it failed or not |
| FAST take, taker side (`buildSigned`, `lib/fill.js:208`) | `finish` always deletes |
| FAST take, maker side (`cosignWith`, `lib/fill.js:285`) | `fail` deletes; a spent or mempool-spent input is caught by the pre-sign `txncheck` (`mmrproofs`) and the `checkmempool` look **before** any signature |
| `send` (split, place order) and `consolidate` | one node command: the node picks the coins itself and there is no transaction id to delete |

Result of a clash: a **rejected transaction and a wasted key use, not stuck funds**. The coin was spent once, by A.
B reports the failure (an ERROR packet, or a refused take) and its user tries again.

Coins the engines cannot take from each other by construction: PandaPools reserve coins (at a covenant address, not a
simple one) and AtomiX HTLC coins (they carry state) are never chosen by Dexicon, which takes only state-free coins
at simple addresses. The other direction is open: a `send` from the Wallet, AtomiX or PandaPools can spend a coin
that backs a FAST order. The maker's refresh (once a minute) then re-backs the order from other coins or withdraws
it; a take arriving in between is refused at the pre-sign check, with no signature spent.

Not proven without a node: the node's exact answer to a `txnpost` whose input is already spent in the mempool
(expected `status:false`; if it were accepted and never mined, the RESTING layer shows "has not confirmed in 6
blocks" and its claims are freed by the 10 minute sweep, and a FAST relock or split is simply repeated).

## (d) What the store holds, and what a wallet reset does

The identity is **not** stored. It is derived at every start from `seedrandom modifier:dexicon-identity-v1` (the
node's one-way derivation from its seed), then `AX.identity.fromSeed(seed, 'decks')`. Only the public id is kept
(`ax_kv.publicId`), to notice a change. The same wallet always gives the same identity; a different wallet gives a
different one (tested).

In `dexicon.sqlite`, and **not rebuildable** from the chain or the wallet:

| What | Where | If lost |
|---|---|---|
| The user's FAST orders | `ax_kv.myorders` | the orders stay on the relays, unanswered, until they lapse (65 minutes without a heartbeat, 23 hours at most); no coin is locked by them |
| Takes sent and not yet answered | `ax_kv.pending_takes`, `void_takes` | **funds exposure**: a signed take has no expiry, and voiding it (spending one of its coins back to the wallet) needs this record |
| FAST fills | `ax_kv.fill_<txpowid>` | history only |
| The FAST ladder's settings, rung ids, cross times and pending cross | `ax_kv.mm_config`, `mm_ids`, `mm_cross`, `mm_cross_pending` | settings re-entered; a pending cross would no longer hold auto-cross back |
| The relay list, coin age setting | `ax_kv.relays`, `coin_max_age` | back to the three defaults |
| On-chain orders the user placed, their coins and identities | `my_orders`, `my_coins`, `my_identities` | the orders themselves are found again on the chain by owner key; the orphan warning (orders under another key mode) loses its evidence |
| Trade tape and the user's trades | `market_tape`, `my_trades` | history only |
| A fill waiting to confirm, pending rows, cancels, renewals in flight | `fill_state`, `pending_state`, `cancelled_coins`, `processor_inflight` | a trade in flight is no longer followed (it still settles or fails on the chain) |
| The on-chain ladder | `maker_state` | settings re-entered |
| Input claims | `pp_posted_inputs` | a posted input could be chosen again before it confirms; the node refuses the second spend |

Writes to the money-state rows (`fill_*`, `pending_takes`, `void_takes`, `mm_cross_pending`, `pp_posted_inputs`,
`fill_state`, `pending_state`, `maker_state`, `my_orders`, `my_coins`, `cancelled_coins`, `processor_inflight`) are
written to disk at once; everything else within 400 ms (the shim's pause). FAST order sequence numbers are clock
times, so an order republished after a crash still supersedes its older copy.

**A wallet reset or restore (rewritten for 0.18.106).** Before it: the main process refuses the replacement while
Dexicon has on-chain orders (named by coin id in full), placements waiting for a block, or takes not yet answered, and
also when the engine cannot be asked (`main/restore.js` `activeWorkList`, fed by `dexicon.activeWork()`). FAST orders
do not block it: they lock nothing and lapse by themselves.

After it, four independent lines, none of which needs the window:

1. `node-manager.runResync` (rewritten in 0.18.116). Before a wallet-replacing command is sent, the three trading
   engines are held (`onEnginesHold`: `atomix.hold()`, `pandapools.hold()`, `dexicon.hold()`; no timer, no start, no
   screen action, no signing command) and the wallet is identified: `walletMark()`, a SHA-256 of the node's
   `seedrandom modifier:minimacore-desktop-wallet-mark-v1` (equal = the same seed). After the command the mark is read
   again (`walletSettle`: at once when the node still runs, else by the health poll before the restarted node is
   called "running"). **Another wallet**: `node.onWalletReplaced` (`main/main.js`: minimaMail, PandaPools, AtomiX,
   Dexicon with `hold`, P2P Chance) sets the stores aside (`dexicon.sqlite-legacy-keys-YYYYMMDD`, a second on the same
   day gets `-2`; never deleted), then the engines are released. **The same wallet** (the same phrase restored again,
   a refused command, a timeout before any swap): nothing is moved and the engines go on with their stores.
   **Not readable**: nothing is concluded, the engines stay held, asked again every health tick. After a timeout with
   the node still running the check stays owed, because the node may swap later: it is asked again every tick and at
   the next start. One case is still decided without a comparison: the wallet could not be identified BEFORE the
   command (a locked node). Then the stores are set aside after a success and after an unknown result, as in 0.18.106.
2. `dexicon.stop()` drops the engine whenever the node is not "running", so no engine carries an identity across a
   node start. Other ways to another wallet (another data folder, a crash in the middle) meet line 3. Since 0.18.117
   the drop waits for what the engine has in flight (see "Stopping", below).
3. At every boot the service compares `ax_kv.publicId` with the identity this wallet derives
   (`retireOldIdentity`). Different: not READY, the on-chain engine not booted, the store moved aside by the host
   (`MDS.foreignStore`), an empty engine started, both identities logged in full.
4. While a move aside is owed and fails, `init()` opens no store: Dexicon stays stopped, `dxStatus().problem` says why
   (the Dexicon screens show it), and the move is tried again every tick.

The old engine's late callbacks reach neither the node nor the new store (epoch guard, tested). A signing command
it had already queued behind another signer is dropped in the queue (0.18.107: one `AbortController` per epoch, its
signal on every `rpcCall`, aborted by `stop()` and `invalidate()`); one the node was already given cannot be recalled.

A Dexicon that cannot be checked (0.18.110): a damaged store, or an engine that is not ready two minutes after the
node started, no longer refuses a replacement for ever. `activeWork()` gives `waitedMs`; `restore.activeWorkList`
names what cannot be checked; when that is the only thing in the way the screen may ask to go on
(`restore.DEX_SKIP_WARNING`), and `mcd:dxSkipCheck` checks again in the main process, logs the choice and leaves the
Dexicon check out for two minutes. Lines 1 to 4 then run as always, so the damaged store is kept aside.

**One store per wallet (0.18.120, M3).** The host derives the trading identity itself before it opens anything
(`seedrandom modifier:dexicon-identity-v1`, then the engine's own `AX.identity.fromSeed` in the engine's context) and
opens `dexicon-<publicId>.sqlite`. Another data folder, or a wallet restored over this one, therefore opens ITS store,
and the first wallet finds its own again when it is back (its orders, and the takes it had sent: they can be voided
again). Until 0.18.119 line 3 moved the one `dexicon.sqlite` aside at every such change and nothing brought it back.
A `dexicon.sqlite` from before is read (read only) for the identity it records and renamed once to that identity's
name, whoever is running; to this wallet's when it records none; kept aside when that name already exists; left alone,
with no engine started, when it cannot be read. Line 3 still stands for a file under this wallet's name that records
another identity. `invalidate()` (line 1) still moves the store this host had open aside under its dated name; a host
that has opened none moves only an old `dexicon.sqlite`. Cost: `seedrandom` is asked twice per start (host, service).

Not covered by line 3: a store with no recorded `publicId` (the engine never reached READY on it). AtomiX and
PandaPools have line 1 only, plus their own guards (AtomiX IdentityWatch, PandaPools signing holds); a data-folder
change does not reset them.

A restore that goes back to the SAME wallet keeps every store (0.18.116; before, the stores were moved aside and
putting them back was a manual step). Not covered: the app killed between the command and the comparison (the owed
check is in memory); the next start then meets lines 2 to 4 for Dexicon and the engines' own guards for the others.

## (e) The MiniDapp's MDS and this host's stand-ins

| MDS in the node | Here | Matters because |
|---|---|---|
| `MDS.cmd`: through MiniHub permissions, WRITE trust, replies can be `pending:true`, replies over about 256 KB come back empty | the node's own RPC through `rpcCall`: no trust levels, never `pending`, no size cap | the engine's `pending` branches never run; `checkmode` is answered by the host (`writemode:true`, `dblocked:false`), so a password-locked node is not noticed up front and shows as failed signatures; the book scan's "empty reply, halve the window" probe costs one extra read per region and nothing else |
| `MDS.sql`: H2, one database shared by page and service | sql.js (SQLite) through the shim: `MERGE INTO … KEY(…)` → `INSERT OR REPLACE`, upper-case column names, `auto_increment` rewritten | every statement the engine uses ran on the stand-in (boot, tape migration with `ALTER TABLE … ADD COLUMN`, kv, claims); SQLite's `LIKE` is case-insensitive where H2's is not (the engine's only `LIKE` is `k LIKE 'fill_%'`); the database is saved whole to a file (at once for the rows above, else after 400 ms), where H2 commits each statement |
| `MDS.net.GET` / `POST`: **synchronous** in Rhino, any URL | **asynchronous**, https only, only under a relay of the engine's current list or the price source (GET: `api.mexc.com`, and `api.coingecko.com/api/v3/coins/minima/tickers`), no redirects, the app's SSRF guard (`main/netfetch.js`: no private or loopback address), replies capped at 8 MB, a POST body at 256K characters for a relay message (the protocol's `MAX_MSG_BYTES`; 64K until 0.18.119, which refused every take over about 7.8 KB of transaction: a sealed take is about eight times its transaction), read timeout 15 s without a byte (so the page's 25 s long-poll hold is cut to 10 s in `renderer/dexicon/mds.js`, 0.18.119; the service's own hold is 8 s) | the tick needs an overlap guard and a watchdog (service header, ASYNC NET); **a relay on the user's own machine or LAN (`http://localhost…`, which the engine itself allows) cannot be used here**; since 0.18.108 Dexicon takes **no** slot of the pool the app's other outbound calls share (`ownCap`): it has its own lanes in `main/dexicon.js`, WORK 2 at a time and POLL 3 (the service's inbox long poll and the page's inbox and book long polls). Refusals to takers go at low priority, at most 32 waiting, oldest dropped; nothing that carries a signature or its result is dropped. Before, three of the four shared slots were held by those long polls most of the time |
| `MDS.comms.solo`: echoed to every part of the MiniDapp, the service included | service → `mcd:dexicon` event for the screens; screens → `mcd:dxCommand` `{op:"comms"}` → the service's `MDSCOMMS` event; no echo | the `origin` field's job (ignoring one's own echo) has nothing to do; the host accepts only origins `ui` and `dexicon` from a screen |
| `MDS.keypair` | not provided | the engine does not use it (settings live in `ax_kv`) |
| Timers: the node sends `MDS_TIMER_10SECONDS` and pushes `NEWBLOCK` per block; the service scope has no `setTimeout` | a 10 s interval in the host; the block is **polled** on that interval, so a block is seen up to 10 s late and several blocks arrive as one event | the engine takes the tip from `block` itself, so a merged event loses nothing; `setTimeout` exists in the vm but the engine never calls it |
| `MDS.notify` | the host's `notify` event (no OS notification is raised yet) | 3b decides what to show |
| `MDS.load` | path-jailed to `main/dexicon/` | a stray file there fails the parity gate |
| `inited` once per node start | once per node start too since 0.18.106 (the engine is dropped when the node stops), plus a retry of `PDService.boot()` once a minute while the resting engine is not ready, never beside a boot still running (0.18.110; a boot that never ends is given up on after 5 minutes) | a node that was slow at the first try does not leave the Exchange dead |
| Price: `resting/price.js` over `MDS.net.GET` (MEXC depth, then MEXC bookTicker), and since 0.0.90 `AX.ladder.feed(PandaPrice)`: when neither MEXC call returns JSON, MEXC's own MINIMA/USDT ticker from `https://api.coingecko.com/api/v3/coins/minima/tickers?exchange_ids=mxc` | the same files, the same three URLs; the host allows GET to `api.mexc.com` and to that one CoinGecko path, nothing else | a MEXC answer (even a thin or crossed book) stands and CoinGecko is not asked; the fallback read is aged from CoinGecko's fetch time; `dxStatus().price.source` is `MEXC` or `MEXC via CoinGecko` |

## Stopping: what is in flight ends first (0.18.117)

A maker's co-signed take is recorded after `txnpost` answers (`handleTake`: `fill_<txpowid>`, the "taken" reply,
`afterFill` reducing `remaining`). Up to 0.18.116 `stop()` dropped the engine the moment the node said "stopping", so a
reply that arrived after it was refused by the epoch guard: the fill was on the chain and nothing recorded it.

- `node-manager.stop()` now calls `onStopping` (main.js) **before** it sends `quit` and waits for it (30 s at most):
  `dexicon.stop()`, `atomix.quiet()`, `pandapools.quiet()`.
- `dexicon.stop()` ends the timer and every new event at once (`fire` is closed, `status().ready` is false), drops
  signers that are only queued (0.18.107), and drops the engine when nothing is at the node and nothing is in the WORK
  lane for three looks running (40 ms apart), or after 15 s; an unanswered `txnpost` is waited for beyond that (it ends
  when the node answers or the request fails; the RPC limit is 180 s).
- A `txnpost` that fails without the node having provably refused it (anything but ECONNREFUSED or an auth failure)
  reaches the engine as "the node did not answer txnpost: …". For a maker's take the service (POST UNANSWERED in its
  header) writes `ax_kv.fill_unanswered_<ms>_<orderId>` with status `unknown` at once (to disk, it matches `fill_`),
  reduces the order as if the fill had happened and tells the taker nothing. `settleFills` decides later: an output
  coin of the take on the chain = `done`; this node's own input coin unspent and out of the mempool ten minutes on, or
  nothing after two hours = `lost`, and the amount is put back on the order if it is still live. The screens show
  UNKNOWN / DONE / LOST (`DexCore.fillState`).
- Not done: the taker is not told "taken" after the fact (the reply needs the txpowid, which this node never got);
  the taker's own void pass settles its side from the chain.
- AtomiX and PandaPools: their engines are not dropped when the node stops (the context lives until the app quits or
  the wallet is replaced), so a record written after a reply is written. What they lacked was the wait: `quiet()`
  (10 s at most) now lets what they have at the node answer before `quit`. A `txnpost` of theirs that the node never
  answers is not specially recorded by the glue. What each engine then does is its own (vendored) rule and was not
  re-examined here: AtomiX records the coin it locked on first sighting on the chain (`mycoinid`), PandaPools has its
  durable input claims (`pp_posted_inputs`).

## The taker's page and takes awaiting an answer (0.18.109)

A FAST take is built, signed and sent by the MiniDapp page (`renderer/dexicon/ui/app.js`, verbatim, in the hidden
`dxroom://` frame). The page records it in `ax_kv.pending_takes` before sending, hears the maker's answer on its own
inbox poll, and voids it (spends one of its own coins in it back to the wallet) when no answer came in 5 minutes.

- The frame is made by `renderer/dexicon-ui.js` whenever the node is "running" and the engine is ready, on any tab
  (`DexCore.pageStep`); it is remade when `dxStatus().epoch` changes, and dropped with the node.
- Voiding does not depend on the frame: when the page has written no `ui_alive` for 2 minutes, the service voids
  from the same records (`voidSweep`, `voidOne` in `service.desktop.js`; every third tick). With the frame alive the
  page owns its takes and the service leaves them alone.
- While the node is stopped nothing can void a take. The Shutdown warning says how many are waiting
  (`dexicon.activeWork().takes`, through `mcd:dxWork`); the wallet-restore gate refuses while any is.

## The Trade click signs what was reviewed (0.18.118)

Two books exist: the service's (`dxBook`, one relay read every 10 s, drawn as the ladder) and the page's own
(long-polled; the one a take is built from). Up to 0.18.117 the review was planned on the first and the click acted on
the second.

- The page sends its FAST book with every report (`renderer/dexicon/mds.js` `fastBook`: `DexiconFast.crossing` on
  both sides, so other makers' backed orders only, in the page's own take order). The ticket plans on it
  (`DexCore.tradeBook`), with this node's own orders added from the read model for the "only your own orders" line.
- `place` carries `expect` ("take" or "rest") and, for a take, `take` and `worst` (`DexCore.expectOf`). `ACTS.place`
  walks the page's `crossing()` again with `AX.fill.floorTake` and refuses with "The book changed since you reviewed
  this. Review it again. Nothing was signed." unless it finds the same: no crossing order for "rest"; the same total
  and the same worst price for "take".
- `ui/app.js` `nextOrder` turns a sweep whose orders have just gone into a resting order of the full amount. The page
  file is verbatim, so `mds.js` wraps `AX.maker.create`: while a reviewed take runs, it is refused.
- One money action at a time: `running()` in `mds.js` (the page's own busy button, a published order not yet answered,
  and the 1.5 s before a sweep has locked the button) refuses `place`, both cancels, both edits and `makerStop`; the
  native screens have one `money()` gate for the same buttons. After a FAST action the amount field is set to the
  page's own (`finishSweep`: only what is surely untraded; empty after a published order).
- Not covered: within a take the page may still skip an order (an earlier take of it pending, a refusal) and move to
  the next one inside the same limit price; the limit is the bound, as on the phone. Room ①'s actions are not behind
  the Exchange gate (another engine; the signing queue serialises them).

## The command bridge (`mcd:dxCommand`)

`{ op: "cmd", command }`, `{ op: "sql", query }`, `{ op: "comms", message }`, `{ op: "net", … }`, `{ op: "identity" }`.
Ported from DexiconPro's `room.dex`.

**Until 0.18.119 it was not a spending boundary**: the hidden page builds and signs its own FAST takes, so `txncreate`,
`txninput`, `txnoutput`, `txnsign` and `txnpost` reach it, and whoever controlled the page could build any spend with
them. Since 0.18.120 the main process checks every signature and post the frame asks for (next section).
What else bounds the page: it is this app's vendored code (digest-pinned), it runs in a sandboxed frame of its own origin
with no network (CSP `connect-src 'none'`) and no `window.mcd`, and relay data is parsed, never evaluated. The verb
list keeps out what the page never needs (`send`, `consolidate`, backups, key and password parameters).

Since 0.18.110:

- **SQL is an allow-list** (`dexSql`, `SQL_OK` in `main/dexicon.js`): the `ax_kv` statements of `lib/mdsw.js`
  (`kvInit`, `kvGet`, `kvSet`, `kvDel`), `SELECT k, v FROM ax_kv WHERE k LIKE '…'`, `… WHERE k IN ('…',…)`, and
  ``SELECT `json` FROM `fill_state` WHERE `id`=1``. One statement; values are quoted literals. `publicId` cannot be
  written. Refusals are logged ("refused SQL from a screen").
- **The identity seed is never an IPC answer.** `seedrandom` is refused on the bridge. `{ op: "identity" }` is answered
  by `main/main.js`: `dexicon.identitySeed()` (the same one-way derivation the service uses), then
  `dexicon-room.js` `deliverIdentity` runs `window.__dxIdentity(seed)` in the one `dxroom://exchange/` frame of the
  asking window; the reply is `{ status: true }` or a reason, never the seed. The page needs the seed because it signs
  orders and seals takes with the identity made from it. Not proven in Electron (see the plan, section 9).

Verbs and rules:

- Verbs: `balance block checkmode coins getaddress history newscript random scripts status txpow txncheck txncreate
  txndelete txnexport txnimport txninput txnoutput txnpost txnsign txnview`. (`seedrandom` was allowed in its one
  identity form until 0.18.110.) **Removed** from DexiconPro's list: `coinexport`, `consolidate`,
  `runscript`, `tokens`, `txnbasics`, `txnstate`; the page at 0.0.89 never sends them (its consolidate is a packet to
  the service). If a 3b screen needs one, add it with the line of page code that issues it.
- Kept: no `;` and no control characters, 300,000 characters at most, no `file:`, `keyuses:`, `privatekey:`,
  `password:`, `txnpostauto:`, `txnpostmine:`, `txnpostburn:`. **Added**: `txnpost` with `auto:`, `burn:` or `mine:`
  is refused.
- **Removed** (DexiconPro-only): the PAUSE ALL / NUKE gate on `send` / `txnpost` / LIMIT / SPLIT / EDIT, the refusal
  of `MAKER_*` packets, the SQL refusals (`maker_state`, `mm_*`, `mxusd_tokenid`).
- **Added**: packets must be JSON with origin `ui` or `dexicon`. (The own-order rule on LIMIT of 0.18.99 was removed in 0.18.105, see (a).)

## The frame's transactions are checked in the main process (0.18.120, M4)

`main/dexicon-signgate.js` (pure rules) and `pageCmd` / `frameCheck` in `main/dexicon.js`.

What is enforced, on every `txn*` command that comes through the bridge:

- Only the exact command shapes of the page's two builders (`lib/fill.js` `buildSigned`, `lib/maker.js` `relock`):
  `txncreate id:`, `txninput id: coinid: scriptmmr:true`, `txnoutput id: amount: address:0x… [tokenid:]`,
  `txnsign id: publickey:auto|0x…`, `txnpost id:`, `txncheck`, `txnexport`, `txndelete`. Any other spelling (a floating
  input, `storestate:`, an `Mx` address, extra parameters) is refused. `txnimport` is no longer a verb of the bridge.
- `txninput` / `txnoutput` / `txnsign` / `txnpost` / `txncheck` / `txnexport` / `txndelete` only on an id the frame
  created with `txncreate` in this engine's life.
- Before a `txnsign` or `txnpost` is forwarded, main asks the node what that id holds (`txnlist id:`) and applies:
  - **SELF** (every output pays this wallet): allowed, signed and posted, when per token everything that goes in
    comes back (no burn). This is the page's void / relock.
  - **TAKE** (an output pays someone else): never posted. Signed only when the user reviewed a FAST trade on the
    native Trade screen in the last ten minutes (`{ op: "reviewed", buy, price, amount }`, sent by the app's own
    window before it drives the page; the frame's bridge cannot send that op); every input that is not this wallet's
    is a coin of ONE live order, of the side being taken, that the **service's own** relay client holds
    (`RELAY.orders()`, not the page's copy); every foreign output pays that order's address or the address of one of
    its coins; only MINIMA and MxUSD move; this wallet gives one and receives the other at that order's price or
    better (the engine's rounding); the order's price is inside the reviewed limit; and the MINIMA of all takes signed
    since the review is inside the reviewed amount (a transaction signed with several keys is counted once).
- "This wallet's address" = a `RETURN SIGNEDBY(key)` script from `scripts` whose key is in `keys`. (`scripts` alone
  holds every maker's script the taker registered.) Read once per engine, and again before a refusal stands.
- A refusal that may only mean "this side is behind" (the page has heard an order the service has not read yet) makes
  the service read each relay once, then the check is made again.
- Frame transaction commands run one at a time, so nothing can be added to a transaction between the check and the
  signature. Every refusal is logged ("REFUSED from the Dexicon page") and returned to the page as its error.

What it does NOT cover:

- **Which order.** Main knows the reviewed side, limit and amount, not the orders the review listed. A take of
  another live order inside the same limit and amount passes (that is also what the page's own sweep may do).
- **The engine's own records.** The brief asked for the check to read the pending take the transaction belongs to.
  It cannot: `ui/app.js` `sendTake` writes `pending_takes[orderId]` AFTER `F.build` has signed, and the transaction
  id (`dx` + time + random) appears in no table. The order is therefore taken from the service's relay book instead.
- **Both books come from the same relays.** An order a relay invents is "an order" for both; what bounds the loss is
  the reviewed limit price and amount, not the order's honesty.
- The maker's side (its change, whether its coins cover the fill): not this wallet's funds; the engine checks them.
- Non-transaction verbs (`newscript`, reads), the page's SQL (its own allow-list) and its relay traffic.
- The service (`main/dexicon/service.desktop.js`) is not behind this gate: it is the app's own code in the main
  process, and it must co-sign as maker and place on-chain orders.
- Not proven on a node: that `txnlist id:` shows input and output coins with `address`, `tokenid` and, for MxUSD,
  `tokenamount` exactly as read from the node's source (`TxnRow.toJSON`, `Coin.toJSON`, `txninput`, `txnoutput`). If
  it does not, every FAST take is refused with "an MxUSD amount the node did not state": first dev-node check.

**Proposed donor-side change (mds/dexicon), so a host can bind a signature to the engine's own record:**

1. `ui/app.js` `sendTake`: write the pending take (order id, the order as taken, the plan with its inputs and outputs)
   to `ax_kv.pending_takes` BEFORE `F.build`, marked `building`, and clear the mark once it is signed and sent (a
   record left `building` is dropped by the void pass: nothing was sent).
2. `lib/fill.js` `buildSigned`: take the transaction id from the caller and store it in that record
   (`pending_takes[orderId].txnid`), or derive it from the order id, instead of `txnId('dx')` known to nobody.
3. `ui/app.js` `executeTake`: write the reviewed limit, side and amount of the run (`ax_kv.take_run`) before the
   first order is tried, so the bound a host enforces is the engine's own record and not a message from the screen.
4. `nextOrder`: do not turn a sweep that finds nothing into `createFast` (0.18.118 refuses it from outside).

## Not proven without a node or relays

- The engine against a real node: boot, key reading, the book and pool scans on real data, a real signature.
- Any relay traffic: publish, inbox long poll, a take from another node, a co-sign, a fill settling.
- The node's answer to a double spend at `txnpost` ((c)).
- That `keys action:list` on a block-key wallet lists the keys the engine's ownership test needs.
- The price feed against the real MEXC replies through `main/netfetch.js`.
