# Running a TEST copy from source

`scripts/dev-run.sh` starts this app from the source tree as a TEST copy that cannot touch the real install or its
node. Use it for hands-on testing of a branch. It never starts the installed app.

```bash
scripts/dev-run.sh                       # profile: ~/Library/Application Support/MinimaCoreDesktop-TEST
scripts/dev-run.sh /path/to/a/folder     # another profile (one folder = one separate copy)
scripts/dev-run.sh --port 24001          # first run only: the base port (default 23001)
scripts/dev-run.sh --jars <dir>          # copy <dir>/minima*.jar and <dir>/parlons-node*.jar into resources/ first
```

## What it refuses

- A profile folder that is the real one (`~/Library/Application Support/minimaCore`), inside it, or around it, in any
  letter case. The app checks this again itself (`main/flavor.js`; the real folder is `<application data>/minimaCore`,
  taken from the application-data folder, never from the app's current data folder). The app is started WITHOUT
  `--user-data-dir` and refuses that switch (0.19.105: with it the app's own check compared the profile with itself
  and always refused).
- A folder that already holds files and has no `TEST_PROFILE` file (so: not created by this script).
- A profile whose `config.json` keeps its node data outside the profile.
- A busy port. The base port and base+1 to +5, +584 and +586 are looked at on every run, and the app looks again
  itself before it starts its node: a port held by anything that is not this profile's own earlier node is reported
  and never touched (0.19.105). 12001 (the real app's default) and 17001 (Pandamonium Desktop's) are refused outright.
- Missing node jars. The script fetches nothing and copies nothing unless `--jars <dir>` is given. It prints the
  copy commands:

```bash
# the jars package.json pins (classic wallets only): minima 1.1.2.3-euro8, parlons-node 0.2.162 (parlonsNode / parlonsNodeSha256)
cp ~/Projects/minima/_artifacts/node-cmdinject-2026-11-21/minima-1.1.2.3-euro8.jar    resources/minima.jar
cp ~/Projects/minima/_artifacts/node-cmdinject-2026-11-21/parlons-node-0.2.162.jar    resources/parlons-node.jar
# the block-capable jars the pandamonium flavour pins (flavors.pandamonium.jars): minima 1.1.2.31-euro14, parlons-node 0.2.160
cp ~/Projects/minima/_artifacts/node-cmdinject-2026-11-21/minima-1.1.2.31-euro14-block.jar resources/minima.jar
cp ~/Projects/minima/_artifacts/node-cmdinject-2026-11-21/parlons-node-0.2.160-block.jar   resources/parlons-node.jar
```

  sha256: minima-1.1.2.3-euro8 `fc63eb672374e7ceb7cfba17d0e098e3c2991c9a0ef124b0a14fae111c088ef9`, parlons-node-0.2.162
  `65ee56a6ffb302ea0ffcb0d81c1af6ce3f64f0abd662f7885346863d80eb34c1`, minima-1.1.2.31-euro14-block
  `e9399cce238971138d5efe7aa2fba93bfc601bce9e536fcf7477c3c2970e72e0`, parlons-node-0.2.160-block
  `e40ad7bc812285ba49a93715df6a9e855dcc7bfd3df9c450bee58b8b89558a39` (the folder's `SHA256SUMS`).

  `resources/minima.jar` is a tracked file: after copying another jar over it, git shows it modified. Do not commit
  it; `git checkout resources/minima.jar` puts the shipped one back. `resources/parlons-node.jar` is ignored by git.
- No Java: `resources/jre` is used when present, else `java` from PATH.

Before starting it prints the profile folder, the ports, the Java it will use and the sha256 of each jar.

## What is separate from the real install

| Thing | Real install | TEST copy |
|---|---|---|
| userData (config, node data, wallet, `atomix.sqlite`, `pandapools.sqlite`, `dexicon/`, mail, chat, history, logs, node pidfile) | `~/Library/Application Support/minimaCore` | the profile folder |
| Login keychain service (RPC secret, secret start-up parameters, mail identity, shop identity, P2P Chance preimages) | `com.eurobuddha.minimacore.rpc` | `com.eurobuddha.minimacore.rpc.test.<sha256 of the profile folder>` |
| Electron safeStorage key (encrypts the secret files when the keychain write fails) | `minimaCore Safe Storage` | `minimaCore TEST Safe Storage` (the app name is `minimaCore TEST`) |
| Single-instance lock | in userData | in the profile folder (so both copies can run at once) |
| Open at login | registered by the packaged app | never registered |
| Update feed | read every start | never read: not at start, not from Settings; nothing is downloaded (`main/updater.js` `OFF`) |
| Ports | base 12001 by default | base 23001 by default, written to the profile's `config.json` on the first run only |
| Protocol | `dxroom://` is handled inside the process; nothing is registered with the OS | the same: nothing to separate |
| Window | "Minima Core" | title "Minima Core (TEST PROFILE)", a red TEST PROFILE tag on every screen, a TEST badge on the Dock icon |

Not separate, by nature: the network. A TEST copy's node is a real node on the chosen network with its own new
wallet. "Contribute to the network" would ask the router for a port mapping for the TEST port. A wallet restored
into a TEST copy from a real seed IS that real wallet on a second node: do not do that with a wallet that is in use.

Not proven by a run (the app was not started while this was built): that Electron names the Safe Storage key after
`app.setName`. Check once in Keychain Access after the first start: there must be a `minimaCore TEST Safe Storage`
entry and the `minimaCore Safe Storage` entry must be untouched.

## Scripts that can reach a node

No script in `scripts/` names a node. `atomix-unit.js` is hermetic (mock node, and it fails if anything leaves the
process). The live gates (`atomix-boot-gate.js`, `atomix-s2-gate.js`) and `cdp-eval.js` run only when the caller
names a node and says it is theirs; see the head of `scripts/test-node.cjs`. `scripts/hermetic-test.cjs` proves it.

### The live variant of the engine checks (owner's test node)

The owner's TEST node is the docker container `minimaarchive` (host ports 13001 to 13003; its RPC answers only inside
the container, at `127.0.0.1:9005`; upstream Minima 1.0.47.16). The name is written here and nowhere in code: a
script uses it only when the caller gives it.

```bash
AX_TEST_NODE_CONTAINER=minimaarchive AX_TEST_NODE_RPC=http://127.0.0.1:9005 AX_TEST_NODE_I_OWN_THIS=yes node scripts/atomix-unit.js
AX_TEST_NODE_CONTAINER=minimaarchive AX_TEST_NODE_RPC=http://127.0.0.1:9005 AX_TEST_NODE_I_OWN_THIS=yes npm run gate:atomix
```

The balance check (0.19.103): before its first command a live script sends `balance`. A node with nothing on it
passes. A node with ANY non-zero balance is refused, unless a second variable, `AX_TEST_NODE_ADDRESS`, carries one of
THAT node's own addresses and the node confirms it (`checkaddress`, `simple: true`). So a wrong container name or port
can never pass: the wrong node is either empty or does not own the address. For a funded test node:

```bash
AX_TEST_NODE_CONTAINER=minimaarchive AX_TEST_NODE_RPC=http://127.0.0.1:9005 AX_TEST_NODE_I_OWN_THIS=yes \
  AX_TEST_NODE_ADDRESS=<an address of that node, whole: `getaddress` on it> npm run gate:atomix
```

A refusal ends the script with exit code 2 and "Nothing else was sent": only `balance` (and `checkaddress`) left.

WARNING: these checks read that node's seed phrase and its Ethereum key into the test process (`vault action:seed`,
`seedrandom modifier:ethbridge`) and register the AtomiX swap scripts on it (`newscript`). The script prints this
before it sends anything. Run them only against a node whose funds you can afford to lose. Never name the custody
wallet's container: no script may reach it.

`minimaarchive` is an upstream stock node. It is useful as the funding source and as the counterparty for the TEST
profile's own wallet (send from it to an address of the TEST copy; trade against it). It is not the app's node: the
TEST copy runs its own node from `resources/`.

## Another app from this tree: Pandamonium Desktop (0.19.105)

`main/flavor.js` builds more than one app from this source. The flavour is chosen at BUILD time (`"flavor"` in the
packaged `package.json`, written by `scripts/build-flavor.cjs`); nothing at run time turns one app into the other.
The source tree itself names no flavour, so `npm run dist:mac:signed` is the released app, unchanged.

| Kept by identity | Released app | Pandamonium Desktop |
|---|---|---|
| Name (menu bar, About, window title, tray, `~/Library/Logs/<name>`) | `minimaCore` (window "Minima Core") | `Pandamonium Desktop` |
| Bundle id (preferences, saved state, notifications, login item) | `com.eurobuddha.minimacore` | `com.eurobuddha.pandamonium.desktop` |
| Data folder (config, node data, wallet, every store, `node.pid`, `node.log`, the single-instance lock, crash dumps) | `~/Library/Application Support/minimaCore` | `~/Library/Application Support/PandamoniumDesktop` |
| Login keychain service (RPC secret, secret start-up parameters, mail and shop identities, P2P Chance preimages) | `com.eurobuddha.minimacore.rpc` | `com.eurobuddha.pandamonium.desktop.rpc` |
| Electron safeStorage keychain item | `minimaCore Safe Storage` | `Pandamonium Desktop Safe Storage` |
| Update feed | `https://eurobuddha.com/pandaapps/minimacore-desktop.json` | none: never read, nothing downloaded |
| Open at login | the user's choice | never registered |
| Linux autostart file (not used: never registered) | `minimacore.desktop` | `pandamonium-desktop.desktop` |
| Router port-mapping label | `minimaCore Minima node` | `Pandamonium Desktop Minima node` |
| Artifacts | `minimaCore-<version>-arm64.dmg` | `PandamoniumDesktop-<version>-arm64.dmg` |
| Node jars | `parlons-node` 0.2.162, the shipped `minima.jar` 1.1.2.3-euro8 (classic keys only) | `parlons-node` 0.2.160, `minima` 1.1.2.31-euro14 (block and classic keys), pinned in `package.json` `flavors.pandamonium.jars` |

Ports, all from the base port (`node-manager.ports()`):

| Port | Released app | Pandamonium Desktop |
|---|---|---|
| base: the node's P2P port (the Maxima relay shares it when contributing) | 12001 | 17001 |
| base + 4: the node's RPC | 12005 | 17005 |
| base + 5: the keets sidecar's loopback API | 12006 | 17006 |
| base + 584: the Parlons wallet gateway | 12585 | 17585 |
| base + 586: the Parlons panel | 12587 | 17587 |
| base + 1 to base + 3: Minima's by convention (MiniDapp System); not bound, this node line has none | 12002 to 12004 | 17002 to 17004 |

Not keyed to the app, and the same in both: the `dxroom://` scheme (inside the process; nothing is registered with the
OS), the User-Agent `minimaCore-Desktop` on outgoing requests, the marker file `minimacore-keymode.txt` inside a block
wallet's own data folder, the keets DHT port (chosen by the system).

Before the node starts, every port above must be free. A port held by another program is named with what holds it
and the node is not started. The only process this app ever stops is its own node from an earlier launch: the pid in
ITS OWN `node.pid`, and only while that pid's command line names ITS OWN data folder.

Build (macOS arm64, signed with the Developer ID certificate in the login keychain, NOT notarized, nothing downloaded):

```bash
cp -R ../minimacore-desktop/resources/jre resources/jre                                      # once: the JRE (not in git)
cp -R ../minimacore-desktop/resources/keets-sidecar/node_modules resources/keets-sidecar/    # once: the sidecar's modules
cp ~/Projects/minima/_artifacts/node-cmdinject-2026-11-21/minima-1.1.2.31-euro14-block.jar resources-pandamonium/minima.jar       # once: the flavour's pinned jars
cp ~/Projects/minima/_artifacts/node-cmdinject-2026-11-21/parlons-node-0.2.160-block.jar   resources-pandamonium/parlons-node.jar
node scripts/build-flavor.cjs pandamonium
```

(The 21 Nov folder holds more than one `minima*.jar`, so `--jars` on it refuses; a folder with only the two jars works.)

`--jars <dir>` copies the two jars into `resources-pandamonium/` (not in git); the build refuses a jar whose sha256 is
not the one pinned for the flavour. `--stage-only` stops after that check; `--adhoc` signs without a certificate.
