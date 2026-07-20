#!/bin/bash
# PARITY GATE: main/casino/service.js (the Zero Edge Casino background auto-processor) must stay BYTE-IDENTICAL
# to the donor ~/Projects/Ideas/universal-casino/mds/service.js. A change is a FILE COPY from the donor, never a
# hand-edit — the auto-reveal/auto-resolve path is fund-critical. Desktop-only glue (loader.js, engine.js,
# casino.js) is exempt: engine.js lifts the donor's index.html txn command-strings verbatim but is NOT a whole-file
# copy, so it is reviewed, not byte-checked.
set -e
cd "$(dirname "$0")/.."
DONOR="${CASINO_DONOR:-$HOME/Projects/Ideas/universal-casino/mds}"
[ -d "$DONOR" ] || { echo "donor dir not found at $DONOR"; exit 2; }

if ! diff -q "main/casino/service.js" "$DONOR/service.js" >/dev/null 2>&1; then
  echo "PARITY FAIL: main/casino/service.js differs from donor $DONOR/service.js"
  exit 1
fi
echo "casino parity OK — service.js byte-identical to the donor (Zero Edge Casino v2.8.3)"
