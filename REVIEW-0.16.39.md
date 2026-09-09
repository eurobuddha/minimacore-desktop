# minimaCore Desktop 0.16.39 activity parity review

## Summary

Mirrors Android PandaPools 0.9.43–0.9.46 transaction activity behavior into MDS and Desktop. Exact transaction identities and node proof determine the displayed result. A local observation time, submission age, or pool-reserve snapshot cannot establish inclusion. This is an activity/receipt change, not completion of the wider funds-safety audit.

## Findings addressed

### MAJOR — inferred confirmations and false creation failures
`store.js` previously used elapsed blocks/time for most actions. Both frontends checked current reserves for creates and could mark missing reserves as failure. Replace these paths with independent `txpow onchain` replies. Display the actual confirmation count and last check time. A valid not-found reply can remove an earlier green status; transport/malformed replies retain previous evidence and report an error.

### MAJOR — receipt identity lost during mining
Capture `body.txn.transactionid` from successful posts before the UI records the receipt. Keep the original submission ID permanently. Match mined IDs using exact immutable transaction identity. For eligible legacy receipts, port Android ReceiptRecovery and Maxima TxHeader/Magic/MiniNumber serialization; the entire mined SHA3 header must reproduce before reconstructing the original pre-mining hash. Time only narrows candidates, never proves identity. Revisit retained node headers once, without clearing history.

### MAJOR — missing records and device-dependent transaction times
Join receipts and wallet history in chronological order, retain failures, remove the 120-receipt deletion, and provide Show more. Rotate verification over the entire stored history. Use transaction header timestamps in UTC in both frontends. Stop creating new feed records from reserve snapshots. Existing observations stay visible with explicit observation provenance and unknown transaction time.

### MAJOR — public transactions missing on other wallets
Use the existing Block Explorer/Android `txpow address:` lookup and require exact input/output address membership. Classify per-pool movements using existing `Statement.poolFlows` (the MDS port of Android TxClassifier). Store public results separately from wallet accounting. Independently verify their mined IDs. Known, owned and old-observation addresses remain candidates after a pool closes.

### MAJOR — incomplete sync or storage errors presented as completion
Failed/skipped history pages and the fetch budget no longer mark backfill/receipt repair complete. Distinguish duplicate history IDs from storage failure. Preserve the last visible snapshot when a storage read fails. Read commands have timeout/late-callback guards; public lookups are serial, four addresses per batch with cooldowns.

## Reuse and parity

Sources read: native `ActivityLog.java`, `ActivityTimeline.java`, `PoolActivity.java`, `ReceiptRecovery.java`, their tests and the actual consolidation fixture; Maxima TxHeader/Magic/MiniNumber/MiniData codecs; MDS history/store/statement/poolmgr/service; Desktop pandapools orchestrator, loader, SQL shim and renderer. KeyUses `phrase/sha3.js` is reused unchanged with its MIT notice. The JavaScript header adapter uses the existing Decimal implementation for exact MiniNumber bytes, without floating-point amount arithmetic.

Eleven shared engine files are byte-identical, including all new activity/recovery files. Desktop already had distinct signing/coin-lock implementations in poolmgr/service before this task. Those existing transaction flows are preserved; both receive the same submission-identity capture and removal of snapshot-feed ingestion. This review does not certify or change the pre-existing signing/locking differences.

## Validation

- 18 regression tests pass against the MDS engine and against Desktop's copied engine (`tests/activity-chain.test.cjs`, set PP_ENGINE_ROOT for the latter).
- The actual Android consolidation fixture reconstructs original ID `0x8C6B7401E1343318C7EC80563408C9978C40B7CA59EF76CE443EB0D2B68D27EB`. Altered headers, wrong mined hashes and malformed parents fail closed.
- Tests cover immutable new-receipt matching, old receipts, 140 retained failures, verification across 200 history records, not-found/reorg evidence, transport/malformed replies, public/wallet separation, SQL persistence/reload, incomplete pages, storage failure retention and MDS rendering.
- Desktop parity/display check passes for real counts, withdrawal classification, UTC times, copyable original IDs, observation provenance and HTML escaping.
- Successful SQL operations from the suite replay against Minima's H2 2.4.240 engine as well as Desktop sql.js.
- Changed scripts and MDS inline scripts parse; git diff --check passes.

## Verdict and limits

Approve for packaged validation. No spending/signing command or live-wallet transaction was issued during testing. Recovery still needs the node's retained header (and the original ID); missing archived history is not fabricated. Public address responses are not byte-bounded by a node max argument; a failed lookup stays visible. Live MDS/Desktop wallet verification and installer deployment are separate from the isolated tests above.

## Packaged validation

First and only macOS ARM64 artifact: `dist/minimaCore-0.16.39-arm64.dmg`. SHA-256 `c8617ccd03da69bdc56f615c50790844f561329a1176eb586bbaed008c2be6b7`. Developer ID signing, strict deep codesign verification, Apple notarization, app/DMG stapling and Gatekeeper checks all passed (`scripts/verify-mac.sh`: ALL OK). The packaged app.asar version is 0.16.39, and every changed runtime file matches the committed source exactly. No prior versioned DMG was overwritten.

MDS 0.6.22 source was verified on GitHub at 34bf886a519833b0449340f9798dbcca617bcfad; Desktop 0.16.39 source at 90832864e722776248264c450be1495643f307c4. These artifacts have not been installed into a live MDS/Desktop wallet during this task. Windows/Linux installers and store publication are not part of this local macOS package validation.
