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
  letter case. The app checks this again itself (`main/testprofile.js`).
- A folder that already holds files and has no `TEST_PROFILE` file (so: not created by this script).
- A profile whose `config.json` keeps its node data outside the profile.
- A busy port. The base port and base+1 to +4, +584 and +586 are looked at on every run. Before starting a node the
  app stops "a node left running on our port"; on a port that another node holds, that would be the other node. So a
  busy port is always a refusal, never a retry. 12001 (the real app's default) is refused outright.
- Missing node jars. The script fetches nothing and copies nothing unless `--jars <dir>` is given. It prints the
  copy commands:

```bash
# the shipped jars (classic wallets only)
cp ~/Projects/minima/desktop/minimacore-desktop/resources/minima.jar       resources/minima.jar
cp ~/Projects/minima/desktop/minimacore-desktop/resources/parlons-node.jar resources/parlons-node.jar
# the block-capable jars (19 Nov 2026 build)
cp ~/Projects/minima/_artifacts/parlons-block-2026-11-19/minima-1.1.2.31-euro5.jar resources/minima.jar
cp ~/Projects/minima/_artifacts/parlons-block-2026-11-19/parlons-node-0.2.153.jar  resources/parlons-node.jar
```

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
| Update feed | read every start | not read at start; no update is offered (Settings, "Check for updates" still asks the feed if pressed) |
| Ports | base 12001 by default | base 23001 by default, written to the profile's `config.json` on the first run only |
| Protocol | `dxroom://` is handled inside the process; nothing is registered with the OS | the same: nothing to separate |
| Window | "Minima Core" | title "Minima Core — TEST PROFILE", a red TEST PROFILE tag on every screen, a TEST badge on the Dock icon |

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
