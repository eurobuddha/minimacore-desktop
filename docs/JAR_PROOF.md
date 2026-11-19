# Node jar for block-as-key-uses on the desktop — findings, 19 Nov 2026

Owner decision D1: new wallets use block-as-key-uses; existing wallets keep classic keys and are never switched.

## Result

No existing single jar fits. The node that works is Pandamonium's line (minima-core 1.1.2.31-euro4) packaged with the
desktop's H2 2.4.240. That composition was run on the desktop's bundled JRE (26.0.1) on a private solo chain, with
throwaway data, and served both key modes.

## The jars

| jar | sha256 | key modes | notes |
|---|---|---|---|
| `desktop/minimacore-desktop/resources/minima.jar` | `8cb690406b31d68ff218066c4986c67bfbf488d394fe25c879ace62501c42ea9` | classic only | shipped today; branch `security/txn-write-gate-main-2026-11-08` @ `e64600285be` (1.1.2.3 line); has `-mdsbind` |
| `apks/base/app/libs/minima.jar` | `32f29846c07874dc530feda958b9fdbb4c0bbfabaadee463063b54d90ff2fdc9` | classic + block | Pandamonium's; branch `security/txn-write-gate-android-2026-11-07` @ `49d667d6eb4`; bundles no BouncyCastle or H2; lacks `-mdsbind` |
| `core/minima-core/merge-1.1.2.31/jar/minima.jar` | `f4ee348a45052cc657539f86e7cc9af9aa72ed7edf95b7dcc3a099fbdc42b47e` | classic + block | DexiconPro's; no keets |
| `keets-android:jar/minima.jar` (git object) | `6fcd5cf216c588c97500bcfadb7bc7d94a7db35d78926884c84d56b0205ebca9` | classic + block | fat jar with BC + H2 2.4.240; lacks the txn-write-gate and `balance` fixes |
| `desktop/minimacore-desktop/resources/parlons-node.jar` 0.2.152 | `1b3a0dc7921675d54e96a611be5a37194116227c4529e32d8aeb74bb72ec1fd1` | classic only | the DEFAULT node kind; embeds its own Minima on the old line |

## Proven

- Block mode: `-blockaskeyuses -lowram` starts; keys are 128x4, maxuses 268435456; a send signs and key uses follow
  the block number.
- Keets flags are accepted.
- The same seed gives different keys in the two modes (zero overlap). Classic keys equal the shipped desktop jar's.
- A data folder created by the shipped desktop jar opens under the new line in classic mode with the same keys.
- Passing the block flag to an existing classic folder mixes key types permanently. It must never happen.
- H2 2.1.214 cannot open a desktop-created folder ("Unsupported database file version"). H2 2.4.240 is required.
- The current jlinked JRE modules are enough.

## What shipping it needs

1. Build a fat jar from `security/txn-write-gate-android-2026-11-07` @ `49d667d6eb4` with commit `95ef3a6ea32`
   (`NIOHandoff` + `-mdsbind`) cherry-picked, H2 2.4.240, BouncyCastle as today.
2. Rebuild `parlons-node.jar` in the `maxima` repo on the same line, because the Parlons node is the default kind
   and embeds its own Minima. Otherwise block wallets would have to run without the Parlons node.
3. Startup: block mode passes `-blockaskeyuses -lowram`; classic passes neither. Refuse both flags in free-text
   extra parameters.
4. Per install: record the mode once in config when the wallet is created. Existing data with no record is classic
   for good. The Classic switch shows only before a wallet exists. Restore from seed asks which mode first.

## Not proven

- Only a private solo chain with tiny data: no mainnet sync, no MegaMMR, no real desktop data folder.
- Moving existing classic wallets from the 1.1.2.3 line to 1.1.2.31-euro4 needs a soak on real data.
- `-lowram` on desktop beyond boot. Block-key generation is slow (8 keys in about 70 s). A block wallet must reach
  the chain tip before it can sign.
- Desktop modules that assume a key holds 262144 uses were not audited.
- AtomiX's swap identity does not survive a mode switch (already a rule: never switch an existing wallet).

Experiment files: scratchpad `jarproof/` (not kept in the repo).

## Owner decision, 19 Nov 2026: the Parlons node stays the base node

The desktop keeps `parlons-node.jar` as its default node (Minima + Maxima + Keets + the Parlons account and relay in
one). Parlons is not removed. Consequences for block-as-key-uses:

- Block mode for new wallets needs `parlons-node.jar` rebuilt in the `maxima` repo on the 1.1.2.31-euro4 node line.
- `maxima/node/src/main/java/com/eurobuddha/maxima/node/NodeAccountWallet.java` hard-codes a key's capacity as
  262144 uses (classic, 64 leaves x 3 levels). That must follow the node's real key shape in block mode.
- On the desktop the Parlons account's wallet IS the node's wallet (`NodeWallet.java`: "one seed, one signer"); it
  has no separate key set. (The Parlons phone and cloud apps are different: they carry their own wallet and counter.)
- The app must verify over RPC, after start, that the running node is in the recorded key mode, and stop if not: a
  flag name inside the jar does not prove the Parlons wrapper passes it through.

## Built, 19 Nov 2026: block-capable Parlons node (local, not released)

Kept in `/Users/eurobuddha/Projects/minima/_artifacts/parlons-block-2026-11-19/` with `BUILD.md`:
- `parlons-node-0.2.153.jar` sha256 `c2b8cb33b07b78197cc4ed0b5c82cf3f14b6407095f20963971d6b932b25e6af`
- `minima-1.1.2.31-euro5.jar` sha256 `93111abb83f2239970257e692026b6033f3b1caeaf31db52604b9f531a0617ea`

Source, local branches `block-mode-2026-11-19`: core `core/minima-core` @ `48cd9b7d397` (worktree
`_worktrees/minima-core-block-mode`), maxima @ `55a92f2c` (worktree `_worktrees/maxima-block-mode`).

Proven on the desktop JRE on private chains: classic start (64x3, 262144), block start (128x4, 268435456, key uses
follow the block), a folder created by 0.2.152 opens under 0.2.153 classic with identical keys, addresses, coins and
Parlons identity, and the same phrase gives no keys in common between modes. The Parlons identity is the same in
both modes. Maxima tests: 605 pass.

To tell the modes apart after start: `keys`, every row's `size` / `depth` / `maxuses`
(classic 64 / 3 / 262144; block 128 / 4 / 268435456).

This node line has NO MiniDapp System. Minima Core Desktop never enables MDS, so it is unaffected; the jar must not
go to the relay fleet or any host that uses MDS inside the Parlons node.

Not proven: mainnet sync, MegaMMR, the relay cape, Keets live, a real desktop data folder, Windows and Linux.
