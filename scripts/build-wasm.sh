#!/bin/sh
# Build the C scan core to docs/lib/lcc.wasm.
# Uses Emscripten when emcc is available, otherwise zig's wasm32-wasi target.
# Both produce the same exported C functions and a small WASI import surface.
set -e
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"
node scripts/gen-palette-tables.js

MODEL_FLAGS=""
if [ "${LCC_ENABLE_MODELS:-0}" = "1" ]; then
  MODEL_FLAGS="-DLCC_ENABLE_MODELS=1"
fi

SOURCES="
  native/lcc_util.c
  native/lcc_model.c
  native/lcc_color.c
  native/lcc_ecc.c
  native/lcc_stack.c
  native/lcc_layout.c
  native/lcc_preprocess.c
  native/lcc_detect.c
  native/lcc_decode.c
  native/lcc_api.c
  native/palette_tables.c
"

if command -v emcc >/dev/null 2>&1 || [ -x "$HOME/emsdk/upstream/emscripten/emcc" ]; then
  if [ -f "$HOME/emsdk/emsdk_env.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/emsdk/emsdk_env.sh"
  fi
  # shellcheck disable=SC2086
  export EM_CACHE="${EM_CACHE:-$ROOT/.em-cache}"
  # shellcheck disable=SC2086
  emcc $SOURCES $MODEL_FLAGS \
    -O3 \
    -msimd128 \
    -Inative \
    -s STANDALONE_WASM=1 \
    -s PURE_WASI=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    --no-entry \
    -Wl,--export=lcc_api_stack \
    -Wl,--export=lcc_api_decode \
    -Wl,--export=lcc_api_scan \
    -Wl,--export=lcc_api_set_features \
    -Wl,--export=lcc_api_finder \
    -Wl,--export=lcc_api_debug_residuals \
    -Wl,--export=lcc_api_debug_residuals_h \
    -Wl,--export=lcc_last \
    -Wl,--export=lcc_last_len \
    -Wl,--export=malloc \
    -Wl,--export=free \
    -o docs/lib/lcc.wasm
else
  export ZIG_GLOBAL_CACHE_DIR="${ZIG_GLOBAL_CACHE_DIR:-$ROOT/.zig-cache}"
  export ZIG_LOCAL_CACHE_DIR="${ZIG_LOCAL_CACHE_DIR:-$ROOT/.zig-cache}"
  # shellcheck disable=SC2086
  zig cc -target wasm32-wasi -mcpu=generic+simd128 -O3 -Inative $MODEL_FLAGS $SOURCES \
    -o docs/lib/lcc.wasm \
    -Wl,--no-entry \
    -Wl,--export=lcc_api_stack \
    -Wl,--export=lcc_api_decode \
    -Wl,--export=lcc_api_scan \
    -Wl,--export=lcc_api_set_features \
    -Wl,--export=lcc_api_finder \
    -Wl,--export=lcc_api_debug_residuals \
    -Wl,--export=lcc_api_debug_residuals_h \
    -Wl,--export=lcc_last \
    -Wl,--export=lcc_last_len \
    -Wl,--export=malloc \
    -Wl,--export=free
fi
