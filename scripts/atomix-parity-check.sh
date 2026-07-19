#!/bin/bash
# PARITY GATE: every AtomiX engine file under main/atomix/ must be BYTE-IDENTICAL to the donor
# ~/Projects/atomix-mds (the canonical engine repo — same rule as main/pandapools/ vs pandapools-mds).
# A change is a FILE COPY from the donor, never a hand-edit. Desktop-only glue (loader.js) is exempt.
# Donor pinned at atomix-mds 0.1.9 (6f8376f) at module creation; the check diffs against the donor's
# WORKING TREE so a donor upgrade shows here as a diff until the copy is refreshed deliberately.
set -e
cd "$(dirname "$0")/.."
DONOR="${ATOMIX_DONOR:-$HOME/Projects/atomix-mds}"
[ -d "$DONOR" ] || { echo "donor repo not found at $DONOR"; exit 2; }

FAIL=0
# The manifest = service.js's own MDS.load list + service.js itself (the engine, complete).
FILES=$(grep -oE "MDS.load\('[^']+'\)" main/atomix/service.js | sed "s/MDS.load('//;s/')//")
FILES="$FILES service.js"
N=0
for f in $FILES; do
  N=$((N+1))
  if ! diff -q "main/atomix/$f" "$DONOR/$f" >/dev/null 2>&1; then
    echo "PARITY FAIL: main/atomix/$f differs from donor $DONOR/$f"
    FAIL=1
  fi
done
[ "$N" -ge 30 ] || { echo "PARITY FAIL: only $N files checked (manifest truncated?)"; exit 1; }
if [ "$FAIL" -ne 0 ]; then exit 1; fi
echo "atomix parity OK — $N engine files byte-identical to the donor"
