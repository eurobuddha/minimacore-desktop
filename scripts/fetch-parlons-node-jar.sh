#!/usr/bin/env bash
# Fetch the Parlons Node jar (eurobuddha/maxima, newest node-v* release) into resources/parlons-node.jar,
# verifying it against the release's SHA256SUMS. Pin a version with PARLONS_NODE_VERSION=0.2.45.
# The jar is gitignored: CI and a local build both run this before packaging.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p resources
REPO="eurobuddha/maxima"
API="https://api.github.com/repos/$REPO/releases?per_page=50"
JSON="$(curl -fsSL "$API")"
if [ -n "${PARLONS_NODE_VERSION:-}" ]; then
  JAR_URL="https://github.com/$REPO/releases/download/node-v$PARLONS_NODE_VERSION/parlons-node-$PARLONS_NODE_VERSION.jar"
  SUM_URL="https://github.com/$REPO/releases/download/node-v$PARLONS_NODE_VERSION/SHA256SUMS"
else
  JAR_URL="$(printf '%s' "$JSON" | grep -oE 'https://github.com/[^"]+/node-v[^"]+/parlons-node-[0-9.]+\.jar' | head -1)"
  SUM_URL="$(printf '%s' "$JSON" | grep -oE 'https://github.com/[^"]+/node-v[^"]+/SHA256SUMS' | head -1)"
fi
[ -n "$JAR_URL" ] || { echo "no node-v* release with a parlons-node jar found"; exit 1; }
NAME="$(basename "$JAR_URL")"
TMP="$(mktemp -d)"
echo "fetching $JAR_URL"
curl -fSL -o "$TMP/$NAME" "$JAR_URL"
curl -fsSL -o "$TMP/SHA256SUMS" "$SUM_URL"
( cd "$TMP" && grep " $NAME\$" SHA256SUMS | shasum -a 256 -c - )
mv "$TMP/$NAME" resources/parlons-node.jar
rm -rf "$TMP"
echo "resources/parlons-node.jar = $NAME ($(du -h resources/parlons-node.jar | cut -f1))"
java -jar resources/parlons-node.jar -v 2>/dev/null || true
