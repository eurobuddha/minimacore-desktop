# Open-offer keepalive — APK 0.7.2 / MDS 2.9.2 / desktop integration branch

Untaken house offers now renew at age 500 blocks, at most two per processing block/scan, independently of the selected currency. One owner-signed transaction consumes the existing offer and creates one output at the same covenant with the exact collateral, token and all eight original state fields. It neither selects wallet funding nor generates or exposes a new secret. A confirmed successor has a new coin ID and fresh creation height. Existing old owned offers are eligible on the first successful scan after upgrading.

## Cause and evidence

`coins address:` searches the retained tree. Core `TxPoWSearcher.searchCoins` / `TxPoWTreeNode.copyParentRelevantCoins` retain an owner's relevant unspent offers through cascade, while foreign offers can disappear from another node's searchable tree. Increasing depth cannot retrieve already-pruned foreign coins. The family core cascades from 1024 blocks; 500 leaves a confirmation margin. Stock Minima has a longer window. `trackall:false` and foreign-coin hygiene exposed this limitation without a phase-0 refresh path. APK 0.7.0/0.7.1 did not remove such a path: it was absent. This is consistent with the reported seven offers; their live coin ages were not obtainable through disabled device RPC.

## Reused implementation and guardrails

Read/reused APK `CasinoTxn.reveal` and `CmdChain` for state-preserving construction, sequential status checks and abort-on-failure cleanup. Read the complete relevant GTC renewal/cancellation path in `~/Projects/minima/mds/Limit/service.js`: reuse its 500-block early window, bounded scheduling and durable cancellation-intent approach. Its refund/recreate sequence is unnecessary here because casino's phase-0 covenant already permits the house to sign the same collateral directly into a successor.

Only canonical owned phase-0 offers in Minima or MxUSD qualify. Renewal requires the saved house preimage and exact collateral. Command-bound fields are validated before interpolation. Java uses BigDecimal; ES5 uses the node's exact `maths` command because Rhino has no BigInt. All ports, the commitment and monetary precision are preserved. Failed attempts retain a retry cooldown. Temporary renewal transactions are deleted on success or failure.

Cancel first persists `casino_cancel_for_<houseCommit>`. Renewal rechecks it immediately before posting. If renewal already won the race, the service cancels its still-untaken successor using the same commitment after restart. A taken successor is never renewed or cancelled by upkeep. Normal reveal/resolve then applies. No vanished offer is recreated from unrelated wallet funds.

APK shares AutoProcessor between the foreground Activity and background service, using the existing ownership handoff. The MDS/desktop service owns renewal even with a fresh browser heartbeat; foreground reveal/resolve ownership remains as before. Service keys are refreshed before each block scan so an identity created after service startup is recognized. MDS automatic writes require WRITE mode and verified covenant registration.

## Parity and validation

Donor `mds/service.js`, `timeout-claims.js`, and `offer-keepalive.js` are byte-identical to desktop `main/casino/`. The existing two-currency My Bets and timeout-claim parity remains included.

- APK: 25 JVM tests pass, including seven offers (four Minima, three USD), age boundaries, both currencies, cancellation successors, invalid offers and retry/busy bounds. Release APK build and lint pass.
- Desktop gate: 22 tests pass, plus existing transaction glue checks. Includes actual service VM with foreground heartbeat/new wallet keys, manual Cancel persistence in both UIs, failures at every preparation step, and cancellation/restart races.
- `CasinoOfferOracle.java` recompiles the current production APK builder, compares its complete plan with the JS builder for six game/currency cases, and runs the real Minima KISS VM. It verifies authorized renewal and subsequent taking, rejects stranger renewal and changed terms, checks exact node maths and colored-token output scaling with synthetic metadata. Signer lists represent already-verified signatures; this is offline covenant execution, not mined consensus or cryptographic signature testing.
- Existing 160 APK/JS timeout policy vectors and covenant equality still pass.

Run APK `./gradlew testDebugUnitTest assembleRelease lintRelease`, then desktop `CASINO_APK=<apk> CASINO_DONOR=<donor>/mds npm run test:casino`. Set `MINIMA_CORE_JAR` when the core jar is not at `~/Projects/minima/core/minima-core/jar/minima.jar`.

The owner node and automatic processor must run to renew offers. After upgrade, allow renewal confirmation before expecting other devices to discover replacements. No transactions were posted against the user's live bets during development. Multi-device mined renewal and visual smoke remain release verification steps. This fix is not a claim that all broader adversarial-review issues or settlement-precision differences have been closed.
