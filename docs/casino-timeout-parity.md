# Casino timeout / My Bets parity handoff

This branch ports APK 0.7.1 into P2PChance. It is based on desktop commit 785f787 (0.16.65), with an isolated prerelease version 0.16.66-casino-parity.1. When integrating, retain the newest Parlons/node changes and choose the next desktop release version in package.json and package-lock.json. Do not downgrade the current master version or parlonsNode field.

Changes: My Bets lists both currencies with per-coin labels and counts; a banner links to eligible timeout claims; phase 1 belongs to the player, phase 2 to the house, strictly after the deadline. Failed scans retain the last successful view. Background reminders persist coin IDs, deduplicate across restarts and retract after the final claim disappears. Notification clicks open My Bets. Existing reveal/resolve processing still handles both currencies.

Donor: universal-casino mds/ (version 2.9.1, casino-timeout-parity branch). Copy service.js and timeout-claims.js byte-for-byte into main/casino/. The parity gate enforces both copies.

Validation: npm run test:casino passed all 11 regression tests and existing transaction glue checks, including 160 comparisons with the APK Java policy and identical covenant text. Run ./gradlew testDebugUnitTest in the APK repository first to build the dependency classes. CASINO_APK and CASINO_DONOR override source locations. The test recompiles the current APK policy sources. Existing APK tests passed.

MDS cannot silently update notifications or deep-link a tab: it uses the foreground banner and a saved flag to open My Bets on next launch; partial removals do not make a new sound. The last removal cancels. Desktop supports direct click routing and silent notifications while focused.

The earlier local 0.16.51 DMG was signed/notarized but predates concurrent desktop work. Rebuild the integrated desktop version; do not publish that older DMG. Browser security policy blocked the isolated local visual preview; renderer behaviour is covered by executable VM fixtures, not a claimed live visual/device test.

Separate open review finding: phase-0 offers have no keepalive renewal in APK AutoProcessor, donor autoProcess/service, or desktop service. REPOST_AFTER only retries phase-1 reveal / phase-2 resolve. After cascade, nodes retain their own relevant coins while losing foreign offers from the searchable tree. The 0.6.8 trackall:false and 0.6.10 hygiene changes exposed this discovery limitation; 0.7.0/0.7.1 did not remove a renewal branch. This port does not fix open-offer renewal. Do not describe it as complete casino parity or an adversarial-security clearance.
