# Code Review

## Summary

Reviewed the keepalive changes in APK AutoProcessor, CasinoTxn, OfferKeepAlive and their Activity/service callers; MDS offer-keepalive, service and manual Cancel; desktop engine glue and exact donor copies. The new path consumes only the existing collateral, validates command-bound state, preserves both currency amounts and handles cancellation across a successor. No unresolved critical or major finding in this scoped change after the fixes and tests below.

## Findings addressed before commit

- Temporary APK renewal transactions initially survived successful posts. The renewal callback now deletes the build workspace; MDS also cleans success/failure and stale service workspaces at restart.
- Startup-only MDS key loading could miss an identity created later by the UI. The existing parser now refreshes before block processing; a real service VM regression exercises this.
- Foreground heartbeat suppression would have disabled service renewal while the casino page was open. Phase-0 upkeep now runs before that suppression; only reveal/resolve ownership uses the heartbeat.
- Cancellation could otherwise lose a race to renewal and leave a new offer open. Both manual UIs and APK persist a commitment-keyed intent; renewal rechecks before posting and upkeep follows a young phase-0 successor after restart.

## Validation and limits

25 Android tests, release build and lint passed. 22 parity/regression tests and existing desktop transaction glue checks passed. Six complete APK/JS plans compare equal and execute in the real offline KISS VM for both currencies and all games. The oracle checks subsequent taking and adversarial signer/term changes. Tests do not prove network mining, mobile background scheduling or live multi-device discovery. No live bets were spent for testing. Broader previously identified settlement-precision and unrelated transaction-validation differences remain outside this scoped approval.

## Verdict

Approve this scoped keepalive change for integration. Retain the documented release smoke checks and rebuild the desktop after merging concurrent work.
