#!/usr/bin/env bash
# notarize-dmg.sh [dmg] [keychain profile] — electron-builder notarizes + staples the .app inside the DMG;
# this notarizes the DMG itself as well and staples the ticket to it, so a downloaded DMG verifies with
# no network (Gatekeeper checks the DMG before the app). Idempotent: skips when already stapled.
set -euo pipefail
cd "$(dirname "$0")/.."
DMG="${1:-$(ls dist/*.dmg 2>/dev/null | sort -V | tail -1)}"
PROFILE="${2:-${APPLE_KEYCHAIN_PROFILE:-minimadesk}}"
[ -f "$DMG" ] || { echo "no dmg: $DMG"; exit 1; }
if xcrun stapler validate "$DMG" > /dev/null 2>&1; then echo "already stapled: $DMG"; exit 0; fi
echo "notarizing $DMG (profile $PROFILE)…"
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$DMG"
echo "stapled: $DMG"
