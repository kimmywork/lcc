#!/bin/sh
# Native ASan/UBSan robustness gate for the C core.
#
#   sh scripts/fuzz-native.sh                 # safe fuzz only (must pass)
#   sh scripts/fuzz-native.sh --audit         # also run hostile API probes
#   ITER=2000 SEED=7 sh scripts/fuzz-native.sh
#
# The audit probes deliberately violate the C API contract (mismatched buffer
# length, overflowing dimensions, mutated packed buffers).  The hardened build
# must reject them without ASan/UBSan reports; any report makes the gate fail.
set -e
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"

if [ -x /opt/homebrew/opt/llvm/bin/clang ]; then
  CC=${CC:-/opt/homebrew/opt/llvm/bin/clang}
elif command -v clang >/dev/null 2>&1; then
  CC=${CC:-clang}
else
  echo "fuzz-native: clang not found; skipping"
  exit 0
fi

ITER=${ITER:-300}
SEED=${SEED:-1}
BUILD=$(mktemp -d "${TMPDIR:-/tmp}/lcc-fuzz.XXXXXX")
trap 'rm -rf "$BUILD"' EXIT

SOURCES="
  native/lcc_util.c
  native/lcc_model.c
  native/lcc_color.c
  native/lcc_ecc.c
  native/lcc_stack.c
  native/lcc_layout.c
  native/lcc_encode_constraint.c
  native/lcc_encode_layers.c
  native/lcc_encode_layout.c
  native/lcc_encode_shapes.c
  native/lcc_encoder.c
  native/lcc_preprocess.c
  native/lcc_detect.c
  native/lcc_decode.c
  native/lcc_api.c
  native/palette_tables.c
  native/fuzz_harness.c
"

echo "building native ASan/UBSan harness with $CC"
# shellcheck disable=SC2086
"$CC" -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer \
  -Inative $SOURCES -lm -o "$BUILD/lcc_fuzz"

export ASAN_OPTIONS="${ASAN_OPTIONS:-detect_leaks=0:abort_on_error=1:symbolize=1}"
export UBSAN_OPTIONS="${UBSAN_OPTIONS:-halt_on_error=1:print_stacktrace=1}"

echo "safe fuzz: iterations=$ITER seed=$SEED"
"$BUILD/lcc_fuzz" safe "$ITER" "$SEED"
"$BUILD/lcc_fuzz" encode "$ITER" "$SEED"

AUDIT_FAIL=0
if [ "$1" = "--audit" ]; then
  echo
  echo "audit 1: decode buffer length mismatch"
  if "$BUILD/lcc_fuzz" mismatch >"$BUILD/mismatch.log" 2>&1; then
    echo "  no ASan report (contract enforced)"
  else
    echo "  ASan/UBSan reported a fault"
    AUDIT_FAIL=1
    sed -n '1,8p' "$BUILD/mismatch.log" | sed 's/^/    /'
  fi

  echo
  echo "audit 2: hostile packed buffers (random bytes + header mutation)"
  if "$BUILD/lcc_fuzz" hostile "${HOSTILE_ITER:-30}" "$SEED" >"$BUILD/hostile.log" 2>&1; then
    echo "  no ASan/UBSan report in ${HOSTILE_ITER:-30} hostile iterations"
  else
    echo "  ASan/UBSan reported a fault"
    AUDIT_FAIL=1
    sed -n '1,8p' "$BUILD/hostile.log" | sed 's/^/    /'
  fi

  echo
  echo "audit 3: width*height*3 integer overflow in packed stack input"
  if "$BUILD/lcc_fuzz" overflow >"$BUILD/overflow.log" 2>&1; then
    echo "  no ASan report (overflow rejected)"
  else
    echo "  ASan/UBSan reported a fault"
    AUDIT_FAIL=1
    sed -n '1,8p' "$BUILD/overflow.log" | sed 's/^/    /'
  fi
fi

echo
if [ "$AUDIT_FAIL" -ne 0 ]; then
  echo "native fuzz gate: FAILED"
  exit 1
fi
echo "native fuzz gate: OK"
