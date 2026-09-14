# Graph Report - minimacore-desktop  (2026-09-09)

## Corpus Check
- 126 files · ~302,017 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2425 nodes · 5523 edges · 126 communities (109 shown, 17 thin omitted)
- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS · INFERRED: 515 edges (avg confidence: 0.61)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `e6d1573d`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- app.js
- poolmgr.js
- ui.js
- casino.js
- mail.js
- otc.js
- shop.js
- pandapools/service.js
- renderAxSwap
- Packaging File Globs
- renderCasino
- history-db.js
- atomix.js
- copy
- el
- p
- responder.js
- store.js
- settle.js
- casino/engine.js
- swapdb.js
- htlc.js
- esc
- mailcrypto.js
- pandapools/decimal.js
- mdsw.js
- config.js
- mail-store.js
- shop-store.js
- showConfirm
- vestrDoCreate
- elliptic.js
- ax_sodium.js
- toast
- main.js
- portmap.js
- pandapools.js
- NodeManager
- peg.js
- Tab Navigation (data-view tab bar)
- maker.js
- webwallet.js
- curve.js
- lib/decimal.js
- lib/engine.js
- Rpc
- orderbook.js
- d
- k
- s
- netfetch.js
- atomix/service.js
- order.js
- casino/service.js
- build
- init
- ethSendReview
- ethwallet.js
- tokenicons.js
- linux
- ethTokensLoad
- hex.js
- minimaCore Desktop App
- identity.js
- identitywatch.js
- ethwallet-unit.js
- cdp-eval.js
- scripts
- form
- abi.js
- ethtx.js
- history-store.js
- finalise
- activity-chain.js
- mac
- ax_eth.js
- swapplan.js
- wallet.js
- vestr.js
- casino-glue-test.js
- faucet.js
- termcomplete-test.js
- digitsToString
- fetch-parlons-node-jar.sh
- trading.js
- parseOther
- notarize-dmg.sh
- atomix-s2-gate.js
- Terminal IDE-style Parameter Autocomplete
- parlons.js
- pandapools/loader.js
- Minima Blockchain Brand Identity
- atomix-boot-gate.js
- boot.js
- flow.js
- publish-desktop.sh
- publish-desktop-platforms.sh
- release-desktop.sh
- getPi
- router.js
- verify-mac.sh
- inspect.js
- prng.js
- "node_modules/bn.js/lib/bn.js"
- cosine
- pandapools-parity-check.cjs
- nodeCmd
- log
- App Shell (header, tabs, views)
- Minima Tile Icon (SVG)
- install.sh
- pre-commit
- preload.js
- atomix-parity-check.sh
- casino-parity-check.sh
- minimaCore Desktop 0.16.39 activity parity review
- Keccak
- createAnchor
- withTimeout
- parlons-view-test.cjs

## God Nodes (most connected - your core abstractions)
1. `el()` - 138 edges
2. `esc()` - 101 edges
3. `toast()` - 77 edges
4. `p()` - 57 edges
5. `files` - 44 edges
6. `el()` - 41 edges
7. `AX()` - 36 edges
8. `NodeManager` - 26 edges
9. `renderSettings()` - 24 edges
10. `render()` - 24 edges

## Surprising Connections (you probably didn't know these)
- `fixture()` --indirect_call--> `el()`  [INFERRED]
  scripts/parlons-view-test.cjs → renderer/app.js
- `withServer()` --indirect_call--> `resolve()`  [INFERRED]
  scripts/rpc-test.cjs → main/casino.js
- `Bundled JRE via jlink` --semantically_similar_to--> `Bundled JRE (no system Java needed)`  [INFERRED] [semantically similar]
  .github/workflows/desktop-build.yml → README.md
- `RULE 0 — Explicit Instructions Are Blocking` --semantically_similar_to--> `Byte-Identical MDS Engine Reuse Rule`  [INFERRED] [semantically similar]
  CLAUDE.md → CHANGELOG.md
- `createBet()` --indirect_call--> `cmd()`  [INFERRED]
  main/casino/engine.js → renderer/app.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Winternitz Key-Reuse Defense Layers** — changelog_winternitz_key_reuse, changelog_wallet_signdata_fix, changelog_serial_signing_gate, changelog_opkuses_backup_restore, changelog_owner_key_hunt_ledger [EXTRACTED 1.00]
- **Shared-Covenant Balance Pollution Fix (trackall:false + hygiene sweep)** — changelog_trackall_pollution_trap, changelog_launch_hygiene_sweep, changelog_pandapools_module, changelog_casino_module [EXTRACTED 1.00]
- **Terminal Autocomplete Stack (registry engine + dropdown UI)** — changelog_terminal_autocomplete, renderer_index_terminal_view, renderer_index_autocomplete_dropdown [INFERRED 0.95]
- **Cross-platform Build and Release Pipeline** — github_workflows_desktop_build_workflow, github_workflows_desktop_build_build_matrix, github_workflows_desktop_build_jlink_jre, readme_bundled_jre [INFERRED 0.85]

## Communities (126 total, 17 thin omitted)

### Community 0 - "app.js"
Cohesion: 0.04
Nodes (77): RFC-1918, absCmp(), appendLog(), applyMailUpdate(), axStatusCache, BAL_BY_TID, CASINO_PIP, CASINO_PRESETS (+69 more)

### Community 1 - "poolmgr.js"
Cohesion: 0.05
Nodes (81): address(), send(), derivePools(), done(), finishScan(), fund(), gatherOwned(), gatherRegistry() (+73 more)

### Community 2 - "ui.js"
Cohesion: 0.10
Nodes (68): activeSwap(), activityTab(), amtField(), banner(), bidiInput(), bootErrorCard(), ccy(), clean() (+60 more)

### Community 3 - "casino.js"
Cohesion: 0.09
Nodes (48): balance(), buildMds(), C(), cancel(), cgame(), claimTimeout(), cmnum(), cnorm() (+40 more)

### Community 4 - "mail.js"
Cohesion: 0.06
Nodes (48): addContact(), archivedThreads(), autoReplyTimes, backup, config, contacts(), crypto, currentBlock() (+40 more)

### Community 5 - "otc.js"
Cohesion: 0.13
Nodes (45): accept(), addMsg(), allDeals(), apply(), applyPropose(), approxEq(), changed(), claimExecute() (+37 more)

### Community 6 - "shop.js"
Cohesion: 0.07
Nodes (36): advanceStatus(), capSeen(), coinAmount(), coinsAt(), config, crypto, emitter, EventEmitter (+28 more)

### Community 7 - "pandapools/service.js"
Cohesion: 0.11
Nodes (45): annKeySvc(), cleanForeign(), covScript(), decCmp(), decDiv(), decSnap(), decSub(), demoteForeign() (+37 more)

### Community 8 - "renderAxSwap"
Cohesion: 0.08
Nodes (45): ax6(), axAgo(), axBestLine(), axChip(), axCleanNum(), axDealRow(), axDepthHalf(), axDepthRow() (+37 more)

### Community 9 - "Packaging File Globs"
Cohesion: 0.05
Nodes (43): files, main/**, node_modules/abort-controller/**, node_modules/chrome-dgram/**, node_modules/cross-fetch-ponyfill/**, node_modules/cross-spawn/**, node_modules/data-uri-to-buffer/**, node_modules/debug/** (+35 more)

### Community 10 - "renderCasino"
Cohesion: 0.09
Nodes (51): applyCasinoCcyTheme(), casinoActAppend(), casinoActClass(), casinoActivity(), casinoActPaint(), casinoBlock(), casinoCcyLabel(), casinoCcyName() (+43 more)

### Community 11 - "history-db.js"
Cohesion: 0.09
Nodes (35): all(), { app }, bI(), clear(), count(), countSync(), dbPath(), ensureReady() (+27 more)

### Community 12 - "atomix.js"
Cohesion: 0.08
Nodes (34): buildMds(), { createContext }, emitter, ETH_FEE_MULT, ETH_RPC_FILE(), ETH_SEED_TOKENS, ethPrivateHost(), ethRpcLoad() (+26 more)

### Community 13 - "copy"
Cohesion: 0.09
Nodes (40): applyIcon(), balBreakdown(), balCardHtml(), cmd(), copy(), copyHistory(), decSub(), enhanceTokenIcons() (+32 more)

### Community 14 - "el"
Cohesion: 0.08
Nodes (59): appendTerm(), applyTheme(), boot(), casinoAgeGate(), currentWwMode(), cycleTheme(), drawQR(), el() (+51 more)

### Community 15 - "p"
Cohesion: 0.15
Nodes (35): AX(), balances(), book(), bookScan(), coins(), computeQuote(), ethBalances(), ethWallet() (+27 more)

### Community 16 - "responder.js"
Cohesion: 0.14
Nodes (33): acceptTakerBuyMinima(), acceptTakerSellMinima(), addDec(), addIncoming(), cpBurstFull(), decimalsOf(), doScanIncoming(), ensureAllowance() (+25 more)

### Community 17 - "store.js"
Cohesion: 0.12
Nodes (22): actRecord(), actRecordFailed(), actSetStatus(), confirmed(), create(), ensureHistory(), ensureOwnPools(), esc() (+14 more)

### Community 18 - "settle.js"
Cohesion: 0.17
Nodes (33): activeSwaps(), amountTokenOk(), broadcastEthRefund(), broadcastEthWithdraw(), checkCanSwapCoin(), checkEthContractBody(), checkEthContractFor(), checkExpiredMinima() (+25 more)

### Community 19 - "casino/engine.js"
Cohesion: 0.18
Nodes (33): addMultipleInputs(), cancelBet(), claimTimeout(), coinAmount(), coinsAtContract(), coinTok(), createBet(), decAdd() (+25 more)

### Community 20 - "swapdb.js"
Cohesion: 0.20
Nodes (31): activeHashes(), allSwaps(), deleteSwap(), esc(), executedTrades(), getEvents(), getRequest(), getSecret() (+23 more)

### Community 21 - "htlc.js"
Cohesion: 0.14
Nodes (32): checkFailure(), claim(), coinAmount(), confirmationDepth(), deleteTxn(), flag(), grain(), guardedCoins() (+24 more)

### Community 22 - "esc"
Cohesion: 0.08
Nodes (40): axCoinDump(), axEditInput(), axEditRow(), axFld(), axGenField(), axGenRow(), axLevelRow(), axMakerEditor() (+32 more)

### Community 23 - "mailcrypto.js"
Cohesion: 0.15
Nodes (16): boxPkOf(), crypto, deriveIdentity(), deriveIdentityDomain(), hkdf32(), idBytes(), ikmFromSeed(), isValidPublicId() (+8 more)

### Community 24 - "pandapools/decimal.js"
Cohesion: 0.07
Nodes (5): hypot(), max(), maxOrMin(), min(), sqrt()

### Community 25 - "mdsw.js"
Cohesion: 0.25
Nodes (13): cmd(), cmdR(), esc(), ethLockAcquire(), ethLockInit(), ethLockRelease(), kvDel(), kvGet() (+5 more)

### Community 26 - "config.js"
Cohesion: 0.07
Nodes (41): { app, safeStorage }, configPath(), crypto, DEFAULTS, deleteSecret(), effectiveParams(), encAvailable(), { execFileSync } (+33 more)

### Community 27 - "mail-store.js"
Cohesion: 0.16
Nodes (28): addContact(), addMessage(), all(), allThreadRows(), { app }, archivedSet(), archivedThreads(), clear() (+20 more)

### Community 28 - "shop-store.js"
Cohesion: 0.15
Nodes (28): addChat(), { app }, chat(), clear(), decAdd(), decCmp(), decGte(), deleteShop() (+20 more)

### Community 29 - "showConfirm"
Cohesion: 0.09
Nodes (41): applyPpDir(), axExportKey(), axWelcome(), confirmPpWithdraw(), doPpCollect(), doPpStatement(), doPpSwap(), onPandapoolsUpdate() (+33 more)

### Community 30 - "vestrDoCreate"
Cohesion: 0.36
Nodes (10): onVestrUpdate(), renderVestrCalc(), renderVestrCreate(), renderVestrList(), renderVestrSub(), vestrDoCollect(), vestrDoCreate(), vFmt() (+2 more)

### Community 31 - "elliptic.js"
Cohesion: 0.07
Nodes (3): "node_modules/hash.js/lib/hash/sha/256.js"(), "node_modules/hash.js/lib/hash/sha/512.js"(), "node_modules/hmac-drbg/lib/hmac-drbg.js"()

### Community 32 - "ax_sodium.js"
Cohesion: 0.27
Nodes (6): cat(), hkdfSha256(), hmacSha256(), RFC-5869, seal(), sealOpen()

### Community 33 - "toast"
Cohesion: 0.13
Nodes (39): addPeerContact(), axOtcPropose(), compressImage(), confirmDeleteContact(), confirmDeleteThread(), contactMenu(), doArchive(), doMailBackup() (+31 more)

### Community 34 - "main.js"
Cohesion: 0.07
Nodes (23): { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell, Notification, session, clipboard }, atomix, casino, config, createWindow(), ethwallet, faucet, fs (+15 more)

### Community 35 - "portmap.js"
Cohesion: 0.15
Nodes (12): defaultRoute(), dgram, EventEmitter, { execFile }, isPrivateIp(), RFC-1918, lanIp(), os (+4 more)

### Community 36 - "pandapools.js"
Cohesion: 0.10
Nodes (21): activity(), activityLabels(), { app }, config, { createContext, ALL_FILES }, currentBlock(), emitter, EventEmitter (+13 more)

### Community 37 - "NodeManager"
Cohesion: 0.08
Nodes (25): alive(), { app }, commandOf(), config, EventEmitter, fs, killPid(), listeners() (+17 more)

### Community 38 - "peg.js"
Cohesion: 0.15
Nodes (17): ingest(), poll(), price(), reconcileSpent(), ageMs(), applyPeg(), commitMexc(), effectiveLevel() (+9 more)

### Community 39 - "Tab Navigation (data-view tab bar)"
Cohesion: 0.11
Nodes (22): AtomiX Atomic-Swap Tab, Balances Full Breakdown + Untruncated Tagged Coin List, Byte-Identical MDS Engine Reuse Rule, ZeroEdge Casino Tab (P2PChance), ETH Wallet Tab, Transaction History (SQLite, locally owned), In-app Node Jar Updater Removal, Launch Hygiene Sweep (cleanForeign) (+14 more)

### Community 40 - "maker.js"
Cohesion: 0.20
Nodes (19): buildOrder(), clampAsks(), currentOrder(), doLoadConfig(), doPublish(), keepAlive(), kvKey(), loadConfig() (+11 more)

### Community 41 - "webwallet.js"
Cohesion: 0.14
Nodes (30): ackKeyuses(), derive(), emitter, entryFor(), { EventEmitter }, fs, isAmount(), isMegammr() (+22 more)

### Community 42 - "curve.js"
Cohesion: 0.17
Nodes (17): aggregatePrice(), amt(), clampDec(), dec(), decOr(), fix(), funded(), grain() (+9 more)

### Community 43 - "lib/decimal.js"
Cohesion: 0.25
Nodes (19): bumpFrac(), ceilDp(), divFloor(), floorDp(), formatUnits(), fromScaled(), grain6(), gt0() (+11 more)

### Community 44 - "lib/engine.js"
Cohesion: 0.25
Nodes (16): baseSwap(), confirmMyLock(), ensureAllowance(), ethChainNow(), executeOtc(), isMyPublishKey(), normKey(), notifyChanged() (+8 more)

### Community 45 - "Rpc"
Cohesion: 0.24
Nodes (5): big(), hexToBig(), host(), Rpc(), snippet()

### Community 46 - "orderbook.js"
Cohesion: 0.22
Nodes (16): aggSide(), bestMakers(), cmp(), compareForFill(), isMine(), levelCap(), mergeFreshest(), nowMs() (+8 more)

### Community 47 - "d"
Cohesion: 0.27
Nodes (17): block(), build(), cell(), cells(), classify(), d(), fixed(), hasBeacon() (+9 more)

### Community 48 - "k"
Cohesion: 0.22
Nodes (10): "node_modules/elliptic/lib/elliptic/curve/base.js"(), "node_modules/elliptic/lib/elliptic/curve/edwards.js"(), "node_modules/elliptic/lib/elliptic/curve/short.js"(), "node_modules/elliptic/lib/elliptic/ec/index.js"(), "node_modules/elliptic/lib/elliptic/ec/key.js"(), feeGrowth(), k(), client (+2 more)

### Community 49 - "s"
Cohesion: 0.12
Nodes (18): "node_modules/elliptic/lib/elliptic/ec/signature.js"(), "node_modules/hash.js/lib/hash/ripemd.js"(), "node_modules/hash.js/lib/hash/sha/1.js"(), "node_modules/js-sha3/src/sha3.js"(), balance(), aggregateInfo(), createPreview(), D() (+10 more)

### Community 50 - "netfetch.js"
Cohesion: 0.21
Nodes (16): acquire(), dns, fetchJson(), getCapped(), http, https, ipBlocked(), isBlockedHost() (+8 more)

### Community 51 - "atomix/service.js"
Cohesion: 0.56
Nodes (8): configureEngines(), getBalances(), log(), logOnce(), notifyLog(), poll(), reloadShared(), tryBoot()

### Community 52 - "order.js"
Cohesion: 0.23
Nodes (14): canonicalJson(), effectiveAsks(), effectiveBids(), finite(), fromJson(), hasLiquidity(), isHex(), level() (+6 more)

### Community 53 - "casino/service.js"
Cohesion: 0.24
Nodes (15): cleanTracking(), coinAmount(), coinTok(), doResolve(), doReveal(), extractResponse(), gameTypeName(), getState() (+7 more)

### Community 54 - "build"
Cohesion: 0.17
Nodes (12): build, appId, extraResources, nsis, productName, win, allowToChangeInstallationDirectory, oneClick (+4 more)

### Community 55 - "init"
Cohesion: 0.23
Nodes (15): actionOnPool(), advanceRestoredKeys(), backup(), closePool(), collectToWallet(), createPool(), deposit(), ensureOwnerKey() (+7 more)

### Community 56 - "ethSendReview"
Cohesion: 0.24
Nodes (12): ensureRpcOverride(), ethAddrChecksumOk(), ethAmbiguousBroadcast(), ethCapGas(), ethGasNow(), ethGasScaledRpc(), ethReserveGp(), ethSendExecute() (+4 more)

### Community 57 - "ethwallet.js"
Cohesion: 0.14
Nodes (3): atomix, emitter, { EventEmitter }

### Community 58 - "tokenicons.js"
Cohesion: 0.26
Nodes (12): b64encode(), first(), hsl(), identiconDataUri(), meta(), metaField(), pickIconField(), resolveIcon() (+4 more)

### Community 59 - "linux"
Cohesion: 0.33
Nodes (6): linux, artifactName, category, icon, maintainer, target

### Community 60 - "ethTokensLoad"
Cohesion: 0.26
Nodes (14): ETH_TOKENS_FILE(), ethAddToken(), ethCleanSymbol(), ethDecodeSymbol(), ethRemoveToken(), ethTokenBy(), ethTokenMeta(), ethTokens() (+6 more)

### Community 62 - "minimaCore Desktop App"
Cohesion: 0.18
Nodes (11): Cross-platform Build Matrix (mac/win/linux), Bundled JRE via jlink, Desktop Build GitHub Actions Workflow, Bundled JRE (no system Java needed), Design.java CSS Port (native look), First-run Node Wizard, minimaCore Desktop App, Node Updater (sha256-verified jar swap) (+3 more)

### Community 63 - "identity.js"
Cohesion: 0.31
Nodes (9): boxPkOf(), canonicalId(), fromSeed(), isValidPublicId(), makeIdentity(), open(), seal(), seedBytes() (+1 more)

### Community 64 - "identitywatch.js"
Cohesion: 0.29
Nodes (6): check(), checkEth(), checkMinima(), halted(), raiseOrClear(), summary()

### Community 65 - "ethwallet-unit.js"
Cohesion: 0.33
Nodes (5): atomix, eq(), ok(), ssrf, xssOut

### Community 66 - "cdp-eval.js"
Cohesion: 0.33
Nodes (3): crypto, http, net

### Community 67 - "scripts"
Cohesion: 0.05
Nodes (38): electron, electron-builder, libsodium-wrappers, author, dependencies, libsodium-wrappers, qrcode-generator, @silentbot1/nat-api (+30 more)

### Community 68 - "form"
Cohesion: 0.71
Nodes (6): compute(), draw(), fmt(), fmtMove(), fmtPrice(), form()

### Community 69 - "abi.js"
Cohesion: 0.47
Nodes (9): decode(), encAddr(), encBool(), encBytes32(), encodeCall(), encUint(), pad64(), selector() (+1 more)

### Community 70 - "ethtx.js"
Cohesion: 0.33
Nodes (7): acquire(), busyErr(), doSend(), pump(), release(), send(), slot()

### Community 71 - "history-store.js"
Cohesion: 0.33
Nodes (9): all(), { app }, clear(), ensureLoaded(), filePath(), fs, merge(), path (+1 more)

### Community 72 - "finalise"
Cohesion: 0.24
Nodes (10): ceil(), checkRoundingDigits(), finalise(), floor(), getLn10(), naturalExponential(), naturalLogarithm(), round() (+2 more)

### Community 73 - "activity-chain.js"
Cohesion: 0.07
Nodes (45): b32(), contractId(), make(), safeBig(), "node_modules/tweetnacl/nacl-fast.js"(), allHistory(), command(), decorate() (+37 more)

### Community 74 - "mac"
Cohesion: 0.17
Nodes (12): mac, NSCameraUsageDescription, category, entitlements, entitlementsInherit, extendInfo, gatekeeperAssess, hardenedRuntime (+4 more)

### Community 76 - "ax_eth.js"
Cohesion: 0.47
Nodes (8): addressFromPriv(), intBytes(), keccakBytes(), rlpBytes(), rlpLenPrefix(), rlpList(), signLegacyTx(), toBigHex()

### Community 77 - "swapplan.js"
Cohesion: 0.53
Nodes (8): buildSweepPlan(), ceilUsdt(), computeMinima(), computeUsdt(), legMinima(), num(), pstr(), sweepDepthMinima()

### Community 78 - "wallet.js"
Cohesion: 0.33
Nodes (5): checkSend(), gasReserveWei(), isEthAddr(), maxEthSendWei(), validDec()

### Community 79 - "vestr.js"
Cohesion: 0.15
Nodes (25): pinMinimaSend(), blockHeightForDate(), calculate(), coinAmount(), collect(), contractFromCoin(), create(), crypto (+17 more)

### Community 80 - "casino-glue-test.js"
Cohesion: 0.22
Nodes (6): casino, cfg, mem, OPEN_BET, path, sent

### Community 81 - "faucet.js"
Cohesion: 0.50
Nodes (4): getJson(), https, requestFaucet(), { URL }

### Community 83 - "digitsToString"
Cohesion: 0.32
Nodes (8): checkInt32(), convertBase(), digitsToString(), finiteToString(), getZeroString(), nonFiniteToString(), random(), toStringBinary()

### Community 86 - "parseOther"
Cohesion: 0.33
Nodes (7): clone(), getBase10Exponent(), intPow(), isDecimalInstance(), parseDecimal(), parseOther(), truncate()

### Community 88 - "atomix-s2-gate.js"
Cohesion: 0.29
Nodes (4): { execFile }, fs, os, path

### Community 89 - "Terminal IDE-style Parameter Autocomplete"
Cohesion: 0.40
Nodes (6): minimaCore Desktop Changelog, Terminal IDE-style Parameter Autocomplete, Pre-commit Version-Bump Hook (.githooks/pre-commit), Versioning Guardrail — Every Code Change Ships a Version Bump, Terminal Autocomplete Dropdown (termSug/termHint), Terminal View (termOut/termIn)

### Community 90 - "parlons.js"
Cohesion: 0.33
Nodes (8): fs, node, openExternal(), path, readTrim(), { shell }, status(), ticketUrl()

### Community 91 - "pandapools/loader.js"
Cohesion: 0.33
Nodes (5): ALL_FILES, createContext(), fs, path, vm

### Community 92 - "Minima Blockchain Brand Identity"
Cohesion: 0.40
Nodes (6): Brand Color Palette (dark #16181c, orange #ff512f, blue #317aff, grey #91919d), Minima Logo Mark (SVG), Minima Blockchain Brand Identity, currentColor Theming (theme-adaptive icon fill), Minima Outline Logo (SVG), MinimaCore Desktop Renderer UI

### Community 93 - "atomix-boot-gate.js"
Cohesion: 0.33
Nodes (4): { execFile }, fs, os, path

### Community 94 - "boot.js"
Cohesion: 0.60
Nodes (3): init(), lockedErr(), permErr()

### Community 95 - "flow.js"
Cohesion: 0.70
Nodes (4): each(), map(), once(), waterfall()

### Community 100 - "getPi"
Cohesion: 0.40
Nodes (5): atan(), atan2(), getPi(), isOdd(), toLessThanHalfPi()

### Community 104 - "prng.js"
Cohesion: 0.83
Nodes (3): init(), initBrowser(), initService()

### Community 106 - ""node_modules/bn.js/lib/bn.js""
Cohesion: 0.50
Nodes (4): "node_modules/bn.js/lib/bn.js"(), div(), mod(), pow()

### Community 107 - "cosine"
Cohesion: 0.67
Nodes (4): cosine(), sine(), taylorSeries(), tinyPow()

### Community 109 - "pandapools-parity-check.cjs"
Cohesion: 0.15
Nodes (12): assert, ctx, feed, files, fs, html, htmlCode, path (+4 more)

### Community 110 - "nodeCmd"
Cohesion: 0.50
Nodes (5): buildMds(), importCoin(), nodeCmd(), restoreOne(), runner()

### Community 112 - "log"
Cohesion: 0.67
Nodes (3): log(), log10(), log2()

### Community 113 - "App Shell (header, tabs, views)"
Cohesion: 0.67
Nodes (3): App Shell (header, tabs, views), Renderer Content-Security-Policy, First-Run Node Setup Wizard

### Community 114 - "Minima Tile Icon (SVG)"
Cohesion: 0.67
Nodes (3): Theme-Adaptive Icon via currentColor, Minima Brand Logomark (angular M), Minima Tile Icon (SVG)

### Community 123 - "minimaCore Desktop 0.16.39 activity parity review"
Cohesion: 0.14
Nodes (13): Findings addressed, MAJOR — incomplete sync or storage errors presented as completion, MAJOR — inferred confirmations and false creation failures, MAJOR — missing records and device-dependent transaction times, MAJOR — public transactions missing on other wallets, MAJOR — receipt identity lost during mining, minimaCore Desktop 0.16.39 activity parity review, Packaged validation (+5 more)

### Community 125 - "createAnchor"
Cohesion: 0.32
Nodes (8): acceptMid(), createAnchor(), effLevel(), fmtMid(), isMarketFed(), market(), marketFresh(), refreshMarket()

### Community 126 - "withTimeout"
Cohesion: 0.46
Nodes (8): jvm(), makerAvail(), makerPublish(), makerSave(), makerWithdraw(), switchCurrency(), toVm(), withTimeout()

### Community 127 - "parlons-view-test.cjs"
Cohesion: 0.25
Nodes (7): assert, fixture(), fs, path, source, test, vm

## Knowledge Gaps
- **397 isolated node(s):** `name`, `productName`, `version`, `description`, `author` (+392 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **17 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `p()` connect `p` to `poolmgr.js`, `casino.js`, `pandapools/service.js`, `renderCasino`, `atomix.js`, `esc`, `pandapools.js`, `NodeManager`, `peg.js`, `d`, `k`, `s`, `init`, `ethSendReview`, `ethTokensLoad`, `activity-chain.js`, `vestr.js`, `"node_modules/bn.js/lib/bn.js"`, `withTimeout`?**
  _High betweenness centrality (0.193) - this node is a cross-community bridge._
- **Why does `s()` connect `s` to `pandapools.js`, `otc.js`, `renderAxSwap`, `"node_modules/bn.js/lib/bn.js"`, `k`, `settle.js`, `init`, `createAnchor`?**
  _High betweenness centrality (0.079) - this node is a cross-community bridge._
- **Why does `k()` connect `k` to `poolmgr.js`, `ui.js`, `NodeManager`, `pandapools/service.js`, `activity-chain.js`, `curve.js`, `copy`, `d`, `store.js`, `atomix/service.js`, `config.js`?**
  _High betweenness centrality (0.059) - this node is a cross-community bridge._
- **Are the 27 inferred relationships involving `p()` (e.g. with `ingest()` and `createContext()`) actually correct?**
  _`p()` has 27 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `productName`, `version` to the rest of the system?**
  _397 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `app.js` be split into smaller, more focused modules?**
  _Cohesion score 0.035443037974683546 - nodes in this community are weakly interconnected._
- **Should `poolmgr.js` be split into smaller, more focused modules?**
  _Cohesion score 0.050883898709985664 - nodes in this community are weakly interconnected._