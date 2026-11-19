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
