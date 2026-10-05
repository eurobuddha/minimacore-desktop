# Graph Report - minimacore-desktop  (2026-09-30)

## Corpus Check
- 155 files · ~354,311 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2992 nodes · 6322 edges · 159 communities (142 shown, 17 thin omitted)
- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS · INFERRED: 590 edges (avg confidence: 0.59)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `1903e7a1`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- poolmgr.js
- app.js
- config.js
- ui.js
- pandapools/service.js
- main/casino.js
- node-manager.js
- main/mail.js
- renderSettings
- esc
- activity-chain.js
- otc.js
- casino/engine.js
- config.js
- showTokenDetail
- reserve-recovery.js
- files
- scripts
- history-db.js
- atomix.js
- atomix-ui.js
- shop.js
- pools.js
- p
- responder.js
- settle.js
- store.js
- renderShopBrowse
- swapdb.js
- pandapools/decimal.js
- elliptic.js
- mail-store.js
- casino-timeout-test.cjs
- shop-store.js
- htlc.js
- main.js
- pandapools.js
- portmap.js
- vestr.js
- peg.js
- renderer/mail.js
- maker.js
- renderer/casino.js
- ethhtlc.js
- curve.js
- pandapools-recovery.test.cjs
- lib/decimal.js
- pandapools-signgate.test.cjs
- s
- casino/service.js
- lib/engine.js
- Rpc
- orderbook.js
- netfetch.js
- d
- order.js
- Changelog
- REVIEW-0.16.52.md
- ethwallet.js
- tokenicons.js
- pandapools-parity-manifest.cjs
- mac
- pandapools-parity-check.cjs
- .main
- ethSendReview
- hex.js
- trading.js
- rpcCall
- build
- identity.js
- identitywatch.js
- k
- init
- config-keys-test.cjs
- pandapools-recovery-lifecycle.test.cjs
- ax_sodium.js
- abi.js
- ethtx.js
- history-store.js
- finalise
- Keccak
- ax_eth.js
- swapplan.js
- wallet.js
- showHistoryDetail
- actionOnPool
- casino-glue-test.js
- buildAndPost
- mailcrypto.js
- digitsToString
- parlons-calls-test.cjs
- parlons-view-test.cjs
- parseOther
- minimaCore Desktop (macOS)
- atomix-s2-gate.js
- renderVestrList
- linux
- atomix-boot-gate.js
- cdp-eval.js
- boot.js
- flow.js
- faucet.js
- getPi
- router.js
- termcomplete-test.js
- inspect.js
- prng.js
- "node_modules/bn.js/lib/bn.js"
- cosine
- fetch-parlons-node-jar.sh
- log
- install.sh
- pre-commit
- preload.js
- atomix-parity-check.sh
- casino-parity-check.sh
- notarize-dmg.sh
- publish-desktop.sh
- publish-desktop-platforms.sh
- release-desktop.sh
- verify-mac.sh
- updater-test.cjs
- package.json
- netfetch-test.cjs
- updater.js
- parlons.js
- ensureRpcOverride
- termcomplete.js
- beginHunt
- sqlEsc
- pinMinimaSend
- init
- pandapools/loader.js
- createPool
- panels-test.cjs
- mdsw.js
- casinoart.js
- minimaCore Desktop 0.16.39 activity parity review
- dependencies
- atomix/service.js
- Review — minimaCore Desktop 0.16.87
- gated
- el
- createAnchor
- Open-offer keepalive — APK 0.7.2 / MDS 2.9.2 / desktop integration branch
- Code Review
- User instructions — AUTHORITATIVE. These override default behavior and must be followed exactly.
- REVIEW-0.16.54.md
- resync-host-test.cjs
- devDependencies
- swapExecute

## God Nodes (most connected - your core abstractions)
1. `el()` - 76 edges
2. `p()` - 60 edges
3. `Changelog` - 60 edges
4. `esc()` - 48 edges
5. `files` - 44 edges
6. `el()` - 41 edges
7. `AX()` - 36 edges
8. `toast()` - 34 edges
9. `NodeManager` - 27 edges
10. `scripts` - 26 edges

## Surprising Connections (you probably didn't know these)
- `withServer()` --indirect_call--> `resolve()`  [INFERRED]
  scripts/rpc-test.cjs → main/casino.js
- `effectiveParams()` --indirect_call--> `k()`  [INFERRED]
  config.js → main/pandapools/curve.js
- `casinoRefresh()` --indirect_call--> `p()`  [INFERRED]
  renderer/casino.js → main/atomix.js
- `ppMineHtml()` --indirect_call--> `p()`  [INFERRED]
  renderer/pools.js → main/atomix.js
- `ppPairRows()` --indirect_call--> `p()`  [INFERRED]
  renderer/pools.js → main/atomix.js

## Import Cycles
- None detected.

## Communities (159 total, 17 thin omitted)

### Community 0 - "poolmgr.js"
Cohesion: 0.12
Nodes (21): collectCanSign(), collectDecide(), collectRemaining(), collectSweep(), countSigs(), ensureTrackedAll(), ensureTrackedForSwap(), errOf() (+13 more)

### Community 1 - "app.js"
Cohesion: 0.06
Nodes (51): absCmp(), appendLog(), applyTheme(), BAL_BY_TID, boot(), casinoActivity(), classify(), coinLite() (+43 more)

### Community 2 - "config.js"
Cohesion: 0.13
Nodes (26): { app, safeStorage }, configPath(), crypto, DEFAULTS, deleteSecret(), effectiveParams(), encAvailable(), { execFileSync } (+18 more)

### Community 3 - "ui.js"
Cohesion: 0.10
Nodes (68): activeSwap(), activityTab(), amtField(), banner(), bidiInput(), bootErrorCard(), ccy(), clean() (+60 more)

### Community 4 - "pandapools/service.js"
Cohesion: 0.06
Nodes (77): derivePools(), done(), finishScan(), fund(), gatherOwned(), gatherRegistry(), group(), parseScripts() (+69 more)

### Community 5 - "main/casino.js"
Cohesion: 0.07
Nodes (55): balance(), buildMds(), C(), cancel(), cgame(), claimTimeout(), cmnum(), cnorm() (+47 more)

### Community 6 - "node-manager.js"
Cohesion: 0.07
Nodes (27): alive(), { app }, commandOf(), config, { createNodeLog }, EventEmitter, fs, killPid() (+19 more)

### Community 7 - "main/mail.js"
Cohesion: 0.06
Nodes (32): addContact(), archivedThreads(), autoReplyTimes, backfill, backfillStatus(), backup, config, contacts() (+24 more)

### Community 8 - "renderSettings"
Cohesion: 0.17
Nodes (21): casinoAgeGate(), hideSetup(), keysInfo(), onStatus(), postBootNewSeed(), postBootRestore(), renderActive(), renderAtomix() (+13 more)

### Community 9 - "esc"
Cohesion: 0.15
Nodes (21): contribHelp(), esc(), ewAddTokenDialog(), ewExportKey(), ewRpcDialog(), ewSettingsDialog(), forwardHowTo(), isPrivateAddr() (+13 more)

### Community 10 - "activity-chain.js"
Cohesion: 0.12
Nodes (41): "node_modules/elliptic/lib/elliptic/ec/signature.js"(), allHistory(), command(), decorate(), esc(), hex(), init(), isPersonal() (+33 more)

### Community 11 - "otc.js"
Cohesion: 0.13
Nodes (45): accept(), addMsg(), allDeals(), apply(), applyPropose(), approxEq(), changed(), claimExecute() (+37 more)

### Community 12 - "casino/engine.js"
Cohesion: 0.13
Nodes (42): addMultipleInputs(), cancelBet(), claimTimeout(), coinAmount(), coinsAtContract(), coinTok(), createBet(), decAdd() (+34 more)

### Community 13 - "config.js"
Cohesion: 0.12
Nodes (26): { app, safeStorage }, configPath(), crypto, DEFAULTS, deleteSecret(), effectiveParams(), encAvailable(), { execFileSync } (+18 more)

### Community 14 - "showTokenDetail"
Cohesion: 0.19
Nodes (19): applyIcon(), balBreakdown(), balCardHtml(), cmd(), decSub(), enhanceTokenIcons(), groupThousands(), isNftBal() (+11 more)

### Community 15 - "reserve-recovery.js"
Cohesion: 0.12
Nodes (45): allowedArchive(), backup(), browserArchive(), call(), cancelPoolTransactions(), checkedKeys(), checkSignature(), classifyKeys() (+37 more)

### Community 16 - "files"
Cohesion: 0.05
Nodes (43): files, main/**, node_modules/abort-controller/**, node_modules/chrome-dgram/**, node_modules/cross-fetch-ponyfill/**, node_modules/cross-spawn/**, node_modules/data-uri-to-buffer/**, node_modules/debug/** (+35 more)

### Community 17 - "scripts"
Cohesion: 0.08
Nodes (26): scripts, dist, dist:linux, dist:mac, dist:mac:signed, dist:win, fetch:parlons, gate:atomix (+18 more)

### Community 18 - "history-db.js"
Cohesion: 0.07
Nodes (38): all(), { app }, bI(), clear(), count(), countSync(), dbPath(), ensureReady() (+30 more)

### Community 19 - "atomix.js"
Cohesion: 0.08
Nodes (33): bareRefusal(), buildMds(), { createContext }, emitter, ETH_FEE_MULT, ETH_SEED_TOKENS, ethSendInFlight, ethUserHosts (+25 more)

### Community 20 - "atomix-ui.js"
Cohesion: 0.08
Nodes (67): ax6(), axAgo(), axApplyLook(), axBestLine(), axCcyName(), axCcyOf(), axChip(), axCleanNum() (+59 more)

### Community 21 - "shop.js"
Cohesion: 0.07
Nodes (36): advanceStatus(), capSeen(), coinAmount(), coinsAt(), config, crypto, emitter, EventEmitter (+28 more)

### Community 22 - "pools.js"
Cohesion: 0.09
Nodes (57): applyPpDir(), collectPpFunds(), confirmPpSigning(), confirmPpWithdraw(), doPpCollect(), doPpSwap(), onPandapoolsUpdate(), ppActBtn() (+49 more)

### Community 23 - "p"
Cohesion: 0.15
Nodes (39): AX(), balances(), book(), bookScan(), coins(), computeQuote(), ethBalances(), ethWallet() (+31 more)

### Community 24 - "responder.js"
Cohesion: 0.14
Nodes (33): acceptTakerBuyMinima(), acceptTakerSellMinima(), addDec(), addIncoming(), cpBurstFull(), decimalsOf(), doScanIncoming(), ensureAllowance() (+25 more)

### Community 25 - "settle.js"
Cohesion: 0.16
Nodes (37): activeSwaps(), amountTokenOk(), broadcastEthRefund(), broadcastEthWithdraw(), checkCanSwapCoin(), checkEthContractBody(), checkEthContractFor(), checkExpiredMinima() (+29 more)

### Community 26 - "store.js"
Cohesion: 0.09
Nodes (32): actRecord(), actRecordFailed(), actSetStatus(), collectAdd(), collectAttempted(), collectClear(), confirmed(), create() (+24 more)

### Community 27 - "renderShopBrowse"
Cohesion: 0.18
Nodes (15): renderMiniMall(), renderShopBrowse(), renderShopStudio(), renderShopSub(), shopCapOf(), shopCartTotal(), shopDoPay(), shopNormalizeShipping() (+7 more)

### Community 28 - "swapdb.js"
Cohesion: 0.20
Nodes (32): activeHashes(), allSwaps(), deleteSwap(), esc(), executedTrades(), getEvents(), getRequest(), getSecret() (+24 more)

### Community 29 - "pandapools/decimal.js"
Cohesion: 0.07
Nodes (5): hypot(), max(), maxOrMin(), min(), sqrt()

### Community 30 - "elliptic.js"
Cohesion: 0.07
Nodes (3): "node_modules/hash.js/lib/hash/sha/256.js"(), "node_modules/hash.js/lib/hash/sha/512.js"(), "node_modules/hmac-drbg/lib/hmac-drbg.js"()

### Community 31 - "mail-store.js"
Cohesion: 0.15
Nodes (29): addContact(), addMessage(), all(), allThreadRows(), { app }, archivedSet(), archivedThreads(), clear() (+21 more)

### Community 32 - "casino-timeout-test.cjs"
Cohesion: 0.07
Nodes (12): { app, session, Notification, systemPreferences }, install(), isPanel(), assert, ctx, focus(), fs, Notification (+4 more)

### Community 33 - "shop-store.js"
Cohesion: 0.15
Nodes (28): addChat(), { app }, chat(), clear(), decAdd(), decCmp(), decGte(), deleteShop() (+20 more)

### Community 34 - "htlc.js"
Cohesion: 0.07
Nodes (67): checkFailure(), claim(), coinAmount(), confirmationDepth(), deleteTxn(), ensureScript(), flag(), grain() (+59 more)

### Community 35 - "main.js"
Cohesion: 0.07
Nodes (23): { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell, Notification, session, clipboard }, atomix, casino, config, createWindow(), ethwallet, faucet, fs (+15 more)

### Community 36 - "pandapools.js"
Cohesion: 0.09
Nodes (27): activity(), activityLabels(), { app }, buildMds(), config, { createContext, ALL_FILES }, currentBlock(), emitter (+19 more)

### Community 37 - "portmap.js"
Cohesion: 0.15
Nodes (12): defaultRoute(), dgram, EventEmitter, { execFile }, isPrivateIp(), RFC-1918, lanIp(), os (+4 more)

### Community 38 - "vestr.js"
Cohesion: 0.16
Nodes (25): blockHeightForDate(), calculate(), coinAmount(), collect(), contractFromCoin(), create(), crypto, emitter (+17 more)

### Community 39 - "peg.js"
Cohesion: 0.15
Nodes (17): ingest(), poll(), price(), reconcileSpent(), ageMs(), applyPeg(), commitMexc(), effectiveLevel() (+9 more)

### Community 40 - "renderer/mail.js"
Cohesion: 0.09
Nodes (55): avatar(), bubble(), clock(), composeImage(), compressImage(), contactMenu(), convHtml(), dayLabel() (+47 more)

### Community 41 - "maker.js"
Cohesion: 0.20
Nodes (19): buildOrder(), clampAsks(), currentOrder(), doLoadConfig(), doPublish(), keepAlive(), kvKey(), loadConfig() (+11 more)

### Community 42 - "renderer/casino.js"
Cohesion: 0.09
Nodes (68): applyCasinoCcyTheme(), bell(), casinoActAppend(), casinoActClass(), casinoActivity(), casinoActPaint(), casinoAnimHTML(), casinoBlock() (+60 more)

### Community 43 - "ethhtlc.js"
Cohesion: 0.12
Nodes (15): b32(), contractId(), make(), safeBig(), amount(), cancelKey(), decimal(), due() (+7 more)

### Community 44 - "curve.js"
Cohesion: 0.17
Nodes (17): aggregatePrice(), amt(), clampDec(), dec(), decOr(), fix(), funded(), grain() (+9 more)

### Community 45 - "pandapools-recovery.test.cjs"
Cohesion: 0.08
Nodes (17): addr, assert, close(), fs, good(), harness(), invoke(), {makeSqlShim} (+9 more)

### Community 46 - "lib/decimal.js"
Cohesion: 0.25
Nodes (19): bumpFrac(), ceilDp(), divFloor(), floorDp(), formatUnits(), fromScaled(), grain6(), gt0() (+11 more)

### Community 47 - "pandapools-signgate.test.cjs"
Cohesion: 0.11
Nodes (16): addr, assert, asyncStandard(), fs, good(), harness(), invoke(), loader (+8 more)

### Community 48 - "s"
Cohesion: 0.16
Nodes (13): "node_modules/hash.js/lib/hash/ripemd.js"(), "node_modules/hash.js/lib/hash/sha/1.js"(), "node_modules/js-sha3/src/sha3.js"(), balance(), aggregateInfo(), createPreview(), D(), statement() (+5 more)

### Community 49 - "casino/service.js"
Cohesion: 0.21
Nodes (17): cleanTracking(), coinAmount(), coinTok(), doResolve(), doReveal(), ensureScript(), extractResponse(), gameTypeName() (+9 more)

### Community 50 - "lib/engine.js"
Cohesion: 0.25
Nodes (16): baseSwap(), confirmMyLock(), ensureAllowance(), ethChainNow(), executeOtc(), isMyPublishKey(), normKey(), notifyChanged() (+8 more)

### Community 51 - "Rpc"
Cohesion: 0.24
Nodes (5): big(), hexToBig(), host(), Rpc(), snippet()

### Community 52 - "orderbook.js"
Cohesion: 0.22
Nodes (16): aggSide(), bestMakers(), cmp(), compareForFill(), isMine(), levelCap(), mergeFreshest(), nowMs() (+8 more)

### Community 53 - "netfetch.js"
Cohesion: 0.20
Nodes (18): acquire(), connectPin(), dns, fetchJson(), getCapped(), http, https, ipBlocked() (+10 more)

### Community 54 - "d"
Cohesion: 0.27
Nodes (17): block(), build(), cell(), cells(), classify(), d(), fixed(), hasBeacon() (+9 more)

### Community 55 - "order.js"
Cohesion: 0.23
Nodes (14): canonicalJson(), effectiveAsks(), effectiveBids(), finite(), fromJson(), hasLiquidity(), isHex(), level() (+6 more)

### Community 56 - "Changelog"
Cohesion: 0.03
Nodes (60): [0.11.x] — Vestr + AtomiX preimage fix, [0.13.0] — cross-platform builds, [0.15.x] — Web Wallet + AtomiX CSV + clipboard, [0.16.0] – [0.16.1] — ETH Wallet tab, [0.16.11] — PandaPools: stop the runaway owner-key hunt (bounded, remembered, provable), [0.16.12] — SECURITY: bundled node jar carries the Wallet.signData fix; in-app jar updater removed, [0.16.13] — bundled node moves to 1.1.2.4 (upstream super-parent fix), [0.16.14] — Terminal: IDE-style parameter autocomplete (port from Terminal IDE) (+52 more)

### Community 58 - "ethwallet.js"
Cohesion: 0.14
Nodes (3): atomix, emitter, { EventEmitter }

### Community 59 - "tokenicons.js"
Cohesion: 0.26
Nodes (12): b64encode(), first(), hsl(), identiconDataUri(), meta(), metaField(), pickIconField(), resolveIcon() (+4 more)

### Community 60 - "pandapools-parity-manifest.cjs"
Cohesion: 0.20
Nodes (13): crypto, digestEngine(), donorProvenance(), engineDir, { execFileSync }, FILES, fs, manifestPath (+5 more)

### Community 61 - "mac"
Cohesion: 0.15
Nodes (13): mac, NSCameraUsageDescription, NSMicrophoneUsageDescription, category, entitlements, entitlementsInherit, extendInfo, gatekeeperAssess (+5 more)

### Community 62 - "pandapools-parity-check.cjs"
Cohesion: 0.14
Nodes (10): assert, ctx, feed, files, fs, html, path, root (+2 more)

### Community 63 - ".main"
Cohesion: 0.29
Nodes (5): Bet, Coin, CasinoOfferOracle, CasinoTimeoutParity, Transaction

### Community 64 - "ethSendReview"
Cohesion: 0.14
Nodes (25): ETH_TOKENS_FILE(), ethAddrChecksumOk(), ethAddToken(), ethAmbiguousBroadcast(), ethCapGas(), ethCleanSymbol(), ethDecodeSymbol(), ethGasNow() (+17 more)

### Community 66 - "trading.js"
Cohesion: 0.24
Nodes (7): byKey(), forCoinLabel(), forSwap(), isTerminalSwap(), loadKey(), visibleIn(), withinWindow()

### Community 67 - "rpcCall"
Cohesion: 0.20
Nodes (10): runner(), http, rpcCall(), timeoutFor(), WRITE_PREFIXES, assert, net, { rpcCall } (+2 more)

### Community 68 - "build"
Cohesion: 0.17
Nodes (12): build, appId, extraResources, nsis, productName, win, allowToChangeInstallationDirectory, oneClick (+4 more)

### Community 69 - "identity.js"
Cohesion: 0.31
Nodes (9): boxPkOf(), canonicalId(), fromSeed(), isValidPublicId(), makeIdentity(), open(), seal(), seedBytes() (+1 more)

### Community 70 - "identitywatch.js"
Cohesion: 0.29
Nodes (6): check(), checkEth(), checkMinima(), halted(), raiseOrClear(), summary()

### Community 71 - "k"
Cohesion: 0.15
Nodes (11): "node_modules/elliptic/lib/elliptic/curve/base.js"(), "node_modules/elliptic/lib/elliptic/curve/edwards.js"(), "node_modules/elliptic/lib/elliptic/curve/short.js"(), "node_modules/elliptic/lib/elliptic/ec/index.js"(), "node_modules/elliptic/lib/elliptic/ec/key.js"(), "node_modules/tweetnacl/nacl-fast.js"(), feeGrowth(), k() (+3 more)

### Community 72 - "init"
Cohesion: 0.19
Nodes (14): archiveSettings(), backup(), collectToWallet(), confirmSigning(), createPool(), init(), listRetired(), pendingCollect() (+6 more)

### Community 73 - "config-keys-test.cjs"
Cohesion: 0.23
Nodes (11): assert, braceBlock(), configSrc, defaultsKeys(), fs, path, rendererKeys(), rendererSrc (+3 more)

### Community 74 - "pandapools-recovery-lifecycle.test.cjs"
Cohesion: 0.18
Nodes (8): actualSql, assert, fs, loader, os, path, test, vm

### Community 75 - "ax_sodium.js"
Cohesion: 0.27
Nodes (6): cat(), hkdfSha256(), hmacSha256(), RFC-5869, seal(), sealOpen()

### Community 76 - "abi.js"
Cohesion: 0.47
Nodes (9): decode(), encAddr(), encBool(), encBytes32(), encodeCall(), encUint(), pad64(), selector() (+1 more)

### Community 77 - "ethtx.js"
Cohesion: 0.33
Nodes (7): acquire(), busyErr(), doSend(), pump(), release(), send(), slot()

### Community 78 - "history-store.js"
Cohesion: 0.33
Nodes (9): all(), { app }, clear(), ensureLoaded(), filePath(), fs, merge(), path (+1 more)

### Community 79 - "finalise"
Cohesion: 0.24
Nodes (10): ceil(), checkRoundingDigits(), finalise(), floor(), getLn10(), naturalExponential(), naturalLogarithm(), round() (+2 more)

### Community 81 - "ax_eth.js"
Cohesion: 0.47
Nodes (8): addressFromPriv(), intBytes(), keccakBytes(), rlpBytes(), rlpLenPrefix(), rlpList(), signLegacyTx(), toBigHex()

### Community 82 - "swapplan.js"
Cohesion: 0.53
Nodes (8): buildSweepPlan(), ceilUsdt(), computeMinima(), computeUsdt(), legMinima(), num(), pstr(), sweepDepthMinima()

### Community 83 - "wallet.js"
Cohesion: 0.33
Nodes (5): checkSend(), gasReserveWei(), isEthAddr(), maxEthSendWei(), validDec()

### Community 84 - "showHistoryDetail"
Cohesion: 0.13
Nodes (24): copyHistory(), ensureHistActions(), ensureHistFilter(), exportHistory(), histCells(), histDate(), histExportRows(), histFilterActive() (+16 more)

### Community 85 - "actionOnPool"
Cohesion: 0.31
Nodes (9): actionOnPool(), closePool(), deposit(), ensureOwnerKey(), execDeadline(), migrate(), poolByAddress(), pumpActionQueue() (+1 more)

### Community 86 - "casino-glue-test.js"
Cohesion: 0.22
Nodes (6): casino, cfg, mem, OPEN_BET, path, sent

### Community 87 - "buildAndPost"
Cohesion: 0.32
Nodes (17): addAnnounceState(), buildAndPost(), buildCreate(), buildMigrate(), buildRouted(), close(), deposit(), ensureTracked() (+9 more)

### Community 88 - "mailcrypto.js"
Cohesion: 0.15
Nodes (16): boxPkOf(), crypto, deriveIdentity(), deriveIdentityDomain(), hkdf32(), idBytes(), ikmFromSeed(), isValidPublicId() (+8 more)

### Community 89 - "digitsToString"
Cohesion: 0.32
Nodes (8): checkInt32(), convertBase(), digitsToString(), finiteToString(), getZeroString(), nonFiniteToString(), random(), toStringBinary()

### Community 90 - "parlons-calls-test.cjs"
Cohesion: 0.25
Nodes (6): assert, fs, path, source, {test}, vm

### Community 91 - "parlons-view-test.cjs"
Cohesion: 0.25
Nodes (6): assert, fs, path, source, test, vm

### Community 92 - "parseOther"
Cohesion: 0.33
Nodes (7): clone(), getBase10Exponent(), intPow(), isDecimalInstance(), parseDecimal(), parseOther(), truncate()

### Community 93 - "minimaCore Desktop (macOS)"
Cohesion: 0.11
Nodes (18): 0.16.28, 0.16.29, 0.16.30, 0.16.31, 0.16.32, 0.16.33, 0.16.34, 0.16.35 (+10 more)

### Community 94 - "atomix-s2-gate.js"
Cohesion: 0.29
Nodes (4): { execFile }, fs, os, path

### Community 95 - "renderVestrList"
Cohesion: 0.36
Nodes (10): onVestrUpdate(), renderVestr(), renderVestrCalc(), renderVestrCreate(), renderVestrList(), renderVestrSub(), vestrDoCollect(), vestrDoCreate() (+2 more)

### Community 96 - "linux"
Cohesion: 0.33
Nodes (6): linux, artifactName, category, icon, maintainer, target

### Community 97 - "atomix-boot-gate.js"
Cohesion: 0.33
Nodes (4): { execFile }, fs, os, path

### Community 98 - "cdp-eval.js"
Cohesion: 0.33
Nodes (3): crypto, http, net

### Community 99 - "boot.js"
Cohesion: 0.60
Nodes (3): init(), lockedErr(), permErr()

### Community 100 - "flow.js"
Cohesion: 0.70
Nodes (4): each(), map(), once(), waterfall()

### Community 102 - "faucet.js"
Cohesion: 0.50
Nodes (4): getJson(), https, requestFaucet(), { URL }

### Community 103 - "getPi"
Cohesion: 0.40
Nodes (5): atan(), atan2(), getPi(), isOdd(), toLessThanHalfPi()

### Community 106 - "inspect.js"
Cohesion: 0.60
Nodes (4): buildReport(), recordedTxnSummary(), statusDetail(), tok()

### Community 107 - "prng.js"
Cohesion: 0.83
Nodes (3): init(), initBrowser(), initService()

### Community 109 - ""node_modules/bn.js/lib/bn.js""
Cohesion: 0.50
Nodes (4): "node_modules/bn.js/lib/bn.js"(), div(), mod(), pow()

### Community 110 - "cosine"
Cohesion: 0.67
Nodes (4): cosine(), sine(), taylorSeries(), tinyPow()

### Community 113 - "log"
Cohesion: 0.67
Nodes (3): log(), log10(), log2()

### Community 127 - "updater-test.cjs"
Cohesion: 0.11
Nodes (14): assert, crypto, DOWNLOADS, { EventEmitter }, fs, GOOD_SHA, http, https (+6 more)

### Community 128 - "package.json"
Cohesion: 0.20
Nodes (9): author, description, license, main, name, parlonsNode, parlonsNodeSha256, productName (+1 more)

### Community 129 - "netfetch-test.cjs"
Cohesion: 0.15
Nodes (7): assert, dns, { EventEmitter }, http, https, netfetch, test

### Community 130 - "updater.js"
Cohesion: 0.18
Nodes (17): { app, shell }, check(), cmpVersion(), config, crypto, current(), download(), feedUrl() (+9 more)

### Community 131 - "parlons.js"
Cohesion: 0.33
Nodes (8): fs, node, openExternal(), path, readTrim(), { shell }, status(), ticketUrl()

### Community 132 - "ensureRpcOverride"
Cohesion: 0.40
Nodes (6): ensureRpcOverride(), ETH_RPC_FILE(), ethPrivateHost(), ethRpcLoad(), ethSetRpc(), ethValidateRpc()

### Community 133 - "termcomplete.js"
Cohesion: 0.24
Nodes (13): addParamItems(), commandBrief(), docsFor(), getCmd(), helpBrief(), helpFull(), helpStore(), item() (+5 more)

### Community 134 - "beginHunt"
Cohesion: 0.22
Nodes (14): beginHunt(), fingerprintOf(), huntKeys(), keyRowsOf(), keyTotalOf(), loadHuntState(), parseModifier(), provenForeign() (+6 more)

### Community 135 - "sqlEsc"
Cohesion: 0.20
Nodes (12): acquireGlobalSignLock(), coinAmt(), lockedMap(), lockTable(), pruneLocks(), releaseIds(), reserveLocks(), selectCoinsAttempt() (+4 more)

### Community 136 - "pinMinimaSend"
Cohesion: 0.14
Nodes (9): crypto, decrypt(), deriveKey(), encrypt(), pinMinimaSend(), assert, backup, mail (+1 more)

### Community 137 - "init"
Cohesion: 0.17
Nodes (24): backfillStep(), currentBlock(), depthForGap(), init(), nextFloorTarget(), nodeCmd(), pay(), processCoins() (+16 more)

### Community 138 - "pandapools/loader.js"
Cohesion: 0.33
Nodes (5): ALL_FILES, createContext(), fs, path, vm

### Community 139 - "createPool"
Cohesion: 0.50
Nodes (4): address(), send(), createPool(), deriveAddress()

### Community 140 - "panels-test.cjs"
Cohesion: 0.10
Nodes (10): assert, fs, NOOP_API, PANELS, path, R, selectorsOf(), SHARED_TOKENS (+2 more)

### Community 141 - "mdsw.js"
Cohesion: 0.25
Nodes (13): cmd(), cmdR(), esc(), ethLockAcquire(), ethLockInit(), ethLockRelease(), kvDel(), kvGet() (+5 more)

### Community 142 - "casinoart.js"
Cohesion: 0.44
Nodes (8): clear(), confetti(), drawCoin(), drawDie(), drawWheel(), easeOut(), fit(), spinner()

### Community 143 - "minimaCore Desktop 0.16.39 activity parity review"
Cohesion: 0.15
Nodes (13): Findings addressed, MAJOR — incomplete sync or storage errors presented as completion, MAJOR — inferred confirmations and false creation failures, MAJOR — missing records and device-dependent transaction times, MAJOR — public transactions missing on other wallets, MAJOR — receipt identity lost during mining, minimaCore Desktop 0.16.39 activity parity review, Packaged validation (+5 more)

### Community 144 - "dependencies"
Cohesion: 0.22
Nodes (9): libsodium-wrappers, dependencies, libsodium-wrappers, qrcode-generator, @silentbot1/nat-api, sql.js, qrcode-generator, @silentbot1/nat-api (+1 more)

### Community 145 - "atomix/service.js"
Cohesion: 0.56
Nodes (8): configureEngines(), getBalances(), log(), logOnce(), notifyLog(), poll(), reloadShared(), tryBoot()

### Community 146 - "Review — minimaCore Desktop 0.16.87"
Cohesion: 0.20
Nodes (7): Hunk classification — the claim this release rests on, Keeping it byte-identical, Not done here, Review — minimaCore Desktop 0.16.87, Two traps in the catch-up itself, Validation, Why this was necessary

### Community 147 - "gated"
Cohesion: 0.31
Nodes (9): clearWatchdog(), forceReleaseActiveSign(), gated(), pendingCount(), releaseGlobalSignLock(), releaseSign(), scheduleWatchdog(), startNextSign() (+1 more)

### Community 148 - "el"
Cohesion: 0.15
Nodes (32): appendTerm(), copy(), currentWwMode(), drawQR(), el(), ewConfirmSend(), ewEthIcon(), ewReceive() (+24 more)

### Community 150 - "createAnchor"
Cohesion: 0.32
Nodes (8): acceptMid(), createAnchor(), effLevel(), fmtMid(), isMarketFed(), market(), marketFresh(), refreshMarket()

### Community 151 - "Open-offer keepalive — APK 0.7.2 / MDS 2.9.2 / desktop integration branch"
Cohesion: 0.29
Nodes (5): Cause and evidence, Open-offer keepalive — APK 0.7.2 / MDS 2.9.2 / desktop integration branch, Parity and validation, Reused implementation and guardrails, Casino timeout / My Bets parity handoff

### Community 152 - "Code Review"
Cohesion: 0.33
Nodes (5): Code Review, Findings addressed before commit, Summary, Validation and limits, Verdict

### Community 153 - "User instructions — AUTHORITATIVE. These override default behavior and must be followed exactly."
Cohesion: 0.40
Nodes (4): RULE 0 (highest priority) — Follow the user's explicit instructions. They are BLOCKING, not suggestions., Signed mac releases (since 0.16.23, 2026-09-04), User instructions — AUTHORITATIVE. These override default behavior and must be followed exactly., Versioning guardrail — every code change ships with a version bump

### Community 156 - "resync-host-test.cjs"
Cohesion: 0.33
Nodes (5): assert, fs, path, ROOT, test

### Community 157 - "devDependencies"
Cohesion: 0.40
Nodes (5): electron, electron-builder, devDependencies, electron, electron-builder

### Community 158 - "swapExecute"
Cohesion: 0.50
Nodes (4): legHooks(), makerObj(), pollConfirm(), swapExecute()

## Knowledge Gaps
- **587 isolated node(s):** `What it does`, `Design`, `Develop`, `Build the .dmg`, `0.16.36` (+582 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **17 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `p()` connect `p` to `pandapools/service.js`, `main/casino.js`, `activity-chain.js`, `createPool`, `reserve-recovery.js`, `atomix.js`, `pools.js`, `swapExecute`, `pandapools.js`, `vestr.js`, `peg.js`, `renderer/casino.js`, `s`, `d`, `ethSendReview`, `rpcCall`, `k`, `init`, `actionOnPool`, `"node_modules/bn.js/lib/bn.js"`?**
  _High betweenness centrality (0.194) - this node is a cross-community bridge._
- **Why does `k()` connect `k` to `config.js`, `ui.js`, `pandapools/service.js`, `node-manager.js`, `config-keys-test.cjs`, `activity-chain.js`, `curve.js`, `config.js`, `showTokenDetail`, `reserve-recovery.js`, `atomix/service.js`, `d`, `store.js`?**
  _High betweenness centrality (0.138) - this node is a cross-community bridge._
- **Why does `s()` connect `s` to `pandapools.js`, `k`, `init`, `activity-chain.js`, `otc.js`, `"node_modules/bn.js/lib/bn.js"`, `atomix-ui.js`, `createAnchor`, `p`, `settle.js`?**
  _High betweenness centrality (0.091) - this node is a cross-community bridge._
- **Are the 30 inferred relationships involving `p()` (e.g. with `ingest()` and `createContext()`) actually correct?**
  _`p()` has 30 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `esc()` (e.g. with `app.js` and `axSwapRows()`) actually correct?**
  _`esc()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `What it does`, `Design`, `Develop` to the rest of the system?**
  _587 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `poolmgr.js` be split into smaller, more focused modules?**
  _Cohesion score 0.12307692307692308 - nodes in this community are weakly interconnected._