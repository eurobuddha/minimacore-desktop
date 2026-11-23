#!/usr/bin/env bash
# The node jars the installer bundles must be the pinned ones (0.18.317). resources/*.jar are gitignored and go stale
# silently: on 2026-11-23 this tree still held parlons-node 0.2.152 (sha256
# 1b3a0dc7921675d54e96a611be5a37194116227c4529e32d8aeb74bb72ec1fd1), from before the node's command-injection fix,
# while package.json pinned 0.2.162. A signed build packaged whatever sat there. Now it refuses: each jar's sha256 must
# equal package.json "parlonsNodeSha256" / "minimaJarSha256". Fix a mismatch with scripts/fetch-parlons-node-jar.sh
# (or by copying the pinned minima.jar), never by editing the pin.
# 0.18.321: an optional directory to check instead of resources/: scripts/verify-mac.sh passes the built app's
# Contents/Resources, so what is checked is what ships. Every dist:* script runs it first; CI runs it after the fetch.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${1:-resources}"
sha_of() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi; }
fail=0
for pair in "$DIR/parlons-node.jar:parlonsNodeSha256" "$DIR/minima.jar:minimaJarSha256"; do
  jar="${pair%%:*}"; key="${pair##*:}"
  want="$(node -p "require('./package.json').$key || ''")"
  [ -n "$want" ] || { echo "FAIL package.json has no $key"; fail=1; continue; }
  [ -f "$jar" ] || { echo "FAIL $jar is missing"; fail=1; continue; }
  have="$(sha_of "$jar")"
  if [ "$have" = "$want" ]; then echo "OK   $jar $have"; else echo "FAIL $jar is $have, the pin ($key) is $want"; fail=1; fi
done
[ "$fail" -eq 0 ] || { echo "Refusing to build or release with a node jar that is not the pinned one."; exit 1; }
