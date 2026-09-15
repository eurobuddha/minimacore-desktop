#!/usr/bin/env bash
# Fetch the Parlons Node jar (eurobuddha/maxima, newest node-v* release) into resources/parlons-node.jar.
# Pin a version with PARLONS_NODE_VERSION=0.2.45. The jar is gitignored: CI and a local build both run this
# before packaging.
#
# VERIFICATION, IN ORDER OF AUTHORITY:
#   1. package.json "parlonsNodeSha256" — the digest committed to THIS repo. This is the only check with any
#      authority: SHA256SUMS ships from the same GitHub release as the jar, so whoever can replace the asset
#      can replace the sums file too. Checking a download against a checksum served beside it proves the
#      bytes arrived intact, not that they are the bytes we meant to ship. The pin is what proves that, and
#      it is how main/pandapools is already gated (scripts/pandapools-parity.manifest.json).
#   2. the release's SHA256SUMS — kept as a transport check, and it must AGREE with the pin.
#
# An empty grep result used to pass as a successful verification: `grep ... | sha256sum -c -` exits 0 on
# EMPTY stdin (GNU coreutils; macOS shasum exits 1), so a renamed or missing asset verified nothing at all
# and the jar shipped anyway on the linux/windows legs. Every match is now asserted non-empty first.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p resources
REPO="eurobuddha/maxima"
JAR_DEST="resources/parlons-node.jar"
sha_of() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi; }
API="https://api.github.com/repos/$REPO/releases?per_page=50"
# The releases API is only asked when nothing pins the version (it is rate-limited per runner IP: 403s
# on shared CI hosts); an auth token, when the environment has one, lifts the limit.
AUTH=(); [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ] && AUTH=(-H "Authorization: Bearer ${GH_TOKEN:-$GITHUB_TOKEN}")
api_json() { curl -fsSL "${AUTH[@]}" "$API" 2>/dev/null || true; }
# Default pin: package.json "parlonsNode" (the version the last local build shipped), so CI's Windows and
# Linux installers carry exactly the same Parlons Node as the Mac DMG. Override with PARLONS_NODE_VERSION.
if [ -z "${PARLONS_NODE_VERSION:-}" ] && [ -f package.json ]; then
  PARLONS_NODE_VERSION="$(node -p "require('./package.json').parlonsNode || ''" 2>/dev/null || true)"
fi
# The committed digest for that pinned version (empty when the version was overridden on the command line).
PINNED_SHA=""
if [ -f package.json ] && [ "${PARLONS_NODE_VERSION:-}" = "$(node -p "require('./package.json').parlonsNode || ''" 2>/dev/null || true)" ]; then
  PINNED_SHA="$(node -p "require('./package.json').parlonsNodeSha256 || ''" 2>/dev/null || true)"
fi
# A jar already sitting in resources/ is only reusable if it IS the pinned one. It is gitignored, so it goes
# stale silently: the checked-in pin said 0.2.112 while a local tree still held 0.2.108, which would have put
# a different node in the local Mac DMG than in CI's Windows and Linux installers — the exact drift the pin
# exists to stop. Re-fetch on any mismatch rather than trusting whatever is on disk.
if [ -n "$PINNED_SHA" ] && [ -f "$JAR_DEST" ]; then
  HAVE="$(sha_of "$JAR_DEST")"
  if [ "$HAVE" = "$PINNED_SHA" ]; then
    echo "$JAR_DEST already matches the pinned $PARLONS_NODE_VERSION digest — keeping it"
    exit 0
  fi
  echo "$JAR_DEST does NOT match the pinned $PARLONS_NODE_VERSION digest (have $HAVE) — re-fetching"
fi
if [ -n "${PARLONS_NODE_VERSION:-}" ]; then
  JAR_URL="https://github.com/$REPO/releases/download/node-v$PARLONS_NODE_VERSION/parlons-node-$PARLONS_NODE_VERSION.jar"
  SUM_URL="https://github.com/$REPO/releases/download/node-v$PARLONS_NODE_VERSION/SHA256SUMS"
else
  # The releases API lags a just-created release by minutes; gh's list is consistent - prefer it.
  # (gh is unauthenticated on CI runners: a failed listing falls through to the API, it must not abort)
  NEWEST="$( (gh release list -R "$REPO" --limit 100 2>/dev/null || true) | grep -oE '^node-v[0-9.]+' | sort -t. -k3,3n | tail -1 | sed 's/^node-v//' || true)"
  if [ -n "$NEWEST" ]; then
    JAR_URL="https://github.com/$REPO/releases/download/node-v$NEWEST/parlons-node-$NEWEST.jar"
    SUM_URL="https://github.com/$REPO/releases/download/node-v$NEWEST/SHA256SUMS"
  else
    JSON="$(api_json)"
    JAR_URL="$(printf '%s' "$JSON" | grep -oE 'https://github.com/[^"]+/node-v[^"]+/parlons-node-[0-9.]+\.jar' | head -1 || true)"
    SUM_URL="$(printf '%s' "$JSON" | grep -oE 'https://github.com/[^"]+/node-v[^"]+/SHA256SUMS' | head -1 || true)"
  fi
fi
[ -n "$JAR_URL" ] || { echo "no node-v* release with a parlons-node jar found"; exit 1; }
NAME="$(basename "$JAR_URL")"
TMP="$(mktemp -d)"
echo "fetching $JAR_URL"
curl -fSL -o "$TMP/$NAME" "$JAR_URL"
curl -fsSL -o "$TMP/SHA256SUMS" "$SUM_URL"

GOT="$(sha_of "$TMP/$NAME")"

# 1. the committed pin — the only check with authority (see the header).
if [ -n "$PINNED_SHA" ]; then
  [ "$GOT" = "$PINNED_SHA" ] || {
    echo "FAIL: $NAME sha256 $GOT does not match the digest pinned in package.json ($PINNED_SHA)."
    echo "      Either the release was altered, or the pin is stale — if you deliberately moved to a new"
    echo "      node, update BOTH parlonsNode and parlonsNodeSha256 in package.json in the same commit."
    rm -rf "$TMP"; exit 1; }
else
  echo "WARNING: no parlonsNodeSha256 pin for this version — falling back to the release's own SHA256SUMS,"
  echo "         which only proves the download arrived intact, not that it is the jar we meant to ship."
fi

# 2. the release's SHA256SUMS — transport check, and it must agree with the pin.
#    Assert the line exists: an empty match piped into `sha256sum -c -` exits 0 and verifies NOTHING.
LINE="$(grep " $NAME\$" "$TMP/SHA256SUMS" || true)"
[ -n "$LINE" ] || { echo "FAIL: $NAME has no entry in the release's SHA256SUMS — refusing to ship it."; rm -rf "$TMP"; exit 1; }
SUM_SHA="${LINE%% *}"
[ "$SUM_SHA" = "$GOT" ] || { echo "FAIL: $NAME sha256 $GOT != SHA256SUMS $SUM_SHA"; rm -rf "$TMP"; exit 1; }

mv "$TMP/$NAME" "$JAR_DEST"
rm -rf "$TMP"
echo "$JAR_DEST = $NAME sha256 $GOT ($(du -h "$JAR_DEST" | cut -f1))"
java -jar resources/parlons-node.jar -v 2>/dev/null || true
