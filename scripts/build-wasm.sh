#!/bin/sh
# Build the two LCC wasm artifacts, each in a SIMD and a baseline variant:
#   docs/lib/lcc-decoder.wasm           SIMD
#   docs/lib/lcc-decoder-baseline.wasm  no SIMD (older mobile browsers)
#   docs/lib/lcc-encoder.wasm           SIMD
#   docs/lib/lcc-encoder-baseline.wasm  no SIMD
# Uses Emscripten when emcc is available, otherwise zig's wasm32-wasi target.
set -e
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"
node scripts/gen-palette-tables.js

DECODER_SOURCES="
  native/lcc_util.c
  native/lcc_model.c
  native/lcc_color.c
  native/lcc_ecc.c
  native/lcc_stack.c
  native/lcc_layout.c
  native/lcc_encode_constraint.c
  native/lcc_preprocess.c
  native/lcc_detect.c
  native/lcc_decode.c
  native/lcc_api.c
  native/palette_tables.c
"

ENCODER_SOURCES="
  native/lcc_util.c
  native/lcc_color.c
  native/lcc_ecc.c
  native/lcc_layout.c
  native/lcc_encode_layers.c
  native/lcc_encode_layout.c
  native/lcc_encode_shapes.c
  native/lcc_encode_constraint.c
  native/lcc_encoder.c
  native/lcc_api_encode.c
  native/palette_tables.c
"

DECODER_EXPORTS="
  -Wl,--export=lcc_api_stack
  -Wl,--export=lcc_api_detect
  -Wl,--export=lcc_api_decode
  -Wl,--export=lcc_api_decode_explicit
  -Wl,--export=lcc_api_scan
  -Wl,--export=lcc_api_debug_residuals
  -Wl,--export=lcc_api_debug_residuals_h
  -Wl,--export=lcc_last
  -Wl,--export=lcc_last_len
  -Wl,--export=malloc
  -Wl,--export=free
"

ENCODER_EXPORTS="
  -Wl,--export=lcc_api_encode
  -Wl,--export=lcc_api_encode_layout
  -Wl,--export=lcc_last
  -Wl,--export=lcc_last_len
  -Wl,--export=malloc
  -Wl,--export=free
"

build_target() {
  name=$1
  sources=$2
  exports=$3
  simd=$4
  if command -v emcc >/dev/null 2>&1 || [ -x "$HOME/emsdk/upstream/emscripten/emcc" ]; then
    if ! command -v emcc >/dev/null 2>&1 && [ -f "$HOME/emsdk/emsdk_env.sh" ]; then
      # shellcheck disable=SC1091
      . "$HOME/emsdk/emsdk_env.sh"
    fi
    # shellcheck disable=SC2086
    export EM_CACHE="${EM_CACHE:-$ROOT/.em-cache}"
    SIMD_FLAGS=""
    [ "$simd" = "1" ] && SIMD_FLAGS="-msimd128"
    # shellcheck disable=SC2086
    emcc $sources \
      -O3 \
      $SIMD_FLAGS \
      -Inative \
      -s STANDALONE_WASM=1 \
      -s PURE_WASI=1 \
      -s ALLOW_MEMORY_GROWTH=1 \
      --no-entry \
      $exports \
      -o "docs/lib/$name"
  else
    export ZIG_GLOBAL_CACHE_DIR="${ZIG_GLOBAL_CACHE_DIR:-$ROOT/.zig-cache}"
    export ZIG_LOCAL_CACHE_DIR="${ZIG_LOCAL_CACHE_DIR:-$ROOT/.zig-cache}"
    CPU="generic"
    [ "$simd" = "1" ] && CPU="generic+simd128"
    # shellcheck disable=SC2086
    zig cc -target wasm32-wasi -mcpu="$CPU" -O3 -Inative $sources \
      -mexec-model=reactor \
      -o "docs/lib/$name" \
      -Wl,--no-entry \
      $exports
  fi
}

mkdir -p docs/lib
build_target lcc-decoder.wasm "$DECODER_SOURCES" "$DECODER_EXPORTS" 1
build_target lcc-decoder-baseline.wasm "$DECODER_SOURCES" "$DECODER_EXPORTS" 0
build_target lcc-encoder.wasm "$ENCODER_SOURCES" "$ENCODER_EXPORTS" 1
build_target lcc-encoder-baseline.wasm "$ENCODER_SOURCES" "$ENCODER_EXPORTS" 0
