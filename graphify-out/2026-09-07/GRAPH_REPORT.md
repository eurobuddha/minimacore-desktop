# Graph Report - desktop/minimacore-desktop  (2026-09-04)

## Corpus Check
- 105 files · ~282,203 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2297 nodes · 5230 edges · 116 communities (106 shown, 10 thin omitted)
- Extraction: 90% EXTRACTED · 10% INFERRED · 0% AMBIGUOUS · INFERRED: 498 edges (avg confidence: 0.6)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `0f45eb7f`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- app.js
- poolmgr.js
- ui.js
- casino.js
- mail.js
- AtomiX OTC Deals
- shop.js
- pandapools/service.js
- renderAxSwap
- Packaging File Globs
- casinoActivity
- history-db.js
- atomix.js
- renderSettings
- el
- p
- responder.js
- store.js
- settle.js
- casino/engine.js
- swapdb.js
- webwallet.js
- esc
- mailcrypto.js
- pandapools/decimal.js
- htlc.js
- config.js
- mail-store.js
- shop-store.js
- toast
- renderShopBrowse
- elliptic.js
- vestr.js
- renderMailCurrent
- main.js
- portmap.js
- pandapools.js
- NodeManager
- peg.js
- Tab Navigation (data-view tab bar)
- maker.js
- Changelog
- curve.js
- lib/decimal.js
- lib/engine.js
- Rpc
- orderbook.js
- d
- mdsw.js
- s
- netfetch.js
- ethhtlc.js
- order.js
- casino/service.js
- build
- init
- ethTokensLoad
- ethwallet.js
- tokenicons.js
- package.json
- ethSendReview
- hex.js
- minimaCore Desktop App
- identity.js
- identitywatch.js
- book.js
- NPM Scripts
- form
- abi.js
- ethtx.js
- history-store.js
- finalise
- history.js
- mac
- dependencies
- ax_eth.js
- swapplan.js
- wallet.js
- atomix/service.js
- casino-glue-test.js
- withTimeout
- nodeCmd
- digitsToString
- trading.js
- parseOther
- minimaCore Desktop (macOS)
- atomix-s2-gate.js
- Terminal IDE-style Parameter Autocomplete
- "node_modules/tweetnacl/nacl-fast.js"
- pandapools/loader.js
- Minima Blockchain Brand Identity
- atomix-boot-gate.js
- boot.js
- flow.js
- getPi
- router.js
- rpcCall
- inspect.js
- prng.js
- "node_modules/bn.js/lib/bn.js"
- cosine
- User instructions — AUTHORITATIVE. These override default behavior and must be followed exactly.
- log
- App Shell (header, tabs, views)
- Minima Tile Icon (SVG)
- install.sh
- pre-commit
- preload.js
- atomix-parity-check.sh
- casino-parity-check.sh

## God Nodes (most connected - your core abstractions)
1. `el()` - 136 edges
2. `esc()` - 97 edges
3. `toast()` - 76 edges
4. `p()` - 55 edges
5. `files` - 44 edges
6. `el()` - 41 edges
7. `AX()` - 36 edges
8. `Changelog` - 26 edges
9. `render()` - 24 edges
10. `renderSettings()` - 24 edges

## Surprising Connections (you probably didn't know these)
- `Bundled JRE via jlink` --semantically_similar_to--> `Bundled JRE (no system Java needed)`  [INFERRED] [semantically similar]
  .github/workflows/desktop-build.yml → README.md
- `RULE 0 — Explicit Instructions Are Blocking` --semantically_similar_to--> `Byte-Identical MDS Engine Reuse Rule`  [INFERRED] [semantically similar]
  CLAUDE.md → CHANGELOG.md
- `Tab Navigation (data-view tab bar)` --references--> `ETH Wallet Tab`  [INFERRED]
  renderer/index.html → CHANGELOG.md
- `Tab Navigation (data-view tab bar)` --references--> `Web Wallet Tab`  [INFERRED]
  renderer/index.html → CHANGELOG.md
- `Tab Navigation (data-view tab bar)` --references--> `miniMall Shop Tab`  [INFERRED]
  renderer/index.html → CHANGELOG.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Winternitz Key-Reuse Defense Layers** — changelog_winternitz_key_reuse, changelog_wallet_signdata_fix, changelog_serial_signing_gate, changelog_opkuses_backup_restore, changelog_owner_key_hunt_ledger [EXTRACTED 1.00]
- **Shared-Covenant Balance Pollution Fix (trackall:false + hygiene sweep)** — changelog_trackall_pollution_trap, changelog_launch_hygiene_sweep, changelog_pandapools_module, changelog_casino_module [EXTRACTED 1.00]
- **Terminal Autocomplete Stack (registry engine + dropdown UI)** — changelog_terminal_autocomplete, renderer_index_terminal_view, renderer_index_autocomplete_dropdown [INFERRED 0.95]
- **Cross-platform Build and Release Pipeline** — github_workflows_desktop_build_workflow, github_workflows_desktop_build_build_matrix, github_workflows_desktop_build_jlink_jre, readme_bundled_jre [INFERRED 0.85]

## Communities (116 total, 10 thin omitted)

### Community 0 - "app.js"
Cohesion: 0.03
Nodes (93): RFC-1918, absCmp(), appendLog(), applyTheme(), axEditInput(), axEditRow(), axFld(), axGenField() (+85 more)

### Community 1 - "poolmgr.js"
Cohesion: 0.07
Nodes (67): address(), send(), addAnnounceState(), advanceKeyUses(), beginHunt(), buildAndPost(), buildCreate(), buildMigrate() (+59 more)

### Community 2 - "ui.js"
Cohesion: 0.10
Nodes (68): activeSwap(), activityTab(), amtField(), banner(), bidiInput(), bootErrorCard(), ccy(), clean() (+60 more)

### Community 3 - "casino.js"
Cohesion: 0.06
Nodes (65): balance(), buildMds(), C(), cancel(), cgame(), claimTimeout(), cmnum(), cnorm() (+57 more)

### Community 4 - "mail.js"
Cohesion: 0.06
Nodes (48): addContact(), archivedThreads(), autoReplyTimes, backup, config, contacts(), crypto, currentBlock() (+40 more)

### Community 5 - "AtomiX OTC Deals"
Cohesion: 0.11
Nodes (50): accept(), addMsg(), allDeals(), apply(), applyPropose(), approxEq(), changed(), claimExecute() (+42 more)

### Community 6 - "shop.js"
Cohesion: 0.06
Nodes (42): advanceStatus(), capSeen(), coinAmount(), coinsAt(), config, crypto, emitter, EventEmitter (+34 more)

### Community 7 - "pandapools/service.js"
Cohesion: 0.11
Nodes (46): script(), annKeySvc(), cleanForeign(), covScript(), decCmp(), decDiv(), decSnap(), decSub() (+38 more)

### Community 8 - "renderAxSwap"
Cohesion: 0.11
Nodes (37): ax6(), axAgo(), axBestLine(), axCleanNum(), axDepthHalf(), axDepthRow(), axDoReview(), axDrawChart() (+29 more)

### Community 9 - "Packaging File Globs"
Cohesion: 0.05
Nodes (43): files, main/**, node_modules/abort-controller/**, node_modules/chrome-dgram/**, node_modules/cross-fetch-ponyfill/**, node_modules/cross-spawn/**, node_modules/data-uri-to-buffer/**, node_modules/debug/** (+35 more)

### Community 10 - "casinoActivity"
Cohesion: 0.10
Nodes (41): casinoActAppend(), casinoActClass(), casinoActivity(), casinoActPaint(), casinoBlock(), casinoCheckCreateConfirm(), casinoCheckTakeConfirm(), casinoCoinIsPayout() (+33 more)

### Community 11 - "history-db.js"
Cohesion: 0.09
Nodes (35): all(), { app }, bI(), clear(), count(), countSync(), dbPath(), ensureReady() (+27 more)

### Community 12 - "atomix.js"
Cohesion: 0.08
Nodes (34): buildMds(), { createContext }, emitter, ETH_FEE_MULT, ETH_RPC_FILE(), ETH_SEED_TOKENS, ethPrivateHost(), ethRpcLoad() (+26 more)

### Community 13 - "renderSettings"
Cohesion: 0.10
Nodes (41): applyIcon(), axReceive(), balBreakdown(), balCardHtml(), casinoAgeGate(), cmd(), copy(), decSub() (+33 more)

### Community 14 - "el"
Cohesion: 0.09
Nodes (45): appendTerm(), boot(), currentWwMode(), drawQR(), el(), initTabScroll(), onAtomixUpdate(), onEthWalletUpdate() (+37 more)

### Community 15 - "p"
Cohesion: 0.15
Nodes (35): AX(), balances(), book(), bookScan(), coins(), computeQuote(), ethBalances(), ethWallet() (+27 more)

### Community 16 - "responder.js"
Cohesion: 0.14
Nodes (33): acceptTakerBuyMinima(), acceptTakerSellMinima(), addDec(), addIncoming(), cpBurstFull(), decimalsOf(), doScanIncoming(), ensureAllowance() (+25 more)

### Community 17 - "store.js"
Cohesion: 0.10
Nodes (27): actRecord(), actRecordFailed(), actSetStatus(), confirmed(), create(), ensureHistory(), ensureOwnPools(), esc() (+19 more)

### Community 18 - "settle.js"
Cohesion: 0.17
Nodes (32): activeSwaps(), amountTokenOk(), broadcastEthRefund(), broadcastEthWithdraw(), checkCanSwapCoin(), checkEthContractBody(), checkEthContractFor(), checkExpiredMinima() (+24 more)

### Community 19 - "casino/engine.js"
Cohesion: 0.18
Nodes (31): addMultipleInputs(), cancelBet(), claimTimeout(), coinsAtContract(), createBet(), decAdd(), decCmp(), decSub() (+23 more)

### Community 20 - "swapdb.js"
Cohesion: 0.20
Nodes (31): activeHashes(), allSwaps(), deleteSwap(), esc(), executedTrades(), getEvents(), getRequest(), getSecret() (+23 more)

### Community 21 - "webwallet.js"
Cohesion: 0.13
Nodes (32): myFreeCoins(), scanAllHtlcCoins(), ackKeyuses(), derive(), emitter, entryFor(), { EventEmitter }, fs (+24 more)

### Community 22 - "esc"
Cohesion: 0.09
Nodes (38): axChip(), axCoinDump(), axDealRow(), axLevelRow(), esc(), ewConfirmSend(), ewEthIcon(), ewExportKey() (+30 more)

### Community 23 - "mailcrypto.js"
Cohesion: 0.10
Nodes (22): cat(), hkdfSha256(), hmacSha256(), RFC-5869, seal(), sealOpen(), boxPkOf(), crypto (+14 more)

### Community 24 - "pandapools/decimal.js"
Cohesion: 0.07
Nodes (5): hypot(), max(), maxOrMin(), min(), sqrt()

### Community 25 - "htlc.js"
Cohesion: 0.19
Nodes (24): claim(), coinAmount(), deleteTxn(), grain(), isDecimal(), isHex(), isHexOrMinima(), loadKeys() (+16 more)

### Community 26 - "config.js"
Cohesion: 0.13
Nodes (25): { app, safeStorage }, configPath(), crypto, DEFAULTS, deleteSecret(), effectiveParams(), encAvailable(), { execFileSync } (+17 more)

### Community 27 - "mail-store.js"
Cohesion: 0.16
Nodes (28): addContact(), addMessage(), all(), allThreadRows(), { app }, archivedSet(), archivedThreads(), clear() (+20 more)

### Community 28 - "shop-store.js"
Cohesion: 0.15
Nodes (28): addChat(), { app }, chat(), clear(), decAdd(), decCmp(), decGte(), deleteShop() (+20 more)

### Community 29 - "toast"
Cohesion: 0.08
Nodes (50): addPeerContact(), applyPpDir(), axExportKey(), axOtcPropose(), axSendDialog(), axSwitchCurrency(), axWelcome(), confirmPpWithdraw() (+42 more)

### Community 30 - "renderShopBrowse"
Cohesion: 0.18
Nodes (15): renderMiniMall(), renderShopBrowse(), renderShopStudio(), renderShopSub(), shopCapOf(), shopCartTotal(), shopDoPay(), shopNormalizeShipping() (+7 more)

### Community 31 - "elliptic.js"
Cohesion: 0.06
Nodes (6): "node_modules/elliptic/lib/elliptic/ec/index.js"(), "node_modules/elliptic/lib/elliptic/ec/key.js"(), "node_modules/hash.js/lib/hash/sha/256.js"(), "node_modules/hash.js/lib/hash/sha/512.js"(), client, priv()

### Community 32 - "vestr.js"
Cohesion: 0.17
Nodes (24): blockHeightForDate(), calculate(), coinAmount(), collect(), contractFromCoin(), create(), crypto, emitter (+16 more)

### Community 33 - "renderMailCurrent"
Cohesion: 0.17
Nodes (29): applyMailUpdate(), confirmDeleteContact(), confirmDeleteThread(), contactMenu(), doArchive(), mailAvatar(), mailDayLabel(), mailHeader() (+21 more)

### Community 34 - "main.js"
Cohesion: 0.08
Nodes (22): { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell, Notification, session, clipboard }, atomix, casino, config, createWindow(), ethwallet, faucet, fs (+14 more)

### Community 35 - "portmap.js"
Cohesion: 0.15
Nodes (12): defaultRoute(), dgram, EventEmitter, { execFile }, isPrivateIp(), RFC-1918, lanIp(), os (+4 more)

### Community 36 - "pandapools.js"
Cohesion: 0.09
Nodes (23): acceptMid(), { app }, config, createAnchor(), { createContext, ALL_FILES }, effLevel(), emitter, EventEmitter (+15 more)

### Community 38 - "peg.js"
Cohesion: 0.15
Nodes (17): ingest(), poll(), price(), reconcileSpent(), ageMs(), applyPeg(), commitMexc(), effectiveLevel() (+9 more)

### Community 39 - "Tab Navigation (data-view tab bar)"
Cohesion: 0.11
Nodes (22): AtomiX Atomic-Swap Tab, Balances Full Breakdown + Untruncated Tagged Coin List, Byte-Identical MDS Engine Reuse Rule, ZeroEdge Casino Tab (P2PChance), ETH Wallet Tab, Transaction History (SQLite, locally owned), In-app Node Jar Updater Removal, Launch Hygiene Sweep (cleanForeign) (+14 more)

### Community 40 - "maker.js"
Cohesion: 0.20
Nodes (19): buildOrder(), clampAsks(), currentOrder(), doLoadConfig(), doPublish(), keepAlive(), kvKey(), loadConfig() (+11 more)

### Community 41 - "Changelog"
Cohesion: 0.07
Nodes (26): [0.11.x] — Vestr + AtomiX preimage fix, [0.13.0] — cross-platform builds, [0.15.x] — Web Wallet + AtomiX CSV + clipboard, [0.16.0] – [0.16.1] — ETH Wallet tab, [0.16.11] — PandaPools: stop the runaway owner-key hunt (bounded, remembered, provable), [0.16.12] — SECURITY: bundled node jar carries the Wallet.signData fix; in-app jar updater removed, [0.16.13] — bundled node moves to 1.1.2.4 (upstream super-parent fix), [0.16.14] — Terminal: IDE-style parameter autocomplete (port from Terminal IDE) (+18 more)

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
Cohesion: 0.19
Nodes (23): "node_modules/elliptic/lib/elliptic/curve/base.js"(), "node_modules/elliptic/lib/elliptic/curve/edwards.js"(), "node_modules/elliptic/lib/elliptic/curve/short.js"(), feeGrowth(), k(), block(), build(), cell() (+15 more)

### Community 48 - "mdsw.js"
Cohesion: 0.25
Nodes (13): cmd(), cmdR(), esc(), ethLockAcquire(), ethLockInit(), ethLockRelease(), kvDel(), kvGet() (+5 more)

### Community 49 - "s"
Cohesion: 0.14
Nodes (15): "node_modules/elliptic/lib/elliptic/ec/signature.js"(), "node_modules/hash.js/lib/hash/ripemd.js"(), "node_modules/hash.js/lib/hash/sha/1.js"(), "node_modules/js-sha3/src/sha3.js"(), balance(), aggregateInfo(), createPreview(), D() (+7 more)

### Community 50 - "netfetch.js"
Cohesion: 0.21
Nodes (16): acquire(), dns, fetchJson(), getCapped(), http, https, ipBlocked(), isBlockedHost() (+8 more)

### Community 51 - "ethhtlc.js"
Cohesion: 0.14
Nodes (4): b32(), contractId(), make(), safeBig()

### Community 52 - "order.js"
Cohesion: 0.23
Nodes (14): canonicalJson(), effectiveAsks(), effectiveBids(), finite(), fromJson(), hasLiquidity(), isHex(), level() (+6 more)

### Community 53 - "casino/service.js"
Cohesion: 0.25
Nodes (13): cleanTracking(), doResolve(), doReveal(), extractResponse(), gameTypeName(), getState(), isMyKey(), miniNum() (+5 more)

### Community 54 - "build"
Cohesion: 0.12
Nodes (16): build, appId, extraResources, linux, nsis, productName, win, category (+8 more)

### Community 55 - "init"
Cohesion: 0.23
Nodes (15): actionOnPool(), advanceRestoredKeys(), backup(), closePool(), collectToWallet(), createPool(), deposit(), ensureOwnerKey() (+7 more)

### Community 56 - "ethTokensLoad"
Cohesion: 0.26
Nodes (14): ETH_TOKENS_FILE(), ethAddToken(), ethCleanSymbol(), ethDecodeSymbol(), ethRemoveToken(), ethTokenBy(), ethTokenMeta(), ethTokens() (+6 more)

### Community 57 - "ethwallet.js"
Cohesion: 0.14
Nodes (3): atomix, emitter, { EventEmitter }

### Community 58 - "tokenicons.js"
Cohesion: 0.26
Nodes (12): b64encode(), first(), hsl(), identiconDataUri(), meta(), metaField(), pickIconField(), resolveIcon() (+4 more)

### Community 59 - "package.json"
Cohesion: 0.15
Nodes (12): electron, electron-builder, author, description, devDependencies, electron, electron-builder, license (+4 more)

### Community 60 - "ethSendReview"
Cohesion: 0.24
Nodes (12): ensureRpcOverride(), ethAddrChecksumOk(), ethAmbiguousBroadcast(), ethCapGas(), ethGasNow(), ethGasScaledRpc(), ethReserveGp(), ethSendExecute() (+4 more)

### Community 62 - "minimaCore Desktop App"
Cohesion: 0.18
Nodes (11): Cross-platform Build Matrix (mac/win/linux), Bundled JRE via jlink, Desktop Build GitHub Actions Workflow, Bundled JRE (no system Java needed), Design.java CSS Port (native look), First-run Node Wizard, minimaCore Desktop App, Node Updater (sha256-verified jar swap) (+3 more)

### Community 63 - "identity.js"
Cohesion: 0.31
Nodes (9): boxPkOf(), canonicalId(), fromSeed(), isValidPublicId(), makeIdentity(), open(), seal(), seedBytes() (+1 more)

### Community 64 - "identitywatch.js"
Cohesion: 0.29
Nodes (6): check(), checkEth(), checkMinima(), halted(), raiseOrClear(), summary()

### Community 66 - "book.js"
Cohesion: 0.22
Nodes (11): derivePools(), done(), finishScan(), fund(), gatherOwned(), gatherRegistry(), group(), parseScripts() (+3 more)

### Community 67 - "NPM Scripts"
Cohesion: 0.18
Nodes (11): scripts, dist, dist:linux, dist:mac, dist:win, gate:atomix, start, test:atomix (+3 more)

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

### Community 73 - "history.js"
Cohesion: 0.38
Nodes (8): coins(), entryFrom(), finish(), firstAddr(), markDone(), page(), shrink(), sync()

### Community 74 - "mac"
Cohesion: 0.20
Nodes (10): mac, NSCameraUsageDescription, category, entitlements, entitlementsInherit, extendInfo, hardenedRuntime, icon (+2 more)

### Community 75 - "dependencies"
Cohesion: 0.22
Nodes (9): libsodium-wrappers, dependencies, libsodium-wrappers, qrcode-generator, @silentbot1/nat-api, sql.js, qrcode-generator, @silentbot1/nat-api (+1 more)

### Community 76 - "ax_eth.js"
Cohesion: 0.47
Nodes (8): addressFromPriv(), intBytes(), keccakBytes(), rlpBytes(), rlpLenPrefix(), rlpList(), signLegacyTx(), toBigHex()

### Community 77 - "swapplan.js"
Cohesion: 0.53
Nodes (8): buildSweepPlan(), ceilUsdt(), computeMinima(), computeUsdt(), legMinima(), num(), pstr(), sweepDepthMinima()

### Community 78 - "wallet.js"
Cohesion: 0.33
Nodes (5): checkSend(), gasReserveWei(), isEthAddr(), maxEthSendWei(), validDec()

### Community 79 - "atomix/service.js"
Cohesion: 0.56
Nodes (8): configureEngines(), getBalances(), log(), logOnce(), notifyLog(), poll(), reloadShared(), tryBoot()

### Community 80 - "casino-glue-test.js"
Cohesion: 0.22
Nodes (6): casino, cfg, mem, OPEN_BET, path, sent

### Community 81 - "withTimeout"
Cohesion: 0.46
Nodes (8): jvm(), makerAvail(), makerPublish(), makerSave(), makerWithdraw(), switchCurrency(), toVm(), withTimeout()

### Community 82 - "nodeCmd"
Cohesion: 0.20
Nodes (12): buildMds(), currentBlock(), flush(), importCoin(), invalidate(), nodeCmd(), restoreOne(), runCycle() (+4 more)

### Community 83 - "digitsToString"
Cohesion: 0.32
Nodes (8): checkInt32(), convertBase(), digitsToString(), finiteToString(), getZeroString(), nonFiniteToString(), random(), toStringBinary()

### Community 86 - "parseOther"
Cohesion: 0.33
Nodes (7): clone(), getBase10Exponent(), intPow(), isDecimalInstance(), parseDecimal(), parseOther(), truncate()

### Community 87 - "minimaCore Desktop (macOS)"
Cohesion: 0.29
Nodes (6): Build the .dmg, Design, Develop, minimaCore Desktop (macOS), Notes / TODO, What it does

### Community 88 - "atomix-s2-gate.js"
Cohesion: 0.29
Nodes (4): { execFile }, fs, os, path

### Community 89 - "Terminal IDE-style Parameter Autocomplete"
Cohesion: 0.40
Nodes (6): minimaCore Desktop Changelog, Terminal IDE-style Parameter Autocomplete, Pre-commit Version-Bump Hook (.githooks/pre-commit), Versioning Guardrail — Every Code Change Ships a Version Bump, Terminal Autocomplete Dropdown (termSug/termHint), Terminal View (termOut/termIn)

### Community 90 - ""node_modules/tweetnacl/nacl-fast.js""
Cohesion: 0.33
Nodes (3): "node_modules/hmac-drbg/lib/hmac-drbg.js"(), "node_modules/tweetnacl/nacl-fast.js"(), add()

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

### Community 102 - "rpcCall"
Cohesion: 0.16
Nodes (13): { app }, config, EventEmitter, fs, path, portmap, { rpcCall }, { spawn } (+5 more)

### Community 104 - "prng.js"
Cohesion: 0.83
Nodes (3): init(), initBrowser(), initService()

### Community 106 - ""node_modules/bn.js/lib/bn.js""
Cohesion: 0.50
Nodes (4): "node_modules/bn.js/lib/bn.js"(), div(), mod(), pow()

### Community 107 - "cosine"
Cohesion: 0.67
Nodes (4): cosine(), sine(), taylorSeries(), tinyPow()

### Community 109 - "User instructions — AUTHORITATIVE. These override default behavior and must be followed exactly."
Cohesion: 0.50
Nodes (3): RULE 0 (highest priority) — Follow the user's explicit instructions. They are BLOCKING, not suggestions., User instructions — AUTHORITATIVE. These override default behavior and must be followed exactly., Versioning guardrail — every code change ships with a version bump

### Community 112 - "log"
Cohesion: 0.67
Nodes (3): log(), log10(), log2()

### Community 113 - "App Shell (header, tabs, views)"
Cohesion: 0.67
Nodes (3): App Shell (header, tabs, views), Renderer Content-Security-Policy, First-Run Node Setup Wizard

### Community 114 - "Minima Tile Icon (SVG)"
Cohesion: 0.67
Nodes (3): Theme-Adaptive Icon via currentColor, Minima Brand Logomark (angular M), Minima Tile Icon (SVG)

## Knowledge Gaps
- **368 isolated node(s):** `install.sh script`, `{ EventEmitter }`, `path`, `fs`, `{ rpcCall }` (+363 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **10 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `p()` connect `p` to `vestr.js`, `poolmgr.js`, `casino.js`, `peg.js`, `pandapools/service.js`, `rpcCall`, `"node_modules/bn.js/lib/bn.js"`, `casinoActivity`, `atomix.js`, `d`, `withTimeout`, `s`, `init`, `ethTokensLoad`, `"node_modules/tweetnacl/nacl-fast.js"`, `ethSendReview`, `toast`?**
  _High betweenness centrality (0.167) - this node is a cross-community bridge._
- **Why does `s()` connect `s` to `pandapools.js`, `AtomiX OTC Deals`, `renderAxSwap`, `"node_modules/bn.js/lib/bn.js"`, `d`, `settle.js`, `init`, `elliptic.js`?**
  _High betweenness centrality (0.094) - this node is a cross-community bridge._
- **Why does `k()` connect `d` to `ui.js`, `book.js`, `"node_modules/tweetnacl/nacl-fast.js"`, `pandapools/service.js`, `history.js`, `curve.js`, `renderSettings`, `atomix/service.js`, `store.js`, `config.js`, `elliptic.js`?**
  _High betweenness centrality (0.077) - this node is a cross-community bridge._
- **Are the 26 inferred relationships involving `p()` (e.g. with `ingest()` and `createContext()`) actually correct?**
  _`p()` has 26 INFERRED edges - model-reasoned connections that need verification._
- **What connects `install.sh script`, `{ EventEmitter }`, `path` to the rest of the system?**
  _368 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `app.js` be split into smaller, more focused modules?**
  _Cohesion score 0.0331140350877193 - nodes in this community are weakly interconnected._
- **Should `poolmgr.js` be split into smaller, more focused modules?**
  _Cohesion score 0.06627175120325805 - nodes in this community are weakly interconnected._