#!/bin/bash
# dev-run.sh — start THIS app from source as a TEST copy that cannot touch the real install. See docs/DEV_RUN.md.
#
#   scripts/dev-run.sh [profile-folder] [--port <basePort>] [--jars <dir>]
#
# - its own folder (default ~/Library/Application Support/MinimaCoreDesktop-TEST): config, node data, wallet,
#   every engine's store. Refused if it is, is inside, or contains the real minimaCore folder, or if it already
#   holds something this script did not create.
# - its own ports: basePort (default 23001; the real app's default is 12001) and base+1..+5, +584, +586 are
#   probed EVERY run and the run is refused if anything listens on one. (The app stops "a node left running on
#   our port" before starting its own: on a port another node holds, that would be that node.) The port is
#   written into the profile's config.json on the first run only; later runs read it from there.
# - its own keychain names, no login item, no update feed (main/flavor.js, switched on by MCD_TEST_PROFILE).
#   The app is started WITHOUT --user-data-dir: it sets its folder itself and refuses that switch (0.19.105; with
#   the switch the app's own "is this the real folder?" check compared the profile with itself).
# - node jars: never fetched. Missing jars are a refusal with the copy commands; --jars <dir> copies them.
#   The sha256 of every jar that will run is printed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
REAL_DIRS=("$HOME/Library/Application Support/minimaCore" "$HOME/.config/minimaCore" "${APPDATA:-$HOME/AppData/Roaming}/minimaCore")
PROFILE="$HOME/Library/Application Support/MinimaCoreDesktop-TEST"
PORT=""; JARS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:?--port needs a number}"; shift 2 ;;
    --jars) JARS="${2:?--jars needs a folder}"; shift 2 ;;
    -h|--help) sed -n 2,17p "$0"; exit 0 ;;
    -*) echo "REFUSED: unknown option $1"; exit 2 ;;
    *) PROFILE="$1"; shift ;;
  esac
done
refuse() { echo "REFUSED: $*" >&2; echo "Nothing was started." >&2; exit 2; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
# the folder as the file system sees it: resolve the deepest part that exists (symlinks included), keep the rest
canon() {
  local p="$1" tail=""
  case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
  while [ ! -d "$p" ]; do tail="/$(basename "$p")$tail"; p="$(dirname "$p")"; done
  printf '%s%s' "$(cd "$p" && pwd -P)" "$tail"
}
PROFILE="$(canon "$PROFILE")"
case "$PROFILE" in *..*) refuse "the profile folder must not contain '..': $PROFILE" ;; esac
for real in "${REAL_DIRS[@]}"; do
  r="$(lower "$(canon "$real")")"; p="$(lower "$PROFILE")"
  case "$p/" in "$r/"*) refuse "the profile folder $PROFILE is, or is inside, the real install's folder $real" ;; esac
  case "$r/" in "$p/"*) refuse "the profile folder $PROFILE contains the real install's folder $real" ;; esac
done
MARK="$PROFILE/TEST_PROFILE"
if [ -d "$PROFILE" ] && [ -n "$(ls -A "$PROFILE" 2>/dev/null)" ] && [ ! -f "$MARK" ]; then
  refuse "$PROFILE already holds files and was not created by this script (no TEST_PROFILE file in it). Use an empty or new folder."
fi

# ---- jars ----
RES="$ROOT/resources"
if [ -n "$JARS" ]; then
  [ -d "$JARS" ] || refuse "--jars: no such folder: $JARS"
  for pair in "minima:minima.jar" "parlons-node:parlons-node.jar"; do
    stem="${pair%%:*}"; dest="${pair##*:}"
    found=(); while IFS= read -r f; do found+=("$f"); done < <(find "$JARS" -maxdepth 1 -type f -name "$stem*.jar" | sort)
    [ "${#found[@]}" -eq 1 ] || refuse "--jars: expected exactly one $stem*.jar in $JARS, found ${#found[@]}"
    cp "${found[0]}" "$RES/$dest"; echo "copied ${found[0]} -> $RES/$dest"
  done
  if ! git -C "$ROOT" diff --quiet -- resources/minima.jar 2>/dev/null; then
    echo "NOTE: resources/minima.jar is a tracked file and now differs from the commit. Do not commit it; 'git -C \"$ROOT\" checkout resources/minima.jar' puts the shipped one back."
  fi
fi
missing=0
for jar in minima.jar parlons-node.jar; do [ -f "$RES/$jar" ] || { echo "MISSING: $RES/$jar" >&2; missing=1; }; done
if [ "$missing" = 1 ]; then
  cat >&2 <<MSG
REFUSED: a node jar is missing, and this script does not fetch or copy jars by itself. Copy them yourself:
  the jars package.json pins (classic wallets only: minima 1.1.2.3-euro8, parlons-node 0.2.162):
    cp "$HOME/Projects/minima/_artifacts/node-cmdinject-2026-11-21/minima-1.1.2.3-euro8.jar" "$RES/minima.jar"
    cp "$HOME/Projects/minima/_artifacts/node-cmdinject-2026-11-21/parlons-node-0.2.162.jar" "$RES/parlons-node.jar"
  the block-capable jars the pandamonium flavour pins (minima 1.1.2.31-euro14-chatonly, parlons-node 0.2.160-chatonly-rpc8; they know -keetschatonly):
    cp "$HOME/Projects/minima/_artifacts/node-cmdinject-2026-11-21/minima-1.1.2.31-euro14-block-chatonly.jar" "$RES/minima.jar"
    cp "$HOME/Projects/minima/_artifacts/node-cmdinject-2026-11-21/parlons-node-0.2.160-block-chatonly-rpc8.jar" "$RES/parlons-node.jar"
  or let this script copy a folder's pair:  scripts/dev-run.sh --jars <dir>
Nothing was started.
MSG
  exit 2
fi
if [ -x "$RES/jre/bin/java" ]; then JAVA="$RES/jre/bin/java"; else JAVA="$(command -v java || true)"; fi
[ -n "$JAVA" ] || refuse "no Java: there is no $RES/jre and no java on PATH. Copy the bundled one: cp -R \"$HOME/Projects/minima/desktop/minimacore-desktop/resources/jre\" \"$RES/jre\""
ELECTRON="$ROOT/node_modules/.bin/electron"
[ -x "$ELECTRON" ] || refuse "Electron is not installed in $ROOT/node_modules (run: npm ci)"
command -v node >/dev/null || refuse "node is not on PATH"

# ---- ports ----
CONF="$PROFILE/config.json"
if [ -f "$CONF" ]; then
  SAVED="$(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(c.basePort||""))}catch(e){}' "$CONF")"
  [ -n "$SAVED" ] || refuse "$CONF has no basePort. Fix or remove that file."
  DATA="$(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(c.dataFolder||""))}catch(e){}' "$CONF")"
  if [ -n "$DATA" ]; then case "$(lower "$(canon "$DATA")")/" in "$(lower "$PROFILE")/"*) ;; *) refuse "this profile's config.json keeps its node data OUTSIDE the profile ($DATA). A TEST copy must not run on another install's node data. Remove dataFolder from $CONF." ;; esac; fi
  if [ -n "$PORT" ] && [ "$PORT" != "$SAVED" ]; then refuse "this profile already runs on base port $SAVED (config.json); --port is for the first run only. Change it in the app's Settings, or use another profile folder."; fi
  PORT="$SAVED"
else
  PORT="${PORT:-23001}"
fi
case "$PORT" in ''|*[!0-9]*) refuse "the base port must be a number: $PORT" ;; esac
[ "$PORT" -ge 1024 ] && [ "$PORT" -le 64900 ] || refuse "the base port must be between 1024 and 64900: $PORT"
[ "$PORT" != 12001 ] || refuse "12001 is the real app's default base port. Choose another with --port."
[ "$PORT" != 17001 ] || refuse "17001 is Pandamonium Desktop's default base port. Choose another with --port."
busy=""
for off in 0 1 2 3 4 5 584 586; do
  n=$((PORT + off))
  if lsof -nP -iTCP:"$n" -sTCP:LISTEN >/dev/null 2>&1 || nc -z -G 1 127.0.0.1 "$n" >/dev/null 2>&1; then busy="$busy $n"; fi
done
[ -z "$busy" ] || refuse "something is already listening on port(s)$busy (base port $PORT uses $PORT to $((PORT + 5)), $((PORT + 584)) and $((PORT + 586))). If that is this TEST profile's own node from an earlier run, stop it first; otherwise choose another base with --port on a new profile."

# ---- first run: the folder, its mark, its port ----
mkdir -p "$PROFILE"
[ -f "$MARK" ] || echo "Created by scripts/dev-run.sh. A TEST copy of Minima Core Desktop: nothing here belongs to the real install." > "$MARK"
[ -f "$CONF" ] || { printf '{\n  "basePort": %s\n}\n' "$PORT" > "$CONF"; echo "first run: base port $PORT written to $CONF"; }

echo "TEST profile : $PROFILE"
echo "ports        : $PORT (node), $((PORT + 4)) (RPC), $((PORT + 5)) (keets sidecar), $((PORT + 584)) and $((PORT + 586)) (Parlons)"
echo "java         : $JAVA"
echo "jars that will run (sha256):"
for jar in minima.jar parlons-node.jar; do echo "  $(shasum -a 256 "$RES/$jar" | cut -d' ' -f1)  $RES/$jar"; done
PIN="$(node -e 'process.stdout.write(require(process.argv[1]).parlonsNodeSha256||"")' "$ROOT/package.json")"
echo "  (package.json pins parlons-node.jar at $PIN)"
echo "keychain     : its own service name (com.eurobuddha.minimacore.rpc.test.<sha256 of the folder>), its own Safe Storage key"
echo "starting. The window title, a red tag on every screen and the Dock badge say TEST."
unset ELECTRON_RUN_AS_NODE
MCD_TEST_PROFILE="$PROFILE" exec "$ELECTRON" "$ROOT"
