# Shared coin reservation (Phase 3f)

Four signers share one wallet: AtomiX, PandaPools, the Dexicon engine, and the wallet itself (Send, Split,
Consolidate, Mail, Chat, miniMall, Vestr, the Web Wallet, the terminal) plus P2P Chance in its settle-only form.
The signing queue (`main/noderun.js`) keeps their signatures apart in time. It does not keep their COINS apart: one
engine chooses a coin, another chooses the same coin before the first has posted. This file is the design of the one
registry that does.

Engines are not edited. The only differences an engine can observe are a refusal before signing, and which coins it
is shown or pinned to.

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

`tokenid`, `amount` and `address` are filled in by the sweeper's read of the coin; until then they are unknown and
every rule treats "unknown" as "could be this token".

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

Why a refused `txninput` ends cleanly: each builder runs its steps one node command at a time and deletes the
transaction on the first `status:false`: AtomiX `runSeq` then `deleteTxn` (`main/atomix/lib/htlc.js`, lock, claim,
refund), PandaPools `runChain` (`poolmgr.js:153`) and `runCmds` then `giveUp` (`service.js`), Dexicon RESTING
`T.run` / `T.checkPost` (`resting/txn.js`), FAST relock (`lib/maker.js`), split (`lib/ladder.js`) and take
(`lib/fill.js` `finish`), P2P Chance (`casino/engine.js`, `casino/service.js`), Vestr collect. The `txndelete` that
follows releases the transaction's other coins here.

## Release, always

1. `txndelete` of a transaction that was never posted; a `status:false` answer to its `txninput`.
2. A definite `txnpost` rejection: `status:false` and not `pending`.
3. Spent: the sweeper asks the node for each reserved coin (`coins coinid:C`, one coin per read, at most 25 reads a
   sweep, round robin, so a fragmented wallet is never listed). A coin the node no longer shows is spent: released.
   This is also how a coin spent by a phone or a MiniDapp on the same node leaves the registry.
4. Known dead. `txnpost` answering ok is asynchronous mining, not confirmation, so a posted coin stays reserved. It
   is released as dead only when ALL hold: at least 12 blocks and 10 minutes since the post, the coin is still
   unspent, and `coins coinid:C checkmempool:true` shows it (nothing in the mempool spends it). 12 blocks is past
   any normal mining delay; a transaction absent from the mempool that long is not coming back by itself.
5. An abandoned build: `building` for 15 minutes with no post and no delete.
6. Engine stop: that owner's `building` coins (the builds died with the engine). Its posted coins and its holds stay:
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
- For `atomix` and `casino`, if that read fails the input is let through (today's behaviour) rather than refused.
- If a settlement transaction (one of `atomix` or `casino` that already carries a contract coin) names a plain coin
  that is only a hold, the hold is dropped and the input goes through: the collateral's owner finds the coin gone by
  its normal path (Dexicon's refresh re-backs or withdraws the order; a take arriving meanwhile is refused at its
  pre-sign check).
- When every free coin is held, nothing waits: each command fails at once with the reason.

## Persistence

`userData/coin-reservations-<wallet id>.json`, written (temp file, fsync, rename) before the reserving command is
forwarded. The wallet id is the SHA-256 of `seedrandom modifier:coin-reservation-v1`: one-way, public, and another
wallet opens another file. The file is opened when the node is running and closed when it stops. If the id cannot be
read the registry works in memory, says so once in the log and tries again every minute; it never blocks a command
for that. A coin its owner has already posted keeps that record when the same owner names it for a second transaction.

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
