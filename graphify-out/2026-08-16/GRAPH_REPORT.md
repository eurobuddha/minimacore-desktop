# Graph Report - minimacore-desktop  (2026-08-12)

## Corpus Check
- 99 files · ~262,138 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2228 nodes · 5142 edges · 111 communities (102 shown, 9 thin omitted)
- Extraction: 90% EXTRACTED · 10% INFERRED · 0% AMBIGUOUS · INFERRED: 511 edges (avg confidence: 0.61)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `5eaddee5`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- app.js
- casino.js
- mail.js
- pandapools/service.js
- webwallet.js
- otc.js
- Renderer App Shell (header + tab navigation + views)
- shop.js
- showConfirm
- files
- el
- casinoActivity
- history-db.js
- toast
- atomix.js
- poolmgr.js
- renderSettings
- esc
- p
- responder.js
- casino/engine.js
- settle.js
- swapdb.js
- mail-store.js
- shop-store.js
- elliptic.js
- pandapools.js
- pandapools/decimal.js
- config.js
- main.js
- portmap.js
- vestr.js
- store.js
- peg.js
- maker.js
- mailcrypto.js
- ui.js
- lib/decimal.js
- s
- curve.js
- lib/engine.js
- Rpc
- orderbook.js
- netfetch.js
- ethhtlc.js
- mdsw.js
- rpcCall
- order.js
- boot
- ethTokensLoad
- casino/service.js
- t
- NodeManager
- init
- package.json
- ethSendReview
- hex.js
- Changelog
- identity.js
- build
- ax_sodium.js
- abi.js
- ethtx.js
- d
- history-store.js
- finalise
- mac
- scripts
- dependencies
- ax_eth.js
- swapplan.js
- wallet.js
- pay
- casino-glue-test.js
- withTimeout
- tokenicons.js
- identitywatch.js
- trading.js
- digitsToString
- atomix-s2-gate.js
- "node_modules/tweetnacl/nacl-fast.js"
- parseOther
- history.js
- atomix-boot-gate.js
- boot.js
- flow.js
- getPi
- router.js
- linux
- prng.js
- "node_modules/bn.js/lib/bn.js"
- cosine
- Minima Outline Logo (SVG)
- minimaCore Desktop App
- maxOrMin
- Brand Color Palette (dark #16181c, orange #ff512f, blue #317aff, grey #91919d)
- Minima Tile Icon (SVG)
- signedNet
- preload.js
- atomix-parity-check.sh
- casino-parity-check.sh
- minimaCore Desktop (macOS)
- importBackup
- Desktop Build GitHub Actions Workflow
- mailbackup.js
- User instructions — AUTHORITATIVE. These override default behavior and must be followed exactly.

## God Nodes (most connected - your core abstractions)
1. `el()` - 132 edges
2. `esc()` - 96 edges
3. `toast()` - 76 edges
4. `p()` - 56 edges
5. `files` - 44 edges
6. `el()` - 41 edges
7. `AX()` - 36 edges
8. `s()` - 26 edges
9. `renderSettings()` - 24 edges
10. `render()` - 23 edges

## Surprising Connections (you probably didn't know these)
- `Rule 0: Follow Explicit Instructions / Reuse Before Reinvent` --semantically_similar_to--> `AtomiX Atomic-Swap Module`  [INFERRED] [semantically similar]
  CLAUDE.md → CHANGELOG.md
- `Bundled JRE via jlink` --semantically_similar_to--> `Bundled JRE (no system Java needed)`  [INFERRED] [semantically similar]
  .github/workflows/desktop-build.yml → README.md
- `Per-address WOTS Key-Uses Safety Checker (0.7.1)` --semantically_similar_to--> `Wallet Seed Onboarding (megammrsync restore + key-uses attestation)`  [INFERRED] [semantically similar]
  CHANGELOG.md → README.md
- `Web Wallet (MegaMMR-gated wallet-from-seed)` --semantically_similar_to--> `Wallet Seed Onboarding (megammrsync restore + key-uses attestation)`  [INFERRED] [semantically similar]
  CHANGELOG.md → README.md
- `Renderer App Shell (header + tab navigation + views)` --conceptually_related_to--> `Web Wallet (MegaMMR-gated wallet-from-seed)`  [INFERRED]
  renderer/index.html → CHANGELOG.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Wallet Module Suite (tab-per-module shell)** — renderer_index_shell, changelog_pandapools, changelog_atomix, changelog_eth_wallet, changelog_minimall, changelog_vestr, changelog_minimamail, changelog_web_wallet [INFERRED 0.85]
- **Byte-identical Engine Reuse / 3-way Interop Pattern** — changelog_pandapools, changelog_atomix, changelog_minimall, changelog_vestr, changelog_eth_wallet [EXTRACTED 1.00]
- **Cross-platform Build and Release Pipeline** — github_workflows_desktop_build_workflow, github_workflows_desktop_build_build_matrix, github_workflows_desktop_build_jlink_jre, changelog_cross_platform_builds, readme_bundled_jre [INFERRED 0.85]

## Communities (111 total, 9 thin omitted)

### Community 0 - "app.js"
Cohesion: 0.04
Nodes (80): absCmp(), appendLog(), applyMailUpdate(), axExportCsv(), axLegDone(), axStageRow(), axStages(), axStagesRows() (+72 more)

### Community 1 - "casino.js"
Cohesion: 0.06
Nodes (61): balance(), buildMds(), C(), cancel(), cgame(), claimTimeout(), cmnum(), cnorm() (+53 more)

### Community 2 - "mail.js"
Cohesion: 0.07
Nodes (23): archivedThreads(), autoReplyTimes, backup, config, contacts(), crypto, emitter, EventEmitter (+15 more)

### Community 3 - "pandapools/service.js"
Cohesion: 0.08
Nodes (53): statusDetail(), tok(), derivePools(), done(), finishScan(), fund(), gatherOwned(), gatherRegistry() (+45 more)

### Community 4 - "webwallet.js"
Cohesion: 0.07
Nodes (54): claim(), coinAmount(), deleteTxn(), grain(), loadKeys(), lock(), lockFromCoins(), maybeGrain() (+46 more)

### Community 5 - "otc.js"
Cohesion: 0.11
Nodes (50): accept(), addMsg(), allDeals(), apply(), applyPropose(), approxEq(), changed(), claimExecute() (+42 more)

### Community 6 - "Renderer App Shell (header + tab navigation + views)"
Cohesion: 0.12
Nodes (18): AtomiX Atomic-Swap Module, Clipboard-via-Main-Process Fix (0.15.8), Individual|Combined Pool View Toggle (0.16.2), ETH Wallet Tab, ETH Wallet Fund-Safety Review Fixes (0.16.1), HTLC Preimage Verification Fix (0.11.2), miniMall On-chain Shop Module, minimaMail On-chain Encrypted Messenger (+10 more)

### Community 7 - "shop.js"
Cohesion: 0.06
Nodes (42): advanceStatus(), capSeen(), coinAmount(), coinsAt(), config, crypto, emitter, EventEmitter (+34 more)

### Community 8 - "showConfirm"
Cohesion: 0.08
Nodes (48): applyPpDir(), axExportKey(), axSwitchCurrency(), axWelcome(), confirmPpWithdraw(), doPpCollect(), doPpStatement(), doPpSwap() (+40 more)

### Community 9 - "files"
Cohesion: 0.05
Nodes (43): files, main/**, node_modules/abort-controller/**, node_modules/chrome-dgram/**, node_modules/cross-fetch-ponyfill/**, node_modules/cross-spawn/**, node_modules/data-uri-to-buffer/**, node_modules/debug/** (+35 more)

### Community 10 - "el"
Cohesion: 0.10
Nodes (42): ax6(), axAgo(), axBestLine(), axCleanNum(), axDepthHalf(), axDepthRow(), axDoReview(), axDrawChart() (+34 more)

### Community 11 - "casinoActivity"
Cohesion: 0.10
Nodes (41): casinoActAppend(), casinoActClass(), casinoActivity(), casinoActPaint(), casinoBlock(), casinoCheckCreateConfirm(), casinoCheckTakeConfirm(), casinoCoinIsPayout() (+33 more)

### Community 12 - "history-db.js"
Cohesion: 0.09
Nodes (35): all(), { app }, bI(), clear(), count(), countSync(), dbPath(), ensureReady() (+27 more)

### Community 13 - "toast"
Cohesion: 0.13
Nodes (40): addPeerContact(), axOtcPropose(), compressImage(), confirmDeleteContact(), confirmDeleteThread(), contactMenu(), doArchive(), doMailBackup() (+32 more)

### Community 14 - "atomix.js"
Cohesion: 0.08
Nodes (35): allowedUrl(), buildMds(), { createContext }, emitter, ETH_FEE_MULT, ETH_RPC_FILE(), ETH_SEED_TOKENS, ethPrivateHost() (+27 more)

### Community 15 - "poolmgr.js"
Cohesion: 0.09
Nodes (52): address(), send(), addAnnounceState(), advanceKeyUses(), beginHunt(), buildAndPost(), buildCreate(), buildMigrate() (+44 more)

### Community 16 - "renderSettings"
Cohesion: 0.10
Nodes (44): appendTerm(), applyIcon(), balBreakdown(), balCardHtml(), casinoAgeGate(), cmd(), copy(), decSub() (+36 more)

### Community 17 - "esc"
Cohesion: 0.08
Nodes (36): amt(), axChip(), axCoinDump(), axDealRow(), axEditInput(), axEditRow(), axFld(), axGenField() (+28 more)

### Community 18 - "p"
Cohesion: 0.15
Nodes (35): AX(), balances(), book(), bookScan(), coins(), computeQuote(), ethBalances(), ethWallet() (+27 more)

### Community 19 - "responder.js"
Cohesion: 0.14
Nodes (33): acceptTakerBuyMinima(), acceptTakerSellMinima(), addDec(), addIncoming(), cpBurstFull(), decimalsOf(), doScanIncoming(), ensureAllowance() (+25 more)

### Community 20 - "casino/engine.js"
Cohesion: 0.18
Nodes (31): addMultipleInputs(), cancelBet(), claimTimeout(), coinsAtContract(), createBet(), decAdd(), decCmp(), decSub() (+23 more)

### Community 21 - "settle.js"
Cohesion: 0.17
Nodes (31): activeSwaps(), amountTokenOk(), broadcastEthRefund(), broadcastEthWithdraw(), checkCanSwapCoin(), checkEthContractBody(), checkEthContractFor(), checkExpiredMinima() (+23 more)

### Community 22 - "swapdb.js"
Cohesion: 0.20
Nodes (31): activeHashes(), allSwaps(), deleteSwap(), esc(), executedTrades(), getEvents(), getRequest(), getSecret() (+23 more)

### Community 23 - "mail-store.js"
Cohesion: 0.16
Nodes (28): addContact(), addMessage(), all(), allThreadRows(), { app }, archivedSet(), archivedThreads(), clear() (+20 more)

### Community 24 - "shop-store.js"
Cohesion: 0.15
Nodes (28): addChat(), { app }, chat(), clear(), decAdd(), decCmp(), decGte(), deleteShop() (+20 more)

### Community 25 - "elliptic.js"
Cohesion: 0.06
Nodes (5): "node_modules/elliptic/lib/elliptic/ec/index.js"(), "node_modules/elliptic/lib/elliptic/ec/key.js"(), "node_modules/hash.js/lib/hash/sha/512.js"(), client, priv()

### Community 26 - "pandapools.js"
Cohesion: 0.07
Nodes (40): acceptMid(), { app }, buildMds(), config, createAnchor(), { createContext, ALL_FILES }, currentBlock(), effLevel() (+32 more)

### Community 27 - "pandapools/decimal.js"
Cohesion: 0.08
Nodes (5): hypot(), log(), log10(), log2(), sqrt()

### Community 28 - "config.js"
Cohesion: 0.15
Nodes (25): { app, safeStorage }, configPath(), crypto, DEFAULTS, deleteSecret(), effectiveParams(), encAvailable(), { execFileSync } (+17 more)

### Community 29 - "main.js"
Cohesion: 0.05
Nodes (29): atomix, emitter, { EventEmitter }, getJson(), https, requestFaucet(), { URL }, { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell, Notification, session, clipboard } (+21 more)

### Community 30 - "portmap.js"
Cohesion: 0.15
Nodes (12): defaultRoute(), dgram, EventEmitter, { execFile }, isPrivateIp(), RFC-1918, lanIp(), os (+4 more)

### Community 31 - "vestr.js"
Cohesion: 0.13
Nodes (32): configureEngines(), getBalances(), log(), logOnce(), notifyLog(), poll(), reloadShared(), tryBoot() (+24 more)

### Community 32 - "store.js"
Cohesion: 0.12
Nodes (24): actRecord(), actRecordFailed(), actSetStatus(), confirmed(), create(), ensureHistory(), ensureOwnPools(), esc() (+16 more)

### Community 33 - "peg.js"
Cohesion: 0.15
Nodes (17): ingest(), poll(), price(), reconcileSpent(), ageMs(), applyPeg(), commitMexc(), effectiveLevel() (+9 more)

### Community 34 - "maker.js"
Cohesion: 0.20
Nodes (19): buildOrder(), clampAsks(), currentOrder(), doLoadConfig(), doPublish(), keepAlive(), kvKey(), loadConfig() (+11 more)

### Community 35 - "mailcrypto.js"
Cohesion: 0.15
Nodes (16): boxPkOf(), crypto, deriveIdentity(), deriveIdentityDomain(), hkdf32(), idBytes(), ikmFromSeed(), isValidPublicId() (+8 more)

### Community 36 - "ui.js"
Cohesion: 0.10
Nodes (68): activeSwap(), activityTab(), amtField(), banner(), bidiInput(), bootErrorCard(), ccy(), clean() (+60 more)

### Community 37 - "lib/decimal.js"
Cohesion: 0.25
Nodes (19): bumpFrac(), ceilDp(), divFloor(), floorDp(), formatUnits(), fromScaled(), grain6(), gt0() (+11 more)

### Community 38 - "s"
Cohesion: 0.15
Nodes (14): "node_modules/elliptic/lib/elliptic/ec/signature.js"(), "node_modules/hash.js/lib/hash/ripemd.js"(), "node_modules/js-sha3/src/sha3.js"(), balance(), aggregateInfo(), createPreview(), D(), feed() (+6 more)

### Community 39 - "curve.js"
Cohesion: 0.17
Nodes (17): aggregatePrice(), clampDec(), dec(), decOr(), feeGrowth(), fix(), funded(), grain() (+9 more)

### Community 40 - "lib/engine.js"
Cohesion: 0.25
Nodes (16): baseSwap(), confirmMyLock(), ensureAllowance(), ethChainNow(), executeOtc(), isMyPublishKey(), normKey(), notifyChanged() (+8 more)

### Community 41 - "Rpc"
Cohesion: 0.24
Nodes (5): big(), hexToBig(), host(), Rpc(), snippet()

### Community 42 - "orderbook.js"
Cohesion: 0.22
Nodes (16): aggSide(), bestMakers(), cmp(), compareForFill(), isMine(), levelCap(), mergeFreshest(), nowMs() (+8 more)

### Community 43 - "netfetch.js"
Cohesion: 0.21
Nodes (16): acquire(), dns, fetchJson(), getCapped(), http, https, ipBlocked(), isBlockedHost() (+8 more)

### Community 44 - "ethhtlc.js"
Cohesion: 0.14
Nodes (4): b32(), contractId(), make(), safeBig()

### Community 45 - "mdsw.js"
Cohesion: 0.26
Nodes (13): cmd(), cmdR(), esc(), ethLockAcquire(), ethLockInit(), ethLockRelease(), kvDel(), kvGet() (+5 more)

### Community 46 - "rpcCall"
Cohesion: 0.15
Nodes (14): runner(), { app }, config, EventEmitter, fs, path, portmap, { rpcCall } (+6 more)

### Community 47 - "order.js"
Cohesion: 0.24
Nodes (13): canonicalJson(), effectiveAsks(), effectiveBids(), finite(), fromJson(), hasLiquidity(), level(), make() (+5 more)

### Community 48 - "boot"
Cohesion: 0.10
Nodes (30): applyTheme(), boot(), currentWwMode(), cycleTheme(), initTabScroll(), onAtomixUpdate(), onVestrUpdate(), onWebWalletUpdate() (+22 more)

### Community 49 - "ethTokensLoad"
Cohesion: 0.26
Nodes (14): ETH_TOKENS_FILE(), ethAddToken(), ethCleanSymbol(), ethDecodeSymbol(), ethRemoveToken(), ethTokenBy(), ethTokenMeta(), ethTokens() (+6 more)

### Community 50 - "casino/service.js"
Cohesion: 0.29
Nodes (11): doResolve(), doReveal(), extractResponse(), gameTypeName(), getState(), isMyKey(), miniNum(), pickLbl() (+3 more)

### Community 51 - "t"
Cohesion: 0.13
Nodes (25): t(), copyHistory(), ensureHistActions(), ensureHistFilter(), ewConfirmSend(), exportHistory(), HIST_COLS, HIST_ROWS (+17 more)

### Community 53 - "init"
Cohesion: 0.23
Nodes (15): actionOnPool(), advanceRestoredKeys(), backup(), closePool(), collectToWallet(), createPool(), deposit(), ensureOwnerKey() (+7 more)

### Community 54 - "package.json"
Cohesion: 0.15
Nodes (12): electron, electron-builder, author, description, devDependencies, electron, electron-builder, license (+4 more)

### Community 55 - "ethSendReview"
Cohesion: 0.24
Nodes (12): ensureRpcOverride(), ethAddrChecksumOk(), ethAmbiguousBroadcast(), ethCapGas(), ethGasNow(), ethGasScaledRpc(), ethReserveGp(), ethSendExecute() (+4 more)

### Community 57 - "Changelog"
Cohesion: 0.10
Nodes (20): [0.11.x] — Vestr + AtomiX preimage fix, [0.13.0] — cross-platform builds, [0.15.x] — Web Wallet + AtomiX CSV + clipboard, [0.16.0] – [0.16.1] — ETH Wallet tab, [0.16.11] — PandaPools: stop the runaway owner-key hunt (bounded, remembered, provable), [0.16.12] — SECURITY: bundled node jar carries the Wallet.signData fix; in-app jar updater removed, [0.16.13] — bundled node moves to 1.1.2.4 (upstream super-parent fix), [0.16.2] — PandaPools: Individual | Combined pool view toggle (+12 more)

### Community 58 - "identity.js"
Cohesion: 0.31
Nodes (9): boxPkOf(), canonicalId(), fromSeed(), isValidPublicId(), makeIdentity(), open(), seal(), seedBytes() (+1 more)

### Community 59 - "build"
Cohesion: 0.18
Nodes (11): build, appId, extraResources, nsis, productName, win, allowToChangeInstallationDirectory, oneClick (+3 more)

### Community 60 - "ax_sodium.js"
Cohesion: 0.27
Nodes (6): cat(), hkdfSha256(), hmacSha256(), RFC-5869, seal(), sealOpen()

### Community 61 - "abi.js"
Cohesion: 0.47
Nodes (9): decode(), encAddr(), encBool(), encBytes32(), encodeCall(), encUint(), pad64(), selector() (+1 more)

### Community 62 - "ethtx.js"
Cohesion: 0.33
Nodes (7): acquire(), busyErr(), doSend(), pump(), release(), send(), slot()

### Community 63 - "d"
Cohesion: 0.18
Nodes (23): "node_modules/elliptic/lib/elliptic/curve/base.js"(), "node_modules/elliptic/lib/elliptic/curve/edwards.js"(), "node_modules/elliptic/lib/elliptic/curve/short.js"(), "node_modules/hash.js/lib/hash/sha/1.js"(), "node_modules/hash.js/lib/hash/sha/256.js"(), k(), block(), build() (+15 more)

### Community 64 - "history-store.js"
Cohesion: 0.33
Nodes (9): all(), { app }, clear(), ensureLoaded(), filePath(), fs, merge(), path (+1 more)

### Community 65 - "finalise"
Cohesion: 0.24
Nodes (10): ceil(), checkRoundingDigits(), finalise(), floor(), getLn10(), naturalExponential(), naturalLogarithm(), round() (+2 more)

### Community 66 - "mac"
Cohesion: 0.20
Nodes (10): mac, NSCameraUsageDescription, category, entitlements, entitlementsInherit, extendInfo, hardenedRuntime, icon (+2 more)

### Community 67 - "scripts"
Cohesion: 0.20
Nodes (10): scripts, dist, dist:linux, dist:mac, dist:win, gate:atomix, start, test:atomix (+2 more)

### Community 68 - "dependencies"
Cohesion: 0.22
Nodes (9): libsodium-wrappers, dependencies, libsodium-wrappers, qrcode-generator, @silentbot1/nat-api, sql.js, qrcode-generator, @silentbot1/nat-api (+1 more)

### Community 69 - "ax_eth.js"
Cohesion: 0.47
Nodes (8): addressFromPriv(), intBytes(), keccakBytes(), rlpBytes(), rlpLenPrefix(), rlpList(), signLegacyTx(), toBigHex()

### Community 70 - "swapplan.js"
Cohesion: 0.53
Nodes (8): buildSweepPlan(), ceilUsdt(), computeMinima(), computeUsdt(), legMinima(), num(), pstr(), sweepDepthMinima()

### Community 71 - "wallet.js"
Cohesion: 0.33
Nodes (5): checkSend(), gasReserveWei(), isEthAddr(), maxEthSendWei(), validDec()

### Community 72 - "pay"
Cohesion: 0.30
Nodes (14): currentBlock(), init(), nodeCmd(), pay(), queryCoins(), randomId(), requestPayaddr(), scanOnce() (+6 more)

### Community 73 - "casino-glue-test.js"
Cohesion: 0.22
Nodes (6): casino, cfg, mem, OPEN_BET, path, sent

### Community 74 - "withTimeout"
Cohesion: 0.46
Nodes (8): jvm(), makerAvail(), makerPublish(), makerSave(), makerWithdraw(), switchCurrency(), toVm(), withTimeout()

### Community 75 - "tokenicons.js"
Cohesion: 0.26
Nodes (12): b64encode(), first(), hsl(), identiconDataUri(), meta(), metaField(), pickIconField(), resolveIcon() (+4 more)

### Community 76 - "identitywatch.js"
Cohesion: 0.29
Nodes (6): check(), checkEth(), checkMinima(), halted(), raiseOrClear(), summary()

### Community 78 - "digitsToString"
Cohesion: 0.32
Nodes (8): checkInt32(), convertBase(), digitsToString(), finiteToString(), getZeroString(), nonFiniteToString(), random(), toStringBinary()

### Community 79 - "atomix-s2-gate.js"
Cohesion: 0.29
Nodes (4): { execFile }, fs, os, path

### Community 80 - ""node_modules/tweetnacl/nacl-fast.js""
Cohesion: 0.33
Nodes (3): "node_modules/hmac-drbg/lib/hmac-drbg.js"(), "node_modules/tweetnacl/nacl-fast.js"(), add()

### Community 81 - "parseOther"
Cohesion: 0.33
Nodes (7): clone(), getBase10Exponent(), intPow(), isDecimalInstance(), parseDecimal(), parseOther(), truncate()

### Community 82 - "history.js"
Cohesion: 0.38
Nodes (8): coins(), entryFrom(), finish(), firstAddr(), markDone(), page(), shrink(), sync()

### Community 83 - "atomix-boot-gate.js"
Cohesion: 0.33
Nodes (4): { execFile }, fs, os, path

### Community 84 - "boot.js"
Cohesion: 0.60
Nodes (3): init(), lockedErr(), permErr()

### Community 85 - "flow.js"
Cohesion: 0.70
Nodes (4): each(), map(), once(), waterfall()

### Community 87 - "getPi"
Cohesion: 0.40
Nodes (5): atan(), atan2(), getPi(), isOdd(), toLessThanHalfPi()

### Community 89 - "linux"
Cohesion: 0.40
Nodes (5): linux, category, icon, maintainer, target

### Community 90 - "prng.js"
Cohesion: 0.83
Nodes (3): init(), initBrowser(), initService()

### Community 91 - ""node_modules/bn.js/lib/bn.js""
Cohesion: 0.50
Nodes (4): "node_modules/bn.js/lib/bn.js"(), div(), mod(), pow()

### Community 92 - "cosine"
Cohesion: 0.67
Nodes (4): cosine(), sine(), taylorSeries(), tinyPow()

### Community 93 - "Minima Outline Logo (SVG)"
Cohesion: 0.50
Nodes (4): currentColor Theming (theme-adaptive icon fill), Minima Outline Logo (SVG), Minima Blockchain Brand Identity, MinimaCore Desktop Renderer UI

### Community 95 - "minimaCore Desktop App"
Cohesion: 0.22
Nodes (9): Per-address WOTS Key-Uses Safety Checker (0.7.1), Web Wallet (MegaMMR-gated wallet-from-seed), First-run Node Wizard, minimaCore Desktop App, Node Updater (sha256-verified jar swap), Localhost-only RPC with Keychain-held Password, Wallet Seed Onboarding (megammrsync restore + key-uses attestation), Thin Wrapper Around minima.jar (+1 more)

### Community 96 - "maxOrMin"
Cohesion: 0.67
Nodes (3): max(), maxOrMin(), min()

### Community 97 - "Brand Color Palette (dark #16181c, orange #ff512f, blue #317aff, grey #91919d)"
Cohesion: 1.00
Nodes (3): Brand Color Palette (dark #16181c, orange #ff512f, blue #317aff, grey #91919d), Minima Logo Mark (SVG), Minima Blockchain Brand Identity

### Community 98 - "Minima Tile Icon (SVG)"
Cohesion: 0.67
Nodes (3): Theme-Adaptive Icon via currentColor, Minima Brand Logomark (angular M), Minima Tile Icon (SVG)

### Community 104 - "minimaCore Desktop (macOS)"
Cohesion: 0.29
Nodes (6): Build the .dmg, Design, Develop, minimaCore Desktop (macOS), Notes / TODO, What it does

### Community 105 - "importBackup"
Cohesion: 0.33
Nodes (6): addContact(), importBackup(), looksLikeMinimaAddress(), myIdentity(), scan(), startLoop()

### Community 106 - "Desktop Build GitHub Actions Workflow"
Cohesion: 0.40
Nodes (5): Cross-platform Builds (0.13.0), Cross-platform Build Matrix (mac/win/linux), Bundled JRE via jlink, Desktop Build GitHub Actions Workflow, Bundled JRE (no system Java needed)

### Community 107 - "mailbackup.js"
Cohesion: 0.60
Nodes (4): crypto, decrypt(), deriveKey(), encrypt()

## Knowledge Gaps
- **341 isolated node(s):** `{ EventEmitter }`, `path`, `fs`, `{ rpcCall }`, `{ createContext }` (+336 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `p()` connect `p` to `peg.js`, `casino.js`, `pandapools/service.js`, `s`, `showConfirm`, `withTimeout`, `casinoActivity`, `atomix.js`, `poolmgr.js`, `"node_modules/tweetnacl/nacl-fast.js"`, `ethTokensLoad`, `rpcCall`, `init`, `ethSendReview`, `"node_modules/bn.js/lib/bn.js"`, `vestr.js`, `d`?**
  _High betweenness centrality (0.178) - this node is a cross-community bridge._
- **Why does `Renderer App Shell (header + tab navigation + views)` connect `Renderer App Shell (header + tab navigation + views)` to `app.js`, `tokenicons.js`, `qrcode.js`, `minimaCore Desktop App`?**
  _High betweenness centrality (0.090) - this node is a cross-community bridge._
- **Why does `s()` connect `s` to `app.js`, `otc.js`, `el`, `boot`, `t`, `settle.js`, `init`, `elliptic.js`, `pandapools.js`, `"node_modules/bn.js/lib/bn.js"`, `d`?**
  _High betweenness centrality (0.084) - this node is a cross-community bridge._
- **Are the 27 inferred relationships involving `p()` (e.g. with `ingest()` and `createContext()`) actually correct?**
  _`p()` has 27 INFERRED edges - model-reasoned connections that need verification._
- **What connects `{ EventEmitter }`, `path`, `fs` to the rest of the system?**
  _341 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `app.js` be split into smaller, more focused modules?**
  _Cohesion score 0.03849544519541581 - nodes in this community are weakly interconnected._
- **Should `casino.js` be split into smaller, more focused modules?**
  _Cohesion score 0.06467661691542288 - nodes in this community are weakly interconnected._