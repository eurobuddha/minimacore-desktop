# Graph Report - .  (2026-07-28)

## Corpus Check
- 99 files · ~242,048 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2054 nodes · 4686 edges · 104 communities (94 shown, 10 thin omitted)
- Extraction: 90% EXTRACTED · 10% INFERRED · 0% AMBIGUOUS · INFERRED: 473 edges (avg confidence: 0.6)
- Token cost: 137,514 input · 0 output

## Community Hubs (Navigation)
- Renderer App Shell
- Casino Module Core
- MinimaMail Backend
- AtomiX Inspect & Book Scan
- Minima HTLC Engine
- OTC Deal Engine
- Project Docs & Changelog
- MiniMall Shop & PIN Send
- Wallet & Pools UI Dialogs
- Build Packaging File Globs
- AtomiX Trading UI
- Casino UI
- History Database
- Mail & Contacts UI
- AtomiX Main Module
- AtomiX Take & Pool Manager
- Renderer Utility Helpers
- AtomiX Maker Editor UI
- AtomiX IPC API Facade
- AtomiX Swap Responder
- Casino Bet Engine
- Swap Settlement Engine
- Swap Database
- Mail Storage Layer
- Shop Storage Layer
- Bundled Elliptic Crypto
- PandaPools Main Module
- PandaPools Decimal Math
- App Config & Secrets
- Electron Main Process
- NAT Port Mapping
- Vestr Vesting Module
- PandaPools Store
- Market Price Feed & Peg
- AtomiX Maker Orders
- Mail Encryption (HKDF)
- PandaPools UI
- Shared Decimal Utilities
- Bundled Hash Libraries
- AMM Curve Quoting
- Swap Engine Core
- Ethereum RPC Client
- AtomiX Orderbook
- Network Fetch Guard
- Ethereum HTLC Contract
- MDS Command Wrapper
- Minima Node Manager
- Order Model
- Web Wallet UI
- ERC20 Token Registry
- Casino Service
- ETH Wallet Module
- NodeManager Class
- Pool Lifecycle Actions
- Package Metadata
- ETH Gas & Send Logic
- Hex & Blake Utilities
- Vestr UI
- Identity Keys
- Windows Build Config
- Sodium Crypto Wrapper
- Ethereum ABI Encoder
- ETH Transaction Queue
- Elliptic Curve Internals
- History Store
- Decimal Rounding Internals
- macOS Build Config
- NPM Scripts
- Runtime Dependencies
- ETH Tx Signing (RLP)
- Swap Sweep Planner
- ETH Wallet Sends
- AtomiX Service Boot
- Casino Glue Test
- Maker UI Helpers
- Market Mid-Price Helpers
- ETH Wallet Unit Tests
- Trading Pair State
- Decimal String Conversion
- AtomiX S2 Gate Test
- NaCl & DRBG Bundles
- Decimal Parsing
- PandaPools VM Loader
- AtomiX Boot Gate Test
- Mail Boot & Identity
- Async Flow Helpers
- Decimal Trig Functions
- Pool Router
- Linux Build Config
- PRNG Init
- BigNumber (bn.js)
- Taylor Series Math
- Outline Logo & Branding
- Decimal Logarithms
- Decimal Max/Min
- Logo Mark & Palette
- Tile Icon Branding
- Sign Helpers
- Preload IPC Bridge
- AtomiX Parity Check
- Casino Parity Check

## God Nodes (most connected - your core abstractions)
1. `el()` - 132 edges
2. `esc()` - 96 edges
3. `toast()` - 75 edges
4. `p()` - 54 edges
5. `files` - 44 edges
6. `AX()` - 36 edges
7. `s()` - 25 edges
8. `renderSettings()` - 24 edges
9. `renderActive()` - 22 edges
10. `showConfirm()` - 22 edges

## Surprising Connections (you probably didn't know these)
- `Rule 0: Follow Explicit Instructions / Reuse Before Reinvent` --semantically_similar_to--> `AtomiX Atomic-Swap Module`  [INFERRED] [semantically similar]
  CLAUDE.md → CHANGELOG.md
- `"node_modules/hash.js/lib/hash/sha/512.js"()` --indirect_call--> `el()`  [INFERRED]
  main/atomix/vendor/elliptic.js → renderer/app.js
- `Bundled JRE via jlink` --semantically_similar_to--> `Bundled JRE (no system Java needed)`  [INFERRED] [semantically similar]
  .github/workflows/desktop-build.yml → README.md
- `Per-address WOTS Key-Uses Safety Checker (0.7.1)` --semantically_similar_to--> `Wallet Seed Onboarding (megammrsync restore + key-uses attestation)`  [INFERRED] [semantically similar]
  CHANGELOG.md → README.md
- `Web Wallet (MegaMMR-gated wallet-from-seed)` --semantically_similar_to--> `Wallet Seed Onboarding (megammrsync restore + key-uses attestation)`  [INFERRED] [semantically similar]
  CHANGELOG.md → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Wallet Module Suite (tab-per-module shell)** — renderer_index_shell, changelog_pandapools, changelog_atomix, changelog_eth_wallet, changelog_minimall, changelog_vestr, changelog_minimamail, changelog_web_wallet [INFERRED 0.85]
- **Byte-identical Engine Reuse / 3-way Interop Pattern** — changelog_pandapools, changelog_atomix, changelog_minimall, changelog_vestr, changelog_eth_wallet [EXTRACTED 1.00]
- **Cross-platform Build and Release Pipeline** — github_workflows_desktop_build_workflow, github_workflows_desktop_build_build_matrix, github_workflows_desktop_build_jlink_jre, changelog_cross_platform_builds, readme_bundled_jre [INFERRED 0.85]

## Communities (104 total, 10 thin omitted)

### Community 0 - "Renderer App Shell"
Cohesion: 0.04
Nodes (92): absCmp(), appendLog(), applyMailUpdate(), applyTheme(), axStatusCache, BAL_BY_TID, CASINO_PIP, CASINO_PRESETS (+84 more)

### Community 1 - "Casino Module Core"
Cohesion: 0.06
Nodes (65): balance(), buildMds(), C(), cancel(), cgame(), claimTimeout(), cmnum(), cnorm() (+57 more)

### Community 2 - "MinimaMail Backend"
Cohesion: 0.06
Nodes (48): addContact(), archivedThreads(), autoReplyTimes, backup, config, contacts(), crypto, currentBlock() (+40 more)

### Community 3 - "AtomiX Inspect & Book Scan"
Cohesion: 0.07
Nodes (50): statusDetail(), tok(), derivePools(), finishScan(), gatherOwned(), gatherRegistry(), group(), parseScripts() (+42 more)

### Community 4 - "Minima HTLC Engine"
Cohesion: 0.08
Nodes (51): claim(), coinAmount(), deleteTxn(), grain(), loadKeys(), lock(), lockFromCoins(), maybeGrain() (+43 more)

### Community 5 - "OTC Deal Engine"
Cohesion: 0.11
Nodes (50): accept(), addMsg(), allDeals(), apply(), applyPropose(), approxEq(), changed(), claimExecute() (+42 more)

### Community 6 - "Project Docs & Changelog"
Cohesion: 0.05
Nodes (45): AtomiX Atomic-Swap Module, minimaCore Desktop Changelog (0.1.x - 0.16.2), Clipboard-via-Main-Process Fix (0.15.8), Individual|Combined Pool View Toggle (0.16.2), Cross-platform Builds (0.13.0), ETH Wallet Tab, ETH Wallet Fund-Safety Review Fixes (0.16.1), HTLC Preimage Verification Fix (0.11.2) (+37 more)

### Community 7 - "MiniMall Shop & PIN Send"
Cohesion: 0.08
Nodes (35): pinMinimaSend(), advanceStatus(), capSeen(), coinAmount(), coinsAt(), config, crypto, emitter (+27 more)

### Community 8 - "Wallet & Pools UI Dialogs"
Cohesion: 0.10
Nodes (46): amt(), t(), applyPpDir(), axExportKey(), axSendDialog(), axWelcome(), confirmPpWithdraw(), doPpCollect() (+38 more)

### Community 9 - "Build Packaging File Globs"
Cohesion: 0.05
Nodes (43): files, main/**, node_modules/abort-controller/**, node_modules/chrome-dgram/**, node_modules/cross-fetch-ponyfill/**, node_modules/cross-spawn/**, node_modules/data-uri-to-buffer/**, node_modules/debug/** (+35 more)

### Community 10 - "AtomiX Trading UI"
Cohesion: 0.09
Nodes (42): ax6(), axAgo(), axBestLine(), axChip(), axCleanNum(), axDealRow(), axDepthHalf(), axDepthRow() (+34 more)

### Community 11 - "Casino UI"
Cohesion: 0.10
Nodes (41): casinoActAppend(), casinoActClass(), casinoActivity(), casinoActPaint(), casinoBlock(), casinoCheckCreateConfirm(), casinoCheckTakeConfirm(), casinoCoinIsPayout() (+33 more)

### Community 12 - "History Database"
Cohesion: 0.09
Nodes (35): all(), { app }, bI(), clear(), count(), countSync(), dbPath(), ensureReady() (+27 more)

### Community 13 - "Mail & Contacts UI"
Cohesion: 0.13
Nodes (40): addPeerContact(), axOtcPropose(), compressImage(), confirmDeleteContact(), confirmDeleteThread(), contactMenu(), doArchive(), doMailBackup() (+32 more)

### Community 14 - "AtomiX Main Module"
Cohesion: 0.08
Nodes (35): allowedUrl(), buildMds(), { createContext }, emitter, ETH_FEE_MULT, ETH_RPC_FILE(), ETH_SEED_TOKENS, ethPrivateHost() (+27 more)

### Community 15 - "AtomiX Take & Pool Manager"
Cohesion: 0.13
Nodes (36): address(), send(), addAnnounceState(), buildAndPost(), buildCreate(), buildMigrate(), buildRouted(), close() (+28 more)

### Community 16 - "Renderer Utility Helpers"
Cohesion: 0.11
Nodes (39): appendTerm(), applyIcon(), balCardHtml(), casinoAgeGate(), cmd(), copy(), decSub(), drawQR() (+31 more)

### Community 17 - "AtomiX Maker Editor UI"
Cohesion: 0.08
Nodes (36): axCoinDump(), axEditInput(), axEditRow(), axFld(), axGenField(), axGenRow(), axLevelRow(), axMakerEditor() (+28 more)

### Community 18 - "AtomiX IPC API Facade"
Cohesion: 0.15
Nodes (35): AX(), balances(), book(), bookScan(), coins(), computeQuote(), ethBalances(), ethWallet() (+27 more)

### Community 19 - "AtomiX Swap Responder"
Cohesion: 0.14
Nodes (32): acceptTakerBuyMinima(), acceptTakerSellMinima(), addDec(), addIncoming(), cpBurstFull(), decimalsOf(), doScanIncoming(), ensureAllowance() (+24 more)

### Community 20 - "Casino Bet Engine"
Cohesion: 0.18
Nodes (31): addMultipleInputs(), cancelBet(), claimTimeout(), coinsAtContract(), createBet(), decAdd(), decCmp(), decSub() (+23 more)

### Community 21 - "Swap Settlement Engine"
Cohesion: 0.17
Nodes (30): activeSwaps(), amountTokenOk(), broadcastEthRefund(), broadcastEthWithdraw(), checkCanSwapCoin(), checkEthContractBody(), checkEthContractFor(), checkExpiredMinima() (+22 more)

### Community 22 - "Swap Database"
Cohesion: 0.20
Nodes (31): activeHashes(), allSwaps(), deleteSwap(), esc(), executedTrades(), getEvents(), getRequest(), getSecret() (+23 more)

### Community 23 - "Mail Storage Layer"
Cohesion: 0.16
Nodes (28): addContact(), addMessage(), all(), allThreadRows(), { app }, archivedSet(), archivedThreads(), clear() (+20 more)

### Community 24 - "Shop Storage Layer"
Cohesion: 0.15
Nodes (28): addChat(), { app }, chat(), clear(), decAdd(), decCmp(), decGte(), deleteShop() (+20 more)

### Community 26 - "PandaPools Main Module"
Cohesion: 0.11
Nodes (23): { app }, buildMds(), config, { createContext, ALL_FILES }, currentBlock(), emitter, EventEmitter, { fetchJson } (+15 more)

### Community 28 - "App Config & Secrets"
Cohesion: 0.15
Nodes (25): { app, safeStorage }, configPath(), crypto, DEFAULTS, deleteSecret(), effectiveParams(), encAvailable(), { execFileSync } (+17 more)

### Community 29 - "Electron Main Process"
Cohesion: 0.08
Nodes (22): { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell, Notification, session, clipboard }, atomix, casino, config, createWindow(), ethwallet, faucet, fs (+14 more)

### Community 30 - "NAT Port Mapping"
Cohesion: 0.15
Nodes (12): defaultRoute(), dgram, EventEmitter, { execFile }, isPrivateIp(), RFC-1918, lanIp(), os (+4 more)

### Community 31 - "Vestr Vesting Module"
Cohesion: 0.17
Nodes (24): blockHeightForDate(), calculate(), coinAmount(), collect(), contractFromCoin(), create(), crypto, emitter (+16 more)

### Community 32 - "PandaPools Store"
Cohesion: 0.14
Nodes (17): actRecord(), actRecordFailed(), actSetStatus(), confirmed(), create(), esc(), init(), knownAddrsAdd() (+9 more)

### Community 33 - "Market Price Feed & Peg"
Cohesion: 0.15
Nodes (17): ingest(), poll(), price(), reconcileSpent(), ageMs(), applyPeg(), commitMexc(), effectiveLevel() (+9 more)

### Community 34 - "AtomiX Maker Orders"
Cohesion: 0.20
Nodes (19): buildOrder(), clampAsks(), currentOrder(), doLoadConfig(), doPublish(), keepAlive(), kvKey(), loadConfig() (+11 more)

### Community 35 - "Mail Encryption (HKDF)"
Cohesion: 0.15
Nodes (16): boxPkOf(), crypto, deriveIdentity(), deriveIdentityDomain(), hkdf32(), idBytes(), ikmFromSeed(), isValidPublicId() (+8 more)

### Community 36 - "PandaPools UI"
Cohesion: 0.13
Nodes (21): onPandapoolsUpdate(), PP_POOLS, ppActsHtml(), ppCombinedCards(), ppFeedHtml(), ppMineHtml(), ppNum(), ppPairRows() (+13 more)

### Community 37 - "Shared Decimal Utilities"
Cohesion: 0.25
Nodes (19): bumpFrac(), ceilDp(), divFloor(), floorDp(), formatUnits(), fromScaled(), grain6(), gt0() (+11 more)

### Community 38 - "Bundled Hash Libraries"
Cohesion: 0.12
Nodes (18): "node_modules/elliptic/lib/elliptic/ec/signature.js"(), "node_modules/hash.js/lib/hash/ripemd.js"(), "node_modules/hash.js/lib/hash/sha/1.js"(), "node_modules/js-sha3/src/sha3.js"(), balance(), aggregateInfo(), createPreview(), D() (+10 more)

### Community 39 - "AMM Curve Quoting"
Cohesion: 0.18
Nodes (16): aggregatePrice(), clampDec(), dec(), decOr(), fix(), funded(), grain(), isMinima() (+8 more)

### Community 40 - "Swap Engine Core"
Cohesion: 0.25
Nodes (16): baseSwap(), confirmMyLock(), ensureAllowance(), ethChainNow(), executeOtc(), isMyPublishKey(), normKey(), notifyChanged() (+8 more)

### Community 41 - "Ethereum RPC Client"
Cohesion: 0.23
Nodes (5): big(), hexToBig(), host(), Rpc(), snippet()

### Community 42 - "AtomiX Orderbook"
Cohesion: 0.22
Nodes (16): aggSide(), bestMakers(), cmp(), compareForFill(), isMine(), levelCap(), mergeFreshest(), nowMs() (+8 more)

### Community 43 - "Network Fetch Guard"
Cohesion: 0.21
Nodes (16): acquire(), dns, fetchJson(), getCapped(), http, https, ipBlocked(), isBlockedHost() (+8 more)

### Community 44 - "Ethereum HTLC Contract"
Cohesion: 0.14
Nodes (4): b32(), contractId(), make(), safeBig()

### Community 45 - "MDS Command Wrapper"
Cohesion: 0.27
Nodes (12): cmd(), cmdR(), esc(), ethLockAcquire(), ethLockInit(), ethLockRelease(), kvDel(), kvGet() (+4 more)

### Community 46 - "Minima Node Manager"
Cohesion: 0.15
Nodes (14): { app }, config, EventEmitter, fs, path, portmap, { rpcCall }, { spawn } (+6 more)

### Community 47 - "Order Model"
Cohesion: 0.24
Nodes (13): canonicalJson(), effectiveAsks(), effectiveBids(), finite(), fromJson(), hasLiquidity(), level(), make() (+5 more)

### Community 48 - "Web Wallet UI"
Cohesion: 0.20
Nodes (15): boot(), currentWwMode(), initTabScroll(), onWebWalletUpdate(), positionTabInk(), renderWebWallet(), renderWwGate(), renderWwUnlock() (+7 more)

### Community 49 - "ERC20 Token Registry"
Cohesion: 0.26
Nodes (14): ETH_TOKENS_FILE(), ethAddToken(), ethCleanSymbol(), ethDecodeSymbol(), ethRemoveToken(), ethTokenBy(), ethTokenMeta(), ethTokens() (+6 more)

### Community 50 - "Casino Service"
Cohesion: 0.29
Nodes (11): doResolve(), doReveal(), extractResponse(), gameTypeName(), getState(), isMyKey(), miniNum(), pickLbl() (+3 more)

### Community 51 - "ETH Wallet Module"
Cohesion: 0.14
Nodes (3): atomix, emitter, { EventEmitter }

### Community 53 - "Pool Lifecycle Actions"
Cohesion: 0.25
Nodes (14): actionOnPool(), backup(), closePool(), collectToWallet(), createPool(), deposit(), ensureOwnerKey(), init() (+6 more)

### Community 54 - "Package Metadata"
Cohesion: 0.15
Nodes (12): electron, electron-builder, author, description, devDependencies, electron, electron-builder, license (+4 more)

### Community 55 - "ETH Gas & Send Logic"
Cohesion: 0.24
Nodes (12): ensureRpcOverride(), ethAddrChecksumOk(), ethAmbiguousBroadcast(), ethCapGas(), ethGasNow(), ethGasScaledRpc(), ethReserveGp(), ethSendExecute() (+4 more)

### Community 57 - "Vestr UI"
Cohesion: 0.30
Nodes (12): onVestrUpdate(), renderVestr(), renderVestrCalc(), renderVestrCreate(), renderVestrList(), renderVestrSub(), VESTR_GRACE, vestrDoCollect() (+4 more)

### Community 58 - "Identity Keys"
Cohesion: 0.31
Nodes (9): boxPkOf(), canonicalId(), fromSeed(), isValidPublicId(), makeIdentity(), open(), seal(), seedBytes() (+1 more)

### Community 59 - "Windows Build Config"
Cohesion: 0.18
Nodes (11): build, appId, extraResources, nsis, productName, win, allowToChangeInstallationDirectory, oneClick (+3 more)

### Community 60 - "Sodium Crypto Wrapper"
Cohesion: 0.27
Nodes (6): cat(), hkdfSha256(), hmacSha256(), RFC-5869, seal(), sealOpen()

### Community 61 - "Ethereum ABI Encoder"
Cohesion: 0.47
Nodes (9): decode(), encAddr(), encBool(), encBytes32(), encodeCall(), encUint(), pad64(), selector() (+1 more)

### Community 62 - "ETH Transaction Queue"
Cohesion: 0.33
Nodes (7): acquire(), busyErr(), doSend(), pump(), release(), send(), slot()

### Community 63 - "Elliptic Curve Internals"
Cohesion: 0.20
Nodes (9): "node_modules/elliptic/lib/elliptic/curve/base.js"(), "node_modules/elliptic/lib/elliptic/curve/edwards.js"(), "node_modules/elliptic/lib/elliptic/curve/short.js"(), "node_modules/elliptic/lib/elliptic/ec/index.js"(), "node_modules/elliptic/lib/elliptic/ec/key.js"(), feeGrowth(), k(), client (+1 more)

### Community 64 - "History Store"
Cohesion: 0.33
Nodes (9): all(), { app }, clear(), ensureLoaded(), filePath(), fs, merge(), path (+1 more)

### Community 65 - "Decimal Rounding Internals"
Cohesion: 0.24
Nodes (10): ceil(), checkRoundingDigits(), finalise(), floor(), getLn10(), naturalExponential(), naturalLogarithm(), round() (+2 more)

### Community 66 - "macOS Build Config"
Cohesion: 0.20
Nodes (10): mac, NSCameraUsageDescription, category, entitlements, entitlementsInherit, extendInfo, hardenedRuntime, icon (+2 more)

### Community 67 - "NPM Scripts"
Cohesion: 0.20
Nodes (10): scripts, dist, dist:linux, dist:mac, dist:win, gate:atomix, start, test:atomix (+2 more)

### Community 68 - "Runtime Dependencies"
Cohesion: 0.22
Nodes (9): libsodium-wrappers, dependencies, libsodium-wrappers, qrcode-generator, @silentbot1/nat-api, sql.js, qrcode-generator, @silentbot1/nat-api (+1 more)

### Community 69 - "ETH Tx Signing (RLP)"
Cohesion: 0.47
Nodes (8): addressFromPriv(), intBytes(), keccakBytes(), rlpBytes(), rlpLenPrefix(), rlpList(), signLegacyTx(), toBigHex()

### Community 70 - "Swap Sweep Planner"
Cohesion: 0.53
Nodes (8): buildSweepPlan(), ceilUsdt(), computeMinima(), computeUsdt(), legMinima(), num(), pstr(), sweepDepthMinima()

### Community 71 - "ETH Wallet Sends"
Cohesion: 0.33
Nodes (5): checkSend(), gasReserveWei(), isEthAddr(), maxEthSendWei(), validDec()

### Community 72 - "AtomiX Service Boot"
Cohesion: 0.56
Nodes (8): configureEngines(), getBalances(), log(), logOnce(), notifyLog(), poll(), reloadShared(), tryBoot()

### Community 73 - "Casino Glue Test"
Cohesion: 0.22
Nodes (6): casino, cfg, mem, OPEN_BET, path, sent

### Community 74 - "Maker UI Helpers"
Cohesion: 0.46
Nodes (8): jvm(), makerAvail(), makerPublish(), makerSave(), makerWithdraw(), switchCurrency(), toVm(), withTimeout()

### Community 75 - "Market Mid-Price Helpers"
Cohesion: 0.32
Nodes (8): acceptMid(), createAnchor(), effLevel(), fmtMid(), isMarketFed(), market(), marketFresh(), refreshMarket()

### Community 76 - "ETH Wallet Unit Tests"
Cohesion: 0.29
Nodes (7): T, actualGpThroughEngine(), atomix, eq(), ok(), ssrf, xssOut

### Community 78 - "Decimal String Conversion"
Cohesion: 0.38
Nodes (7): checkInt32(), digitsToString(), finiteToString(), getZeroString(), nonFiniteToString(), random(), toStringBinary()

### Community 79 - "AtomiX S2 Gate Test"
Cohesion: 0.29
Nodes (4): { execFile }, fs, os, path

### Community 80 - "NaCl & DRBG Bundles"
Cohesion: 0.33
Nodes (3): "node_modules/hmac-drbg/lib/hmac-drbg.js"(), "node_modules/tweetnacl/nacl-fast.js"(), add()

### Community 81 - "Decimal Parsing"
Cohesion: 0.33
Nodes (6): convertBase(), getBase10Exponent(), intPow(), parseDecimal(), parseOther(), truncate()

### Community 82 - "PandaPools VM Loader"
Cohesion: 0.33
Nodes (5): ALL_FILES, createContext(), fs, path, vm

### Community 83 - "AtomiX Boot Gate Test"
Cohesion: 0.33
Nodes (4): { execFile }, fs, os, path

### Community 84 - "Mail Boot & Identity"
Cohesion: 0.60
Nodes (3): init(), lockedErr(), permErr()

### Community 85 - "Async Flow Helpers"
Cohesion: 0.70
Nodes (4): each(), map(), once(), waterfall()

### Community 87 - "Decimal Trig Functions"
Cohesion: 0.40
Nodes (5): atan(), atan2(), getPi(), isOdd(), toLessThanHalfPi()

### Community 89 - "Linux Build Config"
Cohesion: 0.40
Nodes (5): linux, category, icon, maintainer, target

### Community 90 - "PRNG Init"
Cohesion: 0.83
Nodes (3): init(), initBrowser(), initService()

### Community 91 - "BigNumber (bn.js)"
Cohesion: 0.50
Nodes (4): "node_modules/bn.js/lib/bn.js"(), div(), mod(), pow()

### Community 92 - "Taylor Series Math"
Cohesion: 0.67
Nodes (4): cosine(), sine(), taylorSeries(), tinyPow()

### Community 93 - "Outline Logo & Branding"
Cohesion: 0.50
Nodes (4): currentColor Theming (theme-adaptive icon fill), Minima Outline Logo (SVG), Minima Blockchain Brand Identity, MinimaCore Desktop Renderer UI

### Community 95 - "Decimal Logarithms"
Cohesion: 0.67
Nodes (3): log(), log10(), log2()

### Community 96 - "Decimal Max/Min"
Cohesion: 0.67
Nodes (3): max(), maxOrMin(), min()

### Community 97 - "Logo Mark & Palette"
Cohesion: 1.00
Nodes (3): Brand Color Palette (dark #16181c, orange #ff512f, blue #317aff, grey #91919d), Minima Logo Mark (SVG), Minima Blockchain Brand Identity

### Community 98 - "Tile Icon Branding"
Cohesion: 0.67
Nodes (3): Theme-Adaptive Icon via currentColor, Minima Brand Logomark (angular M), Minima Tile Icon (SVG)

## Knowledge Gaps
- **317 isolated node(s):** `{ EventEmitter }`, `path`, `fs`, `{ rpcCall }`, `{ createContext }` (+312 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **10 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `p()` connect `AtomiX IPC API Facade` to `Market Price Feed & Peg`, `Casino Module Core`, `AtomiX Inspect & Book Scan`, `PandaPools UI`, `Bundled Hash Libraries`, `Wallet & Pools UI Dialogs`, `Maker UI Helpers`, `Casino UI`, `AtomiX Main Module`, `AtomiX Take & Pool Manager`, `NaCl & DRBG Bundles`, `ERC20 Token Registry`, `Minima Node Manager`, `Pool Lifecycle Actions`, `ETH Gas & Send Logic`, `BigNumber (bn.js)`, `Vestr Vesting Module`, `Elliptic Curve Internals`?**
  _High betweenness centrality (0.177) - this node is a cross-community bridge._
- **Why does `s()` connect `Bundled Hash Libraries` to `Renderer App Shell`, `OTC Deal Engine`, `AtomiX Trading UI`, `Market Mid-Price Helpers`, `Swap Settlement Engine`, `Pool Lifecycle Actions`, `Vestr UI`, `PandaPools Main Module`, `BigNumber (bn.js)`, `Elliptic Curve Internals`?**
  _High betweenness centrality (0.117) - this node is a cross-community bridge._
- **Why does `Renderer App Shell (header + tab navigation + views)` connect `Project Docs & Changelog` to `Renderer App Shell`?**
  _High betweenness centrality (0.065) - this node is a cross-community bridge._
- **Are the 25 inferred relationships involving `p()` (e.g. with `ingest()` and `createContext()`) actually correct?**
  _`p()` has 25 INFERRED edges - model-reasoned connections that need verification._
- **What connects `{ EventEmitter }`, `path`, `fs` to the rest of the system?**
  _317 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Renderer App Shell` be split into smaller, more focused modules?**
  _Cohesion score 0.036730123180291153 - nodes in this community are weakly interconnected._
- **Should `Casino Module Core` be split into smaller, more focused modules?**
  _Cohesion score 0.05829420970266041 - nodes in this community are weakly interconnected._