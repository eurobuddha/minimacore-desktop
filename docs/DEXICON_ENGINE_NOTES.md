# Dexicon engine in the desktop: notes and safety analysis (Phase 3a)

Written 19 Nov 2026 with 0.18.99. Nothing here was tried on a node or against a relay: every statement is from
reading the code and from tests on a stand-in node (`scripts/dexicon-host.test.cjs`). What could not be proven that
way is listed at the end and in `PANDAMONIUM_DESKTOP_PLAN.md` section 9.

## What is where

| Part | File | Origin |
|---|---|---|
| Engine, 37 files | `main/dexicon/{lib,crypto,vendor,resting}/` | byte for byte from `mds/dexicon` 0.0.89, branch `security/2026-11-07`, commit `500dd24344a3739472eccbefb0c684bed2aa2930`; gate: `scripts/dexicon-parity-manifest.cjs` (CI) and `scripts/dexicon-parity-check.cjs` (donor) |
| Service | `main/dexicon/service.desktop.js` | hand mirror of the donor's `service.js`; its header lists every difference |
| Loader | `main/dexicon/loader.js` | DexiconPro's, without its two injected hooks |
| Host | `main/dexicon.js` | DexiconPro's `main/dexicon.js` + the `room.dex` part of `main/rooms.js`, as the public build |
| Store | `userData/dexicon/dexicon.sqlite` | new; the SQL shim is `main/pandapools/sqlshim.js` (the one DexiconPro uses) |
| IPC | `mcd:dxStatus`, `mcd:dxBook`, `mcd:dxMine`, `mcd:dxCommand`, `mcd:dxInvalidate`, event `mcd:dexicon` | `main/main.js`, `main/preload.js` |

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
| **A LIMIT order on the Exchange page (`PDService.limitWithPoolsInner`)** | **Yes: the engine does not prevent it.** It plans over the whole book: `PandaComposite.plan(PDService.book, …)` (`resting/pd_service.js:1165`) and `PandaBook.plan(PDService.book, …)` (`:1197`); `C.orders` (`resting/composite.js:115`) and `B.plan` (`resting/book.js:47`) skip only unfillable, wrong-side, expired and out-of-limit orders. `PDService.owns` / `isMine` (`resting/pd_service.js:112`, `:113`) are used for display, cancel and the ladder, never for routing. | **closed in the host**, below |

**The host's rule for LIMIT** (`selfTrade` in `main/dexicon/service.desktop.js`, asked by `pageComms` in
`main/dexicon.js` before the packet reaches the engine): a LIMIT is refused when any fillable order of this node's
own keys (`PDService.isMine`) sits on the other side at or inside the limit price (with no limit price: any own order
on the other side), and while the node's keys have not been read. It is blunt on purpose, because the engine re-reads
the pools and plans again after the check. The message names the order's price and its coin id in full. Pools are not
part of the rule. Limits of this rule, stated plainly:

- It is a host rule over a book that is up to one block old. An own order that appears on the chain between the
  check and the engine's own plan is not seen. The right place for the rule is the engine (`C.orders` and `B.plan`
  leaving out `PDService.isMine` orders); that is a change in the donor, to be made there and re-vendored.
- It covers the bridge (`mcd:dxCommand`). Nothing else in this app can send a LIMIT to the engine.
- DexiconPro's rule was different (`crosses()`: its order form only rests, so anything that would trade at once is
  refused). The public page does take, so that rule was not ported.

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

**A wallet reset or restore.** Before it: the main process refuses the replacement while Dexicon has on-chain orders
(named by coin id in full), placements waiting for a block, or takes not yet answered, and also when the engine
cannot be asked (`main/restore.js` `activeWorkList`, fed by `dexicon.activeWork()`). FAST orders do not block it: they
lock nothing and lapse by themselves. After it: `dexicon.invalidate()` (the renderer's `walletReplaced` chain,
`mcd:dxInvalidate`) stops the engine, **moves `dexicon.sqlite` aside as `dexicon.sqlite-legacy-keys-YYYYMMDD`** (a
second on the same day gets `-2`; `main/restore.js` `moveAside`; never deleted), and starts an empty engine on the new
wallet's identity. The old engine's late callbacks reach neither the node nor the new store (epoch guard, tested). If
the move fails, Dexicon stays stopped and says so in its log.

Open point: a restore that goes back to the SAME wallet also moves the store aside. The file is kept, so nothing is
lost, but putting it back is a manual step today.

## (e) The MiniDapp's MDS and this host's stand-ins

| MDS in the node | Here | Matters because |
|---|---|---|
| `MDS.cmd`: through MiniHub permissions, WRITE trust, replies can be `pending:true`, replies over about 256 KB come back empty | the node's own RPC through `rpcCall`: no trust levels, never `pending`, no size cap | the engine's `pending` branches never run; `checkmode` is answered by the host (`writemode:true`, `dblocked:false`), so a password-locked node is not noticed up front and shows as failed signatures; the book scan's "empty reply, halve the window" probe costs one extra read per region and nothing else |
| `MDS.sql`: H2, one database shared by page and service | sql.js (SQLite) through the shim: `MERGE INTO … KEY(…)` → `INSERT OR REPLACE`, upper-case column names, `auto_increment` rewritten | every statement the engine uses ran on the stand-in (boot, tape migration with `ALTER TABLE … ADD COLUMN`, kv, claims); SQLite's `LIKE` is case-insensitive where H2's is not (the engine's only `LIKE` is `k LIKE 'fill_%'`); the database is saved whole to a file (at once for the rows above, else after 400 ms), where H2 commits each statement |
| `MDS.net.GET` / `POST`: **synchronous** in Rhino, any URL | **asynchronous**, https only, only under a relay of the engine's current list or `api.mexc.com` (GET), no redirects, the app's SSRF guard (`main/netfetch.js`: no private or loopback address), replies capped at 8 MB, a POST body at 64 KB, read timeout 15 s | the tick needs an overlap guard and a watchdog (service header, ASYNC NET); **a relay on the user's own machine or LAN (`http://localhost…`, which the engine itself allows) cannot be used here**; the long poll (8 s of every 10 s) holds one slot of the pool the app's other outbound calls share |
| `MDS.comms.solo`: echoed to every part of the MiniDapp, the service included | service → `mcd:dexicon` event for the screens; screens → `mcd:dxCommand` `{op:"comms"}` → the service's `MDSCOMMS` event; no echo | the `origin` field's job (ignoring one's own echo) has nothing to do; the host accepts only origins `ui` and `dexicon` from a screen |
| `MDS.keypair` | not provided | the engine does not use it (settings live in `ax_kv`) |
| Timers: the node sends `MDS_TIMER_10SECONDS` and pushes `NEWBLOCK` per block; the service scope has no `setTimeout` | a 10 s interval in the host; the block is **polled** on that interval, so a block is seen up to 10 s late and several blocks arrive as one event | the engine takes the tip from `block` itself, so a merged event loses nothing; `setTimeout` exists in the vm but the engine never calls it |
| `MDS.notify` | the host's `notify` event (no OS notification is raised yet) | 3b decides what to show |
| `MDS.load` | path-jailed to `main/dexicon/` | a stray file there fails the parity gate |
| `inited` once per node start | once per app start, plus a retry of `PDService.boot()` once a minute while the resting engine is not ready | a node that was slow at the first try does not leave the Exchange dead |
| Price: `resting/price.js` over `MDS.net.GET` (MEXC depth, then MEXC bookTicker) | the same file, the same two URLs | **the MiniDapp has no CoinGecko fallback** (that exists in the Android apps); none was added |

## The command bridge (`mcd:dxCommand`)

`{ op: "cmd", command }`, `{ op: "sql", query }`, `{ op: "comms", message }`. Ported from DexiconPro's `room.dex`:

- Verbs: `balance block checkmode coins getaddress history newscript random scripts status txpow txncheck txncreate
  txndelete txnexport txnimport txninput txnoutput txnpost txnsign txnview`, plus exactly
  `seedrandom modifier:dexicon-identity-v1`. **Removed** from DexiconPro's list: `coinexport`, `consolidate`,
  `runscript`, `tokens`, `txnbasics`, `txnstate`; the page at 0.0.89 never sends them (its consolidate is a packet to
  the service). If a 3b screen needs one, add it with the line of page code that issues it.
- Kept: no `;` and no control characters, 300,000 characters at most, no `file:`, `keyuses:`, `privatekey:`,
  `password:`, `txnpostauto:`, `txnpostmine:`, `txnpostburn:`. **Added**: `txnpost` with `auto:`, `burn:` or `mine:`
  is refused.
- **Removed** (DexiconPro-only): the PAUSE ALL / NUKE gate on `send` / `txnpost` / LIMIT / SPLIT / EDIT, the refusal
  of `MAKER_*` packets, the SQL refusals (`maker_state`, `mm_*`, `mxusd_tokenid`).
- **Added**: packets must be JSON with origin `ui` or `dexicon`; a LIMIT passes the own-order rule of (a).

## Not proven without a node or relays

- The engine against a real node: boot, key reading, the book and pool scans on real data, a real signature.
- Any relay traffic: publish, inbox long poll, a take from another node, a co-sign, a fill settling.
- The node's answer to a double spend at `txnpost` ((c)).
- That `keys action:list` on a block-key wallet lists the keys the engine's ownership test needs.
- The price feed against the real MEXC replies through `main/netfetch.js`.
