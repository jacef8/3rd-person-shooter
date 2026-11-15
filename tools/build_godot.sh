#!/usr/bin/env bash
# Builds the Godot client: bakes the map, exports the web build (served at /g/, stored gzipped in
# godot/web) and, with ANDROID=1, the APK (client/apk/deadzone-godot.apk). Needs Godot 4.5.1 and its
# export templates (GODOT=path to the binary).
set -euo pipefail
cd "$(dirname "$0")/.."
GODOT=${GODOT:-/opt/godot/Godot_v4.5.1-stable_linux.x86_64}
[ "${SKIP_MAP:-0}" = 1 ] || node tools/export_godot_map.mjs 10
cd godot
"$GODOT" --headless --path . --import >/dev/null 2>&1 || true
mkdir -p build/web
"$GODOT" --headless --path . --export-release "Web" build/web/index.html
rm -rf web && mkdir -p web
cp build/web/index.html build/web/index.js build/web/*.worklet.js build/web/*.png web/
gzip -9 -c build/web/index.wasm > web/index.wasm.gz
gzip -9 -c build/web/index.pck > web/index.pck.gz
if [ "${ANDROID:-0}" = 1 ]; then
  mkdir -p build/android
  "$GODOT" --headless --path . --export-debug "Android" build/android/deadzone.apk
  cp build/android/deadzone.apk ../client/apk/deadzone-godot.apk
fi
ls -la web
