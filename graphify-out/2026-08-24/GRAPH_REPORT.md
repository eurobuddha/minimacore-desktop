# Graph Report - .  (2026-08-23)

## Corpus Check
- 44 files · ~278,603 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2279 nodes · 5144 edges · 123 communities (111 shown, 12 thin omitted)
- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS · INFERRED: 458 edges (avg confidence: 0.59)
- Token cost: 54,344 input · 6,300 output

## Community Hubs (Navigation)
- Renderer App Core
- PandaPools Pool Manager
- AtomiX Renderer UI
- Casino Renderer
- Mail Renderer
- AtomiX OTC Deals
- Shop Renderer
- PandaPools Service + Hygiene Sweep
- AtomiX UI Helpers
- Packaging File Globs
- Casino Activity Feed
- History SQLite DB
- AtomiX Main Service
- Wallet Renderer Helpers
- App Boot + Theming
- AtomiX Quotes + Books
- AtomiX Responder
- PandaPools Store
- AtomiX Settlement
- Casino Bet Engine
- AtomiX Swap DB
- Web Wallet Engine
- Renderer Misc Panels
- Mail Crypto (sodium)
- PandaPools Decimal Math
- Minima HTLC
- Config + Secrets
- Mail Store
- Shop Store
- Renderer Confirm Dialogs
- History Renderer Helpers
- Vendored Elliptic Curves
- Vestr Vesting + Send Pin
- Mail Contacts UI
- Electron Main Process
- NAT Port Mapping
- PandaPools Main Module
- Node Manager
- Price Peg + Market Feed
- Module Suite Concepts
- AtomiX Maker
- Changelog Release History
- PandaPools Price Curve
- Shared Decimal Utils
- AtomiX Swap Engine
- ETH JSON-RPC Client
- AtomiX Orderbook
- PandaPools Statement
- MDS Command Wrapper
- Vendored Hash Libs
- Capped Net Fetch
- ETH HTLC Contract
- AtomiX Order Model
- Casino Service + Tracking
- Electron Builder Config
- PandaPools Pool Actions
- ETH Token Registry
- ETH Wallet Module
- Token Icons
- Package Metadata
- ETH Gas + Send Review
- Hex Utilities
- Cross-platform Build Pipeline
- Mail Identity
- Identity Watch
- Vendored EC Internals
- PandaPools Book Scan
- NPM Scripts
- Vestr Renderer
- ETH ABI Codec
- ETH Transaction Queue
- History JSON Store
- Decimal Rounding Core
- PandaPools History Sync
- macOS Build Config
- Runtime Dependencies
- ETH Signing Primitives
- AtomiX Sweep Planner
- ETH Wallet Sends
- AtomiX Service Boot
- Casino Glue Test
- AtomiX Maker VM Bridge
- PandaPools Market Anchor
- Decimal String Conversion
- ETH Wallet Unit Test
- Trading Pair State
- Decimal Parsing
- macOS App Readme
- AtomiX S2 Gate
- Terminal Autocomplete + Guardrail
- Vendored NaCl
- PandaPools VM Loader
- Minima Brand Identity
- AtomiX Boot Gate
- Mail Boot + Identity
- Async Flow Utils
- Faucet Client
- PandaPools Node Runner
- Decimal Trig (pi/atan)
- PandaPools Router
- Node RPC Client
- AtomiX Inspect Report
- PRNG Init
- Vendored BN.js Ops
- Decimal Trig Series
- PandaPools Pair Quotes
- Authoritative User Rules
- Casino Take Helper
- Decimal Logarithms
- App Shell + CSP + Wizard
- Minima Tile Icon
- Hook Installer
- Version-Bump Pre-commit Hook
- Preload IPC Bridge
- AtomiX Parity Check
- Casino Parity Check

## God Nodes (most connected - your core abstractions)
1. `el()` - 136 edges
2. `esc()` - 97 edges
3. `toast()` - 76 edges
4. `p()` - 55 edges
5. `files` - 44 edges
6. `el()` - 40 edges
7. `AX()` - 36 edges
8. `renderSettings()` - 24 edges
9. `render()` - 23 edges
10. `s()` - 23 edges

## Surprising Connections (you probably didn't know these)
- `Bundled JRE via jlink` --semantically_similar_to--> `Bundled JRE (no system Java needed)`  [INFERRED] [semantically similar]
  .github/workflows/desktop-build.yml → README.md
- `RULE 0 — Explicit Instructions Are Blocking` --semantically_similar_to--> `Byte-Identical MDS Engine Reuse Rule`  [INFERRED] [semantically similar]
  CLAUDE.md → CHANGELOG.md
- `ingest()` --indirect_call--> `t()`  [INFERRED]
  main/atomix/lib/market.js → preflight-portmap.mjs
- `"node_modules/hash.js/lib/hash/sha/512.js"()` --indirect_call--> `el()`  [INFERRED]
  main/atomix/vendor/elliptic.js → renderer/app.js
- `targets()` --indirect_call--> `reject()`  [INFERRED]
  scripts/cdp-eval.js → main/atomix/lib/otc.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Winternitz Key-Reuse Defense Layers** — changelog_winternitz_key_reuse, changelog_wallet_signdata_fix, changelog_serial_signing_gate, changelog_opkuses_backup_restore, changelog_owner_key_hunt_ledger [EXTRACTED 1.00]
- **Shared-Covenant Balance Pollution Fix (trackall:false + hygiene sweep)** — changelog_trackall_pollution_trap, changelog_launch_hygiene_sweep, changelog_pandapools_module, changelog_casino_module [EXTRACTED 1.00]
- **Terminal Autocomplete Stack (registry engine + dropdown UI)** — changelog_terminal_autocomplete, renderer_index_terminal_view, renderer_index_autocomplete_dropdown [INFERRED 0.95]
- **Cross-platform Build and Release Pipeline** — github_workflows_desktop_build_workflow, github_workflows_desktop_build_build_matrix, github_workflows_desktop_build_jlink_jre, readme_bundled_jre [INFERRED 0.85]

## Communities (123 total, 12 thin omitted)

### Community 0 - "Renderer App Core"
Cohesion: 0.03
Nodes (98): RFC-1918, absCmp(), appendLog(), applyMailUpdate(), axEditInput(), axEditRow(), axFld(), axGenField() (+90 more)

### Community 1 - "PandaPools Pool Manager"
Cohesion: 0.07
Nodes (65): addAnnounceState(), advanceKeyUses(), beginHunt(), buildAndPost(), buildCreate(), buildMigrate(), buildRouted(), burnTo() (+57 more)

### Community 2 - "AtomiX Renderer UI"
Cohesion: 0.10
Nodes (68): activeSwap(), activityTab(), amtField(), banner(), bidiInput(), bootErrorCard(), ccy(), clean() (+60 more)

### Community 3 - "Casino Renderer"
Cohesion: 0.06
Nodes (61): balance(), buildMds(), C(), cancel(), cgame(), claimTimeout(), cmnum(), cnorm() (+53 more)

### Community 4 - "Mail Renderer"
Cohesion: 0.06
Nodes (48): addContact(), archivedThreads(), autoReplyTimes, backup, config, contacts(), crypto, currentBlock() (+40 more)

### Community 5 - "AtomiX OTC Deals"
Cohesion: 0.11
Nodes (50): accept(), addMsg(), allDeals(), apply(), applyPropose(), approxEq(), changed(), claimExecute() (+42 more)

### Community 6 - "Shop Renderer"
Cohesion: 0.08
Nodes (35): advanceStatus(), capSeen(), coinAmount(), coinsAt(), config, crypto, emitter, EventEmitter (+27 more)

### Community 7 - "PandaPools Service + Hygiene Sweep"
Cohesion: 0.11
Nodes (45): annKeySvc(), cleanForeign(), covScript(), decCmp(), decDiv(), decSnap(), decSub(), demoteForeign() (+37 more)

### Community 8 - "AtomiX UI Helpers"
Cohesion: 0.08
Nodes (45): ax6(), axAgo(), axBestLine(), axChip(), axCleanNum(), axDealRow(), axDepthHalf(), axDepthRow() (+37 more)

### Community 9 - "Packaging File Globs"
Cohesion: 0.05
Nodes (43): files, main/**, node_modules/abort-controller/**, node_modules/chrome-dgram/**, node_modules/cross-fetch-ponyfill/**, node_modules/cross-spawn/**, node_modules/data-uri-to-buffer/**, node_modules/debug/** (+35 more)

### Community 10 - "Casino Activity Feed"
Cohesion: 0.10
Nodes (41): casinoActAppend(), casinoActClass(), casinoActivity(), casinoActPaint(), casinoBlock(), casinoCheckCreateConfirm(), casinoCheckTakeConfirm(), casinoCoinIsPayout() (+33 more)

### Community 11 - "History SQLite DB"
Cohesion: 0.09
Nodes (35): all(), { app }, bI(), clear(), count(), countSync(), dbPath(), ensureReady() (+27 more)

### Community 12 - "AtomiX Main Service"
Cohesion: 0.08
Nodes (34): buildMds(), { createContext }, emitter, ETH_FEE_MULT, ETH_RPC_FILE(), ETH_SEED_TOKENS, ethPrivateHost(), ethRpcLoad() (+26 more)

### Community 13 - "Wallet Renderer Helpers"
Cohesion: 0.11
Nodes (38): applyIcon(), balBreakdown(), balCardHtml(), casinoAgeGate(), cmd(), copy(), decSub(), enhanceTokenIcons() (+30 more)

### Community 14 - "App Boot + Theming"
Cohesion: 0.11
Nodes (37): appendTerm(), applyPpDir(), applyTheme(), boot(), currentWwMode(), cycleTheme(), doPpSwap(), drawQR() (+29 more)

### Community 15 - "AtomiX Quotes + Books"
Cohesion: 0.15
Nodes (35): AX(), balances(), book(), bookScan(), coins(), computeQuote(), ethBalances(), ethWallet() (+27 more)

### Community 16 - "AtomiX Responder"
Cohesion: 0.14
Nodes (33): acceptTakerBuyMinima(), acceptTakerSellMinima(), addDec(), addIncoming(), cpBurstFull(), decimalsOf(), doScanIncoming(), ensureAllowance() (+25 more)

### Community 17 - "PandaPools Store"
Cohesion: 0.10
Nodes (27): actRecord(), actRecordFailed(), actSetStatus(), confirmed(), create(), ensureHistory(), ensureOwnPools(), esc() (+19 more)

### Community 18 - "AtomiX Settlement"
Cohesion: 0.17
Nodes (32): activeSwaps(), amountTokenOk(), broadcastEthRefund(), broadcastEthWithdraw(), checkCanSwapCoin(), checkEthContractBody(), checkEthContractFor(), checkExpiredMinima() (+24 more)

### Community 19 - "Casino Bet Engine"
Cohesion: 0.18
Nodes (31): addMultipleInputs(), cancelBet(), claimTimeout(), coinsAtContract(), createBet(), decAdd(), decCmp(), decSub() (+23 more)

### Community 20 - "AtomiX Swap DB"
Cohesion: 0.20
Nodes (31): activeHashes(), allSwaps(), deleteSwap(), esc(), executedTrades(), getEvents(), getRequest(), getSecret() (+23 more)

### Community 21 - "Web Wallet Engine"
Cohesion: 0.14
Nodes (30): ackKeyuses(), derive(), emitter, entryFor(), { EventEmitter }, fs, isAmount(), isMegammr() (+22 more)

### Community 22 - "Renderer Misc Panels"
Cohesion: 0.10
Nodes (32): axCoinDump(), axLevelRow(), contribHelp(), esc(), ewConfirmSend(), ewEthIcon(), ewReceive(), ewSendDialog() (+24 more)

### Community 23 - "Mail Crypto (sodium)"
Cohesion: 0.10
Nodes (21): cat(), hkdfSha256(), hmacSha256(), seal(), sealOpen(), boxPkOf(), crypto, deriveIdentity() (+13 more)

### Community 24 - "PandaPools Decimal Math"
Cohesion: 0.07
Nodes (5): hypot(), max(), maxOrMin(), min(), sqrt()

### Community 25 - "Minima HTLC"
Cohesion: 0.17
Nodes (24): claim(), coinAmount(), deleteTxn(), grain(), isDecimal(), isHex(), isHexOrMinima(), loadKeys() (+16 more)

### Community 26 - "Config + Secrets"
Cohesion: 0.13
Nodes (25): { app, safeStorage }, configPath(), crypto, DEFAULTS, deleteSecret(), effectiveParams(), encAvailable(), { execFileSync } (+17 more)

### Community 27 - "Mail Store"
Cohesion: 0.16
Nodes (28): addContact(), addMessage(), all(), allThreadRows(), { app }, archivedSet(), archivedThreads(), clear() (+20 more)

### Community 28 - "Shop Store"
Cohesion: 0.15
Nodes (28): addChat(), { app }, chat(), clear(), decAdd(), decCmp(), decGte(), deleteShop() (+20 more)

### Community 29 - "Renderer Confirm Dialogs"
Cohesion: 0.15
Nodes (29): axExportKey(), axOtcPropose(), axWelcome(), confirmPpWithdraw(), doMailBackup(), doMailRestore(), doPpCollect(), doPpStatement() (+21 more)

### Community 30 - "History Renderer Helpers"
Cohesion: 0.11
Nodes (29): histRowHtml(), hostOf(), labelFor(), looksLikeMinimaAddress(), onPandapoolsUpdate(), ppActsHtml(), ppCombinedCards(), ppFeedHtml() (+21 more)

### Community 32 - "Vestr Vesting + Send Pin"
Cohesion: 0.15
Nodes (25): pinMinimaSend(), blockHeightForDate(), calculate(), coinAmount(), collect(), contractFromCoin(), create(), crypto (+17 more)

### Community 33 - "Mail Contacts UI"
Cohesion: 0.19
Nodes (27): addPeerContact(), confirmDeleteContact(), confirmDeleteThread(), contactMenu(), doArchive(), mailAvatar(), mailHeader(), mailName() (+19 more)

### Community 34 - "Electron Main Process"
Cohesion: 0.08
Nodes (21): { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell, Notification, session, clipboard }, atomix, casino, config, createWindow(), ethwallet, faucet, fs (+13 more)

### Community 35 - "NAT Port Mapping"
Cohesion: 0.15
Nodes (12): defaultRoute(), dgram, EventEmitter, { execFile }, isPrivateIp(), RFC-1918, lanIp(), os (+4 more)

### Community 36 - "PandaPools Main Module"
Cohesion: 0.10
Nodes (18): { app }, config, { createContext, ALL_FILES }, currentBlock(), emitter, EventEmitter, { fetchJson }, flush() (+10 more)

### Community 37 - "Node Manager"
Cohesion: 0.17
Nodes (10): { app }, config, EventEmitter, fs, NodeManager, path, portmap, { rpcCall } (+2 more)

### Community 38 - "Price Peg + Market Feed"
Cohesion: 0.15
Nodes (17): ingest(), poll(), price(), reconcileSpent(), ageMs(), applyPeg(), commitMexc(), effectiveLevel() (+9 more)

### Community 39 - "Module Suite Concepts"
Cohesion: 0.11
Nodes (22): AtomiX Atomic-Swap Tab, Balances Full Breakdown + Untruncated Tagged Coin List, Byte-Identical MDS Engine Reuse Rule, ZeroEdge Casino Tab (P2PChance), ETH Wallet Tab, Transaction History (SQLite, locally owned), In-app Node Jar Updater Removal, Launch Hygiene Sweep (cleanForeign) (+14 more)

### Community 40 - "AtomiX Maker"
Cohesion: 0.20
Nodes (19): buildOrder(), clampAsks(), currentOrder(), doLoadConfig(), doPublish(), keepAlive(), kvKey(), loadConfig() (+11 more)

### Community 41 - "Changelog Release History"
Cohesion: 0.10
Nodes (20): [0.11.x] — Vestr + AtomiX preimage fix, [0.13.0] — cross-platform builds, [0.15.x] — Web Wallet + AtomiX CSV + clipboard, [0.16.0] – [0.16.1] — ETH Wallet tab, [0.16.11] — PandaPools: stop the runaway owner-key hunt (bounded, remembered, provable), [0.16.12] — SECURITY: bundled node jar carries the Wallet.signData fix; in-app jar updater removed, [0.16.13] — bundled node moves to 1.1.2.4 (upstream super-parent fix), [0.16.2] — PandaPools: Individual | Combined pool view toggle (+12 more)

### Community 42 - "PandaPools Price Curve"
Cohesion: 0.17
Nodes (17): aggregatePrice(), amt(), clampDec(), dec(), decOr(), fix(), funded(), grain() (+9 more)

### Community 43 - "Shared Decimal Utils"
Cohesion: 0.25
Nodes (19): bumpFrac(), ceilDp(), divFloor(), floorDp(), formatUnits(), fromScaled(), grain6(), gt0() (+11 more)

### Community 44 - "AtomiX Swap Engine"
Cohesion: 0.25
Nodes (16): baseSwap(), confirmMyLock(), ensureAllowance(), ethChainNow(), executeOtc(), isMyPublishKey(), normKey(), notifyChanged() (+8 more)

### Community 45 - "ETH JSON-RPC Client"
Cohesion: 0.24
Nodes (5): big(), hexToBig(), host(), Rpc(), snippet()

### Community 46 - "AtomiX Orderbook"
Cohesion: 0.22
Nodes (16): aggSide(), bestMakers(), cmp(), compareForFill(), isMine(), levelCap(), mergeFreshest(), nowMs() (+8 more)

### Community 47 - "PandaPools Statement"
Cohesion: 0.27
Nodes (17): block(), build(), cell(), cells(), classify(), d(), fixed(), hasBeacon() (+9 more)

### Community 48 - "MDS Command Wrapper"
Cohesion: 0.25
Nodes (13): cmd(), cmdR(), esc(), ethLockAcquire(), ethLockInit(), ethLockRelease(), kvDel(), kvGet() (+5 more)

### Community 49 - "Vendored Hash Libs"
Cohesion: 0.14
Nodes (15): "node_modules/elliptic/lib/elliptic/ec/signature.js"(), "node_modules/hash.js/lib/hash/ripemd.js"(), "node_modules/hash.js/lib/hash/sha/1.js"(), "node_modules/js-sha3/src/sha3.js"(), balance(), aggregateInfo(), createPreview(), D() (+7 more)

### Community 50 - "Capped Net Fetch"
Cohesion: 0.21
Nodes (16): acquire(), dns, fetchJson(), getCapped(), http, https, ipBlocked(), isBlockedHost() (+8 more)

### Community 51 - "ETH HTLC Contract"
Cohesion: 0.14
Nodes (4): b32(), contractId(), make(), safeBig()

### Community 52 - "AtomiX Order Model"
Cohesion: 0.23
Nodes (14): canonicalJson(), effectiveAsks(), effectiveBids(), finite(), fromJson(), hasLiquidity(), isHex(), level() (+6 more)

### Community 53 - "Casino Service + Tracking"
Cohesion: 0.25
Nodes (13): cleanTracking(), doResolve(), doReveal(), extractResponse(), gameTypeName(), getState(), isMyKey(), miniNum() (+5 more)

### Community 54 - "Electron Builder Config"
Cohesion: 0.12
Nodes (16): build, appId, extraResources, linux, nsis, productName, win, category (+8 more)

### Community 55 - "PandaPools Pool Actions"
Cohesion: 0.23
Nodes (15): actionOnPool(), advanceRestoredKeys(), backup(), closePool(), collectToWallet(), createPool(), deposit(), ensureOwnerKey() (+7 more)

### Community 56 - "ETH Token Registry"
Cohesion: 0.26
Nodes (14): ETH_TOKENS_FILE(), ethAddToken(), ethCleanSymbol(), ethDecodeSymbol(), ethRemoveToken(), ethTokenBy(), ethTokenMeta(), ethTokens() (+6 more)

### Community 57 - "ETH Wallet Module"
Cohesion: 0.14
Nodes (3): atomix, emitter, { EventEmitter }

### Community 58 - "Token Icons"
Cohesion: 0.26
Nodes (12): b64encode(), first(), hsl(), identiconDataUri(), meta(), metaField(), pickIconField(), resolveIcon() (+4 more)

### Community 59 - "Package Metadata"
Cohesion: 0.15
Nodes (12): electron, electron-builder, author, description, devDependencies, electron, electron-builder, license (+4 more)

### Community 60 - "ETH Gas + Send Review"
Cohesion: 0.24
Nodes (12): ensureRpcOverride(), ethAddrChecksumOk(), ethAmbiguousBroadcast(), ethCapGas(), ethGasNow(), ethGasScaledRpc(), ethReserveGp(), ethSendExecute() (+4 more)

### Community 62 - "Cross-platform Build Pipeline"
Cohesion: 0.18
Nodes (11): Cross-platform Build Matrix (mac/win/linux), Bundled JRE via jlink, Desktop Build GitHub Actions Workflow, Bundled JRE (no system Java needed), Design.java CSS Port (native look), First-run Node Wizard, minimaCore Desktop App, Node Updater (sha256-verified jar swap) (+3 more)

### Community 63 - "Mail Identity"
Cohesion: 0.31
Nodes (9): boxPkOf(), canonicalId(), fromSeed(), isValidPublicId(), makeIdentity(), open(), seal(), seedBytes() (+1 more)

### Community 64 - "Identity Watch"
Cohesion: 0.29
Nodes (6): check(), checkEth(), checkMinima(), halted(), raiseOrClear(), summary()

### Community 65 - "Vendored EC Internals"
Cohesion: 0.22
Nodes (10): "node_modules/elliptic/lib/elliptic/curve/base.js"(), "node_modules/elliptic/lib/elliptic/curve/edwards.js"(), "node_modules/elliptic/lib/elliptic/curve/short.js"(), "node_modules/elliptic/lib/elliptic/ec/index.js"(), "node_modules/elliptic/lib/elliptic/ec/key.js"(), feeGrowth(), k(), client (+2 more)

### Community 66 - "PandaPools Book Scan"
Cohesion: 0.35
Nodes (10): derivePools(), done(), finishScan(), fund(), gatherOwned(), gatherRegistry(), group(), parseScripts() (+2 more)

### Community 67 - "NPM Scripts"
Cohesion: 0.18
Nodes (11): scripts, dist, dist:linux, dist:mac, dist:win, gate:atomix, start, test:atomix (+3 more)

### Community 68 - "Vestr Renderer"
Cohesion: 0.33
Nodes (11): onVestrUpdate(), renderVestr(), renderVestrCalc(), renderVestrCreate(), renderVestrList(), renderVestrSub(), vestrDoCollect(), vestrDoCreate() (+3 more)

### Community 69 - "ETH ABI Codec"
Cohesion: 0.47
Nodes (9): decode(), encAddr(), encBool(), encBytes32(), encodeCall(), encUint(), pad64(), selector() (+1 more)

### Community 70 - "ETH Transaction Queue"
Cohesion: 0.33
Nodes (7): acquire(), busyErr(), doSend(), pump(), release(), send(), slot()

### Community 71 - "History JSON Store"
Cohesion: 0.33
Nodes (9): all(), { app }, clear(), ensureLoaded(), filePath(), fs, merge(), path (+1 more)

### Community 72 - "Decimal Rounding Core"
Cohesion: 0.24
Nodes (10): ceil(), checkRoundingDigits(), finalise(), floor(), getLn10(), naturalExponential(), naturalLogarithm(), round() (+2 more)

### Community 73 - "PandaPools History Sync"
Cohesion: 0.38
Nodes (8): coins(), entryFrom(), finish(), firstAddr(), markDone(), page(), shrink(), sync()

### Community 74 - "macOS Build Config"
Cohesion: 0.20
Nodes (10): mac, NSCameraUsageDescription, category, entitlements, entitlementsInherit, extendInfo, hardenedRuntime, icon (+2 more)

### Community 75 - "Runtime Dependencies"
Cohesion: 0.22
Nodes (9): libsodium-wrappers, dependencies, libsodium-wrappers, qrcode-generator, @silentbot1/nat-api, sql.js, qrcode-generator, @silentbot1/nat-api (+1 more)

### Community 76 - "ETH Signing Primitives"
Cohesion: 0.47
Nodes (8): addressFromPriv(), intBytes(), keccakBytes(), rlpBytes(), rlpLenPrefix(), rlpList(), signLegacyTx(), toBigHex()

### Community 77 - "AtomiX Sweep Planner"
Cohesion: 0.53
Nodes (8): buildSweepPlan(), ceilUsdt(), computeMinima(), computeUsdt(), legMinima(), num(), pstr(), sweepDepthMinima()

### Community 78 - "ETH Wallet Sends"
Cohesion: 0.33
Nodes (5): checkSend(), gasReserveWei(), isEthAddr(), maxEthSendWei(), validDec()

### Community 79 - "AtomiX Service Boot"
Cohesion: 0.56
Nodes (8): configureEngines(), getBalances(), log(), logOnce(), notifyLog(), poll(), reloadShared(), tryBoot()

### Community 80 - "Casino Glue Test"
Cohesion: 0.22
Nodes (6): casino, cfg, mem, OPEN_BET, path, sent

### Community 81 - "AtomiX Maker VM Bridge"
Cohesion: 0.46
Nodes (8): jvm(), makerAvail(), makerPublish(), makerSave(), makerWithdraw(), switchCurrency(), toVm(), withTimeout()

### Community 82 - "PandaPools Market Anchor"
Cohesion: 0.32
Nodes (8): acceptMid(), createAnchor(), effLevel(), fmtMid(), isMarketFed(), market(), marketFresh(), refreshMarket()

### Community 83 - "Decimal String Conversion"
Cohesion: 0.32
Nodes (8): checkInt32(), convertBase(), digitsToString(), finiteToString(), getZeroString(), nonFiniteToString(), random(), toStringBinary()

### Community 84 - "ETH Wallet Unit Test"
Cohesion: 0.29
Nodes (7): T, actualGpThroughEngine(), atomix, eq(), ok(), ssrf, xssOut

### Community 86 - "Decimal Parsing"
Cohesion: 0.33
Nodes (7): clone(), getBase10Exponent(), intPow(), isDecimalInstance(), parseDecimal(), parseOther(), truncate()

### Community 87 - "macOS App Readme"
Cohesion: 0.29
Nodes (6): Build the .dmg, Design, Develop, minimaCore Desktop (macOS), Notes / TODO, What it does

### Community 88 - "AtomiX S2 Gate"
Cohesion: 0.29
Nodes (4): { execFile }, fs, os, path

### Community 89 - "Terminal Autocomplete + Guardrail"
Cohesion: 0.40
Nodes (6): minimaCore Desktop Changelog, Terminal IDE-style Parameter Autocomplete, Pre-commit Version-Bump Hook (.githooks/pre-commit), Versioning Guardrail — Every Code Change Ships a Version Bump, Terminal Autocomplete Dropdown (termSug/termHint), Terminal View (termOut/termIn)

### Community 90 - "Vendored NaCl"
Cohesion: 0.33
Nodes (3): "node_modules/hmac-drbg/lib/hmac-drbg.js"(), "node_modules/tweetnacl/nacl-fast.js"(), add()

### Community 91 - "PandaPools VM Loader"
Cohesion: 0.33
Nodes (5): ALL_FILES, createContext(), fs, path, vm

### Community 92 - "Minima Brand Identity"
Cohesion: 0.40
Nodes (6): Brand Color Palette (dark #16181c, orange #ff512f, blue #317aff, grey #91919d), Minima Logo Mark (SVG), Minima Blockchain Brand Identity, currentColor Theming (theme-adaptive icon fill), Minima Outline Logo (SVG), MinimaCore Desktop Renderer UI

### Community 93 - "AtomiX Boot Gate"
Cohesion: 0.33
Nodes (4): { execFile }, fs, os, path

### Community 94 - "Mail Boot + Identity"
Cohesion: 0.60
Nodes (3): init(), lockedErr(), permErr()

### Community 95 - "Async Flow Utils"
Cohesion: 0.70
Nodes (4): each(), map(), once(), waterfall()

### Community 97 - "Faucet Client"
Cohesion: 0.50
Nodes (4): getJson(), https, requestFaucet(), { URL }

### Community 98 - "PandaPools Node Runner"
Cohesion: 0.50
Nodes (5): buildMds(), importCoin(), nodeCmd(), restoreOne(), runner()

### Community 100 - "Decimal Trig (pi/atan)"
Cohesion: 0.40
Nodes (5): atan(), atan2(), getPi(), isOdd(), toLessThanHalfPi()

### Community 102 - "Node RPC Client"
Cohesion: 0.60
Nodes (4): http, rpcCall(), timeoutFor(), WRITE_PREFIXES

### Community 104 - "PRNG Init"
Cohesion: 0.83
Nodes (3): init(), initBrowser(), initService()

### Community 106 - "Vendored BN.js Ops"
Cohesion: 0.50
Nodes (4): "node_modules/bn.js/lib/bn.js"(), div(), mod(), pow()

### Community 107 - "Decimal Trig Series"
Cohesion: 0.67
Nodes (4): cosine(), sine(), taylorSeries(), tinyPow()

### Community 108 - "PandaPools Pair Quotes"
Cohesion: 0.50
Nodes (4): pairInfo(), pairPoolsFor(), priceImpactOf(), quoteAndStash()

### Community 112 - "Decimal Logarithms"
Cohesion: 0.67
Nodes (3): log(), log10(), log2()

### Community 113 - "App Shell + CSP + Wizard"
Cohesion: 0.67
Nodes (3): App Shell (header, tabs, views), Renderer Content-Security-Policy, First-Run Node Setup Wizard

### Community 114 - "Minima Tile Icon"
Cohesion: 0.67
Nodes (3): Theme-Adaptive Icon via currentColor, Minima Brand Logomark (angular M), Minima Tile Icon (SVG)

## Knowledge Gaps
- **359 isolated node(s):** `vm`, `fs`, `path`, `{ app, safeStorage }`, `{ execFileSync }` (+354 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **12 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `p()` connect `AtomiX Quotes + Books` to `Vestr Vesting + Send Pin`, `Vendored EC Internals`, `PandaPools Pool Manager`, `Casino Renderer`, `Price Peg + Market Feed`, `PandaPools Service + Hygiene Sweep`, `Node RPC Client`, `Vendored BN.js Ops`, `Casino Activity Feed`, `AtomiX Main Service`, `PandaPools Statement`, `AtomiX Maker VM Bridge`, `Vendored Hash Libs`, `PandaPools Pool Actions`, `ETH Token Registry`, `Vendored NaCl`, `ETH Gas + Send Review`, `History Renderer Helpers`?**
  _High betweenness centrality (0.185) - this node is a cross-community bridge._
- **Why does `s()` connect `Vendored Hash Libs` to `Vendored EC Internals`, `PandaPools Main Module`, `AtomiX OTC Deals`, `AtomiX UI Helpers`, `Vendored BN.js Ops`, `PandaPools Pair Quotes`, `AtomiX Settlement`, `PandaPools Market Anchor`, `PandaPools Pool Actions`?**
  _High betweenness centrality (0.136) - this node is a cross-community bridge._
- **Why does `balance()` connect `Vendored Hash Libs` to `Casino Bet Engine`?**
  _High betweenness centrality (0.065) - this node is a cross-community bridge._
- **Are the 26 inferred relationships involving `p()` (e.g. with `ingest()` and `createContext()`) actually correct?**
  _`p()` has 26 INFERRED edges - model-reasoned connections that need verification._
- **What connects `vm`, `fs`, `path` to the rest of the system?**
  _359 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Renderer App Core` be split into smaller, more focused modules?**
  _Cohesion score 0.03207920792079208 - nodes in this community are weakly interconnected._
- **Should `PandaPools Pool Manager` be split into smaller, more focused modules?**
  _Cohesion score 0.07042253521126761 - nodes in this community are weakly interconnected._