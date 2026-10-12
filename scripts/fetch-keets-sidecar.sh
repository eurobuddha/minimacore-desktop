#!/usr/bin/env bash
# Install the keets sidecar's node_modules (hyperswarm, exact-pinned by the committed lockfile).
# The sidecar source (index.js/package.json/package-lock.json) IS in git — only node_modules is not
# (global node_modules/ ignore). CI and a fresh clone run this before electron-builder; the prebuild
# native modules (udx-native, sodium-native) ship binaries for every desktop platform, so one install
# serves all three targets.
set -euo pipefail
cd "$(dirname "$0")/../resources/keets-sidecar"
npm ci --omit=dev
node -e "require('hyperswarm'); console.log('keets sidecar deps OK')"
