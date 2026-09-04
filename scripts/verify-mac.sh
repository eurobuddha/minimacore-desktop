#!/usr/bin/env bash
# verify-mac.sh — prove the mac build will install cleanly on any Mac: Developer ID signature that passes a
# strict deep verify, hardened runtime, Gatekeeper's own assessment, notarization tickets stapled to the app
# AND to the DMG (so it verifies offline). Exits non-zero on the first failure.
# Run after `npm run dist:mac` + scripts/notarize-dmg.sh (what `npm run dist:mac:signed` does), or in CI.
# NOTE: codesign output is captured into variables first — `codesign | grep -q` under pipefail fails on a
# PASSING check (grep closes the pipe early, codesign dies with SIGPIPE).
set -euo pipefail
cd "$(dirname "$0")/.."

APP=$(ls -d dist/mac*/*.app 2>/dev/null | head -1)
DMG=$(ls dist/*.dmg 2>/dev/null | sort -V | tail -1)
[ -n "$APP" ] || { echo "no .app under dist/ — build first"; exit 1; }
[ -n "$DMG" ] || { echo "no .dmg under dist/ — build first"; exit 1; }

echo "== app: $APP"
INFO=$(codesign -dv --verbose=2 "$APP" 2>&1 || true)
echo "$INFO" | grep -E 'Authority=Developer ID Application|TeamIdentifier|Timestamp|flags=' || true
echo "$INFO" | grep -q 'Authority=Developer ID Application' || { echo "FAIL: not signed with a Developer ID Application certificate"; exit 1; }
echo "$INFO" | grep -q 'flags=.*runtime' || { echo "FAIL: hardened runtime not enabled"; exit 1; }
codesign --verify --deep --strict --verbose=1 "$APP" && echo "ok: codesign strict deep verify"
xcrun stapler validate "$APP" > /dev/null && echo "ok: notarization ticket stapled to the app"
ASSESS=$(spctl --assess --type execute --verbose=2 "$APP" 2>&1 || true)
echo "$ASSESS" | grep -q 'accepted' || { echo "FAIL: Gatekeeper rejects the app: $ASSESS"; exit 1; }
echo "$ASSESS" | grep -q 'Notarized Developer ID' || { echo "FAIL: Gatekeeper does not see a notarized Developer ID app: $ASSESS"; exit 1; }
echo "ok: spctl accepts the app (Notarized Developer ID)"

echo "== dmg: $DMG"
xcrun stapler validate "$DMG" > /dev/null && echo "ok: notarization ticket stapled to the dmg" \
  || { echo "FAIL: no ticket stapled to the dmg — run scripts/notarize-dmg.sh"; exit 1; }
DASSESS=$(spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG" 2>&1 || true)
echo "$DASSESS" | grep -q 'accepted' || { echo "FAIL: Gatekeeper rejects the dmg: $DASSESS"; exit 1; }
echo "ok: spctl accepts the dmg"

echo "ALL OK — $DMG installs cleanly on any Mac"
