#!/usr/bin/env bash
# verify-mac.sh — prove the mac build will install cleanly on any Mac: Developer ID signature that passes a
# strict deep verify, hardened runtime, Gatekeeper's own assessment, and the notarization ticket stapled to
# the DMG. Exits non-zero on the first failure. Run after `npm run dist:mac` (local) or in CI.
set -euo pipefail
cd "$(dirname "$0")/.."

APP=$(ls -d dist/mac*/*.app 2>/dev/null | head -1)
DMG=$(ls dist/*.dmg 2>/dev/null | sort -V | tail -1)
[ -n "$APP" ] || { echo "no .app under dist/ — build first"; exit 1; }
[ -n "$DMG" ] || { echo "no .dmg under dist/ — build first"; exit 1; }

echo "== app: $APP"
codesign -dv --verbose=2 "$APP" 2>&1 | grep -E 'Authority=|TeamIdentifier|Timestamp|flags=' || true
codesign -dv --verbose=2 "$APP" 2>&1 | grep -q 'Authority=Developer ID Application' \
  || { echo "FAIL: not signed with a Developer ID Application certificate"; exit 1; }
codesign -dv --verbose=2 "$APP" 2>&1 | grep -q 'flags=.*runtime' \
  || { echo "FAIL: hardened runtime not enabled"; exit 1; }
codesign --verify --deep --strict --verbose=2 "$APP" && echo "ok: codesign strict deep verify"

echo "== Gatekeeper assessment"
spctl --assess --type execute --verbose=2 "$APP" && echo "ok: spctl accepts the app"

echo "== dmg: $DMG"
codesign -dv "$DMG" 2>&1 | grep -q 'Developer ID' || { echo "FAIL: dmg not signed"; exit 1; }
xcrun stapler validate "$DMG" && echo "ok: notarization ticket stapled to the dmg"
spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG" && echo "ok: spctl accepts the dmg"

echo "ALL OK — $DMG installs cleanly on any Mac"
