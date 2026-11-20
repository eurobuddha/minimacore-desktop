# Shared coin reservation (Phase 3f)

Four signers share one wallet: AtomiX, PandaPools, the Dexicon engine, and the wallet itself (Send, Split,
Consolidate, Mail, Chat, miniMall, Vestr, the Web Wallet, the terminal) plus P2P Chance in its settle-only form.
The signing queue (`main/noderun.js`) keeps their signatures apart in time. It does not keep their COINS apart: one
engine chooses a coin, another chooses the same coin before the first has posted. This file is the design of the one
registry that does.

Engines are not edited. The only differences an engine can observe are a refusal before signing, and which coins it
is shown or pinned to.

## Setting (0.19.100): what is enforced

The security review's verdict on 0.18.143 to 0.18.147 was "do not ship fully enabled". Since 0.19.100:

| Part | Default | Setting |
|---|---|---|
| `txninput` refusal, and the bookkeeping of `txncreate` / `txnpost` / `txndelete` | ENFORCED | master switch only |
| an engine's `coins relevant:true … tokenid:` read left without held coins | ENFORCED | master switch only |
| `send` pinning / refusal, `consolidate` refusal, a chain holding either | OBSERVED: the command goes out byte for byte; the log (`[coins] observe: … WOULD HAVE BEEN PINNED / REFUSED: why`) says what would have happened | `coinGuardSends`: `off` (not looked at, no extra read) / `observe` / `enforce` |
| everything | on | `coinGuard: false` = the whole guard is a passthrough: nothing read, recorded or refused |

Both are in Settings, "Coin guard" (`config.json` keys `coinGuard`, `coinGuardSends`; `main.js` passes them to
`reserve.setMode` at start and at every save). While sends are not enforced, the callers' own pin (`main/sendpin.js`)
avoids no held coin (`reserve.sendHeld`), and the Wallet shows the node's own sendable figures (held coins are still
marked in the coins dialog).

"Release all holds" (Settings, with a confirm; `mcd:reserveReleaseAll`): `invalidate()` in the main process, the file
moved aside under a dated name, a new one opened. Safe: the node's own mempool check still refuses a double spend. A
hold whose Dexicon order is still live is listed again by its engine within a minute.

## Where it lives

`main/reserve.js` holds the registry. `main/rpc.js` `rpcCall` is the one function every node command of every caller
already passes, so the registry's `guard` is called there, INSIDE the signing queue: a `send` is checked and pinned
at the moment it is really sent, not when it was queued. Each caller says who it is with `opts.owner` on its
`rpcCall` (`atomix`, `pandapools`, `dexicon`, `casino`, and `wallet` for everything else; a call that names no owner
is `wallet`). `main/sendpin.js` stays the coin pin and learns two things: reserved coins, and tokens.

The engines' tests replace their runners with mocks, so they do not pass the registry. Its own tests
(`scripts/reserve-test.cjs`) put it in front of a model node.

## Data model

Two maps, both keyed by coin id (lower case):

- `txns`: a coin named for a transaction. `{ coinid, owner, txn, state, at, postedAt, postedBlock, why, tokenid,
  amount, address }`. `state` is `building` (named by `txninput`, not posted), `posting` (a `txnpost` was sent and
  has not answered) or `posted`.
- `holds`: a coin that is standing collateral. `{ coinid, owner, why, at, tokenid, amount, address }`. Today the
  only source is Dexicon: the coins of its live FAST orders (`ax_kv` `myorders`, status `live`) and its own coins in
  takes sent and not yet answered or still being voided (`pending_takes`, `void_takes`, field `mine`). The desktop
  glue (`main/dexicon.js`) reads these from the engine's store whenever the engine writes them, and at every sweep.

`tokenid`, `amount` and `address` are read from the node when a hold is set (M5, 0.19.100), by `consolidate` itself
for any record still unknown, and by the sweeper. Only a coin the node did not answer for is "unknown", and every
rule treats that as "could be this token". A record with no time, or a time in the future, has its clock started at
the next sweep, so it lapses like any other (L4).

## What is intercepted (every command shape)

| Command | What the registry does |
|---|---|
| `txncreate id:X` | notes that X is this owner's |
| `txninput id:X coinid:C …` | C held by ANOTHER owner (a `txns` entry or a hold): refused before the node sees it, `{ status:false, pending:false, error:"Coin C is held for …. Nothing was signed." }`. Otherwise C is recorded `building` for X, written to disk, then forwarded. A `status:false` answer from the node removes the record |
| `txnpost id:X …` | X's coins become `posting` (on disk) before it is sent. Answer `status:true` or `pending`: `posted`. Answer `status:false` and not pending: released. No answer (timeout, dropped connection): stays `posting`, which is treated as posted |
| `txndelete id:X` | X not posted: its coins are released. X posted: kept (see release) |
| `send …` without `fromaddress:` | when another owner holds anything: pinned with `fromaddress:` to an address none of whose coins is held by another owner and whose coins cover the amount (MINIMA and tokens). No such address: refused, "not enough free funds: N is held for …". When nobody else holds anything the command is forwarded exactly as before |
| `send … fromaddress:A` | refused when a coin at A is held by another owner (the node would be free to pick it) |
| `consolidate tokenid:T` | refused while another owner holds a coin of T (or of unknown token), naming what holds it: core's `consolidate` picks its own coins (the largest, by address) and has no way to leave one out. `dryrun:true` passes |
| `coins relevant:true … tokenid:T` (no `coinid:`, no `address:`) asked by an engine | the coins held by ANOTHER owner are left out of the answer, so each engine chooses its inputs among coins it can really use. The wallet's own reads are not filtered: the Wallet shows every coin and marks the held ones |
| a `;` chain | the same checks on each part; a chain that holds a `send` or `consolidate` is refused while another owner holds anything (run it as one command) |

Everything else passes untouched. `txnimport` is not read (see limits).

How a command is read (0.19.100), as the node reads it (`CommandRunner`):
- The verb in any case (`SEND` is `send`: the node lower-cases it). `main/sendpin.js` and `main.js` test it the same way.
- Parameters are split on white space with a `{…}`, `[…]` or `"…"` value kept whole, so `amount:` inside a state JSON is
  not a parameter; a value's own quotes are dropped (`coinid:"0x…"` is that coin).
- A parameter NAME given twice is refused (`txninput`, `txnpost id:`, and `send` / `consolidate` when enforced): the
  node keeps the last value, a reader of the text finds the first.
- A `;` ends a command for the node WHEREVER it stands, inside a JSON value too (`runMultiCommand` is a tokenizer on
  `;`). The guard splits exactly there. The review asked for a `;` inside a state JSON not to count as a chain (L5):
  NOT done, on purpose. The node would still run what follows the `;` as a command of its own, so a `txninput`
  written inside a JSON value would be executed and never checked.

Shapes still NOT guarded (each needs its own design; none is used by the app's engines for a wallet coin today):
- `txnimport` of a whole transaction, then `txnpost`: the inputs are not read.
- `send` / `txnpost` with `burn:`, `sendpoll`, `multisig`, `tokencreate`, `sendfrom`, `sendnosign` / `sendview` /
  `sendpost`: the node picks coins itself (or the key is not this wallet's).
- `txnaddamount` (the node adds inputs of its choice to a transaction), `txnauto`, `txnmine`, `txnminepost`.
- `consolidate` and `send` while the setting is `observe` or `off`.
- A node parameter name in another letter case than the guard expects is read here but is a different (unknown)
  parameter to the node, which rejects the command: refused twice rather than passed.
- Anything sent to the node from outside this app (a phone, a MiniDapp, the node's own terminal).

Why a refused `txninput` ends cleanly: each builder runs its steps one node command at a time and deletes the
transaction on the first `status:false`: AtomiX `runSeq` then `deleteTxn` (`main/atomix/lib/htlc.js`, lock, claim,
refund), PandaPools `runChain` (`poolmgr.js:153`) and `runCmds` then `giveUp` (`service.js`), Dexicon RESTING
`T.run` / `T.checkPost` (`resting/txn.js`), FAST relock (`lib/maker.js`), split (`lib/ladder.js`) and take
(`lib/fill.js` `finish`), P2P Chance (`casino/engine.js`, `casino/service.js`), Vestr collect. The `txndelete` that
follows releases the transaction's other coins here.

## Release, always

1. `txndelete` of a transaction that was never posted; a `status:false` answer to its `txninput`.
2. A definite rejection of a transaction's FIRST `txnpost`: `status:false` and not `pending`. A retried post that is
   rejected releases nothing (L2): the first may be in the mempool, and "already there" is such a rejection.
3. Spent: the sweeper asks the node for each reserved coin (`coins coinid:C`, one coin per read, at most 25 reads a
   sweep, round robin, so a fragmented wallet is never listed). A coin the node does not show in TWO sweeps running,
   with a chain tip each time, is spent: released (M4; one miss, or a miss with no tip, decides nothing). A coin
   called gone that its source still lists is asked for again each sweep and, shown again, is held again.
   This is also how a coin spent by a phone or a MiniDapp on the same node leaves the registry.
4. Known dead. `txnpost` answering ok is asynchronous mining, not confirmation, so a posted coin stays reserved. It
   is released as dead only when ALL hold: at least 12 blocks and 10 minutes since the post, the coin is still
   unspent, and `coins coinid:C checkmempool:true` shows it (nothing in the mempool spends it). 12 blocks is past
   any normal mining delay; a transaction absent from the mempool that long is not coming back by itself.
5. An abandoned build: `building` for 15 minutes with no post and no delete.
6. Engine stop: that owner's `building` coins (the builds died with the engine; wired for Dexicon, and since
   0.19.100 for AtomiX and PandaPools when they are held or their wallet is replaced). Its posted coins and its holds stay:
   they still back something on the chain or on the relays.
7. Wallet replaced or reset: everything; the store is moved aside under a dated name, never deleted.
8. A hold ends when its source no longer lists the coin (order cancelled, filled; take answered or voided), at the
   order's own expiry (`until`, so an order lapses here even with no engine running), by 3, or when its source has
   not listed it for 24 hours (an engine that never comes back cannot hold a coin for good). While the engine is
   merely stopped its holds stay: the order is still on the relays, and the source answers "cannot say", not "none".

## Settlement wins

A reservation must never stop a time-critical settlement.

- AtomiX claim and refund spend ONE input, the HTLC coin itself, with no fee or change input
  (`main/atomix/lib/htlc.js` `claim`, `refund`). P2P Chance reveals and collects spend the bet coin itself.
- The registry only ever refuses a PLAIN wallet coin. Before a refusal it asks the node once
  (`coins coinid:C sendable:true`): a coin that is not at one of this wallet's simple addresses (an HTLC coin, a pool
  reserve, a bet) is never refused, whoever named it first. So a counterparty that names my HTLC coin as an order's
  backing cannot make my own Dexicon take block my claim.
- If that read fails (no answer, or the node does not say), EVERY engine's input is let through and the log says so
  (0.19.100, M1: a pool operation or a Dexicon settlement must not fail on an unanswered read). Only `wallet`, whose
  commands a person can repeat, is refused.
- If a settlement transaction (one of `atomix` or `casino` that already carries a contract coin) names a plain coin
  that is only a hold, the hold is dropped and the input goes through: the collateral's owner finds the coin gone by
  its normal path (Dexicon's refresh re-backs or withdraws the order; a take arriving meanwhile is refused at its
  pre-sign check).
- When every free coin is held, nothing waits: each command fails at once with the reason.

## Persistence

`userData/coin-reservations-pk-<wallet id>.json` (mode 0600), written (temp file, fsync, rename) before the reserving
command is forwarded. The wallet id is the SHA-256 of the wallet's FIRST public key, the key with modifier `0x00`
(`keys modifier:0x00`, else the row of `keys`): public data, the same for a wallet in a key mode however often it is
restored, and readable on a locked node. Nothing is derived from the seed for it (up to 0.19.0 it was
`seedrandom modifier:coin-reservation-v1`; that command is no longer sent). One-time rename: a folder with no file of
the new name and exactly ONE `coin-reservations-0x….json` has it renamed; with several, none is taken (the old name
cannot be recomputed without the seed read). The file is opened when the node is running and closed when it stops.
If the id cannot be read the registry works in memory, says so once in the log and tries again every minute. A watched
command waits at most 3 s for an open in progress (M2), then goes on with what memory holds; the late open merges. A coin its owner has already posted keeps that record when the same owner names it for a second transaction.

## Visibility

The Wallet tab (`renderer/app.js`, fed by `mcd:reserved`: `reserve.list()` and `reserve.funds("wallet")`): the
headline, each token row, the token page and the Send screen show the node's sendable LESS what the engines hold,
with a line "held N for …"; the coins dialog marks a held coin with a HELD chip and what holds it in words, and the
coin's detail says "Held for"; Send refuses an amount above the free funds with the reason before its review. The
held figure is the one a send would meet: a coin at an address with a held coin counts as held.

The three Dexicon rooms keep their engines' own figures and are not redrawn. What stops them claiming the same
coins: each engine's own coin reads leave out what the others hold (so FAST backing, an AtomiX lock from coins, a
pool's funding and the AtomiX coin list in room ① are chosen from coins that engine can use), and anything else is
refused before signing with the reason. NOT reconciled: a room's balance line taken from the node's `balance`
(rooms ① and ②, and "free for a new order" in ③) still counts coins another engine holds; the action then fails
with the reason instead of the figure being lower. Doing better needs a held line in the room screens.

## Limits

- This app only. A phone or MiniDapp on the same node can spend a reserved coin; the sweeper then repairs the registry.
- `send` can only be pinned to an ADDRESS. Free coins that share an address with a held coin cannot be sent while it
  is held; the refusal says so.
- `burn:` on a token send, and `txnpost burn:`, make the node pick its own MINIMA coins: not constrained.
- A transaction that arrives whole by `txnimport` is not read; its coins are covered only if they are already held.
- `sendfrom` (the Web Wallet's own key) and coins of other wallets are outside the registry.
- A coin older than the node's proof window that is not this wallet's cannot be asked about and is released as spent.

## H1, the proper fix: DESIGN ONLY (not built)

The finding: `send` can only be pinned to an ADDRESS. When every address that could fund a send also holds a held
coin, the pin fails and an enforced send is refused although free coins exist ("coins at an address with a held coin
count as held"). A wallet whose coins sit at few addresses (the usual case after a consolidate) is then unable to
send while one order is live. That is why sends are only observed today.

The fix is to stop using `send` for that case and build the transaction from explicit free coins:

1. In `sendVerdict`, when the address pin fails and `freeUnits >= need`: choose inputs among the FREE coins of the
   token (`coins relevant:true sendable:true checkmempool:true tokenid:T coinage:3`, less every coin `foreign()`
   names): the smallest single coin that covers, else largest first, at most 10 inputs (above that: refuse and say
   "consolidate first").
2. Build it as the engines do, one command at a time, deleting on the first failure:
   `txncreate id:W` · `txninput id:W coinid:C` per input (through the guard, so each is recorded `building` for
   `wallet` and no engine can take it meanwhile) · `txnoutput id:W amount:A address:TO tokenid:T storestate:…` ·
   change: `txnoutput` to a fresh `getaddress` of this wallet (the node's `send` does the same) · `txnstate` for each
   state port of the original `send state:{…}` · `txnsign id:W publickey:auto` · `txnpost id:W auto:true
   txndelete:true` (with `mine:true` when the send had it).
3. Tokens: outputs are in token units and the node scales them; the input coin must be passed as the node holds it.
   The family rule applies only to OFF-node builders (byte-exact `coinexport`); this is built ON the node by
   `txninput coinid:`, which takes the node's own coin proof.
4. `burn:` is refused in this path (the node picks its own MINIMA for a burn). `multi:[…]` becomes one `txnoutput`
   per pair. `split:` and `debug:` are refused. Anything not recognised: refuse, never guess.
5. Every error path runs `txndelete`; `txnpost` answering `pending` is asynchronous mining, not failure.
6. The reply is reshaped to what `send` answers (`response.txpowid`, `status`, `pending`), because callers read it
   (Mail's receipt, the Wallet's toast, AtomiX's publish retry).
7. Signing passes the one signing queue as a unit: the queue must hold from `txnsign` to `txnpost` so no other
   signer runs in between (today each command is queued alone; a second key use between sign and post is harmless,
   but the queue's "lost signer" handling must see the pair as one).
8. Tests before it is enabled: the model node gains `txnoutput` accounting (inputs = outputs + change), then the
   same test list as `send`: MINIMA, MxUSD, `multi:`, a state send, an insufficient wallet, a node failure at every
   step (each ends in `txndelete` and a released reservation), and byte-identical behaviour when nothing is held.

Until that exists `enforce` keeps the address pin and its refusal, and the default stays `observe`.
