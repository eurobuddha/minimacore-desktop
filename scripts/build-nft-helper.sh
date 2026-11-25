#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
classes=$(mktemp -d)
trap 'rm -rf "$classes"' EXIT
javac --release 11 -cp nft-helper/json-20240303.jar -d "$classes" nft-helper/*.java
unzip -q nft-helper/json-20240303.jar 'org/json/*' -d "$classes"
jar --create --file resources/nftwallet.jar --date=2026-01-01T00:00:00Z -C "$classes" .
