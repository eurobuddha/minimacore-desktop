#!/usr/bin/env bash
# notarize-dmg.sh [dmg] [keychain profile] — electron-builder notarizes + staples the .app inside the DMG;
# this notarizes the DMG itself as well and staples the ticket to it, so a downloaded DMG verifies with
# no network (Gatekeeper checks the DMG before the app). Idempotent: skips when already stapled.
set -euo pipefail
cd "$(dirname "$0")/.."
DMG="${1:-$(ls dist/*.dmg 2>/dev/null | sort -V | tail -1)}"
PROFILE="${2:-${APPLE_KEYCHAIN_PROFILE:-minimadesk}}"
[ -f "$DMG" ] || { echo "no dmg: $DMG"; exit 1; }
# Sign the disk image itself as well as the app inside it. Reuse the release
# identity selection used by Parlons Desktop; never replace an existing valid ID.
DMG_SIGNED_NOW=false
DMG_SIGN_INFO=$(codesign -dv --verbose=2 "$DMG" 2>&1 || true)
if ! echo "$DMG_SIGN_INFO" | grep -q 'Authority=Developer ID Application'; then
  DMG_SIGN_IDENTITY="${CSC_NAME:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)}"
  [ -n "$DMG_SIGN_IDENTITY" ] || { echo "no Developer ID Application identity for the DMG"; exit 1; }
  codesign --force --sign "$DMG_SIGN_IDENTITY" --timestamp "$DMG"
  DMG_SIGNED_NOW=true
fi
codesign --verify --strict "$DMG"
if [ "$DMG_SIGNED_NOW" = false ] && xcrun stapler validate "$DMG" > /dev/null 2>&1; then echo "already stapled: $DMG"; exit 0; fi
echo "notarizing $DMG (profile $PROFILE)…"
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$DMG"
echo "stapled: $DMG"
