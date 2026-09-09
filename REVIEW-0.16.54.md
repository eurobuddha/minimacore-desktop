# Verified pool recovery and signing state

Expired proof snapshots and a light node's empty coin lookup previously left owners without an actionable recovery path. Restore could report success after failed imports and regenerate keys using an estimated signing counter. The updated flow preserves the covenant recipe, finds and validates current reserves, reports only verified recovery, and requires explicit confirmation of current complete wallet signing state before owner signing resumes.

Reuse: the native recovery/key/funding helpers; MDS and Desktop Covenant, Decimal, Curve, Store and PoolMgr; Desktop's existing bounded netfetch and atomic SQL image writer. The shared reserve coordinator is byte-identical across MDS and Desktop. Background upkeep now uses the oldest verified leg, a KMIN completeness check, and current ownership before tracking cleanup. Legacy records are held on upgrade; ordinary rediscovery preserves an already confirmed state.

Validation completed on 2026-09-09:

- Native: 205 tests in each Debug and Release variant, no failures; both lint checks and release APK build passed. The APK certificate matches the family release signer.
- JavaScript: 22 exact-source recovery/UI tests and two Desktop lifecycle tests. Coverage includes stale/wrong/missing proofs, import/archive failure, oversized archive streams, crowded addresses, moving backup reserves, key-state races, disk failures, legacy migration, delayed cleanup and unresolved cards.
- Existing activity suite: 18 regressions passed; 12 shared files pass byte parity.
- Packaged MDS: dapp.conf is first; service bytes equal the reviewed concatenation. Minima's Rhino 1.7.14 executes the bundle without browser timers. H2 2.4.240 validates migration and monotonic merge SQL, including legacy-held and new-trusted rows.
- Independent Android, MDS and Desktop adversarial reviews all approved after fixes and repeat review. Concurrent Desktop Casino edits were preserved by a three-way rebase against hash-verified originals.

Limits: public pool recipes contain no private keys or current signing state. Recovery requires the matching complete wallet state and available chain proofs. No default public archive is assumed. The optional MDS HTTPS archive must allow browser CORS requests; its streaming reader is capped and cancellable. Native/Desktop use their bounded HTTP clients. The app cannot keep pools fresh while both it and the node are offline.

Visual QA is unverified: browser security policy rejected the local-file preview. Source-level UI checks passed. No new build was installed on a live wallet during validation. These artifacts have not been published to stores.
