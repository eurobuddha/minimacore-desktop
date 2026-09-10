# Casino timeout / My Bets parity handoff

This branch ports APK 0.7.1 into P2PChance. It is based on desktop commit 785f787 (0.16.65), with an isolated prerelease version 0.16.66-casino-parity.2. When integrating, retain the newest Parlons/node changes and choose the next desktop release version in package.json and package-lock.json. Do not downgrade the current master version or parlonsNode field.

Changes: My Bets lists both currencies with per-coin labels and counts; a banner links to eligible timeout claims; phase 1 belongs to the player, phase 2 to the house, strictly after the deadline. Failed scans retain the last successful view. Background reminders persist coin IDs, deduplicate across restarts and retract after the final claim disappears. Notification clicks open My Bets. Existing reveal/resolve processing still handles both currencies.

Donor: universal-casino mds/ (version 2.9.2, casino-timeout-parity branch). Copy service.js, timeout-claims.js and offer-keepalive.js byte-for-byte into main/casino/. The parity gate enforces all three copies.

Validation: npm run test:casino passed all 11 regression tests and existing transaction glue checks, including 160 comparisons with the APK Java policy and identical covenant text. Run ./gradlew testDebugUnitTest in the APK repository first to build the dependency classes. CASINO_APK and CASINO_DONOR override source locations. The test recompiles the current APK policy sources. Existing APK tests passed.

MDS cannot silently update notifications or deep-link a tab: it uses the foreground banner and a saved flag to open My Bets on next launch; partial removals do not make a new sound. The last removal cancels. Desktop supports direct click routing and silent notifications while focused.

The earlier local 0.16.51 DMG was signed/notarized but predates concurrent desktop work. Rebuild the integrated desktop version; do not publish that older DMG. Browser security policy blocked the isolated local visual preview; renderer behaviour is covered by executable VM fixtures, not a claimed live visual/device test.

The follow-up fixes phase-0 keepalive as well. See [casino-open-offer-keepalive.md](casino-open-offer-keepalive.md) for cause, behavior and expanded 22-test validation. Integrate this branch with the donor casino-timeout-parity branch and APK casino-open-offer-keepalive branch. Preserve concurrent desktop changes and choose the next release version; these commits are a handoff, not a published desktop release.
