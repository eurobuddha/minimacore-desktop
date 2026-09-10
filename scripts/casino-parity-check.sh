#!/bin/bash
# PARITY GATE: main/casino/service.js (the Zero Edge Casino background auto-processor) must stay BYTE-IDENTICAL
# to the universal-casino donor's mds/service.js. A change is a FILE COPY from the donor, never a
# hand-edit — the auto-reveal/auto-resolve path is fund-critical. Desktop-only glue (loader.js, engine.js,
# casino.js) is exempt: engine.js lifts the donor's index.html txn command-strings verbatim but is NOT a whole-file
# copy, so it is reviewed, not byte-checked.
set -e
cd "$(dirname "$0")/.."
# Donor location: $CASINO_DONOR wins, else the first candidate that exists. The donor tree was moved under
# ~/Projects/archive/, so the original path is kept only as a fallback — without this the gate exited 2 and
# stopped checking a fund-critical file at all. NOTE: mds/tnzec in the build family is a DIFFERENT codebase,
# not this donor.
DONOR="$CASINO_DONOR"
if [ -z "$DONOR" ]; then
  for c in "$HOME/Projects/archive/Ideas/universal-casino/mds" "$HOME/Projects/Ideas/universal-casino/mds"; do
    [ -d "$c" ] && { DONOR="$c"; break; }
  done
fi
[ -n "$DONOR" ] && [ -d "$DONOR" ] || {
  echo "donor dir not found — looked for \$CASINO_DONOR, ~/Projects/archive/Ideas/universal-casino/mds, ~/Projects/Ideas/universal-casino/mds"; exit 2; }

if ! diff -q "main/casino/service.js" "$DONOR/service.js" >/dev/null 2>&1; then
  echo "PARITY FAIL: main/casino/service.js differs from donor $DONOR/service.js"
  exit 1
fi
diff -q "main/casino/timeout-claims.js" "$DONOR/timeout-claims.js"
echo "casino parity OK — service.js and timeout-claims.js byte-identical to the donor"
CASINO_DONOR="$DONOR" node --test scripts/casino-timeout-test.cjs
