#!/bin/sh
# Compile the platform-independent helper against the same public classes as the packaged node.
set -eu
cd "$(dirname "$0")/.."
classes=$(mktemp -d)
trap 'rm -rf "$classes"' EXIT
javac --release 11 -cp resources/minima.jar -d "$classes" wallet-helper/com/eurobuddha/wallet/*.java wallet-helper/ClassicWebWallet.java
jar --create --file resources/classic-webwallet.jar --date=2026-01-01T00:00:00Z -C "$classes" .
