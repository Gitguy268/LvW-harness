#!/usr/bin/env bash
# Builds src/webui/vendor/whisper/ (lvw-whisper.js + .wasm) from a pinned whisper.cpp tag.
# Needs emsdk on PATH (source emsdk_env.sh). Usage: scripts/build-whisper-wasm.sh [workdir]
set -euo pipefail
TAG=v1.9.5
COMMIT=d1be6fde11ac6e0407606b4e42fe72d34add8037
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${1:-$(mktemp -d)}"
OUT="$HERE/../src/webui/vendor/whisper"
command -v emcmake >/dev/null || { echo "emcmake not found: source emsdk_env.sh first" >&2; exit 1; }
if [ ! -d "$WORK/whisper.cpp" ]; then
  git clone --depth 1 --branch "$TAG" https://github.com/ggml-org/whisper.cpp.git "$WORK/whisper.cpp"
fi
[ "$(git -C "$WORK/whisper.cpp" rev-parse HEAD)" = "$COMMIT" ] || { echo "whisper.cpp $TAG is not $COMMIT" >&2; exit 1; }
emcmake cmake -S "$HERE/whisper-wasm" -B "$WORK/build" -DWHISPER_SRC="$WORK/whisper.cpp" -DCMAKE_BUILD_TYPE=Release -DGGML_OPENMP=OFF
cmake --build "$WORK/build" --target lvw-whisper -j
mkdir -p "$OUT"
cp "$WORK"/build/lvw-whisper.js "$WORK"/build/lvw-whisper.wasm "$OUT/"
cp "$WORK/whisper.cpp/LICENSE" "$OUT/LICENSE-whisper.cpp"
echo "$TAG $COMMIT" > "$OUT/VERSION"
ls -la "$OUT"
