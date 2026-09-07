#!/usr/bin/env bash
# Publish a minimaCore Desktop release: the signed+verified DMG to the GitHub release v<ver>, then the
# one-app store feed (manifest only, sha256 per file) to the eurobuddha.com store host, which the app's
# in-app updater reads (main/updater.js): https://eurobuddha.com/pandaapps/minimacore-desktop.json
# Usage: scripts/publish-desktop.sh <ver> ["release notes"]     (run after: npm run dist:mac:signed)
set -euo pipefail
cd "$(dirname "$0")/.."
VER="${1:?version, e.g. 0.16.27}"; NOTES="${2:-minimaCore Desktop $VER}"
DMG="dist/minimaCore-$VER-arm64.dmg"
[ -f "$DMG" ] || { echo "no $DMG — build it first (npm run dist:mac:signed)"; exit 1; }
xcrun stapler validate "$DMG" > /dev/null || { echo "$DMG is not notarized+stapled — refusing"; exit 1; }
REPO="eurobuddha/minimacore-desktop"
HOST="${STORE_HOST:-root@eurobuddha.com}"
REMOTE_DIR="/var/www/html/pandaapps"
FEED="pandaapps/minimacore-desktop.json"
SHA=$(shasum -a 256 "$DMG" | cut -d' ' -f1)
SIZE=$(stat -f%z "$DMG")
echo "== GitHub release v$VER"
if gh release view "v$VER" -R "$REPO" > /dev/null 2>&1; then
  gh release upload "v$VER" "$DMG" --clobber -R "$REPO"
else
  gh release create "v$VER" "$DMG" --title "minimaCore Desktop $VER" --notes "$NOTES
sha256 $SHA" -R "$REPO"
fi
FILE_URL="https://github.com/$REPO/releases/download/v$VER/minimaCore-$VER-arm64.dmg"
echo "== feed"
mkdir -p pandaapps
python3 - "$VER" "$NOTES" "$FILE_URL" "$SHA" "$SIZE" "$FEED" <<'PY'
import json, sys, datetime, os
ver, notes, url, sha, size, feed = sys.argv[1:7]
doc = {"app": "minimaCore Desktop", "version": ver, "date": datetime.date.today().isoformat(), "notes": notes, "platforms": {}}
if os.path.exists(feed):
    try: doc["platforms"] = json.load(open(feed)).get("platforms", {})   # keep other platforms' rows until they are rebuilt
    except Exception: pass
doc["platforms"]["mac-arm64"] = {"file": url, "sha256": sha, "size": int(size)}
json.dump(doc, open(feed, "w"), indent=2); print(open(feed).read())
PY
echo "== upload the feed to $HOST:$REMOTE_DIR"
ssh "$HOST" "mkdir -p $REMOTE_DIR"
scp "$FEED" "$HOST:$REMOTE_DIR/minimacore-desktop.json"
curl -fsSL https://eurobuddha.com/pandaapps/minimacore-desktop.json | python3 -c "import sys,json; d=json.load(sys.stdin); print('live feed:', d['version'], d['platforms']['mac-arm64']['file'])"
